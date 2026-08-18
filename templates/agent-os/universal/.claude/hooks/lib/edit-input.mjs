/**
 * Normalise the edit surfaces exposed by Claude Code and Codex.
 *
 * Claude sends Write/Edit fields directly. Codex sends an apply_patch command,
 * so added lines are returned for ordinary edits. A move is different: the
 * destination receives the existing file too, so guards inspect the resulting
 * content instead of only the patch additions.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

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
  return patchFragments(String(toolInput.command ?? ''));
}

function patchFragments(command) {
  const fragments = [];
  let current = null;

  const flush = () => {
    if (current !== null) {
      const moved = current.moveTo
        ? movedFragment(current)
        : { fragment: current.additions.join('\n') };
      fragments.push({ filePath: normalisePath(current.moveTo ?? current.sourcePath), ...moved });
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
    const candidate = path.resolve(repoRoot, current.sourcePath);
    if (!isWithin(repoRoot, candidate)) {
      return inspectionFailure(current, 'move source is outside the repository root');
    }

    const source = realpathSync(candidate);
    if (!isWithin(repoRoot, source)) {
      return inspectionFailure(current, 'move source resolves outside the repository root');
    }

    const handle = openSync(source, 'r');
    let bytesRead = 0;
    const buffer = Buffer.allocUnsafe(MAX_MOVED_FILE_BYTES + 1);
    try {
      while (bytesRead < buffer.length) {
        const count = readSync(handle, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
    } finally {
      closeSync(handle);
    }
    if (bytesRead > MAX_MOVED_FILE_BYTES) {
      return inspectionFailure(
        current,
        `move source exceeds the ${MAX_MOVED_FILE_BYTES}-byte inspection limit`,
      );
    }

    const content = buffer.toString('utf8', 0, bytesRead);
    const applied = applyHunks(content, current.hunks);
    if (applied === null) {
      return inspectionFailure(current, 'move patch context does not match the source file');
    }
    return { fragment: applied };
  } catch (error) {
    return inspectionFailure(current, `could not inspect moved file: ${error.message}`);
  }
}

function applyHunks(content, hunks) {
  const lines = content.split(/\r?\n/);
  const budget = { remaining: MAX_CONTEXT_COMPARISONS };
  for (const hunk of hunks) {
    if (hunk.lines.length > MAX_HUNK_LINES) return null;
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
    const index = findSequence(lines, before, budget);
    if (index === -1) return null;
    lines.splice(index, before.length, ...after);
  }
  return lines.join('\n');
}

function findSequence(lines, sequence, budget) {
  const lastStart = lines.length - sequence.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      budget.remaining -= 1;
      if (budget.remaining < 0) return -1;
      if (lines[start + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function inspectionFailure(current, reason) {
  process.stderr.write(`edit-input: ${reason}\n`);
  return { fragment: current.additions.join('\n'), inspectionError: reason };
}

function normalisePath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}
