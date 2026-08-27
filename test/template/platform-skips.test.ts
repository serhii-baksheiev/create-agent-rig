import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * AR-93: a skip on a platform is legitimate only for a capability genuinely
 * absent there — and then it is named, justified in its reason, and COUNTED,
 * so the number is one a reader watches rather than a vague allowance. Every
 * such site goes through one of the two helpers below (never a bare
 * `it.skipIf(process.platform === 'win32')`), and this pins how many there are.
 * A new site is added here on the day it is written, with its reason.
 */
const PLATFORM_SKIP_HELPERS = [
  'modeBitsDeny',
  'modeBitsExist',
  'symlinksAvailable',
  'fifosAvailable',
  'onlyOnWindows',
] as const;

const EXPECTED_SITES: Record<(typeof PLATFORM_SKIP_HELPERS)[number], number> = {
  // SITES, not cases: queue.test.ts has five on 0o500/0o000 (an it.for over
  // three adapters and three singles on 0o500, one on 0o000), run-journal's
  // 0o555 pair shares one beforeEach, copy-tree's exec bit is one, and
  // unattended-flag has read, removal and legacy-cleanup EACCES boundaries
  modeBitsDeny: 10,
  // queue.test.ts: the 0o077 read of state.json — root sees mode bits, Windows has none
  modeBitsExist: 1,
  // hooks.test.ts: the two symlink-fixture cases share one wrapper
  symlinksAvailable: 1,
  // codex.test.ts: the FIFO move-source fixture; unattended-flag: nonblocking flag read
  fifosAvailable: 2,
  // run-without-git-location.test.ts: the .cmd shim branch, measured only there
  onlyOnWindows: 2,
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
