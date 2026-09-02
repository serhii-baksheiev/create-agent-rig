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

const quote = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const list = (vocabulary: readonly string[]): string => vocabulary.map(quote).join(', ');

/** Refuse a key the shape does not declare — the shape is closed on purpose. */
export const unknownKeys = (
  problems: Problem[],
  input: Record<string, unknown>,
  known: readonly string[],
): void => {
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) problems.push({ field: key, message: 'unknown field' });
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
