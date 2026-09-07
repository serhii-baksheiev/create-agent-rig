/**
 * The one list of what a repository-wide scan skips (RP-155).
 *
 * Two kinds of exclusion, and they are different facts:
 *   - a directory NAME skipped wherever it sits — `node_modules`, `.git`;
 *   - a repository-relative PATH skipped as a whole subtree — `.claude/worktrees`,
 *     where the `worktree-task` skill puts a session's sibling checkouts. A
 *     checkout nested there carries its own journal, rules, config and
 *     node_modules, and a scan that descends into it reports another checkout's
 *     files as this one's: consistency.test.ts once flagged
 *     `.claude/worktrees/<name>/journal/2026-08.md:311` once per worktree
 *     present, and the root eslint saw two project roots and refused every
 *     TypeScript file.
 *
 * Every scanner that can reach `.claude/` imports this module rather than
 * carrying a literal — `.claude/rules/invariants.md`, "one mechanism, one
 * implementation" — and `SCAN_IGNORE_GLOBS` is the same two facts in the
 * spelling ESLint's flat-config `ignores` takes, derived here so the root
 * eslint.config.mjs cannot drift from the walkers. Plain JavaScript on purpose:
 * eslint.config.mjs runs before any TypeScript build exists.
 *
 * Limits, stated rather than implied: `filesBelow` reads directory entries as
 * `Dirent`s and follows nothing — a symlink or junction is neither descended
 * nor reported (its `isDirectory()` is false), which is what the walker it
 * replaced did too; and `skipsScan` judges the spelling it is handed, so a
 * path that reaches a skipped directory through a link elsewhere is not seen
 * as skipped. Neither shape exists in this repository's scanned trees today.
 *
 * Pinned in test/template/scan-exclusions.test.ts › "names node_modules and
 * .git as skipped wherever they sit, and .claude/worktrees as a skipped
 * subtree", › "skipsScan refuses a worktree path, a nested node_modules, and
 * nothing else", › "filesBelow does not report a file inside a nested checkout
 * under .claude/worktrees/, and still reports its siblings" and › "the ESLint
 * ignore globs are the same facts, not a third spelling".
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const SKIPPED_DIRECTORY_NAMES = Object.freeze(['node_modules', '.git']);
export const SKIPPED_REPOSITORY_PATHS = Object.freeze(['.claude/worktrees']);
export const SCAN_IGNORE_GLOBS = Object.freeze([
  ...SKIPPED_DIRECTORY_NAMES.map((name) => `**/${name}/**`),
  ...SKIPPED_REPOSITORY_PATHS.map((rel) => `${rel}/**`),
]);

const toPosix = (value) => value.split(path.sep).join('/');

/**
 * Whether a repository scan skips `absolutePath` (a file or a directory) —
 * because one of its segments below `repoRoot` is a skipped name, or because
 * its repository-relative path is, or lies under, a skipped subtree.
 */
export const skipsScan = (repoRoot, absolutePath) => {
  const relative = toPosix(path.relative(repoRoot, absolutePath));
  if (relative === '' || relative.startsWith('..')) return false;
  const segments = relative.split('/');
  if (segments.some((segment) => SKIPPED_DIRECTORY_NAMES.includes(segment))) return true;
  return SKIPPED_REPOSITORY_PATHS.some((rel) => relative === rel || relative.startsWith(`${rel}/`));
};

/**
 * Every file under `dir` (absolute paths, any depth) whose name ends with
 * `extension`, never descending into a directory `skipsScan` refuses.
 */
export const filesBelow = async (repoRoot, dir, { extension }) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (skipsScan(repoRoot, full)) return [];
      if (entry.isDirectory()) return filesBelow(repoRoot, full, { extension });
      return entry.name.endsWith(extension) ? [full] : [];
    }),
  );
  return found.flat();
};
