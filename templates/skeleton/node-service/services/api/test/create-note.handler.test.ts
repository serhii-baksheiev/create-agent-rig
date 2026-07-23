import { AppError, createLogger } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { makeCreateNoteHandler } from '../src/handlers/create-note.js';
import type { CreateNoteDeps } from '../src/usecases/create-note.js';

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

describe('POST /notes handler', () => {
  it('returns 201 with the created note', async () => {
    const handler = makeCreateNoteHandler(stubDeps());
    const result = await handler(JSON.stringify({ title: 'Hello' }));
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body)).toMatchObject({
      note: { id: 'fixed-id', slug: 'hello', createdAt: '2024-01-01T00:00:00.000Z' },
    });
  });

  it('returns 400 for malformed JSON', async () => {
    const result = await makeCreateNoteHandler(stubDeps())('{not json');
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 with issues for invalid input', async () => {
    const result = await makeCreateNoteHandler(stubDeps())(JSON.stringify({ title: '' }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).issues.join(' ')).toMatch(/title/);
  });

  it('maps typed errors to their status code', async () => {
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: {
          put: () => Promise.reject(new AppError('conflict', { statusCode: 409, code: 'DUP' })),
        },
      }),
    );
    const result = await handler(JSON.stringify({ title: 'T' }));
    expect(result.statusCode).toBe(409);
  });

  it('hides unknown errors behind a 500 and logs them', async () => {
    const logs: string[] = [];
    const handler = makeCreateNoteHandler(
      stubDeps({
        notes: { put: () => Promise.reject(new Error('secret detail')) },
        log: createLogger({}, (line) => logs.push(line)),
      }),
    );
    const result = await handler(JSON.stringify({ title: 'T' }));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret detail');
    expect(logs.join('\n')).toContain('secret detail');
  });
});
