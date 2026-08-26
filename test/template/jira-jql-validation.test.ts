import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-51 — `buildJql` interpolates `options.project` straight into a JQL string
 * and returns `options.jql` verbatim. Both come from `.claude/queue.json`, a
 * rulebook file an unattended run could rewrite — so the adapter validates the
 * key against the Jira project-key rule and refuses a jql that does not start
 * by naming the configured project.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = () =>
  import(
    pathToFileURL(
      path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/queue/jira.mjs'),
    ).href
  ) as Promise<{
    buildJql: (options?: { project?: string | null; jql?: string | null }) => string;
  }>;

const KEY_RULE = '^[A-Z][A-Z0-9_]{1,9}$';

describe('buildJql: the project key is validated before it is interpolated', () => {
  it('accepts a well-formed key', async () => {
    const { buildJql } = await load();
    expect(buildJql({ project: 'AR' })).toMatch(/^project = AR AND /);
  });

  it('refuses a lower-case key, a key with a space, and an injected clause — naming the rule', async () => {
    const { buildJql } = await load();
    for (const project of ['ar', 'A B', 'AR) OR project = X']) {
      expect(() => buildJql({ project }), project).toThrow(KEY_RULE);
    }
  });
});

describe('buildJql: an explicit jql must name the configured project first', () => {
  it('returns a jql that starts with the configured project', async () => {
    const { buildJql } = await load();
    const jql = 'project = AR AND labels = x';
    expect(buildJql({ project: 'AR', jql })).toBe(jql);
  });

  it('refuses a jql that names a different project than the configured one', async () => {
    const { buildJql } = await load();
    expect(() => buildJql({ project: 'AR', jql: 'project = XX AND labels = x' })).toThrow();
  });

  it('refuses a jql that does not start with `project = <KEY>` when no project is configured', async () => {
    const { buildJql } = await load();
    expect(() => buildJql({ jql: 'labels = x' })).toThrow(/project = /);
  });

  it('accepts a jql that starts with a project of its own when none is configured', async () => {
    const { buildJql } = await load();
    const jql = 'project = ZZ ORDER BY key';
    expect(buildJql({ jql })).toBe(jql);
  });
});
