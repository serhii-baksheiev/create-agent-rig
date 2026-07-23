import { AppError } from '@app/shared';
import type { Logger } from '@app/shared';
import { listNotesUsecase, type ListNotesDeps } from '../usecases/list-notes.js';
import type { HttpResponse } from './create-note.js';

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  body: JSON.stringify(body),
});

export function makeListNotesHandler(deps: ListNotesDeps & { log: Logger }) {
  return async (): Promise<HttpResponse> => {
    try {
      return json(200, { notes: await listNotesUsecase(deps) });
    } catch (error) {
      if (error instanceof AppError) {
        return json(error.statusCode, { error: error.message, code: error.code });
      }
      deps.log.error('unhandled error in list-notes', { error: String(error) });
      return json(500, { error: 'internal error' });
    }
  };
}
