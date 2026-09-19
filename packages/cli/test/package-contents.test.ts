import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runPackageManager } from '../../../test/e2e/run.js';
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

// RP-179 acceptance #5, round 2 (owner ruling): "no third-party payload" is
// proved by the SHAPE of the actual published file list — a strict
// allowlist — not by grepping for a product's name. A name check proves a
// word is absent; it says nothing about an unnamed fork, a renamed vendor
// drop, or a differently-branded tool doing the same thing. Every path `npm
// pack` would publish has to match one of these roots, or the check fails,
// whatever the offending path is called. `templates/` is checked
// source-side, before a build, by
// `test/template/no-vendored-plugins.test.ts`'s `isVendoredArtifact`; this
// is the authoritative, post-build version of the same property, over the
// actual tarball `npm publish` would upload.
const ALLOWED_EXACT_FILES = new Set([
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'package.json',
  'scripts/prepare.mjs',
]);
const ALLOWED_PREFIXES = ['packages/cli/dist/', 'templates/'];

function isAllowedPublishedPath(p: string): boolean {
  return ALLOWED_EXACT_FILES.has(p) || ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

const VENDOR_DIR_NAMES = new Set([
  'node_modules',
  'vendor',
  'third_party',
  'third-party',
  '.cache',
]);

function hasVendorDirSegment(p: string): boolean {
  return p.split('/').some((segment) => VENDOR_DIR_NAMES.has(segment));
}

describe('the published npm tarball, checked by shape rather than by name', () => {
  let publishedPaths: string[];

  beforeAll(async () => {
    const packDir = await mkdtemp(path.join(tmpdir(), 'caf-allowlist-pack-'));
    try {
      const { stdout } = await runPackageManager(
        'npm',
        ['pack', '--json', '--pack-destination', packDir],
        { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
      );
      const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      if (!packed) throw new Error('fixture: npm pack produced no package');
      publishedPaths = packed.files.map((file) => file.path);
    } finally {
      await removeFixture(packDir);
    }
  }, 120_000);

  it('publishes only paths under the declared roots — an unexpected path fails by shape, not by name', () => {
    expect(publishedPaths.length).toBeGreaterThan(0);
    const unexpected = publishedPaths.filter((p) => !isAllowedPublishedPath(p));
    expect(unexpected).toEqual([]);
  });

  it('is non-vacuous: the allowlist rejects a vendored or plugin-catalog path of every shape, and clears the real roots', () => {
    expect(isAllowedPublishedPath('node_modules/left-pad/index.js')).toBe(false);
    expect(isAllowedPublishedPath('.claude-plugin/plugin.json')).toBe(false);
    expect(isAllowedPublishedPath('marketplace.json')).toBe(false);
    expect(isAllowedPublishedPath('vendor/some-lib/lib.min.js')).toBe(false);
    expect(isAllowedPublishedPath('packages/cli/dist/index.js')).toBe(true);
    expect(isAllowedPublishedPath('templates/agent-os/universal/CLAUDE.md')).toBe(true);
    expect(isAllowedPublishedPath('CHANGELOG.md')).toBe(true);
  });

  it('carries no vendor, cache, or dependency-install-shaped directory — a second, independent proof of the same property', () => {
    const offenders = publishedPaths.filter(hasVendorDirSegment);
    expect(offenders).toEqual([]);
  });

  it('ships only compiled CLI output under packages/cli/dist — every path there is a plain .js file, nothing else', () => {
    const distPaths = publishedPaths.filter((p) => p.startsWith('packages/cli/dist/'));
    expect(distPaths.length).toBeGreaterThan(0);
    const nonJs = distPaths.filter((p) => !p.endsWith('.js'));
    expect(nonJs).toEqual([]);
  });
});

// The zero-runtime-dependency contract, checked in both manifests that could
// carry one. The root package.json is what a published install resolves;
// `packages/cli/package.json` is never itself published (see the
// prepublishOnly guard below), but it is the manifest that governs what
// `packages/cli/src` — compiled, unchanged, into the published `dist/` — is
// allowed to import. A dependency declared only there would not appear as a
// literal path in the tarball (a plain `tsc` compile does not inline
// imports), so the allowlist checks above cannot see it; this closes that
// gap at the source.
describe('zero runtime dependencies, in both manifests that could declare one', () => {
  it('declares no runtime `dependencies` in the published package.json', async () => {
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    // Absent is the normal shape (this repo's own package.json today); an
    // explicit empty object must also pass, so a future edit that adds one
    // `{}` "for clarity" is not itself the regression this test exists for.
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('declares no runtime `dependencies` in packages/cli/package.json, the manifest the CLI is actually built from', async () => {
    const raw = await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; private?: boolean };
    expect(pkg.private, 'fixture premise: this package must stay unpublished').toBe(true);
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
