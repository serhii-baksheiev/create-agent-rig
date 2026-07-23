// Integration: the real HTTP server over a real socket, with real file
// storage and a real spool directory — the whole request path at once.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { JsonFileNoteStore } from '@app/db';
import { createLogger } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SpoolEventPublisher } from '../src/adapters/spool-publisher.js';
import { makeServer } from '../src/server.js';

let dir: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'api-int-'));
  let n = 0;
  server = makeServer({
    notes: new JsonFileNoteStore(path.join(dir, 'data', 'notes.json')),
    events: new SpoolEventPublisher(path.join(dir, 'queue'), () => `msg-${++n}`),
    newId: () => `id-${++n}`,
    now: () => '2024-01-01T00:00:00.000Z',
    log: createLogger({}, () => {}),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

describe('the service end to end', () => {
  it('creates a note over HTTP, persists it, and spools the event', async () => {
    const response = await fetch(`${baseUrl}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Integration proof', tags: ['e2e'] }),
    });
    expect(response.status).toBe(201);
    const { note } = (await response.json()) as { note: { slug: string } };
    expect(note.slug).toBe('integration-proof');

    expect(await readdir(path.join(dir, 'queue'))).toHaveLength(1);
    expect(await readdir(path.join(dir, 'data'))).toContain('notes.json');
  });

  it('rejects invalid input with 400', async () => {
    const response = await fetch(`${baseUrl}/notes`, {
      method: 'POST',
      body: JSON.stringify({ title: '' }),
    });
    expect(response.status).toBe(400);
  });

  it('404s unknown routes', async () => {
    const response = await fetch(`${baseUrl}/other`);
    expect(response.status).toBe(404);
  });
});
