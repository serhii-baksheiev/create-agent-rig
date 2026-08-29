// PreToolUse hook: the pre-commit gate may not be bypassed. A red check is a
// signal to fix, never to silence — so `--no-verify` (and `git commit -n`) is
// refused at the tool layer.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
//
// Stated limit: it strips QUOTED text so prose about the flag is not a bypass,
// but it does not parse heredocs. Writing `git commit -nm …` inside a heredoc
// body — a doc, a test fixture, a PR description — is therefore blocked. That
// happened while writing this hook's own tests. The fix is not to teach this file
// to tokenise: it owns exactly one invariant and stays readable because of it
// (see .claude/rules/invariants.md, "One invariant per hook"). Use a file rather
// than a heredoc, or quote the example.
import { readHookInput } from './lib/hook-input.mjs';

function main() {
  const input = readHookInput();
  if (input === null) return 0;
  if (input.tool_name !== 'Bash') return 0;
  const raw = String(input.tool_input?.command ?? '');

  // Strip quoted segments first: a commit message that merely MENTIONS a
  // forbidden flag is prose, not a bypass. Only unquoted flags count.
  const command = raw.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

  // Examine each git commit/push invocation separately (pipelines, && chains).
  const gitSegment = /\bgit\b[^|&;]*\b(commit|push)\b[^|&;]*/g;
  for (const match of command.matchAll(gitSegment)) {
    const [segment, verb] = match;
    const bypasses =
      /(^|\s)--no-verify\b/.test(segment) ||
      // `-n` is --no-verify for commit only (for push it means --dry-run), and it
      // counts inside a COMBINED cluster: `git commit -nm "msg"` bypassed the
      // pre-commit gate outright, which is the one thing this hook exists to stop.
      (verb === 'commit' && /(^|\s)-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(segment));
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
