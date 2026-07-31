import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { initFileContents, initManifest } from '../../packages/cli/src/commands/init.js';
import { listTree } from '../../packages/cli/src/lib/copy-tree.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const initDir = path.join(repoRoot, 'templates', 'agent-os', 'init');

/**
 * References init installs on purpose without the file behind them. Each needs
 * a reason, and CLAUDE.md must say the same thing to the reader — a silently
 * absent file is exactly the "gate looking at nothing" failure.
 */
const DOCUMENTED_ABSENT: Record<string, string> = {
  '.claude/hooks/dod-checks.json':
    'the stack layer supplies the DoD checks; init cannot know this repo’s commands',
};

async function installed(): Promise<Map<string, string>> {
  return initFileContents('/tmp/example-repo');
}

describe('the init layer installs a rig with no dangling references', () => {
  it('references no .claude file it does not install', async () => {
    const files = await installed();
    const present = new Set(files.keys());
    const offences: string[] = [];
    const reference = /\.claude\/[A-Za-z0-9._\-/]+\.(?:md|mjs|json)/g;
    for (const [rel, content] of files) {
      for (const match of content.matchAll(reference)) {
        const target = match[0];
        if (present.has(target)) continue;
        if (target in DOCUMENTED_ABSENT) continue;
        offences.push(`${rel} -> ${target}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('explains every reference it leaves deliberately unbacked', async () => {
    const claudeMd = (await installed()).get('CLAUDE.md');
    expect(claudeMd).toBeDefined();
    for (const target of Object.keys(DOCUMENTED_ABSENT)) {
      expect(claudeMd, target).toContain(path.basename(target));
    }
  });

  it('wires every hook it installs, and only those', async () => {
    const files = await installed();
    const settings = files.get('.claude/settings.json');
    expect(settings, 'init must ship the wiring, or the hooks never run').toBeDefined();
    const wired = [...settings!.matchAll(/\.claude\/hooks\/([A-Za-z0-9._-]+\.mjs)/g)].map(
      (m) => m[1],
    );
    const shipped = [...files.keys()]
      .filter((rel) => rel.startsWith('.claude/hooks/') && rel.endsWith('.mjs'))
      .map((rel) => path.basename(rel));
    expect([...new Set(wired)].sort()).toEqual(shipped.sort());
  });

  it('substitutes every token — a token in a filename is a dead kill switch', async () => {
    for (const [rel, content] of await installed()) {
      expect(content, rel).not.toContain('__PROJECT_NAME__');
      expect(content, rel).not.toContain('__PROJECT_SCOPE__');
      expect(content, rel).not.toContain('__REGION__');
    }
  });

  it('installs only text files — substitution would corrupt anything else', async () => {
    for (const { rel, source } of await initManifest()) {
      if (source === null) continue;
      const buffer = await readFile(source);
      expect(buffer.subarray(0, 8192).includes(0), rel).toBe(false);
    }
  });
});

describe('templates/agent-os/init is an override layer, not a second copy', () => {
  it('overrides only files the universal layer also has', async () => {
    const overrides = await listTree(initDir);
    expect(overrides.length).toBeGreaterThan(0);
    for (const rel of overrides) {
      await expect(stat(path.join(universalDir, rel)), rel).resolves.toBeDefined();
    }
  });

  it('is reached by init and by nothing else — `create` composes universal + stack only', async () => {
    const sources = (await initManifest()).map((f) => f.source);
    expect(sources.some((s) => s !== null && s.startsWith(initDir))).toBe(true);
  });
});
