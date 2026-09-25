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
import { readBoundedFileInRepo } from '../lib/bounded-file.js';
import {
  composeRegion,
  decodeStrictUtf8,
  hasAnyMarker,
  MAX_AGENTS_MD_REGION_BYTES,
} from '../lib/agents-md-region.js';
import { atomicWriteInRepo } from '../lib/atomic-write.js';

/**
 * Codex's documented combined-budget default (round 2, prose-reviewer
 * blocker 1): `project_doc_max_bytes`, 32 KiB, is the total Codex stops
 * ADDING AGENTS.md files at once it reaches — not a per-file cap — per
 * Codex's own docs (learn.chatgpt.com/docs/agent-configuration/agents-md,
 * redirected from developers.openai.com/codex/guides/agents-md, read
 * 2026-09-25): "stops adding files once the combined size reaches the limit
 * defined by `project_doc_max_bytes` (32 KiB by default)". Configurable, and
 * a budget across every AGENTS.md Codex reads for a project — not specific
 * to this one file. The warning below fires on this one file alone already
 * exceeding that DEFAULT combined budget, which is a fair (if conservative)
 * proxy: a file this large leaves no room for any other AGENTS.md Codex
 * would otherwise also read, even before the rest of the combined total is
 * considered.
 */
const CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES = 32768;

/** A user-facing failure: message is printed as-is, no stack trace. */
export class InitError extends Error {}

/** What `--force` answers with now that `upgrade` owns the case it stood in for. */
export const FORCE_DEPRECATED =
  'deprecated — init --force replaced only CLAUDE.md; run create-agent-rig upgrade instead';

export interface InitOptions {
  /** Report the plan, write nothing. */
  dryRun?: boolean;
  /**
   * @deprecated Refused since 0.5, and still recognised only to refuse — it
   * only ever replaced `CLAUDE.md`; `upgrade` refreshes a rig file by file.
   * It stays in the type so `index.ts` can pass the flag through and get the
   * refusal, rather than an unknown-option parse error that names nothing.
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
  /**
   * Non-fatal notices the CLI prints after a successful install — today,
   * only the AGENTS.md managed region landing over Codex's default combined
   * AGENTS.md budget (`project_doc_max_bytes`, 32 KiB) on its own
   * (RP-256 slice 2). Always present, empty when there is nothing to say.
   */
  warnings: string[];
}

const SETTINGS = '.claude/settings.json';
const CODEX_HOOKS = '.codex/hooks.json';
const ROOT_CLAUDE = 'CLAUDE.md';
/**
 * Where the CLAUDE.md shim lives on a `nested` placement (RP-256 slice 1).
 * Exported so `upgrade.ts` and `uninstall.ts` derive the SAME path rather
 * than each spelling it out again (`invariants.md`, "one spelling of a
 * fact") — `upgrade.ts` reads it to recognise a nested rig from its
 * manifest, `uninstall.ts` to widen the ownership boundary it is held to.
 */
export const NESTED_CLAUDE = '.claude/CLAUDE.md';
const AGENTS_MAP = 'AGENTS.md';
/**
 * Plain, static files this install always ships alongside the process layer,
 * beside the two generated wiring files and the two maps above — neither
 * architecture-specific (RP-177 retired that group entirely) nor subject to
 * the maps' overwrite refusal, so they are appended here rather than folded
 * into either list.
 */
const STATIC_EXTRAS = ['.codex/config.toml'] as const;

/**
 * Where the Rig's CLAUDE.md shim goes (RP-256 slice 1). `root` is the
 * pre-existing behaviour: `CLAUDE.md` at the repo root, byte-identical to the
 * one AGENTS.md shim every earlier release wrote. `nested` is new: a repo
 * that already has its OWN root `CLAUDE.md` keeps it untouched, and the shim
 * installs instead at `.claude/CLAUDE.md`, importing the rulebook as
 * `@../AGENTS.md` (one directory up from where it now sits) rather than the
 * root shim's `@AGENTS.md`. Both files are loaded by Claude Code — measured,
 * not assumed: see `docs/decisions/agents-md-canonical.md`, "CLAUDE.md
 * coexistence — measured (RP-256 slice 1)" — so nothing is lost.
 */
export type ClaudeMdPlacement = 'root' | 'nested';

/** The two map paths, in refusal-check order, for a given placement. */
function mapsFor(placement: ClaudeMdPlacement): readonly [string, string] {
  return [placement === 'nested' ? NESTED_CLAUDE : ROOT_CLAUDE, AGENTS_MAP];
}

/**
 * Whether `p` is something the user placed there and owns — a REGULAR file,
 * or a SYMLINK to one (code-review round 1 blocker B1, PR #324): the link
 * points at the user's own content exactly the way a regular file holds it,
 * so it is not this rig's to write over either. `lstat`, never `access`,
 * and never following a symlink through to decide EXISTENCE — only its
 * *kind* is read here, never its target's content. A directory is neither:
 * there is no content there to leave alone the way a file's or a link's
 * content is, so it falls through to `false` and stays a `root`-placement
 * refusal instead.
 */
async function hasOwnRootClaudeMd(p: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The placement THIS install should use, derived from the manifest first and
 * the filesystem only when the manifest is silent on it:
 *
 * - the manifest already records `.claude/CLAUDE.md` (a previous run already
 *   went nested) → stay `nested`, regardless of what root `CLAUDE.md` looks
 *   like today;
 * - no manifest entry for `CLAUDE.md` at all, and a regular file or a
 *   symlink already sits at root `CLAUDE.md` → `nested`, so that file is
 *   never claimed as the rig's own;
 * - anything else (a clean repo, a directory sitting at `CLAUDE.md`, or a
 *   manifest that already recorded root `CLAUDE.md`) → `root`, unchanged
 *   from every earlier release.
 */
async function claudeMdPlacementForInstall(
  repoDir: string,
  previous: RigManifest | null,
): Promise<ClaudeMdPlacement> {
  if (previous?.files[NESTED_CLAUDE] !== undefined) return 'nested';
  if (previous?.files[ROOT_CLAUDE] === undefined) {
    if (await hasOwnRootClaudeMd(path.join(repoDir, ROOT_CLAUDE))) return 'nested';
  }
  return 'root';
}

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'layers.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/**
 * Exactly `layers.json`'s own array for one layer — never the always-added
 * extras (`SETTINGS`, `CODEX_HOOKS`, `STATIC_EXTRAS`, `mapsFor`'s two paths) `initManifest`
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
export async function initManifest(
  layers: readonly Layer[] = DEFAULT_LAYERS,
  placement: ClaudeMdPlacement = 'root',
): Promise<InitFile[]> {
  const manifest = await loadManifest();
  const universal = agentOsUniversalDir();

  const layerFiles = layers.flatMap((layer) => manifest[layer]);
  const files: InitFile[] = [...layerFiles, ...STATIC_EXTRAS, ...mapsFor(placement)].map((rel) => ({
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
  placement: ClaudeMdPlacement = 'root',
): Promise<Map<string, string>> {
  const projectName = project?.name ?? projectNameFor(repoDir);
  const ctx: SubstitutionContext = {
    projectName,
  };

  const files = await initManifest(layers, placement);
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
  placement: ClaudeMdPlacement = 'root',
): Promise<InstalledFile[]> {
  const files = await initManifest(layers, placement);
  const contents = await initFileContents(repoDir, project, layers, placement);
  return files.map(({ rel, source }) => ({ rel, source, content: contents.get(rel) ?? '' }));
}

export interface PlanInitOptions {
  /** Plan as though `--layer workflow` were given (RP-180). */
  withWorkflow?: boolean;
}

export async function planInit(repoDir: string, options: PlanInitOptions = {}): Promise<InitPlan> {
  const previous = await readManifest(repoDir);
  const layers = effectiveLayers(previous, options.withWorkflow === true);
  const placement = await claudeMdPlacementForInstall(repoDir, previous);
  const files = (await initManifest(layers, placement)).map((f) => f.rel);
  const conflicts = (
    await mapConcurrent(files, 16, async (rel) =>
      (await exists(path.join(repoDir, rel))) ? rel : null,
    )
  ).filter((rel): rel is string => rel !== null);
  // RP-256 slice 1: root CLAUDE.md is deliberately NOT in `files` once
  // placement goes `nested` — the install plans `.claude/CLAUDE.md` instead
  // — so the generic loop above never sees it. It is still worth reporting:
  // it is present, and it is kept rather than overwritten, which is exactly
  // what this list already means for every other entry in it.
  if (placement === 'nested' && (await exists(path.join(repoDir, ROOT_CLAUDE)))) {
    conflicts.push(ROOT_CLAUDE);
  }
  return { files: files.map((p) => ({ path: p })), conflicts };
}

export async function initProject(repoDir: string, options: InitOptions): Promise<InitResult> {
  // Refused before anything is read or written, so a deprecated flag cannot
  // half-install: `upgrade` covers what this stood in for, and it decides per
  // file from the manifest instead of overriding one refusal wholesale.
  if (options.force) throw new InitError(FORCE_DEPRECATED);

  const previous = await readManifest(repoDir);
  const layers = effectiveLayers(previous, options.withWorkflow === true);
  const placement = await claudeMdPlacementForInstall(repoDir, previous);
  const files = (await initManifest(layers, placement)).map((f) => f.rel);

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

  // Refuse to clobber whichever CLAUDE.md slot this run actually plans to
  // write (root, or nested at `.claude/CLAUDE.md`) — init edits someone's
  // working repository (brief §4, non-negotiable). RP-256 slice 1: a
  // pre-existing ROOT CLAUDE.md no longer reaches this loop at all once
  // placement is `nested` — it is not in `files`, so it is never this rig's
  // to overwrite in the first place; see `recordInstall` below for where it
  // is recorded instead. RP-256 slice 2: AGENTS.md is no longer refused
  // here at all — a plain pre-existing one now coexists (see the region
  // block below); only the CLAUDE.md slot still refuses outright.
  const claudeMap = mapsFor(placement)[0];
  {
    const dest = destinations.get(claudeMap);
    if (dest !== undefined && (await exists(dest))) {
      // code-review round 1 advisory A8/blocker B1 (PR #324): a DIRECTORY at
      // a map's path is not the user's file to leave in place the way a
      // regular file or a symlink is (`hasOwnRootClaudeMd` above already
      // keeps it out of `nested` placement for this reason) — there is no
      // content to merge in by hand, byte for byte or through a link, so
      // the generic "Merge the agent-os map in by hand" remedy below does
      // not fit it. Checked before the hash comparison beneath: a directory
      // can never match a previously recorded file hash, and calling
      // `readFile` on one throws `EISDIR` rather than returning bytes to
      // compare.
      if ((await lstat(dest).catch(() => null))?.isDirectory()) {
        throw new InitError(
          `This repo already has a directory at ${claudeMap}. Refusing to write into it. Move or remove that directory, then run create-agent-rig init again.`,
        );
      }
      // A map this rig wrote and that still matches its manifest is safe to
      // skip on an idempotent re-run. An unrecorded or edited map remains the
      // user's guidance and is still refused.
      if (
        previous?.files[claudeMap] !== undefined &&
        sha256(await readFile(dest)) === previous.files[claudeMap]
      ) {
        // idempotent re-run — nothing to refuse
      } else {
        // Suggesting `upgrade` only makes sense once there is a rig for it to
        // refresh. With no manifest at all, that suggestion loops straight
        // into upgrade's OWN "no rig found, run init" refusal.
        const remedy =
          previous !== null
            ? 'Merge the agent-os map in by hand, or run create-agent-rig upgrade to refresh a rig.'
            : 'Merge the agent-os map in by hand.';
        throw new InitError(
          `This repo already has a ${claudeMap}. Refusing to overwrite it. ${remedy}`,
        );
      }
    }
  }

  // RP-256 slice 2: a plain pre-existing AGENTS.md coexists — its bytes
  // become the managed region's prefix (composed below, once the rendered
  // body is available). The one refusal that remains is markers already
  // there that init cannot safely merge with: a well-formed region from
  // elsewhere, or a malformed/foreign fragment of one (an unterminated
  // begin, a stray end, two begins). Never suggests `upgrade` — there is no
  // rig installed yet for it to refresh.
  //
  // Round 2, code-reviewer B2/B3: a pre-existing AGENTS.md this run's OWN
  // manifest already vouches for — either as a whole rig-owned file
  // (`previous.files[AGENTS.md]`, the pre-slice-2 shape) or as an already
  // region-tracked one (`previous.regions[AGENTS.md]`) — is never routed
  // through the foreign-file marker check at all. A whole-file entry keeps
  // the EXACT pre-slice-2 behaviour: unedited is left alone, edited is
  // refused outright. A region entry is always left alone, edited or not —
  // idempotent, like any other `kept` path — never refused, never
  // duplicated: `regions` is not `recordInstall`'s to touch this run
  // (`extraRegions` stays `undefined`), so `previous.regions` is carried
  // forward unchanged by that function's own default.
  // Round 3, code-reviewer blocker 1: a region-tracked AGENTS.md the user
  // DELETED, then `init` re-run — the marker-check block below only ever
  // runs `if (await exists(dest))`, so a deleted path skips it entirely and
  // falls straight into the ordinary write loop, which writes the whole
  // rendered rulebook (there is no existing prefix to splice into). That
  // write is exactly right — this IS a clean-repo install of AGENTS.md now.
  // What is not right, without this flag, is `previous.regions['AGENTS.md']`
  // being carried forward stale: `dropStaleRegion` names the path whose
  // `regions` entry `recordInstall` must drop this run, so the fresh
  // whole-file write is recorded in `files` (never `regions`, never both).
  let dropStaleRegion: string[] | undefined;
  let existingAgentsBytes: Buffer | null = null;
  let existingAgentsText: string | null = null;
  let existingAgentsMode: number | null = null;
  {
    const dest = destinations.get(AGENTS_MAP)!;
    if (!(await exists(dest)) && previous?.regions?.[AGENTS_MAP] !== undefined) {
      dropStaleRegion = [AGENTS_MAP];
    }
    if (await exists(dest)) {
      const stat = await lstat(dest).catch(() => null);
      if (stat?.isDirectory()) {
        throw new InitError(
          `This repo already has a directory at ${AGENTS_MAP}. Refusing to write into it. Move or remove that directory, then run create-agent-rig init again.`,
        );
      }
      const bytes = await readBoundedFileInRepo(repoDir, dest, MAX_AGENTS_MD_REGION_BYTES);
      if (bytes === null) {
        throw new InitError(
          `Refusing to read "${AGENTS_MAP}": not a plain file this rig can safely merge with ` +
            `(too large, not a regular file, or it resolves outside ${repoDir}). Move or remove ` +
            'it, then run create-agent-rig init again.',
        );
      }
      const wholeFileHash = previous?.files[AGENTS_MAP];
      const regionHash = previous?.regions?.[AGENTS_MAP];
      if (wholeFileHash !== undefined) {
        // Round 2, B3: this rig's OWN whole-file AGENTS.md (from before
        // slice 2, or from a clean install this same release did) — unedited
        // is the ordinary idempotent "already installed" case (left in
        // `files` below, generic loop reports it `skipped`); edited is
        // refused exactly as every release before this slice already did.
        // Never routed into the foreign-marker check: a rig's own rendered
        // rulebook carries no region markers at all, so that check would
        // silently accept it and append a SECOND copy of the rulebook.
        if (sha256(bytes) !== wholeFileHash) {
          throw new InitError(
            `This repo already has an ${AGENTS_MAP}. Refusing to overwrite it. Merge the agent-os ` +
              'map in by hand, or run create-agent-rig upgrade to refresh a rig.',
          );
        }
      } else if (regionHash !== undefined) {
        // Round 2, B2: already region-tracked by THIS rig's own manifest —
        // always left alone, whether the region is still exactly what was
        // installed or the user has since edited inside it. Nothing to
        // refuse, nothing to append: `existingAgentsBytes` stays unset, so
        // AGENTS.md stays in the ordinary write loop below and is reported
        // `skipped` (the file already exists), exactly like any other
        // untouched or user-edited rig-tracked path.
      } else {
        // Genuinely foreign: neither manifest bucket names this path.
        const text = decodeStrictUtf8(bytes);
        if (text === null) {
          throw new InitError(
            `Refusing to merge "${AGENTS_MAP}": its bytes are not valid UTF-8, so this rig cannot ` +
              'safely read it as text without risking corruption. Save it as UTF-8, then run ' +
              'create-agent-rig init again.',
          );
        }
        if (hasAnyMarker(text)) {
          throw new InitError(
            `This repo's ${AGENTS_MAP} already carries create-agent-rig region markers that init ` +
              'cannot safely merge with. Resolve them by hand, then run create-agent-rig init again.',
          );
        }
        existingAgentsBytes = bytes;
        existingAgentsText = text;
        existingAgentsMode = stat !== null ? stat.mode & 0o777 : null;
      }
    }
  }

  const contents = await initFileContents(repoDir, options.project, layers, placement);
  const plannedCount = files.length;
  // RP-256 slice 2: once a pre-existing AGENTS.md has passed the marker
  // check above, it is no longer this loop's ordinary "exists → skipped"
  // path — it gets a managed region appended instead, handled separately
  // right after this loop so the append (and its own dry-run/warning
  // handling) has the rendered body available.
  const filesToWrite =
    existingAgentsBytes !== null ? files.filter((rel) => rel !== AGENTS_MAP) : files;
  const actions = await mapConcurrent(filesToWrite, 16, async (rel) => {
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
  const warnings: string[] = [];

  // RP-256 slice 2: the append itself. `existingAgentsBytes` is only ever
  // set once the marker check above has already let this run through, so
  // there is nothing left to refuse here — only compose, warn if the result
  // is large, and (outside a dry run) write it and record it. Round 2,
  // security-scanner B1/A1: written atomically (a temp file in the same
  // directory, then a rename), so a hard link at AGENTS.md is replaced —
  // never written through to whatever else it names — and the original
  // file's own mode is preserved rather than defaulted.
  let regionBodyHash: string | undefined;
  if (existingAgentsBytes !== null && existingAgentsText !== null) {
    const body = contents.get(AGENTS_MAP) ?? '';
    const composed = composeRegion(existingAgentsText, body);
    regionBodyHash = sha256(body);
    const composedSize = Buffer.byteLength(composed, 'utf8');
    if (composedSize > CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES) {
      warnings.push(
        `${AGENTS_MAP} is now ${composedSize} bytes, over Codex's default combined AGENTS.md ` +
          `budget of ${CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES} bytes (32 KiB, \`project_doc_max_bytes\`) ` +
          'on its own. The install still succeeded — Codex may stop reading before the rest of ' +
          'this file, or before any other AGENTS.md it would otherwise also read.',
      );
    }
    if (!options.dryRun) {
      const result = await atomicWriteInRepo(
        repoDir,
        AGENTS_MAP,
        Buffer.from(composed, 'utf8'),
        existingAgentsMode ?? 0o644,
      );
      if (!result.ok) {
        throw new InitError(
          `Refusing to write "${AGENTS_MAP}" through a symlink or outside ${repoDir}.`,
        );
      }
      written.push(AGENTS_MAP);
    }
  }

  if (!options.dryRun) {
    // RP-256 slice 1: on a `nested` placement, root CLAUDE.md is the user's
    // own file — never in `files`, so the loop above never touches it, and
    // it needs its own evidence entry under the manifest's `kept` (RP-182's
    // meaning: seen and left, not owned). `null` when there is nothing there
    // to record: the placement is `root` (simply not a question), the target
    // is not a regular file within {@link MAX_KEPT_BYTES}, or — security-
    // scanner round 2 advisory A1 (PR #324) — the target resolves outside
    // `repoDir` and so is not this repository's evidence to commit.
    const keptRootClaude =
      placement === 'nested'
        ? await readKeptRootClaudeMd(repoDir, path.join(repoDir, ROOT_CLAUDE))
        : null;
    const extraKept =
      keptRootClaude !== null ? { [ROOT_CLAUDE]: sha256(keptRootClaude) } : undefined;
    // code-review round 1 blocker B2/advisory A2 (PR #324): once `nested`,
    // THIS run owns the truth about root CLAUDE.md's `kept` entry, present
    // or absent. Root CLAUDE.md never reaches `written`/`skipped` on this
    // placement (it is not in `files` at all), so the generic per-path
    // loops in `recordInstall` can never clear a stale entry a prior nested
    // install left behind once the user deletes their own file — this is
    // the one path whose absence still has to be told apart from "never
    // computed at all" (a `root` placement, where dropping it would erase a
    // kept entry this run has no opinion on).
    const dropKept = placement === 'nested' && keptRootClaude === null ? [ROOT_CLAUDE] : undefined;
    // RP-256 slice 2: the region body's hash, recorded under `regions`
    // rather than `files` — AGENTS.md on disk is a mix of the user's own
    // bytes and this rig's, so neither existing bucket describes it.
    // `undefined` unless this run actually appended a region (a clean repo,
    // or a dry run, never sets `regionBodyHash`).
    const extraRegions =
      regionBodyHash !== undefined ? { [AGENTS_MAP]: regionBodyHash } : undefined;
    await recordInstall(
      repoDir,
      written,
      skipped,
      contents,
      layers,
      options.project,
      extraKept,
      dropKept,
      extraRegions,
      dropStaleRegion,
    );
  }

  return { written, skipped, plannedCount, warnings };
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
 * The largest root `CLAUDE.md` this rig will hash into a committed
 * manifest's `kept`. Generous for a rulebook a human edits by hand, and
 * still a real bound: {@link readKeptRootClaudeMd} allocates this many bytes
 * plus one, once, never more — regardless of what is actually at the far
 * end of a symlink a repository itself controls (security-scanner round 2
 * blocker B1, PR #324).
 */
const MAX_KEPT_BYTES = 1024 * 1024;

/**
 * The bytes to vouch for under `kept['CLAUDE.md']` on a `nested` placement —
 * read by FOLLOWING a symlink (code-review round 1 blocker B1, PR #324): a
 * symlink at root CLAUDE.md is the user's own file exactly like a regular
 * file is, per {@link hasOwnRootClaudeMd}, so `kept` records the same thing
 * for one that it records for the other — the sha256 of the content a
 * reader opening the file would see, following the link to get there.
 *
 * security-scanner round 2 blocker B1 (PR #324): a repository-controlled
 * symlink can point at a FIFO, a device, or a file of unbounded size, and
 * the earlier two-step `lstat` + `readFile` had no defence against any of
 * the three — a FIFO with no writer hung `init` mid-`open()`, after every
 * other file had already been written, and no manifest was ever produced
 * for a re-run to repair. This opens the path directly with
 * `O_RDONLY | O_NONBLOCK` (so `open()` on a FIFO with nothing on the write
 * end returns immediately instead of blocking the event loop), `fstat`s
 * that SAME handle — never a second, independent `lstat`/`stat` call, which
 * would leave a window for the target to change underneath — and reads only
 * from that handle, only when it names a REGULAR file no larger than
 * {@link MAX_KEPT_BYTES}. The containment check below this DOES resolve the
 * path a second time, through `realpath(abs)` rather than the handle — that
 * one is answering a different question (is the target inside `repoDir` at
 * all, for the advisory A1 rule below) than the size/regularity fstat
 * settles, and reads the bytes it vouches for from the handle opened
 * earlier regardless of what a race did to the path in between.
 *
 * security-scanner round 2 advisory A1 (PR #324): `kept` is evidence about
 * THIS repository, committed into a manifest the user pushes — so a target
 * that resolves OUTSIDE `repoDir` gets no entry at all. Nothing about a
 * file the rig never touched, and that may not even be the user's to
 * disclose (an outside symlink can point anywhere readable), belongs in a
 * document this project commits. The containment check follows the same
 * `realpath(repoDir)`-prefix, separator-aware comparison every other
 * escapes-root check in this codebase uses (`../lib/safe-path.ts`,
 * `uninstall.ts`) — there is no separate Windows case rule: `realpath`
 * itself returns the on-disk casing for both sides, so the plain string
 * comparison already agrees with how Windows resolves the path.
 *
 * `null` for anything else: a directory, a missing path, a non-regular
 * target, a target over the cap, a target outside the repo, or a target
 * this process cannot read.
 *
 * The FIFO-safe, bounded-read, containment-checked mechanics live in
 * {@link readBoundedFileInRepo} (`../lib/bounded-file.js`), shared with the
 * AGENTS.md managed-region reads RP-256 slice 2 adds below — one
 * implementation, not two that could drift apart (`.claude/rules/
 * invariants.md`, "one spelling of a fact").
 */
async function readKeptRootClaudeMd(repoDir: string, abs: string): Promise<Buffer | null> {
  return readBoundedFileInRepo(repoDir, abs, MAX_KEPT_BYTES);
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
 * reason — {@link initProject} throws on the existing `AGENTS.md` (root
 * `CLAUDE.md` no longer refuses outright since RP-256 slice 1; a `nested`
 * placement leaves it as `kept` instead). The gap that leaves is a `create`
 * rig whose `AGENTS.md` was deleted, and this function is what makes that
 * case safe.
 */
async function recordInstall(
  repoDir: string,
  written: readonly string[],
  skipped: readonly string[],
  contents: Map<string, string>,
  layers: readonly Layer[],
  project?: RigProject,
  // RP-256 slice 1: evidence for a path that is not in `written`/`skipped` at
  // all — a `nested` placement's root CLAUDE.md, which `files` never
  // included in the first place, so the generic loops below never see it.
  // Merged in exactly like an ordinary `kept` entry once computed by the
  // caller (`initProject`), which already knows whether it applies.
  extraKept?: Record<string, string>,
  // code-review round 1 blocker B2/advisory A2 (PR #324): keys this run
  // OWNS the truth about — same population as `extraKept` above, the
  // opposite finding (nothing there any more, so any entry a prior run left
  // is stale) — and, exactly because they never reach `written`/`skipped`
  // either, the loops below cannot discover that on their own.
  dropKept?: readonly string[],
  // RP-256 slice 2: evidence for a region SPLICED into a user-owned file —
  // `written` already carries `'AGENTS.md'` on an append (so the CLI's
  // "Installed N files" count and any wiring-disclosure logic still see it),
  // but its bytes are a mix of the user's own and this rig's, so neither
  // `files` nor `kept` describes it; the generic loops below explicitly skip
  // it and this is where it is recorded instead.
  extraRegions?: Record<string, string>,
  // Round 3, code-reviewer blocker 1: the opposite finding to `extraRegions`
  // — a path `previous.regions` still names but THIS run found the region no
  // longer applies to (the file was deleted, and the generic loop below just
  // wrote a fresh WHOLE-file rulebook in its place, a clean-repo install in
  // every sense). Named here, not re-derived: by the time this function
  // runs, the file already exists again (this run just wrote it), so a
  // filesystem check here could never tell "still region-tracked" apart from
  // "freshly whole-file-written" — only `initProject`, which saw the file's
  // state BEFORE its own writes, knows which one happened.
  dropRegions?: readonly string[],
): Promise<void> {
  const previous = await readManifest(repoDir);
  const name = projectNameFor(repoDir);
  // Round 2: a path ALREADY region-tracked by a previous run (carried
  // forward via `previous?.regions`, not only one this run itself just
  // appended via `extraRegions`) must stay excluded from `files`/`kept`
  // bookkeeping too — B2's "always left alone, idempotent" behaviour skips
  // it in the generic write loop, which otherwise reads as "the rig saw it
  // and left it" and would start tracking it under `kept` as well, on top
  // of `regions`. Round 3: a path THIS run drops from `regions` (see
  // `dropRegions` above) is excluded from this set too — it just became an
  // ordinary whole-file write, and `files` is where that belongs.
  const regionTrackedPaths = new Set([
    ...Object.keys(previous?.regions ?? {}).filter((rel) => !(dropRegions ?? []).includes(rel)),
    ...Object.keys(extraRegions ?? {}),
  ]);
  const files = { ...(previous?.files ?? {}) };
  for (const rel of written) {
    if (regionTrackedPaths.has(rel)) continue;
    files[rel] = sha256(contents.get(rel) ?? '');
  }
  const kept = { ...(previous?.kept ?? {}), ...(extraKept ?? {}) };
  for (const rel of written) delete kept[rel];
  for (const rel of skipped) {
    if (files[rel] !== undefined || regionTrackedPaths.has(rel)) continue; // the rig already vouches for it elsewhere
    const found = await readRegularFile(path.join(repoDir, rel));
    if (found === null) delete kept[rel];
    else kept[rel] = sha256(found);
  }
  for (const rel of dropKept ?? []) delete kept[rel];
  const regions = { ...(previous?.regions ?? {}) };
  for (const rel of dropRegions ?? []) delete regions[rel];
  Object.assign(regions, extraRegions ?? {});
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
    ...(Object.keys(regions).length > 0 ? { regions } : {}),
  };
  await writeManifest(repoDir, manifest);
}
