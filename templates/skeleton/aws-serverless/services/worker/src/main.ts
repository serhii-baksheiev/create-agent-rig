// Composition root for the worker Lambda.
import { createLogger } from '@app/shared';
import { makeNoteCreatedHandler } from './handlers/note-created.js';

export const handler = makeNoteCreatedHandler({
  log: createLogger({ service: 'worker' }),
});
