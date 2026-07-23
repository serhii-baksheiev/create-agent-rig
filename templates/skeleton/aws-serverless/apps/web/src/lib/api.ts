// The web talks to the backend over HTTP only — never by importing it
// (the guard-web-boundary hook refuses such imports at the tool layer).
import type { Note } from '@app/core';

// Same-origin by default (the API server serves this bundle); set
// NEXT_PUBLIC_API_URL at build time when the API lives elsewhere.
const base = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function createNote(input: { title: string; tags: string[] }): Promise<Note> {
  const response = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { note?: Note; error?: string; issues?: string[] };
  if (!response.ok || !body.note) {
    throw new Error(body.issues?.join('; ') ?? body.error ?? `HTTP ${response.status}`);
  }
  return body.note;
}

export async function listNotes(): Promise<Note[]> {
  const response = await fetch(`${base}/notes`);
  const body = (await response.json()) as { notes?: Note[]; error?: string };
  if (!response.ok || !body.notes) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body.notes;
}
