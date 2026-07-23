import { describe, expect, it } from 'vitest';
import { InvalidNoteError, createNote, slugify } from '../src/note.js';

const identity = { id: 'note-1', createdAt: '2024-01-01T00:00:00.000Z' };

describe('createNote', () => {
  it('builds a note from valid input', () => {
    const note = createNote({ title: 'Hello World', tags: ['a', 'b'] }, identity);
    expect(note).toEqual({
      id: 'note-1',
      title: 'Hello World',
      slug: 'hello-world',
      tags: ['a', 'b'],
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('is deterministic: identical arguments yield an identical note', () => {
    const a = createNote({ title: 'Same' }, identity);
    const b = createNote({ title: 'Same' }, identity);
    expect(a).toEqual(b);
  });

  it('defaults tags to an empty array', () => {
    expect(createNote({ title: 'No tags' }, identity).tags).toEqual([]);
  });

  it('trims the title', () => {
    expect(createNote({ title: '  padded  ' }, identity).title).toBe('padded');
  });

  it('deduplicates tags', () => {
    expect(createNote({ title: 'T', tags: ['x', 'x', 'y'] }, identity).tags).toEqual(['x', 'y']);
  });

  it('refuses an empty or whitespace-only title', () => {
    expect(() => createNote({ title: '' }, identity)).toThrow(InvalidNoteError);
    expect(() => createNote({ title: '   ' }, identity)).toThrow(InvalidNoteError);
  });

  it('refuses a title over 200 characters', () => {
    expect(() => createNote({ title: 'x'.repeat(201) }, identity)).toThrow(InvalidNoteError);
    expect(() => createNote({ title: 'x'.repeat(200) }, identity)).not.toThrow();
  });

  it('refuses more than 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(() => createNote({ title: 'T', tags }, identity)).toThrow(InvalidNoteError);
  });

  it('refuses empty or oversized tags', () => {
    expect(() => createNote({ title: 'T', tags: [''] }, identity)).toThrow(InvalidNoteError);
    expect(() => createNote({ title: 'T', tags: ['x'.repeat(41)] }, identity)).toThrow(
      InvalidNoteError,
    );
  });

  it('refuses non-object input', () => {
    for (const bad of [null, undefined, 42, 'title', []]) {
      expect(() => createNote(bad, identity)).toThrow(InvalidNoteError);
    }
  });

  it('refuses wrongly-typed fields', () => {
    expect(() => createNote({ title: 42 }, identity)).toThrow(InvalidNoteError);
    expect(() => createNote({ title: 'T', tags: 'not-an-array' }, identity)).toThrow(
      InvalidNoteError,
    );
  });

  it('reports every issue with its path', () => {
    try {
      createNote({ title: '', tags: [''] }, identity);
      expect.unreachable('should have thrown');
    } catch (error) {
      const invalid = error as InvalidNoteError;
      expect(invalid.issues.length).toBeGreaterThanOrEqual(2);
      expect(invalid.issues.join('\n')).toMatch(/title/);
      expect(invalid.issues.join('\n')).toMatch(/tags/);
    }
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses runs of non-alphanumerics and trims hyphens', () => {
    expect(slugify('  a -- b!! c  ')).toBe('a-b-c');
  });

  it('strips diacritics', () => {
    expect(slugify('Crème Brûlée')).toBe('creme-brulee');
  });

  it('falls back to "note" when nothing survives', () => {
    expect(slugify('!!!')).toBe('note');
    expect(slugify('日本語')).toBe('note');
  });
});
