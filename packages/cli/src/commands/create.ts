import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTree, listTree } from '../lib/copy-tree.js';
import { ALLOWED_OVERWRITES, detectCollisions } from '../lib/composition.js';
import { substituteContent, substituteFileName } from '../lib/substitute.js';
import type { SubstitutionContext } from '../lib/substitute.js';
import { DEFAULT_TARGET, TARGETS, TARGET_NAMES } from '../lib/targets.js';
import { agentOsStackDir, agentOsUniversalDir, skeletonDir } from '../templates.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class CreateError extends Error {}

export interface CreateOptions {
  cwd: string;
  /** Target name from the registry; defaults to {@link DEFAULT_TARGET}. */
  target?: string;
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
  const layers = [
    { name: `skeleton/${target.skeletonDir}`, dir: skeletonDir(target.skeletonDir) },
    { name: 'agent-os/universal', dir: agentOsUniversalDir() },
    ...target.stacks.map((stack) => ({
      name: `agent-os/stack/${stack}`,
      dir: agentOsStackDir(stack),
    })),
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

  return { projectDir, projectName };
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
