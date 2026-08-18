/**
 * Normalise the edit surfaces exposed by Claude Code and Codex.
 *
 * Claude sends Write/Edit fields directly. Codex sends an apply_patch command,
 * so added lines are returned for ordinary edits. A move is different: the
 * destination receives the existing file too, so guards inspect the resulting
 * content instead of only the patch additions when inspection succeeds.
 *
 * Limits and their executable contracts:
 * - move sources must stay inside the repository (codex.test.ts > refuses to inspect a move source outside the repository via %s)
 * - symlinks may not resolve outside it (codex.test.ts > rejects an in-repository symlink that resolves outside without echoing its content)
 * - missing or unreadable sources diagnose and fail open (codex.test.ts > diagnoses a missing move source but leaves the guard fail-open)
 * - source reads are capped (codex.test.ts > reads only a bounded prefix and blocks an oversized move source)
 * - patch input is capped before parsing (codex.test.ts > refuses an oversized apply_patch command before parsing its contents)
 * - patch context must match (codex.test.ts > blocks a move whose patch context does not match its source)
 * - each hunk is capped (codex.test.ts > blocks a move hunk that exceeds the hunk-line ceiling)
 * - context search has one total budget (codex.test.ts > blocks a move when the context-comparison budget is exhausted)
 * - patch destinations must stay inside the repository (codex.test.ts > refuses absolute and traversal move destinations outside the repository)
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
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
  const command = String(toolInput.command ?? '');
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
  return patchFragments(command);
}

function patchFragments(command) {
  const fragments = [];
  let current = null;

  const flush = () => {
    if (current !== null) {
      const destination = canonicalPatchPath(current.moveTo ?? current.sourcePath);
      if (destination === null) {
        fragments.push({
          filePath: '',
          fragment: '',
          inspectionRefusal: 'patch destination is outside the repository',
          appliesToAll: true,
        });
      } else {
        const moved = current.moveTo
          ? movedFragment(current)
          : { fragment: current.additions.join('\n') };
        fragments.push({ filePath: destination, ...moved });
      }
      current = null;
    }
  };

  for (const line of command.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (file) {
      flush();
      current = { sourcePath: file[1], moveTo: null, additions: [], hunks: [], activeHunk: null };
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current !== null) {
      current.moveTo = move[1];
      continue;
    }
    if (/^\*\*\* (?:Delete File|End Patch)/.test(line)) {
      flush();
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
  flush();
  return fragments;
}

function movedFragment(current) {
  const sourcePath = canonicalPatchPath(current.sourcePath);
  if (sourcePath === null) {
    return inspectionRefusal(current, 'move source is outside the repository root');
  }
  try {
    const repoRoot = realpathSync(
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim(),
    );
    const candidate = path.resolve(repoRoot, sourcePath);
    if (!isWithin(repoRoot, candidate)) {
      return inspectionRefusal(current, 'move source is outside the repository root');
    }

    const resolvedSource = realpathSync(candidate);
    if (!isWithin(repoRoot, resolvedSource)) {
      return inspectionRefusal(current, 'move source resolves outside the repository root');
    }

    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const handle = openSync(candidate, constants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(handle);
      const verifiedSource = realpathSync(candidate);
      if (!isWithin(repoRoot, verifiedSource)) {
        return inspectionRefusal(current, 'move source resolves outside the repository root');
      }
      const verified = statSync(verifiedSource);
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
      if (bytesRead > MAX_MOVED_FILE_BYTES) {
        return inspectionRefusal(
          current,
          `move source exceeds the ${MAX_MOVED_FILE_BYTES}-byte inspection limit`,
        );
      }

      const content = buffer.toString('utf8', 0, bytesRead);
      return applyHunks(content, current.hunks, current);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    process.stderr.write(`edit-input: could not inspect moved file: ${error.message}\n`);
    return { fragment: current.additions.join('\n') };
  }
}

function applyHunks(content, hunks, current) {
  const lines = content.split(/\r?\n/);
  const budget = { remaining: MAX_CONTEXT_COMPARISONS };
  for (const hunk of hunks) {
    if (hunk.lines.length > MAX_HUNK_LINES) {
      return inspectionRefusal(
        current,
        `move hunk exceeds the ${MAX_HUNK_LINES}-line inspection limit`,
      );
    }
    const before = hunk.lines
      .filter(({ operation }) => operation !== '+')
      .map(({ text }) => text);
    const after = hunk.lines
      .filter(({ operation }) => operation !== '-')
      .map(({ text }) => text);

    if (before.length === 0) {
      lines.splice(Math.max(0, lines.length - 1), 0, ...after);
      continue;
    }
    const match = findSequence(lines, before, budget);
    if (match.exhausted) {
      return inspectionRefusal(current, 'move context comparison budget was exhausted');
    }
    if (match.index === -1) {
      return inspectionRefusal(current, 'move patch context does not match the source file');
    }
    lines.splice(match.index, before.length, ...after);
  }
  return { fragment: lines.join('\n') };
}

function findSequence(lines, sequence, budget) {
  const lastStart = lines.length - sequence.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      budget.remaining -= 1;
      if (budget.remaining < 0) return { index: -1, exhausted: true };
      if (lines[start + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return { index: start, exhausted: false };
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
  const slashed = String(value ?? '').replaceAll('\\', '/');
  return slashed === '' ? '' : path.posix.normalize(slashed);
}

function canonicalPatchPath(value) {
  const normalised = normalisePath(value);
  if (
    normalised === '' ||
    path.posix.isAbsolute(normalised) ||
    /^[A-Za-z]:\//.test(normalised) ||
    normalised === '..' ||
    normalised.startsWith('../')
  ) {
    return null;
  }
  return normalised.replace(/^\.\//, '');
}
