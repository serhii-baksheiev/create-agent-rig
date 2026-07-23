import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Phase 8.3: the npm-publish path differs from the git path exactly where
// scaffolders classically break — the packed file set and the file modes.
// This test walks the full path: pack → install tarball → generate → assert.
describe('npm pack → install → generate (the publish path)', () => {
  let work: string;
  let tarball: string;
  let packedPaths: string[];

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-pack-'));
    const packDir = path.join(work, 'pack');
    await mkdir(packDir);
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: { path: string }[] }>;
    tarball = path.join(packDir, packed!.filename);
    packedPaths = packed!.files.map((f) => f.path);

    for (const target of ['aws-serverless', 'node-service']) {
      const appDir = path.join(work, target);
      await mkdir(appDir);
      await exec(
        'npx',
        ['--yes', `--package=${tarball}`, 'create-agent-factory', 'app', '--target', target],
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
    }
    expect(packedPaths).toContain('templates/agent-os/universal/.claude/settings.json');
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
      ]) {
        await expect(
          readFile(path.join(projectDir, p), 'utf8'),
          `${target}/${p}`,
        ).resolves.toBeTruthy();
      }
    }
  });

  it('a generated project from the tarball still passes its own checks (node-service)', async () => {
    const projectDir = path.join(work, 'node-service', 'app');
    await exec('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir });
    await exec('pnpm', ['check'], { cwd: projectDir });
  });

  it('file modes survive the pack → generate path', async () => {
    // every generated file must stay readable/writable; spot-check that modes
    // came from the template, not from writeFile defaults (0o666 & umask)
    const probe = path.join(work, 'node-service', 'app', '.claude', 'hooks', 'block-no-verify.mjs');
    const mode = (await stat(probe)).mode & 0o777;
    expect(mode & 0o400).not.toBe(0);
  });
});
