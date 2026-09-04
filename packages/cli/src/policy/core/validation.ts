/**
 * The small set of checks the declaration and the decision record share.
 *
 * Every check appends to a problem list instead of throwing, so a caller sees
 * every defect of a record at once — `validateDeclaration` › "reports every
 * problem at once rather than stopping at the first" in
 * `packages/cli/test/policy-declaration.test.ts`. Each message that refuses an
 * enumerated value quotes the value, because a refusal that names the field
 * and not the word leaves the caller guessing which of two spellings it sent.
 */

export interface Problem {
  field: string;
  message: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A value as it appeared, escaped, for a message a person reads. Exported
 * because every module here that puts OUTSIDE data into a diagnostic must put
 * it through the same escaping — a raw newline or ANSI sequence in a matcher
 * can otherwise forge a line of the report it lands in (`./probe.ts`).
 */
export const quote = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const list = (vocabulary: readonly string[]): string => vocabulary.map(quote).join(', ');

/**
 * Refuse a key the shape does not declare — the shape is closed on purpose.
 * A nested shape passes its own field name as `prefix`, so the problem names
 * `verdict.severity` rather than a bare `severity` the caller cannot place.
 */
export const unknownKeys = (
  problems: Problem[],
  input: Record<string, unknown>,
  known: readonly string[],
  prefix = '',
): void => {
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) {
      problems.push({ field: prefix === '' ? key : `${prefix}.${key}`, message: 'unknown field' });
    }
  }
};

/** Refuse a string that is absent, not a string, or empty. */
export const nonEmptyString = (problems: Problem[], field: string, value: unknown): boolean => {
  if (typeof value !== 'string' || value === '') {
    problems.push({ field, message: `must be a non-empty string, got ${quote(value)}` });
    return false;
  }
  return true;
};

/**
 * Refuse a string that is absent, not a string, or has no non-space character.
 *
 * Stricter than `nonEmptyString` in exactly one place — a value of whitespace
 * only — and a separate helper rather than a tightening of that one, because
 * the shapes already validated by it are not in this change's scope. Where a
 * field is a fact a later reader has to act on (an exact version, a pointer to
 * evidence), a blank is the same defect as an absence and is refused as one.
 */
export const nonBlankString = (problems: Problem[], field: string, value: unknown): boolean => {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push({ field, message: `must be a non-blank string, got ${quote(value)}` });
    return false;
  }
  return true;
};

/**
 * Date, `T`, time to the second (fractions allowed), and an explicit zone.
 *
 * One spelling of one fact (`rules/invariants.md`, "One mechanism, one
 * implementation"). Its three readers are `./decision-record.ts`
 * (`recordedAt`), `./evidence-matrix.ts` (`observedAt`) and `./coverage.ts`
 * (`verifiedAt`, through `requireTimestamp`), so a bare date is refused the
 * same way whichever of them is validating — `packages/cli/test/policy-coverage.test.ts`
 * › "refuses the probe timestamp %j, which is exactly what the shared ISO-8601
 * pattern refuses" imports this pattern rather than restating it, so the two
 * sides cannot drift apart. A timestamp is always supplied by the caller —
 * nothing under this directory reads a clock.
 */
export const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Refuse a string outside a closed vocabulary, quoting the offending value. */
export const member = <T extends string>(
  problems: Problem[],
  field: string,
  value: unknown,
  vocabulary: readonly T[],
): value is T => {
  if (typeof value === 'string' && (vocabulary as readonly string[]).includes(value)) return true;
  problems.push({ field, message: `${quote(value)} is not one of ${list(vocabulary)}` });
  return false;
};

/**
 * Refuse a list that is not an array, carries a value outside the vocabulary,
 * repeats one, or — when `nonEmpty` — is empty.
 */
export const members = <T extends string>(
  problems: Problem[],
  field: string,
  value: unknown,
  vocabulary: readonly T[],
  { nonEmpty }: { nonEmpty: boolean },
): value is readonly T[] => {
  if (!Array.isArray(value)) {
    problems.push({ field, message: `must be a list, got ${quote(value)}` });
    return false;
  }
  let clean = true;
  if (nonEmpty && value.length === 0) {
    problems.push({ field, message: 'must not be empty' });
    clean = false;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!member(problems, field, entry, vocabulary)) {
      clean = false;
      continue;
    }
    if (seen.has(entry)) {
      problems.push({ field, message: `${quote(entry)} is listed twice` });
      clean = false;
    }
    seen.add(entry);
  }
  return clean;
};

/** Refuse a string that does not match the pattern, saying what shape was expected. */
export const matching = (
  problems: Problem[],
  field: string,
  value: unknown,
  pattern: RegExp,
  expected: string,
): boolean => {
  if (typeof value === 'string' && pattern.test(value)) return true;
  problems.push({ field, message: `must be ${expected}, got ${quote(value)}` });
  return false;
};
