import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'rules');
const stack = (name: string) =>
  path.join(repoRoot, 'templates', 'agent-os', 'stack', name, '.claude', 'rules');

// PR-flow addendum: the autonomy tiers already say a human-review change opens
// a PR — so workflow.md must carry how a PR is driven to merge, stated
// provider-neutrally, degrading honestly on a project with no remote yet.
describe('workflow.md — PR flow (process layer)', () => {
  let workflow: string;

  it('reads the file', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    expect(workflow.length).toBeGreaterThan(0);
  });

  it('states branch discipline: one task, one branch, never the default branch', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    expect(workflow).toMatch(/one task.*one branch/i);
    expect(workflow).toMatch(/default branch/i);
  });

  it('states the gate order: local checks → reviewer fan-out → merge', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    expect(workflow).toMatch(/local checks/i);
    expect(workflow).toMatch(/fan.?out/i);
  });

  it('carries the non-lazy merge criterion, provider-neutral', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    // the principle: a watcher can exit before checks register; confirm the
    // required check completed for THIS commit
    expect(workflow).toMatch(/this commit/i);
    expect(workflow).toMatch(/registered|watcher/i);
    // …but universal names NO concrete command
    expect(workflow).not.toMatch(/\bgh\b/);
    expect(workflow).not.toMatch(/gh pr checks/);
  });

  it('states the fan-out shape (code review always; security + infra by touched paths)', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    expect(workflow).toMatch(/code-reviewer/);
    expect(workflow).toMatch(/security/i);
    expect(workflow).toMatch(/infra/i);
  });

  it('states the post-merge tail: verify the deployed surface, update the plan', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    expect(workflow).toMatch(/post-merge/i);
    expect(workflow).toMatch(/PLAN\.md|update the plan/i);
  });

  it('degrades honestly: the PR flow applies once a remote and checks exist', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    expect(workflow).toMatch(/remote/i);
    expect(workflow).toMatch(/once .* (exist|remote)/i);
  });

  it('ships no flake registry (an empty section invites filling)', async () => {
    workflow = await readFile(path.join(universal, 'workflow.md'), 'utf8');
    expect(workflow).not.toMatch(/known flakes|flake registry|## Flakes/i);
  });
});

describe('the concrete merge command lives in stack/*, not universal', () => {
  it('node-ts states how to confirm the check for the head SHA', async () => {
    const nodeTs = await readFile(path.join(stack('node-ts'), 'node-ts.md'), 'utf8');
    expect(nodeTs).toMatch(/gh\b/);
    expect(nodeTs).toMatch(/SHA|head/i);
  });
});
