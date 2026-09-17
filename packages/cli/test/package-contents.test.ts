import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// `npm pack` runs `prepare`, whose build output is also explicitly included by
// package.json. A compiler does not normally remove outputs for source files
// that disappeared, so these are the three retired surfaces that a checkout
// from before RP-177 can still have under its ignored `dist/` directory.
const staleOutputs = [
  'packages/cli/dist/lib/targets.js',
  'packages/cli/dist/lib/composition.js',
  'packages/cli/dist/policy/evidence-shell.js',
];

describe('the package publish path', () => {
  it('does not publish stale output for retired targets, composition, or policy', async () => {
    const packDir = await mkdtemp(path.join(tmpdir(), 'caf-retired-dist-pack-'));
    try {
      for (const rel of staleOutputs) {
        const file = path.join(repoRoot, ...rel.split('/'));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `stale ${rel}\n`);
      }

      // This is the publish preparation itself, not a simulated file list:
      // npm invokes `prepare` before it reports the contents of the tarball.
      const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', packDir], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      });
      const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      if (!packed) throw new Error('fixture: npm pack produced no package');

      const paths = packed.files.map((file) => file.path);
      for (const rel of staleOutputs) {
        expect(paths, `publish tarball retained stale ${rel}`).not.toContain(rel);
      }
    } finally {
      await Promise.all(
        staleOutputs.map((rel) => rm(path.join(repoRoot, ...rel.split('/')), { force: true })),
      );
      await removeFixture(packDir);
    }
  }, 120_000);
});
