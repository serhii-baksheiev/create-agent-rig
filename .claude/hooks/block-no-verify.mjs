// PreToolUse hook: the pre-commit gate may not be bypassed. A red check is a
// signal to fix, never to silence — so `--no-verify` (and `git commit -n`) is
// refused at the tool layer.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
import { readFileSync } from 'node:fs';

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (input.tool_name !== 'Bash') return 0;
  const command = String(input.tool_input?.command ?? '');

  // Examine each git commit/push invocation separately (pipelines, && chains).
  const gitSegment = /\bgit\b[^|&;]*\b(commit|push)\b[^|&;]*/g;
  for (const match of command.matchAll(gitSegment)) {
    const [segment, verb] = match;
    const bypasses =
      /(^|\s)--no-verify\b/.test(segment) ||
      // -n is --no-verify for commit only (for push it means --dry-run).
      (verb === 'commit' && /(^|\s)-n\b/.test(segment));
    if (bypasses) {
      process.stderr.write(
        'BLOCKED — bypassing pre-commit checks is never allowed. ' +
          'If a check fails, fix the failure (or stop and report why it cannot be fixed); ' +
          'see .claude/rules/workflow.md.\n',
      );
      return 2;
    }
  }
  return 0;
}

process.exit(main());
