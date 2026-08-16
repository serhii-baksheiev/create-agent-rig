import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { AppError, createLogger } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { makeCreateNoteHandler } from '../src/handlers/create-note.js';
import type { CreateNoteDeps } from '../src/usecases/create-note.js';

const event = (body: string): APIGatewayProxyEventV2 =>
  ({ body, isBase64Encoded: false }) as APIGatewayProxyEventV2;

/** Lambda always passes a context; the handler only ever needs the request id. */
const lambdaContext = (awsRequestId: string): Context => ({ awsRequestId }) as Context;

function stubDeps(overrides: Partial<CreateNoteDeps> = {}) {
  const deps: CreateNoteDeps = {
    notes: { put: async () => {} },
    events: { publish: async () => {} },
    newId: () => 'fixed-id',
    now: () => '2024-01-01T00:00:00.000Z',
    log: createLogger({}, () => {}),
    ...overrides,
  };
  return deps;
}

const asResult = (r: unknown) => r as APIGatewayProxyStructuredResultV2;

describe('POST /notes handler', () => {
  it('returns 201 with the created note', async () => {
    const handler = makeCreateNoteHandler(stubDeps());
    const result = asResult(await handler(event(JSON.stringify({ title: 'Hello' }))));
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body!)).toMatchObject({
      note: { id: 'fixed-id', slug: 'hello', createdAt: '2024-01-01T00:00:00.000Z' },
    });
  });

  it('decodes base64-encoded bodies', async () => {
    const handler = makeCreateNoteHandler(stubDeps());
    const raw = Buffer.from(JSON.stringify({ title: 'Encoded' })).toString('base64');
    const result = asResult(
      await handler({ body: raw, isBase64Encoded: true } as APIGatewayProxyEventV2),
    );
    expect(result.statusCode).toBe(201);
  });

  it('returns 400 for malformed JSON without touching the store', async () => {
    let touched = false;
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: {
          put: async () => {
            touched = true;
          },
        },
      }),
    );
    const result = asResult(await handler(event('{not json')));
    expect(result.statusCode).toBe(400);
    expect(touched).toBe(false);
  });

  it('returns 400 with issues for invalid input', async () => {
    const handler = makeCreateNoteHandler(stubDeps());
    const result = asResult(await handler(event(JSON.stringify({ title: '' }))));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).issues.join(' ')).toMatch(/title/);
  });

  it('maps typed errors to their status code', async () => {
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: {
          put: () => Promise.reject(new AppError('conflict', { statusCode: 409, code: 'DUP' })),
        },
      }),
    );
    const result = asResult(await handler(event(JSON.stringify({ title: 'T' }))));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body!)).toEqual({ error: 'conflict', code: 'DUP' });
  });

  it('hides unknown errors behind a 500 and logs them', async () => {
    const logs: string[] = [];
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: { put: () => Promise.reject(new Error('secret detail')) },
        log: createLogger({}, (line) => logs.push(line)),
      }),
    );
    const result = asResult(await handler(event(JSON.stringify({ title: 'T' }))));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret detail');
    expect(logs.join('\n')).toContain('secret detail');
  });

  // AppError defaults to statusCode 500 / code INTERNAL, so "typed" does not
  // mean "safe to show": a table name, a host, an SDK message all arrive this
  // way. Only a 4xx AppError is a message the caller was meant to read.
  it('hides a typed error that carries the default status behind the same constant 500', async () => {
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: {
          put: () => Promise.reject(new AppError('table NotesTable-prod is not authorised')),
        },
      }),
    );
    const result = asResult(await handler(event(JSON.stringify({ title: 'T' }))));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('NotesTable-prod');
    expect(JSON.parse(result.body!)).toEqual({ error: 'internal error' });
  });

  // Withholding the message is not the same decision as flattening the status.
  // 503 tells a caller to retry and 500 tells it not to bother, and that
  // distinction is transport, not disclosure — the sibling handler pins it
  // (`list-notes.test.ts`), and this one did not, so collapsing the status here
  // passed the whole suite.
  it('keeps a 5xx status the caller can act on, while still hiding the message', async () => {
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: {
          put: () =>
            Promise.reject(
              new AppError('table NotesTable-prod is throttling', {
                statusCode: 503,
                code: 'X',
              }),
            ),
        },
      }),
    );
    const result = asResult(await handler(event(JSON.stringify({ title: 'T' }))));
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('NotesTable-prod');
    expect(JSON.parse(result.body!)).toEqual({ error: 'internal error' });
  });

  it('logs the typed internal error it hid, so the detail is kept and not lost', async () => {
    const logs: string[] = [];
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: {
          put: () => Promise.reject(new AppError('table NotesTable-prod is not authorised')),
        },
        log: createLogger({}, (line) => logs.push(line)),
      }),
    );
    await handler(event(JSON.stringify({ title: 'T' })));
    expect(logs.join('\n')).toContain('NotesTable-prod');
  });

  it('logs the failure with its stack, not only its message', async () => {
    const logs: string[] = [];
    const boom = new Error('secret detail');
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: { put: () => Promise.reject(boom) },
        log: createLogger({}, (line) => logs.push(line)),
      }),
    );
    await handler(event(JSON.stringify({ title: 'T' })));
    // `String(error)` is "Error: secret detail" — a message with no frames is
    // not something anyone can debug from CloudWatch.
    expect(JSON.parse(logs[0]!)).toMatchObject({ stack: boom.stack });
  });

  // The response withholds everything about a 5xx AppError, so the log line is
  // the only place left that can say WHICH internal failure it was — and `code`
  // is the one field of that error which is safe to keep verbatim. Losing it
  // flattens DATA_CORRUPT, INTERNAL and every future code into one shape nobody
  // can triage. The body assertion lives here on purpose: the two halves of the
  // contract ("kept in the log", "still absent from the response") must not
  // drift apart.
  it('logs the code of the internal error it withheld, and still keeps it out of the response', async () => {
    const logs: string[] = [];
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: {
          put: () =>
            Promise.reject(
              new AppError('table NotesTable-prod returned a torn item', {
                code: 'DATA_CORRUPT',
              }),
            ),
        },
        log: createLogger({}, (line) => logs.push(line)),
      }),
    );
    const result = asResult(await handler(event(JSON.stringify({ title: 'T' }))));
    expect(JSON.parse(logs[0]!)).toMatchObject({ code: 'DATA_CORRUPT' });
    expect(result.body).not.toContain('DATA_CORRUPT');
    expect(JSON.parse(result.body!)).toEqual({ error: 'internal error' });
  });

  it('carries the Lambda request id into the line it logs', async () => {
    const logs: string[] = [];
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: { put: () => Promise.reject(new Error('secret detail')) },
        log: createLogger({}, (line) => logs.push(line)),
      }),
    );
    // Without it a log line cannot be tied to the invocation that produced it.
    await handler(event(JSON.stringify({ title: 'T' })), lambdaContext('req-42'));
    expect(JSON.parse(logs[0]!)).toMatchObject({ awsRequestId: 'req-42' });
  });
});
