import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Vitest's JSON reporter on Windows names test files with a drive-qualified,
// backslash-separated path. RP-306 must turn that runner output into the same
// repository-relative identity that its portable evidence records elsewhere.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tddEvidence = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'tdd-evidence.mjs',
);

describe('RP-306 Windows Vitest identity paths', () => {
  it('normalizes a drive-qualified backslash result path beneath the project root', async () => {
    const module = (await import(pathToFileURL(tddEvidence).href)) as {
      projectRelativePath?: (projectRoot: string, resultPath: string) => string | null;
    };

    expect(module.projectRelativePath).toBeTypeOf('function');
    expect(
      module.projectRelativePath!('C:\\rig\\project', 'C:\\rig\\project\\test\\feature.test.ts'),
    ).toBe('test/feature.test.ts');
  });
});
