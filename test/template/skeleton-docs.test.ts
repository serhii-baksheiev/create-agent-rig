import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A skeleton teaches by example, so an unstated failure mode is copied forward
// as if it were a design. These pin the tradeoffs the templates ship WITH —
// the claim has to survive an edit, or it quietly disappears.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (target: string, ...parts: string[]) =>
  readFile(path.join(repoRoot, 'templates', 'skeleton', target, ...parts), 'utf8');

describe('aws-serverless is honest about the dual write in create-note', () => {
  it('the README names the failure mode: a failed publish leaves a note with no event', async () => {
    const readme = await read('aws-serverless', 'README.md');
    expect(readme, 'the two writes are named as such').toMatch(
      /dual[- ]write|not atomic|two writes/i,
    );
    expect(
      readme,
      'and what it costs: the put succeeded, the publish did not, nothing compensates',
    ).toMatch(/(publish|event)[^.]{0,200}(fail|error)|(fail|error)[^.]{0,200}(publish|event)/i);
    expect(readme, 'and the way out, so the reader is not left with a shrug').toMatch(
      /outbox|compensat|retry/i,
    );
  });

  it('the usecase carries the warning where the two writes actually happen', async () => {
    // A reader who never opens the README still edits this file.
    const usecase = await read('aws-serverless', 'services/api/src/usecases/create-note.ts');
    expect(usecase).toMatch(/dual[- ]write|not atomic|two writes/i);
    expect(usecase).toMatch(/outbox|compensat/i);
  });
});
