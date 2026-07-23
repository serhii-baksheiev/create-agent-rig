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

describe('listNotesUsecase', () => {
  it('returns what the store lists', async () => {
    expect(await listNotesUsecase({ notes: { list: async () => [note] } })).toEqual([note]);
  });
});

describe('GET /notes handler', () => {
  it('returns 200 with the notes', async () => {
    const handler = makeListNotesHandler({
      notes: { list: async () => [note] },
      log: createLogger({}, () => {}),
    });
    const result = await handler();
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ notes: [note] });
  });

  it('maps typed errors and hides unknown ones', async () => {
    const typed = makeListNotesHandler({
      notes: { list: () => Promise.reject(new AppError('nope', { statusCode: 503, code: 'X' })) },
      log: createLogger({}, () => {}),
    });
    expect((await typed()).statusCode).toBe(503);

    const logs: string[] = [];
    const unknown = makeListNotesHandler({
      notes: { list: () => Promise.reject(new Error('secret')) },
      log: createLogger({}, (line) => logs.push(line)),
    });
    const result = await unknown();
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret');
    expect(logs.join('')).toContain('secret');
  });
});
