import { createHash } from 'node:crypto';

/**
 * RP-256 slice 2 — installing beside a user-owned AGENTS.md through one
 * bounded managed region.
 *
 * These are the tests' OWN pinned choices for the parts the ticket left
 * open ("choose a minimal, exact form"), not a reflection of anything
 * production has decided yet — the tests importing this module ARE the
 * contract an implementation has to satisfy, not a description of one that
 * already exists.
 *
 * - The marker lines match `AGENTS.md`'s own comment style and the ticket's
 *   suggested minimal form, exactly, as a WHOLE line.
 * - The separator between a user's own bytes and the begin marker is ALWAYS
 *   exactly one inserted "\n" — regardless of whether the user's content
 *   already ends in one. This is what makes the whole operation exactly
 *   reversible in both cases (pinned, not merely convenient):
 *     - user bytes already end in "\n": the inserted separator becomes a
 *       SECOND, distinguishable newline — stripping exactly one newline
 *       immediately before the begin marker removes the INSERTED one and
 *       leaves the user's own trailing newline untouched.
 *     - user bytes do not end in "\n": the inserted separator is the ONLY
 *       newline there — stripping it restores the user's bytes with no
 *       trailing newline at all, exactly as they were.
 *   See `packages/cli/test/agents-md-region-uninstall.test.ts` for the
 *   round-trip proof of both cases.
 */
export const REGION_BEGIN = '<!-- create-agent-rig:begin -->';
export const REGION_END = '<!-- create-agent-rig:end -->';

/**
 * node:crypto directly — never `packages/cli/src/lib/manifest.js`'s own
 * `sha256` re-export, so a hash comparison in a test that reads this module
 * is never the same computation as the mechanism under test (the
 * independent-oracle invariant, `.claude/rules/invariants.md`).
 */
export function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The exact bytes this suite expects `init`/`upgrade` to write when a
 * rendered rulebook body is spliced into (or refreshed within) a
 * pre-existing, user-owned AGENTS.md: the user's bytes, byte for byte,
 * followed by the always-inserted separator described above, the begin
 * marker on its own line, the rendered body (which already carries its own
 * trailing "\n" — the shipped template ends in one), and the end marker on
 * its own line followed by a trailing newline.
 *
 * `suffix` (round 2, code-reviewer B1 / security-scanner B1): whatever bytes
 * the user placed AFTER the end marker's own line — the natural place to add
 * a new section to a file that already has one. Defaults to `''`, which
 * reproduces exactly the bytes this function always produced before this
 * parameter existed (`${REGION_END}\n` with nothing after) — a call site
 * that never passes a third argument is byte-for-byte unaffected. When
 * `suffix` is non-empty it is appended immediately after the end marker's
 * own trailing `"\n"`, verbatim — no further separator is inserted, because
 * `suffix` already carries whatever bytes originally followed that newline
 * (which may itself start with a blank line, more prose, anything): the
 * ticket's carry-through design (round 2, item 1) is "preserve exactly what
 * was there", not "insert a fresh one".
 */
export function composeRegion(userBytes: string, body: string, suffix: string = ''): string {
  return `${userBytes}\n${REGION_BEGIN}\n${body}${REGION_END}\n${suffix}`;
}
