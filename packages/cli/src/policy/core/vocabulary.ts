/**
 * The closed vocabularies of the policy declaration (RP-76).
 *
 * Every value a declaration or a decision record may carry in an enumerated
 * field is listed here and nowhere else. Adding a value is a schema edit — a
 * change to this file plus the test that pins the list — never a string a
 * caller invents at runtime. That is what makes a record auditable: an unknown
 * word is refused rather than read as something close to a known one.
 *
 * Harness-neutral by construction: nothing here names a harness, a vendor, a
 * native tool or a native path. The per-harness spellings live in
 * `../harness/`, and `test/template/policy-declaration.test.ts` › "no file
 * under src/policy/core mentions a harness, a vendor, a native tool or a native
 * path" is what keeps them out of here.
 */

const closed = <const T extends readonly string[]>(values: T): T => Object.freeze(values);

/**
 * Whether a declared policy can actually be enforced on a given harness
 * surface. `UNSUPPORTED` and `INTEGRATION-FAILED` never yield a silent pass:
 * a decision record carrying either must qualify its verdict `UNVERIFIABLE`
 * (`./decision-record.ts`). The four states are defined here.
 */
export const CAPABILITY_STATES = closed([
  'SUPPORTED',
  'DEGRADED',
  'UNSUPPORTED',
  'INTEGRATION-FAILED',
] as const);
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/**
 * The states under which no question was actually put to a working mechanism.
 *
 * One spelling of one fact (`rules/invariants.md`, "One mechanism, one
 * implementation"): `./decision-record.ts` refuses an unqualified verdict
 * carrying one of these, and `./coverage.ts` › `qualifierFor` returns
 * `UNVERIFIABLE` for exactly the same set. Two copies would disagree, and the
 * one nobody is looking at would be the one that let a silent pass through.
 *
 * It is deliberately NOT derived from a rank or an ordering. `coverage.ts`
 * carries an enforcement ordering for deciding what counts as a downgrade;
 * keying verdict qualification off that would mean a future re-rank silently
 * changed which verdicts are unverifiable.
 */
export const UNENFORCEABLE_STATES = closed(['UNSUPPORTED', 'INTEGRATION-FAILED'] as const);

/**
 * The two ways a capability status is established, and the only two.
 *
 * `probe` is one active read of the surface's own wiring, taken when the
 * surface changes (`PROBE_TRIGGERS`). `traffic` is passive: an operation that
 * was expected to produce an observable signal, and what it actually produced.
 * There is deliberately no third source meaning "time passed" — silence is
 * absence of evidence, not evidence of absence.
 */
export const VERIFICATION_SOURCES = closed(['probe', 'traffic'] as const);
export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];

/**
 * The occasions on which a surface is probed. Every member is an event on the
 * surface; none of them is an interval.
 *
 * What this vocabulary does, exactly: `./coverage.ts` › `coverageFromProbe`
 * takes a trigger as a required argument and refuses a word outside this list,
 * so a probe must NAME its occasion and cannot name a schedule — ›
 * "refuses the trigger %j, because a probe is occasioned by a change to the
 * surface and by nothing else".
 *
 * ⚠ What it does NOT do, stated because an earlier draft of this comment
 * claimed it: nothing here stops a caller passing `'upgrade'` on a timer. The
 * check refuses a LABEL outside the vocabulary, not the practice of probing
 * periodically. `docs/decisions/capability-coverage.md` §1 says the same, and
 * this file used to contradict it.
 */
export const PROBE_TRIGGERS = closed(['install', 'upgrade', 'registration', 'reconnect'] as const);
export type ProbeTrigger = (typeof PROBE_TRIGGERS)[number];

/** The autonomy tiers of `rules/autonomy.md`; `never` is the tier the guards enforce. */
export const AUTONOMY_TIERS = closed(['tier-0', 'tier-1', 'tier-2', 'never'] as const);
export type AutonomyTier = (typeof AUTONOMY_TIERS)[number];

/** The operations a policy can apply to, named by what the agent does, not by a tool. */
export const OPERATIONS = closed(['file-edit', 'shell-command'] as const);
export type Operation = (typeof OPERATIONS)[number];

/** When the mechanism decides, relative to the operation it judges. */
export const ENFORCEMENT_TIMINGS = closed(['before-operation'] as const);
export type EnforcementTiming = (typeof ENFORCEMENT_TIMINGS)[number];

/** What a harness must provide for the mechanism to run at all. */
export const HARNESS_CAPABILITIES = closed(['pre-operation-hook'] as const);
export type HarnessCapability = (typeof HARNESS_CAPABILITIES)[number];

/**
 * The three outcomes a guard can reach: allow, block, or refuse to inspect —
 * the third being neither a match nor an error (`rules/invariants.md`,
 * "Refusing to inspect is a third outcome").
 */
export const DECISION_OUTCOMES = closed(['allow', 'block', 'refuse-to-inspect'] as const);
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/** What a mechanism does when it cannot decide: let the operation through, or stop it. */
export const FAILURE_SEMANTICS = closed(['fail-open', 'fail-closed'] as const);
export type FailureSemantics = (typeof FAILURE_SEMANTICS)[number];

/** The kinds of evidence a decision record may carry, and a policy may require. */
export const EVIDENCE_KINDS = closed(['exit-code', 'diagnostic-text', 'test-pointer'] as const);
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** How a mechanism treats what it matched when it reports: verbatim, or omitted. */
export const REDACTION_RULES = closed(['none', 'omit-matched-values'] as const);
export type RedactionRule = (typeof REDACTION_RULES)[number];

/** Where a policy is in its life; a `retired` policy is no longer offered by the registry. */
export const LIFECYCLE_STATES = closed(['active', 'deprecated', 'retired'] as const);
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * The two ways a verdict can say "this word is weaker than it looks": the
 * question could not be put (`UNVERIFIABLE`), or nothing backs the answer
 * (`UNMEASURED`). Either one must carry a reason.
 */
export const VERDICT_QUALIFIERS = closed(['UNVERIFIABLE', 'UNMEASURED'] as const);
export type VerdictQualifier = (typeof VERDICT_QUALIFIERS)[number];
