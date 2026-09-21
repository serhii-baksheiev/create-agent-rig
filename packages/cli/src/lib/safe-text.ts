/**
 * A control or Unicode-format character (RTL override, zero-width joiner, an
 * ESC sequence, a bare CR/LF) inside a string that later reaches a screen a
 * maintainer reads before approving a write — a plan line, a manifest key, a
 * declared integration id. Extracted from `manifest.ts` (RP-22 S1) so a second
 * caller does not duplicate the predicate; the manifest's own behaviour and
 * tests are unchanged by the move (`.claude/rules/invariants.md`, "One
 * mechanism, one implementation").
 */
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/u;

/**
 * Whether one code point (as yielded by spreading a string, so a surrogate
 * pair arrives as a single two-code-unit element) is a Unicode format
 * character (a bidi override, a zero-width joiner, …) or one of the two
 * Unicode line separators (U+2028, U+2029). Shared by `hasControlCharacter`
 * below and by `../integrations/exec.ts`'s own output sanitizer, which
 * refuses the same three classes IN ADDITION TO the plain ASCII/C1
 * control-character ranges each of them tests separately, in its own,
 * non-shared way (`.claude/rules/invariants.md`, "One mechanism, one
 * implementation").
 */
export function isFormatOrLineSeparatorCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code === 0x2028 || code === 0x2029 || FORMAT_CHARACTER_PATTERN.test(character);
}

export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || isFormatOrLineSeparatorCharacter(character)
    );
  });
}

/**
 * A type predicate, not a cast: narrows `unknown` to an indexable object
 * without asserting anything. Shared by the integration JSON parsers.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type DepthScan = { tooDeep: boolean; hasControlChar: boolean };

/**
 * One iterative, explicit-worklist pass over a parsed JSON value that answers
 * two questions at once: does anything here carry a control or Unicode-format
 * character, and does the value nest deeper than `maxDepth` below its root.
 *
 * Iterative on purpose. A naive recursive walk over attacker-controlled JSON
 * stack-overflows well inside any reasonable byte cap — `JSON.parse` itself
 * tolerates a depth of 30 000+ — so recursion here would be the one way a
 * caller's "TOTAL, never throws" promise could break
 * (`.claude/rules/invariants.md`, "no recursion over input"). Total work is
 * bounded by the number of JSON tokens in `root`, which the caller's own byte
 * cap must be checked BEFORE this ever runs.
 *
 * The caller selects the depth bound for its accepted schema.
 */
export function scanForDepthAndControlChars(root: unknown, maxDepth: number): DepthScan {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let hasControlChar = false;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break; // guarded by the loop condition; stated for the type checker
    const { value, depth } = next;
    if (depth > maxDepth) return { tooDeep: true, hasControlChar };
    if (typeof value === 'string') {
      if (hasControlCharacter(value)) hasControlChar = true;
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (hasControlCharacter(key)) hasControlChar = true;
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return { tooDeep: false, hasControlChar };
}
