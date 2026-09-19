import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * AR-93: a skip on a platform is legitimate only for a capability genuinely
 * absent there — and then it is named and justified in its reason, never a
 * bare `it.skipIf(process.platform === 'win32')`.
 *
 * RP-178 removed the exact-count half of this file's check (it enumerated
 * every call site of the platform-skip helpers, including ten sites in the
 * since-deleted policy-benchmark suite). A count
 * of call sites protects nothing a user of the shipped package can observe;
 * what remains is the one invariant that does: no platform skip without a
 * reason travelling to the report.
 */
const testFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await testFiles(full)));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

describe('platform skips are named', () => {
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
});
