import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { makeNoteCreatedEvent, createNote } from '@app/core';
import { describe, expect, it } from 'vitest';
import { SqsEventPublisher } from '../src/adapters/sqs-publisher.js';

describe('SqsEventPublisher', () => {
  it('sends the JSON-encoded event to the configured queue', async () => {
    const sent: unknown[] = [];
    const publisher = new SqsEventPublisher(
      { send: (c) => (sent.push(c), Promise.resolve({})) },
      'https://queue.example/q',
    );
    const note = createNote({ title: 'Hi' }, { id: 'n1', createdAt: '2024-01-01T00:00:00.000Z' });
    const event = makeNoteCreatedEvent(note);
    await publisher.publish(event);

    const command = sent[0] as SendMessageCommand;
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input.QueueUrl).toBe('https://queue.example/q');
    expect(JSON.parse(command.input.MessageBody!)).toEqual(event);
  });
});
