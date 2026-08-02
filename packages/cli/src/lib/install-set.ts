import { readFile } from 'node:fs/promises';
import { listTreeEntries } from './copy-tree.js';
import { substituteContent, substituteFileName } from './substitute.js';
import type { SubstitutionContext } from './substitute.js';
import { agentOsStackDir, agentOsUniversalDir } from '../templates.js';

/** One file an install owns: where it goes, where it came from, what it says. */
export interface InstalledFile {
  rel: string;
  /** Template file behind it, or `null` when the CLI generates the content. */
  source: string | null;
  content: string;
}

export interface Layer {
  name: string;
  dir: string;
}

/**
 * The agent-os layers of a target, in composition order. One definition, read
 * by `create` when it copies them and by `upgrade` when it refreshes them —
 * two lists would drift, and the one nobody looks at would be the wrong one.
 */
export function agentOsLayerDirs(stacks: readonly string[]): Layer[] {
  return [
    { name: 'agent-os/universal', dir: agentOsUniversalDir() },
    ...stacks.map((stack) => ({ name: `agent-os/stack/${stack}`, dir: agentOsStackDir(stack) })),
  ];
}

/**
 * Exactly the agent-os bytes `create` writes, for a given target and project.
 *
 * The skeleton is deliberately absent: after generation the code is the user's
 * project, not the rig's — `upgrade` refreshes the process layer and nothing
 * else. Layers claim disjoint paths (`composition.ts` refuses otherwise), so
 * this is a plain concatenation.
 *
 * 🔴 Two assumptions, both load-bearing and both true today: the layer is all
 * **text** (this reads every file as UTF-8; a template test pins it for the
 * process half) and none of it is **executable** (`upgrade` writes with a bare
 * `writeFile` and does not carry the mode across the way `copyTree` does —
 * nothing in `templates/agent-os` currently has a mode to carry). Adding the
 * first binary asset or executable script here means teaching both.
 */
export async function agentOsInstallSet(
  stacks: readonly string[],
  ctx: SubstitutionContext,
): Promise<InstalledFile[]> {
  const files: InstalledFile[] = [];
  for (const layer of agentOsLayerDirs(stacks)) {
    const entries = await listTreeEntries(layer.dir, {
      transformName: (name) => substituteFileName(name, ctx),
    });
    for (const entry of entries) {
      files.push({
        rel: entry.rel,
        source: entry.source,
        content: substituteContent(await readFile(entry.source, 'utf8'), ctx),
      });
    }
  }
  return files;
}
