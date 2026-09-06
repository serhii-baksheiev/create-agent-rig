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
 * Whether an outside record CARRIES a field — own and enumerable, which is
 * exactly the set `Object.keys` walks, and which `JSON.stringify` writes out
 * whenever the value is serialisable.
 *
 * ⚠ The second half is a "whenever", not an equivalence, and the earlier
 * wording claimed the equivalence. `{ downgradeReason: undefined }` is own and
 * enumerable, so this returns `true`, while `JSON.stringify` drops it — which
 * is why a `SUPPORTED` row written that way is refused for carrying a reason
 * even though its serialisation carries none. The refusal is the conservative
 * direction, but a reader who took "the rule is what `JSON.stringify` sees"
 * literally would predict acceptance. `Object.keys` is the set this actually
 * implements; that is the half to reason from.
 *
 * 🔴 The two halves are one rule, and each was a real false pass. A field found
 * on the PROTOTYPE let a hook serialising as `{}` be read as running the
 * generated command, and let an evidence row own nothing and still validate; a
 * field that is own but NOT ENUMERABLE let a row validate and then serialise
 * without the pointer that made it pass. Both are the same defect stated twice:
 * something was accepted as evidence that no serialisation of the value
 * carries. `unknownKeys` already judges a record by `Object.keys`, so reading
 * by any wider notion made the closed-shape check and the field reads disagree
 * about what the record even contains — and the reads were the wider of the
 * two.
 *
 * Held over both readers at once: `packages/cli/test/policy-coverage.test.ts`
 * (absent in a generated rig) › "refuses a hook entry whose command is only
 * inherited, because the entry itself carries no command" and › "refuses a row
 * whose evidence pointer is own but not enumerable, because the rule is what
 * JSON.stringify sees".
 */
export const carriesField = (input: object, field: string): boolean =>
  Object.prototype.propertyIsEnumerable.call(input, field);

/**
 * Read one field the way the record's own serialisation would carry it, or
 * `undefined` when the record does not carry it at all.
 *
 * Presence and value travel through the same predicate on purpose: a caller
 * that tested presence one way and read the value another is how the two
 * came apart the first time.
 */
export const ownField = (input: object, field: string): unknown =>
  carriesField(input, field) ? (input as Record<string, unknown>)[field] : undefined;

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
 * A real calendar date, `T`, time to the second (fractions allowed), and an
 * explicit zone.
 *
 * One spelling of one fact (`rules/invariants.md`, "One mechanism, one
 * implementation"). Its three readers are `./decision-record.ts`
 * (`recordedAt`), `./evidence-matrix.ts` (`observedAt`) and `./coverage.ts`
 * (`verifiedAt`, through `requireTimestamp`), so a bare date is refused the
 * same way whichever of them is validating — including lexically shaped but
 * impossible dates — `packages/cli/test/policy-coverage.test.ts`
 * › "refuses the probe timestamp %j, which is exactly what the shared ISO-8601
 * pattern refuses" imports this pattern rather than restating it, so the two
 * sides cannot drift apart. A timestamp is always supplied by the caller —
 * nothing under this directory reads a clock.
 */
const ISO_8601_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * A date-time shape whose `test` also proves the named calendar instant exists.
 * Keeping the semantic check behind the same exported predicate prevents the
 * coverage, decision-record and evidence-row validators from drifting apart.
 */
export const ISO_8601 = {
  test(value: string): boolean {
    const match = ISO_8601_SHAPE.exec(value);
    if (match === null) return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, zoneHour, zoneMinute] =
      match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth[month - 1]! &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      (zoneHour === undefined || (Number(zoneHour) <= 23 && Number(zoneMinute) <= 59))
    );
  },
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
  pattern: { test(value: string): boolean },
  expected: string,
): boolean => {
  if (typeof value === 'string' && pattern.test(value)) return true;
  problems.push({ field, message: `must be ${expected}, got ${quote(value)}` });
  return false;
};

/**
 * A version that names one build rather than a set of them.
 *
 * One spelling of one fact: `./evidence-matrix.ts` refuses a matrix row on it
 * and `./coverage.ts` refuses a surface identity on it, so "the exact version
 * observed" means the same thing wherever it is written.
 *
 * 🔴 This is an ALLOWLIST, and it replaced a denylist that could not be
 * finished. The denylist refused five vague words, the range operator
 * characters, a wildcard component and two npm range spellings — and accepted
 * `main`, `master`, `stable`, `next`, `nightly`, `dev`, `edge`, `canary` and
 * `1.2.3 or 2.0.0`, because none of them is any of those things. A moving label
 * is not a shape you can enumerate: every branch name a harness ever publishes
 * from is a new entry, added by whoever notices, which is nobody. So the check
 * asks what a build identifier LOOKS LIKE instead of what a moving target is
 * called, and a word the grammar does not describe is refused whether or not
 * anyone anticipated it.
 *
 * Two shapes are accepted, and they are the two this rig actually reads:
 *
 * - a build NUMBER — a dotted numeric version, optionally `v`-prefixed, with an
 *   optional pre-release or build-metadata suffix after `-` or `+`. That covers
 *   `2.0.14`, `v2.0.14`, `1.104.2`, a date build id like `2026-09-05`, a plain
 *   build id like `20260904.3`, and a suffix carrying any letter at all,
 *   including `1.0.0-X` and `0.0.0-fixture`;
 * - a build ID — 7 to 64 hex characters, which is a git object id at every
 *   length git itself abbreviates to.
 *
 * The distinction that costs the most to get wrong is the one between a bare
 * channel word and a suffix: `beta` names whatever is on that channel today and
 * is refused, while `1.0.0-beta.2` names one build and is accepted. The grammar
 * draws that line by requiring the number first — a suffix cannot stand alone.
 *
 * The value is matched AS GIVEN, with no trim. An earlier version validated
 * `value.trim()` while both callers stored the value verbatim, so `" 2.0.14 "`,
 * `"2.0.14\r\n"` and a BOM-prefixed form were accepted and then persisted with
 * their padding: two rows for one build that compare unequal, and a version
 * carrying a newline sitting in a field a report will one day render. What is
 * checked and what is stored are now the same string: ›
 * "refuses an evidence row whose harness version carries %s, because the row
 * would store what it was not validated on" and › "refuses to probe against a
 * harness version carrying %s, so two maps of one build cannot compare
 * unequal", with › "still accepts the same build once %s is gone, because it is
 * the padding that is refused and not the version" holding the other side.
 *
 * Refused, and now by construction rather than by enumeration: the vague words,
 * every moving branch label, range OPERATORS, wildcard components, both npm
 * range spellings, and any text carrying whitespace or a comma — which is what
 * `1.2.3 or 2.0.0` and `1.2.3, 2.0.0` are. Both readers are pinned in
 * `packages/cli/test/policy-coverage.test.ts` (absent in a generated rig) ›
 * "refuses the harness version %j, because it names a moving label or more than
 * one build" and › "refuses to probe against the harness version %j, because it
 * names a moving label or more than one build", with the other direction held
 * so the grammar cannot swallow a real build id: › "still accepts the harness
 * version %j, because it names one build" and › "still probes against the
 * harness version %j, because it names one build".
 */
const BUILD_NUMBER = /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$/;
const BUILD_ID = /^[0-9a-fA-F]{7,64}$/;

/**
 * What a refusal says is expected — one spelling, read by this module and by
 * `./coverage.ts`, so the two cannot come to describe different grammars.
 */
export const EXACT_VERSION_EXPECTED =
  'must name one immutable build: a version number like 2.0.14, ' +
  'optionally v-prefixed and optionally carrying a -pre-release or +build suffix, ' +
  'or a 7-to-64-character hex build id';

export const isExactVersion = (value: string): boolean =>
  BUILD_NUMBER.test(value) || BUILD_ID.test(value);

/**
 * Refuse a version the grammar does not describe, quoting the value and naming
 * the two shapes that are accepted.
 *
 * The message says what would be accepted rather than what was wrong, because
 * the check is an allowlist: it also refuses `1.0.0.beta` and `2026_09_05`,
 * which are neither a range nor a moving target, and the earlier message told
 * their author they had written one. `./probe.ts` states the principle this
 * trips over — a refusal naming a cause that did not occur sends an operator
 * looking for something that is not there.
 */
export const exactVersion = (problems: Problem[], field: string, value: unknown): void => {
  if (typeof value !== 'string' || value.trim() === '') return;
  if (!isExactVersion(value)) {
    problems.push({ field, message: `${EXACT_VERSION_EXPECTED}; got ${quote(value)}` });
  }
};
