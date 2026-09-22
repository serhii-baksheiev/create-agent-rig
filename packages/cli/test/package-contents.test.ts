import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPackageManager } from '../../../test/e2e/run.js';
import { isPluginMarketplaceArtifact } from '../../../test/helpers/plugin-artifact.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

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
      const { stdout } = await runPackageManager(
        'npm',
        ['pack', '--json', '--pack-destination', packDir],
        {
          cwd: repoRoot,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
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

// RP-179 acceptance #5: no plugin catalog/marketplace is created, and the npm
// package keeps zero runtime dependencies. `templates/` is checked separately
// and more broadly by `test/template/no-vendored-plugins.test.ts`; this
// describes the same invariant from the other side — the actual tarball `npm
// publish` would upload, and the manifest that ships inside it.
describe('the npm package carries no plugin catalog and no runtime dependency', () => {
  it('keeps a `.claude-plugin/` directory and a `marketplace.json` file out of the published tarball', async () => {
    const packDir = await mkdtemp(path.join(tmpdir(), 'caf-plugin-pack-'));
    try {
      const { stdout } = await runPackageManager(
        'npm',
        ['pack', '--json', '--pack-destination', packDir],
        { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
      );
      const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      if (!packed) throw new Error('fixture: npm pack produced no package');

      const paths = packed.files.map((file) => file.path);
      const pluginArtifacts = paths.filter(isPluginMarketplaceArtifact);
      expect(pluginArtifacts).toEqual([]);
    } finally {
      await removeFixture(packDir);
    }
  }, 120_000);

  it('declares no runtime `dependencies` in the published package.json', async () => {
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    // Absent is the normal shape (this repo's own package.json today); an
    // explicit empty object must also pass, so a future edit that adds one
    // `{}` "for clarity" is not itself the regression this test exists for.
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});

/**
 * A path that is third-party PROVIDER PAYLOAD rather than Rig's own source: a
 * Spec Kit project directory (`.specify/`), a file named `speckit*`, or a
 * Basic Memory data path (`.basic-memory/` or `basic-memory.*`). "## Harness
 * delivery and provider ownership" (`docs/command-contract.md`) states Rig
 * plans and delegates to each provider's own CLI and vendors none of their
 * data — `packages/cli/test/spec-kit.test.ts` › "requires explicit adoption
 * before touching an external .specify payload". A copy of either provider's
 * own files landing in the published tarball would be a publish-path defect
 * this predicate exists to catch; RP-184 PR2 extends this file with it.
 *
 * Path-based, deliberately, like `isPluginMarketplaceArtifact` above: this
 * repository's own source legitimately contains the strings "spec-kit" and
 * "basic-memory" (`packages/cli/src/integrations/registry.ts`,
 * `verify.ts`) — a content scan over the packed dist would false-positive on
 * Rig's own compiled provider-integration modules, which do ship and should.
 */
function isVendoredProviderPayload(relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1] ?? '';
  return (
    segments.includes('.specify') ||
    /^speckit/i.test(base) ||
    segments.includes('.basic-memory') ||
    /^basic-memory\./i.test(base)
  );
}

describe('the npm package carries no vendored third-party provider payload (RP-184 PR2)', () => {
  it('carries no Spec Kit `.specify/` directory, `speckit*` file, or Basic Memory data file', async () => {
    const packDir = await mkdtemp(path.join(tmpdir(), 'caf-provider-payload-pack-'));
    try {
      const { stdout } = await runPackageManager(
        'npm',
        ['pack', '--json', '--pack-destination', packDir],
        { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
      );
      const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      if (!packed) throw new Error('fixture: npm pack produced no package');

      const paths = packed.files.map((file) => file.path);
      const offenders = paths.filter(isVendoredProviderPayload);
      expect(offenders).toEqual([]);
    } finally {
      await removeFixture(packDir);
    }
  }, 120_000);

  it('is non-vacuous: catches a planted violation of each provider shape, and clears this repository’s own integration source', () => {
    const planted = [
      'templates/agent-os/universal/.specify/memory/constitution.md',
      'templates/agent-os/universal/speckit-cache.json',
      'templates/agent-os/universal/.basic-memory/notes.db',
      'templates/agent-os/universal/basic-memory.jsonl',
    ];
    expect(planted.filter(isVendoredProviderPayload)).toEqual(planted);

    // Rig's own compiled provider-integration modules name both providers in
    // their filenames or contents without being vendored provider payload —
    // this predicate does not treat naming a provider as owning its data.
    expect(isVendoredProviderPayload('packages/cli/dist/integrations/spec-kit.js')).toBe(false);
    expect(isVendoredProviderPayload('packages/cli/dist/integrations/registry.js')).toBe(false);
    expect(isVendoredProviderPayload('packages/cli/dist/integrations/verify.js')).toBe(false);
  });
});
