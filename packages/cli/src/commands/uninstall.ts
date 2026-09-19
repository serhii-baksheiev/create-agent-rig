import { lstat, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { initInstallSet } from './init.js';
import { hookFilesReferencedIn } from '../lib/init-settings.js';
import { MANIFEST_REL, parseManifest, sha256 } from '../lib/manifest.js';
import type { RigManifest } from '../lib/manifest.js';
import { resolveInside } from '../lib/safe-path.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class UninstallError extends Error {}

export type UninstallVerdict = 'remove' | 'absent' | 'preserved';

export interface UninstallAction {
  rel: string;
  verdict: UninstallVerdict;
  /** Why, for `preserved` — always set on that verdict, never on the others. */
  reason?: string;
}

export interface UninstallPlan {
  /**
   * True when there is nothing to act on: no manifest at all — never written,
   * already removed by a previous uninstall, or deleted by hand. This is what
   * makes a repeat run idempotent: the second run sees no manifest and reports
   * success with nothing to do, rather than an error about a target that is
   * already gone.
   */
  noManifest: boolean;
  actions: UninstallAction[];
}

export interface ApplyUninstallOptions {
  dryRun?: boolean;
  /**
   * Test seam: replaces the function that removes one file on disk. Real runs
   * never pass this — it exists so a test can inject a failure partway through
   * a multi-file removal without a mocking framework.
   */
  removeFile?: (absolutePath: string) => Promise<void>;
}

export interface ApplyUninstallResult {
  /** Paths actually deleted from disk (real run only — empty on a dry run). */
  removed: string[];
  /** True only when every `remove` action succeeded and the manifest itself was deleted. */
  manifestRemoved: boolean;
  /** Present only after a failed, partial run: what finished before the error. */
  completed?: string[];
  /** Present only after a failed, partial run: what a re-run still owes, including the failed path. */
  remaining?: string[];
  /** Present only after a failed, partial run: the error's own message. */
  error?: string;
}

const WIRING_PATHS = new Set(['.claude/settings.json', '.codex/hooks.json']);

/** `.rig/` is evidence — the manifest never names anything under it worth removing on its say-so. */
const RIG_DIR = '.rig';

/**
 * Where `rel` lives inside the rig — refused outright if it lands anywhere
 * else. The manifest is committed, so it arrives in pull requests like any
 * other file, and a path it names has to be checked exactly as `upgrade`
 * checks one before writing.
 */
function onDisk(repoDir: string, rel: string): string {
  const dest = resolveInside(repoDir, rel);
  if (dest === null) {
    throw new UninstallError(`Refusing to touch "${rel}" — it resolves outside ${repoDir}.`);
  }
  return dest;
}

/**
 * The file's raw bytes, or `null` when it is genuinely absent. Any other
 * failure — permissions, a directory where a file should be — is rethrown,
 * because a plan that cannot tell "gone" from "unreadable" must not guess.
 *
 * Read as bytes, never decoded — ADR-RP-003 (raw-byte ownership): a hash
 * compares exactly what the rig wrote against exactly what is on disk, and a
 * file that is not valid UTF-8 must not be silently rewritten through
 * replacement characters before it is hashed.
 */
async function readIfPresent(repoDir: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(onDisk(repoDir, rel));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Why a path that resolves lexically inside the repo is still refused. */
export const NOT_A_REGULAR_FILE_REASON = 'not a regular file inside the repository (symlink)';

/**
 * `'ok'`, `'absent'`, or `'unsafe'` — decided with `lstat`, one path segment at
 * a time from the repository root down, so a symlink is caught wherever it
 * sits and never followed to answer the question.
 *
 * `resolveInside` is purely lexical: it refuses `..` and an absolute path, but
 * a manifest path that lands inside the repo lexically can still leave it at
 * runtime if an ANCESTOR directory is a symlink out — `.claude/rules` pointing
 * outside the repo makes `.claude/rules/workflow.md` resolve outside it too,
 * even though the string never left. Reading such a path hashes bytes this
 * command has no evidence for; removing it deletes something outside the repo
 * entirely. So every segment down to the file itself is checked with `lstat`,
 * which — unlike `stat` or a plain `readFile`/`unlink` — never follows the
 * final symlink component, and the file itself must be a regular file too: a
 * symlink sitting exactly at the manifest path is exactly as unsafe to read
 * through and to report as owned.
 *
 * `'absent'` covers a missing ancestor as well as a missing file — both mean
 * "nothing here to remove", which is what the existing `absent` verdict
 * already says.
 */
async function regularFileStatus(
  repoDir: string,
  rel: string,
): Promise<'ok' | 'absent' | 'unsafe'> {
  // Lexical containment first, unchanged from before this check existed: a
  // manifest path with `..` or an absolute segment refuses the whole run,
  // exactly as it did when this was `onDisk`'s job alone. Only a path that
  // passes this can even reach the lstat walk below.
  onDisk(repoDir, rel);
  const segments = rel.split('/');
  let current = repoDir;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
    const isLast = index === segments.length - 1;
    if (isLast) return info.isFile() ? 'ok' : 'unsafe';
    if (!info.isDirectory()) return 'unsafe';
  }
  // Unreachable: `segments` always has at least one element (`''.split('/')`
  // is `['']`), and every branch inside the loop returns. Here only to
  // satisfy the compiler, the same way `applyUpgrade`'s "Internal:" throw does.
  throw new UninstallError(`Internal: could not classify "${rel}" — no path segment to check.`);
}

const normalizeToLF = (content: string): string => content.replace(/\r\n/g, '\n');
const normalizeToCRLF = (content: string): string => normalizeToLF(content).replace(/\n/g, '\r\n');

/**
 * True when `current`'s only difference from the recorded hash is its line
 * endings — checked both directions, since the recorded hash was taken of
 * whatever the rig actually wrote, and this command has no other record of
 * those original bytes to compare against.
 *
 * A binary file — one whose bytes do not round-trip through UTF-8 without
 * loss — can never take this branch: decoding it would hash a
 * replacement-character string standing in for bytes that were never text,
 * exactly what ADR-RP-003 forbids. Its own raw-byte hash was already checked
 * and did not match, so it falls through to `modified` instead, the same as
 * `upgrade`'s `isReleasedVersion` treats an invalid-UTF-8 candidate.
 */
function isLineEndingOnlyMatch(current: Buffer, recordedHash: string): boolean {
  const decoded = current.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(current)) return false;
  return (
    sha256(normalizeToLF(decoded)) === recordedHash ||
    sha256(normalizeToCRLF(decoded)) === recordedHash
  );
}

/** The first path segment — the top-level name a manifest entry lives under. */
function topSegment(rel: string): string {
  return rel.split('/')[0]!;
}

/**
 * Refuses the whole run outright when any manifest path — `files` or `kept` —
 * names something under `.git`. A manifest is committed, so it is untrusted
 * input the same way a pull request is; a manifest that pairs
 * `.git/hooks/pre-commit` with that file's true on-disk hash would otherwise
 * make a confirmed `uninstall` remove the repository's own git hooks. Checked
 * once, over every key, before anything else runs.
 */
function refuseGitPaths(manifest: RigManifest): void {
  const all = [...Object.keys(manifest.files), ...Object.keys(manifest.kept ?? {})];
  const gitPath = all.find((rel) => topSegment(rel) === '.git');
  if (gitPath !== undefined) {
    throw new UninstallError(
      `${MANIFEST_REL} names "${gitPath}", under .git. A rig manifest never legitimately owns ` +
        'anything there — refusing to run.',
    );
  }
}

/**
 * Every top-level path this release actually installs — the ownership
 * boundary a `remove` verdict is held to, beyond the manifest's own say-so.
 * Read from the same install-set generator `init`/`upgrade` use, never
 * hand-listed: a hand-written list of "rig directories" drifts the day the
 * install set changes shape, and a manifest naming a path outside it (a
 * tampered entry, or simply a stale one from a release that installed
 * something this one does not) is not evidence this command can act on.
 */
async function rigOwnedRoots(repoDir: string): Promise<Set<string>> {
  const files = await initInstallSet(repoDir);
  return new Set(files.map((f) => topSegment(f.rel)));
}

/**
 * What an uninstall would do, decided per file, removing nothing.
 *
 * Ownership evidence is the manifest alone: a path's recorded hash is the only
 * thing that can mark it for removal, and only when the bytes on disk still
 * match it exactly AND the path sits under a top-level root this release
 * actually installs. Everything else — absent, edited, kept by init, wiring
 * this rig no longer recognises, a path outside the current install set, or
 * the CRLF/LF twin of what it wrote — is reported and left alone.
 */
export async function planUninstall(repoDir: string): Promise<UninstallPlan> {
  const raw = await readIfPresent(repoDir, MANIFEST_REL);
  if (raw === null) return { noManifest: true, actions: [] };

  const manifest = parseManifest(raw.toString('utf8'));
  if (manifest === null) {
    throw new UninstallError(
      `${MANIFEST_REL} exists but could not be read as a rig manifest. Refusing to remove anything.`,
    );
  }
  refuseGitPaths(manifest);
  const ownedRoots = await rigOwnedRoots(repoDir);

  const actions: UninstallAction[] = [];
  for (const rel of Object.keys(manifest.files).sort()) {
    const recorded = manifest.files[rel]!;
    // Lexical containment unconditionally, before the ownership check below —
    // a `..`-escaping path is refused outright regardless of whether its top
    // segment happens to look owned.
    onDisk(repoDir, rel);
    if (!ownedRoots.has(topSegment(rel))) {
      actions.push({
        rel,
        verdict: 'preserved',
        reason: `not a path this release installs (top-level "${topSegment(rel)}" is not part of the current install set)`,
      });
      continue;
    }
    const status = await regularFileStatus(repoDir, rel);
    if (status === 'absent') {
      actions.push({ rel, verdict: 'absent' });
      continue;
    }
    if (status === 'unsafe') {
      actions.push({ rel, verdict: 'preserved', reason: NOT_A_REGULAR_FILE_REASON });
      continue;
    }
    // status === 'ok': every ancestor is a real directory and the path itself
    // is a regular file — safe to read and to hash.
    const current = await readFile(onDisk(repoDir, rel));

    if (WIRING_PATHS.has(rel)) {
      if (sha256(current) === recorded) {
        actions.push({ rel, verdict: 'remove' });
      } else {
        const hooks = [...hookFilesReferencedIn(current.toString('utf8'))].sort();
        actions.push({
          rel,
          verdict: 'preserved',
          reason:
            "wiring-modified — remove the rig's hook entries by hand" +
            (hooks.length > 0 ? ` (still referenced: ${hooks.join(', ')})` : ''),
        });
      }
      continue;
    }

    const currentHash = sha256(current);
    if (currentHash === recorded) {
      actions.push({ rel, verdict: 'remove' });
    } else if (isLineEndingOnlyMatch(current, recorded)) {
      actions.push({ rel, verdict: 'preserved', reason: 'line-endings-only' });
    } else {
      actions.push({ rel, verdict: 'preserved', reason: 'modified' });
    }
  }

  for (const rel of Object.keys(manifest.kept ?? {}).sort()) {
    actions.push({ rel, verdict: 'preserved', reason: 'user-owned (kept by init)' });
  }

  return { noManifest: false, actions };
}

/**
 * True when every segment of `relDir`, walked one at a time from `repoDir`,
 * `lstat`s as a real (non-symlink) directory.
 *
 * Mirrors {@link regularFileStatus}'s own per-segment walk, for the same
 * reason: a single `lstat` on the whole joined path has the OS resolve every
 * INTERMEDIATE component transparently — only the final component is left
 * unfollowed — so it would happily walk through a symlinked ancestor to
 * answer "is the last segment a directory". Checking one segment at a time
 * means each `lstat` only ever extends a prefix the previous iteration has
 * already proven is a real directory, so no call in the chain can be resolved
 * through a symlink it did not itself just reject.
 */
async function isPlainDirectoryChain(repoDir: string, relDir: string): Promise<boolean> {
  let current = repoDir;
  for (const segment of relDir.split('/')) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return false;
    }
    if (!info.isDirectory()) return false;
  }
  return true;
}

/**
 * Removes `rel`'s parent directories while they are empty, stopping at the
 * repository root and never removing `.rig` itself — evidence lives there,
 * and the directory staying in place (even empty) is the rig's own record
 * that it once ran here.
 *
 * Symlink-safe the same way removal itself is: before any directory is read
 * or emptied, {@link isPlainDirectoryChain} re-walks it segment by segment, so
 * an ancestor swapped for a symlink after the file itself was removed is left
 * alone rather than read or emptied through.
 */
async function removeEmptyParents(repoDir: string, rel: string): Promise<void> {
  let dir = path.posix.dirname(rel.split(path.sep).join('/'));
  while (dir !== '.' && dir !== '' && dir !== RIG_DIR) {
    if (!(await isPlainDirectoryChain(repoDir, dir))) return;
    const abs = path.join(repoDir, ...dir.split('/'));
    let entries: string[];
    try {
      entries = await readdir(abs);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    try {
      await rmdir(abs);
    } catch {
      return;
    }
    dir = path.posix.dirname(dir);
  }
}

/**
 * Removes the `remove`-verdict paths in `plan`, then the manifest — but only
 * once every one of them succeeded AND nothing else in the plan is
 * `preserved`. A `preserved` action means the rig still owns bytes it did not
 * remove (an edit, a CRLF checkout, wiring the run left alone); deleting the
 * manifest anyway would discard the only evidence naming what it still owns,
 * blinding a later `upgrade`. A failure among the removals stops the run
 * where it is either way: the manifest stays, so a re-run's plan sees the
 * removed paths as `absent` and picks up exactly where this one stopped.
 */
export async function applyUninstall(
  repoDir: string,
  plan: UninstallPlan,
  options: ApplyUninstallOptions = {},
): Promise<ApplyUninstallResult> {
  if (plan.noManifest) return { removed: [], manifestRemoved: false };

  const toRemove = plan.actions.filter((a) => a.verdict === 'remove').map((a) => a.rel);
  if (options.dryRun === true) return { removed: [], manifestRemoved: false };

  const removeFile = options.removeFile ?? ((absolutePath: string) => unlink(absolutePath));
  const removed: string[] = [];
  for (const rel of toRemove) {
    try {
      // Re-checked here, not trusted from the plan: the plan can be stale by
      // the time this runs, and a symlink swapped in after planning is
      // exactly the case the plan-time check cannot see.
      const status = await regularFileStatus(repoDir, rel);
      if (status !== 'ok') {
        throw new Error(
          `refusing to remove "${rel}": it is no longer a plain file inside the repository ` +
            '(a symlink appeared since planning)',
        );
      }
      await removeFile(onDisk(repoDir, rel));
    } catch (error) {
      return {
        removed,
        manifestRemoved: false,
        completed: [...removed],
        remaining: toRemove.slice(removed.length),
        error: (error as Error).message,
      };
    }
    removed.push(rel);
    await removeEmptyParents(repoDir, rel);
  }

  // Something is still preserved — the rig remains installed, on purpose. The
  // manifest is the only record naming what it still owns, so it is kept even
  // though every removal that WAS planned just succeeded.
  if (plan.actions.some((a) => a.verdict === 'preserved')) {
    return { removed, manifestRemoved: false };
  }

  try {
    await unlink(onDisk(repoDir, MANIFEST_REL));
  } catch (error) {
    return {
      removed,
      manifestRemoved: false,
      completed: [...removed],
      remaining: [MANIFEST_REL],
      error: (error as Error).message,
    };
  }
  // The manifest is often the last file left in `.claude/` — its own removal
  // is what can finally empty that directory, so the same cleanup runs again
  // for it.
  await removeEmptyParents(repoDir, MANIFEST_REL);

  return { removed, manifestRemoved: true };
}
