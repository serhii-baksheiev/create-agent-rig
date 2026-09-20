import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { settingsForInstalledHooks } from '../lib/init-settings.js';
import type { InstalledFile } from '../lib/install-set.js';
import { mapConcurrent } from '../lib/copy-tree.js';
import {
  ALL_LAYERS,
  DEFAULT_LAYERS,
  MANIFEST_REL,
  readManifest,
  sha256,
  writeManifest,
} from '../lib/manifest.js';
import type { Layer, RigManifest, RigProject } from '../lib/manifest.js';
import { resolveWritableInside } from '../lib/safe-path.js';
import { substituteContent } from '../lib/substitute.js';
import type { SubstitutionContext } from '../lib/substitute.js';
import { agentOsUniversalDir } from '../templates.js';
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
   * @deprecated Refused since 0.5 and removed in 0.6. It only ever replaced
   * `CLAUDE.md`; `upgrade` refreshes a rig file by file. It stays in the type
   * so `index.ts` can pass the flag through and get the refusal, rather than an
   * unknown-option parse error that names nothing.
   */
  force?: boolean;
  /**
   * An already-validated project identity, supplied by `create` (RP-177).
   * Without it, the project name is derived by slugging the directory name
   * (`projectNameFor`) — correct for `init` adopting an arbitrary existing
   * repo, but lossy for `create`, whose caller already validated a name that
   * may not survive slugging unchanged (a trailing `-` or `.`, stripped by
   * `projectNameFor`, used to make a freshly created rig fail to match its own
   * installed files on the very next `upgrade`). When given, this is used
   * as-is instead of being re-derived.
   */
  project?: RigProject;
  /**
   * Opt into the workflow layer (RP-180): the queue adapter, the `loop` and
   * `pr-ship` skills, run-state/journal, revalidation and claim-records, and
   * the PR-lifecycle helpers (`decision-router`, `detect-missed-gate`,
   * `reconcile-external-prs`). Experimental — an autonomous, cooperative
   * multi-session workflow, not required by Lean Core. Default `false`: a
   * fresh install carries the process layer only.
   *
   * A rig that already has the workflow layer installed (its manifest's
   * `layers` includes `'workflow'`) keeps it on a plain re-run of `init` with
   * no flag — this only ever ADDS the layer, never drops one a previous run
   * or `--layer workflow` already recorded.
   */
  withWorkflow?: boolean;
}

interface Manifest {
  process: string[];
  workflow: string[];
}

/**
 * The layers this install writes, given what a previous run (if any)
 * recorded and whether this run opted in.
 *
 * Never narrows what a previous run already installed: `--layer workflow` is
 * additive, and a rig that already carries the workflow layer keeps it on a
 * plain re-run with no flag (RP-180's "existing dogfood repositories can
 * explicitly retain the layer" applies to `init` re-runs, not only to
 * `upgrade`).
 */
function effectiveLayers(previous: RigManifest | null, withWorkflow: boolean): Layer[] {
  const wantsWorkflow = withWorkflow || (previous?.layers.includes('workflow') ?? false);
  return wantsWorkflow ? [...ALL_LAYERS] : [...DEFAULT_LAYERS];
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
const CODEX_HOOKS = '.codex/hooks.json';
const MAPS = ['CLAUDE.md', 'AGENTS.md'] as const;
/**
 * Plain, static files this install always ships alongside the process layer,
 * beside the two generated wiring files and the two maps above — neither
 * architecture-specific (RP-177 retired that group entirely) nor subject to
 * the maps' overwrite refusal, so they are appended here rather than folded
 * into either list.
 */
const STATIC_EXTRAS = ['.codex/config.toml'] as const;

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'layers.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/**
 * Exactly `layers.json`'s own array for one layer — never the always-added
 * extras (`SETTINGS`, `CODEX_HOOKS`, `STATIC_EXTRAS`, `MAPS`) `initManifest`
 * appends to every layer regardless of which one was asked for. A caller
 * that wants to know whether a SPECIFIC layer's own files are on disk (RP-180
 * round 3, `commands/upgrade.ts`'s `detectLayersOnDisk`) needs this
 * distinction: those extras exist for any rig at all, Core-only included, so
 * checking `initManifest([layer])`'s full output against disk would report
 * every layer as "present" always.
 */
export async function layerOnlyPaths(layer: Layer): Promise<string[]> {
  const manifest = await loadManifest();
  return manifest[layer];
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
 * `init` installs the PROCESS layer (hooks-and-reach brief §3/§4): rules that
 * assume nothing about the codebase shape. Since RP-177 it is the ONLY
 * flavour `create-agent-rig` ships — the architecture group (rules describing
 * `packages/core` and friends) was retired outright, not merely excluded here,
 * so there is no wider install for `create` to fall back to and no override
 * layer left to shadow a universal file.
 *
 * `.claude/settings.json` and `.codex/hooks.json` are generated rather than
 * copied: derived from the shipped settings so they name exactly the hooks
 * that travelled.
 */
export async function initManifest(layers: readonly Layer[] = DEFAULT_LAYERS): Promise<InitFile[]> {
  const manifest = await loadManifest();
  const universal = agentOsUniversalDir();

  const layerFiles = layers.flatMap((layer) => manifest[layer]);
  const files: InitFile[] = [...layerFiles, ...STATIC_EXTRAS, ...MAPS].map((rel) => ({
    rel,
    source: path.join(universal, rel),
  }));
  files.push({ rel: SETTINGS, source: null });
  files.push({ rel: CODEX_HOOKS, source: null });
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
  layers: readonly Layer[] = DEFAULT_LAYERS,
): Promise<Map<string, string>> {
  const projectName = project?.name ?? projectNameFor(repoDir);
  const ctx: SubstitutionContext = {
    projectName,
  };

  const files = await initManifest(layers);
  const contents = new Map<string, string>();
  const sourceFiles = files.filter(
    (file): file is InitFile & { source: string } => file.source !== null,
  );
  const rendered = await mapConcurrent(sourceFiles, 16, async ({ rel, source }) => ({
    rel,
    content: substituteContent(await readFile(source, 'utf8'), ctx),
  }));
  for (const { rel, content } of rendered) {
    contents.set(rel, content);
  }

  const installedHooks = new Set(
    files.map((f) => f.rel).filter((rel) => rel.startsWith('.claude/hooks/')),
  );
  const [shippedSettings, shippedCodexHooks] = await Promise.all([
    readFile(path.join(agentOsUniversalDir(), SETTINGS), 'utf8'),
    readFile(path.join(agentOsUniversalDir(), CODEX_HOOKS), 'utf8'),
  ]);
  const shipped = JSON.parse(shippedSettings) as unknown;
  contents.set(
    SETTINGS,
    `${JSON.stringify(settingsForInstalledHooks(shipped, installedHooks), null, 2)}\n`,
  );
  const shippedCodex = JSON.parse(shippedCodexHooks) as unknown;
  contents.set(
    CODEX_HOOKS,
    `${JSON.stringify(settingsForInstalledHooks(shippedCodex, installedHooks), null, 2)}\n`,
  );
  return contents;
}

/** The process layer as a set of {@link InstalledFile}s — what `upgrade` reads. */
export async function initInstallSet(
  repoDir: string,
  project?: RigProject,
  layers: readonly Layer[] = DEFAULT_LAYERS,
): Promise<InstalledFile[]> {
  const files = await initManifest(layers);
  const contents = await initFileContents(repoDir, project, layers);
  return files.map(({ rel, source }) => ({ rel, source, content: contents.get(rel) ?? '' }));
}

export interface PlanInitOptions {
  /** Plan as though `--layer workflow` were given (RP-180). */
  withWorkflow?: boolean;
}

export async function planInit(repoDir: string, options: PlanInitOptions = {}): Promise<InitPlan> {
  const previous = await readManifest(repoDir);
  const layers = effectiveLayers(previous, options.withWorkflow === true);
  const files = (await initManifest(layers)).map((f) => f.rel);
  const conflicts = (
    await mapConcurrent(files, 16, async (rel) =>
      (await exists(path.join(repoDir, rel))) ? rel : null,
    )
  ).filter((rel): rel is string => rel !== null);
  return { files: files.map((p) => ({ path: p })), conflicts };
}

export async function initProject(repoDir: string, options: InitOptions): Promise<InitResult> {
  // Refused before anything is read or written, so a deprecated flag cannot
  // half-install: `upgrade` covers what this stood in for, and it decides per
  // file from the manifest instead of overriding one refusal wholesale.
  if (options.force) throw new InitError(FORCE_DEPRECATED);

  const previous = await readManifest(repoDir);
  const layers = effectiveLayers(previous, options.withWorkflow === true);
  const files = (await initManifest(layers)).map((f) => f.rel);

  // Resolve the whole write set before the first edit. A lexical child can
  // still escape through a symlink at the leaf or in any existing parent, and
  // discovering that after another payload file was written would leave a
  // partial install. The manifest is a write too, even on an otherwise-empty
  // re-run, so it belongs in the same preflight.
  const destinations = new Map<string, string>();
  for (const rel of [...files, MANIFEST_REL]) {
    const dest = await resolveWritableInside(repoDir, rel);
    if (dest === null) {
      throw new InitError(`Refusing to write "${rel}" through a symlink or outside ${repoDir}.`);
    }
    destinations.set(rel, dest);
  }

  // Refuse to clobber an existing CLAUDE.md — init edits someone's working
  // repository (brief §4, non-negotiable).
  for (const map of MAPS) {
    const dest = destinations.get(map);
    if (dest !== undefined && (await exists(dest))) {
      // A map this rig wrote and that still matches its manifest is safe to
      // skip on an idempotent re-run. An unrecorded or edited map remains the
      // user's guidance and is still refused.
      if (
        previous?.files[map] !== undefined &&
        sha256(await readFile(dest)) === previous.files[map]
      ) {
        continue;
      }
      throw new InitError(
        `This repo already has an ${map}. Refusing to overwrite it. ` +
          'Merge the agent-os map in by hand, or run create-agent-rig upgrade to refresh a rig.',
      );
    }
  }

  const contents = await initFileContents(repoDir, options.project, layers);
  const plannedCount = files.length;
  const actions = await mapConcurrent(files, 16, async (rel) => {
    const dest = destinations.get(rel)!;
    if (await exists(dest)) {
      // never overwrite a file init did not write (a user's own copy)
      return { rel, verdict: 'skipped' as const };
    }
    if (options.dryRun) return { rel, verdict: 'planned' as const };
    await mkdir(path.dirname(dest), { recursive: true });
    const checked = await resolveWritableInside(repoDir, rel);
    if (checked === null) {
      throw new InitError(`Refusing to write "${rel}" through a symlink or outside ${repoDir}.`);
    }
    await writeFile(checked, contents.get(rel) ?? '');
    return { rel, verdict: 'written' as const };
  });
  const written = actions.filter(({ verdict }) => verdict === 'written').map(({ rel }) => rel);
  const skipped = actions.filter(({ verdict }) => verdict === 'skipped').map(({ rel }) => rel);

  if (!options.dryRun) {
    await recordInstall(repoDir, written, skipped, contents, layers, options.project);
  }

  return { written, skipped, plannedCount };
}

/**
 * The text of a regular file, or `null` for anything else at that path — a
 * directory, a symlink, a file this process cannot read. `kept` records only
 * bytes that are the file itself: hashing through a link would put the hash of
 * something outside the repository into a committed manifest, and a read that
 * throws here would abort the install after every other file was written.
 */
async function readRegularFile(abs: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(abs)).isFile()) return null;
    return await readFile(abs);
  } catch {
    return null;
  }
}

/**
 * Record what was installed, so a later `upgrade` can tell a file it wrote
 * from a file the user owns.
 *
 * Only files actually **written** are recorded in `files`. A file `init` kept
 * is somebody else's — claiming it there would let the next upgrade replace a
 * user's own document with the rig's. It is recorded in `kept` instead, with
 * the sha256 of the bytes found on disk (RP-182): not a claim of ownership, a
 * record that the rig saw the file and left it — so the next upgrade can say
 * "kept by init, unchanged since" or "edited since" rather than only "not a
 * version this rig ever released". A path already in `files` is never moved to
 * `kept` by a later run that skips it: the rig wrote those bytes. Earlier
 * entries are preserved: a re-run writes nothing and must not therefore
 * un-remember everything.
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
 * preserves a manifest, so a rig without a READABLE one still gets
 * `kind: 'init'`, no stacks and an empty region, and the advisory in `runInit`
 * stays silent for the same reason. That is three populations, not one: a rig
 * from before 0.4.0 never had a manifest, a deleted manifest is a documented
 * recovery step, and one on disk that `parseManifest` voids reads as absent to
 * `readManifest` alike. `upgrade`'s `detectInstall`
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
  skipped: readonly string[],
  contents: Map<string, string>,
  layers: readonly Layer[],
  project?: RigProject,
): Promise<void> {
  const previous = await readManifest(repoDir);
  const name = projectNameFor(repoDir);
  const files = { ...(previous?.files ?? {}) };
  for (const rel of written) files[rel] = sha256(contents.get(rel) ?? '');
  const kept = { ...(previous?.kept ?? {}) };
  for (const rel of written) delete kept[rel];
  for (const rel of skipped) {
    if (files[rel] !== undefined) continue; // the rig wrote it once; still its bytes to vouch for
    const found = await readRegularFile(path.join(repoDir, rel));
    if (found === null) delete kept[rel];
    else kept[rel] = sha256(found);
  }
  const manifest: RigManifest = {
    version: await packageVersion(),
    kind: previous?.kind ?? 'init',
    // No manifest: prefer the caller's already-validated identity (`create`,
    // RP-177) and only fall back to slugging the directory name when there is
    // none. See the limit above — `upgrade` can do better from the files
    // themselves, and `init` deliberately does not reach for it.
    project: previous?.project ?? project ?? { name, scope: name, region: '' },
    stacks: previous?.stacks ?? [],
    // `layers` is what THIS run resolved (already unioned with whatever the
    // previous manifest recorded — RP-180's `effectiveLayers`), not
    // re-derived here: a second computation of the same union is exactly the
    // "second copy that goes stale" `invariants.md` warns about.
    layers: [...layers],
    files,
    ...(Object.keys(kept).length > 0 ? { kept } : {}),
  };
  await writeManifest(repoDir, manifest);
}
