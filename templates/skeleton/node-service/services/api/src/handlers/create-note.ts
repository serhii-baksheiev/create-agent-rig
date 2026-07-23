// The handler translates transport ⇄ domain and nothing else: decode the
// payload, call the usecase, map the result (or the typed error) to HTTP.
import { InvalidNoteError } from '@app/core';
import { AppError } from '@app/shared';
import { createNoteUsecase, type CreateNoteDeps } from '../usecases/create-note.js';

export interface HttpResponse {
  statusCode: number;
  body: string;
}

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  body: JSON.stringify(body),
});

export function makeCreateNoteHandler(deps: CreateNoteDeps) {
  return async (rawBody: string): Promise<HttpResponse> => {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'body must be valid JSON' });
    }

    try {
      const note = await createNoteUsecase(payload, deps);
      return json(201, { note });
    } catch (error) {
      if (error instanceof InvalidNoteError) {
        return json(400, { error: 'invalid note', issues: error.issues });
      }
      if (error instanceof AppError) {
        return json(error.statusCode, { error: error.message, code: error.code });
      }
      deps.log.error('unhandled error in create-note', { error: String(error) });
      return json(500, { error: 'internal error' });
    }
  };
}
