import type { SQSEvent } from 'aws-lambda';
import type { ProcessDeps } from '../usecases/process-note-created.js';
import { processNoteCreated } from '../usecases/process-note-created.js';

/**
 * The event source uses batchSize 1, so a throw fails exactly this message and
 * SQS redrives it (then the DLQ takes over). Keep the handler a thin loop.
 */
export function makeNoteCreatedHandler(deps: ProcessDeps) {
  return async (event: SQSEvent): Promise<void> => {
    for (const record of event.Records) {
      await processNoteCreated(record.body, deps);
    }
  };
}
