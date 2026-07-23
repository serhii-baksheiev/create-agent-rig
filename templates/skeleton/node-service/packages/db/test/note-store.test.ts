import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError, NotFoundError } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileNoteStore } from '../src/note-store.js';

const note = {
  id: 'n1',
  title: 'Hello',
  slug: 'hello',
  tags: ['x'],
  createdAt: '2024-01-01T00:00:00.000Z',
};

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'note-store-'));
  file = path.join(dir, 'data', 'notes.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonFileNoteStore', () => {
  it('round-trips a note (creating the data dir on first write)', async () => {
    const store = new JsonFileNoteStore(file);
    await store.put(note);
    expect(await store.get('n1')).toEqual(note);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n1: note });
  });

  it('refuses to overwrite an existing id', async () => {
    const store = new JsonFileNoteStore(file);
    await store.put(note);
    await expect(store.put(note)).rejects.toThrow(AppError);
    await expect(store.put(note)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('throws NotFoundError on a miss', async () => {
    await expect(new JsonFileNoteStore(file).get('nope')).rejects.toThrow(NotFoundError);
  });

  it('refuses corrupt stored entries instead of returning them', async () => {
    const store = new JsonFileNoteStore(file);
    await store.put(note);
    const table = JSON.parse(await readFile(file, 'utf8'));
    table.n1 = { id: 'n1' };
    await writeFile(file, JSON.stringify(table));
    await expect(store.get('n1')).rejects.toThrow();
  });

  it('reports a corrupt data file clearly', async () => {
    const store = new JsonFileNoteStore(file);
    await store.put(note);
    await writeFile(file, '{not json');
    await expect(store.get('n1')).rejects.toMatchObject({ code: 'DATA_CORRUPT' });
  });
});
