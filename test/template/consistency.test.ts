import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesBelow } from '../helpers/scan-exclusions.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Phase 10: inside one rulebook there can be only one answer. Wherever the
// request path is spelled out, it must be this exact chain (suffixes like
// "+ event" are fine; a *different* chain is drift).
const CANONICAL_CHAIN = 'payload → handler → usecase → model';
const CHAIN_MENTION = /(payload|handler)\s*(\([^)]*\))?\s*→/;

// The walk is the shared one (RP-155): this scan roots at `.claude/`, where the
// worktree-task skill nests sibling checkouts, and a walker of its own once
// reported `.claude/worktrees/<name>/journal/2026-08.md:311` as this repo's
// drift — once per worktree present.
const walkMarkdown = (dir: string) => filesBelow(repoRoot, dir, { extension: '.md' });

describe('the layer chain is stated identically everywhere', () => {
  it('every mention of the request path uses the canonical chain', async () => {
    const roots = [path.join(repoRoot, 'templates'), path.join(repoRoot, '.claude')];
    const files = (await Promise.all(roots.map(walkMarkdown))).flat();
    files.push(path.join(repoRoot, 'CLAUDE.md'));

    const offences: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (CHAIN_MENTION.test(line) && !line.includes(CANONICAL_CHAIN)) {
          offences.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });
});
