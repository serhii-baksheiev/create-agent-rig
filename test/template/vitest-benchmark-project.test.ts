import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

// RP-111. The policy-benchmark guard commands take 20-28 s or time out on the
// hosted Windows runners; serializing the two harness workers (PR #202) did
// not change it. This pins the next topology: isolate the three benchmark
// files into their own vitest project, run it last, one file at a time, and
// keep it in the same lanes (pre-commit, the Windows unit job) the template
// project already runs in.

interface ProjectConfig {
  name?: string;
  include?: string[];
  exclude?: string[];
  setupFiles?: string[];
  testTimeout?: number;
  maxWorkers?: number;
  sequence?: { groupOrder?: number };
}

interface Project {
  test: ProjectConfig;
}

const BENCHMARK_GLOB = 'test/template/policy-benchmark*.test.ts';

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

// A tiny, literal matcher for the one glob shape this test cares about:
// `<dir>/<prefix>*<suffix>`, matched against a bare relative path with no
// path separators inside the wildcard's span. Good enough to pin that
// BENCHMARK_GLOB is the one the implementation relies on, without reaching
// for a Node-version-dependent API.
function matchesSimpleGlob(glob: string, filePath: string): boolean {
  const starIndex = glob.indexOf('*');
  if (starIndex === -1) return glob === filePath;
  const prefix = glob.slice(0, starIndex);
  const suffix = glob.slice(starIndex + 1);
  if (!filePath.startsWith(prefix) || !filePath.endsWith(suffix)) return false;
  const middle = filePath.slice(prefix.length, filePath.length - suffix.length);
  return !middle.includes('/');
}

describe('the policy benchmark runs in its own vitest project, alone and last', () => {
  it('gives the benchmark files a project of their own that runs one file at a time', () => {
    const benchmark = findProject('benchmark');
    expect(benchmark, "a vitest project named 'benchmark' should exist").toBeDefined();
    expect(benchmark?.test.include).toEqual([BENCHMARK_GLOB]);
    expect(benchmark?.test.maxWorkers).toBe(1);
  });

  it('runs that project after every other project, so no other test file is in flight beside a guard', () => {
    const benchmark = findProject('benchmark');
    expect(benchmark, "a vitest project named 'benchmark' should exist").toBeDefined();

    const benchmarkOrder = benchmark?.test.sequence?.groupOrder;
    expect(benchmarkOrder, 'benchmark project should declare test.sequence.groupOrder').toEqual(
      expect.any(Number),
    );

    const others = projects.filter((p) => p.test.name !== 'benchmark');
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) {
      const otherOrder = other.test.sequence?.groupOrder ?? 0;
      expect(benchmarkOrder ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(otherOrder);
    }
  });

  it('keeps the benchmark files out of the template project, so no file runs twice', () => {
    const template = findProject('template');
    expect(template, "a vitest project named 'template' should exist").toBeDefined();
    expect(Array.isArray(template?.test.exclude)).toBe(true);
    expect(template?.test.exclude).toContain(BENCHMARK_GLOB);
  });

  it('keeps the benchmark project on the same 15 s budget as the template project', () => {
    const benchmark = findProject('benchmark');
    const template = findProject('template');
    expect(template?.test.testTimeout).toBe(15_000);
    expect(benchmark?.test.testTimeout).toBe(15_000);
    expect(benchmark?.test.testTimeout).toBe(template?.test.testTimeout);
  });

  it('keeps the benchmark project in the pre-commit and Windows unit lane', () => {
    const packageJsonUrl = new URL('../../package.json', import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const testUnit = packageJson.scripts?.['test:unit'] ?? '';
    expect(testUnit).toMatch(/--project unit\b/);
    expect(testUnit).toMatch(/--project template\b/);
    expect(testUnit).toMatch(/--project benchmark\b/);
  });

  it('matches the three benchmark files and nothing else', () => {
    const benchmarkFiles = [
      'test/template/policy-benchmark.test.ts',
      'test/template/policy-benchmark-security.test.ts',
      'test/template/policy-benchmark-runtime.test.ts',
    ];
    for (const file of benchmarkFiles) {
      expect(matchesSimpleGlob(BENCHMARK_GLOB, file)).toBe(true);
    }
    expect(matchesSimpleGlob(BENCHMARK_GLOB, 'test/template/vitest-timeouts.test.ts')).toBe(false);
  });
});
