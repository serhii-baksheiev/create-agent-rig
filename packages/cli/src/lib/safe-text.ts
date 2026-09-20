/**
 * A control or Unicode-format character (RTL override, zero-width joiner, an
 * ESC sequence, a bare CR/LF) inside a string that later reaches a screen a
 * maintainer reads before approving a write — a plan line, a manifest key, a
 * declared integration id. Extracted from `manifest.ts` (RP-22 S1) so a second
 * caller does not duplicate the predicate; the manifest's own behaviour and
 * tests are unchanged by the move (`.claude/rules/invariants.md`, "One
 * mechanism, one implementation").
 */
export function hasControlCharacter(value: string): boolean {
  const formatCharacter = /\p{Cf}/u;
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      formatCharacter.test(character)
    );
  });
}

/**
 * A type predicate, not a cast: narrows `unknown` to an indexable object
 * without asserting anything. Shared by every parser of committed JSON in
 * `integrations/` (RP-22 S2 gate finding: this used to be a private copy in
 * both `declaration.ts` and `receipt.ts` — `.claude/rules/invariants.md`,
 * "One mechanism, one implementation").
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
 * Shared by `declaration.ts` (`maxDepth` 4) and `receipt.ts` (`maxDepth` 5) —
 * each file states its own depth bound next to its own schema shape, only the
 * walk itself is common (RP-22 S2 gate finding: this used to be duplicated,
 * one copy per file, with the same iterative structure typed twice).
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
