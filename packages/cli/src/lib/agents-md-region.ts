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
 * The user's own bytes, the separator `composeRegion` always inserts, the
 * begin marker on its own line, the rendered body, then the end marker on
 * its own line followed by a trailing newline.
 *
 * The separator between `userBytes` and the begin marker is ALWAYS exactly
 * one inserted `"\n"`, regardless of whether `userBytes` already ends in
 * one — this is what makes {@link locateRegion} exactly invert this
 * function in both cases: user bytes already ending in `"\n"` gain a
 * SECOND, distinguishable newline (stripping the inserted one leaves the
 * user's own trailing newline untouched); user bytes not ending in `"\n"`
 * get the separator as their only new newline (stripping it restores no
 * trailing newline at all).
 */
export function composeRegion(userBytes: string, body: string): string {
  return `${userBytes}\n${REGION_BEGIN}\n${body}${REGION_END}\n`;
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
  return { userBytes, body };
}

/**
 * The user's own bytes, restored exactly — the inverse of {@link
 * composeRegion}. `null` when `text` is not a well-formed region (see
 * {@link locateRegion}).
 */
export function stripRegion(text: string): string | null {
  const located = locateRegion(text);
  return located === null ? null : located.userBytes;
}
