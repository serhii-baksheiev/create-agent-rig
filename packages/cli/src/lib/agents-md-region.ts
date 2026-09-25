/**
 * RP-256 slice 2 — the bytes-only mechanics of the managed region a
 * user-owned AGENTS.md gets spliced with: composing it, finding it by exact
 * whole-line marker match, and stripping it back out.
 *
 * Deliberately narrow: no generic markdown merging, no fuzzy matching — a
 * marker only counts when it is a WHOLE line (start of text or right after a
 * `\n`, and end of text or right before a `\n`), so text that merely
 * contains the marker string inside a longer line (quoted in a code block,
 * say) is never mistaken for the real thing.
 *
 * This is production's OWN implementation, independent of
 * `test/helpers/agents-md-region.ts` — that module is the tests' oracle, not
 * something production imports (the independent-oracle invariant,
 * `.claude/rules/invariants.md`). Both happen to agree on the marker text and
 * the composition rule because that rule is pinned in Jira RP-256 comment
 * 20585, not because one was derived from the other.
 */

export const REGION_BEGIN = '<!-- create-agent-rig:begin -->';
export const REGION_END = '<!-- create-agent-rig:end -->';

/**
 * The largest user-owned AGENTS.md this rig will read in order to splice a
 * region into (or out of) it — generous for a rulebook a human edits by
 * hand (the rendered rulebook body itself is well under this), and still a
 * real bound: {@link import('./bounded-file.js').readBoundedFileInRepo}
 * allocates this many bytes plus one, once, never more, regardless of what
 * is actually at the far end of a symlink a repository itself controls
 * (mirrors `init.ts`'s `MAX_KEPT_BYTES`, RP-256 slice 1).
 */
export const MAX_AGENTS_MD_REGION_BYTES = 1024 * 1024;

/**
 * `bytes` decoded as strict UTF-8, or `null` when they are not (round 2,
 * code-reviewer B4 / security-scanner B2) — including a UTF-16 BOM (`FF FE`
 * or `FE FF`), which is never valid UTF-8 lead-byte data and so is refused
 * by the same `fatal: true` check, not by a special case for it. The one
 * spelling of this decode `init.ts`, `upgrade.ts` and `uninstall.ts` all use
 * for the user's own AGENTS.md bytes — `doctor.ts`'s own `text()` already
 * decoded this way before round 2, for the same reason: a lossy
 * `Buffer#toString('utf8')` silently turns an invalid byte into `U+FFFD`
 * (`EF BF BD` once re-encoded), which is not the byte that was there.
 *
 * `ignoreBOM: true` matters for more than habit: a leading UTF-8 BOM
 * (`EF BB BF`) is a legitimate three-byte UTF-8 encoding of U+FEFF, decoded
 * here AS that character rather than stripped — so re-encoding the returned
 * string with `Buffer.from(str, 'utf8')` reproduces the original bytes
 * exactly, which the byte-for-byte "left untouched" guarantee this whole
 * module exists for depends on.
 */
export function decodeStrictUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The user's own bytes, the separator `composeRegion` always inserts, the
 * begin marker on its own line, the rendered body, then the end marker on
 * its own line followed by a trailing newline, then `suffix` verbatim.
 *
 * The separator between `userBytes` and the begin marker is ALWAYS exactly
 * one inserted `"\n"`, regardless of whether `userBytes` already ends in
 * one — this is what makes {@link locateRegion} exactly invert this
 * function in both cases: user bytes already ending in `"\n"` gain a
 * SECOND, distinguishable newline (stripping the inserted one leaves the
 * user's own trailing newline untouched); user bytes not ending in `"\n"`
 * get the separator as their only new newline (stripping it restores no
 * trailing newline at all).
 *
 * `suffix` (round 2, code-reviewer B1 / security-scanner B1): whatever bytes
 * sit AFTER the end marker's own line — the natural place for a user to add
 * a new section to a file that already has one. Defaults to `''`, which
 * reproduces exactly the bytes this function always produced before this
 * parameter existed — a call site that never passes a third argument is
 * byte-for-byte unaffected. Appended immediately after the end marker's own
 * trailing `"\n"`, verbatim, with no further separator inserted: `suffix`
 * already carries whatever bytes originally followed that newline.
 */
export function composeRegion(userBytes: string, body: string, suffix: string = ''): string {
  return `${userBytes}\n${REGION_BEGIN}\n${body}${REGION_END}\n${suffix}`;
}

/**
 * Every character index in `text` where `marker` occurs as a WHOLE line —
 * preceded by the start of `text` or a `\n`, and followed by the end of
 * `text` or a `\n`. A marker string appearing mid-line (inside a longer
 * sentence, inside a code fence) is not counted.
 */
function wholeLineIndexesOf(text: string, marker: string): number[] {
  const indexes: number[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(marker, searchFrom);
    if (idx === -1) break;
    const atLineStart = idx === 0 || text[idx - 1] === '\n';
    const afterEnd = idx + marker.length;
    const atLineEnd = afterEnd === text.length || text[afterEnd] === '\n';
    if (atLineStart && atLineEnd) indexes.push(idx);
    searchFrom = idx + marker.length;
  }
  return indexes;
}

/** Whether `text` contains a begin or end marker as a whole line, anywhere. */
export function hasAnyMarker(text: string): boolean {
  return (
    wholeLineIndexesOf(text, REGION_BEGIN).length > 0 ||
    wholeLineIndexesOf(text, REGION_END).length > 0
  );
}

export interface RegionMatch {
  /** Exactly the `userBytes` a `composeRegion` call would have been given. */
  userBytes: string;
  /** Exactly the `body` a `composeRegion` call would have been given. */
  body: string;
  /**
   * Exactly the `suffix` a `composeRegion` call would have been given —
   * everything after the end marker's own line, including its own trailing
   * `"\n"` if the end marker is not the file's last line (round 2,
   * code-reviewer B1 / security-scanner B1). `''` when the end marker's line
   * IS the last thing in `text` (with or without its own trailing newline).
   */
  suffix: string;
}

/**
 * `text` located as a well-formed managed region, or `null` when it is not:
 * anything other than EXACTLY one begin marker and EXACTLY one end marker,
 * in that order, as whole lines. Malformed — a missing marker, two begins,
 * an end before a begin — is `null`, exactly like no markers at all; a
 * caller that needs to tell "no markers" apart from "malformed markers"
 * uses {@link hasAnyMarker} first.
 */
export function locateRegion(text: string): RegionMatch | null {
  const begins = wholeLineIndexesOf(text, REGION_BEGIN);
  const ends = wholeLineIndexesOf(text, REGION_END);
  if (begins.length !== 1 || ends.length !== 1) return null;
  const beginIdx = begins[0]!;
  const endIdx = ends[0]!;
  if (beginIdx >= endIdx) return null;
  // `beginIdx === 0` means no separator was ever inserted before it — not a
  // shape `composeRegion` ever produces (it always writes `userBytes` first,
  // even an empty one, followed by an inserted "\n") — so it is foreign,
  // exactly like any other malformed shape.
  if (beginIdx === 0) return null;
  const userBytes = text.slice(0, beginIdx - 1);
  const bodyStart = beginIdx + REGION_BEGIN.length + 1;
  const body = text.slice(bodyStart, endIdx);
  // The end marker's own line ends either at the end of `text` (no trailing
  // newline at all — `suffix` is empty) or at a `\n` `wholeLineIndexesOf`
  // already confirmed is there (`atLineEnd`) — skip exactly that one
  // newline, never more, and everything past it is `suffix`, verbatim.
  const endLineTextEnd = endIdx + REGION_END.length;
  const suffix = endLineTextEnd === text.length ? '' : text.slice(endLineTextEnd + 1);
  return { userBytes, body, suffix };
}

/**
 * The user's own bytes, restored exactly — the inverse of {@link
 * composeRegion}: `userBytes` followed immediately by `suffix`, with no
 * separator inserted between them (`suffix` already carries whatever bytes
 * originally followed the region, including any newline of its own).
 * `null` when `text` is not a well-formed region (see {@link locateRegion}).
 */
export function stripRegion(text: string): string | null {
  const located = locateRegion(text);
  return located === null ? null : `${located.userBytes}${located.suffix}`;
}
