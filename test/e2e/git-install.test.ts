import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runNpx } from './run.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-git-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('git install (the `npx github:…` personal-stage distribution path)', () => {
  // npm clones the repo, installs devDependencies, runs `prepare` (which builds
  // the CLI), packs, and exposes the bin — exactly what `npx github:<user>/…` does.
  // NOTE: this exercises the last *commit* (git clone), not the working tree.
  it('installs from a local git clone and generates a project', async () => {
    const appDir = path.join(work, 'app');
    await mkdir(appDir);
    // runNpx, not a bare exec: this install step is the one that failed on CI
    // with no reason attached (RP-70). Its stderr is the diagnosis.
    await runNpx(
      [
        '--yes',
        `--package=git+file://${repoRoot}`,
        'create-agent-rig',
        'git-app',
        '--target',
        'aws-serverless',
      ],
      {
        cwd: appDir,
        env: { ...process.env, npm_config_cache: path.join(work, 'npx-cache') },
      },
    );
    const pkg = JSON.parse(await readFile(path.join(appDir, 'git-app', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@git-app/root');
    const readme = await readFile(path.join(appDir, 'git-app', 'README.md'), 'utf8');
    expect(readme).toContain('# git-app');
  });
});
