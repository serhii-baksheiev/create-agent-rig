import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const observed = vi.hoisted(() => ({ gitDirectoryWasPresent: false }));

vi.mock('../src/commands/init.js', async () => ({
  initProject: async (projectDir: string) => {
    try {
      await stat(path.join(projectDir, '.git'));
      observed.gitDirectoryWasPresent = true;
    } catch {
      observed.gitDirectoryWasPresent = false;
    }
  },
}));

const { createProject } = await import('../src/commands/create.js');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-create-order-'));
  observed.gitDirectoryWasPresent = false;
});

afterEach(async () => {
  await removeFixture(work);
});

describe('createProject', () => {
  it('initialises Git before handing the directory to init', async () => {
    await createProject('git-first', { cwd: work });

    expect(observed.gitDirectoryWasPresent).toBe(true);
  });
});
