import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The e2e suite packs the published tarball exactly ONCE, here, before any
// test file runs — and `test/template/e2e-pack.test.ts` holds that line.
//
// The measured reason: `npm pack` runs the `prepare` lifecycle, and
// `scripts/prepare.mjs` builds `packages/cli/dist` — which `package.json`
// `files` also tells pack to READ. Three suites packing in parallel meant
// three `tsc` runs rewriting that directory while three packs read it, so a
// tarball could carry a half-written CLI. It did: `upgrade.test.ts` failed
// with `init` exiting 1 under the full suite and passed in isolation.
//
// `git-install.test.ts` is not a fourth writer: npm *clones* the repo for a
// `git+file://` install and runs `prepare` inside the clone.
declare module 'vitest' {
  export interface ProvidedContext {
    /** Absolute path to the packed tarball every e2e suite installs from. */
    tarball: string;
    /** The tarball's file list — what the publish path actually ships. */
    packedPaths: string[];
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const work = await mkdtemp(path.join(tmpdir(), 'caf-pack-once-'));
  const packDir = path.join(work, 'pack');
  await mkdir(packDir);

  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: { path: string }[] }>;
  if (!packed) throw new Error('npm pack produced no tarball');

  project.provide('tarball', path.join(packDir, packed.filename));
  project.provide(
    'packedPaths',
    packed.files.map((f) => f.path),
  );

  return async () => {
    await rm(work, { recursive: true, force: true });
  };
}
