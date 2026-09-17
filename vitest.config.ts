import { configDefaults, defineConfig } from 'vitest/config';

// The e2e installs get a sequence group of their own, after unit/template: a
// template test that spawns git and the CLI timed out on the hosted Windows
// runner while the npm installs of test/e2e/git-install.test.ts ran beside it
// (RP-158) — pinned by test/template/vitest-e2e-group.test.ts.
//
// RP-178 removed the policy benchmark project that used to run last here (the
// benchmark spawned the real guards as child processes under a per-guard
// deadline; the guards it measured, and the "policy" library surface it
// exercised, were never called from a shipped entry point — see
// docs/compatibility.md). Guard behaviour is now covered directly, in the
// template project, by test/template/guard-acceptance.test.ts.

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
          exclude: [...configDefaults.exclude],
          setupFiles: ['test/setup-env.ts'],
          // The figure ci.yml passes as --testTimeout (test/template/vitest-timeouts.test.ts
          // pins the two equal). Tests here spawn stub `gh` subprocesses, and under a
          // full parallel `pnpm test` with e2e beside them (before e2e had a group of
          // its own) some crossed vitest's 5 s default while passing alone — the
          // measurements are on AR-143.
          testTimeout: 15_000,
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
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
