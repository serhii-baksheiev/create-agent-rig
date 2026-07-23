import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

// PLAN.md §8 item 2 — mandatory in CI: the generated project must install,
// lint, typecheck, test, and synth on its own, from a cold directory.
describe('generated aws-serverless project passes its own checks', () => {
  let work: string;
  let projectDir: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-genproj-'));
    projectDir = path.join(work, 'proof-app');
    await exec(process.execPath, [cliBin, 'proof-app'], { cwd: work });
    await exec('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir });
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('has every layer of the skeleton', async () => {
    for (const p of [
      'packages/core/src',
      'packages/shared/src',
      'packages/db/src',
      'services/api/src',
      'services/worker/src',
      'infra/lib',
      '.claude/settings.json',
      'CLAUDE.md',
      'README.md',
    ]) {
      await expect(exec('test', ['-e', path.join(projectDir, p)])).resolves.toBeTruthy();
    }
  });

  it('rewrote the placeholder scope everywhere', async () => {
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@proof-app/root');
    const { stdout } = await exec('grep', ['-rl', '@app/', '--include=*', '.'], {
      cwd: projectDir,
    }).catch((e) => e as { stdout: string });
    expect(stdout ?? '').toBe('');
  });

  it('passes lint', async () => {
    await exec('pnpm', ['lint'], { cwd: projectDir });
  });

  it('passes typecheck', async () => {
    await exec('pnpm', ['typecheck'], { cwd: projectDir });
  });

  it('passes its own test suite', async () => {
    await exec('pnpm', ['test'], { cwd: projectDir });
  });

  it('synthesizes its CDK stack', async () => {
    await exec('pnpm', ['synth'], { cwd: projectDir });
  });
});
