/**
 * Reading TypeScript source as text, for the guards in this directory that
 * decide something about the shape of a call rather than about its result.
 *
 * Two guards need the same two primitives, and a second copy of either is a
 * copy that drifts — `.claude/rules/invariants.md`, "One mechanism, one
 * implementation". `stripComments` lived in `e2e-pack.test.ts` first and was
 * moved here when `e2e-install-network.test.ts` needed it; that file imports
 * it now rather than carrying its own.
 *
 * ⚠ These are TEXT scanners, not a parser. They are honest about a diff
 * fragment and useless against anything assembled at runtime. Every guard
 * built on them has to state that limit for itself, because the limit belongs
 * to the claim, not to the primitive.
 */

/**
 * Blank out comments, preserving string and template literals, so a construct
 * mentioned in prose — including in a comment explaining the very rule that
 * forbids it — can never be mistaken for an invocation.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    const char = source[i]!;
    if (char === "'" || char === '"' || char === '`') {
      out += char;
      i += 1;
      while (i < source.length) {
        const inner = source[i]!;
        out += inner;
        i += 1;
        if (inner === '\\') {
          if (i < source.length) out += source[i++]!;
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * The text of one call, from the `(` at `open` to its matching `)`.
 *
 * Parentheses inside string and template literals do not count, or an argument
 * like `'--package=(x)'` would unbalance the scan and silently truncate the
 * call — which for a guard means reading only part of what it judges. An
 * unterminated call yields the rest of the source rather than throwing: the
 * caller is deciding whether a fragment is present, and more text can only
 * make that answer safer.
 */
export function callTextAt(code: string, open: number): string {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const char = code[i]!;
    if (char === "'" || char === '"' || char === '`') {
      i += 1;
      while (i < code.length) {
        const inner = code[i]!;
        i += 1;
        if (inner === '\\') {
          i += 1;
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
    i += 1;
  }
  return code.slice(open);
}
