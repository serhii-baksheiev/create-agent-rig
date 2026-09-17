import { lstat, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hookFilesReferencedIn } from '../lib/init-settings.js';
import { MANIFEST_REL, parseManifest, sha256 } from '../lib/manifest.js';
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
 * The file's bytes, or `null` when it is genuinely absent. Any other failure —
 * permissions, a directory where a file should be — is rethrown, because a
 * plan that cannot tell "gone" from "unreadable" must not guess.
 */
async function readIfPresent(repoDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(onDisk(repoDir, rel), 'utf8');
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
 */
function isLineEndingOnlyMatch(current: string, recordedHash: string): boolean {
  return (
    sha256(normalizeToLF(current)) === recordedHash ||
    sha256(normalizeToCRLF(current)) === recordedHash
  );
}

/**
 * What an uninstall would do, decided per file, removing nothing.
 *
 * Ownership evidence is the manifest alone: a path's recorded hash is the only
 * thing that can mark it for removal, and only when the bytes on disk still
 * match it exactly. Everything else — absent, edited, kept by init, wiring
 * this rig no longer recognises, or the CRLF/LF twin of what it wrote — is
 * reported and left alone.
 */
export async function planUninstall(repoDir: string): Promise<UninstallPlan> {
  const raw = await readIfPresent(repoDir, MANIFEST_REL);
  if (raw === null) return { noManifest: true, actions: [] };

  const manifest = parseManifest(raw);
  if (manifest === null) {
    throw new UninstallError(
      `${MANIFEST_REL} exists but could not be read as a rig manifest. Refusing to remove anything.`,
    );
  }

  const actions: UninstallAction[] = [];
  for (const rel of Object.keys(manifest.files).sort()) {
    const recorded = manifest.files[rel]!;
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
    const current = await readFile(onDisk(repoDir, rel), 'utf8');

    if (WIRING_PATHS.has(rel)) {
      if (sha256(current) === recorded) {
        actions.push({ rel, verdict: 'remove' });
      } else {
        const hooks = [...hookFilesReferencedIn(current)].sort();
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
 * Removes `rel`'s parent directories while they are empty, stopping at the
 * repository root and never removing `.rig` itself — evidence lives there,
 * and the directory staying in place (even empty) is the rig's own record
 * that it once ran here.
 */
async function removeEmptyParents(repoDir: string, rel: string): Promise<void> {
  let dir = path.posix.dirname(rel.split(path.sep).join('/'));
  while (dir !== '.' && dir !== '' && dir !== RIG_DIR) {
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
 * Removes the `remove`-verdict paths in `plan`, then the manifest — only once
 * every one of them succeeded. A failure stops the run where it is: the
 * manifest stays, so a re-run's plan sees the removed paths as `absent` and
 * picks up exactly where this one stopped.
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
