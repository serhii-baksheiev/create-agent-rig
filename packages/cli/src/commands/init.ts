import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { settingsForInstalledHooks } from '../lib/init-settings.js';
import type { InstalledFile } from '../lib/install-set.js';
import { readManifest, sha256, writeManifest } from '../lib/manifest.js';
import type { RigManifest, RigProject } from '../lib/manifest.js';
import { substituteContent } from '../lib/substitute.js';
import type { SubstitutionContext } from '../lib/substitute.js';
import { agentOsInitDir, agentOsUniversalDir } from '../templates.js';
import { packageVersion } from '../lib/version.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class InitError extends Error {}

/** What `--force` answers with now that `upgrade` owns the case it stood in for. */
export const FORCE_DEPRECATED =
  'deprecated — init --force replaced only CLAUDE.md; run create-agent-rig upgrade instead';

export interface InitOptions {
  /** Report the plan, write nothing. */
  dryRun?: boolean;
  /**
   * Deprecated: refused, and removed in the release after this one. It only
   * ever replaced `CLAUDE.md`; `upgrade` refreshes a rig file by file.
   */
  force?: boolean;
}

interface Manifest {
  process: string[];
  architecture: string[];
  meta: string[];
}

/** One installed path, and the template file behind it (`null` = generated here). */
export interface InitFile {
  rel: string;
  source: string | null;
}

export interface InitPlan {
  /** Process-layer files that would be installed. */
  files: Array<{ path: string }>;
  /** Paths that already exist and would be preserved / need a decision. */
  conflicts: string[];
}

export interface InitResult {
  written: string[];
  skipped: string[];
  plannedCount: number;
}

const SETTINGS = '.claude/settings.json';

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'layers.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The name this repo is known by inside the rig. It ends up in a *filename* —
 * `~/.claude/<name>-loop-STOP`, the kill switch — so it is reduced to
 * characters an operator can type into a shell without quoting.
 */
export function projectNameFor(repoDir: string): string {
  const base = path.basename(path.resolve(repoDir));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug === '' ? 'project' : slug;
}

/**
 * `init` installs only the PROCESS layer (hooks-and-reach brief §3/§4): rules
 * that assume nothing about the codebase shape. Architecture rules reference
 * `packages/core` and friends — installing them into an arbitrary repo would
 * describe a structure that does not exist, which is worse than no rule.
 *
 * It also installs two things the process manifest does not name, because both
 * are meaningless in the generated shape and load-bearing here:
 *
 * - `CLAUDE.md` — the map, taken from the init override layer, which describes
 *   the rig this command installs rather than the generated monorepo;
 * - `.claude/settings.json` — the wiring, derived from the shipped settings so
 *   it names exactly the hooks that travelled.
 */
export async function initManifest(): Promise<InitFile[]> {
  const manifest = await loadManifest();
  const universal = agentOsUniversalDir();
  const override = agentOsInitDir();

  const files: InitFile[] = [];
  for (const rel of [...manifest.process, 'CLAUDE.md']) {
    const overridden = path.join(override, rel);
    files.push({
      rel,
      source: (await exists(overridden)) ? overridden : path.join(universal, rel),
    });
  }
  files.push({ rel: SETTINGS, source: null });
  return files;
}

/**
 * Exactly the bytes `init` would write, keyed by destination path — the single
 * source the plan, the install and the template tests all read.
 *
 * Every file the process layer carries is text (asserted by a template test),
 * so substitution can be applied unconditionally: an unsubstituted
 * `__PROJECT_NAME__` in `stop-flag.mjs` is a kill switch that silently never
 * fires.
 */
export async function initFileContents(
  repoDir: string,
  project?: RigProject,
): Promise<Map<string, string>> {
  const projectName = project?.name ?? projectNameFor(repoDir);
  const ctx: SubstitutionContext = {
    projectName,
    projectScope: project?.scope ?? projectName,
    region: project?.region ?? '',
  };

  const files = await initManifest();
  const contents = new Map<string, string>();
  for (const { rel, source } of files) {
    if (source === null) continue;
    contents.set(rel, substituteContent(await readFile(source, 'utf8'), ctx));
  }

  const installedHooks = new Set(
    files.map((f) => f.rel).filter((rel) => rel.startsWith('.claude/hooks/')),
  );
  const shipped = JSON.parse(
    await readFile(path.join(agentOsUniversalDir(), SETTINGS), 'utf8'),
  ) as unknown;
  contents.set(
    SETTINGS,
    `${JSON.stringify(settingsForInstalledHooks(shipped, installedHooks), null, 2)}\n`,
  );
  return contents;
}

/** The process layer as a set of {@link InstalledFile}s — what `upgrade` reads. */
export async function initInstallSet(
  repoDir: string,
  project?: RigProject,
): Promise<InstalledFile[]> {
  const files = await initManifest();
  const contents = await initFileContents(repoDir, project);
  return files.map(({ rel, source }) => ({ rel, source, content: contents.get(rel) ?? '' }));
}

export async function planInit(repoDir: string): Promise<InitPlan> {
  const files = (await initManifest()).map((f) => f.rel);
  const conflicts: string[] = [];
  for (const rel of files) {
    if (await exists(path.join(repoDir, rel))) conflicts.push(rel);
  }
  return { files: files.map((p) => ({ path: p })), conflicts };
}

export async function initProject(repoDir: string, options: InitOptions): Promise<InitResult> {
  // Refused before anything is read or written, so a deprecated flag cannot
  // half-install: `upgrade` covers what this stood in for, and it decides per
  // file from the manifest instead of overriding one refusal wholesale.
  if (options.force) throw new InitError(FORCE_DEPRECATED);

  const files = (await initManifest()).map((f) => f.rel);

  // Refuse to clobber an existing CLAUDE.md — init edits someone's working
  // repository (brief §4, non-negotiable).
  if (files.includes('CLAUDE.md')) {
    if (await exists(path.join(repoDir, 'CLAUDE.md'))) {
      throw new InitError(
        'This repo already has a CLAUDE.md. Refusing to overwrite it. ' +
          'Merge the agent-os map in by hand, or run create-agent-rig upgrade to refresh a rig.',
      );
    }
  }

  const contents = await initFileContents(repoDir);
  const written: string[] = [];
  const skipped: string[] = [];
  const plannedCount = files.length;

  for (const rel of files) {
    const dest = path.join(repoDir, rel);
    if (await exists(dest)) {
      // never overwrite a file init did not write (a user's own copy). With
      // `--force` refused above, `CLAUDE.md` is no longer the exception it was.
      skipped.push(rel);
      continue;
    }
    if (options.dryRun) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, contents.get(rel) ?? '');
    written.push(rel);
  }

  if (!options.dryRun) await recordInstall(repoDir, written, contents);

  return { written, skipped, plannedCount };
}

/**
 * Record what was installed, so a later `upgrade` can tell a file it wrote
 * from a file the user owns.
 *
 * Only files actually **written** are recorded. A file `init` kept is
 * somebody else's — claiming it here would let the next upgrade replace a
 * user's own document with the rig's. Earlier entries are preserved: a re-run
 * writes nothing and must not therefore un-remember everything.
 *
 * 🔴 **`kind`, `project` and `stacks` are preserved, not rewritten.** Reached
 * inside a rig `create` produced, this used to stamp `kind: 'init'`,
 * `stacks: []` and an empty `region` over the truth — and `planUpgrade` trusts
 * a manifest wholesale (it never re-detects), so the next upgrade routed to the
 * `init` install set and the stack overlays left the plan entirely: not
 * reported as deleted, not as a conflict, simply absent. `init` describes what
 * it wrote; it does not get to re-describe how the rig was installed.
 *
 * ⚠ **The limit, stated because the fix reads as wider than it is:** this
 * preserves a manifest, so a rig that has none — anything from before 0.4.0 —
 * still gets `kind: 'init'`, no stacks and an empty region, and the advisory in
 * `runInit` stays silent for the same reason. `upgrade`'s `detectInstall`
 * recovers all three from the files on disk, so those values are not
 * unavailable, only unavailable *here*: reaching for it would point
 * `commands/init` at `commands/upgrade`, which already imports this module.
 * The fallback below is the honest floor, not the best available answer.
 *
 * The item that asked for this also floated refusing `init` outright on a
 * `create` manifest. It is already refused a step earlier and for a different
 * reason — {@link initProject} throws on the existing `CLAUDE.md`. The gap that
 * leaves is a `create` rig whose `CLAUDE.md` was deleted, and this function is
 * what makes that case safe.
 */
async function recordInstall(
  repoDir: string,
  written: readonly string[],
  contents: Map<string, string>,
): Promise<void> {
  const previous = await readManifest(repoDir);
  const name = projectNameFor(repoDir);
  const files = { ...(previous?.files ?? {}) };
  for (const rel of written) files[rel] = sha256(contents.get(rel) ?? '');
  const manifest: RigManifest = {
    version: await packageVersion(),
    kind: previous?.kind ?? 'init',
    // No manifest: fall back to the directory name, which is all this module
    // reads. See the limit above — `upgrade` can do better from the files
    // themselves, and `init` deliberately does not reach for it.
    project: previous?.project ?? { name, scope: name, region: '' },
    stacks: previous?.stacks ?? [],
    files,
  };
  await writeManifest(repoDir, manifest);
}
