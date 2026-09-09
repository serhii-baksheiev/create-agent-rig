import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPackageManager } from './run.js';
import { filesContaining } from './generated-files.js';

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
    await exec(process.execPath, [cliBin, 'proof-app', '--target', 'aws-serverless'], {
      cwd: work,
    });
    await runPackageManager('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir });
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
      'apps/web/src',
      'infra/lib',
      '.claude/settings.json',
      'CLAUDE.md',
      'README.md',
    ]) {
      await expect(stat(path.join(projectDir, p))).resolves.toBeDefined();
    }
  });

  it('rewrote the placeholder scope everywhere', async () => {
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@proof-app/root');
    await expect(filesContaining(projectDir, '@app/')).resolves.toEqual([]);
  });

  it('passes lint', async () => {
    await runPackageManager('pnpm', ['lint'], { cwd: projectDir });
  });

  it('passes typecheck', async () => {
    await runPackageManager('pnpm', ['typecheck'], { cwd: projectDir });
  });

  it('passes its own test suite', async () => {
    await runPackageManager('pnpm', ['test'], { cwd: projectDir });
  });

  it('synthesizes its CDK stack', async () => {
    await runPackageManager('pnpm', ['synth'], { cwd: projectDir });
  });
});
