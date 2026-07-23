import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { NotFoundError } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { NoteModel } from '../src/note-model.js';
import type { DocumentClient } from '../src/client.js';

const note = {
  id: 'n1',
  title: 'Hello',
  slug: 'hello',
  tags: ['x'],
  createdAt: '2024-01-01T00:00:00.000Z',
};

function stubClient(response: unknown = {}) {
  const sent: unknown[] = [];
  const client: DocumentClient = {
    send: (command) => {
      sent.push(command);
      return Promise.resolve(response);
    },
  };
  return { client, sent };
}

describe('NoteModel.put', () => {
  it('writes the note under the single-table key, refusing overwrites', async () => {
    const { client, sent } = stubClient();
    await new NoteModel(client, 'notes-table').put(note);
    expect(sent).toHaveLength(1);
    const command = sent[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input).toMatchObject({
      TableName: 'notes-table',
      Item: { pk: 'NOTE#n1', sk: 'META', ...note },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });
});

describe('NoteModel.get', () => {
  it('reads by key and validates the stored shape', async () => {
    const { client, sent } = stubClient({ Item: { pk: 'NOTE#n1', sk: 'META', ...note } });
    const loaded = await new NoteModel(client, 'notes-table').get('n1');
    expect(loaded).toEqual(note);
    const command = sent[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toMatchObject({
      TableName: 'notes-table',
      Key: { pk: 'NOTE#n1', sk: 'META' },
    });
  });

  it('throws NotFoundError on a miss', async () => {
    const { client } = stubClient({});
    await expect(new NoteModel(client, 'notes-table').get('nope')).rejects.toThrow(NotFoundError);
  });

  it('refuses corrupt stored data instead of returning it', async () => {
    const { client } = stubClient({ Item: { pk: 'NOTE#n1', sk: 'META', id: 'n1' } });
    await expect(new NoteModel(client, 'notes-table').get('n1')).rejects.toThrow();
  });
});
