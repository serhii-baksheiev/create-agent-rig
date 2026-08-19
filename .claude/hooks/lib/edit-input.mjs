/**
 * Normalise the edit surfaces exposed by Claude Code and Codex.
 *
 * Claude sends Write/Edit fields directly. Codex sends an apply_patch command,
 * so added lines are returned for ordinary edits. A move is different: the
 * destination receives the existing file too, so guards inspect the resulting
 * content instead of only the patch additions when inspection succeeds.
 *
 * Inspection is bounded globally per patch: sources, hunks, output, splices and comparisons.
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const MAX_PATCH_CHARACTERS = 1024 * 1024;
const MAX_MOVED_FILE_BYTES = 1024 * 1024;
const MAX_HUNK_LINES = 10_000;
const MAX_CONTEXT_COMPARISONS = 2_000_000;
const MAX_TOTAL_MOVED_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_HUNK_LINES = 10_000;
const MAX_OUTPUT_LINES = 20_000;
const MAX_SPLICE_OPERATIONS = 1_000;
const MAX_PATCH_SECTIONS = 128;
const MAX_PATCH_PATH_COMPONENTS = 512;

export function editFragments(input) {
  const toolName = input?.tool_name;
  const toolInput = input?.tool_input ?? {};
  if (toolName === 'Write' || toolName === 'Edit') {
    return [
      {
        filePath: normalisePath(toolInput.file_path),
        fragment: String(
          (toolName === 'Write' ? toolInput.content : toolInput.new_string) ?? '',
        ),
      },
    ];
  }
  if (toolName !== 'apply_patch') return [];
  const rawCommand = toolInput.command;
  if (
    typeof rawCommand !== 'string' &&
    !(Array.isArray(rawCommand) && rawCommand.every((part) => typeof part === 'string'))
  ) {
    process.stderr.write('edit-input: cannot safely inspect patch — apply_patch command has an unsupported shape\n');
    return [];
  }
  const command = typeof rawCommand === 'string' ? rawCommand : rawCommand.join('\n');
  if (command.length > MAX_PATCH_CHARACTERS) {
    return [
      {
        filePath: '',
        fragment: '',
        inspectionRefusal: `apply_patch command exceeds the ${MAX_PATCH_CHARACTERS}-character inspection limit`,
        appliesToAll: true,
      },
    ];
  }
  return patchFragments(command, input?.cwd);
}

function patchFragments(command, payloadCwd) {
  const fragments = [];
  const budget = {
    movedBytes: 0,
    hunkLines: 0,
    outputLines: 0,
    splices: 0,
    sections: 0,
    pathComponents: 0,
    comparisons: MAX_CONTEXT_COMPARISONS,
    repoRoot: null,
    patchCwd: null,
    resolvedDirectories: new Map(),
    exhausted: null,
  };
  try {
    const requestedCwd = typeof payloadCwd === 'string' && payloadCwd.trim() !== ''
      ? path.resolve(payloadCwd)
      : process.cwd();
    budget.repoRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: requestedCwd, encoding: 'utf8', maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim());
    budget.patchCwd = realpathSync(requestedCwd);
    if (!isWithin(budget.repoRoot, budget.patchCwd)) budget.patchCwd = null;
  } catch { /* moved inspection below refuses without a trusted root and cwd */ }
  let current = null;
  let patchRefusal = null;

  const flush = () => {
    if (current !== null) {
      budget.sections += 1;
      if (budget.sections > MAX_PATCH_SECTIONS) {
        patchRefusal = {
          filePath: '',
          fragment: '',
          inspectionRefusal: `apply_patch exceeds the ${MAX_PATCH_SECTIONS}-section inspection limit`,
          appliesToAll: true,
        };
        current = null;
        return false;
      }
      const destinationPath = current.moveTo ?? current.sourcePath;
      budget.pathComponents += String(destinationPath ?? '')
        .replaceAll('\\', '/')
        .split('/').length;
      if (budget.pathComponents > MAX_PATCH_PATH_COMPONENTS) {
        patchRefusal = {
          filePath: '',
          fragment: '',
          inspectionRefusal: `apply_patch destination path component count exceeds the ${MAX_PATCH_PATH_COMPONENTS}-component inspection limit`,
          appliesToAll: true,
        };
        current = null;
        return false;
      }
      const destination = repositoryPatchPath(destinationPath, budget);
      if (destination === null) {
        fragments.push({
          filePath: '',
          fragment: '',
          inspectionRefusal: 'patch destination is outside the repository or cannot be resolved safely',
          appliesToAll: true,
        });
      } else {
        const moved = current.moveTo
          ? movedFragment(current, budget)
          : { fragment: current.additions.join('\n') };
        fragments.push({ filePath: destination, ...moved });
      }
      current = null;
    }
    return true;
  };

  for (const line of command.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (file) {
      if (!flush()) break;
      current = { sourcePath: file[1], moveTo: null, additions: [], hunks: [], activeHunk: null };
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current !== null) {
      current.moveTo = move[1];
      continue;
    }
    if (/^\*\*\* (?:Delete File|End Patch)/.test(line)) {
      if (!flush()) break;
      continue;
    }
    if (current !== null && line.startsWith('@@')) {
      current.activeHunk = { lines: [] };
      current.hunks.push(current.activeHunk);
      continue;
    }
    if (current !== null && line.startsWith('+')) current.additions.push(line.slice(1));
    if (current?.activeHunk && /^[-+ ]/.test(line)) {
      current.activeHunk.lines.push({ operation: line[0], text: line.slice(1) });
    }
  }
  if (patchRefusal !== null) return [patchRefusal];
  flush();
  if (patchRefusal !== null) return [patchRefusal];
  return fragments;
}

function movedFragment(current, budget) {
  if (budget.exhausted !== null) return inspectionRefusal(current, budget.exhausted);
  const sourcePath = canonicalPatchPath(current.sourcePath);
  if (sourcePath === null) {
    return inspectionRefusal(current, 'move source is outside the repository root');
  }
  if (budget.repoRoot === null) {
    return inspectionRefusal(current, 'cannot resolve the repository root with git rev-parse');
  }
  if (budget.patchCwd === null) {
    return inspectionRefusal(current, 'cannot resolve the apply_patch working directory');
  }
  try {
    const repoRoot = budget.repoRoot;
    const candidate = path.resolve(budget.patchCwd, sourcePath);
    if (!isWithin(repoRoot, candidate)) {
      return inspectionRefusal(current, 'move source is outside the repository root');
    }

    if (lstatSync(candidate).isSymbolicLink()) {
      return inspectionRefusal(current, 'unsafe move source is a symbolic link');
    }
    const resolvedSource = realpathSync(candidate);
    if (!isWithin(repoRoot, resolvedSource)) {
      return inspectionRefusal(current, 'move source resolves outside the repository root');
    }

    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const nonBlocking = constants.O_NONBLOCK ?? 0;
    const handle = openSync(resolvedSource, constants.O_RDONLY | noFollow | nonBlocking);
    try {
      const opened = fstatSync(handle);
      if (!opened.isFile()) return inspectionRefusal(current, 'move source is not a regular file');
      const verifiedSource = realpathSync(candidate);
      if (!isWithin(repoRoot, verifiedSource)) {
        return inspectionRefusal(current, 'move source resolves outside the repository root');
      }
      const verified = statSync(verifiedSource);
      if (!verified.isFile()) return inspectionRefusal(current, 'move source is not a regular file');
      if (opened.dev !== verified.dev || opened.ino !== verified.ino) {
        return inspectionRefusal(current, 'move source changed during inspection');
      }

      let bytesRead = 0;
      const buffer = Buffer.allocUnsafe(MAX_MOVED_FILE_BYTES + 1);
      while (bytesRead < buffer.length) {
        const count = readSync(handle, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
      budget.movedBytes += bytesRead;
      if (budget.movedBytes > MAX_TOTAL_MOVED_FILE_BYTES) {
        return exhaustBudget(
          budget,
          current,
          `aggregate move source inspection exceeds the ${MAX_TOTAL_MOVED_FILE_BYTES}-byte limit`,
        );
      }
      if (bytesRead > MAX_MOVED_FILE_BYTES) {
        return exhaustBudget(
          budget,
          current,
          `move source exceeds the ${MAX_MOVED_FILE_BYTES}-byte inspection limit`,
        );
      }

      const content = buffer.toString('utf8', 0, bytesRead);
      return applyHunks(content, current.hunks, current, budget);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // A deleted/missing source is not an unsafe path. Preserve the existing
      // fail-open contract, but make the loss of source context visible.
      process.stderr.write(`edit-input: could not inspect moved file: ${error.message}\n`);
      return { fragment: current.additions.join('\n') };
    }
    process.stderr.write(`edit-input: could not inspect moved file: ${error.message}\n`);
    return inspectionRefusal(current, 'cannot safely inspect moved file');
  }
}

function applyHunks(content, hunks, current, budget) {
  const lines = content.split(/\r?\n/);
  if (lines.length > MAX_OUTPUT_LINES) return exhaustBudget(budget, current, `move output exceeds the ${MAX_OUTPUT_LINES}-line limit`);
  for (const hunk of hunks) {
    if (hunk.lines.length > MAX_HUNK_LINES) {
      return exhaustBudget(
        budget,
        current,
        `move hunk exceeds the ${MAX_HUNK_LINES}-line inspection limit`,
      );
    }
    budget.hunkLines += hunk.lines.length;
    if (budget.hunkLines > MAX_TOTAL_HUNK_LINES) return exhaustBudget(budget, current, `total move hunk lines exceed the ${MAX_TOTAL_HUNK_LINES}-line limit`);
    const before = hunk.lines
      .filter(({ operation }) => operation !== '+')
      .map(({ text }) => text);
    const after = hunk.lines
      .filter(({ operation }) => operation !== '-')
      .map(({ text }) => text);

    if (before.length === 0) {
      budget.splices += 1;
      if (budget.splices > MAX_SPLICE_OPERATIONS) return exhaustBudget(budget, current, `move splice budget exceeds ${MAX_SPLICE_OPERATIONS} operations`);
      if (lines.length + after.length > MAX_OUTPUT_LINES) return exhaustBudget(budget, current, `move output exceeds the ${MAX_OUTPUT_LINES}-line limit`);
      lines.splice(Math.max(0, lines.length - 1), 0, ...after);
      continue;
    }
    const match = findSequence(lines, before, budget);
    if (match.exhausted) {
      return exhaustBudget(budget, current, 'move context comparison budget was exhausted');
    }
    if (match.index === -1) {
      return inspectionRefusal(current, 'move patch context does not match the source file');
    }
    lines.splice(match.index, before.length, ...after);
    budget.splices += 1;
    if (budget.splices > MAX_SPLICE_OPERATIONS) return exhaustBudget(budget, current, `move splice budget exceeds ${MAX_SPLICE_OPERATIONS} operations`);
    if (lines.length > MAX_OUTPUT_LINES) return exhaustBudget(budget, current, `move output exceeds the ${MAX_OUTPUT_LINES}-line limit`);
  }
  budget.outputLines += lines.length;
  if (budget.outputLines > MAX_OUTPUT_LINES) {
    return exhaustBudget(budget, current, `aggregate move output exceeds the ${MAX_OUTPUT_LINES}-line limit`);
  }
  return { fragment: lines.join('\n') };
}

function findSequence(lines, sequence, budget) {
  if (sequence.length === 0) return { index: 0, exhausted: false };
  const prefix = Array(sequence.length).fill(0);
  for (let i = 1, length = 0; i < sequence.length; i += 1) {
    while (length > 0 && sequence[i] !== sequence[length]) length = prefix[length - 1];
    if (sequence[i] === sequence[length]) length += 1;
    prefix[i] = length;
  }
  for (let i = 0, matched = 0; i < lines.length; i += 1) {
    // Account for the worst-case window comparison represented by this
    // candidate, even though KMP avoids performing all of those operations.
    // The cap remains meaningful without giving up the linear-time matcher.
    budget.comparisons -= sequence.length;
    if (budget.comparisons < 0) return { index: -1, exhausted: true };
    while (matched > 0 && lines[i] !== sequence[matched]) matched = prefix[matched - 1];
    if (lines[i] === sequence[matched]) matched += 1;
    if (matched === sequence.length) return { index: i - sequence.length + 1, exhausted: false };
  }
  return { index: -1, exhausted: false };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function inspectionRefusal(current, reason) {
  process.stderr.write(`edit-input: ${reason}\n`);
  return { fragment: current.additions.join('\n'), inspectionRefusal: reason };
}

function normalisePath(value) {
  const slashed = String(value ?? '').trim().replaceAll('\\', '/');
  return slashed === '' ? '' : path.posix.normalize(slashed);
}

function canonicalPatchPath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  const normalised = normalisePath(raw);
  if (
    normalised === '' ||
    raw.startsWith('/') ||
    raw.startsWith('//') ||
    path.posix.isAbsolute(normalised) ||
    /^[A-Za-z]:/.test(raw) ||
    raw.split('/').some((part) => part === '..') ||
    normalised === '..' ||
    normalised.startsWith('../')
  ) {
    return null;
  }
  return normalised.replace(/^\.\//, '');
}

function repositoryPatchPath(value, budget) {
  const patchPath = canonicalPatchPath(value);
  if (patchPath === null || budget.repoRoot === null || budget.patchCwd === null) return null;
  const candidate = path.resolve(budget.patchCwd, patchPath);
  if (!isWithin(budget.repoRoot, candidate)) return null;

  let existing = candidate;
  const suffix = [];
  while (true) {
    if (suffix.length > 0 && budget.resolvedDirectories.has(existing)) {
      const resolved = budget.resolvedDirectories.get(existing);
      const resolvedCandidate = path.resolve(resolved, ...suffix);
      if (!isWithin(budget.repoRoot, resolvedCandidate)) return null;
      return path.relative(budget.repoRoot, resolvedCandidate).split(path.sep).join('/');
    }
    try {
      const resolved = realpathSync(existing);
      if (suffix.length > 0) {
        budget.resolvedDirectories.set(existing, resolved);
        let lexicalPrefix = existing;
        let resolvedPrefix = resolved;
        for (const component of suffix.slice(0, -1)) {
          lexicalPrefix = path.resolve(lexicalPrefix, component);
          resolvedPrefix = path.resolve(resolvedPrefix, component);
          budget.resolvedDirectories.set(lexicalPrefix, resolvedPrefix);
        }
      }
      const resolvedCandidate = path.resolve(resolved, ...suffix);
      if (!isWithin(budget.repoRoot, resolvedCandidate)) return null;
      return path.relative(budget.repoRoot, resolvedCandidate).split(path.sep).join('/');
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      try {
        lstatSync(existing);
        return null;
      } catch (lstatError) {
        if (lstatError?.code !== 'ENOENT') return null;
      }
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function exhaustBudget(budget, current, reason) {
  budget.exhausted = reason;
  return inspectionRefusal(current, reason);
}
