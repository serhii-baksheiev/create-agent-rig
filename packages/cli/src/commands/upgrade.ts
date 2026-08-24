import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initInstallSet, projectNameFor } from './init.js';
import { hookFilesReferencedIn } from '../lib/init-settings.js';
import { loadHashHistory, presentInEveryRelease } from '../lib/history.js';
import type { HashHistory } from '../lib/history.js';
import { agentOsInstallSet, agentOsLayerDirs } from '../lib/install-set.js';
import type { InstalledFile } from '../lib/install-set.js';
import { listTree } from '../lib/copy-tree.js';
import { readManifest, sha256, writeManifest } from '../lib/manifest.js';
import type { RigManifest, RigProject } from '../lib/manifest.js';
import { isSafeSubstitutionValue, resolveInside } from '../lib/safe-path.js';
import { detokenizeContent, substituteFileName } from '../lib/substitute.js';
import type { SubstitutionContext } from '../lib/substitute.js';
import { TARGETS } from '../lib/targets.js';
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
  | 'wiring';

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

/** The universal layer's architecture group — installed by `create`, never by `init`. */
const ARCHITECTURE_ONLY = [
  '.claude/rules/architecture.md',
  '.claude/hooks/guard-core-purity.mjs',
  '.claude/hooks/guard-web-boundary.mjs',
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

/**
 * The file's bytes, or `null` when it is genuinely **absent**.
 *
 * Only "not there" is absence. Any other failure — a permission, a directory
 * where a file should be, a path this command refuses to touch — is rethrown,
 * because "I could not read your file" must never become "so I wrote mine over
 * it": every caller of this treats `null` as grounds to install.
 */
async function readIfPresent(repoDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(onDisk(repoDir, rel), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Every stack overlay any target composes — the candidates a rig can carry. */
function knownStacks(): string[] {
  return [...new Set(Object.values(TARGETS).flatMap((t) => t.stacks))];
}

/**
 * What a rig with no manifest looks like it is, from the files it has.
 *
 * Two signals, because one file is too thin a thread to hang a project's map
 * on: the architecture rules and hooks, which `create` installs and `init`
 * deliberately does not, **and** any stack-overlay file at all — `init`
 * composes no overlays, so one of those is proof on its own. The region comes
 * from the target whose stack set matches; it is the only value substitution
 * needs that the directory name cannot give.
 *
 * 🔴 Limit: a `create` rig that deleted every architecture file *and* every
 * stack file reads as an `init` rig. It is then offered the `init` flavour of
 * `CLAUDE.md` — a map of a different project shape. Nothing but a manifest
 * distinguishes those two rigs, which is why 0.4.0 writes one.
 */
async function detectInstall(
  repoDir: string,
): Promise<{ kind: 'create' | 'init'; stacks: string[]; region: string }> {
  const ctx: SubstitutionContext = { projectName: '', projectScope: '', region: '' };
  const stacks: string[] = [];
  for (const stack of knownStacks()) {
    const [layer] = agentOsLayerDirs([stack]).slice(1);
    if (layer === undefined) continue;
    const rels = await listTree(layer.dir, {
      transformName: (name) => substituteFileName(name, ctx),
    });
    for (const rel of rels) {
      if (await exists(onDisk(repoDir, rel))) {
        stacks.push(stack);
        break;
      }
    }
  }
  let architectural = stacks.length > 0;
  for (const rel of ARCHITECTURE_ONLY) {
    if (architectural) break;
    architectural = await exists(onDisk(repoDir, rel));
  }
  if (!architectural) return { kind: 'init', stacks: [], region: '' };

  const target = Object.values(TARGETS).find(
    (t) => t.stacks.length === stacks.length && t.stacks.every((s) => stacks.includes(s)),
  );
  return { kind: 'create', stacks, region: target?.defaultRegion ?? '' };
}

async function installSetFor(
  repoDir: string,
  kind: 'create' | 'init',
  project: RigProject,
  stacks: readonly string[],
): Promise<InstalledFile[]> {
  if (kind === 'init') return initInstallSet(repoDir, project);
  return agentOsInstallSet(stacks, {
    projectName: project.name,
    projectScope: project.scope,
    region: project.region,
  });
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
  content: string,
  ctx: SubstitutionContext,
): boolean {
  const known = history.files[rel];
  if (known === undefined || known.hashes.length === 0) return false;
  const candidates = new Set([sha256(content), sha256(detokenizeContent(content, ctx))]);
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
  // Detection is a whole-tree probe, and it answers a question the manifest
  // has already answered when there is one.
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
  // Only overlays this version actually ships. An unknown name is not input
  // being dropped — there is no layer behind it to install from — and reading
  // a directory a manifest names would be reading a directory a manifest names.
  const shipped = new Set(knownStacks());
  const stacks = (manifest?.stacks ?? detected.stacks).filter((stack) => shipped.has(stack));
  const history = options.history ?? (await loadHashHistory());
  const files = await installSetFor(repoDir, kind, project, stacks);

  const ctx: SubstitutionContext = {
    projectName: project.name,
    projectScope: project.scope,
    region: project.region,
  };
  const actions: UpgradeAction[] = [];
  const contents = new Map<string, string>();
  const nextFiles: Record<string, string> = {};
  let wiring: string | null = null;
  const wiringByPath = new Map<string, string>();

  for (const file of files) {
    const current = await readIfPresent(repoDir, file.rel);
    const recorded = manifest?.files[file.rel];
    contents.set(file.rel, file.content);

    if (current === null) {
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
      ? recorded !== undefined && sha256(current) === recorded
      : (recorded !== undefined && sha256(current) === recorded) ||
        isReleasedVersion(history, file.rel, current, ctx);

    if (current === file.content) {
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
      actions.push({
        rel: file.rel,
        verdict: 'conflict',
        reason:
          recorded === undefined
            ? 'not a version this rig ever released — treated as yours'
            : 'edited since it was installed',
        templatePath: file.source,
      });
      // deliberately NOT recorded: the rig does not own these bytes
    }
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
    actions,
    wiring,
    wiringByPath,
    contents,
    manifest: {
      version: await packageVersion(),
      kind,
      project,
      stacks: [...stacks],
      files: nextFiles,
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

  for (const action of plan.actions) {
    if (action.verdict !== 'update' && action.verdict !== 'new') continue;
    const content = plan.contents.get(action.rel);
    // Never a silent empty file: a missing entry is a defect in the plan, and
    // truncating somebody's rule file is the worst way to report one.
    if (content === undefined) {
      throw new UpgradeError(`Internal: no content planned for "${action.rel}" — nothing written.`);
    }
    const dest = onDisk(repoDir, action.rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
    written.push(action.rel);
  }
  await writeManifest(repoDir, plan.manifest);
  return { written };
}
