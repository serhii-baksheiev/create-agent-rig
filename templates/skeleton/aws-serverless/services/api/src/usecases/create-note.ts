// The usecase layer is mandatory: every business operation lives here, and
// handlers call nothing below it. Dependencies are consumer-owned interfaces —
// the usecase says what it needs, adapters satisfy it.
import { createNote, makeNoteCreatedEvent, type Note, type NoteCreatedEvent } from '@app/core';
import type { Logger } from '@app/shared';

export interface NoteStore {
  put(note: Note): Promise<void>;
}

export interface EventPublisher {
  publish(event: NoteCreatedEvent): Promise<void>;
}

export interface CreateNoteDeps {
  notes: NoteStore;
  events: EventPublisher;
  /** Id generation and the clock are decided here, never inside the core. */
  newId(): string;
  now(): string;
  log: Logger;
}

/**
 * ⚠ These are **two writes and they are not atomic** — a dual write. The put
 * can succeed and the publish then fail, which leaves a stored note whose event
 * never happened: the worker does not run, nothing downstream hears about it,
 * and nothing here compensates. The caller sees a 500 for a note that exists.
 *
 * That is a deliberate simplification for a skeleton, not a pattern to copy at
 * scale. The two ways out, when it starts to matter: an **outbox** (write the
 * event into the same transaction as the note, relay it after), or DynamoDB
 * Streams feeding the worker, which removes the second write entirely.
 */
export async function createNoteUsecase(input: unknown, deps: CreateNoteDeps): Promise<Note> {
  const note = createNote(input, { id: deps.newId(), createdAt: deps.now() });
  await deps.notes.put(note);
  await deps.events.publish(makeNoteCreatedEvent(note));
  deps.log.info('note created', { noteId: note.id, slug: note.slug });
  return note;
}
