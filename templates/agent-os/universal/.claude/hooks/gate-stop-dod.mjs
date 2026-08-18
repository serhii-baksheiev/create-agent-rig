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
//   - fail open on any hook error — a crashed gate must not make the session
//     unquittable.
//
// 🔴 The budget, and the one place this gate fails CLOSED. The checks are a
// real test suite, and it can outrun the wiring `timeout` in
// `.claude/settings.json`. So the hook carries a budget of its own, spends it
// BEFORE the wiring's runs out, and treats exhausting it as "not verified",
// which is a block rather than a pass.
//
// ⚠ This rests on ONE assumption about the harness that nothing in this
// repository can prove or falsify: that a hook outrunning its timeout is
// killed, and that a killed Stop hook does not block the stop. If that is ever
// false, this budget is merely redundant — nothing here breaks. It is stated
// rather than asserted because the whole design follows from it.
//
// The budget is ONE allowance for the whole suite, not a fresh one per check:
// a per-step budget is how three checks quietly cost three times the wall
// clock the wiring allows (`.claude/rules/invariants.md` — "an explicit total
// budget rather than a per-step one").
//   see hooks.test.ts › "gates the stop when a check outruns the budget — unmeasured is not a pass"
//   see hooks.test.ts › "spends one budget across the whole suite, not a fresh one per check"
//   see hooks.test.ts › "gives the stop gate a harness timeout its own budget finishes inside"
//
// Limits, each with the test that pins it:
//   - output volume is not a verdict: a passing check that prints more than the
//     buffer allows is a hook problem, never a DoD failure —
//     see hooks.test.ts › "does not read a chatty passing check as a failure (the ENOBUFS false gate)"
//   - a fail-open is announced on stderr, because a silent exit 0 and a clean
//     pass are the same observation from outside —
//     see hooks.test.ts › "announces a fail-open instead of returning a silent clean pass"
//   - an ABSENT config is not a failure and says nothing: universal ships no
//     checks, and "no config → nothing to gate" is the design, not a swallowed
//     error. Only a config that exists and cannot be used announces.
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { withoutGitLocation } from '../scripts/git-env.mjs';

// The default total budget. It must stay strictly below the `timeout` on the
// Stop entry in `.claude/settings.json` (that one is in SECONDS), or the
// harness kills the gate before the gate can report — the two are read from
// their files and compared by the wiring test above, never restated.
const DEFAULT_BUDGET_MS = 600_000;

/** The gate stays open, and says so — a silent 0 is indistinguishable from clean. */
function failOpen(reason) {
  process.stderr.write(`[hook fail-open] ${reason}\n`);
  return 0;
}

/** The total budget for the whole suite: the override if it is usable, else the default. */
function budgetMs(env) {
  const declared = Number(env.RIG_DOD_BUDGET_MS);
  return Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_BUDGET_MS;
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
  if (checks.length === 0) return 0;

  const deadline = Date.now() + budgetMs(process.env);

  for (const command of checks) {
    const remaining = deadline - Date.now();
    const result =
      remaining > 0
        ? spawnSync(command, {
            shell: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: remaining,
            // Output volume is not a verdict. The default 1 MB turned a chatty
            // but PASSING suite into a throw the catch below reported as a
            // failing check — a gate that fired on nothing.
            maxBuffer: 64 * 1024 * 1024,
          })
        : { error: Object.assign(new Error('budget exhausted'), { code: 'ETIMEDOUT' }) };

    if (result.error) {
      // 🔴 The one fail-CLOSED case. Out of budget means the checks did not
      // finish, so nothing was measured — and an unmeasured Definition of Done
      // is not a passed one. Every OTHER error here is the hook's own problem
      // (it could not spawn, it overran its own buffer), and those stay open.
      if (result.error.code !== 'ETIMEDOUT') {
        return failOpen(`the check \`${command}\` could not be run: ${result.error.message}`);
      }
      process.stderr.write(
        `STOP GATED — \`${command}\` exceeded the Definition of Done budget ` +
          `(${budgetMs(process.env)} ms for the whole suite, RIG_DOD_BUDGET_MS).\n` +
          `The checks did not finish, so the Definition of Done is UNMEASURED — which is ` +
          `not a pass. Run them yourself, or raise the budget if the suite has ` +
          `honestly outgrown it (and raise the Stop hook's \`timeout\` in ` +
          `.claude/settings.json with it — the budget must stay the smaller of the two). ` +
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
