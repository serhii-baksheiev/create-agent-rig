// Composition root for the list function — one function, one entry, one job.
import { z } from 'zod';
import { NoteModel, createDocumentClient } from '@app/db';
import { createLogger, loadEnv } from '@app/shared';
import { makeListNotesHandler } from './handlers/list-notes.js';

const env = loadEnv(z.object({ TABLE_NAME: z.string().min(1) }), process.env);

export const handler = makeListNotesHandler({
  notes: new NoteModel(createDocumentClient(), env.TABLE_NAME),
  log: createLogger({ service: 'api', handler: 'list-notes' }),
});
