import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { installEnv } from '../e2e/run.js';

// WHY THIS TEST EXISTS — a measured, and for a while misdiagnosed, red `e2e`
// lane on an UNCHANGED head:
//
//   FAIL |e2e| test/e2e/pack-install.test.ts > npm pack → install → generate …
//   Error: Hook timed out in 300000ms.
//
// The same commit `b1a60f40` ran green once and red twice within eleven hours,
// always on the two files that install through `npx`, never on an assertion.
// That shape reads as "the budget has no headroom", and the first reading of
// RP-122 was exactly that. It was wrong, and the measurement says why.
//
// Measured on the WSL host, one packed tarball, ONE shared warm npm cache,
// cases alternated so ordering cannot explain the split:
//
//   npx, as the suite invokes it today   322 574 ms / 425 581 ms
//   npx, with audit and fund disabled      5 584 ms /   4 558 ms
//   npx --offline against the same cache    2 721 ms
//
// A warm cache does not help (387 s and 396 s on the third and fourth reuse),
// and offline is three orders of magnitude faster on that same cache. So the
// time is not the install: it is a network call npm makes AROUND the install.
// `npm audit` is that call, and npm's own notice names it —
// "This endpoint is being retired. Use the bulk advisory endpoint instead."
//
// The suite already carried its own control, unnoticed: `upgrade.test.ts`
// installs the SAME tarball with `npm install --no-audit --no-fund` and takes
// 2.8 s in the very CI run where `pack-install` times out at 300 s.
//
// THE INVARIANT: an e2e install path does not make npm's advisory-network
// calls. Nothing in this suite asserts anything about audit output — the
// contract under test is pack → install → generate — so the call is pure cost,
// and it is cost with an unbounded network tail attached to a fixed budget.
//
// This is deliberately NOT a raised timeout. Every budget in the suite is
// unchanged; the work itself is gone (`.claude/rules/autonomy.md`, "Never":
// a test is not weakened to get to green, and `Flaky ≠ retry`).
//
// WHAT THIS GUARD CANNOT SEE — stated so nobody relies on cover it lacks
// (`.claude/rules/invariants.md`, "State the limits"):
//   - It reads `test/e2e/**/*.ts` as TEXT. A file that assembles the string
//     `npm_config_cache` from fragments, or reaches npm through a helper in
//     another directory, is not seen.
//   - It proves the ENV THE HELPER BUILDS and that every file goes through the
//     helper. It does not prove npm honours the variables — that is npm's
//     documented config surface, and the timing evidence above is what stands
//     behind it.
//   - It says nothing about how long any install takes. A regression that
//     makes installs slow for a different reason passes this file untouched.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const e2eDir = path.join(repoRoot, 'test', 'e2e');

/** Every source file of the e2e suite, helpers and setup included. */
async function e2eSourceFiles(): Promise<string[]> {
  const entries = await readdir(e2eDir, { recursive: true });
  return entries.filter((entry) => entry.endsWith('.ts')).sort();
}

/** The one file allowed to name npm's config variables. */
const HELPER = 'run.ts';

describe('the e2e install env disables npm advisory network calls', () => {
  it('builds an env that turns audit and fund off and keeps the caller cache', () => {
    const env = installEnv('/tmp/some-cache');
    expect(env.npm_config_audit).toBe('false');
    expect(env.npm_config_fund).toBe('false');
    expect(env.npm_config_cache).toBe('/tmp/some-cache');
  });

  it('carries the ambient environment through, so PATH and npm auth survive', () => {
    const env = installEnv('/tmp/some-cache');
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('npm_config_')) continue;
      expect(env[key], key).toBe(process.env[key]);
    }
  });
});

describe('every e2e install path goes through that one helper', () => {
  it('finds e2e source files to check at all — a green vacuum is not a pass', async () => {
    expect((await e2eSourceFiles()).length).toBeGreaterThan(0);
  });

  it('no e2e file but the helper names an npm config variable of its own', async () => {
    const offenders: string[] = [];
    for (const file of await e2eSourceFiles()) {
      if (file === HELPER) continue;
      const source = await readFile(path.join(e2eDir, file), 'utf8');
      if (/npm_config_[a-z_]+/.test(source)) offenders.push(`test/e2e/${file}`);
    }
    expect(offenders).toEqual([]);
  });

  it('at least one e2e file actually calls the helper, or the rule above is vacuous', async () => {
    const callers: string[] = [];
    for (const file of await e2eSourceFiles()) {
      if (file === HELPER) continue;
      const source = await readFile(path.join(e2eDir, file), 'utf8');
      if (/\binstallEnv\s*\(/.test(source)) callers.push(`test/e2e/${file}`);
    }
    expect(callers.length).toBeGreaterThan(0);
  });
});
