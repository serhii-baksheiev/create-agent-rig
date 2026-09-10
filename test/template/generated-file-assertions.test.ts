import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type GeneratedFilesModule = {
  filesContaining(root: string, needle: string): Promise<string[]>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const filesContaining = async (root: string, needle: string): Promise<string[]> => {
  const generatedFiles = (await import(
    new URL('../../test/e2e/generated-files.js', import.meta.url).href
  )) as GeneratedFilesModule;
  return generatedFiles.filesContaining(root, needle);
};

const normalise = (file: string): string => file.split(path.sep).join('/');

const withFixture = async <Result>(test: (root: string) => Promise<Result>): Promise<Result> => {
  const root = await mkdtemp(path.join(tmpdir(), 'generated files [safe] $; '));
  try {
    return await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('generated-file assertions', () => {
  it('finds matching hidden and nested files under a root with shell metacharacters', async () => {
    await withFixture(async (root) => {
      const needle = '__GENERATED_FILE_NEEDLE__';
      await mkdir(path.join(root, '.hidden', 'nested'), { recursive: true });
      await mkdir(path.join(root, 'nested'), { recursive: true });
      await Promise.all([
        writeFile(path.join(root, 'root.txt'), `prefix ${needle} suffix\n`),
        writeFile(path.join(root, '.hidden', 'nested', 'match.txt'), needle),
        writeFile(path.join(root, 'nested', 'other.txt'), 'no match\n'),
      ]);

      const matches = await filesContaining(root, needle);

      expect(matches.every((file) => !path.isAbsolute(file))).toBe(true);
      expect(matches.map(normalise).sort()).toEqual(['.hidden/nested/match.txt', 'root.txt']);
    });
  });

  it('skips dependency, cache, and symlink paths at every depth', async () => {
    await withFixture(async (root) => {
      const needle = '__GENERATED_FILE_NEEDLE__';
      await Promise.all([
        mkdir(path.join(root, 'nested', 'node_modules'), { recursive: true }),
        mkdir(path.join(root, 'nested', '.next'), { recursive: true }),
        mkdir(path.join(root, 'node_modules'), { recursive: true }),
        mkdir(path.join(root, '.next'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(root, 'kept.txt'), needle),
        writeFile(path.join(root, 'nested', 'kept.txt'), needle),
        writeFile(path.join(root, 'node_modules', 'ignored.txt'), needle),
        writeFile(path.join(root, '.next', 'ignored.txt'), needle),
        writeFile(path.join(root, 'nested', 'node_modules', 'ignored.txt'), needle),
        writeFile(path.join(root, 'nested', '.next', 'ignored.txt'), needle),
      ]);
      await symlink(path.join(root, 'nested'), path.join(root, 'linked-directory'), 'junction');

      const matches = await filesContaining(root, needle);

      expect(matches.map(normalise).sort()).toEqual(['kept.txt', 'nested/kept.txt']);
    });
  });

  it('rejects a missing scan root instead of treating its contents as absent', async () => {
    await withFixture(async (root) => {
      await expect(filesContaining(path.join(root, 'missing'), '__needle__')).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      );
    });
  });

  it('keeps generated-project checks off Unix test and grep helpers', async () => {
    for (const file of [
      'test/e2e/generated-project.test.ts',
      'test/e2e/generated-node-service.test.ts',
    ]) {
      const source = await readFile(path.join(repoRoot, file), 'utf8');

      expect(source).not.toMatch(/\bexec\(\s*['"](?:test|grep)['"]/);
    }
  });
});
