/**
 * Mirrors `parseElevatedPaths` in
 * `templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs` —
 * the gate sweep's own parser for the fenced ```elevated-paths block a
 * rulebook file declares. Kept in step with it by a correspondence test
 * (`packages/cli/test/elevated-paths-correspondence.test.ts`) that feeds the
 * same literal fixtures to both and fails the moment they disagree, rather
 * than by a shared import — the `.mjs` is the gate sweep's own copy, shipped
 * into every generated rig, and this file is the generator's own, used only
 * to DECIDE whether `upgrade` can trust an on-disk AGENTS.md as a rulebook
 * (round 5, design ruling replacing round 4's verdict-only rule). Two
 * different consumers, one semantics, proven equal rather than assumed so.
 *
 * Bounded, one forward pass: a hostile or merely enormous AGENTS.md cannot
 * make this cost more than a fixed amount of work. The cap is applied BEFORE
 * the regex ever runs, so the single `matchAll` pass is always over a string
 * no longer than {@link ELEVATED_PATHS_SCAN_CAP}, never proportional to an
 * attacker-chosen input size.
 */
export const ELEVATED_PATHS_SCAN_CAP = 1_000_000;

/**
 * Normalise a path so both sides of a comparison agree — identical to the
 * `.mjs` sweep's own `normalizePath`, restated here because the correspondence
 * test proves the two produce the same answer rather than sharing an import.
 */
export function normalizeElevatedPath(path: string): string {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');
}

/**
 * Every declared path across every ```elevated-paths block in `markdown`, or
 * `null` when there is no such block at all. An empty array (block present,
 * nothing left after stripping comments and blank lines) is a real, distinct
 * answer from `null` — round 5's own trigger: a hostile or stale
 * `elevated-paths` block with only a comment ("Everything is Tier 0") parses
 * to `[]`, and {@link isReadableRulebook} treats that exactly like no block
 * at all, never like a real declaration.
 *
 * State limit, tested rather than merely claimed: content beyond
 * {@link ELEVATED_PATHS_SCAN_CAP} characters is never read at all — a block
 * that starts after the cap, or a path line that straddles it, is invisible
 * to this function. `elevated-paths-correspondence.test.ts` pins this pair:
 * a fixture within the cap agrees with the `.mjs` sweep (which has no cap),
 * and the cap's own behaviour on an over-limit fixture is tested against
 * this function alone, never against the `.mjs` (which would legitimately
 * disagree there — the cap is this file's own limit, not a shared one).
 */
export function parseElevatedPaths(markdown: string): string[] | null {
  const text = String(markdown ?? '');
  const bounded =
    text.length > ELEVATED_PATHS_SCAN_CAP ? text.slice(0, ELEVATED_PATHS_SCAN_CAP) : text;
  const blocks = [...bounded.matchAll(/```elevated-paths\r?\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  return blocks.flatMap((block) =>
    (block[1] ?? '')
      .split('\n')
      // An inline comment after the path is a comment, not part of the path.
      .map((line) => normalizeElevatedPath(line.replace(/\s+#.*$/, '').trim()))
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

/**
 * Round 5's content-based hold-back rule (replacing round 4's verdict-only
 * rule): whether `content` can serve as the rulebook AGENTS.md is meant to
 * be — at least one non-empty, non-comment path declared in a fenced
 * ```elevated-paths block. Absence of the FILE is decided by the caller
 * (`upgrade.ts`'s `deleted` verdict); this only ever judges bytes that are
 * actually present.
 */
export function isReadableRulebook(content: string): boolean {
  const parsed = parseElevatedPaths(content);
  return parsed !== null && parsed.length > 0;
}
