import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

// RP-158. On the hosted Windows runner (e2e.yml windows-e2e, `pnpm test
// --maxWorkers=2`) dispatch 35099543331 on head 09b1bee failed
// test/template/queue.test.ts › "reads the state beside an explicit --config
// and never the checkout it is standing in" at its 20 s budget while
// test/e2e/git-install.test.ts (npm installs) ran beside it for the whole
// file: the neighbouring worktree tests in the same describe stretched to
// 14.8 s and 9.7 s against ~2.4 s and ~0.9 s in the green dispatches
// 35101224699 and 35102865119 on the same head. So the e2e installs get their
// own sequence group, after unit and template and before the benchmark
// (which the benchmark pin already requires to run last).

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

describe('the e2e installs run in their own sequence group, after unit/template and before benchmark', () => {
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

  it('runs the e2e project before the benchmark project, which already runs last', () => {
    const e2e = findProject('e2e');
    const benchmark = findProject('benchmark');
    expect(e2e, "a vitest project named 'e2e' should exist").toBeDefined();
    expect(benchmark, "a vitest project named 'benchmark' should exist").toBeDefined();

    const e2eOrder = e2e?.test.sequence?.groupOrder ?? 0;
    const benchmarkOrder = benchmark?.test.sequence?.groupOrder;
    expect(benchmarkOrder, 'benchmark project should declare test.sequence.groupOrder').toEqual(
      expect.any(Number),
    );

    expect(benchmarkOrder ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(e2eOrder);
  });

  it('keeps the e2e project on its existing install glob and global setup', () => {
    const e2e = findProject('e2e');
    expect(e2e, "a vitest project named 'e2e' should exist").toBeDefined();
    expect(e2e?.test.include).toEqual(['test/e2e/**/*.test.ts']);
    expect(e2e?.test.globalSetup).toEqual(['test/e2e/pack-once.ts']);
  });

  it('still covers every test file with exactly these four projects', () => {
    const names = projects.map((p) => p.test.name).sort();
    expect(names).toEqual(['benchmark', 'e2e', 'template', 'unit']);
  });
});
