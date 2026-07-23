import type { SQSEvent } from 'aws-lambda';
import { createNote, makeNoteCreatedEvent } from '@app/core';
import { ValidationError, createLogger } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { makeNoteCreatedHandler } from '../src/handlers/note-created.js';
import { parseNoteCreatedEvent, processNoteCreated } from '../src/usecases/process-note-created.js';

const note = createNote({ title: 'Hello' }, { id: 'n1', createdAt: '2024-01-01T00:00:00.000Z' });
const validBody = JSON.stringify(makeNoteCreatedEvent(note));

const sqsEvent = (...bodies: string[]): SQSEvent =>
  ({ Records: bodies.map((body) => ({ body })) }) as SQSEvent;

function collectLogs() {
  const lines: string[] = [];
  return { log: createLogger({}, (line) => lines.push(line)), lines };
}

describe('parseNoteCreatedEvent', () => {
  it('parses a valid event', () => {
    expect(parseNoteCreatedEvent(validBody).note.id).toBe('n1');
  });

  it('throws ValidationError for non-JSON bodies', () => {
    expect(() => parseNoteCreatedEvent('not json')).toThrow(ValidationError);
  });

  it('throws ValidationError for JSON that is not a note.created event', () => {
    expect(() => parseNoteCreatedEvent(JSON.stringify({ type: 'other' }))).toThrow(
      ValidationError,
    );
  });
});

describe('processNoteCreated', () => {
  it('logs the processed note', async () => {
    const { log, lines } = collectLogs();
    await processNoteCreated(validBody, { log });
    expect(lines.join('\n')).toContain('n1');
  });

  it('lets poison messages throw — the DLQ is the safety net, not a catch block', async () => {
    const { log } = collectLogs();
    await expect(processNoteCreated('poison', { log })).rejects.toThrow(ValidationError);
  });
});

describe('makeNoteCreatedHandler', () => {
  it('processes every record in the batch', async () => {
    const { log, lines } = collectLogs();
    await makeNoteCreatedHandler({ log })(sqsEvent(validBody, validBody));
    expect(lines).toHaveLength(2);
  });

  it('propagates the failure of a poison record', async () => {
    const { log } = collectLogs();
    await expect(makeNoteCreatedHandler({ log })(sqsEvent('poison'))).rejects.toThrow(
      ValidationError,
    );
  });
});
