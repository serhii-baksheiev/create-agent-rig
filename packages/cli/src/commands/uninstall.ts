import { lstat, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initManifest, NESTED_CLAUDE } from './init.js';
import { AGENTS_MD_RESCUE, renderedAgentsMd } from './upgrade.js';
import { hookFilesReferencedIn } from '../lib/init-settings.js';
import { ALL_LAYERS, MANIFEST_REL, parseManifest, sha256 } from '../lib/manifest.js';
import type { RigManifest } from '../lib/manifest.js';
import { MAX_PATH_SEGMENTS, exceedsMaxPathSegments, resolveInside } from '../lib/safe-path.js';
import { readBoundedFileInRepo } from '../lib/bounded-file.js';
import { locateRegion, MAX_AGENTS_MD_REGION_BYTES } from '../lib/agents-md-region.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class UninstallError extends Error {}

export type UninstallVerdict = 'remove' | 'absent' | 'preserved';

export interface UninstallAction {
  rel: string;
  verdict: UninstallVerdict;
  /** Why, for `preserved` — always set on that verdict, never on the others. */
  reason?: string;
  /**
   * An additional disclosure on an otherwise ordinary verdict (round 4,
   * blocker 2) — currently only ever set on a `remove` verdict for
   * CLAUDE.md or AGENTS.md when the OTHER of that pair is NOT a clean
   * removal (preserved as edited, or already `absent`): removing one is
   * exactly the moment the rulebook could end up with no readable copy at
   * all, and a bare `- CLAUDE.md` line does not say so. Never set on
   * `preserved` — that verdict already has `reason` for this purpose.
   */
  note?: string;
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
  /**
   * RP-256 slice 2: true only on `AGENTS.md`'s own `remove` verdict when the
   * manifest tracks it as a managed region rather than a whole file —
   * `applyUninstall` reads this to STRIP the region (write the user's own
   * prefix back) instead of unlinking the file outright, and `recordedHash`
   * means something different here too: the region BODY's hash (never the
   * marker lines), not the whole file's.
   */
  region?: boolean;
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
 * Present on every run that actually completed — EXCEPT a `--dry-run`, which
 * reaches none of these three: a preview has no end state to name, so the
 * field is left out entirely there rather than inventing a fourth value, and
 * that holds even for `noManifest` ("nothing installed" only becomes an end
 * state once a real, non-dry run has acted — or declined to act — on it).
 * Also absent whenever `error` is present — a hard failure (a symlink
 * appeared, the manifest itself went stale) is its own signal, not one of
 * these three.
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
  /**
   * Hook files a wiring file that has been edited, or replaced with a
   * symlink, SINCE `planUninstall` ran still references — discovered only at
   * apply time, because the plan itself still called the wiring pristine.
   * Present only when at least one occurred. Not removed, not a failure: the
   * run kept going, and the manifest is kept (or, under `--detach`, the path
   * is named in the handover) exactly as any other preserved hook would be.
   * `importedBy` is present exactly when `rel` was reached through another
   * protected file's own import rather than named by `wiringRel` directly —
   * see {@link hookImportedByReason}. `wiringKind` is always present — see
   * {@link WiringPreservedKind} and {@link hookStillReferencedReason} — and
   * is never `'kept'` here specifically (a `kept` wiring path is never a
   * plan-time `remove` verdict, which is what this apply-time re-check keys
   * off of). `unverifiedBecause` is present when `rel` was protected by the
   * conservative superset sweep rather than traced — see
   * {@link hookUnverifiedReason} — and takes precedence over `wiringKind`'s
   * wording exactly the way {@link protectedFileReason} decides it.
   */
  protectedHooksAtApply?: Array<{
    rel: string;
    wiringRel: string;
    wiringKind: WiringPreservedKind;
    importedBy?: string;
    unverifiedBecause?: string;
  }>;
  /**
   * Which of the three {@link UninstallOutcome}s this run reached — present
   * on every completed run EXCEPT a `--dry-run` (a preview reaches no end
   * state to name) and absent whenever `error` is present.
   */
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

/**
 * Why a path that resolves lexically inside the repo is still refused.
 * Deliberately does NOT say "(symlink)" — `regularFileStatus`'s `'unsafe'`
 * verdict also covers a directory sitting where the manifest expects a
 * plain file, a non-directory ancestor blocking the walk, and a segment
 * whose `realpath` escapes the repository regardless of how `lstat`
 * classifies it (the Windows-junction case above). A symlink is the common
 * case, not the only one this reason is used for, and naming a kind the
 * code has not actually confirmed is the same mistake `hookStillReferencedReason`
 * made hardcoding "edited" (cycle-5 review, security lens advisory 2).
 */
export const NOT_A_REGULAR_FILE_REASON =
  'not a regular file inside the repository — a symlink, a directory (or other non-file entry) ' +
  'sitting where a plain file belongs, or an ancestor whose real path leaves the repository';

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
 * Two INDEPENDENT checks run at every segment, not one: the `lstat`
 * classification (`isSymbolicLink()` / `isDirectory()` / `isFile()`) refuses
 * anything not confirmed to be a plain directory or file, AND, separately,
 * `realpath` on that same segment must still resolve inside `repoDir`. The
 * second check does not read the classification at all — it is what makes
 * the containment guarantee hold even for a reparse-point kind `lstat` does
 * not report as a symlink, whatever that kind turns out to be, rather than
 * resting on one interpretation of one field.
 *
 * ⚠ **What is and is not measured here.** This repository's own development
 * environment cannot create a Windows directory junction, so the claim above
 * — that the containment check does not depend on how `lstat` classifies
 * one — is a property of the CODE (realpath resolution is classification-
 * independent by construction), not a measurement taken on a junction.
 * `packages/cli/test/uninstall.test.ts`'s Windows-only junction tests
 * (`onlyOnWindows`) DO measure the symlink-classification branch, in the
 * `windows-e2e` CI lane only: they pin that Node/libuv reports a junction
 * through `Stats.isSymbolicLink()` on Windows the same way a real symlink is
 * — the same behaviour this repository's own ancestor-escape fixtures
 * elsewhere already rely on (`test/template/*.test.ts`'s
 * `process.platform === 'win32' ? 'junction' : 'dir'` pattern). Neither this
 * repository's tests nor its CI have ever exercised a reparse-point kind
 * `lstat().isSymbolicLink()` reports `false` for while still pointing outside
 * the repository, so no claim is made about that case beyond "the realpath
 * check would still catch it, by construction, if the target actually
 * resolves outside `repoDir`".
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
  let base: string;
  try {
    base = await realpath(repoDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
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
    const classifiedSafe = isLast
      ? !info.isSymbolicLink() && info.isFile()
      : !info.isSymbolicLink() && info.isDirectory();
    if (!classifiedSafe) return 'unsafe';
    // Classification-independent: whatever this segment reports itself as,
    // its actual target must still resolve inside the repository root.
    let resolved: string;
    try {
      resolved = await realpath(current);
    } catch {
      return 'unsafe';
    }
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return 'unsafe';
  }
  return 'ok';
  // Unreachable in practice: `segments` always has at least one element
  // (`''.split('/')` is `['']`), and every branch inside the loop above
  // returns before falling through. No trailing throw is needed here — the
  // loop's own `return 'ok'` covers every path that reaches the end of it.
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
  // A linear scan, not a regex: `/[. ]+$/` backtracks quadratically on a long
  // run of dots on some engines/inputs (measured: 400,000 dots cost 83s of
  // CPU) — availability only, nothing is removed, but a manifest is
  // committed input and a hostile one must not be able to hang a `--dry-run`.
  let end = withoutStream.length;
  while (end > 0 && (withoutStream[end - 1] === '.' || withoutStream[end - 1] === ' ')) end--;
  return withoutStream.slice(0, end).toLowerCase();
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
 *
 * Reads `initManifest()` alone — the bare `{ rel, source }` list — never
 * `initInstallSet`, which also RENDERS every template's substituted content.
 * Ownership is a question about which PATHS this release installs, not about
 * what bytes it would write there; coupling it to content rendering means a
 * destructive command's plan can fail on a template error that has nothing
 * to do with what is being deleted.
 *
 * Passes {@link ALL_LAYERS} explicitly (RP-180) rather than taking
 * `initManifest`'s own default (`DEFAULT_LAYERS`, Core only): this set is the
 * ownership BOUNDARY a `remove` verdict is held to, not a description of what
 * a plain `init` would install today. A rig that opted into the workflow
 * layer has those paths in `manifest.files` exactly like any Core path, and
 * this set has to include them or `uninstall` would report every one of them
 * "not a path this release installs" and refuse to ever remove it — a rig
 * that opted in would never be able to fully uninstall. Which layers a GIVEN
 * rig actually has is a manifest question (`manifest.files`/`manifest.kept`,
 * see `docs/decisions/workflow-layer-split.md`, "Interaction with
 * `uninstall`"), not a question this boundary answers.
 */
async function rigOwnedPaths(): Promise<Set<string>> {
  const files = await initManifest(ALL_LAYERS);
  const paths = new Set(files.map((f) => f.rel));
  // RP-256 slice 1: `initManifest`'s default is the `root` placement, so the
  // set above already has plain `CLAUDE.md`. A `nested` rig's manifest
  // carries `.claude/CLAUDE.md` instead (see `init.ts`'s `ClaudeMdPlacement`)
  // — this is the ownership BOUNDARY, not one given rig's actual layout, so
  // both possible shim paths belong in it, the same way a workflow-layer
  // path is unioned in regardless of whether THIS rig opted in.
  paths.add(NESTED_CLAUDE);
  return paths;
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
async function readManifestBytes(
  repoDir: string,
  readFileFn: (absolutePath: string) => Promise<Buffer>,
): Promise<Buffer | null> {
  const status = await regularFileStatus(repoDir, MANIFEST_REL);
  if (status === 'absent') return null;
  if (status === 'unsafe') {
    throw new UninstallError(
      `Refusing to read "${MANIFEST_REL}" — an ancestor directory is a symlink (or another ` +
        'non-regular entry), so it cannot be trusted.',
    );
  }
  return readFileFn(onDisk(repoDir, MANIFEST_REL));
}

/**
 * Matches any `.mjs` file anywhere under `.claude/hooks/` — deliberately not
 * anchored to the top level, so it also matches `.claude/hooks/lib/hook-input.mjs`.
 * Used only in the `unsafe`-wiring branch below, to seed the closure walk from
 * every owned hook path, not only the ones a readable wiring file happens to
 * name directly.
 */
const HOOK_REL_PATTERN = /^\.claude\/hooks\/.+\.mjs$/;

/**
 * A relative ESM import target inside a `.mjs` file — `from './x.mjs'` or
 * `from '../y/z.mjs'`. Only a RELATIVE specifier is ever matched (a bare one
 * names a package, not a file this rig owns), and only one ending in `.mjs` —
 * the shape every hook and lib module in this fleet's own tree uses.
 */
const RELATIVE_MJS_IMPORT = /from\s+['"](\.\.?\/[^'"]+\.mjs)['"]/g;

/**
 * WHY the wiring file protecting a hook is itself preserved — decided once
 * per wiring path, from the exact same {@link WiringTracking} distinction
 * `planUninstall`/`applyUninstall` already compute, and threaded through so
 * {@link hookStillReferencedReason} can say the true one:
 *
 * - `'edited'` — a `files`-tracked path whose current bytes no longer match
 *   the recorded hash. The rig wrote it; the user changed it since.
 * - `'kept'` — a `kept` path: `init` found it already in place and never
 *   took ownership of its bytes at all. Never "edited" by anyone this
 *   command has evidence about — it may never have matched anything the rig
 *   ever shipped.
 * - `'unsafe'` — the wiring file itself could not be safely read (a
 *   symlink, or reached through one), so its content was never compared to
 *   anything; every owned hook is protected on the strength of that alone.
 */
export type WiringPreservedKind = 'edited' | 'kept' | 'unsafe';

/**
 * Reason named when a hook file is preserved because the wiring file that
 * still calls it is itself preserved. `kind` is not decoration: a hook a
 * `kept` wiring file references was never "preserved as edited" — nobody
 * edited it, the rig never wrote it, and reusing the `'edited'` wording for
 * every kind produced a report that told two contradictory stories about the
 * SAME repository state (`.claude/settings.json` → "user-owned (kept by
 * init)"; two lines away, `guard-bash.mjs` → "referenced by
 * .claude/settings.json, which was preserved as edited"). Reproduced by
 * hand-authoring a wiring `.claude/settings.json`, running `init` over it
 * (which records it under `kept`, never `files`), then `uninstall --yes`.
 */
export function hookStillReferencedReason(wiringRel: string, kind: WiringPreservedKind): string {
  // Exhaustiveness is enforced at COMPILE time via `default`'s
  // `kind satisfies never` — not by leaving `default` off, which was tried
  // and measured to NOT work: a pre-switch runtime guard that narrows
  // `kind` down to the three known members (`if (kind !== 'edited' && …)`)
  // makes the switch exhaustive over the NARROWED type, so a fourth
  // `WiringPreservedKind` member compiled clean under `tsc --strict` with
  // that guard in place — the opposite of what its own comment claimed
  // (code-lens and security-lens review, RP-181, cycle 8). `satisfies never`
  // inside `default` narrows nothing upstream (there is nothing upstream of
  // `default` left to narrow) and fails typecheck the moment a fourth member
  // exists — verified in a sandbox built from this exact file: three
  // members compiles clean, four members raises `TS1360: Type "..." does
  // not satisfy the expected type 'never'`. The `default` RETURNS a named
  // fallback rather than throwing: this function runs from `index.ts`
  // inside `uninstallPayload`, AFTER `applyUninstall` has already deleted
  // files — a throw reachable from here would turn an unreachable-today
  // inconsistency into a post-deletion stack trace with no JSON on stdout,
  // the worst point in the whole command for that to happen. Verified in
  // the same sandbox: an unexpected `kind` at runtime returns the fallback
  // string, never throws, and never interpolates a literal `undefined`
  // into the sentence.
  let why: string;
  switch (kind) {
    case 'edited':
      why = 'which was preserved as edited';
      break;
    case 'kept':
      why = 'which init found already in place and never took ownership of';
      break;
    case 'unsafe':
      why = 'which could not be safely read (itself a symlink, or reached through one)';
      break;
    default: {
      kind satisfies never;
      return (
        `still referenced by ${wiringRel}, for a reason this version does not name — removing ` +
        'this file would leave it pointing at nothing'
      );
    }
  }
  return `still referenced by ${wiringRel}, ${why} — removing this file would leave it pointing at nothing`;
}

/**
 * Reason named when a file is preserved not because a wiring file names it
 * directly, but because a hook file that IS (directly or, itself,
 * transitively) needed by that wiring imports it. Deliberately a different
 * sentence from {@link hookStillReferencedReason}, naming the IMMEDIATE
 * importer rather than only the ultimate wiring path:
 * `.claude/scripts/lib/secrets.mjs` is never mentioned by
 * `.claude/settings.json` at all — only `.claude/hooks/guard-secret-file.mjs`
 * is — so an operator grepping `settings.json` for `secrets.mjs` to
 * understand why it survived would find nothing if this said only "still
 * referenced by .claude/settings.json"; grepping it for
 * `guard-secret-file.mjs` (this reason's `importedByRel`) finds the real
 * connection.
 *
 * Deliberately does NOT say `importedByRel` is itself directly referenced by
 * `wiringRel` — it says only that `wiringRel` needs it "directly or through
 * further imports", which stays true whether `importedByRel` is the hook a
 * wiring file names outright or itself another import one or more hops
 * removed (`.claude/hooks/lib/edit-input.mjs` imports
 * `.claude/scripts/git-env.mjs`, and neither is named in
 * `.claude/settings.json` at all). A reader who needs the next hop finds it
 * on `importedByRel`'s OWN `preserved` entry, which names what needed IT.
 */
export function hookImportedByReason(importedByRel: string, wiringRel: string): string {
  return (
    `imported by ${importedByRel}, itself needed — directly or through further imports — by ` +
    `the still-preserved ${wiringRel}, which is why it survives too. Removing this file would ` +
    `leave ${importedByRel} unable to load`
  );
}

/**
 * Reason named when a file was protected not because it was traced — as a
 * direct reference or as a genuine import — but because SOME OTHER file the
 * walk needed to read in order to keep tracing could not be read at all.
 * `unreadableRel` names that file, not `rel` itself: this file's own need
 * was never confirmed one way or the other, so it is kept purely as a
 * precaution.
 *
 * Deliberately its own, fifth wording rather than reusing
 * {@link hookStillReferencedReason}'s "still referenced by … which was
 * preserved as edited" — that sentence claims a specific, confirmed
 * connection this file does not have. Reusing it made the wording that
 * sounds MOST certain describe the files the command is LEAST sure about: in
 * one reproduced run, 84 owned paths in one preserved-wiring scenario, ~7
 * genuinely referenced by the wiring file (which the command HAD read and
 * could enumerate exactly), ~30 swept in by this precaution and reported
 * with the identical unqualified "still referenced by" sentence — including
 * a TEST FIXTURE (`.agents/skills/new-invariant/guard-invariant.example.test.mjs`)
 * no hook could ever import (UX-lens review, RP-181).
 */
/**
 * The one fixed prefix every {@link hookUnverifiedReason} string starts
 * with — exported so a caller building a roll-up summary (how many
 * `preserved` paths are genuinely traced versus kept only as a precaution)
 * can tell the two apart from the rendered reason text without a second,
 * independent guess at the wording. One string, defined once; both this
 * module and {@link isUnverifiedReason} read the SAME constant, so they
 * cannot drift apart the way two copies of a fact always eventually do.
 */
const UNVERIFIED_REASON_PREFIX = 'protected because ';

export function hookUnverifiedReason(unreadableRel: string): string {
  return (
    `${UNVERIFIED_REASON_PREFIX}${unreadableRel} could not be read, so every file this release ` +
    'installs is being kept rather than risk removing one it needs'
  );
}

/**
 * True when `reason` is exactly the shape {@link hookUnverifiedReason}
 * produces — used only to build a roll-up summary in the CLI (how many
 * `preserved` paths were genuinely traced versus kept only as a
 * precaution), never to decide protection itself, which has already
 * happened by the time anything calls this.
 */
export function isUnverifiedReason(reason: string): boolean {
  return reason.startsWith(UNVERIFIED_REASON_PREFIX);
}

/**
 * The ONE reason a protected hook or dependency reports, decided by which
 * evidence for its protection actually exists — centralised so
 * `planUninstall` and the apply-time re-check (through `index.ts`, which
 * carries the same three pieces of evidence across the process boundary in
 * `ApplyUninstallResult.protectedHooksAtApply`) cannot describe the same
 * fact two different ways. Precedence, strongest evidence first: a genuine
 * import trace (`importedByRel`) beats mere caution (`unverifiedBecause`)
 * beats a bare direct reference — a file can end up with more than one kind
 * of evidence over the life of a walk (a precaution sweep can catch a path
 * before a LATER, genuine import trace reaches the same one), and the
 * strongest one is what gets reported.
 */
export function protectedFileReason(
  wiringRel: string,
  wiringKind: WiringPreservedKind,
  importedByRel: string | undefined,
  unverifiedBecause: string | undefined,
): string {
  if (importedByRel !== undefined) return hookImportedByReason(importedByRel, wiringRel);
  if (unverifiedBecause !== undefined) return hookUnverifiedReason(unverifiedBecause);
  return hookStillReferencedReason(wiringRel, wiringKind);
}

/**
 * `seedRel` plus everything it (transitively) imports that is itself one of
 * `ownedPaths` — each one added to `protectedHooks` under `wiringRel`, and
 * (for everything except `seedRel` itself) to `importedBy` under whichever
 * file's import target resolved to it, mutating all four maps in place.
 * `unverified` maps a path this pass protected WITHOUT tracing it — see
 * {@link hookUnverifiedReason} — to the file whose own unreadability
 * triggered the sweep that caught it.
 *
 * A directly-wired hook file (`.claude/hooks/guard-bash.mjs`) is not
 * self-contained: it imports `.claude/hooks/lib/hook-input.mjs`,
 * `.claude/scripts/lib/shell-tools.mjs`, `.claude/scripts/stop-flag.mjs` — its
 * own dependencies, which are themselves owned paths a manifest can mark
 * `remove` on their own account. `hookFilesReferencedIn`/{@link HOOK_REL_PATTERN}
 * only ever name the hook files a wiring file calls DIRECTLY; without this
 * walk, a preserved `.claude/settings.json` protects `guard-bash.mjs` itself
 * but not what it imports, and the removal loop deletes `hook-input.mjs` out
 * from under it. `guard-bash.mjs` then dies at module resolution with exit 1
 * on every call — a `PreToolUse` hook that exits non-2 is non-blocking, so
 * the Never tier, the credential guard, `block-no-verify` and the kill switch
 * all go silently inert while `.claude/settings.json` still wires them. This
 * is `safe-path.ts`'s "a brake that looks installed and is not".
 *
 * **Every real READ is gated by {@link regularFileStatus}**, the identical
 * symlink-safe check every other read in this file gets — `onDisk` alone is
 * purely lexical and does not stop a `readFile` from opening whatever the
 * path resolves to. A `.claude/hooks/guard-bash.mjs` swapped for a symlink to
 * `/dev/zero` (or any other unbounded or blocking special file), with the
 * wiring that references it also modified, would otherwise make `readFile`
 * itself hang or exhaust the heap — reachable from a hostile committed
 * manifest through nothing worse than `git clone`, before consent, and
 * fatal to the "`--json` prints exactly one object" promise either way.
 * `protectedHooks.set` already ran for `rel` a line above, so THAT file
 * stays protected regardless of its own status. What that alone cannot do
 * is discover what an unreadable `rel` itself imports — `visited` has
 * already been marked, so nothing else in the walk will try again either.
 *
 * ⚠ **Only `status === 'unsafe'` triggers the superset sweep below —
 * `'absent'` does not, and that distinction is load-bearing, not an
 * oversight.** An earlier version of this function swept on ANY
 * `!== 'ok'` status, `'absent'` included — measured cost: deleting one
 * ordinary, already-uninstalled-by-hand hook file (`block-no-verify.mjs`),
 * with the wiring referencing it preserved, turned 83 planned removals into
 * 40 planned / 43 preserved, on a repository that had done nothing more
 * hostile than turn a hook off. And nothing is bought by sweeping on
 * absence: a file that is not there cannot fail module resolution over an
 * import it cannot make, because the module that would need that import is
 * itself gone. The whole justification for the sweep — a file we cannot
 * READ might import something we cannot discover — simply does not apply to
 * a file that does not exist (code-lens review, RP-181).
 *
 * An earlier version of the `'unsafe'` branch stopped at protecting `rel`
 * alone, on the reasoning that every `.claude/scripts/` dependency the walk
 * needs to reach is also imported by at least one OTHER, ordinarily-readable
 * hook. That reasoning was checked against the shipped import graph and
 * found false: `.claude/scripts/lib/secrets.mjs` has exactly ONE seeder
 * (`guard-secret-file.mjs`), and `.claude/scripts/unattended-flag.mjs` has
 * exactly one (`guard-rulebook.mjs`) — reproduced end to end through a real
 * `git commit` (mode `120000`) and a fresh `git clone`: symlink the sole
 * seeder, preserve the wiring that references it, and `secrets.mjs` survived
 * the uninstall while its only importer died at module resolution, silently
 * inert (security-lens review, RP-181). So the `'unsafe'` branch below does
 * not stop at `rel` alone: it protects the conservative superset — every
 * owned `.mjs` path — the same move `protectedHooksFor` already makes one
 * level up for an unreadable WIRING file, recording each newly-swept path
 * into `unverified` rather than claiming it as confirmed. "Protecting too
 * many is the safe direction" is the same doctrine either way; only where
 * it gets applied, and how honestly it gets reported, changed.
 *
 * Bounded, per `.claude/rules/invariants.md`'s fail-open rule, but precisely:
 * no recursion, and every REAL read happens at most once per owned path —
 * `visited` is checked before reading, and only a resolved import target
 * already IN `ownedPaths` is ever pushed, so a file this release does not
 * ship is never opened. What is NOT bounded by `|ownedPaths|` is transient
 * `queue` length: `!visited.has(resolved)` is checked at PUSH time, and two
 * different files can each name the same not-yet-popped dependency before
 * either is processed, queuing it more than once. Each duplicate costs one
 * cheap pop-and-skip, never a second read — pinned, not merely asserted (see
 * `.claude/rules/invariants.md`, "State the limits — and test them"), by
 * `packages/cli/test/uninstall.test.ts` › "reads each file once however
 * many duplicate imports name the same owned dependency".
 */
async function protectHookAndDeps(
  repoDir: string,
  ownedPaths: ReadonlySet<string>,
  seedRel: string,
  wiringRel: string,
  protectedHooks: Map<string, string>,
  visited: Set<string>,
  importedBy: Map<string, string>,
  unverified: Map<string, string>,
  readFileFn: (absolutePath: string) => Promise<Buffer>,
  walkedBytes: Map<string, Buffer>,
): Promise<void> {
  // `[rel, parent]` — `parent` is the file whose import target resolved to
  // `rel`, or `undefined` for `seedRel` itself (a wiring file names it
  // directly; nothing imported it to get here). Recorded into `importedBy`
  // only the FIRST time `rel` is reached, mirroring `protectedHooks`'s own
  // `!has` guard just below — so a file reachable two different ways keeps
  // whichever path found it first, for a reason string that names one real
  // connection rather than every one that happens to exist.
  const queue: Array<[string, string | undefined]> = [[seedRel, undefined]];
  while (queue.length > 0) {
    const [rel, parent] = queue.pop()!;
    if (visited.has(rel)) continue;
    visited.add(rel);
    // `rel` was REACHED — named by a wiring file, or resolved from another
    // file's import — so it is traced, whatever its own status turns out to
    // be, and is never merely "unverified". Together with the sweep's own
    // `!visited.has(owned)` below this makes the wording independent of the
    // order the seeds arrive in: a sweep that ran BEFORE `rel`'s turn is
    // undone here, and one that runs AFTER it never marks `rel` at all.
    // Clearing only on a readable pop (the cycle-8 fix) closed the first
    // half alone — an unreadable seed anywhere but first in the wiring
    // file's text order still re-marked every hook already confirmed
    // (code-, security- and UX-lens review, RP-181, cycle 9).
    unverified.delete(rel);
    if (!protectedHooks.has(rel)) protectedHooks.set(rel, wiringRel);
    if (parent !== undefined && !importedBy.has(rel)) importedBy.set(rel, parent);
    const status = await regularFileStatus(repoDir, rel);
    // `'absent'` buys the sweep below nothing: a file that is not there has
    // no imports that can fail to resolve, because the module that would
    // make them is itself gone (code-lens review, RP-181). Only `'unsafe'`
    // — unreadable, not merely missing — triggers it.
    if (status === 'absent') continue;
    if (status === 'unsafe') {
      for (const owned of ownedPaths) {
        if (!owned.endsWith('.mjs')) continue;
        if (!protectedHooks.has(owned)) protectedHooks.set(owned, wiringRel);
        // First unreadable file to sweep a given path names the reason;
        // never overwritten by a later sweep, never planted on a path some
        // walk already reached, and cleared the moment one does (above).
        if (!visited.has(owned) && !importedBy.has(owned) && !unverified.has(owned)) {
          unverified.set(owned, rel);
        }
      }
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFileFn(onDisk(repoDir, rel));
    } catch {
      continue; // gone, or unreadable — nothing further to walk from here
    }
    // Recorded only on a SUCCESSFUL read, keyed by `rel` — so the per-file
    // loop in `planUninstall` below can reuse these exact bytes instead of
    // reading `rel` a second time, while a path whose read failed here
    // (caught above) is deliberately left out: the per-file loop must still
    // attempt that read itself and let a real failure (EACCES) reject the
    // whole plan, exactly as it always has for any other owned file — see
    // `packages/cli/test/uninstall.test.ts` › "never lets an owned
    // dependency be removed when its only protecting seeder is unreadable".
    walkedBytes.set(rel, bytes);
    const text = bytes.toString('utf8');
    const dir = path.posix.dirname(rel);
    for (const match of text.matchAll(RELATIVE_MJS_IMPORT)) {
      const resolved = path.posix.normalize(path.posix.join(dir, match[1]!));
      if (ownedPaths.has(resolved) && !visited.has(resolved)) queue.push([resolved, rel]);
    }
  }
}

/**
 * Hook files a wiring file that will end up PRESERVED (not removed) still
 * references, keyed by the hook's own `rel` and naming which wiring file
 * protects it — plus the wiring bytes this pass already read for an `'ok'`
 * wiring file, so a caller that goes on to decide THAT wiring file's own
 * verdict never reads and hashes it a second time.
 *
 * Computed as its own pass, before the main per-file loop that calls it —
 * deciding a hook file's own verdict from a single alphabetical pass over
 * `manifest.files` would process it before its wiring file's preserved
 * status was even known, since a wiring path (`.claude/settings.json`) sorts
 * AFTER the hook files it references (`.claude/hooks/*.mjs`).
 *
 * `recordedHashFor` abstracts over WHERE the recorded hash comes from, so
 * this one pass serves both callers: `planUninstall` asks the manifest
 * directly; `applyUninstall` calls this a SECOND time, asking the plan's own
 * `remove`-verdict actions instead, to catch a wiring file that was still
 * pristine when `planUninstall` ran this same pass but has since been
 * edited or replaced with a symlink — the window a confirmation prompt sits
 * in, and hook files sort ahead of the wiring that references them, so the
 * removal loop would otherwise unlink them before ever re-examining it.
 *
 * A wiring file this command cannot safely READ (`status === 'unsafe'` —
 * itself a symlink, or reached through one) still gets its hooks protected:
 * every owned hook path {@link HOOK_REL_PATTERN} matches, not a computed
 * subset, because reading an unsafe entry to learn exactly which hooks it
 * names is precisely what `regularFileStatus` exists to refuse. Protecting
 * too many hooks is the safe direction; protecting too few — leaving a
 * settings file the run kept pointing at a hook it just deleted — is the bug
 * this exists to close. Each matched hook is also run through
 * {@link protectHookAndDeps}: `HOOK_REL_PATTERN` only reaches paths under
 * `.claude/hooks/`, and a hook's own dependencies reach across that boundary
 * into `.claude/scripts/` (`stop-flag.mjs`, `unattended-flag.mjs`, …) — the
 * pattern alone does not, and cannot, name those.
 *
 * `trackingFor` — not a bare hash lookup — because a wiring path can be
 * PRESERVED for two structurally different reasons, and only one of them has
 * a hash to compare against. A `files` entry (or, at apply time, a plan-time
 * `remove` verdict) is preserved only when its CURRENT bytes no longer match
 * the recorded one — a pristine match means it is about to be removed, so
 * there is nothing downstream to protect on its account. A `kept` entry
 * (`init` found the wiring file already in place and never took ownership of
 * its bytes: `packages/cli/src/commands/init.ts`'s `kept` map, `README.md`'s
 * "starts from an existing repository" path) is preserved UNCONDITIONALLY —
 * `planUninstall`'s own `kept` loop below never checks its hash at all — so
 * there is no pristine case for it to fall into, ever, and comparing it
 * against a hash that does not exist for this purpose would just mean
 * `undefined`, which used to make this whole pass skip the wiring path
 * entirely: a `kept` `.claude/settings.json` protected NONE of its hooks,
 * silently, on the single most ordinary path into this rig — a repository
 * that already had one before `init` ran.
 */
interface WiringTracked {
  tracked: true;
  /** No hash to compare — this wiring path is preserved no matter its bytes. */
  alwaysPreserved: boolean;
  /** Only meaningful when `alwaysPreserved` is false. */
  recordedHash?: string;
}
type WiringTracking = WiringTracked | { tracked: false };

async function protectedHooksFor(
  repoDir: string,
  ownedPaths: ReadonlySet<string>,
  trackingFor: (wiringRel: string) => WiringTracking,
  readFileFn: (absolutePath: string) => Promise<Buffer>,
): Promise<{
  protectedHooks: Map<string, string>;
  /** The immediate importer of a transitively-protected path — absent for a path a wiring file names directly. See {@link hookImportedByReason}. */
  importedBy: Map<string, string>;
  /** A path protected without being traced, mapped to the file whose own unreadability triggered the sweep that caught it. See {@link hookUnverifiedReason}. */
  unverified: Map<string, string>;
  /** Why the wiring path named in `protectedHooks` is itself preserved, keyed by the WIRING path (not the protected hook). See {@link WiringPreservedKind}. */
  wiringKind: Map<string, WiringPreservedKind>;
  wiringBytes: Map<string, Buffer>;
  /** Bytes `protectHookAndDeps` already read while walking a hook's imports, keyed by the hook's own `rel` — reused by `planUninstall`'s per-file loop so a hook this walk successfully read is never read a second time. */
  walkedBytes: Map<string, Buffer>;
}> {
  const protectedHooks = new Map<string, string>();
  const importedBy = new Map<string, string>();
  const unverified = new Map<string, string>();
  const wiringKind = new Map<string, WiringPreservedKind>();
  const wiringBytes = new Map<string, Buffer>();
  const walkedBytes = new Map<string, Buffer>();
  const visited = new Set<string>();
  for (const wiringRel of WIRING_PATHS) {
    const tracking = trackingFor(wiringRel);
    if (!tracking.tracked || !ownedPaths.has(wiringRel)) continue;
    const status = await regularFileStatus(repoDir, wiringRel);
    if (status === 'absent') continue;
    if (status === 'unsafe') {
      wiringKind.set(wiringRel, 'unsafe');
      for (const rel of ownedPaths) {
        if (HOOK_REL_PATTERN.test(rel)) {
          await protectHookAndDeps(
            repoDir,
            ownedPaths,
            rel,
            wiringRel,
            protectedHooks,
            visited,
            importedBy,
            unverified,
            readFileFn,
            walkedBytes,
          );
        }
      }
      continue;
    }
    const current = await readFileFn(onDisk(repoDir, wiringRel));
    wiringBytes.set(wiringRel, current);
    // pristine and NOT always-preserved — it is about to be removed, so
    // nothing downstream needs protecting on its account. A `kept` wiring
    // path never takes this branch: `alwaysPreserved` is true for it
    // unconditionally, hash or no hash.
    if (!tracking.alwaysPreserved && sha256(current) === tracking.recordedHash) continue;
    wiringKind.set(wiringRel, tracking.alwaysPreserved ? 'kept' : 'edited');
    for (const hook of hookFilesReferencedIn(current.toString('utf8'))) {
      await protectHookAndDeps(
        repoDir,
        ownedPaths,
        hook,
        wiringRel,
        protectedHooks,
        visited,
        importedBy,
        unverified,
        readFileFn,
        walkedBytes,
      );
    }
  }
  return { protectedHooks, importedBy, unverified, wiringKind, wiringBytes, walkedBytes };
}

export interface PlanUninstallOptions {
  /**
   * Test seam: replaces the function that reads one file's content. Real
   * runs never pass this — it exists so a test can count reads (never a
   * mocking framework, no patching of module internals) without changing
   * `planUninstall`'s own behaviour, since the default still delegates to
   * `node:fs/promises`' `readFile`.
   */
  readFile?: (absolutePath: string) => Promise<Buffer>;
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
export async function planUninstall(
  repoDir: string,
  options: PlanUninstallOptions = {},
): Promise<UninstallPlan> {
  const readFileFn = options.readFile ?? readFile;
  const raw = await readManifestBytes(repoDir, readFileFn);
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
  const ownedPaths = await rigOwnedPaths();
  // A `kept` wiring path is tracked too, not just a `files` one —
  // `refuseFilesKeptOverlap` above already guarantees the same `rel` never
  // appears in both, so there is no ambiguity about which case applies.
  const trackingFor = (wiringRel: string): WiringTracking => {
    if (Object.hasOwn(manifest.kept ?? {}, wiringRel)) {
      return { tracked: true, alwaysPreserved: true };
    }
    const recordedHash = manifest.files[wiringRel];
    return recordedHash === undefined
      ? { tracked: false }
      : { tracked: true, alwaysPreserved: false, recordedHash };
  };
  const { protectedHooks, importedBy, unverified, wiringKind, wiringBytes, walkedBytes } =
    await protectedHooksFor(repoDir, ownedPaths, trackingFor, readFileFn);

  const actions: UninstallAction[] = [];
  for (const rel of Object.keys(manifest.files).sort()) {
    const recorded = manifest.files[rel]!;
    // Checked BEFORE `onDisk` — and so before `onDisk`'s own message, which
    // reads "resolves outside <repoDir>" and would be FALSE for a path this
    // deep, since it never leaves the repository lexically at all. Every
    // path this release actually owns is nowhere near this deep (pinned in
    // `safe-path.test.ts`), so a key past the cap can never have been one of
    // them regardless — reported the same honest, non-aborting way as any
    // other unowned path, with a reason that names the real limit instead of
    // a false one. This does not weaken the `..`/absolute escape check right
    // below: THAT check still aborts the whole run for a genuinely escaping
    // key, exactly as before; a too-deep key is refused by never reaching
    // that check at all, and it is never read, hashed, or written either way
    // — the depth cap and the escape check are independent safety nets, not
    // substitutes for each other.
    if (exceedsMaxPathSegments(rel)) {
      actions.push({
        rel,
        verdict: 'preserved',
        reason:
          `more than ${MAX_PATH_SEGMENTS} path segments — deeper than any path this release ` +
          'installs, so it is refused without being resolved on disk at all; if this key is ' +
          `not one you recognise, remove it from ${MANIFEST_REL} by hand`,
      });
      continue;
    }
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
    // is a regular file — safe to read and to hash. Read for EVERY owned
    // file here, protected hooks included, before any branch below decides
    // what kind of file this is — matching master's read-then-branch order
    // exactly, so a hook this release cannot read (EACCES) rejects the whole
    // plan the same way an unreadable wiring file or unowned file would,
    // rather than silently falling through to "preserved" without ever
    // having been read (RP-245 round 2, code-reviewer r1: moving this read
    // behind the `protectingWiring` branch let an unreadable protected hook's
    // own dependency, reachable only through it, fall through to an ordinary
    // hash comparison and report `remove`; see
    // `packages/cli/test/uninstall.test.ts` › "never lets an owned
    // dependency be removed when its only protecting seeder is unreadable").
    // The bytes may already have been read once — by `protectedHooksFor`
    // itself for a wiring file, or by `protectHookAndDeps`'s own walk for a
    // hook it successfully traced — and reused here rather than read twice;
    // only a path neither of those already read (including one whose read
    // there failed and was caught) is actually read again, right here.
    const current =
      wiringBytes.get(rel) ?? walkedBytes.get(rel) ?? (await readFileFn(onDisk(repoDir, rel)));

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
        // `wiringKind` is set for `protectingWiring` in the SAME iteration
        // of `protectedHooksFor` that populated `protectedHooks` with
        // `rel` — never independently, so this can only be `undefined` if
        // the two maps disagreed with each other, which would itself be
        // the bug to fix.
        reason: protectedFileReason(
          protectingWiring,
          wiringKind.get(protectingWiring)!,
          importedBy.get(rel),
          unverified.get(rel),
        ),
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

  // RP-256 slice 2: a managed region is neither a whole rig-owned file (the
  // `files` loop above) nor a whole user-owned one (`kept`) — it is a mix,
  // so it gets its own verdict, decided the same way as an ordinary file:
  // intact and unedited (the region body's hash still matches what the
  // manifest vouches for) is `remove` (meaning STRIP, not delete — see
  // {@link UninstallAction.region}); anything else — missing, malformed, or
  // edited since — is `preserved`, and the user's bytes are left exactly as
  // they are. Read through the same FIFO-safe, bounded, containment-checked
  // mechanics `init.ts`/`upgrade.ts` use for this very file
  // ({@link readBoundedFileInRepo}).
  for (const rel of Object.keys(manifest.regions ?? {}).sort()) {
    const recordedHash = manifest.regions![rel]!;
    if (rel !== 'AGENTS.md') {
      // No other path is ever region-tracked today; a manifest naming one is
      // either from a future release or hand-edited — either way, safest as
      // an ordinary preserved path rather than guessed at.
      actions.push({
        rel,
        verdict: 'preserved',
        reason: 'a managed region this release does not recognise',
      });
      continue;
    }
    if (exceedsMaxPathSegments(rel)) {
      actions.push({
        rel,
        verdict: 'preserved',
        reason: `more than ${MAX_PATH_SEGMENTS} path segments — refused without being resolved on disk at all`,
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
    const current = await readBoundedFileInRepo(
      repoDir,
      onDisk(repoDir, rel),
      MAX_AGENTS_MD_REGION_BYTES,
    );
    const located = current === null ? null : locateRegion(current.toString('utf8'));
    if (located === null || sha256(located.body) !== recordedHash) {
      actions.push({
        rel,
        verdict: 'preserved',
        reason:
          current === null
            ? 'too large, not a plain file, or resolves outside the repo — the managed region ' +
              'cannot be verified; left untouched'
            : located === null
              ? 'the managed region markers are missing or malformed — left untouched'
              : 'the managed region was edited since it was installed — treated as yours',
      });
      continue;
    }
    actions.push({ rel, verdict: 'remove', recordedHash, region: true });
  }

  // Round 4, blocker 2 (CLI-UX): removing one of CLAUDE.md/AGENTS.md while
  // the other is not a clean removal — preserved as the user's own edit, or
  // already gone — is exactly the moment the rulebook could end up with no
  // readable copy left at all. `upgrade` already narrates the held-back half
  // of this same situation (`heldBack`); `uninstall` did not narrate its
  // own half at all. `init` refuses outright over a pre-existing CLAUDE.md
  // or AGENTS.md (the `MAPS` special case), so neither ever appears under
  // `manifest.kept` — both are always decided by the loop above, never here.
  // RP-256 slice 1: on a `nested` rig, root CLAUDE.md is never the rig's own
  // copy of the rulebook — it is the user's, recorded only under `kept`
  // (always `preserved`, never the rig-owned sibling AGENTS.md pairs with).
  // The nested shim at `.claude/CLAUDE.md` plays that role instead, so the
  // pair check below has to look at THAT path once the manifest says the
  // rig went nested.
  const claudeMapRel = Object.hasOwn(manifest.files, NESTED_CLAUDE) ? NESTED_CLAUDE : 'CLAUDE.md';
  const claudeAction = actions.find((a) => a.rel === claudeMapRel);
  const agentsAction = actions.find((a) => a.rel === 'AGENTS.md');
  // Round 5 advisory: the `undefined` case previously said "is not tracked
  // by this rig", which reads as "is absent" — it is not. `undefined` here
  // only ever means the manifest never named this path (an old, pre-RP-186
  // manifest missing an entry the current install set always has); the file
  // itself may well be sitting right there. Checked directly rather than
  // guessed at, so the wording says what is actually true.
  const siblingState = async (a: UninstallAction | undefined, rel: string): Promise<string> => {
    if (a !== undefined) {
      return a.verdict === 'absent'
        ? 'is already gone'
        : `stays as yours (${a.reason ?? 'edited'})`;
    }
    const status = await regularFileStatus(repoDir, rel);
    return status === 'absent' ? 'is already gone' : 'exists and is yours (untracked by this rig)';
  };
  const notACleanRemoval = (a: UninstallAction | undefined): boolean =>
    a === undefined || a.verdict === 'preserved' || a.verdict === 'absent';
  // RP-256 slice 2: a `'remove'` verdict on AGENTS.md is not always a clean
  // disappearance the way it always was pre-slice-2 — `region: true` means
  // STRIP the managed region, never delete the file (`uninstall.ts`'s own
  // per-file loop, `planUninstall`'s region pass above). `notACleanRemoval`
  // deliberately still reads ANY `'remove'` as clean (slice 1's own pairing
  // stays correct for the ordinary whole-file case), so this is a THIRD,
  // separate condition: the shim genuinely vanishes while AGENTS.md survives
  // with its rulebook content gone — neither "already gone" nor "exists and
  // is yours" (both are false of a stripped-but-present file) describes it,
  // so it gets its own wording rather than reusing `siblingState`.
  const agentsRegionSurvivesStripped =
    agentsAction?.verdict === 'remove' && agentsAction.region === true;
  if (claudeAction?.verdict === 'remove' && notACleanRemoval(agentsAction)) {
    claudeAction.note =
      `this is the rig's own ${claudeMapRel} — removing it leaves AGENTS.md, which ` +
      `${await siblingState(agentsAction, 'AGENTS.md')}, as the only rulebook copy`;
  } else if (claudeAction?.verdict === 'remove' && agentsRegionSurvivesStripped) {
    claudeAction.note =
      `this is the rig's own ${claudeMapRel} — removing it while AGENTS.md's own managed ` +
      'region is stripped in this same run leaves no readable rulebook copy anywhere; ' +
      'AGENTS.md itself is kept, with the region gone';
  }
  if (agentsAction !== undefined && agentsAction.verdict === 'remove') {
    if (notACleanRemoval(claudeAction)) {
      agentsAction.note =
        `this is the rig's own AGENTS.md — removing it leaves ${claudeMapRel}, which ` +
        `${await siblingState(claudeAction, claudeMapRel)}, as the only rulebook copy`;
    } else if (agentsRegionSurvivesStripped && claudeAction?.verdict === 'remove') {
      agentsAction.note =
        `this run strips the AGENTS.md managed region — with the rig's own ${claudeMapRel} ` +
        'also being removed, no readable rulebook copy is left anywhere; AGENTS.md itself is ' +
        'kept, with the region gone';
    }
  }

  // Round 4, blocker 1 (round 5: shares `renderedAgentsMd` with `upgrade.ts`
  // — one implementation of "is this the current rendering", not two that
  // could drift apart): the sibling `upgrade` writes when CLAUDE.md's shim
  // is genuinely held back (`AGENTS_MD_RESCUE`, never recorded in the
  // manifest) is invisible to the loop above — it only ever walks
  // `manifest.files`/`manifest.kept`. Decided the same way as everything
  // else here: rig-owned (removable) only when its bytes are EXACTLY what
  // this release would render for THIS project right now; anything else is
  // the user's, left alone and reported as preserved. Round 5 advisory:
  // annotated in every state, not only `preserved` — a bare `remove` line
  // said nothing about why removing an UNTRACKED path was safe.
  const rescueStatus = await regularFileStatus(repoDir, AGENTS_MD_RESCUE);
  if (rescueStatus === 'unsafe') {
    actions.push({
      rel: AGENTS_MD_RESCUE,
      verdict: 'preserved',
      reason: NOT_A_REGULAR_FILE_REASON,
    });
  } else if (rescueStatus === 'ok') {
    const rescueBytes = await readFileFn(onDisk(repoDir, AGENTS_MD_RESCUE));
    const rendered = await renderedAgentsMd(manifest.project, manifest.layers ?? ALL_LAYERS);
    if (rendered !== null && sha256(rescueBytes) === sha256(Buffer.from(rendered, 'utf8'))) {
      actions.push({
        rel: AGENTS_MD_RESCUE,
        verdict: 'remove',
        recordedHash: sha256(rescueBytes),
        note: 'byte-identical to what this release renders for AGENTS.md right now — safe to remove, and never recorded in the manifest as rig-owned',
      });
    } else {
      actions.push({
        rel: AGENTS_MD_RESCUE,
        verdict: 'preserved',
        reason: "not this release's current rendered AGENTS.md — treated as yours",
      });
    }
  }
  // 'absent': nothing to report — this path was never rig-owned, so "not
  // there" is simply not there, same as any other path this release never
  // installs.

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
  let base: string;
  try {
    base = await realpath(repoDir);
  } catch {
    return false;
  }
  let current = repoDir;
  for (const segment of relDir.split('/')) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return false;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    // Classification-independent, the same second check `regularFileStatus`
    // makes and for the same reason: whatever `lstat` classifies this
    // segment as, its actual target must still resolve inside the
    // repository root.
    let resolved: string;
    try {
      resolved = await realpath(current);
    } catch {
      return false;
    }
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return false;
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
    raw = await readManifestBytes(repoDir, readFile);
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
  if (plan.noManifest) {
    // `outcome` names one of three end states a REAL run reached; `--dry-run`
    // never reaches one, including here — "nothing installed" is only an end
    // state once a real run has (not) acted on it. See `UninstallOutcome`.
    return options.dryRun === true
      ? { removed: [], manifestRemoved: false }
      : { removed: [], manifestRemoved: false, outcome: 'uninstalled' };
  }

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

  // Re-derived here, not trusted from the plan's own (already-baked-in)
  // per-file verdicts: a wiring file that was still pristine when
  // `planUninstall` ran can have been edited, or replaced with a symlink, in
  // the window since — the confirmation prompt sits in exactly that window —
  // and hook files sort ahead of the wiring that references them, so the
  // removal loop below would otherwise unlink them before ever re-examining
  // it. `toRemove` is where a wiring path's recorded hash comes from here:
  // present only when the PLAN called it `remove` (pristine, `files`-tracked,
  // at plan time), which is exactly the case this re-check exists to catch.
  // A `kept` wiring path is never in `toRemove` — `planUninstall`'s own
  // `kept` loop always calls it `preserved`, unconditionally, so its hooks
  // were already protected by the PLAN-TIME call to `protectedHooksFor`
  // above, and this second pass has nothing further to do on its account.
  //
  // `wiringBytes` is deliberately NOT taken from this call: it is the read
  // this pass itself performs of a wiring file's bytes, at the SAME
  // too-early point in time the comment below explains — reusing it at the
  // removal site would just reintroduce the bug this apply-time re-check
  // exists to close.
  const ownedPaths = await rigOwnedPaths();
  const applyTimeTrackingFor = (wiringRel: string): WiringTracking => {
    const recordedHash = toRemove.find((a) => a.rel === wiringRel)?.recordedHash;
    return recordedHash === undefined
      ? { tracked: false }
      : { tracked: true, alwaysPreserved: false, recordedHash };
  };
  const {
    protectedHooks: applyTimeProtectedHooks,
    importedBy: applyTimeImportedBy,
    unverified: applyTimeUnverified,
    wiringKind: applyTimeWiringKind,
  } = await protectedHooksFor(repoDir, ownedPaths, applyTimeTrackingFor, readFile);

  // ⚠ Boundary that `index.ts`'s own outer try/catch around this whole
  // function relies on: nothing above this line has removed anything, and
  // nothing above this line is inside a try/catch of its own — an exception
  // from `rigOwnedPaths()` or the apply-time `protectedHooksFor` pass above
  // propagates uncaught, and the caller is entitled to assume `removed: []`
  // when that happens. From here down, every per-file removal is wrapped in
  // ITS OWN try/catch (immediately below) and this function always RETURNS a
  // result — real `removed` so far included — rather than throwing. Adding a
  // throwing call inside or after this loop without also updating it to
  // return, not throw, would make that caller's `removed: []` a lie.
  const removeFile = options.removeFile ?? ((absolutePath: string) => unlink(absolutePath));
  const removed: string[] = [];
  const changedSincePlanning: string[] = [];
  const protectedHooksAtApply: Array<{
    rel: string;
    wiringRel: string;
    wiringKind: WiringPreservedKind;
    importedBy?: string;
    unverifiedBecause?: string;
  }> = [];
  for (let i = 0; i < toRemove.length; i++) {
    const { rel, recordedHash, region } = toRemove[i]!;

    const protectingWiring = applyTimeProtectedHooks.get(rel);
    if (protectingWiring !== undefined) {
      // Discovered only now: the plan said `remove`, but the wiring file
      // that still calls this hook has since been edited or become a
      // symlink. Skipped, never removed, reported loudly — this is not a
      // silent exit 0. Never `'kept'` here specifically: `applyTimeTrackingFor`
      // above only ever tracks a path that was a plan-time `remove` verdict,
      // and a `kept` path is never one — ordinarily its hooks were already
      // protected by the PLAN-TIME call, using the manifest's OWN `kept`
      // membership, which this re-check does not consult at all. ⚠ Not an
      // invariant in the one case this re-check exists FOR, though: a `kept`
      // wiring path that was genuinely ABSENT at plan time (nothing to read,
      // so the plan-time pass protected nothing on its account) and then
      // reappears, rewired, in the confirmation-prompt window is exactly the
      // "changed since planning" shape this whole apply-time pass was built
      // to catch — and it is not caught here, because this pass is keyed off
      // `toRemove`, which a `kept` path is never in. Narrow, and no worse
      // than the pre-existing state (a hook this rig never removes anyway
      // stays exactly as absent-or-present as it already was), but stated
      // here rather than left implied.
      //
      // ⚠ A second, sibling gap, this one for an EDITED (not `kept`) wiring
      // file specifically (security-lens review, RP-181, cycle 8): if a
      // hook a preserved-as-edited wiring file names is genuinely ABSENT at
      // plan time, its single-seeded dependency is never swept (correctly — an absent
      // file has nothing to protect a dependency on behalf of), and that
      // dependency gets an ordinary `remove` verdict. If the hook then
      // REAPPEARS — as a symlink, or as a legitimate working file that
      // needs it — in the confirmation-prompt window before apply, nothing
      // re-examines it: this whole pass only re-derives protection for a
      // wiring path that was itself a plan-time `remove` verdict, and an
      // EDITED wiring file never is one. The dependency is removed on
      // schedule. Judged materially weaker than the hole this apply-time
      // re-check exists to close (that one needed only a symlink committed
      // and surviving `git clone`; this one needs WRITE ACCESS to the
      // working tree in the narrow window between the plan being shown and
      // `--yes` being answered) and left as a documented limitation rather
      // than grown into this change: closing it would mean re-deriving
      // apply-time protection for every wiring path unconditionally, not
      // only ones already known to be plan-time `remove` verdicts, which is
      // a wider change than this cycle's fix earns. The same end state also
      // needs no window at all — hand-delete the hook, uninstall, restore the
      // hook from git — and `docs/command-contract.md` says so beside this
      // limitation rather than letting "needs write access" read as its bound.
      const importer = applyTimeImportedBy.get(rel);
      const unverifiedBecause = applyTimeUnverified.get(rel);
      protectedHooksAtApply.push({
        rel,
        wiringRel: protectingWiring,
        // `applyTimeWiringKind` is set for `protectingWiring` in the SAME
        // iteration of `protectedHooksFor` that populated
        // `applyTimeProtectedHooks` with `rel` — never independently, so
        // this can only be `undefined` if the two maps disagreed with each
        // other, which would itself be the bug to fix (the same reasoning
        // as the plan-time assertion above).
        wiringKind: applyTimeWiringKind.get(protectingWiring)!,
        ...(importer !== undefined ? { importedBy: importer } : {}),
        ...(unverifiedBecause !== undefined ? { unverifiedBecause } : {}),
      });
      continue;
    }

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
      //
      // Read FRESH here, never from `wiringBytes` — that cache was filled by
      // `protectedHooksFor` BEFORE this removal loop started, so for
      // `.claude/settings.json` / `.codex/hooks.json` it is not "immediately
      // before removal" the way `UninstallAction.recordedHash`'s own contract
      // promises: it is the whole loop above this file's turn (on the order
      // of a hundred unlinks plus directory cleanups). An edit landing in
      // that span would be missed and the modified wiring file deleted —
      // exactly what this re-check, and `changedSincePlanning`, exist to
      // prevent. (`wiringBytes` is still used at plan time, in `planUninstall`
      // above — there it IS the immediate read, since nothing runs between it
      // and that file's own verdict.)
      if (region === true) {
        // RP-256 slice 2: this "remove" means STRIP the managed region, never
        // delete the file — re-verified the same way the plan itself checked
        // it (the confirmation-prompt window is exactly where a hand edit
        // could land), against the region BODY's hash, not the whole file's.
        const current = await readBoundedFileInRepo(
          repoDir,
          onDisk(repoDir, rel),
          MAX_AGENTS_MD_REGION_BYTES,
        );
        const located = current === null ? null : locateRegion(current.toString('utf8'));
        if (
          located === null ||
          recordedHash === undefined ||
          sha256(located.body) !== recordedHash
        ) {
          changedSincePlanning.push(rel);
          continue;
        }
        await writeFile(onDisk(repoDir, rel), located.userBytes);
        removed.push(rel);
        continue;
      }
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
        ...(protectedHooksAtApply.length > 0 ? { protectedHooksAtApply } : {}),
      };
    }
    removed.push(rel);
    await removeEmptyParents(repoDir, rel);
  }

  const stillPreserved =
    !wouldDeleteManifest || changedSincePlanning.length > 0 || protectedHooksAtApply.length > 0;

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
      ...(protectedHooksAtApply.length > 0 ? { protectedHooksAtApply } : {}),
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
        ...(protectedHooksAtApply.length > 0 ? { protectedHooksAtApply } : {}),
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
      ...(protectedHooksAtApply.length > 0 ? { protectedHooksAtApply } : {}),
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
    ...(protectedHooksAtApply.length > 0 ? { protectedHooksAtApply } : {}),
  };
}
