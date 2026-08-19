import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { copyTree, listTree, mapConcurrent } from '../lib/copy-tree.js';
import { ALLOWED_OVERWRITES, detectCollisions } from '../lib/composition.js';
import { agentOsLayerDirs } from '../lib/install-set.js';
import { sha256, writeManifest } from '../lib/manifest.js';
import { substituteContent, substituteFileName } from '../lib/substitute.js';
import type { SubstitutionContext } from '../lib/substitute.js';
import { gitEnv } from '../lib/git-env.js';
import { DEFAULT_TARGET, TARGETS, TARGET_NAMES } from '../lib/targets.js';
import { skeletonDir } from '../templates.js';
import { packageVersion } from '../lib/version.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class CreateError extends Error {}

export interface CreateOptions {
  cwd: string;
  /** Target name from the registry; defaults to {@link DEFAULT_TARGET}. */
  target?: string;
  /**
   * Initialise git with a baseline commit (default true) so the first change —
   * human or agent — diffs against a pristine template. Never fatal: a missing
   * git skips silently.
   */
  git?: boolean;
}

export interface CreateResult {
  projectDir: string;
  projectName: string;
}

/** Valid npm package name (unscoped part) — also used as the npm scope. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export async function createProject(dirArg: string, options: CreateOptions): Promise<CreateResult> {
  const projectDir = path.resolve(options.cwd, dirArg);
  const projectName = path.basename(projectDir);

  if (!NAME_PATTERN.test(projectName)) {
    throw new CreateError(
      `Invalid project name "${projectName}": use lowercase letters, digits, ".", "_" and "-" ` +
        '(it becomes the npm package name and scope).',
    );
  }

  await ensureEmptyOrAbsent(projectDir);

  const targetName = options.target ?? DEFAULT_TARGET;
  const target = TARGETS[targetName];
  if (!target) {
    throw new CreateError(
      `Unknown target "${targetName}". Known targets: ${TARGET_NAMES.join(', ')}.`,
    );
  }

  const ctx: SubstitutionContext = {
    projectName,
    projectScope: projectName,
    region: target.defaultRegion ?? '',
  };

  const transforms = {
    transformContent: (content: string) => substituteContent(content, ctx),
    transformName: (name: string) => substituteFileName(name, ctx),
  };

  // Layer 2 (the skeleton) + layer 1 (agent-os: universal + stack overlays).
  const agentOsLayers = agentOsLayerDirs(target.stacks);
  const layers = [
    { name: `skeleton/${target.skeletonDir}`, dir: skeletonDir(target.skeletonDir) },
    ...agentOsLayers,
  ];

  // Composition safety: layers must claim disjoint paths. Checked before any
  // copy — a collision is a template bug and must never be resolved by order.
  const claimed = [];
  for (const layer of layers) {
    claimed.push({ name: layer.name, files: await listTree(layer.dir, transforms) });
  }
  const collisions = detectCollisions(claimed, ALLOWED_OVERWRITES);
  if (collisions.length > 0) {
    const detail = collisions
      .map((c) => `  ${c.path} — claimed by ${c.layers.join(' and ')}`)
      .join('\n');
    throw new CreateError(`Template layers collide (fix the templates, not the order):\n${detail}`);
  }

  await mkdir(projectDir, { recursive: true });
  for (const layer of layers) {
    await copyTree(layer.dir, projectDir, transforms);
  }

  await recordInstall(projectDir, agentOsLayers, transforms, ctx, targetName);

  if (options.git !== false) {
    await initGitBaseline(projectDir);
  }

  return { projectDir, projectName };
}

/**
 * Record the agent-os layer in `.claude/.rig-manifest.json`, so a later
 * `upgrade` can tell a file the rig wrote from a file the project's own people
 * changed.
 *
 * The skeleton is **not** recorded, and that is the boundary of the whole
 * upgrade story: once generated, the code belongs to the project. The hashes
 * are read back off the disk rather than recomputed, so the manifest states
 * what is actually there and cannot drift from what was copied. The manifest
 * lands before the baseline commit — it is part of the pristine template, and
 * it belongs in the project's git history.
 */
async function recordInstall(
  projectDir: string,
  agentOsLayers: readonly { dir: string }[],
  transforms: { transformName: (name: string) => string },
  ctx: SubstitutionContext,
  target: string,
): Promise<void> {
  const files: Record<string, string> = {};
  for (const layer of agentOsLayers) {
    const paths = await listTree(layer.dir, transforms);
    const hashes = await mapConcurrent(paths, 16, async (rel) => ({
      rel,
      hash: sha256(await readFile(path.join(projectDir, ...rel.split('/')), 'utf8')),
    }));
    for (const { rel, hash } of hashes) {
      files[rel] = hash;
    }
  }
  await writeManifest(projectDir, {
    version: await packageVersion(),
    kind: 'create',
    project: { name: ctx.projectName, scope: ctx.projectScope, region: ctx.region },
    stacks: [...(TARGETS[target]?.stacks ?? [])],
    files,
  });
}

const run = promisify(execFile);

async function initGitBaseline(projectDir: string): Promise<void> {
  // Disable git's background maintenance for these one-shot commands: a commit
  // can otherwise fork an auto-gc / maintenance process that keeps writing to
  // .git/objects/pack after we return — a non-deterministic tail that races any
  // caller cleaning up the directory, and pointless work on a one-commit repo.
  const quiet = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
  const where = { cwd: projectDir, env: gitEnv() };
  try {
    await run('git', [...quiet, 'init', '--quiet'], where);
    await run('git', [...quiet, 'add', '-A'], where);
    // Explicit identity: the baseline must commit even where git has no
    // global user configured (fresh machines, CI). --no-verify here shields
    // the baseline from the USER'S global hooks only — the generated
    // project's own gates do not exist yet, so nothing is being bypassed.
    await run(
      'git',
      [
        ...quiet,
        '-c',
        'user.name=create-agent-rig',
        '-c',
        'user.email=create-agent-rig@localhost',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'Pristine template (create-agent-rig)',
      ],
      where,
    );
  } catch {
    // git missing or unusable — generation never fails on this.
  }
}

async function ensureEmptyOrAbsent(dir: string): Promise<void> {
  let stats;
  try {
    stats = await stat(dir);
  } catch {
    return; // does not exist — fine
  }
  if (!stats.isDirectory()) {
    throw new CreateError(`Target "${dir}" exists and is not a directory.`);
  }
  const entries = await readdir(dir);
  if (entries.length > 0) {
    throw new CreateError(
      `Target directory "${dir}" is not empty (${entries.length} entries). ` +
        'Choose a new directory — the generator never overwrites existing files.',
    );
  }
}
