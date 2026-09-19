import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

// RP-158. On the hosted Windows runner (e2e.yml windows-e2e, `pnpm test
// --maxWorkers=2`) dispatch 35099543331 on head 09b1bee failed
// test/template/queue.test.ts › "reads the state beside an explicit --config
// and never the checkout it is standing in" at its 20 s budget while
// test/e2e/git-install.test.ts (npm installs) ran beside it for all but its
// last seconds, and a neighbour in the same describe, "answers the MAIN
// checkout root when asked from a linked worktree", took 14.8 s against 2.5 s
// and 2.1 s in the green dispatches 35101224699 and 35102865119 on the same
// head. The same red run also slowed a test in another file after every e2e
// file had finished, so the runner was slow on its own too: this grouping
// removes the suite's own install load from beside the template tests, and
// nothing more. The e2e installs get their own sequence group, after unit and
// template.
//
// RP-178 removed the policy benchmark project this file used to order itself
// against (the benchmark ran last) — the ordering claim below is against
// unit and template only now.

interface ProjectConfig {
  name?: string;
  include?: string[];
  exclude?: string[];
  setupFiles?: string[];
  globalSetup?: string[];
  testTimeout?: number;
  maxWorkers?: number;
  sequence?: { groupOrder?: number };
}

interface Project {
  test: ProjectConfig;
}

function isProject(value: unknown): value is Project {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { test?: unknown }).test === 'object' &&
    (value as { test?: unknown }).test !== null
  );
}

const projects: Project[] = (
  (config as { test?: { projects?: unknown[] } }).test?.projects ?? []
).filter(isProject);

function findProject(name: string): Project | undefined {
  return projects.find((p) => p.test.name === name);
}

describe('the e2e installs run in their own sequence group, after unit/template', () => {
  it('gives the e2e project a groupOrder greater than unit and template', () => {
    const e2e = findProject('e2e');
    expect(e2e, "a vitest project named 'e2e' should exist").toBeDefined();

    const e2eOrder = e2e?.test.sequence?.groupOrder;
    expect(e2eOrder, 'e2e project should declare test.sequence.groupOrder').toEqual(
      expect.any(Number),
    );

    const unit = findProject('unit');
    const template = findProject('template');
    expect(unit, "a vitest project named 'unit' should exist").toBeDefined();
    expect(template, "a vitest project named 'template' should exist").toBeDefined();

    const unitOrder = unit?.test.sequence?.groupOrder ?? 0;
    const templateOrder = template?.test.sequence?.groupOrder ?? 0;

    expect(e2eOrder ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(unitOrder);
    expect(e2eOrder ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(templateOrder);
  });

  it('keeps the e2e project on its existing install glob and global setup', () => {
    const e2e = findProject('e2e');
    expect(e2e, "a vitest project named 'e2e' should exist").toBeDefined();
    expect(e2e?.test.include).toEqual(['test/e2e/**/*.test.ts']);
    expect(e2e?.test.globalSetup).toEqual(['test/e2e/pack-once.ts']);
  });

  it('keeps exactly the three projects unit, template and e2e', () => {
    const names = projects.map((p) => p.test.name).sort();
    expect(names).toEqual(['e2e', 'template', 'unit']);
  });
});
