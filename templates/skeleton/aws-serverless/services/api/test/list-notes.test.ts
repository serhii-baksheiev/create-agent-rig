import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { AppError, createLogger } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { makeListNotesHandler } from '../src/handlers/list-notes.js';
import { listNotesUsecase } from '../src/usecases/list-notes.js';

const note = {
  id: 'n1',
  title: 'Hello',
  slug: 'hello',
  tags: [],
  createdAt: '2024-01-01T00:00:00.000Z',
};

const asResult = (r: unknown) => r as APIGatewayProxyStructuredResultV2;

/** Lambda always passes the event and the context; this route needs no body. */
const getEvent = () => ({ isBase64Encoded: false }) as APIGatewayProxyEventV2;
const lambdaContext = (awsRequestId: string): Context => ({ awsRequestId }) as Context;

describe('listNotesUsecase', () => {
  it('returns what the model lists', async () => {
    expect(await listNotesUsecase({ notes: { list: async () => [note] } })).toEqual([note]);
  });
});

describe('GET /notes handler', () => {
  it('returns 200 with the notes', async () => {
    const handler = makeListNotesHandler({
      notes: { list: async () => [note] },
      log: createLogger({}, () => {}),
    });
    const result = asResult(await handler());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ notes: [note] });
  });

  it('maps typed errors and hides unknown ones', async () => {
    const typed = makeListNotesHandler({
      notes: { list: () => Promise.reject(new AppError('nope', { statusCode: 503, code: 'X' })) },
      log: createLogger({}, () => {}),
    });
    expect(asResult(await typed()).statusCode).toBe(503);

    const logs: string[] = [];
    const unknown = makeListNotesHandler({
      notes: { list: () => Promise.reject(new Error('secret')) },
      log: createLogger({}, (line) => logs.push(line)),
    });
    const result = asResult(await unknown());
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret');
    expect(logs.join('')).toContain('secret');
  });
});

// The same leak create-note was fixed for, and this handler had it too:
// `AppError` defaults to 500/INTERNAL, so a table name, a host or an SDK
// message arrives wearing the same type as "title is required", and every one
// of them used to reach the caller. Typed does not mean safe to show — the
// status decides, and these pin that both handlers decide it the same way.
describe('GET /notes keeps its internals to itself', () => {
  const failWith = (error: unknown, sink: (line: string) => void = () => {}) =>
    makeListNotesHandler({
      notes: { list: () => Promise.reject(error) },
      log: createLogger({}, sink),
    });

  it('hides a typed error that carries the default status behind a constant 500', async () => {
    const handler = failWith(new AppError('table NotesTable-prod is not authorised'));
    const result = asResult(await handler(getEvent(), lambdaContext('req-1')));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('NotesTable-prod');
    expect(JSON.parse(result.body!)).toEqual({ error: 'internal error' });
  });

  it('still forwards a 4xx message, which was written for the caller to read', async () => {
    const handler = failWith(new AppError('unknown tag filter', { statusCode: 400, code: 'BAD' }));
    const result = asResult(await handler(getEvent(), lambdaContext('req-2')));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toEqual({ error: 'unknown tag filter', code: 'BAD' });
  });

  it('logs the internal error it hid with its stack, so the detail is kept and not lost', async () => {
    const logs: string[] = [];
    const boom = new AppError('table NotesTable-prod is not authorised');
    await failWith(boom, (line) => logs.push(line))(getEvent(), lambdaContext('req-3'));
    // `String(error)` is a message with no frames — not something anyone can
    // debug from a log aggregator.
    expect(JSON.parse(logs[0]!)).toMatchObject({ stack: boom.stack });
  });

  // Same contract as create-note: the response withholds everything about a 5xx
  // AppError, so the log line is the only place that can still say WHICH
  // internal failure it was, and `code` is the one field safe to keep verbatim.
  // The body assertion stays beside it so the two halves cannot drift apart.
  it('logs the code of the internal error it withheld, and still keeps it out of the response', async () => {
    const logs: string[] = [];
    const handler = failWith(
      new AppError('table NotesTable-prod returned a torn item', { code: 'DATA_CORRUPT' }),
      (line) => logs.push(line),
    );
    const result = asResult(await handler(getEvent(), lambdaContext('req-4')));
    expect(JSON.parse(logs[0]!)).toMatchObject({ code: 'DATA_CORRUPT' });
    expect(result.body).not.toContain('DATA_CORRUPT');
    expect(JSON.parse(result.body!)).toEqual({ error: 'internal error' });
  });

  it('carries the Lambda request id into the line it logs', async () => {
    const logs: string[] = [];
    const handler = failWith(new AppError('table NotesTable-prod is not authorised'), (line) =>
      logs.push(line),
    );
    // Without it a log line cannot be tied to the invocation that produced it.
    await handler(getEvent(), lambdaContext('req-42'));
    expect(JSON.parse(logs[0]!)).toMatchObject({ awsRequestId: 'req-42' });
  });
});
