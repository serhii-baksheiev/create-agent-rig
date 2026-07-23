import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Phase 10: inside one rulebook there can be only one answer. Wherever the
// request path is spelled out, it must be this exact chain (suffixes like
// "+ event" are fine; a *different* chain is drift).
const CANONICAL_CHAIN = 'payload → handler → usecase → model';
const CHAIN_MENTION = /(payload|handler)\s*(\([^)]*\))?\s*→/;

async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      if (entry.name === 'node_modules') return Promise.resolve([]);
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkMarkdown(p);
      return Promise.resolve(entry.name.endsWith('.md') ? [p] : []);
    }),
  );
  return files.flat();
}

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
