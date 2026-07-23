import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AppError, createLogger } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { makeCreateNoteHandler } from '../src/handlers/create-note.js';
import type { CreateNoteDeps } from '../src/usecases/create-note.js';

const event = (body: string): APIGatewayProxyEventV2 =>
  ({ body, isBase64Encoded: false }) as APIGatewayProxyEventV2;

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
});
