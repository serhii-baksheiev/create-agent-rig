// Thin HTTP shell around the handlers: routing, body collection, and (when
// configured) serving the built web bundle. No second runtime for the
// frontend — the same process serves the static export.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { CreateNoteDeps } from './usecases/create-note.js';
import type { ListNotesDeps } from './usecases/list-notes.js';
import { makeCreateNoteHandler } from './handlers/create-note.js';
import { makeListNotesHandler } from './handlers/list-notes.js';
import type { HttpResponse } from './handlers/create-note.js';

export type ServerDeps = CreateNoteDeps & ListNotesDeps;

export interface ServerOptions {
  /** Directory of the built web bundle (apps/web/out). Unset = API only. */
  staticDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function makeServer(deps: ServerDeps, options: ServerOptions = {}): Server {
  const createNote = makeCreateNoteHandler(deps);
  const listNotes = makeListNotesHandler(deps);

  return createServer((request, response) => {
    const respond = (result: HttpResponse) => {
      response.writeHead(result.statusCode, { 'content-type': 'application/json' });
      response.end(result.body);
    };
    const notFound = () => respond({ statusCode: 404, body: JSON.stringify({ error: 'not found' }) });

    if (request.method === 'POST' && request.url === '/notes') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void createNote(Buffer.concat(chunks).toString('utf8')).then(respond);
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/notes') {
      void listNotes().then(respond);
      return;
    }

    if (request.method === 'GET' && options.staticDir) {
      void serveStatic(options.staticDir, request.url ?? '/', response, notFound);
      return;
    }

    notFound();
  });
}

async function serveStatic(
  staticDir: string,
  rawUrl: string,
  response: import('node:http').ServerResponse,
  notFound: () => void,
): Promise<void> {
  const pathname = decodeURIComponent(new URL(rawUrl, 'http://local').pathname);
  const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const resolved = path.normalize(path.join(staticDir, relative));
  // Path-traversal guard: whatever the URL said, we never leave staticDir.
  if (!resolved.startsWith(path.normalize(staticDir) + path.sep)) {
    return notFound();
  }
  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) return notFound();
  } catch {
    return notFound();
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream',
  });
  createReadStream(resolved).pipe(response);
}
