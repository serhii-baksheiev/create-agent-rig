import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeSegment, isSafeSubstitutionValue, resolveWritableInside } from './safe-path.js';
import { hasControlCharacter } from './safe-text.js';

/**
 * The install manifest: what this rig installed, at which version, and the
 * hash each file had when it was written.
 *
 * It exists to answer the one hard question an upgrade has — *did the user
 * edit this file?* — with evidence instead of a guess. It is **evidence, not a
 * command**: a file the manifest names but the disk no longer has is reported,
 * never silently restored.
 *
 * It is meant to be committed. Without it in the repository, an upgrade run on
 * CI or on a colleague's machine is blind and falls back to the hash history.
 */
export const MANIFEST_REL = '.claude/.rig-manifest.json';

/** A key in `templates/agent-os/universal/layers.json` — the layers a rig can install. */
export type Layer = 'process' | 'workflow';

/** Every layer this release ships. */
export const ALL_LAYERS: readonly Layer[] = ['process', 'workflow'];

/** What a fresh `init`/`create` installs when nothing opts into more. */
export const DEFAULT_LAYERS: readonly Layer[] = ['process'];

/**
 * What an OLD manifest — written before this field existed — is read as
 * having installed.
 *
 * Every release before RP-180 shipped exactly one payload, and that payload
 * is what is now split into `process` + `workflow`. So a manifest with no
 * `layers` key did not choose "core only" — there was no choice to make yet
 * — it installed everything the single array named. Reading the absence as
 * `DEFAULT_LAYERS` (core only) would make the very next `upgrade` treat
 * every workflow file a pre-RP-180 rig has on disk as `retired` and stop
 * managing it: exactly the data-loss direction RP-180's acceptance forbids.
 * Pinned in `packages/cli/test/manifest.test.ts` › "a manifest with no
 * `layers` key parses as though it recorded every layer" and
 * `packages/cli/test/upgrade.test.ts` › "a pre-RP-180 manifest with no
 * `layers` field keeps every workflow file it already has".
 */
const LEGACY_LAYERS: readonly Layer[] = ALL_LAYERS;

const isLayer = (value: unknown): value is Layer => value === 'process' || value === 'workflow';

export interface RigProject {
  name: string;
  scope: string;
  region: string;
}

export interface RigManifest {
  /** The rig version that wrote these files. */
  version: string;
  /** `create` installed a whole project; `init` installed the process layer. */
  kind: 'create' | 'init';
  /** The substitution context that produced the installed bytes. */
  project: RigProject;
  /** agent-os stack overlays composed in (empty for `init`). */
  stacks: string[];
  /**
   * Which `layers.json` layer(s) this rig installed — read by `upgrade` to
   * decide which files it is still allowed to refresh (RP-180). Always
   * populated on the object `parseManifest` returns: an old manifest with no
   * `layers` key in its JSON is resolved to {@link LEGACY_LAYERS} rather than
   * left absent, so every caller downstream of `readManifest` sees a concrete
   * answer and never has to re-derive the same default.
   */
  layers: Layer[];
  /** Install-relative path → sha256 of the bytes written there. */
  files: Record<string, string>;
  /**
   * Install-relative path → sha256 of the bytes `init` FOUND there and left
   * alone (RP-182). Kept apart from `files` on purpose: these are not bytes the
   * rig wrote, so nothing may vouch for them — but a later `upgrade` can now
   * tell "a file that was already here when the rig arrived" from "a path
   * nothing knows anything about". Absent when nothing was kept, so a clean
   * install serialises exactly as before.
   */
  kept?: Record<string, string>;
  /**
   * Install-relative path → sha256 of the managed-region BODY alone (never
   * the marker lines) spliced into a user-owned file (RP-256 slice 2) —
   * `'AGENTS.md'` today. Kept apart from `files` and `kept` for the same
   * reason `kept` is: the file on disk is a mix of the user's own bytes and
   * a region this rig wrote and vouches for, so neither existing bucket
   * describes it. Absent when nothing is region-tracked, so a clean install
   * serialises exactly as before.
   */
  regions?: Record<string, string>;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * Manifest keys are both relative paths and user-visible plan text. A path can
 * be lexically harmless to the filesystem while a newline or ANSI escape in
 * it forges the plan a maintainer reviews before approving an upgrade.
 */
function isSafeManifestPath(value: string): boolean {
  return (
    value !== '' &&
    !path.isAbsolute(value) &&
    !hasControlCharacter(value) &&
    value.split('/').every(isSafeSegment)
  );
}

/**
 * A manifest, or `null` when there is nothing trustworthy to read.
 *
 * The distinction matters: `null` means "no evidence", which sends the upgrade
 * to the hash history. A half-parsed manifest treated as an empty one would
 * claim every file on disk belongs to the user, and upgrade nothing at all.
 */
export function parseManifest(raw: string): RigManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const m = parsed as Partial<RigManifest>;
  if (typeof m.version !== 'string') return null;
  // The same value check its siblings get (AR-128). `version` is printed raw
  // in the upgrade plan header — `installed by ${plan.fromVersion}`, the screen
  // read immediately before `--yes` — so a version carrying a newline or an
  // ANSI escape could forge plan lines the CLI never composed. A version this
  // rig writes is the package's own (`0.5.0` today; a prerelease such as
  // `0.6.0-rc.1` would also pass), which the substitution whitelist admits;
  // semver build metadata (`+`) is not, and a manifest carrying one is voided
  // rather than printed — no released version has carried one.
  if (!isSafeSubstitutionValue(m.version)) return null;
  if (m.kind !== 'create' && m.kind !== 'init') return null;
  const project = m.project as Partial<RigProject> | undefined;
  if (
    typeof project !== 'object' ||
    project === null ||
    typeof project.name !== 'string' ||
    typeof project.scope !== 'string' ||
    typeof project.region !== 'string'
  ) {
    return null;
  }
  // Values, not just types. This file is committed, so it reaches a
  // maintainer's disk through a pull request. A name of `../..` would send a
  // write out of the repository — and `name` and `region` go further than
  // paths: they are substituted into installed **files**, where a quote closes
  // the string literal `stop-flag.mjs` embeds the name in, which `guard-bash`
  // imports on every Bash call. (`scope` reaches no template today and a
  // `stacks` entry names an overlay *directory*.) An unsafe value invalidates
  // the whole manifest rather than being quietly corrected into something
  // plausible.
  //
  // One check, not two: `isSafeSubstitutionValue` is strictly stronger than
  // `isSafeSegment` here — its first character excludes `.`, and its class
  // admits neither `/` nor `\` nor `\0` — so pairing them would leave a second
  // predicate that can never fire, read as cover, and quietly stop being true
  // if either one moves. `isSafeSegment` still guards every path segment at
  // write time, in `resolveInside`.
  if (!isSafeSubstitutionValue(project.name) || !isSafeSubstitutionValue(project.scope)) {
    return null;
  }
  if (project.region !== '' && !isSafeSubstitutionValue(project.region)) return null;
  if (!Array.isArray(m.stacks) || m.stacks.some((s) => typeof s !== 'string')) return null;
  if (m.stacks.some((s) => !isSafeSubstitutionValue(s))) return null;
  // Optional, like `kept` below — absent is every manifest written before this
  // field existed (resolved to `LEGACY_LAYERS` in the return, not left
  // undefined). Present in a shape this reader does not accept voids the
  // manifest, exactly as `stacks` and `kept` do.
  if (m.layers !== undefined && (!Array.isArray(m.layers) || !m.layers.every(isLayer))) {
    return null;
  }
  if (!isStringRecord(m.files) || Object.keys(m.files).some((rel) => !isSafeManifestPath(rel))) {
    return null;
  }
  // Present in a shape this reader does not accept voids the manifest, exactly
  // as `files` does; absent is every manifest written before the field existed.
  if (
    m.kept !== undefined &&
    (!isStringRecord(m.kept) || Object.keys(m.kept).some((rel) => !isSafeManifestPath(rel)))
  ) {
    return null;
  }
  // Present in a shape this reader does not accept voids the manifest,
  // exactly as `files`/`kept` do; absent is every manifest written before
  // the field existed.
  if (
    m.regions !== undefined &&
    (!isStringRecord(m.regions) || Object.keys(m.regions).some((rel) => !isSafeManifestPath(rel)))
  ) {
    return null;
  }
  return {
    version: m.version,
    kind: m.kind,
    project: { name: project.name, scope: project.scope, region: project.region },
    stacks: [...m.stacks],
    // Deduplicated here, once (RP-180 round 3, security blocker S2): the
    // closed set has exactly two members, so a valid manifest never needs
    // more than two entries, but nothing upstream of this reader bounds the
    // array's length — a committed manifest could otherwise repeat one name
    // thousands of times and make every downstream reader of `.layers` (this
    // module's own callers, `upgrade.ts`, `doctor.mjs`) do unbounded work per
    // entry for no reason.
    layers: m.layers !== undefined ? [...new Set(m.layers as Layer[])] : [...LEGACY_LAYERS],
    files: { ...m.files },
    ...(m.kept !== undefined ? { kept: { ...m.kept } } : {}),
    ...(m.regions !== undefined ? { regions: { ...m.regions } } : {}),
  };
}

const sortedRecord = (record: Record<string, string>): Record<string, string> => {
  const sorted: Record<string, string> = {};
  for (const rel of Object.keys(record).sort()) sorted[rel] = record[rel]!;
  return sorted;
};

/**
 * Stable bytes: sorted paths, so a re-run produces no diff of its own. An
 * empty `kept` is omitted, not written as `{}` — a manifest that kept nothing
 * must serialise byte-identical to one written before the key existed.
 */
export function serializeManifest(manifest: RigManifest): string {
  const { kept, regions, ...rest } = manifest;
  const body = {
    ...rest,
    files: sortedRecord(manifest.files),
    ...(kept !== undefined && Object.keys(kept).length > 0 ? { kept: sortedRecord(kept) } : {}),
    ...(regions !== undefined && Object.keys(regions).length > 0
      ? { regions: sortedRecord(regions) }
      : {}),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export async function readManifest(repoDir: string): Promise<RigManifest | null> {
  try {
    return parseManifest(await readFile(path.join(repoDir, ...MANIFEST_REL.split('/')), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeManifest(repoDir: string, manifest: RigManifest): Promise<void> {
  const dest = await resolveWritableInside(repoDir, MANIFEST_REL);
  if (dest === null) {
    throw new Error(`Refusing to write "${MANIFEST_REL}" through a symlink or outside ${repoDir}.`);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const checked = await resolveWritableInside(repoDir, MANIFEST_REL);
  if (checked === null) {
    throw new Error(`Refusing to write "${MANIFEST_REL}" through a symlink or outside ${repoDir}.`);
  }
  await writeFile(checked, serializeManifest(manifest));
}
