// Integration: the real HTTP server over a real socket, with real file
// storage and a real spool directory — the whole request path at once.
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('lists created notes back on GET /notes (the UI read path)', async () => {
    for (const title of ['First note', 'Second note']) {
      await fetch(`${baseUrl}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    }
    const response = await fetch(`${baseUrl}/notes`);
    expect(response.status).toBe(200);
    const { notes } = (await response.json()) as { notes: Array<{ title: string }> };
    expect(notes).toHaveLength(2);
  });

  it('refuses a request body larger than the cap with 413', async () => {
    // Well-formed JSON on purpose: what is rejected is the size, not the shape.
    // The server must answer before it has buffered the whole upload, and must
    // stay readable long enough for the client to see that answer.
    const body = JSON.stringify({ title: 'x'.repeat(1024 * 1024 + 1024) });
    const response = await fetch(`${baseUrl}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(413);
  });
});

/** A listening server serving `staticDir`, plus its base URL. */
async function startStaticServer(staticDir: string): Promise<{ server: Server; base: string }> {
  const server = makeServer(
    {
      notes: new JsonFileNoteStore(path.join(dir, 'data', 'notes.json')),
      events: new SpoolEventPublisher(path.join(dir, 'queue'), () => 'm'),
      newId: () => 'id',
      now: () => '2024-01-01T00:00:00.000Z',
      log: createLogger({}, () => {}),
    },
    { staticDir },
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// Windows has no POSIX mode bits, and root reads a 0o000 file regardless — in
// both cases the "unreadable file" this test needs cannot be built at all.
const cannotMakeFileUnreadable = process.platform === 'win32' || process.getuid?.() === 0;
// Creating a symlink on Windows needs a privilege the test runner may not hold.
const cannotSymlink = process.platform === 'win32';

describe('static serving (the built web bundle)', () => {
  let staticServer: Server;
  let staticBase: string;

  beforeEach(async () => {
    await mkdir(path.join(dir, 'static'), { recursive: true });
    await writeFile(path.join(dir, 'static', 'index.html'), '<h1>web shell</h1>');
    ({ server: staticServer, base: staticBase } = await startStaticServer(
      path.join(dir, 'static'),
    ));
  });

  afterEach(async () => {
    await new Promise((resolve) => staticServer.close(resolve));
  });

  it('serves index.html at the root', async () => {
    const response = await fetch(staticBase + '/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('web shell');
  });

  it('refuses path traversal out of the static dir', async () => {
    await writeFile(path.join(dir, 'secret.txt'), 'nope');
    const response = await fetch(staticBase + '/%2e%2e/secret.txt');
    expect(response.status).toBe(404);
  });

  it('API routes still win over static files', async () => {
    const response = await fetch(staticBase + '/notes');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('answers 400 to an undecodable URL and keeps serving afterwards', async () => {
    // The signal is a leash, not a relaxation: a server that dies on this URL
    // never answers at all, and the run should say so in seconds.
    const response = await fetch(staticBase + '/%', { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(400);

    const afterwards = await fetch(staticBase + '/');
    expect(afterwards.status).toBe(200);
    expect(await afterwards.text()).toContain('web shell');
  });

  it.skipIf(cannotMakeFileUnreadable)(
    'answers a file it cannot open and keeps serving afterwards',
    async () => {
      // A file that passes stat() but fails open() (EACCES here; in production
      // the stat/open race gives ENOENT). Before the headers are held back
      // until the stream opens, that error reached no handler at all and the
      // process paid for one unreadable file.
      const locked = path.join(dir, 'static', 'locked.txt');
      await writeFile(locked, 'unreadable');
      await chmod(locked, 0o000);
      try {
        const response = await fetch(staticBase + '/locked.txt', {
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(500);

        const afterwards = await fetch(staticBase + '/');
        expect(afterwards.status).toBe(200);
        expect(await afterwards.text()).toContain('web shell');
      } finally {
        // Restore before afterEach removes the temp dir.
        await chmod(locked, 0o600);
      }
    },
  );

  it.skipIf(cannotSymlink)('refuses a symlink that escapes the static dir', async () => {
    // A lexical guard inspects only the resolved string, while stat and the
    // read stream follow the link wherever it points — which is why the guard
    // asks realpath as well.
    await writeFile(path.join(dir, 'secret-target.txt'), 'nope');
    await symlink(path.join(dir, 'secret-target.txt'), path.join(dir, 'static', 'escape.txt'));

    const response = await fetch(staticBase + '/escape.txt');
    expect(response.status).toBe(404);
  });

  it('serves the bundle when the configured static dir has a trailing separator', async () => {
    const { server, base } = await startStaticServer(path.join(dir, 'static') + path.sep);
    try {
      const response = await fetch(base + '/');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('web shell');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
