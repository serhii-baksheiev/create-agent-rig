import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { templatesRoot } from '../templates.js';

/**
 * The hashes every released version of every agent-os file had.
 *
 * Rigs installed before the manifest existed (0.3.x) cannot be asked what they
 * installed, so the package carries the answer instead: a file whose bytes
 * match **any** released version was not edited and is safe to replace.
 *
 * Generated from git tags by `scripts/build-hash-history.mjs` at release time
 * — never maintained by hand, because a table nobody can verify is a table
 * that lies in the direction of overwriting someone's work.
 */
export interface HistoryEntry {
  /** The oldest released version that carried this path. */
  since: string;
  /** Every hash the path has had, deduplicated. */
  hashes: string[];
}

export interface HashHistory {
  /** Released versions the table was built from, oldest first. */
  versions: string[];
  /** Install-relative path → what that path has been. */
  files: Record<string, HistoryEntry>;
}

export const EMPTY_HISTORY: HashHistory = { versions: [], files: {} };

/**
 * Whether every release this table knows about carried this path.
 *
 * It is the one question that lets a manifest-less rig keep a **deletion**: if
 * the file shipped in every version the rig could possibly be, then it is gone
 * because somebody removed it — not because the rig predates it. A path added
 * later is genuinely new to an older rig and must still be delivered.
 */
export function presentInEveryRelease(history: HashHistory, rel: string): boolean {
  const oldest = history.versions[0];
  const entry = history.files[rel];
  return oldest !== undefined && entry !== undefined && entry.since === oldest;
}

export function historyPath(): string {
  return path.join(templatesRoot(), 'hash-history.json');
}

/**
 * Fails open to an empty table: a missing or corrupt history means "nothing is
 * recognised", which downgrades files to conflicts. That is the safe
 * direction — the unsafe one is claiming a file is untouched when it is not.
 */
export async function loadHashHistory(): Promise<HashHistory> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(historyPath(), 'utf8'));
  } catch {
    return EMPTY_HISTORY;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_HISTORY;
  const { versions, files } = parsed as Partial<HashHistory>;
  if (!Array.isArray(versions) || typeof files !== 'object' || files === null) return EMPTY_HISTORY;
  const clean: Record<string, HistoryEntry> = {};
  for (const [rel, entry] of Object.entries(files)) {
    const { since, hashes } = (entry ?? {}) as Partial<HistoryEntry>;
    if (typeof since !== 'string') continue;
    if (!Array.isArray(hashes) || hashes.some((h) => typeof h !== 'string')) continue;
    clean[rel] = { since, hashes };
  }
  return { versions: versions.filter((v) => typeof v === 'string'), files: clean };
}
