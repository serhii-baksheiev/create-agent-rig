// The handler translates transport ⇄ domain and nothing else: decode the
// payload, call the usecase, map the result (or the typed error) to HTTP.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { InvalidNoteError } from '@app/core';
import { AppError } from '@app/shared';
import { createNoteUsecase, type CreateNoteDeps } from '../usecases/create-note.js';

/**
 * Lambda passes the context as the second argument; the handler takes the one
 * field it needs, so a log line can be tied back to the invocation that wrote
 * it. Optional because the context is Lambda's to supply, not the caller's.
 */
type Handler = (
  event: APIGatewayProxyEventV2,
  context?: Pick<Context, 'awsRequestId'>,
) => Promise<APIGatewayProxyResultV2>;

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function makeCreateNoteHandler(deps: CreateNoteDeps): Handler {
  return async (event, context) => {
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
      // A 4xx message was written for the caller to read. A 5xx one was not:
      // `AppError` defaults to 500/INTERNAL, so a table name, a host or an SDK
      // message arrives here wearing the same type as "title is required".
      // Typed does not mean safe to show — the status decides.
      if (error instanceof AppError && error.statusCode < 500) {
        return json(error.statusCode, { error: error.message, code: error.code });
      }
      deps.log.error('unhandled error in create-note', {
        // The whole error, not `String(error)`: a message with no frames is not
        // something anyone can debug from a log aggregator.
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        awsRequestId: context?.awsRequestId,
      });
      return json(500, { error: 'internal error' });
    }
  };
}
