// The one place a hook reads its payload — `invariants.md`, "One mechanism,
// one implementation". Eight hooks each parsing stdin is eight chances for one
// of them to keep a defect the others fixed, and the one nobody looks at is the
// one that will.
//
// 🔴 Why this module exists at all (RP-54). A hook that cannot parse its
// payload allows the tool call — that is the documented fail-open, and it is
// correct: a crashed guard must not make the session unusable. But it means an
// unreadable payload silently disarms EVERY rule the hook carries, so what
// counts as unreadable has to be as narrow as the format honestly allows.
//
// Measured on the hosted `windows-unit` runner, through the generated Codex
// `commandWindows` wrapper (CI run 33281160544): the wrapper delivers stdin and
// propagates the child's exit code, but the guard received **290 bytes for a
// 287-byte payload**. PowerShell prepends a UTF-8 BOM on that host. `JSON.parse`
// throws on a leading U+FEFF, so every guard resolved a well-formed payload to
// "not ours to judge" and allowed the edit — including `guard-bash`, which
// carries the Never tier and the kill switch. A Windows host whose PowerShell
// does not add the BOM parses the same payload fine, which is why this looked
// like a runner-only mystery for two days.
//
// A BOM is a byte-order mark, not content: stripping one leading U+FEFF is what
// the format means, not a tolerance added to get a test green.
//
// Bounded work, because a fail-open reader is a total bypass if it can throw or
// spin: one read, one character comparison, one slice, one parse. No loop, no
// recursion, no rescanning.
//
// Limits, stated rather than implied:
// - Only a BOM at position 0 is stripped. A payload with other leading bytes is
//   still unreadable, and still resolves to `null`.
// - `null` means "no payload this hook can judge" and every caller keeps its own
//   fail-open on it. This module does not decide policy; it only removes the
//   spelling difference between two hosts.
// Pinned in hook-stdin.test.ts (absent in a generated rig) ›
// "blocks the same command when PowerShell prepends a UTF-8 BOM" and ›
// "reads stdin through the one shared reader, in every hook that reads it".

import { readFileSync } from 'node:fs';

/** The hook payload as an object, or `null` when there is none this hook can read. */
export const readHookInput = () => {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return null;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * ── The shape of a shell command, for the Never-tier SHELL guards (RP-80) ───
 *
 * One place, for the two guards that read `tool_input.command` on a shell tool —
 * `guard-bash` and `block-no-verify`. It is deliberately NOT a repository-wide
 * ruling on the word `command`: `guard-secret-file` reads an `apply_patch`
 * `command` that is a **list of strings**, which is exactly the shape this
 * module classifies as unreadable, and it is right to — the reasoning is in
 * `docs/decisions/codex-adapter.md`. Routing a third guard through here without
 * checking which shape its tool actually sends would start refusing input
 * another guard exists to read.
 *
 * `.claude/rules/invariants.md` ("Refusing to inspect is a third outcome, not a
 * match and not an error") draws the line these guards need:
 *
 * - **absent** — nothing to judge, so the guard fails OPEN. A `Write` with no
 *   content and a shell tool with no `command` are the same case.
 * - **`string`** — the guard inspects it as it always did.
 * - **present and unreadable** — the guard was handed something and can tell
 *   that it cannot read it. That is a REFUSAL: block, name the shape expected,
 *   and say to resend in that shape.
 *
 * 🔴 Getting that last line backwards costs the whole rule set. Measured on
 * `master` at `254b25c8`: a payload whose `command` was `["gh","pr","merge","1"]`
 * exited 0 from `guard-bash` **with the kill switch armed** — the brake was
 * never consulted, because the guard had already excused itself. `block-no-verify`
 * had the same hole by another road: `String(argv)` comma-joins, and its
 * tokeniser never splits on a comma, so `--no-verify` became invisible rather
 * than unreadable.
 *
 * 🔴 The remedy is carried as a FIELD beside the reason, not inferred from the
 * reason's wording by whoever prints it — `invariants.md` again. A remedy
 * chosen by pattern-matching a sentence is wrong the day somebody rewords the
 * sentence, in every copy at once. And it is deliberately NOT "split the change
 * and retry": that advice belongs to a crossed BOUND, where a smaller input
 * really does fit. Nothing about splitting changes a container's shape, so
 * offering it here would turn a refusal into a loop.
 *
 * Bounded work, because a fail-open guard is a total bypass if any input can
 * make it spin or throw: a fixed number of `typeof` tests and one lookup. The
 * offending value is NEVER serialised into the message — only its shape word —
 * so an enormous or cyclic `command` costs nothing and leaks nothing.
 *
 * Limits, stated rather than implied:
 * - It reads `tool_input.command`. A surface that names its command field
 *   differently is not seen at all, and that is the same blind spot the whole
 *   list in `.claude/scripts/lib/shell-tools.mjs` has: harness → guard is
 *   guarded by nobody.
 * - `absent` covers `null` as well as `undefined`, on both `tool_input` and
 *   `command`. A key explicitly set to null carries no command to read, and
 *   refusing it would fire on payloads that mean "no command".
 * - An empty or whitespace-only string is READABLE and allowed. It is a
 *   command that does nothing, not a shape the guard failed to parse.
 * Pinned in hook-command-shape.test.ts (absent in a generated rig) ›
 * "refuses an unreadable command through %s while the kill switch is armed"
 * and › "allows an ABSENT command through %s".
 */

/** The shape word for a value, bounded: never the value itself. */
const shapeOf = (value) => {
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
};

/**
 * What a shell guard was handed, as one of three outcomes.
 *
 * @returns {{kind:'absent'}
 *          |{kind:'string', command:string}
 *          |{kind:'unreadable', reason:string, remedy:string}}
 */
export const shellCommandOf = (input) => {
  const toolInput = input?.tool_input;
  if (toolInput === undefined || toolInput === null) return { kind: 'absent' };
  if (typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return unreadable('tool_input', shapeOf(toolInput), 'an object');
  }
  const command = toolInput.command;
  if (command === undefined || command === null) return { kind: 'absent' };
  if (typeof command !== 'string') {
    return unreadable('tool_input.command', shapeOf(command), 'a string');
  }
  return { kind: 'string', command };
};

const unreadable = (field, got, expected) => ({
  kind: 'unreadable',
  reason:
    `BLOCKED — ${field} is present as ${got}, and this guard reads ${expected}. ` +
    'An input it cannot read is refused, never allowed: the Never-tier rules and ' +
    'the kill switch are decided by reading the command, so allowing what was ' +
    'not read would report a check that did not happen ' +
    '(.claude/rules/invariants.md, "Refusing to inspect is a third outcome").',
  remedy: `Resend the call with ${field} as ${expected}.`,
});

/**
 * One refusal, one wording — so two guards cannot drift apart in what they say.
 *
 * It answers for the `unreadable` member only. Handed anything else it returns
 * the empty string rather than `"undefined undefined"`: a guard that printed
 * that would be reporting a refusal it cannot explain, and the caller could not
 * act on it. The call sites below never do this today; the guard is here so a
 * later one cannot introduce it silently.
 */
export const refusalText = (refusal) =>
  refusal?.kind === 'unreadable' ? `${refusal.reason} ${refusal.remedy}` : '';
