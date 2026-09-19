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
  /**
   * The manifest's recorded hash, set on every `remove` verdict a real plan
   * produces. `applyUninstall` re-reads the file's actual bytes immediately
   * before each removal and compares against this value — the plan can be
   * stale by the time it is applied, and `regularFileStatus`'s own re-check
   * only catches a symlink or a missing file, never a plain content edit.
   * Absent only on a hand-built plan a test constructs directly (bypassing
   * `planUninstall`) to opt out of that check on purpose.
   */
  recordedHash?: string;
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
  /**
   * sha256 of the manifest's own raw bytes at plan time — `null` only when
   * `noManifest`. `applyUninstall` re-verifies this twice: once before the
   * first removal (a plan built from bytes that no longer exist authorises
   * nothing) and again immediately before the manifest's own deletion (the
   * window every removal before it could have used) — so a manifest replaced
   * after planning is caught rather than acted on, in either direction.
   */
  manifestHash: string | null;
}

export interface ApplyUninstallOptions {
  dryRun?: boolean;
  /**
   * Test seam: replaces the function that removes one file on disk. Real runs
   * never pass this — it exists so a test can inject a failure partway through
   * a multi-file removal without a mocking framework.
   */
  removeFile?: (absolutePath: string) => Promise<void>;
  /**
   * After the same safe cleanup ordinary `uninstall` performs, remove the
   * manifest anyway even when something in the plan is `preserved` (or turned
   * out to be {@link ApplyUninstallResult.changedSincePlanning} at apply
   * time) — leaving every one of those paths for the user rather than
   * refusing to touch the manifest on their account. Detaching never deletes
   * a path this run would not otherwise have deleted on its own: the per-file
   * safety checks (ownership, hash, symlink, changed-since-planning) apply
   * identically either way, and a conflicting or modified file is never
   * forced away. This is the only thing `detach` changes.
   */
  detach?: boolean;
}

/**
 * The one word `--json` reports for what a completed run actually did:
 *
 * - `uninstalled` — every `remove`-verdict path was removed and the manifest
 *   itself was deleted too. Also reported when there was no manifest to act
 *   on at all (nothing installed, nothing to do).
 * - `partial` — something in the plan is `preserved`, or turned out to have
 *   changed since planning, so the manifest was kept on purpose: the rig
 *   still owns bytes it did not remove, and the manifest is the only record
 *   naming them.
 * - `detached` — `--detach` was requested: the same safe cleanup ran, and the
 *   manifest was removed regardless of what else was left behind.
 *
 * Present only on a run that actually completed (no `error`) — a hard failure
 * (a symlink appeared, the manifest itself went stale) is its own signal and
 * carries no outcome of this vocabulary.
 */
export type UninstallOutcome = 'uninstalled' | 'partial' | 'detached';

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
  /**
   * Paths the plan marked `remove` whose bytes no longer matched the plan's
   * recorded hash when their turn to be removed actually came — present only
   * when at least one occurred. Not removed, not a failure: the run kept
   * going, and the manifest is kept (or, under `--detach`, the path is named
   * in the handover) exactly as any other `preserved` path would be.
   */
  changedSincePlanning?: string[];
  /** Which of the three {@link UninstallOutcome}s this run reached — absent exactly when `error` is present. */
  outcome?: UninstallOutcome;
}

/** The reason named for a path discovered changed at apply time, never at plan time. */
export const CHANGED_SINCE_PLANNING_REASON =
  'changed since planning — its bytes no longer match what was planned to be removed';

const WIRING_PATHS = new Set(['.claude/settings.json', '.codex/hooks.json']);

/**
 * `.rig/` holds evidence (claims, run state) this command has no ownership
 * evidence for, so {@link removeEmptyParents}'s walk stops here rather than
 * reading or emptying the DIRECTORY itself. That is not a claim that nothing
 * under `.rig/` is ever removed: a FILE under it can still be one of the
 * exact paths {@link rigOwnedPaths} admits (`.rig/revalidation.json`, which
 * `init` installs) and is removed like any other manifest-owned file when its
 * hash matches — this constant only ever gates the directory's own removal.
 */
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
 *
 * ⚠ **Windows junctions.** A directory junction is a distinct NTFS
 * reparse-point kind from a symlink, and Node/libuv report it through
 * `Stats.isSymbolicLink()` on Windows the same way a real symlink is
 * reported — the same behaviour this repository's own ancestor-escape
 * fixtures already rely on elsewhere (`test/template/*.test.ts`'s
 * `process.platform === 'win32' ? 'junction' : 'dir'` pattern) and the reason
 * `fs.symlink(target, path, 'junction')` is the documented way to create a
 * directory link on Windows without administrator privilege. Every check
 * below is written to hold regardless of that classification anyway: an
 * intermediate segment is refused unless it is BOTH a real directory and not
 * a symlink, and the final segment is refused unless it is a plain file and
 * not a symlink — so even a hypothetical junction that reported
 * `isDirectory(): true` would still be caught. Exercised through
 * `planUninstall`/`applyUninstall` by `packages/cli/test/uninstall.test.ts`'s
 * Windows-only junction tests (`onlyOnWindows`), which run only in the
 * `windows-e2e` CI lane — this repository's own development environment
 * cannot create a junction to verify it directly.
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
    if (isLast) return !info.isSymbolicLink() && info.isFile() ? 'ok' : 'unsafe';
    if (info.isSymbolicLink() || !info.isDirectory()) return 'unsafe';
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

/**
 * `segment`, folded to the one spelling every alias of `.git` collapses to:
 * lowercased, an alternate-data-stream suffix (`name::$DATA`, and any other
 * `:stream`) stripped, then trailing dots and spaces stripped — the two
 * characters Windows itself silently drops when it resolves a path segment
 * on disk, so `.git`, `.git.`, `.git ` and `.GIT` all name the same entry
 * there even though they are different strings here.
 */
function normalizeGitLikeSegment(segment: string): string {
  const withoutStream = segment.split(':')[0] ?? segment;
  return withoutStream.replace(/[. ]+$/, '').toLowerCase();
}

/**
 * Refuses the whole run outright when any manifest path — `files` or `kept` —
 * names something under `.git`, checked on EVERY segment (not only the
 * first), so a nested `.git` inside an owned directory is refused exactly as
 * a top-level one is. A manifest is committed, so it is untrusted input the
 * same way a pull request is; a manifest that pairs `.git/hooks/pre-commit`
 * — or an alias {@link normalizeGitLikeSegment} folds to the same thing —
 * with that file's true on-disk hash would otherwise make a confirmed
 * `uninstall` remove the repository's own git state. Checked once, over
 * every key, before anything else runs.
 */
function refuseGitPaths(manifest: RigManifest): void {
  const all = [...Object.keys(manifest.files), ...Object.keys(manifest.kept ?? {})];
  const gitPath = all.find((rel) =>
    rel.split('/').some((s) => normalizeGitLikeSegment(s) === '.git'),
  );
  if (gitPath !== undefined) {
    throw new UninstallError(
      `${MANIFEST_REL} names "${gitPath}", which resolves to a path under .git. A rig manifest ` +
        'never legitimately owns anything there — refusing to run.',
    );
  }
}

/**
 * Refuses the whole run when a manifest lists the same path under both
 * `files` and `kept`. Nothing this rig ever writes produces that overlap —
 * `planUpgrade` explicitly drops a `kept` path the moment a release vouches
 * for it as one of `files` — so a manifest that has it is corrupt or
 * hand-edited, and letting the reader silently pick a winner (rather than
 * refusing) is exactly how a path ends up removed on one line of the plan
 * while the same plan reports it `preserved` on another.
 */
function refuseFilesKeptOverlap(manifest: RigManifest): void {
  const keptKeys = new Set(Object.keys(manifest.kept ?? {}));
  const overlap = Object.keys(manifest.files).find((rel) => keptKeys.has(rel));
  if (overlap !== undefined) {
    throw new UninstallError(
      `${MANIFEST_REL} names "${overlap}" under both "files" and "kept" — a manifest this tool ` +
        'ever wrote never overlaps the two; refusing to run.',
    );
  }
}

/**
 * The exact set of paths this release actually installs — the ownership
 * boundary a `remove` verdict is held to, beyond the manifest's own say-so.
 * Read from the same install-set generator `init`/`upgrade` use, never
 * hand-listed: a hand-written list drifts the day the install set changes
 * shape, and a manifest naming a path outside it (a tampered entry, or simply
 * a stale one from a release that installed something this one does not) is
 * not evidence this command can act on.
 *
 * Deliberately the exact `rel`, not its top-level segment: a boundary drawn
 * at the top level (`.claude`, `.rig`, `docs`, `journal`, …) would let a
 * manifest pair almost any path under an owned DIRECTORY with its true hash
 * and have it removed, even though this release never installs that exact
 * path. It also means a path spelled with a Windows alternate-data-stream
 * suffix (`name::$DATA`) is never mistaken for the plain name it addresses on
 * disk — the two are different strings, so the suffixed one is simply absent
 * from this set and falls to `preserved` on that ground alone.
 */
async function rigOwnedPaths(repoDir: string): Promise<Set<string>> {
  const files = await initInstallSet(repoDir);
  return new Set(files.map((f) => f.rel));
}

/**
 * The manifest's raw bytes, or `null` when it is genuinely absent — read the
 * same symlink-safe way any other manifest-owned path is: every ancestor
 * segment down to the manifest itself is checked with {@link regularFileStatus}
 * before anything is read, so a symlinked `.claude` cannot make this command
 * read a plausible-looking manifest that sits outside the repository, and
 * cannot make it silently report `noManifest` for a repository that actually
 * has one behind the link either. Refuses rather than guesses either way.
 */
async function readManifestBytes(repoDir: string): Promise<Buffer | null> {
  const status = await regularFileStatus(repoDir, MANIFEST_REL);
  if (status === 'absent') return null;
  if (status === 'unsafe') {
    throw new UninstallError(
      `Refusing to read "${MANIFEST_REL}" — an ancestor directory is a symlink (or another ` +
        'non-regular entry), so it cannot be trusted.',
    );
  }
  return readFile(onDisk(repoDir, MANIFEST_REL));
}

/**
 * Hook files a PRESERVED (edited) wiring file still references, keyed by the
 * hook's own `rel` and naming which wiring file holds it.
 *
 * Computed as its own pass, before the main per-file loop below — deciding a
 * hook file's own verdict from that single alphabetical pass would process it
 * before its wiring file's preserved status was even known, since a wiring
 * path (`.claude/settings.json`) sorts AFTER the hook files it references
 * (`.claude/hooks/*.mjs`). Deleting a hook file a preserved wiring file still
 * calls would leave that wiring — which the run left in place on purpose —
 * pointing at nothing, including the secret guard if it happened to be the
 * hook in question.
 */
async function protectedHooksFor(
  repoDir: string,
  manifest: RigManifest,
  ownedPaths: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const protectedHooks = new Map<string, string>();
  for (const wiringRel of WIRING_PATHS) {
    const recorded = manifest.files[wiringRel];
    if (recorded === undefined || !ownedPaths.has(wiringRel)) continue;
    const status = await regularFileStatus(repoDir, wiringRel);
    if (status !== 'ok') continue;
    const current = await readFile(onDisk(repoDir, wiringRel));
    if (sha256(current) === recorded) continue; // pristine — removed, not preserved
    for (const hook of hookFilesReferencedIn(current.toString('utf8'))) {
      if (!protectedHooks.has(hook)) protectedHooks.set(hook, wiringRel);
    }
  }
  return protectedHooks;
}

/**
 * What an uninstall would do, decided per file, removing nothing.
 *
 * Ownership evidence is the manifest alone: a path's recorded hash is the only
 * thing that can mark it for removal, and only when the bytes on disk still
 * match it exactly AND the path is one of the EXACT paths this release
 * actually installs. Everything else — absent, edited, kept by init, wiring
 * this rig no longer recognises, a hook a preserved wiring file still calls, a
 * path outside the current install set, or the CRLF/LF twin of what it wrote
 * — is reported and left alone.
 */
export async function planUninstall(repoDir: string): Promise<UninstallPlan> {
  const raw = await readManifestBytes(repoDir);
  if (raw === null) return { noManifest: true, actions: [], manifestHash: null };
  const manifestHash = sha256(raw);

  const manifest = parseManifest(raw.toString('utf8'));
  if (manifest === null) {
    throw new UninstallError(
      `${MANIFEST_REL} exists but could not be read as a rig manifest. Refusing to remove anything.`,
    );
  }
  refuseGitPaths(manifest);
  refuseFilesKeptOverlap(manifest);
  const ownedPaths = await rigOwnedPaths(repoDir);
  const protectedHooks = await protectedHooksFor(repoDir, manifest, ownedPaths);

  const actions: UninstallAction[] = [];
  for (const rel of Object.keys(manifest.files).sort()) {
    const recorded = manifest.files[rel]!;
    // Lexical containment unconditionally, before the ownership check below —
    // a `..`-escaping path is refused outright regardless of whether it
    // happens to be one of the exact paths this release installs.
    onDisk(repoDir, rel);
    if (!ownedPaths.has(rel)) {
      actions.push({
        rel,
        verdict: 'preserved',
        reason: 'not a path this release installs',
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
        actions.push({ rel, verdict: 'remove', recordedHash: recorded });
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

    const protectingWiring = protectedHooks.get(rel);
    if (protectingWiring !== undefined) {
      actions.push({
        rel,
        verdict: 'preserved',
        reason: `still referenced by ${protectingWiring}, which was preserved as edited — removing this file would leave it pointing at nothing`,
      });
      continue;
    }

    const currentHash = sha256(current);
    if (currentHash === recorded) {
      actions.push({ rel, verdict: 'remove', recordedHash: recorded });
    } else if (isLineEndingOnlyMatch(current, recorded)) {
      actions.push({ rel, verdict: 'preserved', reason: 'line-endings-only' });
    } else {
      actions.push({ rel, verdict: 'preserved', reason: 'modified' });
    }
  }

  for (const rel of Object.keys(manifest.kept ?? {}).sort()) {
    actions.push({ rel, verdict: 'preserved', reason: 'user-owned (kept by init)' });
  }

  return { noManifest: false, actions, manifestHash };
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
    // `isSymbolicLink()` checked explicitly, not only `isDirectory()` — the
    // same defensive pairing `regularFileStatus` uses, so this holds for a
    // Windows junction regardless of exactly how it is classified.
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
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
 * `null` when the manifest still matches `expectedHash` exactly; otherwise the
 * one sentence explaining why it does not — gone, behind a symlinked ancestor
 * (or another non-regular entry), or simply different bytes now. Never
 * throws: a symlinked ancestor is exactly one of the reasons this reports
 * rather than the caller having to catch {@link UninstallError} itself.
 */
async function manifestMismatchReason(
  repoDir: string,
  expectedHash: string,
): Promise<string | null> {
  let raw: Buffer | null;
  try {
    raw = await readManifestBytes(repoDir);
  } catch (error) {
    return (error as Error).message;
  }
  if (raw === null) return `"${MANIFEST_REL}" is gone — changed since planning`;
  if (sha256(raw) !== expectedHash) {
    return `"${MANIFEST_REL}" changed since planning — its bytes no longer match the plan`;
  }
  return null;
}

/**
 * Removes the `remove`-verdict paths in `plan`, then the manifest — but only
 * once every one of them succeeded AND (outside `--detach`) nothing else in
 * the plan is `preserved`, nor turned out to have changed since planning. A
 * `preserved` action, or a path caught changed at apply time, means the rig
 * still owns bytes it did not remove; deleting the manifest anyway would
 * discard the only evidence naming what it still owns, blinding a later
 * `upgrade` — unless `options.detach` says to do exactly that on purpose,
 * leaving those paths for the user instead.
 *
 * Two kinds of "this is not the plan I made" are both re-checked here, never
 * trusted from `plan`, because the window between the plan being shown and
 * this call — a confirmation prompt sits in it — is exactly where either can
 * happen: the manifest's own bytes ({@link manifestMismatchReason}, checked
 * once before the first removal and again immediately before the manifest's
 * own deletion) and each `remove`-verdict file's own bytes (checked
 * immediately before its removal, via `recordedHash`). A symlink appearing
 * where a plain file was planned is a THIRD kind, and gets a different
 * response on purpose: it aborts the whole run rather than skipping one path,
 * because it is the one shape suspicious enough that continuing is the wrong
 * default.
 */
export async function applyUninstall(
  repoDir: string,
  plan: UninstallPlan,
  options: ApplyUninstallOptions = {},
): Promise<ApplyUninstallResult> {
  if (plan.noManifest) return { removed: [], manifestRemoved: false, outcome: 'uninstalled' };

  const toRemove = plan.actions.filter((a) => a.verdict === 'remove');
  if (options.dryRun === true) return { removed: [], manifestRemoved: false };

  const detach = options.detach === true;
  // Whether this run, absent any hard failure, would go on to delete the
  // manifest: always true under `--detach` (that is the point of it), and
  // otherwise only when nothing in the plan is `preserved`. A `changed since
  // planning` discovery below can still turn this off for an ordinary run —
  // detach is the only thing that overrides it.
  const wouldDeleteManifest = detach || !plan.actions.some((a) => a.verdict === 'preserved');

  // Checkpoint 1: the manifest itself, before anything is touched at all. A
  // plan built from bytes that no longer exist is not evidence for what
  // follows, so nothing is removed — not even the files a fresh plan would
  // still agree to remove.
  if (plan.manifestHash !== null) {
    const mismatch = await manifestMismatchReason(repoDir, plan.manifestHash);
    if (mismatch !== null) {
      return {
        removed: [],
        manifestRemoved: false,
        completed: [],
        remaining: [...toRemove.map((a) => a.rel), ...(wouldDeleteManifest ? [MANIFEST_REL] : [])],
        error: `Refusing to apply a stale plan: ${mismatch}`,
      };
    }
  }

  const removeFile = options.removeFile ?? ((absolutePath: string) => unlink(absolutePath));
  const removed: string[] = [];
  const changedSincePlanning: string[] = [];
  for (let i = 0; i < toRemove.length; i++) {
    const { rel, recordedHash } = toRemove[i]!;
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
      // Content re-checked too, not only the file's TYPE: the symlink check
      // above cannot see a plain edit, and the confirmation prompt between
      // the plan and this call is exactly the window one could happen in. A
      // mismatch is not suspicious the way a symlink is — it is skipped, not
      // aborted, and the run keeps going.
      if (recordedHash !== undefined) {
        const current = await readFile(onDisk(repoDir, rel));
        if (sha256(current) !== recordedHash) {
          changedSincePlanning.push(rel);
          continue;
        }
      }
      await removeFile(onDisk(repoDir, rel));
    } catch (error) {
      const stillOwed = toRemove.slice(i).map((a) => a.rel);
      return {
        removed,
        manifestRemoved: false,
        completed: [...removed],
        remaining: wouldDeleteManifest ? [...stillOwed, MANIFEST_REL] : stillOwed,
        error: (error as Error).message,
        ...(changedSincePlanning.length > 0 ? { changedSincePlanning } : {}),
      };
    }
    removed.push(rel);
    await removeEmptyParents(repoDir, rel);
  }

  const stillPreserved = !wouldDeleteManifest || changedSincePlanning.length > 0;

  // Something is still preserved and this is not a detach — the rig remains
  // installed, on purpose. The manifest is the only record naming what it
  // still owns, so it is kept even though every removal that WAS planned
  // (and still matched its recorded hash) just succeeded.
  if (!detach && stillPreserved) {
    return {
      removed,
      manifestRemoved: false,
      outcome: 'partial',
      ...(changedSincePlanning.length > 0 ? { changedSincePlanning } : {}),
    };
  }

  // Checkpoint 2: the manifest again, immediately before deleting it — the
  // window every removal above could have used. Re-checked the same
  // symlink-safe, content-verified way as checkpoint 1, not trusted from the
  // first check: this narrows the window a swap can exploit; it does not
  // close it entirely — a concurrent swap in the instant between THIS check
  // and the `unlink` call below is a residual race no check-then-act sequence
  // over the filesystem can rule out (docs/command-contract.md, "## uninstall
  // (RP-181)"). On a mismatch here the manifest is kept, never deleted, and
  // the result is an honest partial one: `completed` names every file that
  // really was removed, `remaining` names only the manifest.
  if (plan.manifestHash !== null) {
    const mismatch = await manifestMismatchReason(repoDir, plan.manifestHash);
    if (mismatch !== null) {
      return {
        removed,
        manifestRemoved: false,
        completed: [...removed],
        remaining: [MANIFEST_REL],
        error: mismatch,
        ...(changedSincePlanning.length > 0 ? { changedSincePlanning } : {}),
      };
    }
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
      ...(changedSincePlanning.length > 0 ? { changedSincePlanning } : {}),
    };
  }
  // The manifest is often the last file left in `.claude/` — its own removal
  // is what can finally empty that directory, so the same cleanup runs again
  // for it.
  await removeEmptyParents(repoDir, MANIFEST_REL);

  return {
    removed,
    manifestRemoved: true,
    outcome: detach ? 'detached' : 'uninstalled',
    ...(changedSincePlanning.length > 0 ? { changedSincePlanning } : {}),
  };
}
