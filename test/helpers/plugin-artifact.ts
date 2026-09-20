import path from 'node:path';

/**
 * The one predicate for "this path is a Claude Code plugin-marketplace
 * artifact" — a `.claude-plugin/` directory anywhere in the path, or a
 * `marketplace.json` file (https://code.claude.com/docs/en/plugin-marketplaces).
 *
 * `.claude/rules/invariants.md`: "one mechanism, one implementation." Before
 * this module existed, this same check was written out three times —
 * `test/template/no-vendored-plugins.test.ts` (twice: the real check and its
 * own non-vacuity self-test) and `packages/cli/test/package-contents.test.ts`
 * (once, against the published tarball) — so the non-vacuity test proved the
 * COPY caught a planted violation, never the check that actually runs. All
 * three now import this.
 *
 * `relPath` is a `/`-separated path, relative to whatever root the caller is
 * scanning (a source tree or a packed tarball listing) — this function does
 * no filesystem access of its own.
 */
export function isPluginMarketplaceArtifact(relPath: string): boolean {
  return (
    relPath.split('/').includes('.claude-plugin') || path.basename(relPath) === 'marketplace.json'
  );
}
