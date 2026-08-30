import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Under a full parallel `pnpm test` the template tests that spawn a stub `gh`
// have hit vitest's 5 s default while passing alone (AR-143). CI already runs
// the unit lane with --testTimeout=15000; the template project declares the
// same figure so the local and e2e.yml runs get it too.
const projects = (config as { test?: { projects?: unknown[] } }).test?.projects ?? [];
const projectNamed = (name: string) =>
  projects.find(
    (p): p is { test: { name: string; testTimeout?: number } } =>
      typeof p === 'object' &&
      p !== null &&
      (p as { test?: { name?: string } }).test?.name === name,
  );

const templateProject = projectNamed('template');
const unitProject = projectNamed('unit');

describe('vitest template project timeout', () => {
  it('gives the template project the timeout CI already runs with, so a load-sensitive spawn is not read as a failure', () => {
    expect(templateProject).toBeDefined();
    expect(templateProject?.test.testTimeout).toBe(15_000);
  });

  // RP-54: AR-143 gave this figure to `template` and stopped there. `unit` is the
  // other half of `test:unit`, which is what `.husky/pre-commit` runs — with NO
  // --testTimeout, so it inherited vitest's 5 s default on the one path where a
  // slow host actually bites. ci.yml passes the flag globally, which masked it.
  it('gives the unit project the same timeout, because pre-commit runs it without the CI flag', () => {
    expect(unitProject).toBeDefined();
    expect(unitProject?.test.testTimeout).toBe(15_000);
  });

  it('leaves no lane of test:unit on the bare vitest default, whichever lane runs it', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts['test:unit'] ?? '';
    const lanes = [...script.matchAll(/--project (\S+)/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      expect(projectNamed(lane)?.test.testTimeout).toBe(15_000);
    }
  });

  it('keeps that figure equal to the --testTimeout ci.yml passes, so the two cannot drift', async () => {
    const ci = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const figures = [...ci.matchAll(/--testTimeout=(\d+)/g)].map((m) => Number(m[1]));
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(templateProject?.test.testTimeout).toBe(figure);
    }
  });
});
