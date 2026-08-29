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
