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
import { isRecord, matching, member, members, nonEmptyString, unknownKeys } from './validation.js';
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

const KEYS = [
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
  matching(problems, 'policyId', input.policyId, KEBAB_CASE, 'kebab-case');
  matching(problems, 'policyVersion', input.policyVersion, POLICY_VERSION, 'MAJOR.MINOR');
  member(problems, 'lifecycle', input.lifecycle, LIFECYCLE_STATES);
  nonEmptyString(problems, 'invariant', input.invariant);
  member(problems, 'tier', input.tier, AUTONOMY_TIERS);
  members(problems, 'operations', input.operations, OPERATIONS, { nonEmpty: true });
  member(problems, 'timing', input.timing, ENFORCEMENT_TIMINGS);
  member(problems, 'requiredCapability', input.requiredCapability, HARNESS_CAPABILITIES);
  matching(problems, 'mechanism', input.mechanism, KEBAB_CASE, 'kebab-case');
  members(problems, 'outcomes', input.outcomes, DECISION_OUTCOMES, { nonEmpty: true });
  member(problems, 'onInternalError', input.onInternalError, FAILURE_SEMANTICS);
  member(problems, 'onUnreadableInput', input.onUnreadableInput, FAILURE_SEMANTICS);
  members(problems, 'requiredEvidence', input.requiredEvidence, EVIDENCE_KINDS, {
    nonEmpty: false,
  });
  member(problems, 'redaction', input.redaction, REDACTION_RULES);
  nonEmptyString(problems, 'statedIn', input.statedIn);
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
