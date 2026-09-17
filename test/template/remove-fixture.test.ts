import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_REMOVE_MAX_RETRIES,
  FIXTURE_REMOVE_RETRY_DELAY_MS,
  removeFixture,
} from '../helpers/remove-fixture.js';

// RP-158: the one place that owns "delete a test fixture, with a bound on how
// hard it tries". Every direct `rm(dir, { recursive: true, ... })` call site
// this suite still carries either routes through here or documents why it
// cannot — fixture-cleanup-audit.test.ts is the correspondence check for that
// half. This file is the contract for the helper itself.

describe('removeFixture: the bounded-retry constants', () => {
  it('bounds the retry count between 1 and 10', () => {
    expect(Number.isInteger(FIXTURE_REMOVE_MAX_RETRIES)).toBe(true);
    expect(FIXTURE_REMOVE_MAX_RETRIES).toBeGreaterThanOrEqual(1);
    expect(FIXTURE_REMOVE_MAX_RETRIES).toBeLessThanOrEqual(10);
  });

  it('uses a positive retry delay', () => {
    expect(FIXTURE_REMOVE_RETRY_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('removeFixture: removing a real fixture', () => {
  it('removes a real nested temp directory, files and all', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'remove-fixture-'));
    const nested = path.join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'file.txt'), 'content');

    await removeFixture(dir);

    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is a no-op on a path that was never created', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'remove-fixture-'));
    const missing = path.join(dir, 'never-existed');

    await expect(removeFixture(missing)).resolves.toBeUndefined();

    // the parent the missing path lived under is untouched
    await expect(stat(dir)).resolves.toBeDefined();
  });
});

describe('removeFixture: the options it hands to the remover', () => {
  it('passes the bounded-retry options to an injected remover, unchanged', async () => {
    const calls: Array<{ target: string; options: unknown }> = [];
    const fakeRemove = async (target: string, options: unknown): Promise<void> => {
      calls.push({ target, options });
    };

    await removeFixture('/some/fixture/path', fakeRemove as never);

    expect(calls).toEqual([
      {
        target: '/some/fixture/path',
        options: {
          recursive: true,
          force: true,
          maxRetries: FIXTURE_REMOVE_MAX_RETRIES,
          retryDelay: FIXTURE_REMOVE_RETRY_DELAY_MS,
        },
      },
    ]);
  });

  it('propagates an injected remover error unchanged — bounded, not swallowed', async () => {
    const failure = new Error('boom: remover refused');
    const fakeRemove = async (): Promise<void> => {
      throw failure;
    };

    await expect(removeFixture('/some/fixture/path', fakeRemove as never)).rejects.toBe(failure);
  });
});
