// THE load-bearing test of the frontend (web brief §5): the browser-side
// validator and the server-side schema must be the same decision procedure.
// No jsdom, no rendering — the boundary is the point, not the pixels.
import { InvalidNoteError, NewNoteSchema, createNote } from '@app/core';
import { describe, expect, it } from 'vitest';
import { validateNewNote } from '../src/lib/validate';

const identity = { id: 'n1', createdAt: '2024-01-01T00:00:00.000Z' };

const CASES: Array<{ name: string; input: unknown }> = [
  { name: 'valid minimal', input: { title: 'Hello' } },
  { name: 'valid with tags', input: { title: 'Hello', tags: ['a', 'b'] } },
  { name: 'empty title', input: { title: '' } },
  { name: 'whitespace title', input: { title: '   ' } },
  { name: 'title too long', input: { title: 'x'.repeat(201) } },
  { name: 'too many tags', input: { title: 'T', tags: Array.from({ length: 11 }, (_, i) => `${i}`) } },
  { name: 'empty tag', input: { title: 'T', tags: [''] } },
  { name: 'wrong types', input: { title: 42 } },
  { name: 'not an object', input: 'nope' },
];

describe('one schema, both sides of the wire', () => {
  for (const { name, input } of CASES) {
    it(`web and core agree on: ${name}`, () => {
      const webVerdict = validateNewNote(input);
      const coreVerdict = NewNoteSchema.safeParse(input);
      expect(webVerdict.ok).toBe(coreVerdict.success);

      // …and the domain function (used by the API usecase) agrees with both.
      if (coreVerdict.success) {
        expect(() => createNote(input, identity)).not.toThrow();
      } else {
        expect(() => createNote(input, identity)).toThrow(InvalidNoteError);
        expect(webVerdict.issues.length).toBeGreaterThan(0);
      }
    });
  }
});
