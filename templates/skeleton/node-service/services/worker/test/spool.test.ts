import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNote, makeNoteCreatedEvent } from '@app/core';
import { createLogger } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processNoteCreated } from '../src/usecases/process-note-created.js';
import { processSpoolOnce, type SpoolConfig } from '../src/spool.js';

const note = createNote({ title: 'Hello' }, { id: 'n1', createdAt: '2024-01-01T00:00:00.000Z' });
const validBody = JSON.stringify(makeNoteCreatedEvent(note));

let dir: string;
let config: SpoolConfig;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'spool-worker-'));
  config = {
    queueDir: path.join(dir, 'queue'),
    dlqDir: path.join(dir, 'dlq'),
    maxAttempts: 3,
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeDeps() {
  const lines: string[] = [];
  const log = createLogger({}, (line) => lines.push(line));
  return { deps: { log, process: (raw: string) => processNoteCreated(raw, { log }) }, lines };
}

async function spool(name: string, content: string) {
  await writeFile(path.join(config.queueDir, name), content);
}

describe('processSpoolOnce', () => {
  it('processes valid messages and removes them', async () => {
    const { deps, lines } = makeDeps();
    await processSpoolOnce(config, deps); // creates the dirs
    await spool('m1.json', validBody);
    await spool('m2.json', validBody);

    expect(await processSpoolOnce(config, deps)).toBe(2);
    expect(await readdir(config.queueDir)).toEqual([]);
    expect(await readdir(config.dlqDir)).toEqual([]);
    expect(lines.filter((l) => l.includes('note.created processed'))).toHaveLength(2);
  });

  it('retries poison, then dead-letters it with an ALARM after maxAttempts', async () => {
    const { deps, lines } = makeDeps();
    await processSpoolOnce(config, deps);
    await spool('poison.json', 'not json');

    expect(await processSpoolOnce(config, deps)).toBe(0); // attempt 1 → retry1
    expect(await readdir(config.queueDir)).toEqual(['poison.retry1.json']);
    expect(await processSpoolOnce(config, deps)).toBe(0); // attempt 2 → retry2
    expect(await readdir(config.queueDir)).toEqual(['poison.retry2.json']);
    expect(await processSpoolOnce(config, deps)).toBe(0); // attempt 3 → DLQ
    expect(await readdir(config.queueDir)).toEqual([]);
    expect(await readdir(config.dlqDir)).toEqual(['poison.retry2.json']);
    expect(lines.some((line) => line.includes('ALARM'))).toBe(true);
  });

  it('keeps processing good messages when one is poison', async () => {
    const { deps } = makeDeps();
    await processSpoolOnce(config, deps);
    await spool('a-poison.json', '{broken');
    await spool('b-good.json', validBody);

    expect(await processSpoolOnce(config, deps)).toBe(1);
    expect(await readdir(config.queueDir)).toEqual(['a-poison.retry1.json']);
  });
});
