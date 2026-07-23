// The load-bearing import of this whole app: the browser validates with the
// SAME schema the server trusts. Client-side for instant feedback,
// server-side for trust — one function, two sides of the wire. This is what
// core purity buys: `@app/core` has no I/O, so it runs anywhere.
import { NewNoteSchema } from '@app/core';

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

export function validateNewNote(input: unknown): ValidationResult {
  const parsed = NewNoteSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, issues: [] };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`,
    ),
  };
}
