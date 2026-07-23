import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentOsUniversalDir } from '../templates.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class InitError extends Error {}

export interface InitOptions {
  /** Report the plan, write nothing. */
  dryRun?: boolean;
  /** Overwrite an existing CLAUDE.md (the one file init will not clobber blindly). */
  force?: boolean;
}

interface Manifest {
  process: string[];
  architecture: string[];
  meta: string[];
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

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'layers.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/**
 * `init` installs only the PROCESS layer (hooks-and-reach brief §3/§4): rules
 * that assume nothing about the codebase shape. Architecture rules reference
 * `packages/core` and friends — installing them into an arbitrary repo would
 * describe a structure that does not exist, which is worse than no rule.
 *
 * CLAUDE.md is the meta file we bring, but never over an existing one.
 */
async function processFiles(manifest: Manifest): Promise<string[]> {
  // the process layer, plus CLAUDE.md as the map (guarded separately)
  return [...manifest.process, 'CLAUDE.md'];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function planInit(repoDir: string): Promise<InitPlan> {
  const manifest = await loadManifest();
  const files = await processFiles(manifest);
  const conflicts: string[] = [];
  for (const rel of files) {
    if (await exists(path.join(repoDir, rel))) conflicts.push(rel);
  }
  return { files: files.map((p) => ({ path: p })), conflicts };
}

export async function initProject(repoDir: string, options: InitOptions): Promise<InitResult> {
  const manifest = await loadManifest();
  const files = await processFiles(manifest);
  const universal = agentOsUniversalDir();

  // Refuse to clobber an existing CLAUDE.md unless forced — init edits
  // someone's working repository (brief §4, non-negotiable).
  if (!options.force && files.includes('CLAUDE.md')) {
    if (await exists(path.join(repoDir, 'CLAUDE.md'))) {
      throw new InitError(
        'This repo already has a CLAUDE.md. Refusing to overwrite it. ' +
          'Merge the agent-os map in by hand, or re-run with --force to replace it.',
      );
    }
  }

  const written: string[] = [];
  const skipped: string[] = [];
  const plannedCount = files.length;

  for (const rel of files) {
    const dest = path.join(repoDir, rel);
    const isForceableMeta = rel === 'CLAUDE.md';
    if ((await exists(dest)) && !(isForceableMeta && options.force)) {
      // never overwrite a file init did not write (a user's own copy)
      skipped.push(rel);
      continue;
    }
    if (options.dryRun) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(path.join(universal, rel)));
    written.push(rel);
  }

  return { written, skipped, plannedCount };
}
