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
import { readHookInput, refusalText, shellCommandOf } from './lib/hook-input.mjs';
import { SHELL_TOOLS } from '../scripts/lib/shell-tools.mjs';

function main() {
  const input = readHookInput();
  if (input === null) return 0;
  // One list, not a literal: this hook was launched for every shell surface
  // and then excused itself from all but Bash, so the pre-commit gate stayed
  // bypassable on the other one.
  if (!SHELL_TOOLS.includes(input.tool_name)) return 0;
  // Three outcomes, from the one shared contract (RP-80). `String(argv)` used
  // to stand here, and it did not merely fail to read an array — it produced a
  // plausible-looking string: `["git","commit","--no-verify"]` became
  // `git,commit,--no-verify`, where the tokeniser below never splits on a comma,
  // so the one flag this hook exists to refuse was silently absent. A guard that
  // converts what it cannot read into something it can is worse than one that
  // refuses, because it reports a check it did not perform.
  const parsed = shellCommandOf(input);
  if (parsed.kind === 'unreadable') {
    process.stderr.write(`${refusalText(parsed)}\n`);
    return 2;
  }
  // Positive test, not a list of the others: a member added later must not
  // reach `raw.replace(…)` below with `undefined`, which throws, exits 1, and
  // is read as allow.
  if (parsed.kind !== 'string') return 0;
  const raw = parsed.command;

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
