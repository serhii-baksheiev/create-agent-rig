// Single-table layout: pk = NOTE#<id>, sk = META. One model, one table, one
// place that knows the key schema.
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { NoteSchema, type Note } from '@app/core';
import { NotFoundError } from '@app/shared';
import type { DocumentClient } from './client.js';

const noteKey = (id: string) => ({ pk: `NOTE#${id}`, sk: 'META' });

export class NoteModel {
  constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string,
  ) {}

  async put(note: Note): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...noteKey(note.id), ...note },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  }

  async get(id: string): Promise<Note> {
    const result = (await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: noteKey(id) }),
    )) as { Item?: Record<string, unknown> };
    if (!result.Item) {
      throw new NotFoundError(`note ${id} not found`);
    }
    // Validate on the way out too: the database is an external system.
    return NoteSchema.parse(result.Item);
  }

  async list(): Promise<Note[]> {
    // A filtered Scan is fine at skeleton scale; swap for a GSI Query when
    // real data volume arrives (a Tier-2 change — it touches the schema).
    const result = (await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'sk = :meta',
        ExpressionAttributeValues: { ':meta': 'META' },
      }),
    )) as { Items?: Array<Record<string, unknown>> };
    // Validate every entry — silently skipping corruption would hide data loss.
    return (result.Items ?? [])
      .map((item) => NoteSchema.parse(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
