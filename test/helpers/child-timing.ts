import { readFile } from 'node:fs/promises';

/** Pass to a node child as `--import <this>` to have it record its own elapsed time. */
export const CHILD_TIMING_IMPORT = new URL('./child-timing-preload.mjs', import.meta.url).href;

/** The variable naming the file the child writes its elapsed time to. */
export const CHILD_TIMING_ENV = 'RIG_TEST_CHILD_ELAPSED_FILE';

/** The elapsed milliseconds a child recorded; throws when it recorded nothing. */
export const readChildElapsedMs = async (file: string): Promise<number> => {
  const { elapsedMs } = JSON.parse(await readFile(file, 'utf8')) as { elapsedMs: unknown };
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) {
    throw new Error(`${file} does not hold a recorded elapsed time`);
  }
  return elapsedMs;
};
