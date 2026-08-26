/**
 * Normalise the edit surfaces exposed by Claude Code and Codex.
 *
 * Claude sends Write/Edit fields directly. Codex sends an apply_patch command,
 * so added lines are returned for ordinary edits. A move is different: the
 * destination receives the existing file too, so guards inspect the resulting
 * content instead of only the patch additions when inspection succeeds.
 *
 * Inspection is bounded globally per patch: sources, hunks, output, splices,
 * comparisons, sections and path components.
 */
import { execFileSync } from 'node:child_process';

// 🔴 Git hands its hooks an absolute GIT_DIR, so an inherited one answers about
// the HOOK's repository rather than the session's. Every other git call site in
// this rig strips it — gate-stop-dod, preflight, decision-router,
// queue/checkout — and the move-source lookup below did not, which is how the
// resolved root became an ancestor of the real path and the purity test stopped
// matching. The `env` is spelled out at the call itself rather than behind this
// comment, because the generator's sweep for unsanitised git spawns reads the
// call's own option window.
//
// ⚠ This is this file's only import outside `node:` — if it goes missing every
// guard that consumes `editFragments` dies at module resolution with exit 1,
// which neither harness treats as blocking.
import { withoutGitLocation } from '../../scripts/git-env.mjs';
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
/** A MultiEdit is capped before it is mapped — bounded work, never a spread of input. */
const MAX_MULTI_EDITS = 256;
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
  // Claude Code's other two edit surfaces (AR-51). `MultiEdit` carries one
  // file and a list of edits — one fragment per edit, same path — and
  // `NotebookEdit` carries a cell's new source. Before this, both reached every
  // guard through the unanchored `Write|Edit` matcher and yielded no fragment,
  // so a `Date.now()` in a MultiEdit to the core passed unchecked.
  if (toolName === 'MultiEdit') {
    if (!Array.isArray(toolInput.edits)) return [];
    const filePath = normalisePath(toolInput.file_path);
    return toolInput.edits.slice(0, MAX_MULTI_EDITS).map((edit) => ({
      filePath,
      fragment: String(edit?.new_string ?? ''),
    }));
  }
  if (toolName === 'NotebookEdit') {
    return [
      {
        filePath: normalisePath(toolInput.notebook_path),
        fragment: String(toolInput.new_source ?? ''),
      },
    ];
  }
  if (toolName !== 'apply_patch') return [];
  const rawCommand = toolInput.command;
  // ⚠ **Absent is not malformed, and the difference decides which way this fails.**
  // A payload with no `command` at all is one the hook does not understand, which
  // `.claude/rules/invariants.md` says must ALLOW — the same answer the
  // `Write`/`Edit` arm above gives a payload with no `file_path`. A `command`
  // that is THERE and is not a shape this guard reads is the other case: a
  // condition it detects and can report. Collapsing the two blocked every Codex
  // edit the day the platform renamed the field, with a remedy nobody could act
  // on.
  // ⚠ **`in` throws on a primitive, and two of the three guards have no catch** —
  // they exited 1 with a stack trace, which neither harness treats as blocking, so
  // a crash here was an ALLOW. A `tool_input` that is not an object is the same
  // case as a `command` whose container this guard cannot read: detected, not
  // readable, refused.
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    return [
      {
        filePath: '',
        fragment: '',
        inspectionRefusal:
          'the apply_patch command arrived in a shape this guard cannot read — it is a ' +
          'string, or a list of strings, and nothing else. Nothing was inspected, so ' +
          'nothing about this patch is vouched for.',
        remedy: 'Send the command as a patch string, or a list of strings.',
        appliesToAll: true,
      },
    ];
  }
  if (!('command' in toolInput)) return [];
  if (
    typeof rawCommand !== 'string' &&
    !(Array.isArray(rawCommand) && rawCommand.every((part) => typeof part === 'string'))
  ) {
    // 🔴 **"I could not look" is not "there was nothing to look at."** This
    // returned `[]`, which every consumer reads as a clean patch — so a
    // credential in a payload whose container the normalizer does not recognise
    // landed, while stderr said out loud that nothing had been inspected. The
    // stream nothing gates on is not where a refusal belongs.
    //
    // It now answers exactly as the over-length branch below does, and for the
    // same reason: a bound or a shape the guard can DETECT is a decision it can
    // report, not a crash. `.claude/rules/invariants.md`'s fail-open rule covers
    // the hook throwing or being handed something it cannot parse at all —
    // "a crashed guard that blocks everything gets deleted within the hour" —
    // and this branch is neither. Two opposite answers to one question, ten
    // lines apart, was the real defect.
    return [
      {
        filePath: '',
        fragment: '',
        inspectionRefusal:
          'the apply_patch command arrived in a shape this guard cannot read — it is a ' +
          'string, or a list of strings, and nothing else. Nothing was inspected, so ' +
          'nothing about this patch is vouched for.',
        // 🔴 The remedy travels WITH the refusal that earns it. It was chosen by
        // `/shape/i.test(reason)` in six copies — correct only by coincidence of
        // wording, so rewording the reason silently restored the retry loop this
        // remedy exists to replace. One field, one place.
        remedy: 'Send the command as a patch string, or a list of strings.',
        appliesToAll: true,
      },
    ];
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
    budget.repoRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: requestedCwd, encoding: 'utf8', maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, env: withoutGitLocation() }).trim());
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
