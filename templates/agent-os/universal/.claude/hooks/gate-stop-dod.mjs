// Stop hook: the Definition of Done as a mechanical gate. The session may not
// end while a named DoD check fails — the checklist stops being a wish.
//
// The stack layer supplies the checks (.claude/hooks/dod-checks.json — an
// array of shell commands, cheap and deterministic). Universal supplies only
// the mechanism: no config → nothing to gate.
//
// Anti-loop discipline (the classic Stop-hook trap):
//   - stop_hook_active in the payload means we already blocked this stop once
//     — never block again, or an agent that cannot go green spins forever;
//   - a clean git tree stops instantly: nothing changed, nothing to gate;
//   - fail open on any fault of the hook's OWN — a crashed gate must not make
//     the session unquittable. A check that ran and was killed is NOT one of
//     those; the 🔴 block below is the rule that separates the two.
//
// 🔴 The budget, and the one place this gate fails CLOSED. The checks are a
// real test suite, and it can outrun the wiring `timeout` in
// `.claude/settings.json`. So the hook carries a budget of its own and spends
// it BEFORE the wiring's runs out.
//
// The rule the whole file follows, stated once because two earlier readings of
// it disagreed:
//
//   a check that did not produce a VERDICT blocks;
//   a gate that could not START stays open.
//
// `spawnSync` reports a timeout and a buffer overrun the same way — an `error`
// with `status: null` — and in both the check's result is unknown. Unmeasured
// is not a pass. The hook's OWN faults (an unreadable payload, a config it
// cannot use, a shell it cannot spawn) keep failing open and announcing
// themselves, so a crashed gate still cannot make the session unquittable.
//
// The budget is ONE allowance for the whole suite, not a fresh one per check:
// a per-step budget is how three checks quietly cost three times the wall
// clock the wiring allows (`.claude/rules/invariants.md` — "an explicit total
// budget rather than a per-step one").
//   see hooks.test.ts › "gates the stop when a check outruns the budget — unmeasured is not a pass"
//   see hooks.test.ts › "spends one budget across the whole suite, not a fresh one per check"
//   see hooks.test.ts › "gives the stop gate a harness timeout its own budget finishes inside"
//
// ⚠ This rests on ONE assumption about the harness that nothing in this
// repository can prove or falsify: that a hook outrunning its timeout is
// killed, and that a killed Stop hook does not block the stop. If it is false
// the budget is not merely inert — it becomes the only thing that would stop a
// suite still running at the wiring timeout. It is stated rather than asserted
// because the whole design follows from it.
//
// Limits, each with the test that pins it:
//   - a check whose output outgrows the buffer is UNMEASURED, and blocks like
//     any other unmeasured check —
//     see hooks.test.ts › "gates the stop when a check drowns its own buffer — a pass nobody watched is not a pass"
//   - below that buffer, output volume is not a verdict: a chatty check that
//     passes, passes —
//     see hooks.test.ts › "does not read a chatty passing check as a failure (the ENOBUFS false gate)"
//   - the RIG_DOD_BUDGET_MS override may only LOWER the budget, and an
//     override this hook did not honour is announced rather than ignored —
//     see hooks.test.ts › "clamps a budget override that would outlive the harness, and names the budget it used"
//   - a fail-open is announced on stderr, because a silent exit 0 and a clean
//     pass are the same observation from outside —
//     see hooks.test.ts › "announces a fail-open instead of returning a silent clean pass"
//   - an ABSENT config is not a failure and says nothing; only a config that
//     exists and cannot be used announces —
//     see hooks.test.ts › "stays silent when there is no config at all — nothing to gate is the design, not a swallowed error"
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { withoutGitLocation } from '../scripts/git-env.mjs';

// The default total budget. It must stay strictly below the `timeout` on the
// Stop entry in `.claude/settings.json` (that one is in SECONDS), or the
// harness kills the gate before the gate can report — the two are read from
// their files and compared, never restated —
//   see hooks.test.ts › "gives the stop gate a harness timeout its own budget finishes inside"
const DEFAULT_BUDGET_MS = 600_000;

/** The gate stays open, and says so — a silent 0 is indistinguishable from clean. */
function failOpen(reason) {
  process.stderr.write(`[hook fail-open] ${reason}\n`);
  return 0;
}

/**
 * Error codes that mean the child never ran, so there is no verdict to lose.
 * Everything else that surfaces as `result.error` — a timeout, a buffer
 * overrun — killed a check that WAS running, and that is the unmeasured case.
 */
const SPAWN_NEVER_STARTED = new Set(['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOMEM']);

/**
 * The total budget for the whole suite, and a note when the override was not
 * taken at face value.
 *
 * 🔴 The override may only LOWER the budget. Raising it past the wiring's
 * `timeout` puts back the exact defect this hook exists to remove — the
 * harness kills the gate before it can report, and that kill is silent.
 * Raising the ceiling is a two-file decision (this constant and the wiring),
 * deliberately not something one environment variable can do.
 *
 * An override this hook did not honour is announced, never silently dropped:
 * an operator who set a budget and got a different one has to be able to see
 * it. `Number.isSafeInteger` is the test rather than `isFinite`, because
 * `spawnSync` throws on a fractional `timeout` — and a throw here would land in
 * the backstop and open the gate completely.
 *   see hooks.test.ts › "runs the gate on the default budget when the override is unusable, instead of not running it"
 */
function budgetMs(env) {
  const raw = env.RIG_DOD_BUDGET_MS;
  if (raw === undefined || raw === '') return { ms: DEFAULT_BUDGET_MS, notice: null };

  const declared = Number(raw);
  if (!Number.isSafeInteger(declared) || declared <= 0) {
    return {
      ms: DEFAULT_BUDGET_MS,
      notice:
        `RIG_DOD_BUDGET_MS=${raw} is not a whole number of milliseconds above zero — ` +
        `using the default ${DEFAULT_BUDGET_MS} ms instead.`,
    };
  }
  if (declared > DEFAULT_BUDGET_MS) {
    return {
      ms: DEFAULT_BUDGET_MS,
      notice:
        `RIG_DOD_BUDGET_MS=${raw} is above this gate's ceiling and was clamped to ` +
        `${DEFAULT_BUDGET_MS} ms — the budget must expire before the Stop hook's ` +
        `\`timeout\` in .claude/settings.json, or the gate is killed before it can report. ` +
        `Raise both, in their own files, to raise it at all.`,
    };
  }
  return { ms: declared, notice: null };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    return failOpen(`the Stop payload could not be read: ${error.message}`);
  }
  if (input.hook_event_name !== 'Stop' && input.hook_event_name !== 'SubagentStop') return 0;
  if (input.stop_hook_active) return 0;

  try {
    // The environment loses the variables that locate a repository first. A
    // process started under a git hook inherits an absolute GIT_DIR, and this
    // question — "is the tree clean?" — would then be answered about a
    // different repository entirely: gated on somebody else's uncommitted
    // work, or waved through despite its own.
    //
    // The canonical list, imported. This file used to carry four of the eight
    // inline, justified by "it ships into generated projects, so it cannot
    // import the canonical list from the generator" — a reason that expired the
    // day `.claude/scripts/git-env.mjs` started shipping into generated projects
    // too. Both are in the same layer, one directory apart.
    //
    // The four it dropped were not a smaller opinion. `GIT_OBJECT_DIRECTORY`
    // pointing anywhere but this repository's objects makes `git status` exit
    // 128 (`fatal: bad object HEAD`) — which the catch below reads as "not a git
    // repo" and waves through, running the whole Definition-of-Done suite
    // against a tree it never managed to read.
    //
    // 🔴 Limit: only THIS command is sanitised. The Definition-of-Done checks
    // below run with the environment as given, because they are the project's
    // own commands and their environment is the project's business.
    const status = execSync('git status --porcelain', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: withoutGitLocation(),
    });
    if (status.trim() === '') return 0;
  } catch {
    // not a git repo — run the checks anyway
  }

  let checks;
  try {
    checks = JSON.parse(readFileSync(new URL('./dod-checks.json', import.meta.url), 'utf8'));
  } catch (error) {
    // An absent config is the documented "nothing to gate" case, not an error
    // to announce; anything else is a config that exists and cannot be used.
    if (error.code === 'ENOENT') return 0;
    return failOpen(`dod-checks.json could not be read: ${error.message}`);
  }
  if (!Array.isArray(checks)) return failOpen('dod-checks.json is not an array of commands');
  // Decided HERE rather than left to `spawnSync`, which throws on a non-string
  // and lands the throw in the backstop below: the same exit code by accident
  // instead of by decision, and a message about argument types instead of the
  // file to fix.
  //   see hooks.test.ts › "announces a config it could read but cannot use, and names the file to fix"
  if (!checks.every((command) => typeof command === 'string')) {
    return failOpen('dod-checks.json must be an array of command strings');
  }
  if (checks.length === 0) return 0;

  const budget = budgetMs(process.env);
  if (budget.notice) process.stderr.write(`gate-stop-dod: ${budget.notice}\n`);
  const deadline = Date.now() + budget.ms;

  for (const command of checks) {
    // A 1 ms floor rather than a branch for "the budget is already gone": the
    // check then times out through the ordinary path, which names the command
    // that did not fit instead of blaming it for spending what an earlier one
    // spent. One path, and no branch that only a race can reach.
    const result = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, deadline - Date.now()),
      // Output volume is not a verdict — below this bound. Past it the child is
      // killed and its result is unknown, which the error branch treats as
      // unmeasured rather than as a failure or a pass. The old 1 MB default
      // made a chatty but PASSING suite look like a failing check.
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
      // 🔴 The rule this file follows, at the point where it is decided.
      //
      // A spawn that never started is the gate's own problem — no shell, no
      // file descriptors — and there is no verdict to lose, so it stays open
      // and says so.
      if (SPAWN_NEVER_STARTED.has(result.error.code)) {
        return failOpen(`the check \`${command}\` could not be started: ${result.error.message}`);
      }
      // Everything else killed a check that WAS running — a timeout, a buffer
      // overrun, anything unrecognised. `status` is null, so the verdict is
      // unknown, and an unmeasured Definition of Done is not a passed one.
      const timedOut = result.error.code === 'ETIMEDOUT';
      process.stderr.write(
        `STOP GATED — \`${command}\` produced no verdict: ${result.error.message}\n` +
          (timedOut
            ? `It did not finish inside the ${budget.ms} ms budget for the whole suite ` +
              `(RIG_DOD_BUDGET_MS lowers it; raising it means raising this hook's default ` +
              `and the Stop hook's \`timeout\` in .claude/settings.json together, in that ` +
              `order — the budget must stay the smaller of the two).\n`
            : `It was killed before it could report — output past the buffer is the usual ` +
              `cause. Run it yourself to see the result.\n`) +
          `The check's outcome is UNMEASURED, which is not a pass. ` +
          `This gate never fires twice in a row.\n`,
      );
      return 2;
    }

    if (result.status !== 0) {
      const tail = String(result.stdout ?? '')
        .split('\n')
        .slice(-15)
        .join('\n');
      process.stderr.write(
        `STOP GATED — a Definition of Done check fails: ${command}\n` +
          (tail.trim() ? `${tail}\n` : '') +
          `Fix the failure before ending the session. If this failure has resisted ` +
          `repeated attempts, follow the stop rules instead: end with a written ` +
          `diagnosis (.claude/rules/autonomy.md). This gate never fires twice in a row.\n`,
      );
      return 2;
    }
  }
  return 0;
}

let code;
try {
  code = main();
} catch (error) {
  // The backstop. A gate that throws must not make the session unquittable —
  // but it must not look clean either.
  code = failOpen(`the gate itself threw: ${error.message}`);
}
process.exit(code);
