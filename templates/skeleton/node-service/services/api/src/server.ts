// Thin HTTP shell around the handler: routing and body collection only.
import { createServer, type Server } from 'node:http';
import type { CreateNoteDeps } from './usecases/create-note.js';
import { makeCreateNoteHandler } from './handlers/create-note.js';

export function makeServer(deps: CreateNoteDeps): Server {
  const createNote = makeCreateNoteHandler(deps);
  return createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/notes') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void createNote(Buffer.concat(chunks).toString('utf8')).then((result) => {
          response.writeHead(result.statusCode, { 'content-type': 'application/json' });
          response.end(result.body);
        });
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
}
