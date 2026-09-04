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
 *
 * 🔴 Neither models a REGEX LITERAL, and that is the sharpest edge here. A
 * quote inside one — `/didn't/` — flips `stripComments`'s string parity, and a
 * later `/*` or `//` sitting inside a genuine string is then read as a comment
 * opener and blanks the rest of the file. Measured by `security-scanner` on
 * gate round 3, with a non-compliant install call after it going unseen. The
 * damage is bounded below rather than eliminated: `'` and `"` string mode now
 * ends at a newline, which JavaScript forbids inside either, so a stray quote
 * costs one line instead of a file. A backtick literal may legally span lines
 * and keeps the old behaviour, so a quote inside a regex followed by an
 * unterminated template is still a hole.
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
        // A raw newline cannot appear inside '' or "" — reaching one means the
        // opening quote was not a string at all (a regex literal, most likely),
        // so end the mode here and bound the mis-read to this line.
        if (inner === '\n' && char !== '`') break;
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
 * The text of one call, from the `(` at `open` to its matching `)`, or `null`
 * when it does not balance.
 *
 * Parentheses inside string and template literals do not count, or an argument
 * like `'--package=(x)'` would unbalance the scan and truncate the call —
 * which for a guard means judging only part of what it was handed.
 *
 * 🔴 It returns `null` rather than "the rest of the source", and the direction
 * is the whole point. A first version returned the remainder, reasoning that
 * more text can only make a "is this fragment present?" answer safer. That is
 * backwards for every guard built on this: an unbalanced `(` the scanner does
 * not model makes the return value swallow the rest of the file, so an
 * UNRELATED later `installEnv(…)` makes an env-less call read as compliant.
 * Failing open is how a guard reports coverage it does not have. A caller that
 * cannot read a call must treat that as a violation and say so — loud, and
 * fixable.
 */
export function callTextAt(code: string, open: number): string | null {
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
  return null;
}
