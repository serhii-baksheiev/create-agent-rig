// Composition root — the worker as a long-running process polling the spool.
import { z } from 'zod';
import { createLogger, loadEnv } from '@app/shared';
import { processNoteCreated } from './usecases/process-note-created.js';
import { processSpoolOnce } from './spool.js';

const env = loadEnv(
  z.object({
    QUEUE_DIR: z.string().min(1).default('var/queue'),
    DLQ_DIR: z.string().min(1).default('var/dlq'),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  }),
  process.env,
);

const log = createLogger({ service: 'worker' });
const config = { queueDir: env.QUEUE_DIR, dlqDir: env.DLQ_DIR, maxAttempts: 3 };
const deps = { log, process: (raw: string) => processNoteCreated(raw, { log }) };

log.info('worker polling', { queueDir: env.QUEUE_DIR, intervalMs: env.POLL_INTERVAL_MS });

const tick = async () => {
  const processed = await processSpoolOnce(config, deps);
  if (processed > 0) log.info('spool pass complete', { processed });
  setTimeout(() => void tick(), env.POLL_INTERVAL_MS);
};

void tick();
