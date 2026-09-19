import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-179 acceptance #5, #6, #7. `templates/` is the one payload `init`,
 * `create` and `upgrade` copy into a rig — so anything it carries is
 * something a downstream project receives.
 *
 * This file checks by SHAPE, not by name — the owner's ruling on RP-179
 * round 2: "product names are not a security or licensing boundary." An
 * earlier version of this file grepped `templates/` for the literal words
 * `Ruler` and `Superpowers`; that proved only that two words were absent,
 * which says nothing about an unnamed fork, a renamed vendor drop, or a
 * differently-branded tool that does the same thing. That check is deleted
 * here, not weakened — `docs/decisions/plugin-capability-matrix.md` ("Ruler
 * and Superpowers") records why and what replaced it: this file's shape
 * checks, plus the published-tarball allowlist in
 * `packages/cli/test/package-contents.test.ts`, which is the authoritative,
 * post-build version of the same property.
 *
 * `isVendoredArtifact` is the one predicate both tests below share — a
 * vendored plugin catalog, a bundled/minified file, or a dependency-install
 * directory, wherever it appears under `templates/`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const templatesDir = path.join(repoRoot, 'templates');

const VENDOR_DIR_NAMES = new Set([
  '.claude-plugin',
  'node_modules',
  'vendor',
  'third_party',
  'third-party',
  '.cache',
]);
const BUNDLED_FILE_PATTERN = /\.(min\.js|min\.css|bundle\.js)$/;

/** A vendored, bundled, or plugin-catalog-shaped path — the one predicate both tests use. */
function isVendoredArtifact(relPath: string): boolean {
  const segments = relPath.split('/');
  if (segments.some((segment) => VENDOR_DIR_NAMES.has(segment))) return true;
  if (path.basename(relPath) === 'marketplace.json') return true;
  if (BUNDLED_FILE_PATTERN.test(relPath)) return true;
  return false;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const rel = (p: string): string => path.relative(repoRoot, p).split(path.sep).join('/');

describe('templates/ carries no vendored, bundled, or plugin-catalog-shaped path', () => {
  it('has files to scan at all — a scan over an empty tree is not a pass', () => {
    expect(statSync(templatesDir).isDirectory()).toBe(true);
    expect(walk(templatesDir).length).toBeGreaterThan(50);
  });

  it('carries no vendored, bundled, or plugin-catalog-shaped path', () => {
    const offenders = walk(templatesDir).map(rel).filter(isVendoredArtifact);
    expect(offenders).toEqual([]);
  });

  it('is non-vacuous: the same predicate catches a planted violation of every shape, and clears an ordinary path', () => {
    expect(isVendoredArtifact('templates/agent-os/universal/.claude-plugin/plugin.json')).toBe(
      true,
    );
    expect(isVendoredArtifact('templates/agent-os/universal/marketplace.json')).toBe(true);
    expect(isVendoredArtifact('templates/agent-os/universal/node_modules/x/index.js')).toBe(true);
    expect(isVendoredArtifact('templates/agent-os/universal/vendor/lib.js')).toBe(true);
    expect(isVendoredArtifact('templates/agent-os/universal/third_party/lib.js')).toBe(true);
    expect(isVendoredArtifact('templates/agent-os/universal/dist/app.min.js')).toBe(true);
    expect(isVendoredArtifact('templates/agent-os/universal/dist/app.bundle.js')).toBe(true);
    // an ordinary authored path stays allowed
    expect(isVendoredArtifact('templates/agent-os/universal/CLAUDE.md')).toBe(false);
  });
});
