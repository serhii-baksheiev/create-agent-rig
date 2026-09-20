import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPluginMarketplaceArtifact } from '../helpers/plugin-artifact.js';

/**
 * RP-179 acceptance #5, #6, #7. `templates/` is the one payload `init`,
 * `create` and `upgrade` copy into a rig — so anything it carries is
 * something a downstream project receives. This file mechanically pins three
 * decisions recorded in `docs/decisions/plugin-capability-matrix.md`:
 *
 * - no third-party plugin source, catalog, or marketplace manifest is copied
 *   into Rig (a `.claude-plugin/` directory, or a `marketplace.json` file, are
 *   both Claude Code plugin-marketplace artifacts — see
 *   https://code.claude.com/docs/en/plugin-marketplaces — and Rig ships
 *   neither);
 * - Ruler is not used for projection (acceptance #6);
 * - Superpowers is not part of the default/product profile (acceptance #7).
 *
 * Scoped to `templates/` only, not the whole repository: this generator's own
 * docs, journal and decision records may discuss Ruler or Superpowers by name
 * (as this very file's header does) without that being a product regression —
 * only what ships into a rig is checked.
 *
 * `Ruler` is matched case-sensitively, deliberately: it is also an ordinary
 * English noun (a drawing/measuring tool), and a case-insensitive whole-word
 * match would flag legitimate prose that happens to name one. `Superpowers`
 * has no such collision risk in this codebase (verified: zero hits, either
 * case, anywhere under `templates/` before this file existed), so it stays
 * case-insensitive.
 *
 * The plugin-marketplace-artifact predicate lives in
 * `test/helpers/plugin-artifact.ts`, shared with
 * `packages/cli/test/package-contents.test.ts`'s tarball-side check — one
 * implementation, so the non-vacuity test below proves the check that
 * actually runs, not a copy of it (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation").
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const templatesDir = path.join(repoRoot, 'templates');

const FORBIDDEN_WORDS = [/\bRuler\b/, /\bsuperpowers\b/i];

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

describe('templates/ ships no vendored plugin catalog and no Ruler or Superpowers reference', () => {
  it('has files to scan at all — a scan over an empty tree is not a pass', () => {
    expect(statSync(templatesDir).isDirectory()).toBe(true);
    expect(walk(templatesDir).length).toBeGreaterThan(50);
  });

  it('carries no `.claude-plugin/` directory and no `marketplace.json` file', () => {
    const files = walk(templatesDir).map(rel);
    const pluginArtifacts = files.filter(isPluginMarketplaceArtifact);
    expect(pluginArtifacts).toEqual([]);
  });

  it('references neither Ruler nor Superpowers anywhere a rig receives', () => {
    const offenders: string[] = [];
    for (const file of walk(templatesDir)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_WORDS) {
        if (pattern.test(text)) offenders.push(`${rel(file)}: ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is non-vacuous: the same checks catch a planted violation, and clear a same-shaped legitimate word', () => {
    const files = [
      'templates/agent-os/universal/.claude-plugin/plugin.json',
      'templates/agent-os/universal/marketplace.json',
    ];
    const planted = files.filter(isPluginMarketplaceArtifact);
    expect(planted).toEqual(files);

    expect(FORBIDDEN_WORDS.some((p) => p.test('projected with Ruler'))).toBe(true);
    expect(FORBIDDEN_WORDS.some((p) => p.test('ships the Superpowers plugin'))).toBe(true);
    // the ordinary noun, lowercase, stays allowed — the guard names the
    // product by its capitalized form, it does not own the word
    expect(FORBIDDEN_WORDS.some((p) => p.test('a straightedge ruler for the diagram'))).toBe(false);
  });
});
