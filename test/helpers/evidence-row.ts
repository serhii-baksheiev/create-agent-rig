/**
 * A minimal, test-only shape check for the capability-evidence rows a couple
 * of behavioural tests hard-code (`concurrent-sessions.test.ts`,
 * `subagent-routing.test.ts`) and cross-check against real docs
 * (`docs/decisions/concurrent-sessions.md`, `docs/capability-evidence.json`).
 *
 * This used to be `packages/cli/src/policy/core/evidence-matrix.js`, a shipped
 * "policy library" module, itself built on `./validation.js`. RP-178 removed
 * both — nothing in the package ever called them at runtime (the consumer
 * graph is on pull request #227) — so this file carries
 * forward exactly what the two surviving tests need, no more and no less:
 *
 * - every row is a closed-shape object: `harness`, `surface`, `harnessVersion`,
 *   `os`, `observedAt`, `mechanism`, `observableSignal`, `status`,
 *   `evidencePointer`, and `downgradeReason` when present — nothing else
 *   (`evidence-row.test.ts` › "refuses a field the shape does not declare, and
 *   names it");
 * - `harness`, `surface`, `mechanism`, `observableSignal` and `evidencePointer`
 *   are non-blank strings;
 * - `harnessVersion` names one immutable build — a version number
 *   (`2.1.270`, optionally `v`-prefixed, optionally carrying a pre-release or
 *   build suffix) or a 7-to-64-character hex build id — never a range or a
 *   moving label (`evidence-row.test.ts` › "refuses a version range, a
 *   wildcard or a moving label");
 * - `observedAt` is a zoned ISO-8601 date-time, never a bare date;
 * - `status` is one of the four capability states, and carries a
 *   `downgradeReason` exactly when it is not `SUPPORTED`.
 *
 * It is deliberately not a general-purpose validator (no `ownField`/
 * `carriesField` prototype-chain hardening — RP-157/RP-161's concern, moot for
 * hand-authored object literals in a test file) and is not exported outside
 * `test/`.
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

const KEYS = [
  'harness',
  'surface',
  'harnessVersion',
  'os',
  'observedAt',
  'mechanism',
  'observableSignal',
  'status',
  'downgradeReason',
  'evidencePointer',
] as const;

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

// One immutable build: a version number (optionally v-prefixed, optionally
// carrying a -pre-release or +build suffix) or a 7-to-64-character hex build
// id — never a range, a wildcard, or a moving channel label.
const BUILD_NUMBER = /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$/;
const BUILD_ID = /^[0-9a-fA-F]{7,64}$/;
const isExactVersion = (value: string): boolean => BUILD_NUMBER.test(value) || BUILD_ID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Validate an unknown value as one evidence row, reporting every problem at once. */
export function validateEvidenceRow(input: unknown): EvidenceRowVerdict {
  if (!isRecord(input)) return { ok: false, problems: ['an evidence row is an object'] };
  const problems: string[] = [];

  for (const key of Object.keys(input)) {
    if (!(KEYS as readonly string[]).includes(key)) problems.push(`${key}: unknown field`);
  }
  for (const field of REQUIRED_TEXT) {
    if (!nonBlank(input[field])) problems.push(`${field} must be a non-blank string`);
  }
  if (nonBlank(input.harnessVersion) && !isExactVersion(input.harnessVersion)) {
    problems.push(
      `harnessVersion must name one immutable build (a version number or a 7-to-64-char hex ` +
        `build id), got ${JSON.stringify(input.harnessVersion)}`,
    );
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
