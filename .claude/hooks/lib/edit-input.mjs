/**
 * Normalise the edit surfaces exposed by Claude Code and Codex.
 *
 * Claude sends Write/Edit fields directly. Codex sends an apply_patch command,
 * so only added lines are returned: removed/context lines are not new code and
 * must not create false blocks.
 */
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
      fragments.push({ filePath: normalisePath(current.filePath), fragment: current.lines.join('\n') });
      current = null;
    }
  };

  for (const line of command.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (file) {
      flush();
      current = { filePath: file[1], lines: [] };
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current !== null) {
      current.filePath = move[1];
      continue;
    }
    if (/^\*\*\* (?:Delete File|End Patch)/.test(line)) {
      flush();
      continue;
    }
    if (current !== null && line.startsWith('+')) current.lines.push(line.slice(1));
  }
  flush();
  return fragments;
}

function normalisePath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}
