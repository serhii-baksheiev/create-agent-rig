import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { AppError } from '@app/shared';
import type { Logger } from '@app/shared';
import { listNotesUsecase, type ListNotesDeps } from '../usecases/list-notes.js';

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function makeListNotesHandler(deps: ListNotesDeps & { log: Logger }) {
  return async (
    _event?: APIGatewayProxyEventV2,
    context?: Pick<Context, 'awsRequestId'>,
  ): Promise<APIGatewayProxyResultV2> => {
    try {
      return json(200, { notes: await listNotesUsecase(deps) });
    } catch (error) {
      // Same contract as create-note: a 4xx message was written for the caller,
      // a 5xx one was not. The status survives — 503 tells a caller to retry
      // and 500 does not — and only the message is withheld.
      if (error instanceof AppError && error.statusCode < 500) {
        return json(error.statusCode, { error: error.message, code: error.code });
      }
      deps.log.error('unhandled error in list-notes', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        // The one field of a withheld AppError worth keeping: it says WHICH
        // internal failure this was, and it never reaches the caller.
        code: error instanceof AppError ? error.code : undefined,
        awsRequestId: context?.awsRequestId,
      });
      return json(error instanceof AppError ? error.statusCode : 500, { error: 'internal error' });
    }
  };
}
