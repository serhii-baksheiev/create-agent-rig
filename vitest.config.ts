import { defineConfig } from 'vitest/config';

// One figure for every lane that spawns a subprocess, so the two cannot drift
// (`.claude/rules/invariants.md`: one mechanism, one implementation). It is the
// same number `ci.yml` passes as --testTimeout; test/template/vitest-timeouts.test.ts
// pins them equal in both directions.
const SPAWN_TIMEOUT = 15_000;

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          setupFiles: ['test/setup-env.ts'],
          // RP-54: AR-143 gave this to `template` and stopped there. `unit` is the
          // other half of `test:unit` — the script `.husky/pre-commit` runs, with no
          // --testTimeout of its own — so it sat on vitest's 5 s default exactly where
          // a slow host bites, while ci.yml's global flag masked the gap. The file that
          // exposed it is packages/cli/test/cli-report.test.ts, which spawns the CLI.
          testTimeout: SPAWN_TIMEOUT,
        },
      },
      {
        test: {
          name: 'template',
          include: ['test/template/**/*.test.ts'],
          setupFiles: ['test/setup-env.ts'],
          // The figure ci.yml passes as --testTimeout (test/template/vitest-timeouts.test.ts
          // pins the two equal). Tests here spawn stub `gh` subprocesses, and under a
          // full parallel `pnpm test` with e2e beside them some crossed vitest's 5 s
          // default while passing alone — the measurements are on AR-143.
          testTimeout: SPAWN_TIMEOUT,
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
