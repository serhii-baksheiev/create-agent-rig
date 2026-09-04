/**
 * The capability evidence matrix (RP-36, absorbing the discovery component of
 * the item it supersedes): one row per concrete harness surface, saying what
 * was observed, on exactly which version, when, and where the proof is.
 *
 * The rule that gives the matrix its value is that an incomplete row is
 * REFUSED rather than stored: a row without an exact version or an observed
 * date-time reads like evidence and is not one, because neither "which build
 * was this" nor "was this before or after the change" can be answered from it.
 * Both halves are checked — `packages/cli/test/policy-coverage.test.ts` ›
 * "refuses the harness version %j, because it names a range or a moving target
 * rather than a build" and › "refuses an observedAt that is not an ISO-8601
 * date-time with a zone (%j)". Documentation claims are not rows; a row records
 * live behaviour that was seen.
 *
 * A row whose status is anything but `SUPPORTED` must say why, and a
 * `SUPPORTED` row must not — the shape is closed in both directions, per ›
 * "refuses a %s row that does not say why it is not supported".
 *
 * Every field of the shape is checked and every problem is reported at once,
 * the way `./declaration.ts` does it, so a caller fixes a row in one pass: ›
 * "reports every problem at once rather than stopping at the first".
 *
 * Why the row is shaped this way, and what it deliberately does not check, is
 * `docs/decisions/capability-coverage.md`.
 */

import { CAPABILITY_STATES } from './vocabulary.js';
import type { CapabilityState } from './vocabulary.js';
import {
  ISO_8601,
  isRecord,
  matching,
  member,
  nonBlankString,
  quote,
  unknownKeys,
} from './validation.js';
import type { Problem, Validation } from './validation.js';

export interface EvidenceRow {
  harness: string;
  surface: string;
  /** The exact version observed — not a range, not "latest". */
  harnessVersion: string;
  os: string;
  /** ISO-8601 with an explicit zone; a bare date is refused. */
  observedAt: string;
  /** The harness-neutral name of the enforcing mechanism. */
  mechanism: string;
  /** What an observer can see when the mechanism acts. */
  observableSignal: string;
  status: CapabilityState;
  /** Why the status is not `SUPPORTED`; required exactly when it is not. */
  downgradeReason?: string;
  /** Where the proof is: a test name, a log, a run. */
  evidencePointer: string;
}

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

/**
 * A version that names a build rather than a moving target.
 *
 * Refused: the vague words, and anything carrying a range operator or a
 * wildcard component. The rule exists because "an exact version" was stated
 * three times in this file while nothing checked it, and a row saying `latest`
 * reads like evidence while answering neither of the two questions the column
 * is for — which build was this, and was this before or after the change.
 * Pinned in `packages/cli/test/policy-coverage.test.ts` › "refuses the harness
 * version %j, because it names a range or a moving target rather than a build"
 * and, in the other direction, › "accepts the exact harness version %j,
 * including a plain build id".
 */
const VAGUE_VERSIONS: readonly string[] = ['latest', 'current', 'unknown', 'any', 'head'];
const RANGE_OR_WILDCARD = /[\^~*<>=]|\bx\b|\.x\b/i;

const exactVersion = (problems: Problem[], value: unknown): void => {
  if (typeof value !== 'string') return;
  const version = value.trim();
  if (version === '') return;
  if (VAGUE_VERSIONS.includes(version.toLowerCase()) || RANGE_OR_WILDCARD.test(version)) {
    problems.push({
      field: 'harnessVersion',
      message: `must name the exact version observed, not a range or a moving target; got ${quote(value)}`,
    });
  }
};

/** Validate an unknown value as one matrix row, reporting every problem at once. */
export function validateEvidenceRow(input: unknown): Validation<EvidenceRow> {
  if (!isRecord(input)) {
    return { ok: false, problems: [{ field: '', message: 'an evidence row is an object' }] };
  }
  const problems: Problem[] = [];
  unknownKeys(problems, input, KEYS);
  for (const field of REQUIRED_TEXT) nonBlankString(problems, field, input[field]);
  exactVersion(problems, input.harnessVersion);
  matching(problems, 'observedAt', input.observedAt, ISO_8601, 'an ISO-8601 date-time with a zone');
  const known = member(problems, 'status', input.status, CAPABILITY_STATES);
  if (known && input.status !== 'SUPPORTED') {
    nonBlankString(problems, 'downgradeReason', input.downgradeReason);
  }
  // The shape is closed in both directions: a supported row has no reason to
  // give, so a `downgradeReason` on one is refused rather than ignored. Left
  // unchecked, the field went unvalidated on that branch and the narrowing
  // below handed back a value typed `string` that was not one.
  if (known && input.status === 'SUPPORTED' && 'downgradeReason' in input) {
    problems.push({
      field: 'downgradeReason',
      message: 'a SUPPORTED row has nothing to explain, so it carries no downgrade reason',
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  // Every field above was checked against the shape, so the narrowing is the
  // type the checks just established rather than an assertion over them.
  return { ok: true, value: input as unknown as EvidenceRow };
}
