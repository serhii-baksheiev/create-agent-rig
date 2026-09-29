/**
 * Resolve symlinks in the nearest existing ancestor of `filePath`, preserving
 * a missing tail. The shared implementation `guard-rulebook.mjs` uses to
 * decide the REAL, resolved location an edit fragment names — extracted so
 * it can be pinned directly, in-process, rather than only through the full
 * hook subprocess (RP-247 round 3).
 *
 * `guard-rulebook.mjs` calls `process.exit(main())` at its module top level,
 * so importing THAT file in-process would kill the test worker the same way
 * `edit-input.mjs` and `hook-input.mjs` were split out to avoid exactly that.
 * This module is side-effect free on purpose: no top-level `process.exit`,
 * no I/O at import time — the only filesystem access happens inside the
 * function body, through the injectable `realpath` parameter.
 *
 * `realpath` defaults to `realpathSync.native` (RP-54: never plain
 * `realpathSync` — only the native one expands a Windows 8.3 short name) but
 * is overridable so a test can pin the WALK's own bound directly — call
 * counts, not merely the eventual answer — without a real filesystem for the
 * over-bound case. See canonical-path.test.ts (absent in a generated rig)'s
 * own header: a mutation moving the component-bound check from before the
 * walk to after it left the whole suite green, because the eventual ANSWER
 * stayed correct on every existing pin — only a call-count assertion catches
 * it, which is why one exists here now.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { exceedsPathComponentBound } from './edit-input.mjs';

// RP-246 part 1: `realpathSync.native` never folds an admin-share UNC
// spelling of a Windows path (`\\host\X$\rest`) to the local-drive spelling
// of the same directory (`X:\rest`) — the two stay distinct strings forever,
// which is why `guard-rulebook.mjs` cannot rely on `canonicalRoot` alone to
// recognise a payload path spelled with the local drive when
// `CLAUDE_PROJECT_DIR` itself is UNC-spelled. Pure text, no filesystem call,
// so it is pinned directly in canonical-path.test.ts (absent in a generated
// rig) rather than only through the win32-only guard-rulebook.test.ts
// (absent in a generated rig) subprocess pins that exercise it.
const ADMIN_SHARE_ROOT = /^\\\\[^\\]+\\([A-Za-z])\$(\\.*)?$/;

/**
 * The local-drive spelling of an admin-share UNC root, or `undefined` when
 * `root` is not spelled that way (including an already-local-drive path, a
 * plain UNC share, or a POSIX path).
 */
export function adminShareDriveSpelling(root) {
  const match = ADMIN_SHARE_ROOT.exec(String(root ?? ''));
  if (!match) return undefined;
  const [, drive, rest] = match;
  return `${drive.toUpperCase()}:${rest ?? '\\'}`;
}

export function canonicalPath(filePath, { realpath = realpathSync.native } = {}) {
  const resolved = resolve(filePath);
  // Checked BEFORE any `realpath` call, not merely before the walk RETURNS:
  // this walk would otherwise spend one call per path component that does
  // not exist on disk — a crafted `file_path` with many such components
  // (`/a/a/a/…`) would make it grow with the component count instead of the
  // file's actual depth, and `guard-rulebook.mjs` calls this for every
  // fragment before it ever checks whether the unattended flag is armed. A
  // guard that blocks correctly but only after doing unbounded work first
  // has not met `.claude/rules/invariants.md`'s "provably bounded work" bar
  // either — a killed hook is still an ALLOW. `exceedsPathComponentBound` is
  // `edit-input.mjs`'s own bound, reused rather than a second number
  // (`.claude/rules/invariants.md`, "one mechanism, one implementation").
  if (exceedsPathComponentBound(resolved)) return null;
  // The full resolved path, leaf included, is tried FIRST — not skipped in
  // favour of starting the climb at its parent. RP-247 round 3: an earlier
  // version of this function seeded `tail` with `basename(resolved)` and
  // started `cursor` at `dirname(resolved)` to shave one `realpath` call off
  // the component-count pin below, but a `file_path` whose own LEAF is a
  // symlink is never resolved by a walk that never tries the leaf itself —
  // `canonicalPath('src/link.md')` returned the lexical `src/link.md`
  // unchanged even when that symlink pointed at a rulebook file, letting a
  // Write through it bypass `guard-rulebook` entirely (see
  // guard-rulebook.test.ts (absent in a generated rig) › "blocks a Write to
  // a symlink file whose target is inside the rulebook"). One extra call in
  // the fully-missing case is the cost of resolving a leaf that DOES exist.
  let cursor = resolved;
  const tail = []; // pushed nearest-missing-first; reversed once, joined once — never `unshift`, never spread
  for (;;) {
    try {
      const base = realpath(cursor);
      if (tail.length === 0) return base;
      tail.reverse();
      return join(base, tail.join('/'));
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return filePath;
      tail.push(basename(cursor));
      cursor = parent;
    }
  }
}
