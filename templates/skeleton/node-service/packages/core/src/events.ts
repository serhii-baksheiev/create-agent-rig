// Domain event vocabulary. The schema is the contract between the API (producer)
// and the worker (consumer) — both sides validate against it.
import { z } from 'zod';
import { NoteSchema, type Note } from './note.js';

export const NoteCreatedEventSchema = z.object({
  type: z.literal('note.created'),
  note: NoteSchema,
});
export type NoteCreatedEvent = z.infer<typeof NoteCreatedEventSchema>;

export function makeNoteCreatedEvent(note: Note): NoteCreatedEvent {
  return { type: 'note.created', note };
}
