import { defineConfig } from 'vitest/config';

/**
 * RP-62 — the hosted Windows lane caps how many template files run at once.
 *
 * The template tests spawn stub subprocesses, so they are process-bound rather
 * than CPU-bound, and a hosted 2-core `windows-latest` runner is where that
 * bites: the lane reported contention identically to a real failure, with the
 * victim moving between runs of one commit and never an AssertionError.
 *
 * Lane-specific by construction — only the `windows-unit` job sets this, so
 * every other lane keeps full parallelism. Unset means "no cap", which is what
 * the value being absent from every other environment already says.
 *
 * 🔴 This is NOT the timeout. `--testTimeout` stays 15000 everywhere, and
 * `test/template/vitest-timeouts.test.ts` keeps ci.yml and this file equal on
 * that figure. A lane-specific budget is the owner-ruled fallback if capping
 * concurrency does not hold; it is not this change.
 */
const templateMaxWorkers = Number(process.env.RIG_TEMPLATE_MAX_WORKERS);

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
          setupFiles: ['test/setup-env.ts'],
          // The figure ci.yml passes as --testTimeout (test/template/vitest-timeouts.test.ts
          // pins the two equal). Tests here spawn stub `gh` subprocesses, and under a
          // full parallel `pnpm test` with e2e beside them some crossed vitest's 5 s
          // default while passing alone — the measurements are on AR-143.
          testTimeout: 15_000,
          ...(Number.isInteger(templateMaxWorkers) && templateMaxWorkers > 0
            ? { maxWorkers: templateMaxWorkers }
            : {}),
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
