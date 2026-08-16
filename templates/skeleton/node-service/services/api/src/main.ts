// Composition root — the ONLY file with real wiring. Tests target the
// factories with stub deps and never import this module.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { JsonFileNoteStore } from '@app/db';
import { createLogger, loadEnv } from '@app/shared';
import { SpoolEventPublisher } from './adapters/spool-publisher.js';
import { makeServer } from './server.js';
import { defaultStaticDirFor } from './static-dir.js';

// The built web bundle (pnpm build:web) lives here; served when present.
const defaultStaticDir = defaultStaticDirFor(import.meta.url);

const env = loadEnv(
  z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATA_DIR: z.string().min(1).default('var/data'),
    QUEUE_DIR: z.string().min(1).default('var/queue'),
    STATIC_DIR: z.string().min(1).default(defaultStaticDir),
  }),
  process.env,
);

const log = createLogger({ service: 'api' });

const server = makeServer(
  {
    notes: new JsonFileNoteStore(path.join(env.DATA_DIR, 'notes.json')),
    events: new SpoolEventPublisher(env.QUEUE_DIR, () => `${Date.now()}-${randomUUID()}`),
    newId: () => randomUUID(),
    now: () => new Date().toISOString(),
    log,
  },
  { staticDir: env.STATIC_DIR },
);

server.listen(env.PORT, () => {
  log.info('api listening', { port: env.PORT });
});
