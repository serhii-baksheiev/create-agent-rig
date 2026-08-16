import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeSubstitutionValue } from './safe-path.js';

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
  /** Install-relative path → sha256 of the bytes written there. */
  files: Record<string, string>;
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
  // maintainer's disk through a pull request — and these four values are
  // substituted into installed **files**, not only into paths. A name of
  // `../..` would send a write out of the repository; a name carrying a quote
  // closes the string literal `stop-flag.mjs` embeds it in, which `guard-bash`
  // imports on every Bash call. So an unsafe value invalidates the whole
  // manifest rather than being quietly corrected into something plausible.
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
  if (!isStringRecord(m.files)) return null;
  return {
    version: m.version,
    kind: m.kind,
    project: { name: project.name, scope: project.scope, region: project.region },
    stacks: [...m.stacks],
    files: { ...m.files },
  };
}

/** Stable bytes: sorted paths, so a re-run produces no diff of its own. */
export function serializeManifest(manifest: RigManifest): string {
  const files: Record<string, string> = {};
  for (const rel of Object.keys(manifest.files).sort()) files[rel] = manifest.files[rel]!;
  return `${JSON.stringify({ ...manifest, files }, null, 2)}\n`;
}

export async function readManifest(repoDir: string): Promise<RigManifest | null> {
  try {
    return parseManifest(await readFile(path.join(repoDir, ...MANIFEST_REL.split('/')), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeManifest(repoDir: string, manifest: RigManifest): Promise<void> {
  const dest = path.join(repoDir, ...MANIFEST_REL.split('/'));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, serializeManifest(manifest));
}
