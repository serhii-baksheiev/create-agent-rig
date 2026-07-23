import { InvalidNoteError, type Note, type NoteCreatedEvent } from '@app/core';
import { createLogger } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { createNoteUsecase, type CreateNoteDeps } from '../src/usecases/create-note.js';

function stubDeps() {
  const stored: Note[] = [];
  const published: NoteCreatedEvent[] = [];
  const logs: string[] = [];
  const deps: CreateNoteDeps = {
    notes: { put: async (note) => void stored.push(note) },
    events: { publish: async (event) => void published.push(event) },
    newId: () => 'fixed-id',
    now: () => '2024-01-01T00:00:00.000Z',
    log: createLogger({}, (line) => logs.push(line)),
  };
  return { deps, stored, published, logs };
}

describe('createNoteUsecase', () => {
  it('creates, stores, publishes, and logs — in that order of effects', async () => {
    const { deps, stored, published, logs } = stubDeps();
    const note = await createNoteUsecase({ title: 'Hello World' }, deps);
    expect(note).toMatchObject({ id: 'fixed-id', slug: 'hello-world' });
    expect(stored).toEqual([note]);
    expect(published).toEqual([{ type: 'note.created', note }]);
    expect(logs.join('\n')).toContain('fixed-id');
  });

  it('rejects invalid input before any side effect', async () => {
    const { deps, stored, published } = stubDeps();
    await expect(createNoteUsecase({ title: '' }, deps)).rejects.toThrow(InvalidNoteError);
    expect(stored).toEqual([]);
    expect(published).toEqual([]);
  });

  it('propagates store failures and does not publish', async () => {
    const { deps, published } = stubDeps();
    deps.notes = {
      put: () => Promise.reject(new Error('dynamo down')),
    };
    await expect(createNoteUsecase({ title: 'T' }, deps)).rejects.toThrow('dynamo down');
    expect(published).toEqual([]);
  });
});
