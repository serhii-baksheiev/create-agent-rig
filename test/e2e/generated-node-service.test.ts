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

// The per-target e2e matrix (PLAN.md §8 item 3): the second target must
// install, lint, typecheck, and test on its own, from a cold directory.
describe('generated node-service project passes its own checks', () => {
  let work: string;
  let projectDir: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-gensvc-'));
    projectDir = path.join(work, 'svc-app');
    await exec(process.execPath, [cliBin, 'svc-app', '--target', 'node-service'], { cwd: work });
    await exec('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir });
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('has the same layers, minus the cloud', async () => {
    for (const p of [
      'packages/core/src',
      'packages/shared/src',
      'packages/db/src',
      'services/api/src',
      'services/worker/src',
      '.claude/settings.json',
      'CLAUDE.md',
    ]) {
      await expect(exec('test', ['-e', path.join(projectDir, p)])).resolves.toBeTruthy();
    }
    await expect(exec('test', ['-e', path.join(projectDir, 'infra')])).rejects.toThrow();
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@svc-app/root');
  });

  it('passes lint, typecheck, and its own test suite', async () => {
    await exec('pnpm', ['lint'], { cwd: projectDir });
    await exec('pnpm', ['typecheck'], { cwd: projectDir });
    await exec('pnpm', ['test'], { cwd: projectDir });
  });
});
