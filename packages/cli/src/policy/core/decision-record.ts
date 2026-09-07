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
 * 🔴 EVERY field of the input is read through `carriesField`/`ownField`
 * (`./validation.ts`) — own and enumerable, the set `Object.keys` walks — and
 * never off the record directly. Presence and value travel through the same
 * predicate: `'qualifier' in value` was the load-bearing half of this defect,
 * because `unknownKeys` judges the same record by `Object.keys` while the reads
 * walked the prototype chain, so the closed-shape check and the field reads
 * disagreed about what the record contained — with the reads being the wider of
 * the two, which is the direction that passes. A decision record is the
 * artifact a later reader audits, and the shape that made this worth fixing
 * before it had a caller is a record whose verdict qualifier is only inherited:
 * it validates as qualified, and what it then writes out is `{"outcome":
 * "allow","reason":…}` — the reason survives, the QUALIFIER is what is lost,
 * which is exactly the silent pass an `UNSUPPORTED` capability state exists to
 * prevent. Held over every reading site in this module, in both shapes —
 * inherited, and own but not enumerable — in
 * `packages/cli/test/policy-declaration.test.ts` › "refuses an UNSUPPORTED
 * record whose verdict qualifier is only inherited, because what it writes out
 * is a silent pass", with the other direction held by › "still accepts a record
 * whose every field is defined through Object.defineProperty as own and
 * enumerable".
 *
 * 🔴 And an UNNARROWED outside value only reaches a diagnostic through `quote`
 * (`./validation.ts`), never through bare `String` or `JSON.stringify`. The
 * qualifier is exact: `operation` and `capabilityState` are still interpolated
 * bare, because `member` has narrowed each to its closed vocabulary by the time
 * the message is built — a value that reached those lines is one of a handful of
 * literals this file names. Both unsafe spellings were here: a qualifier
 * carrying a newline forged two `field:
 * message` lines of its own in the rendered problem list — the exact shape
 * `./declaration.ts` › `definePolicy` throws — while the neighbouring line
 * escaped the same value; and a circular value crashed the validator with a
 * `TypeError` where `quote` degrades. Held by ›
 * "escapes a verdict qualifier carrying a newline, so it cannot forge a line of
 * the refusal report" and › "refuses a record whose policyId is a circular
 * value, rather than throwing while it renders the refusal".
 *
 * ⚠ What this does NOT do, and the limits are stated rather than implied:
 *
 * - the `ok: true` value is the input object itself, not a snapshot of the
 *   fields that were certified. Those are the same thing for a value whose
 *   fields are plain data, which is every record `JSON.parse` can produce; they
 *   are not the same for one carrying a live accessor, which validates on one
 *   read and serialises from another. RP-157 owns that, for this module and
 *   `./declaration.ts` together;
 * - the work is linear in the input's own size, and nothing here caps that size.
 *   `Array.prototype.forEach` over `observedFacts` or `evidence` visits a sparse
 *   array's holes, so a caller-built `new Array(1e7)` costs seconds and
 *   gigabytes before the refusal. Measured, unchanged by the change that added
 *   this note, and unreachable from a parsed record — JSON has no holes. It is
 *   written down because an ABSENT limit is the failure `rules/invariants.md`
 *   names, and this one had never been stated;
 * - `quote` itself re-throws for a value whose `JSON.stringify` and `String`
 *   both throw. The direction is a crash, never an `ok: true`, so nothing
 *   malformed is certified through it — RP-160.
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
import {
  ISO_8601,
  carriesField,
  isRecord,
  member,
  nonEmptyString,
  ownField,
  quote,
  unknownKeys,
} from './validation.js';
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
    for (const key of keys)
      nonEmptyString(problems, `${field}[${index}].${key}`, ownField(entry, key));
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
  member(problems, 'verdict.outcome', ownField(value, 'outcome'), DECISION_OUTCOMES);
  const qualifier = ownField(value, 'qualifier');
  const reason = ownField(value, 'reason');
  if (carriesField(value, 'qualifier')) {
    member(problems, 'verdict.qualifier', qualifier, VERDICT_QUALIFIERS);
    if (typeof reason !== 'string' || reason.trim() === '') {
      problems.push({
        field: 'verdict.reason',
        message: `a ${quote(qualifier)} verdict must say why`,
      });
    }
  } else if (carriesField(value, 'reason') && typeof reason !== 'string') {
    problems.push({ field: 'verdict.reason', message: 'must be a string when present' });
  }
  if (capabilityState !== null && NEVER_SILENT_PASS.includes(capabilityState)) {
    if (qualifier !== 'UNVERIFIABLE') {
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
    const kind = ownField(entry, 'kind');
    if (member(problems, `evidence[${index}].kind`, kind, EVIDENCE_KINDS)) {
      present.add(kind);
    }
    nonEmptyString(problems, `evidence[${index}].value`, ownField(entry, 'value'));
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
  const redacted = ownField(value, 'redacted');
  if (typeof redacted !== 'boolean') {
    problems.push({ field: 'diagnostics.redacted', message: 'must be a boolean' });
  } else if (mustRedact && !redacted) {
    problems.push({
      field: 'diagnostics.redacted',
      message: 'the policy redacts matched values, so its diagnostics must be recorded redacted',
    });
  }
  if (typeof ownField(value, 'text') !== 'string') {
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
  const schemaVersion = ownField(input, 'schemaVersion');
  if (schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) {
    problems.push({
      field: 'schemaVersion',
      message: `must be ${DECISION_RECORD_SCHEMA_VERSION}, got ${quote(schemaVersion)}`,
    });
  }

  const policyId = ownField(input, 'policyId');
  const policyVersion = ownField(input, 'policyVersion');
  const policy = typeof policyId === 'string' ? findPolicy(policyId) : null;
  if (policy === null) {
    problems.push({
      field: 'policyId',
      message: `${quote(policyId)} is not a registered policy`,
    });
  } else if (typeof policyVersion === 'string') {
    const compatibility = compatibilityOf(policy.policyId, policyVersion);
    if (compatibility !== 'compatible') {
      problems.push({
        field: 'policyVersion',
        message: `${quote(policyVersion)} is ${compatibility} with ${policy.policyId} ${policy.policyVersion}`,
      });
    }
  } else {
    nonEmptyString(problems, 'policyVersion', policyVersion);
  }

  nonEmptyString(problems, 'harness', ownField(input, 'harness'));
  const operation = ownField(input, 'operation');
  if (member(problems, 'operation', operation, OPERATIONS) && policy !== null) {
    if (!policy.operations.includes(operation)) {
      problems.push({
        field: 'operation',
        message: `${policy.policyId} does not apply to ${operation}`,
      });
    }
  }
  const state = ownField(input, 'capabilityState');
  const capabilityState = member(problems, 'capabilityState', state, CAPABILITY_STATES)
    ? state
    : null;

  namedPairs(problems, 'observedFacts', ownField(input, 'observedFacts'), ['name', 'value']);
  checkVerdict(problems, ownField(input, 'verdict'), capabilityState);
  checkEvidence(problems, ownField(input, 'evidence'), policy?.requiredEvidence ?? []);
  nonEmptyString(problems, 'artifactVersion', ownField(input, 'artifactVersion'));
  checkDiagnostics(
    problems,
    ownField(input, 'diagnostics'),
    policy !== null && policy.redaction !== 'none',
  );
  const recordedAt = ownField(input, 'recordedAt');
  if (
    typeof recordedAt !== 'string' ||
    !ISO_8601.test(recordedAt) ||
    Number.isNaN(Date.parse(recordedAt))
  ) {
    problems.push({
      field: 'recordedAt',
      message: `must be an ISO-8601 date-time with seconds and an explicit zone, got ${quote(recordedAt)}`,
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: input as unknown as DecisionRecord };
}
