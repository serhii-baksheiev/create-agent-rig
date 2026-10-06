/**
 * The unattended-execution posture contract (RP-280) — ONE closed list of
 * conditions, so preflight (RP-281, opt-in workflow layer) and the CLI's
 * `create-agent-rig doctor` (RP-282) answer "is it safe to run unattended"
 * from the same vocabulary instead of two that can silently drift apart.
 * Why this is one module: `docs/decisions/unattended-posture.md`.
 *
 * Each condition names its classification (`required` — a run stops;
 * `advisory` — a run cautions and continues; `not-observable` — Rig cannot
 * mechanically tell), the surfaces that report it (`preflight`, `doctor`),
 * the harness it applies to, and a one-line summary of what is checked.
 * Both surfaces keep their own probes; this module decides only what the
 * conditions are and what a reported outcome means.
 *
 * A surface may name a `not-observable` condition, but only with the
 * outcome `unknown`: it says what Rig could not prove and never turns it
 * into a pass. An outcome other than exactly `pass` is never read as one.
 *
 * Adding an id is a deliberate contract change: see
 * test/template/posture.test.ts (absent in a generated rig) › "exports
 * exactly the required/advisory/not-observable ids the contract names,
 * each kebab-case and unique".
 */

const condition = (id, classification, surfaces, harness, summary) =>
  Object.freeze({ id, classification, surfaces: Object.freeze(surfaces), harness, summary });

/** The closed list — see the header above for what each field means. */
export const POSTURE_CONDITIONS = Object.freeze([
  // required — a run stops.
  condition(
    'kill-switch-armed',
    'required',
    ['preflight', 'doctor'],
    'both',
    'The kill-switch file is present in the home directory of the process that checks, or at a path AGENT_LOOP_STOP names.',
  ),
  condition(
    'run-dir-inherited',
    'required',
    ['preflight'],
    'both',
    'RIG_RUN_DIR is already set in the environment preflight runs in, before the run declares its own.',
  ),
  condition(
    'detection-contract-invalid',
    'required',
    ['preflight', 'doctor'],
    'both',
    '.rig/revalidation.json, the revalidation detection contract, is missing or does not pass its reader.',
  ),
  condition(
    'queue-unreadable',
    'required',
    ['preflight'],
    'both',
    'The queue adapter .claude/queue.json names could not list eligible items.',
  ),
  condition(
    'last-deploy-failed',
    'required',
    ['preflight'],
    'both',
    "The latest run of the project's deploy workflow, as GitHub reports it, did not conclude with success.",
  ),
  condition(
    'hook-wiring-missing',
    'required',
    ['doctor'],
    'both',
    'A hook entry the rig ships is missing from .claude/settings.json or .codex/hooks.json, or hooks are disabled there.',
  ),
  condition(
    'guard-integrity-failed',
    'required',
    ['doctor'],
    'both',
    'An installed guard, or a script it loads, differs from the bytes this Rig version ships, or misbehaves on the guard fixtures.',
  ),
  condition(
    'unattended-flag-stale',
    'required',
    ['preflight'],
    'both',
    'An unattended flag for this checkout is already on disk, or unreadable, before the run arms its own.',
  ),
  condition(
    'workflow-layer-missing',
    'required',
    ['doctor'],
    'both',
    "The installed manifest's layers do not include the workflow layer that unattended runs use.",
  ),
  // advisory — a run cautions and continues.
  condition(
    'default-branch-stale',
    'advisory',
    ['preflight'],
    'both',
    "After a fetch, the local default branch is not the same commit as the remote's.",
  ),
  condition(
    'tracker-credentials-missing',
    'advisory',
    ['doctor'],
    'both',
    'An environment variable the configured tracker adapter needs is not set; values are never read.',
  ),
  condition(
    'dod-checks-missing',
    'advisory',
    ['doctor'],
    'both',
    '.claude/hooks/dod-checks.json is absent, so gate-stop-dod has nothing to run.',
  ),
  condition(
    'gitignore-runtime-entries-missing',
    'advisory',
    ['doctor'],
    'both',
    'A runtime path the installed layers require in .gitignore is not listed there.',
  ),
  // not-observable — Rig cannot mechanically tell; a surface may name one
  // only with the outcome `unknown`.
  condition(
    'harness-hooks-loaded',
    'not-observable',
    [],
    'both',
    'Whether the harness actually loaded these hooks in this session.',
  ),
  condition(
    'codex-hook-trust',
    'not-observable',
    ['doctor'],
    'codex',
    'Whether Codex has been told to trust the project hooks.',
  ),
  condition(
    'workspace-trust',
    'not-observable',
    [],
    'both',
    "Whether the harness's own project or workspace trust was granted for this checkout.",
  ),
  condition(
    'native-sandbox-mode',
    'not-observable',
    [],
    'both',
    'Which native sandbox and permission mode the session runs under.',
  ),
  condition(
    'session-root-matches-run',
    'not-observable',
    [],
    'both',
    "Whether the session was started from the checkout its run directory belongs to.",
  ),
  condition(
    'run-dir-fresh-per-run',
    'not-observable',
    [],
    'both',
    'Whether each run declares a fresh run directory rather than reusing an earlier one.',
  ),
  condition(
    'budget-declared',
    'not-observable',
    ['preflight'],
    'both',
    'Whether a budget for this run was declared before it started.',
  ),
  condition(
    'stray-worktree',
    'not-observable',
    ['preflight'],
    'both',
    'Whether a linked worktree is left over from a run that stopped without cleaning up.',
  ),
]);

/** The matching condition for `id`, or `undefined` for an id the contract does not name. */
export const conditionById = (id) => POSTURE_CONDITIONS.find((entry) => entry.id === id);

/** Only the exact strings `pass` and `fail` keep their meaning; anything else is `unknown`. */
const normalise = (outcome) => (outcome === 'pass' || outcome === 'fail' ? outcome : 'unknown');

/** The condition for `id` on `surface`, refusing what the contract says that surface cannot report. */
const onSurface = (fn, id, raw, surface) => {
  const found = conditionById(id);
  if (!found) throw new Error(`${fn}: "${id}" is not a condition this contract names.`);
  if (!found.surfaces.includes(surface)) {
    throw new Error(`${fn}: "${id}" is not a ${surface} condition.`);
  }
  if (found.classification === 'not-observable' && raw !== 'unknown') {
    throw new Error(`${fn}: "${id}" is not observable, so its only outcome is "unknown".`);
  }
  return found;
};

/**
 * The preflight verdict for a set of reported outcomes, keyed by condition id.
 *
 * A required condition reporting `fail` returns `STOP`. Short of that, any
 * outcome other than `pass` — including the `unknown` that is a
 * not-observable condition's only outcome — returns `CAUTION`. Otherwise —
 * including an empty `outcomes` object — `GO`.
 */
export const preflightVerdict = (outcomes) => {
  const reported = Object.entries(outcomes ?? {}).map(([id, raw]) => ({
    found: onSurface('preflightVerdict', id, raw, 'preflight'),
    outcome: normalise(raw),
  }));

  if (reported.some(({ found, outcome }) => found.classification === 'required' && outcome === 'fail')) {
    return 'STOP';
  }
  if (reported.some(({ outcome }) => outcome !== 'pass')) return 'CAUTION';
  return 'GO';
};

/**
 * The doctor status for one condition's reported outcome: a required
 * condition maps `fail` to `fail`; `pass` maps to `ok`; anything else —
 * an advisory `fail`, any `unknown`, a not-observable condition — is `warn`.
 */
export const doctorStatus = (id, raw) => {
  const found = onSurface('doctorStatus', id, raw, 'doctor');
  const outcome = normalise(raw);
  if (found.classification === 'required' && outcome === 'fail') return 'fail';
  return outcome === 'pass' ? 'ok' : 'warn';
};
