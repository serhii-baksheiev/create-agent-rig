'use client';
// One page, one point: the SAME domain schema validates here (instant
// feedback) and on the server (trust). See src/lib/validate.ts.
import { useCallback, useEffect, useState } from 'react';
import type { Note } from '@app/core';
import { createNote, listNotes } from '../lib/api';
import { validateNewNote } from '../lib/validate';

export default function NotesPage() {
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [status, setStatus] = useState<string>('');

  const refresh = useCallback(async () => {
    try {
      setNotes(await listNotes());
      setStatus('');
    } catch (error) {
      setStatus(`could not load notes: ${String(error)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const input = {
      title,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    // Client-side: the same core schema the server will apply again.
    const verdict = validateNewNote(input);
    setIssues(verdict.issues);
    if (!verdict.ok) return;
    try {
      await createNote(input);
      setTitle('');
      setTags('');
      await refresh();
    } catch (error) {
      setIssues([String(error)]);
    }
  }

  return (
    <main>
      <h1>Notes</h1>
      <p>
        The form validates with the <em>same</em> core function the server
        trusts — one schema, both sides of the wire.
      </p>

      <form onSubmit={onSubmit}>
        <label>
          Title{' '}
          <input
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>{' '}
        <label>
          Tags (comma-separated){' '}
          <input name="tags" value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>{' '}
        <button type="submit">Create</button>
      </form>

      {issues.length > 0 && (
        <ul role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {status && <p role="status">{status}</p>}

      <h2>Existing</h2>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <strong>{note.title}</strong> <code>{note.slug}</code>{' '}
            <small>{note.tags.join(', ')}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
