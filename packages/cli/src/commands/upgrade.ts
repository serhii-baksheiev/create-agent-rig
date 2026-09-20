import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initInstallSet, layerOnlyPaths, projectNameFor } from './init.js';
import { hookFilesReferencedIn } from '../lib/init-settings.js';
import { loadHashHistory, presentInEveryRelease } from '../lib/history.js';
import type { HashHistory } from '../lib/history.js';
import { ALL_LAYERS, MANIFEST_REL, readManifest, sha256, writeManifest } from '../lib/manifest.js';
import type { Layer, RigManifest, RigProject } from '../lib/manifest.js';
import { isSafeSubstitutionValue, resolveInside, resolveWritableInside } from '../lib/safe-path.js';
import { packageVersion } from '../lib/version.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class UpgradeError extends Error {}

export type UpgradeVerdict =
  /** Installed by the rig, untouched since, and this release changed it. */
  | 'update'
  /** This release adds it; nothing on disk, nothing in the manifest. */
  | 'new'
  /** Already what this release would write. */
  | 'unchanged'
  /** Edited, or of unknown provenance — reported, never written. */
  | 'conflict'
  /** The manifest says we installed it; the user removed it. Stays removed. */
  | 'deleted'
  /** Hook wiring that is not replaceable: the released file is handed over. */
  | 'wiring'
  /**
   * The manifest says we installed it; this release's single payload no
   * longer ships it at all (RP-177 retired the per-target stack overlays and
   * the architecture-only group). Never written, never deleted — the rig
   * drops its claim and the path becomes the project's own, whatever state it
   * is in on disk.
   */
  | 'retired';

export interface UpgradeAction {
  rel: string;
  verdict: UpgradeVerdict;
  /** Why, for the verdicts a human has to act on. */
  reason?: string;
  /** Where the new version lives, so the diff can be done by hand. */
  templatePath?: string | null;
}

export interface UpgradePlan {
  kind: 'create' | 'init';
  /** The version that installed this rig — `null` when there was no manifest. */
  fromVersion: string | null;
  toVersion: string;
  /** True when provenance came from the hash history rather than a manifest. */
  bootstrapped: boolean;
  /**
   * What `detectLayersOnDisk` measured for each non-Core layer, or `null`
   * when there was a readable manifest to trust instead — the plan and the
   * summary read this to say when a layer was inferred, and from how much
   * evidence, rather than deciding silently.
   */
  layerInference: LayerInferenceNote[] | null;
  actions: UpgradeAction[];
  /** The first handed-over wiring file's released bytes, for CLI display. */
  wiring: string | null;
  /** Released wiring bytes handed over, keyed by their own path. */
  wiringByPath: Map<string, string>;
  /** New bytes per path — the report's payload, not part of the report. */
  contents: Map<string, string>;
  /** The manifest to leave behind once the plan is applied. */
  manifest: RigManifest;
}

export interface UpgradeOptions {
  /** Override the released-hash table (tests supply their own). */
  history?: HashHistory;
}

export interface ApplyOptions {
  dryRun?: boolean;
}

export interface UpgradeResult {
  written: string[];
}

const SETTINGS = '.claude/settings.json';
const CODEX_HOOKS = '.codex/hooks.json';
const WIRING_PATHS = new Set([SETTINGS, CODEX_HOOKS]);

// Files only the pre-0.10 `create` shape installed. They remain recognition
// evidence for upgrades even though none of them is shipped by the new single
// payload. Keeping their names here does not restore a stack or architecture
// promise; it preserves the identity those old bytes were substituted with.
const LEGACY_CREATE_MARKERS = [
  '.claude/rules/architecture.md',
  '.claude/hooks/guard-core-purity.mjs',
  '.claude/hooks/guard-web-boundary.mjs',
  '.claude/rules/node-ts.md',
  '.claude/rules/aws-cdk.md',
  '.claude/agents/cdk-diff-reviewer.md',
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * What was measured for one non-Core layer while bootstrapping — surfaced on
 * `UpgradePlan.layerInference` so the plan text and summary can say why a
 * layer was (or was not) adopted, rather than silently deciding.
 */
export interface LayerInferenceNote {
  layer: Layer;
  /** How many of the layer's own files are on disk right now. */
  present: number;
  /** How many files `layers.json` lists for the layer. */
  total: number;
  /** Whether `present` cleared {@link LAYER_ADOPTION_QUORUM}. */
  adopted: boolean;
}

/**
 * The quorum a bootstrapped, opt-in layer must clear to be adopted: MORE
 * THAN HALF of its own files already on disk (RP-180 round 4, blocker A).
 *
 * Chosen from the two populations this has to tell apart, not from either
 * one's exact size: a genuine workflow rig with a deleted or corrupted
 * manifest still has (nearly) all ~33 of its files on disk — comfortably
 * over half. A Core-only rig that happens to have a stray file sharing a
 * workflow-layer path (a hand-placed `journal/README.md`, a `.claude/
 * queue.json` written for something unrelated) has one, or a small handful
 * — comfortably under half. The threshold does not need to sit close to
 * either population; it needs to separate them, and a strict majority does
 * that with room on both sides. Pinned in `packages/cli/test/upgrade.test.ts`
 * › `describe('upgrade — the layer-adoption quorum on the bootstrapped path
 * (RP-180 round 4, blocker A)')`.
 */
export const LAYER_ADOPTION_QUORUM = 0.5;

/**
 * Which layer(s) to treat as installed when there is no manifest to read at
 * all — `readManifest` returns `null` both for a genuinely missing file and
 * for one `parseManifest` voided over ANY invalid field (a corrupt `layers`,
 * an unsafe `version`, a non-array `stacks`, …), so this path is reached far
 * more often than "this rig predates the manifest" alone.
 *
 * Two defects lived here in turn. The first (round 3): the fallback was
 * `ALL_LAYERS` unconditionally — `presentInEveryRelease` below does not save
 * it, since that guard only covers paths the hash history already has an
 * entry for, and a workflow file added for the first time has none. The
 * second (round 4, blocker A): the round-3 fix asked only "does AT LEAST ONE
 * of this layer's files exist", so a Core-only rig with a single stray file
 * sharing a workflow-layer path — the user's own `journal/README.md` is
 * enough — re-adopted the WHOLE ~33-file layer the moment the manifest broke
 * for any reason.
 *
 * The fix is a quorum, not a presence check: an opt-in layer is adopted only
 * when {@link LAYER_ADOPTION_QUORUM} of its own files are already there.
 * `process` is never put through this — it is not opt-in, and is normalised
 * into the result unconditionally below, so a `layers` this function returns
 * can never lack it (a `["workflow"]`-only result would leave every
 * enforcement hook unowned). Below quorum, a layer's stray files are left
 * alone entirely: not read into the plan, not adopted into the manifest —
 * see the caller in `planUpgrade` for how "adopted" also bounds what gets
 * WRITTEN (an adopted layer's ABSENT files are still never created).
 */
export async function detectLayersOnDisk(
  repoDir: string,
): Promise<{ layers: Layer[]; notes: LayerInferenceNote[] }> {
  const notes: LayerInferenceNote[] = [];
  const adopted = new Set<Layer>();
  for (const layer of ALL_LAYERS) {
    if (layer === 'process') continue; // never opt-in; normalised in below regardless of measurement
    const paths = await layerOnlyPaths(layer);
    let present = 0;
    for (const rel of paths) {
      if (await exists(onDisk(repoDir, rel))) present += 1;
    }
    const isAdopted = present > paths.length * LAYER_ADOPTION_QUORUM;
    notes.push({ layer, present, total: paths.length, adopted: isAdopted });
    if (isAdopted) adopted.add(layer);
  }
  // `process` is always present in the result — never a measurement, a
  // normalisation, so a bootstrapped `layers` can never lack Core.
  const layers: Layer[] = ['process', ...adopted];
  return { layers, notes };
}

/**
 * Where `rel` lives inside the rig — refused outright if it lands anywhere
 * else. Nothing should be able to produce such a path once the manifest is
 * validated, which is exactly why this stays: the whole command is writes into
 * somebody's repository, and a containment check is cheap next to the cost of
 * being wrong about that.
 */
function onDisk(repoDir: string, rel: string): string {
  const dest = resolveInside(repoDir, rel);
  if (dest === null) {
    throw new UpgradeError(`Refusing to touch "${rel}" — it resolves outside ${repoDir}.`);
  }
  return dest;
}

async function writableOnDisk(repoDir: string, rel: string): Promise<string> {
  const dest = await resolveWritableInside(repoDir, rel);
  if (dest === null) {
    throw new UpgradeError(`Refusing to touch "${rel}" through a symlink or outside ${repoDir}.`);
  }
  return dest;
}

/**
 * The file's bytes, or `null` when it is genuinely **absent**.
 *
 * Only "not there" is absence. Any other failure — a permission, a directory
 * where a file should be, a path this command refuses to touch — is rethrown,
 * because "I could not read your file" must never become "so I wrote mine over
 * it": every caller of this treats `null` as grounds to install.
 */
async function readIfPresent(repoDir: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(await writableOnDisk(repoDir, rel));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * What a rig with no manifest looks like it is, from the files it has.
 *
 * RP-177 ships only one payload, but a pre-0.10 rig may still carry files that
 * only `create` installed. Those retired paths are compatibility evidence: the
 * new release never installs them, yet their presence preserves the raw
 * directory identity old `create` substituted (including a trailing `-`).
 * A readable manifest remains the stronger source and bypasses this heuristic.
 */
async function detectInstall(
  repoDir: string,
): Promise<{ kind: 'create' | 'init'; stacks: string[]; region: string }> {
  for (const rel of LEGACY_CREATE_MARKERS) {
    if (await exists(onDisk(repoDir, rel))) return { kind: 'create', stacks: [], region: '' };
  }
  return { kind: 'init', stacks: [], region: '' };
}

/**
 * Whether these bytes are a released version of this file.
 *
 * Two candidates are offered to the table: the bytes as they sit, and the
 * bytes with the project's own values turned back into tokens — released
 * template bytes carry `__PROJECT_NAME__`, installed bytes never do.
 */
function isReleasedVersion(
  history: HashHistory,
  rel: string,
  content: Buffer,
  projectName: string,
): boolean {
  const known = history.files[rel];
  if (known === undefined || known.hashes.length === 0) return false;
  const candidates = new Set([sha256(content)]);
  const decoded = content.toString('utf8');
  // Detokenization is a text operation. Invalid UTF-8 must not be rewritten
  // through replacement characters and then mistaken for released bytes.
  // The raw-byte candidate above remains authoritative either way.
  if (Buffer.from(decoded, 'utf8').equals(content)) {
    const detokenized =
      projectName === '' ? decoded : decoded.replaceAll(projectName, '__PROJECT_NAME__');
    candidates.add(sha256(detokenized));
  }
  return known.hashes.some((hash) => candidates.has(hash));
}

/**
 * Would writing `next` over `current` stop calling a hook that is still there?
 *
 * The one question the hash arms cannot answer. They prove the bytes belong to
 * the rig; they do not prove the replacement wires the same hooks, and
 * Wiring files have flavours that differ in exactly that. A hook file
 * still on disk with nothing wired to it is the quiet failure
 * `lib/init-settings.ts` names: the rules claim it is enforced and nothing ever
 * calls it.
 *
 * Only hooks whose FILE is still present count. One the user deleted on purpose
 * is not being silenced by this write — it was already gone.
 */
async function unwiresAnInstalledHook(
  repoDir: string,
  current: string,
  next: string,
): Promise<boolean> {
  const nextHooks = hookFilesReferencedIn(next);
  for (const hook of hookFilesReferencedIn(current)) {
    if (nextHooks.has(hook)) continue;
    const onDisk = resolveInside(repoDir, hook);
    if (onDisk !== null && (await exists(onDisk))) return true;
  }
  return false;
}

/**
 * What an upgrade would do, decided per file, writing nothing.
 *
 * The rule is the whole design: **replace what the rig installed and the user
 * did not touch; report everything else.** There is no three-way merge and no
 * patching — silently merging someone's edits into a file the agent loop obeys
 * is how a rig stops meaning what its owner thinks it means.
 */
export async function planUpgrade(
  repoDir: string,
  options: UpgradeOptions = {},
): Promise<UpgradePlan> {
  const manifest = await readManifest(repoDir);
  // Old create-only files are no longer shipped, but while they remain in a
  // pre-0.10 rig they still distinguish its substitution identity. A readable
  // manifest remains authoritative whenever one exists.
  const detected =
    manifest === null
      ? await detectInstall(repoDir)
      : { kind: manifest.kind, stacks: manifest.stacks, region: manifest.project.region };
  const kind = manifest?.kind ?? detected.kind;
  // With no manifest to read, guess the name the rig's own files were written
  // with — and each command wrote them differently, so the guess branches the
  // same way:
  //
  // - `init` substitutes the **slug** and records the slug (`init.ts`,
  //   `projectNameFor` in both places), so for an init rig the slug is not an
  //   approximation, it is the value;
  // - `create` substitutes the name it was **given**, having validated it — and
  //   that validation accepts a trailing `-` or `.`, which `projectNameFor`
  //   strips. So slugging a create rig renames it: `my-app.` became `my-app`,
  //   stopped matching its own installed files, and returned four of them as
  //   conflicts.
  //
  // The one case where the raw name cannot be kept is a directory the manifest
  // reader would refuse — `My App` produced `{"name":"My App"}`, which
  // `parseManifest` voids, so the manifest this command exists to write was
  // written and immediately unreadable, and every later run fell back to
  // matching against released versions. The condition is that reader's own
  // exported predicate, not a second copy of its rule.
  //
  // 🔴 All three branches were bought by a defect, and two of those defects
  // were introduced by fixing the other — the mirror is easy to miss, because
  // each fix looks total until the other kind is tried. Change nothing here
  // without running the three sibling cases in `upgrade.test.ts`.
  //
  // ⚠ It is still the *directory's* name, so a renamed or cloned rig with no
  // manifest bootstraps the new name and its substituted files come back as
  // conflicts — kept and reported, never overwritten. Committing the manifest
  // is what removes the guess, and that is unchanged from 0.4.0.
  const rawName = path.basename(path.resolve(repoDir));
  const bootstrapName =
    kind === 'init' || !isSafeSubstitutionValue(rawName) ? projectNameFor(repoDir) : rawName;
  const project: RigProject = manifest?.project ?? {
    name: bootstrapName,
    scope: bootstrapName,
    region: detected.region,
  };
  const history = options.history ?? (await loadHashHistory());
  // RP-180: which layer(s) this rig is allowed to have refreshed.
  //
  // - A readable manifest is authoritative, and `parseManifest` already
  //   resolves its own absence of `layers` to `ALL_LAYERS` (every release
  //   before RP-180 shipped one payload, so an old manifest with no such
  //   field installed everything) — so `manifest.layers` is never actually
  //   `undefined` here.
  // - No manifest at all (`bootstrapped` — `manifest === null`, which covers
  //   a genuinely missing file AND one `parseManifest` voided over ANY
  //   invalid field, not only a missing `layers` key) reads the candidate
  //   set off the disk itself, by quorum — see {@link detectLayersOnDisk}
  //   and its own history of what was tried here and why each attempt
  //   before it was not enough.
  const inference = manifest === null ? await detectLayersOnDisk(repoDir) : null;
  const layers: Layer[] = manifest?.layers ?? inference!.layers;
  // A path an OLDER manifest still names but this rig's OWN recorded layers
  // no longer cover (a manifest hand-edited to drop a layer, or one from a
  // release that shipped a layer this one renamed) falls out of `files`
  // below exactly like a path RP-177 retired outright: never written, never
  // deleted, simply no longer this plan's to manage.
  let files = await initInstallSet(repoDir, project, layers);
  // Blocker A's second half: even an ADOPTED bootstrapped opt-in layer must
  // never manufacture a file it did not find. Present files of an adopted
  // layer still flow through the ordinary per-file logic below (refreshed or
  // reported exactly as any other owned path); an ABSENT one is dropped from
  // the plan entirely here, before that loop ever sees it, so it can never
  // become a `new` verdict — inferring a layer from partial disk evidence is
  // not licence to fill in the rest of it.
  if (inference !== null) {
    const inferredOptInPaths = new Set<string>();
    for (const layer of inference.layers) {
      if (layer === 'process') continue;
      for (const rel of await layerOnlyPaths(layer)) inferredOptInPaths.add(rel);
    }
    if (inferredOptInPaths.size > 0) {
      const survivors = [];
      for (const file of files) {
        if (inferredOptInPaths.has(file.rel) && !(await exists(onDisk(repoDir, file.rel)))) {
          continue;
        }
        survivors.push(file);
      }
      files = survivors;
    }
  }

  const actions: UpgradeAction[] = [];
  const contents = new Map<string, string>();
  const nextFiles: Record<string, string> = {};
  let wiring: string | null = null;
  const wiringByPath = new Map<string, string>();

  for (const file of files) {
    const currentBytes = await readIfPresent(repoDir, file.rel);
    const recorded = manifest?.files[file.rel];
    contents.set(file.rel, file.content);

    if (currentBytes === null) {
      // Evidence, not a command. The manifest is the direct evidence; without
      // one, a path that shipped in *every* release the table covers was there
      // to be removed, so its absence is a decision. A path added later is
      // simply missing from an older rig, and that one is delivered.
      if (recorded !== undefined) {
        actions.push({
          rel: file.rel,
          verdict: 'deleted',
          reason: 'installed by the rig, removed since — not restored',
        });
        nextFiles[file.rel] = recorded;
      } else if (presentInEveryRelease(history, file.rel)) {
        actions.push({
          rel: file.rel,
          verdict: 'deleted',
          reason: `shipped in every release since ${history.versions[0]}, and is gone — not restored`,
        });
      } else {
        actions.push({ rel: file.rel, verdict: 'new', templatePath: file.source });
        nextFiles[file.rel] = sha256(file.content);
      }
      continue;
    }

    const current = currentBytes.toString('utf8');
    const currentHash = sha256(currentBytes);
    const releasedBytes = Buffer.from(file.content, 'utf8');

    // The two limits that keep wiring files' new replaceability from
    // disarming the rig, both measured rather than reasoned about.
    //
    // 1. The released-hash fallback is not enough for THIS file. Every other
    //    file has one flavour; this one has two — `create` wires all the hooks,
    //    `init` wires only the ones it installs — and they share a history
    //    entry. A manifest-less rig that ran `init` is recorded `kind: 'init'`,
    //    so matching a released hash would write the narrow wiring over the
    //    full one. The item asks for the manifest arm and says the rest is
    //    reported, which is also the reading with no regression behind it.
    // 2. Even the manifest arm is not enough on its own, because `kind` is
    //    trusted from a file that travels in pull requests. So the decision is
    //    gated on the wiring itself: if the replacement would stop calling a
    //    hook still sitting in `.claude/hooks/`, it is handed over. That check
    //    does not care which flavour anything claims to be.
    const isWiring = WIRING_PATHS.has(file.rel);
    const wouldUnwireAnInstalledHook =
      isWiring && (await unwiresAnInstalledHook(repoDir, current, file.content));
    const vouched = isWiring
      ? recorded !== undefined && currentHash === recorded
      : (recorded !== undefined && currentHash === recorded) ||
        isReleasedVersion(history, file.rel, currentBytes, project.name);

    if (currentBytes.equals(releasedBytes)) {
      actions.push({ rel: file.rel, verdict: 'unchanged' });
      nextFiles[file.rel] = sha256(file.content);
    } else if (vouched && !wouldUnwireAnInstalledHook) {
      actions.push({
        rel: file.rel,
        verdict: 'update',
        templatePath: file.source,
        // Every other replacement is routine; this one rewrites what calls the
        // guards, so it says so rather than arriving as one more `~` line.
        ...(isWiring ? { reason: 'the hook wiring, replaced — you never edited it' } : {}),
      });
      nextFiles[file.rel] = sha256(file.content);
    } else if (isWiring) {
      // Nothing vouches for these bytes, or replacing them would silence a hook
      // that is still installed. Either way this is the one file whose conflict
      // is a merge rather than a choice, so the released file is handed over.
      wiring = file.content;
      wiringByPath.set(file.rel, file.content);
      actions.push({
        rel: file.rel,
        verdict: 'wiring',
        // Say what was actually checked. This file no longer consults the
        // released-hash table (see the limits above), so it cannot claim these
        // bytes are not a release — only that the manifest does not vouch for
        // them, which is the check that ran.
        reason: wouldUnwireAnInstalledHook
          ? 'replacing it would stop calling a hook that is still installed — merge the entries below by hand'
          : recorded === undefined
            ? 'the manifest does not vouch for it — treated as yours, merge the entries below by hand'
            : 'edited since it was installed — merge the entries below by hand',
      });
      if (recorded !== undefined) nextFiles[file.rel] = recorded;
    } else {
      // A path `init` found and left alone carries its provenance in `kept`
      // (RP-182): the reason can then say what happened to the file since,
      // instead of only that no release ever shipped these bytes. It names no
      // version — `manifest.version` is rewritten by every upgrade, so it is
      // not the version of the init that kept the file.
      const kept = recorded === undefined ? manifest?.kept?.[file.rel] : undefined;
      const keptReason = (since: string): string =>
        `kept by init (already here, not the rig's bytes), ${since} since — treated as yours`;
      actions.push({
        rel: file.rel,
        verdict: 'conflict',
        reason:
          kept !== undefined
            ? keptReason(currentHash === kept ? 'unchanged' : 'edited')
            : recorded === undefined
              ? 'not a version this rig ever released — treated as yours'
              : 'edited since it was installed',
        templatePath: file.source,
      });
      // deliberately NOT recorded in `files`: the rig does not own these bytes
    }
  }

  // A path an OLDER manifest still names but this release's single payload no
  // longer contains at all (RP-177: the per-target stack overlays and the
  // architecture-only group are retired outright, not merely excluded from
  // one flavour). It is never written and never deleted — there is no
  // template behind it to write, and deleting a file this run does not even
  // read would be exactly the "resolve a stack name into a directory" step
  // this release removes. It simply drops out of `nextFiles`: the rig no
  // longer vouches for it, whatever state it is in on disk.
  //
  // Bootstrapped rigs (`manifest === null`) never reach this loop at all —
  // there is no `manifest.files` to diff the current install set against, so
  // "no longer shipped" has no `files` list to be true of. A claim with
  // nothing behind it is not a smaller retired list; it is not a claim.
  const currentRels = new Set(files.map((f) => f.rel));
  for (const rel of Object.keys(manifest?.files ?? {})) {
    if (currentRels.has(rel)) continue;
    actions.push({
      rel,
      verdict: 'retired',
      reason: 'no longer shipped by this release — the rig no longer manages it; it is now yours',
    });
    // deliberately NOT recorded in `nextFiles`: the rig drops its claim
  }

  // `kept` travels forward untouched, minus every path the plan now vouches
  // for in `files` — a kept file that turned out to be a released version, or
  // is byte-identical to this release, has become the rig's to manage.
  const nextKept: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(manifest?.kept ?? {})) {
    if (nextFiles[rel] === undefined) nextKept[rel] = hash;
  }

  // With no manifest, "there is a rig here" has to be *recognised*, not
  // assumed from a file existing: `CLAUDE.md` and `.claude/settings.json` are
  // in the install set and in nearly every repository ever opened by an agent.
  // Recognition means bytes we know — a file already current, or one that
  // matches a released version. Without that this command would silently
  // perform an `init` nobody asked for.
  if (
    manifest === null &&
    !actions.some((a) => a.verdict === 'unchanged' || a.verdict === 'update')
  )
    throw new UpgradeError(
      `No rig found in ${repoDir}. Nothing here is recognisable as a create-agent-rig ` +
        'install — run `create-agent-rig init` to install the process layer, or upgrade ' +
        'from the directory that holds the rig.',
    );

  return {
    kind,
    fromVersion: manifest?.version ?? null,
    toVersion: await packageVersion(),
    bootstrapped: manifest === null,
    layerInference: inference?.notes ?? null,
    actions,
    wiring,
    wiringByPath,
    contents,
    manifest: {
      version: await packageVersion(),
      kind,
      project,
      // Always empty: the single payload has no overlays to record any more.
      // An older manifest's `stacks` is read (never crashes on an unknown
      // entry — RP-177) but never carried forward.
      stacks: [],
      // Carried forward unchanged: `upgrade` refreshes the layers a rig
      // already recorded, it never adds or drops one. Opting in happens
      // through `init --layer workflow`.
      layers,
      files: nextFiles,
      ...(Object.keys(nextKept).length > 0 ? { kept: nextKept } : {}),
    },
  };
}

/**
 * Write the plan: the `update` and `new` files, then the manifest. Everything
 * else in the plan is a sentence for a human, not an edit.
 */
export async function applyUpgrade(
  repoDir: string,
  plan: UpgradePlan,
  options: ApplyOptions = {},
): Promise<UpgradeResult> {
  const written: string[] = [];
  if (options.dryRun === true) return { written };

  // Preflight the complete write set, including the manifest, before changing
  // any file. Then re-check each destination after mkdir and immediately before
  // writeFile, so both pre-existing and newly-visible symlink components are
  // refused.
  const destinations = new Map<string, string>();
  for (const rel of [
    ...plan.actions
      .filter(({ verdict }) => verdict === 'update' || verdict === 'new')
      .map(({ rel }) => rel),
    MANIFEST_REL,
  ]) {
    destinations.set(rel, await writableOnDisk(repoDir, rel));
  }

  for (const action of plan.actions) {
    if (action.verdict !== 'update' && action.verdict !== 'new') continue;
    const content = plan.contents.get(action.rel);
    // Never a silent empty file: a missing entry is a defect in the plan, and
    // truncating somebody's rule file is the worst way to report one.
    if (content === undefined) {
      throw new UpgradeError(`Internal: no content planned for "${action.rel}" — nothing written.`);
    }
    const dest = destinations.get(action.rel)!;
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(await writableOnDisk(repoDir, action.rel), content);
    written.push(action.rel);
  }
  await writeManifest(repoDir, plan.manifest);
  return { written };
}
