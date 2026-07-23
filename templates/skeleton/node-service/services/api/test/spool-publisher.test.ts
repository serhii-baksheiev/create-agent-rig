import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNote, makeNoteCreatedEvent } from '@app/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpoolEventPublisher } from '../src/adapters/spool-publisher.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'spool-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SpoolEventPublisher', () => {
  it('writes one complete JSON message file per event', async () => {
    const queueDir = path.join(dir, 'queue');
    let n = 0;
    const publisher = new SpoolEventPublisher(queueDir, () => `msg-${++n}`);
    const note = createNote({ title: 'Hi' }, { id: 'n1', createdAt: '2024-01-01T00:00:00.000Z' });
    const event = makeNoteCreatedEvent(note);
    await publisher.publish(event);
    await publisher.publish(event);

    const files = (await readdir(queueDir)).sort();
    expect(files).toEqual(['msg-1.json', 'msg-2.json']);
    expect(JSON.parse(await readFile(path.join(queueDir, 'msg-1.json'), 'utf8'))).toEqual(event);
  });
});
