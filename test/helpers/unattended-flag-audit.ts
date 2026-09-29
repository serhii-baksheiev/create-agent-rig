import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The literal, unsubstituted flag basename every test in this tree writes —
 * `__PROJECT_NAME__-loop-UNATTENDED`, or the checkout-scoped form
 * `__PROJECT_NAME__-<16-hex-char-hash>-loop-UNATTENDED` (`scopedBasename`,
 * unattended-flag.mjs). RP-271, independent-oracle rule
 * (`.claude/rules/invariants.md`): this pattern is a second, hand-written copy
 * of the shape — never a call into unattended-flag.mjs's own hashing — so this
 * module cannot be satisfied merely by production checking its own work.
 */
const FLAG_PATTERN = /^__PROJECT_NAME__(-[0-9a-f]{16})?-loop-UNATTENDED$/;

/** One home directory's `.claude` listing, as of the moment it was taken. */
export interface Snapshot {
  home: string;
  existing: Set<string>;
}

async function listFlags(home: string): Promise<Set<string>> {
  const dir = path.join(home, '.claude');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: no `.claude` yet. ENOTDIR: `home` itself is a file, not a
    // directory — a home that has never been a directory reads the same as
    // one with no `.claude` in it, not as a leak-audit failure.
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Set();
    throw new Error(`RP-271 leak audit: cannot read ${home}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return new Set(entries.filter((name) => FLAG_PATTERN.test(name)));
}

/** Snapshots the scoped-flag names already present under each home's `.claude`. */
export async function snapshotUnattendedFlags(homes: string[]): Promise<Snapshot[]> {
  return Promise.all(homes.map(async (home) => ({ home, existing: await listFlags(home) })));
}

/**
 * Every scoped-flag path present now, under one of the snapshotted homes, that
 * was not present at snapshot time. Tolerates a `.claude` directory that still
 * does not exist.
 */
export async function newUnattendedFlags(snapshot: Snapshot[]): Promise<string[]> {
  const leaked: string[] = [];
  for (const { home, existing } of snapshot) {
    const dir = path.join(home, '.claude');
    const current = await listFlags(home);
    for (const name of current) {
      if (!existing.has(name)) leaked.push(path.join(dir, name));
    }
  }
  return leaked;
}
