// PreToolUse hook: the "Never" tier of .claude/rules/autonomy.md, made
// mechanical. A prompt-level rule is followed most of the time; a hook is
// followed every time, and these are the actions where "most of the time" is
// not good enough because they are not reversible.
//
// It is a SECOND Bash guard on purpose. `block-no-verify` owns exactly one
// invariant (the pre-commit gate may not be bypassed) and stays readable
// because of it; this one owns the irreversible actions and the kill switch.
// One invariant per hook is the pattern; two invariants in one hook is how a
// guard becomes unreadable and then untrusted.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
//
// Matching is SEGMENT-SCOPED: the command is split on pipes and separators, and
// a rule only applies to a segment whose leading word is the command it is
// about. That is what keeps prose out of it — `git commit -m "never rm -rf /"`
// is a `git` segment, so the `rm` rules never see it. Within a segment, quoted
// text is blanked before flags are read, for the same reason.
//
// Accepted limit, stated rather than hidden: a deliberately obfuscated command
// (`git push "--force" origin main`, an alias, a shell script) slips this.
// The guard targets drift, not an adversary — and circumventing it is itself a
// Never-tier violation. The layers behind it are review and CI.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Branches that are shared by definition: rewriting or pushing straight to them affects everyone. */
const PROTECTED = /(^|[\s:+])(main|master|develop|development|trunk)(\s|$)/;
const FORCED = /(^|\s)(-f|--force|--force-with-lease)(\b|=)/;
const MENTIONS_PROD = /\bprod\b|\bproduction\b/i;

/**
 * Targets that make `rm` unrecoverable no matter which directory you are in.
 * Deliberately a short, literal list: a clever heuristic here produces false
 * blocks on `rm -rf ./dist`, and a guard people fight is a guard people disable.
 */
const CATASTROPHIC = /^(\/|\/\*|~|~\/|\$HOME|\$HOME\/|\$\{HOME\}|\$\{HOME\}\/)$/;

/**
 * The kill switch is MACHINE-level, not repo-level, on purpose: a git worktree
 * is its own project root, so a flag dropped in the main checkout would be
 * invisible to a session running inside one. A brake that is silently absent is
 * worse than no brake at all.
 */
const stopFlag = () =>
  process.env.AGENT_LOOP_STOP || join(homedir(), '.claude', 'create-agent-rig-loop-STOP');

/** Quoted text blanked — prose and commit messages must not read as live flags. */
const blank = (segment) => segment.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
/** Quote characters removed, contents kept — `rm -rf "$HOME"` is still `$HOME`. */
const unquote = (segment) => segment.replace(/['"]/g, '');

function checkGit(segment) {
  if (!/\bpush\b/.test(segment)) return null;

  const forced = FORCED.test(segment) || /(^|\s)\+\S/.test(segment);
  const protectedRef = PROTECTED.test(segment.replace(/^\s*git\s+push\b/, ''));

  if (forced && protectedRef) {
    return (
      'BLOCKED — force-pushing a shared branch is a Never-tier action ' +
      '(.claude/rules/autonomy.md). It rewrites history other people and other ' +
      'sessions have already built on. Push a branch and open a PR instead.'
    );
  }
  if (/(^|\s)--mirror\b/.test(segment) || (forced && /(^|\s)--all\b/.test(segment))) {
    return (
      'BLOCKED — a --mirror/--all force-push carries every ref, including the ' +
      'shared branches, whether or not you named them (.claude/rules/autonomy.md). ' +
      'Push the one branch you mean, by name.'
    );
  }
  if (protectedRef) {
    return (
      'BLOCKED — the default branch is never written to directly, and never ' +
      'deleted: it stays releasable at all times (.claude/rules/workflow.md, ' +
      '"Branches and commits"). Work reaches it through a PR.'
    );
  }
  return null;
}

function checkGh(segment) {
  const prod = MENTIONS_PROD.test(segment);
  if (prod && /\bworkflow\s+run\b/.test(segment)) {
    return (
      'BLOCKED — triggering a production deploy from an agent session is a hard ' +
      'stop (.claude/rules/autonomy.md, "Never"). Escalate to the human who owns ' +
      'that release.'
    );
  }
  if (prod && /\/dispatches\b/.test(segment)) {
    return (
      'BLOCKED — dispatching a production workflow through the API is the same ' +
      'hard stop as running it (.claude/rules/autonomy.md, "Never"). Escalate.'
    );
  }
  if (/\bpr\s+merge\b/.test(segment)) {
    const flag = stopFlag();
    if (existsSync(flag)) {
      return (
        `BLOCKED — the kill switch is set (${flag}), so nothing may land on the ` +
        'default branch. Everything else stays allowed on purpose: finish the ' +
        'current task, push the branch, open the PR, write the journal entry, and ' +
        `stop. "Stop cleanly" never means "lose the work". Clear it with: rm ${flag}`
      );
    }
  }
  return null;
}

function checkRm(segment) {
  const targets = unquote(segment)
    .split(/\s+/)
    .slice(1)
    .filter((token) => token && !token.startsWith('-'));
  if (targets.some((target) => CATASTROPHIC.test(target))) {
    return (
      'BLOCKED — this deletes the filesystem root or the whole home directory, ' +
      'which no task in this project requires. If a path really needs removing, ' +
      'name it relative to the project.'
    );
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (input.tool_name !== 'Bash') return 0;
  const raw = String(input.tool_input?.command ?? '');
  if (!raw.trim()) return 0;

  for (const part of raw.split(/[|&;\n]+/)) {
    const segment = ` ${part.trim()} `;
    const head = unquote(part.trim()).split(/\s+/)[0];
    const reason =
      head === 'git'
        ? checkGit(blank(segment))
        : head === 'gh'
          ? checkGh(blank(segment))
          : head === 'rm'
            ? checkRm(segment)
            : null;
    if (reason) {
      process.stderr.write(`${reason}\n`);
      return 2;
    }
  }
  return 0;
}

process.exit(main());
