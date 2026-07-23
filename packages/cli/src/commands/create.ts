import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTree } from '../lib/copy-tree.js';
import { substituteContent, substituteFileName } from '../lib/substitute.js';
import type { SubstitutionContext } from '../lib/substitute.js';
import { DEFAULT_TARGET, TARGETS } from '../lib/targets.js';
import { agentOsDir, skeletonDir } from '../templates.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class CreateError extends Error {}

export interface CreateOptions {
  cwd: string;
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

  const target = TARGETS[DEFAULT_TARGET];
  if (!target) {
    throw new CreateError(`Unknown target "${DEFAULT_TARGET}".`);
  }

  const ctx: SubstitutionContext = {
    projectName,
    projectScope: projectName,
    region: target.defaultRegion,
  };

  const transforms = {
    transformContent: (content: string) => substituteContent(content, ctx),
    transformName: (name: string) => substituteFileName(name, ctx),
  };

  await mkdir(projectDir, { recursive: true });
  // Layer 2: the code skeleton for the target…
  await copyTree(skeletonDir(target.skeletonDir), projectDir, transforms);
  // …then layer 1 on top: the agent operating system (CLAUDE.md + .claude/).
  await copyTree(agentOsDir('universal'), projectDir, transforms);

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
