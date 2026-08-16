// The web talks to the backend over HTTP only — never by importing it
// (the guard-web-boundary hook refuses such imports at the tool layer).
import type { Note } from '@app/core';

// In THIS target the API is never same-origin: the bundle is served from
// CloudFront and the API is API Gateway, so `NEXT_PUBLIC_API_URL` has to be set
// at build time — Next inlines it, and an unset one leaves the empty string
// here, which makes every call go to the CDN serving this page. The fallback
// exists for `pnpm dev`, where a proxy does serve both.
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
