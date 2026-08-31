import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { run, runNpx } from './run.js';

// Phase 8.3: the npm-publish path differs from the git path exactly where
// scaffolders classically break — the packed file set and the file modes.
// This test walks the full path: pack → install tarball → generate → assert.
describe('npm pack → install → generate (the publish path)', () => {
  let work: string;
  // Packed once for the whole e2e project — see test/e2e/pack-once.ts.
  const tarball = inject('tarball');
  const packedPaths = inject('packedPaths');

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-pack-'));

    for (const target of ['aws-serverless', 'node-service']) {
      const appDir = path.join(work, target);
      await mkdir(appDir);
      // runNpx, not a bare exec — the sibling install path of RP-70: an install
      // that does not complete must say why, in the run that saw it.
      await runNpx(
        ['--yes', `--package=${tarball}`, 'create-agent-rig', 'app', '--target', target],
        { cwd: appDir, env: { ...process.env, npm_config_cache: path.join(work, 'npx-cache') } },
      );
    }
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('the tarball carries the un-dotted gitignore (npm strips the dotted form)', () => {
    for (const target of ['aws-serverless', 'node-service']) {
      expect(packedPaths).toContain(`templates/skeleton/${target}/gitignore`);
      expect(packedPaths).not.toContain(`templates/skeleton/${target}/.gitignore`);
    }
  });

  it('the tarball keeps lockfiles, agent-os and workflows, but no run artifacts', () => {
    for (const target of ['aws-serverless', 'node-service']) {
      expect(packedPaths).toContain(`templates/skeleton/${target}/pnpm-lock.yaml`);
      expect(packedPaths).toContain(`templates/skeleton/${target}/.github/workflows/ci.yml`);
      expect(packedPaths).toContain(`templates/skeleton/${target}/apps/web/package.json`);
      // in-place web build artifacts stay out of the tarball
      expect(packedPaths).not.toContain(`templates/skeleton/${target}/apps/web/next-env.d.ts`);
    }
    expect(packedPaths).toContain('templates/agent-os/universal/.claude/settings.json');
    expect(packedPaths).toContain('templates/agent-os/universal/AGENTS.md');
    expect(packedPaths).toContain('templates/agent-os/universal/.codex/hooks.json');
    expect(packedPaths).toContain('templates/agent-os/universal/.agents/skills/pr-ship/SKILL.md');
    expect(packedPaths).toContain('templates/agent-os/universal/.claude/skills/pr-ship/SKILL.md');
    expect(packedPaths).toContain(
      'templates/agent-os/stack/aws-cdk/.claude/skills/post-deploy-verify/SKILL.md',
    );
    expect(packedPaths.some((p) => /node_modules|cdk\.out|\/var\/|\.tsbuildinfo/.test(p))).toBe(
      false,
    );
  });

  it('projects generated from the tarball have the full dotted file set', async () => {
    for (const target of ['aws-serverless', 'node-service']) {
      const projectDir = path.join(work, target, 'app');
      const gitignore = await readFile(path.join(projectDir, '.gitignore'), 'utf8');
      expect(gitignore, target).toContain('node_modules');
      await expect(readFile(path.join(projectDir, 'gitignore'), 'utf8')).rejects.toThrow();
      await expect(readFile(path.join(projectDir, '.npmignore'), 'utf8')).rejects.toThrow();
      for (const p of [
        '.claude/settings.json',
        '.claude/hooks/guard-core-purity.mjs',
        '.github/workflows/ci.yml',
        'pnpm-lock.yaml',
        'CLAUDE.md',
        'AGENTS.md',
        '.codex/hooks.json',
        '.agents/skills/pr-ship/SKILL.md',
      ]) {
        await expect(
          readFile(path.join(projectDir, p), 'utf8'),
          `${target}/${p}`,
        ).resolves.toBeTruthy();
      }
    }
  });

  it('the tarball ships the npm landing files', () => {
    expect(packedPaths).toContain('LICENSE');
    expect(packedPaths).toContain('README.md');
  });

  // U-0: an upgrade can only recognise a manifest-less rig if the released
  // hashes travel with the package. Left out of the tarball, `upgrade` would
  // still run and would call every file on a 0.3.x rig a conflict.
  it('the tarball carries the released-hash table', () => {
    expect(packedPaths).toContain('templates/hash-history.json');
  });

  it('generated projects record what the rig installed, and nothing more', async () => {
    for (const target of ['aws-serverless', 'node-service']) {
      const projectDir = path.join(work, target, 'app');
      const manifest = JSON.parse(
        await readFile(path.join(projectDir, '.claude', '.rig-manifest.json'), 'utf8'),
      ) as { kind: string; stacks: string[]; files: Record<string, string> };
      expect(manifest.kind, target).toBe('create');
      expect(manifest.files['.claude/rules/workflow.md'], target).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.stacks, target).toContain('node-ts');
      // the skeleton is the project's own code from the first commit on — an
      // upgrade refreshes the process layer and never reaches into it
      expect(
        Object.keys(manifest.files).some((rel) => rel.startsWith('packages/')),
        target,
      ).toBe(false);
    }
  });

  // Brief §6: per target — a single-target gate would bake a blind spot in.
  // This turns "the files are there" into "the project works", and catches a
  // broken @app/ scope rewrite (workspace deps resolve only if consistent).
  it('a generated node-service project from the tarball passes its own checks', async () => {
    const projectDir = path.join(work, 'node-service', 'app');
    await run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir });
    await run('pnpm', ['check'], { cwd: projectDir });
  });

  it('a generated aws-serverless project from the tarball passes its own checks', async () => {
    const projectDir = path.join(work, 'aws-serverless', 'app');
    await run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir });
    await run('pnpm', ['check'], { cwd: projectDir });
  });

  it('file modes survive the pack → generate path', async () => {
    // every generated file must stay readable/writable; spot-check that modes
    // came from the template, not from writeFile defaults (0o666 & umask)
    const probe = path.join(work, 'node-service', 'app', '.claude', 'hooks', 'block-no-verify.mjs');
    const mode = (await stat(probe)).mode & 0o777;
    expect(mode & 0o400).not.toBe(0);
  });
});
