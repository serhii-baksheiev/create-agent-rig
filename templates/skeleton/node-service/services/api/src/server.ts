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

/**
 * Largest request body the transport will buffer. A note is a title and some
 * tags; anything past this is a mistake or an attack, and either way the
 * process must not hold it in memory.
 */
const MAX_BODY_BYTES = 1024 * 1024;

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
    const badRequest = () =>
      respond({ statusCode: 400, body: JSON.stringify({ error: 'bad request' }) });

    if (request.method === 'POST' && request.url === '/notes') {
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      // A socket that dies mid-upload emits 'error'; unhandled, it takes the
      // process with it.
      request.on('error', () => {
        refused = true;
      });
      request.on('data', (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          refused = true;
          chunks.length = 0;
          respond({ statusCode: 413, body: JSON.stringify({ error: 'payload too large' }) });
          // Keep draining rather than destroying the socket: a client that is
          // still uploading has to stay connected to read the refusal.
          request.resume();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (refused) return;
        void createNote(Buffer.concat(chunks).toString('utf8')).then(respond);
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/notes') {
      void listNotes().then(respond);
      return;
    }

    if (request.method === 'GET' && options.staticDir) {
      // The rejection handler is the point: without it a throw in here is an
      // unhandled rejection, which ends the process on one malformed request.
      void serveStatic(options.staticDir, request.url ?? '/', response, notFound, badRequest).catch(
        () => {
          if (!response.headersSent) {
            respond({ statusCode: 500, body: JSON.stringify({ error: 'internal error' }) });
          }
        },
      );
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
  badRequest: () => void,
): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://local').pathname);
  } catch {
    // A malformed escape (`GET /%`) is the client's error, not ours.
    return badRequest();
  }
  const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  // Resolve the root first: a configured dir with a trailing separator would
  // otherwise build a `//` prefix that no resolved path can start with, and
  // every request would 404.
  const root = path.resolve(staticDir);
  const resolved = path.resolve(root, `.${path.sep}${relative}`);
  // Path-traversal guard: whatever the URL said, we never leave staticDir.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
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
