/**
 * The unattended-execution posture contract (RP-280) — ONE closed list of
 * conditions, so preflight (RP-281) and doctor (RP-282) answer the question
 * "is it safe to run unattended" from the same vocabulary instead of two
 * that can silently drift apart. Why this is one module rather than two
 * probes agreeing by accident: `docs/decisions/unattended-posture.md`.
 *
 * Each condition names: which classification it is (`required` — a run
 * stops; `advisory` — a run cautions and continues; `not-observable` — this
 * rig cannot mechanically tell), which surface(s) report it (`preflight`,
 * `doctor`, both, or neither for `not-observable`), which harness it applies
 * to, and a one-line summary. Both surfaces keep their own probes — this
 * module decides nothing about HOW a condition is observed, only what the
 * closed list of conditions IS and what a reported outcome means.
 *
 * `not-observable` conditions exist so a surface can say what Rig cannot
 * prove, rather than silently omitting it — a thing neither surface
 * mechanically checks (the harness's own loaded-hook state, Codex's `trust`
 * setting, the editor's workspace-trust prompt, the native OS sandbox mode,
 * and the rest the `POSTURE_CONDITIONS` list below names) is reported as
 * unobservable, never folded into a passing `ok`/`GO`. Per
 * `.claude/rules/invariants.md` ("one mechanism, one implementation") that
 * is why `preflightVerdict` and `doctorStatus` both throw rather than map a
 * `not-observable` id to an outcome — there is no "it passed" for a thing
 * nothing looked at.
 *
 * Adding an id here is a deliberate contract change, not a drive-by edit:
 * see test/template/posture.test.ts (absent in a generated rig) ›
 * "exports exactly the required/advisory/not-observable ids the contract
 * names, each kebab-case and unique".
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
    'The kill-switch file is present, and guard-bash is refusing every merge while it is armed.',
  ),
  condition(
    'run-dir-inherited',
    'required',
    ['preflight'],
    'both',
    'RIG_RUN_DIR was inherited from the parent shell rather than declared fresh for this run.',
  ),
  condition(
    'detection-contract-invalid',
    'required',
    ['preflight', 'doctor'],
    'both',
    'The elevated-paths contract detect-missed-gate.mjs reads failed to parse or resolve.',
  ),
  condition(
    'queue-unreadable',
    'required',
    ['preflight'],
    'both',
    'The queue adapter named in .claude/queue.json could not be read.',
  ),
  condition(
    'last-deploy-failed',
    'required',
    ['preflight'],
    'both',
    'The last recorded deploy verdict was REGRESSION and no HEALTHY verdict has cleared it since.',
  ),
  condition(
    'hook-wiring-missing',
    'required',
    ['doctor'],
    'both',
    'A hook .claude/settings.json names is missing from .claude/hooks/, or is not wired there.',
  ),
  condition(
    'guard-integrity-failed',
    'required',
    ['doctor'],
    'both',
    "An owned guard's bytes differ from the installed manifest with no test file beside it.",
  ),
  condition(
    'unattended-flag-stale',
    'required',
    ['preflight', 'doctor'],
    'both',
    'The unattended flag on disk predates this checkout\'s current claim, so it may belong to a run that already ended.',
  ),
  condition(
    'workflow-layer-missing',
    'required',
    ['doctor'],
    'both',
    'The queue configuration names the opt-in workflow layer, but its files are not installed.',
  ),
  // advisory — a run cautions and continues.
  condition(
    'default-branch-stale',
    'advisory',
    ['preflight'],
    'both',
    "The default branch has diverged from origin/HEAD by more commits than preflight's own bound allows.",
  ),
  condition(
    'tracker-credentials-missing',
    'advisory',
    ['doctor'],
    'both',
    'The tracker credentials this queue adapter needs are not set in the environment.',
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
    'One of the runtime paths this layer requires in .gitignore is missing from it.',
  ),
  // not-observable — this rig cannot mechanically tell, so neither surface
  // may map it to a passing outcome.
  condition(
    'harness-hooks-loaded',
    'not-observable',
    [],
    'both',
    "Whether the attached harness actually loaded these hooks this session — neither surface can read the harness's own loaded-hook state from outside it.",
  ),
  condition(
    'codex-hook-trust',
    'not-observable',
    [],
    'codex',
    "Whether Codex's own trust setting approved these hooks to run at all.",
  ),
  condition(
    'workspace-trust',
    'not-observable',
    [],
    'both',
    "Whether the editor's workspace-trust prompt was accepted for this checkout.",
  ),
  condition(
    'native-sandbox-mode',
    'not-observable',
    [],
    'both',
    "Which native OS sandbox mode the harness is running under is the harness's own setting, not something this rig can read.",
  ),
  condition(
    'session-root-matches-run',
    'not-observable',
    [],
    'both',
    "Whether the session's own working-directory root is the checkout the run directory was declared for.",
  ),
  condition(
    'run-dir-fresh-per-run',
    'not-observable',
    [],
    'both',
    'Whether RIG_RUN_DIR was freshly declared for this run rather than left over from an earlier one — run-dir-inherited catches one failure mode of this; the rest is not mechanically observable.',
  ),
  condition(
    'budget-declared',
    'not-observable',
    [],
    'both',
    'Whether a bounded point-of-diminishing-returns budget was actually agreed for this run before it started.',
  ),
  condition(
    'stray-worktree',
    'not-observable',
    [],
    'both',
    'Whether every linked worktree belongs to a run still in flight, or one that stopped without cleanup — nothing records a worktree\'s owning run.',
  ),
]);

/** The matching condition for `id`, or `undefined` for an id the contract does not name. */
export const conditionById = (id) => POSTURE_CONDITIONS.find((entry) => entry.id === id);

/**
 * The preflight verdict for a set of reported outcomes, keyed by condition id.
 *
 * Throws for an id the contract does not name, and for an id whose condition
 * does not list `preflight` among its surfaces — that covers both a
 * `not-observable` id (empty surfaces) and a `doctor`-only id, because
 * neither may be reported to this surface at all.
 *
 * A required condition reporting `fail` outranks everything else and
 * returns `STOP`. Short of that, any `fail` (necessarily advisory, by the
 * rule above) or any `unknown` (required or advisory) returns `CAUTION`.
 * Otherwise — including an empty `outcomes` object — the verdict is `GO`.
 */
export const preflightVerdict = (outcomes) => {
  const entries = Object.entries(outcomes ?? {});
  const conditions = entries.map(([id, outcome]) => {
    const found = conditionById(id);
    if (!found) throw new Error(`preflightVerdict: "${id}" is not a condition this contract names.`);
    if (!found.surfaces.includes('preflight')) {
      throw new Error(`preflightVerdict: "${id}" is not a preflight condition.`);
    }
    return { found, outcome };
  });

  if (conditions.some(({ found, outcome }) => found.classification === 'required' && outcome === 'fail')) {
    return 'STOP';
  }
  if (conditions.some(({ outcome }) => outcome === 'fail' || outcome === 'unknown')) {
    return 'CAUTION';
  }
  return 'GO';
};

/**
 * The doctor status for one condition's reported outcome.
 *
 * Throws for an id the contract does not name, and for an id whose
 * condition does not list `doctor` among its surfaces — same two cases as
 * `preflightVerdict` above, mirrored for this surface.
 *
 * A required condition maps `fail`→`fail`, `pass`→`ok`, anything else
 * (including `unknown`)→`warn` — a required condition this surface could
 * not confirm cautions rather than silently passing. An advisory condition
 * never returns `fail`: it maps `pass`→`ok` and anything else→`warn`.
 */
export const doctorStatus = (id, outcome) => {
  const found = conditionById(id);
  if (!found) throw new Error(`doctorStatus: "${id}" is not a condition this contract names.`);
  if (!found.surfaces.includes('doctor')) {
    throw new Error(`doctorStatus: "${id}" is not a doctor condition.`);
  }

  if (found.classification === 'required') {
    if (outcome === 'fail') return 'fail';
    if (outcome === 'pass') return 'ok';
    return 'warn';
  }
  return outcome === 'pass' ? 'ok' : 'warn';
};
