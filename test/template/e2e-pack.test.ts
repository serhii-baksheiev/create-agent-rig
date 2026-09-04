import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Shared with e2e-install-network.test.ts — a second copy of a scanner is a
// copy that drifts (`.claude/rules/invariants.md`, "One mechanism, one
// implementation"). This file had the original; it now imports it.
import { stripComments } from './lib/source-scan.js';

// WHY THIS TEST EXISTS — a measured, intermittent failure of `pnpm test`:
//
//   FAIL |e2e| test/e2e/upgrade.test.ts > npm pack → init → upgrade …
//   AssertionError: expected 1 to be +0    (freshRig: `init` exited 1)
//
// The mechanism, verified step by step:
//   1. `npm pack` at the repo root runs the `prepare` lifecycle script
//      (`npm pack --dry-run --foreground-scripts` prints `> create-agent-rig …
//      prepare` → `node scripts/prepare.mjs`).
//   2. `scripts/prepare.mjs` runs `tsc -p packages/cli/tsconfig.build.json`,
//      which REWRITES `packages/cli/dist`.
//   3. The root `package.json` ships `files: ["packages/cli/dist", …]`, so the
//      same `npm pack` READS `packages/cli/dist` while packing.
//   4. Several e2e files each packed in their own `beforeAll`, and vitest runs
//      test files in parallel — so one pack read `dist` while another pack's
//      `tsc` was halfway through rewriting it. The tarball captured a
//      half-written CLI; the CLI installed from it then failed, and `init`
//      exited 1. Running the file alone always passed, which is why it looked
//      like flakiness rather than a race.
//
// The invariant that removes the race: the e2e suite packs the published
// tarball exactly ONCE, and no individual e2e test file packs on its own.
// HOW the single tarball is shared (global setup, a fixture file, an injected
// value) is deliberately not constrained here.
//
// Deleting this test re-opens a race that costs an intermittent red `pnpm test`
// and an afternoon of bisecting a failure that reproduces in no single file.
//
// WHAT THIS GUARD CANNOT SEE — stated so nobody relies on cover it lacks
// (`.claude/rules/invariants.md`, "State the limits"):
//   - It scans `test/e2e/**/*.test.ts` only. A second `globalSetup`, or a
//     helper module the test files import, can re-open the same race with this
//     test still green.
//   - It matches the SHAPE of the invocation, not its working directory. A
//     future test that legitimately packs a *generated* project
//     (`exec('npm', ['pack'], { cwd: generatedApp })` — which never touches
//     `packages/cli/dist`) would trip it. Widen the check to compare `cwd`
//     then; do not relax the regex, which is what removes the guard.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const e2eDir = path.join(repoRoot, 'test', 'e2e');

/**
 * The two spellings of "this process runs `npm pack`":
 *  - the argument-array form actually used here:
 *      exec('npm', ['pack', '--json', '--pack-destination', packDir], …)
 *  - a shell string handed to an exec-like call: exec(`npm pack …`)
 *
 * Neither can match the word "pack" in a describe title, nor an identifier
 * such as `packDir`, `packedPaths` or `tarball` — a guard that fires on honest
 * code gets deleted, and then the race comes back.
 */
const NPM_PACK_ARGV = /['"`]npm['"`]\s*,\s*\[\s*['"`]pack['"`]/;
const NPM_PACK_SHELL =
  /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|\$)\s*\(\s*['"`][^'"`\n]*\bnpm\s+pack\b/;

const invokesNpmPack = (source: string): boolean => {
  const code = stripComments(source);
  return NPM_PACK_ARGV.test(code) || NPM_PACK_SHELL.test(code);
};

async function e2eTestFiles(): Promise<string[]> {
  const entries = await readdir(e2eDir, { recursive: true });
  return entries.filter((entry) => entry.endsWith('.test.ts')).sort();
}

describe('the e2e suite packs the tarball once, not once per test file', () => {
  it('finds e2e test files to check at all — a green vacuum is not a pass', async () => {
    expect((await e2eTestFiles()).length).toBeGreaterThan(0);
  });

  it('no e2e test file runs `npm pack` itself', async () => {
    const files = await e2eTestFiles();
    const packers: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(e2eDir, file), 'utf8');
      if (invokesNpmPack(source)) packers.push(`test/e2e/${file}`);
    }
    expect(packers).toEqual([]);
  });
});

describe('the check reads invocations, not prose', () => {
  it('recognises the invocation in either spelling', () => {
    expect(
      invokesNpmPack("await exec('npm', ['pack', '--json', '--pack-destination', packDir], opts)"),
    ).toBe(true);
    expect(invokesNpmPack('execFile("npm", ["pack"])')).toBe(true);
    expect(invokesNpmPack('await exec(`npm pack --json`)')).toBe(true);
  });

  it('ignores prose, titles and identifiers that merely contain the word', () => {
    for (const honest of [
      "describe('npm pack → init → upgrade (the delivery path)', () => {})",
      '// this used to call npm pack here; it now reuses the shared tarball',
      "/* exec('npm', ['pack', '--json']) — the shape this rule forbids */",
      "const packDir = path.join(work, 'pack');",
      'packedPaths = packed.files.map((f) => f.path);',
      "await exec('npm', ['install', '--no-audit', tarball])",
    ]) {
      expect(invokesNpmPack(honest), honest).toBe(false);
    }
  });
});
