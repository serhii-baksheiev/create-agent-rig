import { configDefaults, defineConfig } from 'vitest/config';

// The policy benchmark spawns the real guards as child processes and measures
// them under a 30 s deadline. On the hosted Windows runners those guards cost
// 20–28 s each while the rest of the suite ran beside them, and serializing
// the benchmark's own two workers changed nothing (PR #202, heads 0ea2349 and
// 94a6609). So the benchmark files run in a project of their own, after every
// other project and one file at a time — pinned by
// test/template/vitest-benchmark-project.test.ts.
const BENCHMARK_FILES = 'test/template/policy-benchmark*.test.ts';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          setupFiles: ['test/setup-env.ts'],
        },
      },
      {
        test: {
          name: 'template',
          include: ['test/template/**/*.test.ts'],
          exclude: [...configDefaults.exclude, BENCHMARK_FILES],
          setupFiles: ['test/setup-env.ts'],
          // The figure ci.yml passes as --testTimeout (test/template/vitest-timeouts.test.ts
          // pins the two equal). Tests here spawn stub `gh` subprocesses, and under a
          // full parallel `pnpm test` with e2e beside them some crossed vitest's 5 s
          // default while passing alone — the measurements are on AR-143.
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'benchmark',
          include: [BENCHMARK_FILES],
          setupFiles: ['test/setup-env.ts'],
          // The template project's figure; the benchmark cases set their own
          // per-test budgets on top of it.
          testTimeout: 15_000,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          setupFiles: ['test/setup-env.ts'],
          // One pack for the whole project — see test/e2e/pack-once.ts for the
          // race that per-file packing produced.
          globalSetup: ['test/e2e/pack-once.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
