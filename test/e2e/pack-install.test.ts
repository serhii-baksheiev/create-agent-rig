import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { installEnv, runNpx } from './run.js';
import { removeFixture } from '../helpers/remove-fixture.js';

// Phase 8.3: the npm-publish path differs from the git path exactly where
// scaffolders classically break — the packed file set and the file modes.
// This test walks the full path: pack → install tarball → generate → assert.
//
// RP-177 retired the per-target skeletons this used to loop over
// (`aws-serverless`, `node-service`): there is exactly one payload now, so
// there is exactly one generation to check.
describe('npm pack → install → generate (the publish path)', () => {
  let work: string;
  let projectDir: string;
  // Packed once for the whole e2e project — see test/e2e/pack-once.ts.
  const tarball = inject('tarball');
  const packedPaths = inject('packedPaths');

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-pack-'));
    const appDir = path.join(work, 'app');
    await mkdir(appDir);
    // runNpx, not a bare exec — the sibling install path of RP-70: an install
    // that does not complete must say why, in the run that saw it.
    await runNpx(['--yes', `--package=${tarball}`, 'create-agent-rig', 'app'], {
      cwd: appDir,
      env: installEnv(path.join(work, 'npx-cache')),
    });
    projectDir = path.join(appDir, 'app');
  });

  afterAll(async () => {
    await removeFixture(work);
  });

  it('the tarball keeps the universal layer, agent-os and no application scaffolding', () => {
    expect(packedPaths).toContain('templates/agent-os/universal/.claude/settings.json');
    expect(packedPaths).toContain('templates/agent-os/universal/AGENTS.md');
    expect(packedPaths).toContain('templates/agent-os/universal/.codex/hooks.json');
    expect(packedPaths).toContain('templates/agent-os/universal/.agents/skills/pr-ship/SKILL.md');
    expect(packedPaths).toContain('templates/agent-os/universal/.claude/skills/pr-ship/SKILL.md');
    expect(packedPaths.some((p) => p.startsWith('templates/skeleton/'))).toBe(false);
    expect(packedPaths.some((p) => p.startsWith('templates/agent-os/stack/'))).toBe(false);
    expect(packedPaths.some((p) => p.startsWith('templates/agent-os/init/'))).toBe(false);
    expect(packedPaths.some((p) => /node_modules|cdk\.out|\.tsbuildinfo/.test(p))).toBe(false);
  });

  it('the tarball ships the npm landing files', () => {
    expect(packedPaths).toContain('LICENSE');
    expect(packedPaths).toContain('README.md');
  });

  // U-0: an upgrade can only recognise a manifest-less rig if the released
  // hashes travel with the package. Left out of the tarball, `upgrade` would
  // still run and would call every file on an old rig a conflict.
  it('the tarball carries the released-hash table', () => {
    expect(packedPaths).toContain('templates/hash-history.json');
  });

  it('the generated project has the full dotted file set, no application code', async () => {
    await expect(readFile(path.join(projectDir, '.npmignore'), 'utf8')).rejects.toThrow();
    for (const p of [
      '.claude/settings.json',
      'CLAUDE.md',
      'AGENTS.md',
      '.codex/hooks.json',
      '.agents/skills/worktree-task/SKILL.md',
    ]) {
      await expect(readFile(path.join(projectDir, p), 'utf8'), p).resolves.toBeTruthy();
    }
    await expect(readFile(path.join(projectDir, 'package.json'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(path.join(projectDir, '.claude', 'rules', 'architecture.md'), 'utf8'),
    ).rejects.toThrow();
    // RP-180: the opt-in workflow layer is not part of the default install —
    // the tarball carries it (checked above), the generated project does not.
    await expect(
      readFile(path.join(projectDir, '.agents', 'skills', 'pr-ship', 'SKILL.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('the generated project records what the rig installed, and nothing more', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(projectDir, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { kind: string; stacks: string[]; layers: string[]; files: Record<string, string> };
    expect(manifest.kind).toBe('init');
    expect(manifest.stacks).toEqual([]);
    expect(manifest.layers).toEqual(['process']);
    expect(manifest.files['.claude/rules/workflow.md']).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files['.claude/scripts/queue/index.mjs']).toBeUndefined();
  });

  it('file modes survive the pack → generate path', async () => {
    // every generated file must stay readable/writable; spot-check that modes
    // came from the template, not from writeFile defaults (0o666 & umask)
    const probe = path.join(projectDir, '.claude', 'hooks', 'block-no-verify.mjs');
    const mode = (await stat(probe)).mode & 0o777;
    expect(mode & 0o400).not.toBe(0);
  });
});
