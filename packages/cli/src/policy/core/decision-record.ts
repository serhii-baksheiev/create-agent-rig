/**
 * The decision-record schema (RP-76): what one verdict of one policy on one
 * harness must carry to be audited later, and the validator that refuses a
 * record which would read as more than it is.
 *
 * Emitting these at runtime is a separate task; this file is the shape and the
 * rules. The rules that go beyond "the field is in its vocabulary":
 *
 * - the policy must be registered and the version compatible with it, so the
 *   record names semantics a reader can look up;
 * - the operation must be one the policy declares;
 * - a qualifier (`UNVERIFIABLE`, `UNMEASURED`) must carry a reason;
 * - a capability state of `UNSUPPORTED` or `INTEGRATION-FAILED` must qualify
 *   the verdict `UNVERIFIABLE` — an unenforceable policy never yields a silent
 *   pass (`./vocabulary.ts`, `CAPABILITY_STATES`);
 * - every evidence kind the policy requires must be present;
 * - a policy that redacts must not be recorded with unredacted diagnostics;
 * - the timestamp is supplied by the caller and must be an ISO-8601 date-time
 *   with seconds and an explicit zone (`ISO_8601` in `./validation.ts`, which
 *   every shape recording an observation time reads; a bare date is
 *   refused) — no clock here.
 *
 * Each rule is one test in `packages/cli/test/policy-declaration.test.ts`
 * under "validating a decision record".
 *
 * ⚠ `diagnostics.redacted` is the emitter's claim, and this validator enforces
 * the claim's presence, not the property: a record marked redacted whose
 * `diagnostics.text`, `observedFacts[].value` or `evidence[].value` still
 * carries a matched value is accepted here. Scanning content would pull the
 * secret vocabulary into the core, which the dependency-direction test
 * forbids — so the emitting task owns that scan, over those three fields,
 * before it persists a record.
 */

import { compatibilityOf, findPolicy } from './registry.js';
import {
  CAPABILITY_STATES,
  UNENFORCEABLE_STATES,
  DECISION_OUTCOMES,
  EVIDENCE_KINDS,
  OPERATIONS,
  VERDICT_QUALIFIERS,
} from './vocabulary.js';
import type {
  CapabilityState,
  DecisionOutcome,
  EvidenceKind,
  Operation,
  VerdictQualifier,
} from './vocabulary.js';
import { ISO_8601, isRecord, member, nonEmptyString, unknownKeys } from './validation.js';
import type { Problem, Validation } from './validation.js';

export const DECISION_RECORD_SCHEMA_VERSION = 1;

export interface ObservedFact {
  name: string;
  value: string;
}

export interface Evidence {
  kind: EvidenceKind;
  value: string;
}

export interface Verdict {
  outcome: DecisionOutcome;
  qualifier?: VerdictQualifier;
  reason?: string;
}

export interface DecisionRecord {
  schemaVersion: typeof DECISION_RECORD_SCHEMA_VERSION;
  policyId: string;
  policyVersion: string;
  /** An opaque id the adapter supplies; the core knows no harness by name. */
  harness: string;
  operation: Operation;
  /** The capability state that applied when the verdict was produced. */
  capabilityState: CapabilityState;
  observedFacts: readonly ObservedFact[];
  verdict: Verdict;
  evidence: readonly Evidence[];
  /** The version of the artifact (rig or generator) that produced the verdict. */
  artifactVersion: string;
  diagnostics: { redacted: boolean; text: string };
  /** ISO-8601, supplied by the caller. */
  recordedAt: string;
}

const KEYS = [
  'schemaVersion',
  'policyId',
  'policyVersion',
  'harness',
  'operation',
  'capabilityState',
  'observedFacts',
  'verdict',
  'evidence',
  'artifactVersion',
  'diagnostics',
  'recordedAt',
] as const;

/**
 * Read from `./vocabulary.ts` rather than restated here: `./coverage.ts` ›
 * `qualifierFor` answers from the same list, and a second copy is how the two
 * come to disagree about which verdicts may pass unqualified.
 */
const NEVER_SILENT_PASS: readonly CapabilityState[] = UNENFORCEABLE_STATES;

const namedPairs = (
  problems: Problem[],
  field: string,
  value: unknown,
  keys: readonly [string, string],
): void => {
  if (!Array.isArray(value)) {
    problems.push({ field, message: 'must be a list' });
    return;
  }
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push({ field: `${field}[${index}]`, message: 'must be an object' });
      return;
    }
    unknownKeys(problems, entry, keys, `${field}[${index}]`);
    for (const key of keys) nonEmptyString(problems, `${field}[${index}].${key}`, entry[key]);
  });
};

const checkVerdict = (
  problems: Problem[],
  value: unknown,
  capabilityState: CapabilityState | null,
): void => {
  if (!isRecord(value)) {
    problems.push({ field: 'verdict', message: 'must be an object' });
    return;
  }
  unknownKeys(problems, value, ['outcome', 'qualifier', 'reason'], 'verdict');
  member(problems, 'verdict.outcome', value.outcome, DECISION_OUTCOMES);
  const qualified = 'qualifier' in value;
  if (qualified) {
    member(problems, 'verdict.qualifier', value.qualifier, VERDICT_QUALIFIERS);
    if (typeof value.reason !== 'string' || value.reason.trim() === '') {
      problems.push({
        field: 'verdict.reason',
        message: `a ${String(value.qualifier)} verdict must say why`,
      });
    }
  } else if ('reason' in value && typeof value.reason !== 'string') {
    problems.push({ field: 'verdict.reason', message: 'must be a string when present' });
  }
  if (capabilityState !== null && NEVER_SILENT_PASS.includes(capabilityState)) {
    if (value.qualifier !== 'UNVERIFIABLE') {
      problems.push({
        field: 'verdict.qualifier',
        message:
          `capabilityState ${capabilityState} never yields a silent pass: ` +
          'the verdict must be qualified UNVERIFIABLE with a reason',
      });
    }
  }
};

const checkEvidence = (
  problems: Problem[],
  value: unknown,
  required: readonly EvidenceKind[],
): void => {
  if (!Array.isArray(value)) {
    problems.push({ field: 'evidence', message: 'must be a list' });
    return;
  }
  const present = new Set<string>();
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push({ field: `evidence[${index}]`, message: 'must be an object' });
      return;
    }
    unknownKeys(problems, entry, ['kind', 'value'], `evidence[${index}]`);
    if (member(problems, `evidence[${index}].kind`, entry.kind, EVIDENCE_KINDS)) {
      present.add(entry.kind);
    }
    nonEmptyString(problems, `evidence[${index}].value`, entry.value);
  });
  for (const kind of required) {
    if (!present.has(kind)) {
      problems.push({ field: 'evidence', message: `the policy requires ${kind} evidence` });
    }
  }
};

const checkDiagnostics = (problems: Problem[], value: unknown, mustRedact: boolean): void => {
  if (!isRecord(value)) {
    problems.push({ field: 'diagnostics', message: 'must be an object' });
    return;
  }
  unknownKeys(problems, value, ['redacted', 'text'], 'diagnostics');
  if (typeof value.redacted !== 'boolean') {
    problems.push({ field: 'diagnostics.redacted', message: 'must be a boolean' });
  } else if (mustRedact && !value.redacted) {
    problems.push({
      field: 'diagnostics.redacted',
      message: 'the policy redacts matched values, so its diagnostics must be recorded redacted',
    });
  }
  if (typeof value.text !== 'string') {
    problems.push({ field: 'diagnostics.text', message: 'must be a string' });
  }
};

/** Validate an unknown value as a decision record, reporting every problem at once. */
export function validateDecisionRecord(input: unknown): Validation<DecisionRecord> {
  if (!isRecord(input)) {
    return { ok: false, problems: [{ field: '', message: 'a decision record is an object' }] };
  }
  const problems: Problem[] = [];
  unknownKeys(problems, input, KEYS);
  if (input.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) {
    problems.push({
      field: 'schemaVersion',
      message: `must be ${DECISION_RECORD_SCHEMA_VERSION}, got ${String(input.schemaVersion)}`,
    });
  }

  const policy = typeof input.policyId === 'string' ? findPolicy(input.policyId) : null;
  if (policy === null) {
    problems.push({
      field: 'policyId',
      message: `${JSON.stringify(input.policyId)} is not a registered policy`,
    });
  } else if (typeof input.policyVersion === 'string') {
    const compatibility = compatibilityOf(policy.policyId, input.policyVersion);
    if (compatibility !== 'compatible') {
      problems.push({
        field: 'policyVersion',
        message: `${JSON.stringify(input.policyVersion)} is ${compatibility} with ${policy.policyId} ${policy.policyVersion}`,
      });
    }
  } else {
    nonEmptyString(problems, 'policyVersion', input.policyVersion);
  }

  nonEmptyString(problems, 'harness', input.harness);
  if (member(problems, 'operation', input.operation, OPERATIONS) && policy !== null) {
    if (!policy.operations.includes(input.operation)) {
      problems.push({
        field: 'operation',
        message: `${policy.policyId} does not apply to ${input.operation}`,
      });
    }
  }
  const capabilityState = member(
    problems,
    'capabilityState',
    input.capabilityState,
    CAPABILITY_STATES,
  )
    ? input.capabilityState
    : null;

  namedPairs(problems, 'observedFacts', input.observedFacts, ['name', 'value']);
  checkVerdict(problems, input.verdict, capabilityState);
  checkEvidence(problems, input.evidence, policy?.requiredEvidence ?? []);
  nonEmptyString(problems, 'artifactVersion', input.artifactVersion);
  checkDiagnostics(problems, input.diagnostics, policy !== null && policy.redaction !== 'none');
  if (
    typeof input.recordedAt !== 'string' ||
    !ISO_8601.test(input.recordedAt) ||
    Number.isNaN(Date.parse(input.recordedAt))
  ) {
    problems.push({
      field: 'recordedAt',
      message: `must be an ISO-8601 date-time with seconds and an explicit zone, got ${JSON.stringify(input.recordedAt)}`,
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: input as unknown as DecisionRecord };
}
