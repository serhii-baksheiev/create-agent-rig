import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-117 — the loop skill names a `<report>` file it never said how to produce,
 * and its `proposeTriage` snippet, called exactly as written, throws on jira.
 *
 * Measured: both premise passes of one run were checked with `verdict.mjs`, and
 * the first check exited 1 — the harness artifact is a JSONL transcript whose
 * last fenced block does not parse. The report is a file the session writes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skill = (name: string) =>
  readFile(
    path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'skills',
      name,
      'SKILL.md',
    ),
    'utf8',
  );

describe('the loop skill says how the <report> it checks comes to exist', () => {
  it('states that the report is a file the session writes from the subagent answer, before the first check', async () => {
    const text = await skill('loop');
    const firstCheck = text.indexOf('verdict.mjs check <report>');
    expect(firstCheck).toBeGreaterThan(0);
    const explained = text.indexOf('`<report>` is a file you write');
    expect(
      explained,
      'the explanation must sit beside the first check, not after it',
    ).toBeGreaterThan(0);
    expect(explained).toBeLessThan(firstCheck + 1500);
    // The reason, so nobody "fixes" it by pointing at the transcript.
    expect(text).toMatch(/transcript[^.]*JSONL[^.]*last fenced block does not parse/);
    // Where to put it, so two reviewers' answers cannot overwrite each other.
    expect(text).toMatch(/\$RIG_RUN_DIR\/[\w-]+\.md/);
  });

  it('names the same convention pr-ship already uses, so the two skills agree', async () => {
    const [loop, prShip] = await Promise.all([skill('loop'), skill('pr-ship')]);
    expect(prShip).toMatch(/save what each subagent returned/);
    expect(loop).toMatch(/as `pr-ship` (?:does|already does)/);
  });
});

describe('the proposeTriage snippet files on every adapter when called as written', () => {
  it('passes the project the jira adapter requires, and says the other two take none', async () => {
    const text = await skill('loop');
    const snippet = text.slice(
      text.indexOf('a.proposeTriage({'),
      text.indexOf('a.proposeTriage({') + 800,
    );
    expect(snippet).toMatch(/\}, \{ project: "<KEY>" \}/);
    expect(snippet).toMatch(/jira only/);
    // The old warning — "called exactly as written, it does not file" — is gone
    // with its cause, rather than left describing a snippet that now files.
    expect(text).not.toMatch(/called exactly as written, it does not file/);
  });
});
