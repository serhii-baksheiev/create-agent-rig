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
