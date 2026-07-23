// Even a trivial read goes through a usecase — the uniformity is the rule.
import type { Note } from '@app/core';

export interface NoteLister {
  list(): Promise<Note[]>;
}

export interface ListNotesDeps {
  notes: NoteLister;
}

export async function listNotesUsecase(deps: ListNotesDeps): Promise<Note[]> {
  return deps.notes.list();
}
