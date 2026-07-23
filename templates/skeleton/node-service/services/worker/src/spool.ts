// A directory is the queue: one JSON file per message. Retries are encoded in
// the filename (msg.json → msg.retry1.json → …); after maxAttempts the file
// moves to the DLQ directory and an alarm line is logged. Same discipline as
// any managed queue — visible failure, bounded retries, no silent loss.
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@app/shared';

export interface SpoolConfig {
  queueDir: string;
  dlqDir: string;
  /** Total attempts a message gets before it is dead-lettered. */
  maxAttempts: number;
}

export interface SpoolDeps {
  log: Logger;
  process(raw: string): Promise<void>;
}

const RETRY_PATTERN = /\.retry(\d+)\.json$/;

const attemptOf = (name: string): number => {
  const match = RETRY_PATTERN.exec(name);
  return match ? Number.parseInt(match[1]!, 10) + 1 : 1;
};

const withRetrySuffix = (name: string, attempt: number): string =>
  name.replace(/(\.retry\d+)?\.json$/, `.retry${attempt}.json`);

/** One pass over the queue. Returns how many messages were processed successfully. */
export async function processSpoolOnce(config: SpoolConfig, deps: SpoolDeps): Promise<number> {
  await mkdir(config.queueDir, { recursive: true });
  await mkdir(config.dlqDir, { recursive: true });
  let processed = 0;

  const entries = (await readdir(config.queueDir)).filter((name) => name.endsWith('.json')).sort();
  for (const name of entries) {
    const file = path.join(config.queueDir, name);
    try {
      await deps.process(await readFile(file, 'utf8'));
      await rm(file);
      processed += 1;
    } catch (error) {
      const attempt = attemptOf(name);
      if (attempt >= config.maxAttempts) {
        await rename(file, path.join(config.dlqDir, name));
        deps.log.error('ALARM: message dead-lettered', {
          file: name,
          attempts: attempt,
          error: String(error),
        });
      } else {
        await rename(file, path.join(config.queueDir, withRetrySuffix(name, attempt)));
        deps.log.warn('message failed, will retry', { file: name, attempt });
      }
    }
  }
  return processed;
}
