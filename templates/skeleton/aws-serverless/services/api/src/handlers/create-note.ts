// The handler translates transport ⇄ domain and nothing else: decode the
// payload, call the usecase, map the result (or the typed error) to HTTP.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { InvalidNoteError } from '@app/core';
import { AppError } from '@app/shared';
import { createNoteUsecase, type CreateNoteDeps } from '../usecases/create-note.js';

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function makeCreateNoteHandler(deps: CreateNoteDeps): Handler {
  return async (event) => {
    let payload: unknown;
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
        : (event.body ?? '');
      payload = JSON.parse(raw);
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
