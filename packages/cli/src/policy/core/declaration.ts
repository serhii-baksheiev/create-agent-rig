/**
 * The typed policy declaration (RP-76).
 *
 * A declaration is the semantic source of one policy: what the invariant is,
 * where it applies, what the mechanism can answer, how it fails, what a
 * verdict must carry as evidence, and which version of those semantics a
 * decision record is talking about. It is data plus a validator — not a policy
 * language, not an interpreter, not a compiler: a harness adapter reads a
 * declaration and names its own native surface for it (`./adapter.ts`), and
 * that is the whole of the transformation.
 *
 * The shape is closed: a field this interface does not name is refused, so a
 * field added by mistake cannot travel unnoticed into a record somebody later
 * audits. Every enumerated field draws from `./vocabulary.ts`.
 *
 * 🔴 `validateDeclaration` reads every field of its input through `ownField`
 * (`./validation.ts`) — own and enumerable, the set `Object.keys` walks — and
 * never off the record directly. `unknownKeys` on the line above already judges
 * the record by `Object.keys`, so a wider read made the closed-shape check and
 * the field reads disagree about what the record contains, with the reads being
 * the wider of the two — the direction that passes. The consequence here is one
 * step worse than in `./decision-record.ts`, because this validator's answer is
 * kept: `definePolicy` copies the validated declaration by spread, and a spread
 * copies own-enumerable keys only. So a declaration whose `tier` and `redaction`
 * were only inherited used to be accepted and then FROZEN into the registry
 * with no `tier` key and no `redaction` key at all — reading either yields
 * `undefined` — a malformed entry produced by the function whose whole job is to
 * refuse malformed ones. Held over all fifteen fields, in both shapes (inherited,
 * and own but not enumerable), in `packages/cli/test/policy-declaration.test.ts`
 * › "refuses a declaration whose %s is %s, because the declaration it writes out
 * carries no such field" and, for the frozen-entry consequence, › "refuses a
 * declaration whose tier is %s, rather than freezing an entry with no tier at
 * all". The `%s` are the names as the `it.each` cases DECLARE them — quoting an
 * expanded case instead is a pointer no grep lands on, which is what
 * `test/template/evidence-pointers.test.ts` treats as a wildcard and what
 * `rules/invariants.md` means by "the test's whole name".
 *
 * ⚠ What this does NOT do: `validateDeclaration` returns the input object
 * itself (`input as unknown as PolicyDeclaration`), so what a caller gets back
 * is the record it passed in, not a snapshot of the fields that were certified.
 * Those are the same thing for a value whose fields are plain DATA, which is
 * every declaration `JSON.parse` can produce; they are not the same for one
 * carrying a live accessor. **An object literal is not the line** — a literal
 * can carry a getter, and an earlier version of this sentence put literals on
 * the safe side, which named the one shape that reaches the gap as the shape
 * that avoids it. Here the consequence is kept rather than merely returned:
 * `definePolicy` spreads the validated value, so a getter validated on read 1
 * is FROZEN into the registry from read 2. That gap is RP-157, and
 * `./decision-record.ts` states the identical limit at its own return.
 */

import {
  AUTONOMY_TIERS,
  DECISION_OUTCOMES,
  ENFORCEMENT_TIMINGS,
  EVIDENCE_KINDS,
  FAILURE_SEMANTICS,
  HARNESS_CAPABILITIES,
  LIFECYCLE_STATES,
  OPERATIONS,
  REDACTION_RULES,
} from './vocabulary.js';
import type {
  AutonomyTier,
  DecisionOutcome,
  EnforcementTiming,
  EvidenceKind,
  FailureSemantics,
  HarnessCapability,
  LifecycleState,
  Operation,
  RedactionRule,
} from './vocabulary.js';
import {
  isRecord,
  matching,
  member,
  members,
  nonEmptyString,
  ownField,
  unknownKeys,
} from './validation.js';
import type { Problem, Validation } from './validation.js';

export type { Problem, Validation } from './validation.js';

export interface PolicyDeclaration {
  /** Stable kebab-case identity; a decision record names the policy by it. */
  policyId: string;
  /**
   * `MAJOR.MINOR`. Same MAJOR means the same semantics for a reader of a
   * decision record; a MINOR bump is additive. `./registry.ts` ›
   * `compatibilityOf` is the rule.
   */
  policyVersion: string;
  lifecycle: LifecycleState;
  /** One sentence in the form "X never happens in Y". */
  invariant: string;
  tier: AutonomyTier;
  /** The operations the mechanism judges; non-empty, no repeats. */
  operations: readonly Operation[];
  timing: EnforcementTiming;
  requiredCapability: HarnessCapability;
  /** The harness-neutral name of the enforcing mechanism, kebab-case. */
  mechanism: string;
  /** The outcomes the mechanism can reach; non-empty, no repeats. */
  outcomes: readonly DecisionOutcome[];
  /** What the mechanism does when it throws. */
  onInternalError: FailureSemantics;
  /** What the mechanism does with input it can see but cannot read. */
  onUnreadableInput: FailureSemantics;
  /** The evidence a decision record for this policy must carry; may be empty, no repeats. */
  requiredEvidence: readonly EvidenceKind[];
  redaction: RedactionRule;
  /** Where the rule is stated in prose, relative to the rulebook. */
  statedIn: string;
}

/**
 * The closed set of fields a declaration may carry — exported so a test can
 * check the fixture against THIS list by name rather than by counting it.
 * A count agrees with a set that has drifted; `rules/invariants.md`, "One
 * mechanism, one implementation".
 */
export const KEYS = [
  'policyId',
  'policyVersion',
  'lifecycle',
  'invariant',
  'tier',
  'operations',
  'timing',
  'requiredCapability',
  'mechanism',
  'outcomes',
  'onInternalError',
  'onUnreadableInput',
  'requiredEvidence',
  'redaction',
  'statedIn',
] as const;

export const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;
export const POLICY_VERSION = /^\d+\.\d+$/;

/** Validate an unknown value as a declaration, reporting every problem at once. */
export function validateDeclaration(input: unknown): Validation<PolicyDeclaration> {
  if (!isRecord(input)) {
    return { ok: false, problems: [{ field: '', message: 'a declaration is an object' }] };
  }
  const problems: Problem[] = [];
  unknownKeys(problems, input, KEYS);
  matching(problems, 'policyId', ownField(input, 'policyId'), KEBAB_CASE, 'kebab-case');
  matching(
    problems,
    'policyVersion',
    ownField(input, 'policyVersion'),
    POLICY_VERSION,
    'MAJOR.MINOR',
  );
  member(problems, 'lifecycle', ownField(input, 'lifecycle'), LIFECYCLE_STATES);
  nonEmptyString(problems, 'invariant', ownField(input, 'invariant'));
  member(problems, 'tier', ownField(input, 'tier'), AUTONOMY_TIERS);
  members(problems, 'operations', ownField(input, 'operations'), OPERATIONS, { nonEmpty: true });
  member(problems, 'timing', ownField(input, 'timing'), ENFORCEMENT_TIMINGS);
  member(
    problems,
    'requiredCapability',
    ownField(input, 'requiredCapability'),
    HARNESS_CAPABILITIES,
  );
  matching(problems, 'mechanism', ownField(input, 'mechanism'), KEBAB_CASE, 'kebab-case');
  members(problems, 'outcomes', ownField(input, 'outcomes'), DECISION_OUTCOMES, { nonEmpty: true });
  member(problems, 'onInternalError', ownField(input, 'onInternalError'), FAILURE_SEMANTICS);
  member(problems, 'onUnreadableInput', ownField(input, 'onUnreadableInput'), FAILURE_SEMANTICS);
  members(problems, 'requiredEvidence', ownField(input, 'requiredEvidence'), EVIDENCE_KINDS, {
    nonEmpty: false,
  });
  member(problems, 'redaction', ownField(input, 'redaction'), REDACTION_RULES);
  nonEmptyString(problems, 'statedIn', ownField(input, 'statedIn'));
  if (problems.length > 0) return { ok: false, problems };
  // Every field above was checked against the shape, so the narrowing is earned
  // rather than asserted: the cast is to the type the checks just established.
  return { ok: true, value: input as unknown as PolicyDeclaration };
}

/**
 * Define a policy: validate it and hand back a frozen copy. Throws an Error
 * whose message lists every problem as `field: message`, so a registry that
 * loads at import time fails with the whole list rather than one line at a
 * time.
 */
export function definePolicy(input: PolicyDeclaration): PolicyDeclaration {
  const result = validateDeclaration(input);
  if (!result.ok) {
    const lines = result.problems.map(({ field, message }) => `${field}: ${message}`);
    throw new Error(`invalid policy declaration:\n  ${lines.join('\n  ')}`);
  }
  const policy = result.value;
  return Object.freeze({
    ...policy,
    operations: Object.freeze([...policy.operations]),
    outcomes: Object.freeze([...policy.outcomes]),
    requiredEvidence: Object.freeze([...policy.requiredEvidence]),
  });
}
