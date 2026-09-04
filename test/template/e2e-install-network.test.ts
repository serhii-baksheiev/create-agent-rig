import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { installEnv } from '../e2e/run.js';
import { callTextAt, stripComments } from './lib/source-scan.js';

// WHY THIS TEST EXISTS — a measured, and for a while misdiagnosed, red `e2e`
// lane on an UNCHANGED head:
//
//   FAIL |e2e| test/e2e/pack-install.test.ts > npm pack → install → generate …
//   Error: Hook timed out in 300000ms.
//
// The same commit `b1a60f40` ran green once and red twice within eleven hours
// — every run on that head, enumerated by `head_sha` rather than read off a
// truncated list — always on the two files that install through `npx`, never
// on an assertion. That shape reads as "the budget has no headroom", and the
// first reading of RP-122 was exactly that. It was wrong, and the measurement
// says why.
//
// Measured on the WSL host, one packed tarball, ONE shared warm npm cache,
// cases alternated so ordering cannot explain the split:
//
//   npx, as the suite invoked it       322 574 ms / 425 581 ms
//   audit off, fund on                   4 782 ms
//   audit on, fund off                 260 834 ms
//   both off                             5 584 ms / 4 558 ms
//   --offline against that same cache    2 721 ms
//   third and fourth reuse of one cache
//     with audit on                    387 338 ms / 395 530 ms
//
// Two conclusions, and the middle rows are what separate them. A warm cache
// does not help — the last row is the third and fourth reuse of a single cache
// and both cost over six minutes — while `--offline` against that same cache
// is 2.7 s, two orders of magnitude below the online runs (119x and 156x). So
// the time is not the install. And the cost is `npm audit` specifically rather
// than the pair: with `fund` off and `audit` left on it is still 260 s. npm
// names the endpoint in its own notice — "This endpoint is being retired. Use
// the bulk advisory endpoint instead."
//
// The suite already carried its own control, unread: `upgrade.test.ts`
// installs the SAME tarball with `--no-audit --no-fund` and takes 2.8 s in the
// very CI run where `pack-install` times out at 300 s.
//
// THE INVARIANT: an e2e install path does not make npm's advisory-network
// calls. Nothing in this suite asserts anything about audit output — the
// contract under test is pack → install → generate — so the call is pure cost,
// and it is cost with an unbounded network tail attached to a fixed budget.
// › "no e2e file asserts on npm audit output, which is what makes disabling it
// a cost saving rather than a coverage loss" keeps that reason true rather
// than merely stated.
//
// This is deliberately NOT a raised timeout. Every budget in the suite is
// unchanged; the work itself is gone (`.claude/rules/autonomy.md`, "Never": a
// test is not weakened to get to green, and `Flaky ≠ retry`).
//
// WHAT THIS GUARD CANNOT SEE — stated so nobody relies on cover it lacks
// (`.claude/rules/invariants.md`, "State the limits"):
//   - It reads `test/e2e/**/*.ts` as TEXT, after blanking comments. A file that
//     assembles the command name or `installEnv` from fragments, reaches npm
//     through a helper in another directory, or shells out through a string
//     rather than an argument array, is not seen.
//   - It judges NPM-family installs only: `runNpx(...)` and `npm` passed as an
//     argument array to an exec-like call. `pnpm install` is deliberately out
//     of scope — pnpm runs no audit on install — and there are four such call
//     sites in this suite that legitimately do not use the helper. Widening
//     this guard to them would fire on honest code.
//   - It proves the env the helper BUILDS and that every npm-family install
//     call it can see names the helper. It does not prove npm honours the
//     variables — that is npm's documented config surface, and the timings
//     above are what stands behind it.
//   - It says nothing about how long any install takes. A regression that makes
//     installs slow for a different reason passes this file untouched.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const e2eDir = path.join(repoRoot, 'test', 'e2e');

/** Every source file of the e2e suite, helpers and setup included. */
async function e2eSourceFiles(): Promise<string[]> {
  const entries = await readdir(e2eDir, { recursive: true });
  return entries.filter((entry) => entry.endsWith('.ts')).sort();
}

/** The one file allowed to name npm's config variables and to define the env. */
const HELPER = 'run.ts';

/**
 * The npm-family install calls in one source, as their full call text.
 *
 * Two spellings, and both are how this suite actually writes them:
 *   - `runNpx([...], { … })` — the wrapper every npx path goes through
 *   - `exec('npm', ['install', …], { … })` — npm as an argv-array command
 *
 * `npm pack` is not an install and runs no audit, so it is excluded by name
 * rather than by hoping nobody writes it: `pack-once.ts` runs exactly that and
 * must not be dragged in. `pnpm` is a different command and never matches.
 */
export function npmInstallCalls(source: string): string[] {
  const code = stripComments(source);
  const calls: string[] = [];

  for (const match of code.matchAll(/\brunNpx\s*\(/g)) {
    calls.push(callTextAt(code, match.index + match[0].length - 1));
  }

  // `npm` as the command of an exec-like call, with an argument array whose
  // first entry is not `pack`.
  for (const match of code.matchAll(
    /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|run)\s*\(\s*['"`]npm['"`]\s*,\s*\[\s*['"`]([a-z-]+)['"`]/g,
  )) {
    if (match[1] === 'pack') continue;
    calls.push(callTextAt(code, code.indexOf('(', match.index)));
  }

  return calls;
}

/** Does this call hand its child the shared install environment? */
const usesHelper = (call: string): boolean => /\binstallEnv\s*\(/.test(call);

describe('the e2e install env disables npm advisory network calls', () => {
  it('builds an env that turns audit and fund off and keeps the caller cache', () => {
    const env = installEnv('/tmp/some-cache');
    expect(env.npm_config_audit).toBe('false');
    expect(env.npm_config_fund).toBe('false');
    expect(env.npm_config_cache).toBe('/tmp/some-cache');
  });

  /**
   * Only the three keys the helper sets may differ from the ambient
   * environment. Checking it that way round — rather than skipping every
   * `npm_config_` key — is deliberate: npm carries a registry token as
   * `npm_config_//registry.npmjs.org/:_authToken`, so a loop that skips the
   * whole prefix skips exactly the credential this case is named for, and
   * would stay green if a future helper filtered it out.
   */
  it('changes only those three keys, so PATH and an npm auth token still reach the child', () => {
    const env = installEnv('/tmp/some-cache');
    const overridden = new Set(['npm_config_cache', 'npm_config_audit', 'npm_config_fund']);
    for (const key of Object.keys(process.env)) {
      if (overridden.has(key)) continue;
      expect(env[key], key).toBe(process.env[key]);
    }
  });
});

describe('every e2e npm install call goes through that one helper', () => {
  it('finds e2e source files to check at all — a green vacuum is not a pass', async () => {
    expect((await e2eSourceFiles()).length).toBeGreaterThan(0);
  });

  it('finds npm install calls to judge at all, or the rule below is vacuous', async () => {
    let found = 0;
    for (const file of await e2eSourceFiles()) {
      found += npmInstallCalls(await readFile(path.join(e2eDir, file), 'utf8')).length;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('every npm install call in the suite hands its child installEnv', async () => {
    const offenders: string[] = [];
    for (const file of await e2eSourceFiles()) {
      if (file === HELPER) continue;
      const source = await readFile(path.join(e2eDir, file), 'utf8');
      for (const call of npmInstallCalls(source)) {
        if (!usesHelper(call)) offenders.push(`test/e2e/${file}: ${call.slice(0, 60)}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Case-insensitively, because npm is: `@npmcli/config/lib/index.js` reads the
   * environment with `/^npm_config_/i`, so `NPM_CONFIG_AUDIT=true` set inline in
   * a test would be honoured by npm and invisible to a case-sensitive guard.
   */
  it('no e2e file but the helper names an npm config variable of its own, in any case', async () => {
    const offenders: string[] = [];
    for (const file of await e2eSourceFiles()) {
      if (file === HELPER) continue;
      const code = stripComments(await readFile(path.join(e2eDir, file), 'utf8'));
      if (/npm_config_/i.test(code)) offenders.push(`test/e2e/${file}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The reason disabling audit is a cost saving and not a coverage loss is
   * that nothing here reads audit output. That sentence is in this file's
   * header and in `run.ts`, and prose about a mechanism goes stale silently —
   * so it is asserted rather than claimed.
   */
  it('no e2e file asserts on npm audit output, which is what makes disabling it a cost saving rather than a coverage loss', async () => {
    const offenders: string[] = [];
    for (const file of await e2eSourceFiles()) {
      const code = stripComments(await readFile(path.join(e2eDir, file), 'utf8'));
      if (/\b(?:vulnerabilities|advisories|auditReport)\b/.test(code)) {
        offenders.push(`test/e2e/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the check reads invocations, not prose', () => {
  it('recognises an install call in either spelling', () => {
    expect(npmInstallCalls("await runNpx(['--yes'], { env: installEnv(c) })")).toHaveLength(1);
    expect(npmInstallCalls("await exec('npm', ['install', '--prefix', p, t], opts)")).toHaveLength(
      1,
    );
    expect(npmInstallCalls('execFile("npm", ["ci"], opts)')).toHaveLength(1);
  });

  it('reads the whole call, so an env on a later line is not missed', () => {
    const [call] = npmInstallCalls(
      "await runNpx(\n  ['--yes', '--package=x'],\n  { cwd: d, env: installEnv(cache) },\n);",
    );
    expect(call).toBeDefined();
    expect(usesHelper(call!)).toBe(true);
  });

  it('is not unbalanced by a parenthesis inside an argument string', () => {
    const [call] = npmInstallCalls("await runNpx(['--package=a(b)'], { env: installEnv(c) });");
    expect(usesHelper(call!)).toBe(true);
  });

  it('ignores prose, titles and the commands that are not npm installs', () => {
    for (const honest of [
      "describe('npm pack → init → upgrade (the delivery path)', () => {})",
      '// this once called runNpx(args, { env: { ...process.env } }) without the helper',
      "/* await exec('npm', ['install', t], { env: { ...process.env } }) — the shape this rule forbids */",
      "await exec('npm', ['pack', '--json', '--pack-destination', packDir], opts)",
      "await exec('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir })",
      "await run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: projectDir })",
    ]) {
      expect(npmInstallCalls(honest), honest).toEqual([]);
    }
  });

  it('catches the reintroduction it exists to catch: an install call with no env at all', () => {
    const calls = npmInstallCalls(
      "await runNpx(['--yes', '--package=x', 'create-agent-rig', 'app'], { cwd: dir });",
    );
    expect(calls).toHaveLength(1);
    expect(usesHelper(calls[0]!)).toBe(false);
  });

  it('catches an install call that rebuilds the env inline instead of calling the helper', () => {
    const calls = npmInstallCalls(
      "await runNpx(['--yes'], { cwd: d, env: { ...process.env, npm_config_cache: c } });",
    );
    expect(usesHelper(calls[0]!)).toBe(false);
  });

  /**
   * The npm-config sweep is case-insensitive because npm's own read is
   * (`/^npm_config_/i`). Asserted here rather than only in the sweep, so the
   * discrimination survives someone "tidying" the flag away.
   */
  it('reads an upper-case npm config variable, because npm honours that spelling too', () => {
    expect(/npm_config_/i.test('NPM_CONFIG_AUDIT=true')).toBe(true);
    expect(/npm_config_/i.test('Npm_Config_Cache')).toBe(true);
  });
});
