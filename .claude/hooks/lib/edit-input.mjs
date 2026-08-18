/**
 * Normalise the edit surfaces exposed by Claude Code and Codex.
 *
 * Claude sends Write/Edit fields directly. Codex sends an apply_patch command,
 * so added lines are returned for ordinary edits. A move is different: the
 * destination receives the existing file too, so guards inspect the resulting
 * content instead of only the patch additions.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  return patchFragments(String(toolInput.command ?? ''), input?.cwd);
}

function patchFragments(command, cwd) {
  const fragments = [];
  let current = null;

  const flush = () => {
    if (current !== null) {
      const fragment = current.moveTo
        ? movedFragment(current, cwd)
        : current.additions.join('\n');
      fragments.push({ filePath: normalisePath(current.moveTo ?? current.sourcePath), fragment });
      current = null;
    }
  };

  for (const line of command.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (file) {
      flush();
      current = { sourcePath: file[1], moveTo: null, additions: [], removals: [] };
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
    if (current !== null && line.startsWith('+')) current.additions.push(line.slice(1));
    if (current !== null && line.startsWith('-')) current.removals.push(line.slice(1));
  }
  flush();
  return fragments;
}

function movedFragment(current, cwd) {
  const source = path.isAbsolute(current.sourcePath)
    ? current.sourcePath
    : path.resolve(String(cwd ?? process.cwd()), current.sourcePath);
  try {
    let content = readFileSync(source, 'utf8');
    for (const removed of current.removals) content = content.replace(`${removed}\n`, '');
    return [content, ...current.additions].join('\n');
  } catch (error) {
    process.stderr.write(`edit-input: could not inspect moved file ${source}: ${error.message}\n`);
    return current.additions.join('\n');
  }
}

function normalisePath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}
