// Queue discipline: validate the message against the shared event schema; a
// message that does not parse is poison — throw, let the spool retry it, and
// after the retry budget the DLQ directory (watched by the alarm log line)
// catches it. Never swallow poison.
import { NoteCreatedEventSchema, type NoteCreatedEvent } from '@app/core';
import { ValidationError, type Logger } from '@app/shared';

export interface ProcessDeps {
  log: Logger;
}

export function parseNoteCreatedEvent(raw: string): NoteCreatedEvent {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new ValidationError('message body is not JSON');
  }
  const parsed = NoteCreatedEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ValidationError(
      'message is not a note.created event',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export async function processNoteCreated(raw: string, deps: ProcessDeps): Promise<void> {
  const event = parseNoteCreatedEvent(raw);
  // The skeleton's "processing" is deliberately small: acknowledge the note.
  // Replace this with real downstream work; keep the validate-first shape.
  deps.log.info('note.created processed', {
    noteId: event.note.id,
    slug: event.note.slug,
    tagCount: event.note.tags.length,
  });
}
