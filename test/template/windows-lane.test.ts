import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

/**
 * RP-62 — the hosted Windows lane reported contention identically to a real
 * failure.
 *
 * The measured shape, across five occurrences: always `Test timed out`, never
 * an AssertionError; the failing file among the suite's heaviest
 * process-spawning tests; a normal duration of ~6-8 s against a 15 s budget;
 * and — the sharpest instance — the victim MOVING between two runs of one
 * commit whose diff was eight lines of comment. Telling that apart from a
 * regression meant querying neighbouring heads by hand.
 *
 * The owner ruling fixed the remedy and its order: reduce worker concurrency on
 * that lane FIRST; a lane-specific 30 s budget only if that does not hold;
 * never a global raise, because the same cases finish far inside the budget on
 * Linux and a uniform raise masks a genuine slowdown everywhere.
 *
 * What this file pins is the SHAPE of that remedy — lane-specific, and not the
 * timeout. It deliberately does not pin the cap's VALUE: the ruling asks for
 * the smallest stable figure, which is a measurement on the hosted runner and
 * will move.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');

const projects = (config as { test?: { projects?: unknown[] } }).test?.projects ?? [];
const templateProject = projects.find(
  (p): p is { test: { name: string; maxWorkers?: number } } =>
    typeof p === 'object' &&
    p !== null &&
    (p as { test?: { name?: string } }).test?.name === 'template',
);

/** The `windows-unit:` job block, up to the next job at the same indent. */
const windowsJob = (ci: string) =>
  ci.split(/^ {2}windows-unit:$/m)[1]?.split(/^ {2}\w[\w-]*:$/m)[0];

describe('the hosted Windows lane caps template concurrency, and only there', () => {
  it('sets RIG_TEMPLATE_MAX_WORKERS in the windows-unit job and in no other', async () => {
    const ci = await readFile(ciPath, 'utf8');
    const job = windowsJob(ci);
    expect(job, 'ci.yml has no windows-unit job').toBeDefined();
    expect(job, 'the Windows lane does not cap template concurrency').toMatch(
      /RIG_TEMPLATE_MAX_WORKERS:\s*\d+/,
    );

    // Lane-specific is the whole point: a cap set anywhere else would slow a
    // lane that has no contention problem, and would stop being evidence about
    // this one.
    const everywhere = [...ci.matchAll(/RIG_TEMPLATE_MAX_WORKERS/g)];
    const inJob = [...job!.matchAll(/RIG_TEMPLATE_MAX_WORKERS/g)];
    expect(everywhere.length, 'RIG_TEMPLATE_MAX_WORKERS is set outside the windows-unit job').toBe(
      inJob.length,
    );
  });

  it('reads that cap into the template project, so the lane setting reaches the runner', () => {
    expect(templateProject, 'vitest.config.ts declares no template project').toBeDefined();

    const configSource = process.env.RIG_TEMPLATE_MAX_WORKERS;
    if (configSource === undefined) {
      // The ordinary case, and the one every other lane runs in: no cap.
      expect(
        templateProject?.test.maxWorkers,
        'the template project caps workers when the lane did not ask it to',
      ).toBeUndefined();
      return;
    }
    // Under the Windows lane's own environment the figure must arrive.
    expect(templateProject?.test.maxWorkers).toBe(Number(configSource));
  });

  it('leaves the timeout alone — the cap is concurrency, never the budget', async () => {
    const ci = await readFile(ciPath, 'utf8');
    // Every --testTimeout in the workflow is the same figure. A lane-specific
    // budget is the ruled fallback, and adopting it silently here would blind
    // the lane it applies to; vitest-timeouts.test.ts pins the figure itself
    // equal to vitest.config.ts's.
    const figures = new Set([...ci.matchAll(/--testTimeout=(\d+)/g)].map((m) => m[1]));
    expect(figures.size, 'the workflow now carries more than one --testTimeout figure').toBe(1);
  });

  it('records a spawn baseline on that lane, so a slow runner is visible in the log', async () => {
    const ci = await readFile(ciPath, 'utf8');
    const job = windowsJob(ci);
    // The diagnosis the ruling asked for: when a case times out, the run should
    // carry enough timing to tell contention from a regression without querying
    // neighbouring heads by hand.
    expect(job, 'the Windows lane records no spawn timing').toMatch(/node -e/);
  });
});
