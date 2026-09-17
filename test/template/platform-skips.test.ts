import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * AR-93: a skip on a platform is legitimate only for a capability genuinely
 * absent there — and then it is named, justified in its reason, and COUNTED,
 * so the number is one a reader watches rather than a vague allowance. Every
 * such site goes through one of the five helpers below (never a bare
 * `it.skipIf(process.platform === 'win32')`), and this pins how many there are.
 * A new site is added here on the day it is written, with its reason.
 */
const PLATFORM_SKIP_HELPERS = [
  'modeBitsDeny',
  'modeBitsExist',
  'symlinksAvailable',
  'fifosAvailable',
  'onlyOnWindows',
  'posixShellAvailable',
  'guardProcessesMeasurable',
] as const;

const EXPECTED_SITES: Record<(typeof PLATFORM_SKIP_HELPERS)[number], number> = {
  // SITES, not cases: queue.test.ts has five on 0o500/0o000 (an it.for over
  // three adapters and three singles on 0o500, one on 0o000), run-journal's
  // 0o555 pair shares one beforeEach, copy-tree's exec bit is one, and
  // unattended-flag has read, removal and legacy-cleanup EACCES boundaries
  modeBitsDeny: 10,
  // queue.test.ts: the 0o077 read of state.json — root sees mode bits, Windows has none
  modeBitsExist: 1,
  // hooks.test.ts: the two symlink-fixture cases share one wrapper;
  // uninstall.test.ts: three symlink-fixture cases (ancestor-dir escape,
  // the managed path itself a symlink, and the plan-to-apply TOCTOU re-check)
  // share their own wrapper
  symlinksAvailable: 2,
  // codex.test.ts: the FIFO move-source fixture; unattended-flag: nonblocking flag read;
  // subagent-routing-hooks.test.ts: a FIFO at the agent path the guard must not wait on
  fifosAvailable: 3,
  // run-without-git-location.test.ts: two .cmd shim branches; codex.test.ts:
  // execute the generated PowerShell hook wiring from a nested cwd;
  // gate-rounds.test.ts: the rename retry gives up only where a held-open
  // counter refuses a rename, which is Windows
  onlyOnWindows: 4,
  // codex.test.ts: execute the POSIX hook wiring; Windows wiring is decoded separately
  posixShellAvailable: 1,
  // RP-111 (PR #202, head af21c6d): the policy-benchmark cases that spawn a
  // real guard child process through the benchmark runner, which pays the
  // hosted-windows-latest guard-startup cost this helper names. Ten sites:
  // policy-benchmark.test.ts — "runs the same versioned corpus in one process
  // per harness and reports adapter-process evidence, not live-harness proof"
  // (the corpus run), "records an expected integration failure as unsupported
  // evidence instead of a passing enforcement result" (integration-failure),
  // "observes the native process boundary of each configured harness command"
  // (native boundary), "fails the whole benchmark when a committed hook
  // disables the real-wiring baseline" (disabled baseline), "fails both
  // harnesses when committed target wiring bypasses the secret-write guard"
  // (bypassed baseline), the it.each "fails the whole benchmark when a
  // committed no-op disables $description" (one source site for its two
  // parameterised scenarios), and "fails compatibility rejection when the
  // foreign-major fixture becomes a valid-major envelope" (foreign-major) —
  // seven; policy-benchmark-security.test.ts — "refuses adapter-process
  // evidence when the measured target head moves after a worker has begun"
  // (moved-head), "refuses adapter-process evidence when the isolated
  // verifier bytes change after a worker has begun" (verifier-bytes), and
  // "names the deadline, earlier commands' timings, and the fourth setup
  // probe's exit-trace note when a real guard command times out inside a
  // benchmark run" (never-exiting-guard timeout) — three. NOT counted: the
  // two policy-benchmark.test.ts cases that refuse before any child process
  // starts ("refuses an exact head that no longer names the tree it was asked
  // to label before starting child processes" and "refuses to label
  // adapter-process evidence while a tracked enforcement input is dirty"),
  // and the policy-benchmark-security.test.ts cases whose refusal is a static
  // parse or an upfront fingerprint check before any worker spawns ("refuses
  // a target unattended flag basename that traverses outside its isolated
  // home" and "holds when a copied verifier runtime restores its benign bytes
  // before the controller first fingerprints it") — none of these publish a
  // guard child process, so none pay the hosted cost this helper measures.
  guardProcessesMeasurable: 10,
};

const testFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await testFiles(full)));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

describe('platform skips are named and counted', () => {
  it('every platform-conditional skip goes through a helper that carries a reason', async () => {
    const files = [
      ...(await testFiles(path.join(repoRoot, 'test'))),
      ...(await testFiles(path.join(repoRoot, 'packages', 'cli', 'test'))),
    ];
    const bare: string[] = [];
    for (const file of files) {
      if (file.endsWith('platform-skips.test.ts')) continue; // this file names the pattern
      const source = await readFile(file, 'utf8');
      // a skipIf/runIf keyed on the platform in any spelling, with no reason
      // travelling to the report
      if (
        /\b(?:skipIf|runIf)\(\s*[^)]*process\.platform/.test(source) ||
        // or an early return keyed on the platform, which reports as PASSED
        /if\s*\(\s*process\.platform\s*[!=]==\s*['"]win32['"]\s*\)\s*return\b/.test(source)
      ) {
        bare.push(path.relative(repoRoot, file));
      }
    }
    expect(bare, 'a reason-less platform skip').toEqual([]);
  });

  it('the number of platform-skip sites is the number written here', async () => {
    const files = [
      ...(await testFiles(path.join(repoRoot, 'test', 'template'))),
      ...(await testFiles(path.join(repoRoot, 'packages', 'cli', 'test'))),
    ];
    const counts: Record<string, number> = {
      modeBitsDeny: 0,
      symlinksAvailable: 0,
      onlyOnWindows: 0,
    };
    for (const file of files) {
      if (file.endsWith('platform-skips.test.ts') || file.endsWith('test-env-helpers.test.ts'))
        continue;
      const source = await readFile(file, 'utf8');
      for (const helper of PLATFORM_SKIP_HELPERS) {
        counts[helper] =
          (counts[helper] ?? 0) +
          (source.match(new RegExp(`skipUnless\\(ctx, ${helper}\\(\\)`, 'g')) ?? []).length;
      }
    }
    expect(counts).toEqual(EXPECTED_SITES);
  });
});
