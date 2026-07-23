// Composition root — the ONLY file with real wiring. Tests target the factory
// (makeCreateNoteHandler) with stub deps and never import this module.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NoteModel, createDocumentClient } from '@app/db';
import { createLogger, loadEnv } from '@app/shared';
import { SqsEventPublisher, createQueueClient } from './adapters/sqs-publisher.js';
import { makeCreateNoteHandler } from './handlers/create-note.js';

const env = loadEnv(
  z.object({ TABLE_NAME: z.string().min(1), QUEUE_URL: z.string().min(1) }),
  process.env,
);

export const handler = makeCreateNoteHandler({
  notes: new NoteModel(createDocumentClient(), env.TABLE_NAME),
  events: new SqsEventPublisher(createQueueClient(), env.QUEUE_URL),
  newId: () => randomUUID(),
  now: () => new Date().toISOString(),
  log: createLogger({ service: 'api' }),
});
