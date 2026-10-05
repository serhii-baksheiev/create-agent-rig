/**
 * RP-374 round 2 — predecessor-to-candidate upgrade acceptance, the heavy
 * case (e2e).
 *
 * Moved out of `test/template/release-acceptance-upgrade.test.ts`: that copy
 * used to run `npm pack` at the repo root directly, which also runs the
 * `prepare` lifecycle and rebuilds `packages/cli/dist` mid-suite — exactly
 * the race `test/e2e/pack-once.ts` exists to remove (see its own header: a
 * tarball packed while another suite's `tsc` run is half-written). This copy
 * reuses the e2e project's single packed candidate tarball (`inject`) and
 * the repo's win32-safe package-manager helper (`runPackageManager`) instead
 * of a bare `exec('npm', …)`.
 *
 * It also pins two round-2 review blockers on top of round 1's already-
 * landed `acceptPredecessorUpgrade`, both of which FAIL against current
 * production:
 *   - the predecessor rig must be generated with `init --layer workflow`,
 *     not plain `init` — proven here by a workflow-layer-only file
 *     (`.claude/skills/loop/SKILL.md`, from
 *     `templates/agent-os/universal/layers.json`'s `workflow` array)
 *     existing in the generated predecessor tree after the call;
 *   - the first `upgrade --yes` must be non-vacuous — it must replace at
 *     least one rig-managed file, and `acceptPredecessorUpgrade`'s result
 *     must report which ones via `firstUpgradeChangedFiles`, a field
 *     current production does not return at all.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { installEnv, runPackageManager } from './run.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'release-acceptance.mjs');

type Module = {
  assertVersionAdvances?: (predecessor: string, candidate: string) => void;
  acquirePredecessor?: <T>(options: {
    expectedGitHead: string;
    expectedShasum: string;
    expectedIntegrity: string;
    registryView: { gitHead?: string };
    tarballPath: string;
    install: (tarballPath: string) => Promise<T>;
  }) => Promise<T>;
  acceptPredecessorUpgrade?: (options: {
    scratch: string;
    env: NodeJS.ProcessEnv;
    predecessorCli: string;
    candidateCli: string;
    candidateVersion: string;
  }) => Promise<{
    manifestVersion: string;
    firstUpgradeChangedFiles: string[];
    secondUpgradeChangedFiles: string[];
  }>;
};

async function importScript(): Promise<Module> {
  return (await import(pathToFileURL(script).href)) as Module;
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'caf-predecessor-upgrade-e2e-'));
});

afterEach(async () => {
  await removeFixture(scratch);
});

describe('release acceptance predecessor-to-candidate upgrade (e2e)', () => {
  // A workflow-layer-only file — present after `init --layer workflow`,
  // absent after plain `init` (`templates/agent-os/universal/layers.json`'s
  // `workflow` array). It doubles as the "rig-managed file the next release
  // changed", so the first upgrade this test drives has something real to
  // replace.
  const WORKFLOW_ONLY_FILE = path.posix.join('.claude', 'skills', 'loop', 'SKILL.md');

  async function tarExtract(tarball: string, into: string): Promise<void> {
    await mkdir(into, { recursive: true });
    await exec('tar', ['-xzf', tarball, '-C', into]);
  }

  async function tarCreate(from: string, memberDir: string, out: string): Promise<void> {
    await exec('tar', ['-czf', out, '-C', from, memberDir]);
  }

  /**
   * A locally built stand-in predecessor: this suite's own packed candidate
   * tarball, repacked under a lower version with one workflow-layer template
   * file's content changed — so the predecessor and the candidate genuinely
   * differ, giving the upgrade under test a real change to deliver.
   */
  async function buildPredecessorTarball(
    candidateTarball: string,
    predecessorVersion: string,
  ): Promise<string> {
    const extracted = path.join(scratch, 'predecessor-src');
    await tarExtract(candidateTarball, extracted);

    const pkgPath = path.join(extracted, 'package', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>;
    pkg.version = predecessorVersion;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const templatePath = path.join(
      extracted,
      'package',
      'templates',
      'agent-os',
      'universal',
      ...WORKFLOW_ONLY_FILE.split('/'),
    );
    const original = await readFile(templatePath, 'utf8');
    await writeFile(templatePath, `${original}\n<!-- predecessor stand-in content -->\n`);

    const out = path.join(scratch, `predecessor-${predecessorVersion}.tgz`);
    await tarCreate(extracted, 'package', out);
    return out;
  }

  async function installCli(tarball: string, prefix: string): Promise<string> {
    await mkdir(prefix, { recursive: true });
    await runPackageManager(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball],
      {
        cwd: prefix,
        maxBuffer: 16 * 1024 * 1024,
        env: installEnv(path.join(prefix, 'npm-cache')),
      },
    );
    return path.join(
      prefix,
      'node_modules',
      'create-agent-rig',
      'packages',
      'cli',
      'dist',
      'index.js',
    );
  }

  it('accepts an immutable published predecessor upgrade with an exact packed candidate', async () => {
    const module = await importScript();
    // Fail fast on a missing phase, before any packing/install work runs.
    expect(module.acquirePredecessor).toBeTypeOf('function');
    expect(module.acceptPredecessorUpgrade).toBeTypeOf('function');
    expect(module.assertVersionAdvances).toBeTypeOf('function');

    // Packed once for the whole e2e project — see test/e2e/pack-once.ts for
    // the race per-file packing produced.
    const candidateTarball = inject('tarball');
    // The repo root's own package.json, never rewritten mid-suite (unlike
    // `packages/cli/dist`, which `prepare` rebuilds) — safe to read directly
    // rather than re-packing to learn the version this tarball carries.
    const candidatePkg = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    const candidateVersion = candidatePkg.version;

    // The predecessor is this exact packed candidate, repacked under a
    // lower, clearly-fake version with one workflow-layer template file
    // changed — a stand-in that needs no second real release to exist, and
    // whose identity the test verifies itself rather than trusting the
    // registry.
    const predecessorVersion = '0.0.1';
    const predecessorTarball = await buildPredecessorTarball(candidateTarball, predecessorVersion);
    const predecessorBytes = await readFile(predecessorTarball);
    const expectedShasum = sha1(predecessorBytes);
    const expectedIntegrity = sha512Integrity(predecessorBytes);
    const expectedGitHead = 'f'.repeat(40);

    module.assertVersionAdvances!(predecessorVersion, candidateVersion);

    const predecessorCli = await module.acquirePredecessor!({
      expectedGitHead,
      expectedShasum,
      expectedIntegrity,
      registryView: { gitHead: expectedGitHead },
      tarballPath: predecessorTarball,
      install: (tarballPath) => installCli(tarballPath, path.join(scratch, 'predecessor-home')),
    });
    const candidateCli = await installCli(candidateTarball, path.join(scratch, 'candidate-home'));

    const result = await module.acceptPredecessorUpgrade!({
      scratch: path.join(scratch, 'acceptance'),
      env: process.env,
      predecessorCli,
      candidateCli,
      candidateVersion,
    });

    expect(result.manifestVersion).toBe(candidateVersion);
    expect(result.secondUpgradeChangedFiles).toEqual([]);

    // Round 2: the predecessor must have been generated with the workflow
    // layer, not plain `init` — a workflow-layer-only file must exist in
    // the generated predecessor rig under `acceptPredecessorUpgrade`'s own
    // `<scratch>/rig` root.
    await expect(
      access(path.join(scratch, 'acceptance', 'rig', ...WORKFLOW_ONLY_FILE.split('/'))),
    ).resolves.toBeUndefined();

    // Round 2: the first upgrade actually changed something non-vacuous,
    // and the result says what.
    expect(Array.isArray(result.firstUpgradeChangedFiles)).toBe(true);
    expect(result.firstUpgradeChangedFiles.length).toBeGreaterThan(0);
  }, 120_000);
});
