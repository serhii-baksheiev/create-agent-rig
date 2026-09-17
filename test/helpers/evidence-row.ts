/**
 * A minimal, test-only shape check for the capability-evidence rows a couple
 * of behavioural tests hard-code (`concurrent-sessions.test.ts`,
 * `subagent-routing.test.ts`) and cross-check against real docs
 * (`docs/decisions/concurrent-sessions.md`, `docs/capability-evidence.json`).
 *
 * This used to be `packages/cli/src/policy/core/evidence-matrix.js`, a shipped
 * "policy library" module. RP-178 removed that library — nothing in the
 * package ever called it at runtime (`docs/compatibility.md` has the
 * consumer graph) — so this file carries forward only the one property the
 * two surviving tests need: a row must name its harness, surface, version,
 * mechanism and evidence pointer, must timestamp itself with a zoned
 * ISO-8601 instant, and must give a reason exactly when its status is not
 * `SUPPORTED`. It is deliberately not a general-purpose validator and is not
 * exported outside `test/`.
 */

export type CapabilityState = 'SUPPORTED' | 'DEGRADED' | 'UNSUPPORTED' | 'INTEGRATION-FAILED';

export interface EvidenceRow {
  harness: string;
  surface: string;
  harnessVersion: string;
  os: string;
  observedAt: string;
  mechanism: string;
  observableSignal: string;
  status: CapabilityState;
  downgradeReason?: string;
  evidencePointer: string;
}

export type EvidenceRowVerdict = { ok: true } | { ok: false; problems: string[] };

const CAPABILITY_STATES: readonly CapabilityState[] = [
  'SUPPORTED',
  'DEGRADED',
  'UNSUPPORTED',
  'INTEGRATION-FAILED',
];

const REQUIRED_TEXT = [
  'harness',
  'surface',
  'harnessVersion',
  'os',
  'mechanism',
  'observableSignal',
  'evidencePointer',
] as const;

// A date-time with an explicit offset or Z — a bare date is refused, the same
// rule the removed module pinned.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Validate an unknown value as one evidence row, reporting every problem at once. */
export function validateEvidenceRow(input: unknown): EvidenceRowVerdict {
  if (!isRecord(input)) return { ok: false, problems: ['an evidence row is an object'] };
  const problems: string[] = [];

  for (const field of REQUIRED_TEXT) {
    if (!nonBlank(input[field])) problems.push(`${field} must be a non-blank string`);
  }
  if (!ISO_8601.test(String(input.observedAt))) {
    problems.push('observedAt must be an ISO-8601 date-time with a zone');
  }
  const status = input.status;
  const knownStatus = CAPABILITY_STATES.includes(status as CapabilityState);
  if (!knownStatus) problems.push(`status must be one of ${CAPABILITY_STATES.join(', ')}`);
  const hasReason = 'downgradeReason' in input && nonBlank(input.downgradeReason);
  if (knownStatus && status !== 'SUPPORTED' && !hasReason) {
    problems.push('downgradeReason must be a non-blank string when status is not SUPPORTED');
  }
  if (knownStatus && status === 'SUPPORTED' && hasReason) {
    problems.push('a SUPPORTED row has nothing to explain, so it carries no downgrade reason');
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}
