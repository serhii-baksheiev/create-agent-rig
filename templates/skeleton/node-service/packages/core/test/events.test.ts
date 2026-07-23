import { describe, expect, it } from 'vitest';
import { NoteCreatedEventSchema, makeNoteCreatedEvent } from '../src/events.js';
import { createNote } from '../src/note.js';

const note = createNote({ title: 'Hello' }, { id: 'n1', createdAt: '2024-01-01T00:00:00.000Z' });

describe('note.created event', () => {
  it('wraps a note and round-trips through its own schema', () => {
    const event = makeNoteCreatedEvent(note);
    expect(event.type).toBe('note.created');
    expect(NoteCreatedEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('rejects a payload with the wrong type tag', () => {
    expect(NoteCreatedEventSchema.safeParse({ type: 'other', note }).success).toBe(false);
  });

  it('rejects a payload with a malformed note', () => {
    expect(
      NoteCreatedEventSchema.safeParse({ type: 'note.created', note: { id: '' } }).success,
    ).toBe(false);
  });
});
