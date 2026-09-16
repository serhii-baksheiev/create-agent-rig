import { rm } from 'node:fs/promises';

/**
 * How hard a fixture removal tries before it gives up (RP-158). Node's `rm`
 * retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM itself when told to; the
 * bound keeps a directory that really is held open from stalling a test for
 * longer than one short back-off.
 */
export const FIXTURE_REMOVE_MAX_RETRIES = 5;
export const FIXTURE_REMOVE_RETRY_DELAY_MS = 100;

/**
 * The one way a test removes a fixture directory it created: recursive,
 * tolerant of a path that is already gone, and retrying a Windows handle that
 * outlived its process. A failure after the last retry is thrown, not
 * swallowed. `test/template/fixture-cleanup-audit.test.ts` holds every other
 * recursive removal in the suite to a written exception.
 */
export const removeFixture = async (target: string, remove = rm): Promise<void> => {
  await remove(target, {
    recursive: true,
    force: true,
    maxRetries: FIXTURE_REMOVE_MAX_RETRIES,
    retryDelay: FIXTURE_REMOVE_RETRY_DELAY_MS,
  });
};
