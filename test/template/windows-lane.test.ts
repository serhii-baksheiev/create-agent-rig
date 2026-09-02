import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-62 — the hosted Windows lane reports contention identically to a real
 * failure.
 *
 * The measured shape, across occurrences: always `Test timed out`, never an
 * AssertionError; the victim among the suite's heaviest process-spawning
 * tests; a normal duration of ~6-8 s against a 15 s budget; and — the sharpest
 * instance — the victim MOVING between two runs of one commit whose diff was
 * eight lines of comment. Telling that apart from a regression meant querying
 * neighbouring heads by hand.
 *
 * The owner ruling fixed the remedy and its order: reduce worker concurrency on
 * that lane FIRST; a lane-specific 30 s budget only if that does not hold;
 * never a global raise, because the same cases finish far inside the budget on
 * Linux and a uniform raise masks a genuine slowdown everywhere.
 *
 * 🔴 The cap is passed on the COMMAND LINE, not set per project, and that was
 * measured rather than chosen. `test:unit` runs `--project unit --project
 * template`; vitest 4 refuses two projects that share `sequence.groupOrder`
 * but resolve different `maxWorkers`, so capping the template project alone
 * aborts the whole run with "no tests" and exits 1 — the lane goes red having
 * executed nothing. The ruling permits this shape exactly when the per-project
 * one "costs more than it buys", and a lane that runs zero tests is that.
 *
 * What this file pins is the SHAPE of the remedy: lane-specific, on the command
 * line, and not the timeout. It deliberately does NOT pin the cap's value — the
 * ruling asks for the smallest stable figure, which is a measurement on the
 * hosted runner and will move.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');

/** Every workflow, so "and nowhere else" means the repository, not one file. */
const workflows = async () => {
  const names = (await readdir(workflowDir)).filter((n) => /\.ya?ml$/.test(n));
  return Promise.all(
    names.map(async (name) => ({
      name,
      body: await readFile(path.join(workflowDir, name), 'utf8'),
    })),
  );
};

/**
 * Lines that actually RUN, with comments stripped — whole-line and inline.
 *
 * 🔴 Both forms, and the second was measured rather than anticipated. A regex
 * over the raw file matches a commented-out setting: `code-reviewer` showed
 * that replacing this job's `env:` block with `# RIG_TEMPLATE_MAX_WORKERS: 2`
 * left the first version of this test green. Stripping whole-line comments
 * alone then let `run: pnpm test:unit … # --maxWorkers=2` pass too — a real
 * mutation, because YAML ends a plain scalar at ` #` and the flag would never
 * reach the command. A check a comment can satisfy is not checking the
 * workflow.
 *
 * ⚠ The inline strip is textual, so it also truncates a ` #` inside a `run: |`
 * script body — the spawn-baseline `echo` is one. That costs nothing here (the
 * tokens this file looks for sit before any such `#`), and erring toward
 * removing too much keeps the failure direction safe: it can only hide a
 * token, never invent one.
 */
const executable = (body: string) =>
  body
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s#.*$/, ''))
    .join('\n');

const windowsJob = (body: string) =>
  body.split(/^ {2}windows-unit:$/m)[1]?.split(/^ {2}\w[\w-]*:$/m)[0];

describe('the hosted Windows lane caps test concurrency, and only there', () => {
  it('passes --maxWorkers in the windows-unit job', async () => {
    const ci = (await workflows()).find((w) => w.name === 'ci.yml');
    expect(ci, 'there is no ci.yml').toBeDefined();
    const job = windowsJob(executable(ci!.body));
    expect(job, 'ci.yml has no windows-unit job').toBeDefined();
    expect(job, 'the Windows lane does not cap concurrency').toMatch(/--maxWorkers[= ]\d+/);
  });

  it('caps no other lane, in any workflow', async () => {
    const offenders: string[] = [];
    for (const { name, body } of await workflows()) {
      const runs = executable(body);
      const job = name === 'ci.yml' ? windowsJob(runs) : undefined;
      // Everything outside the one capped job must be free of a cap: another
      // lane has no contention problem, and slowing it would both cost time and
      // stop this lane being evidence about itself.
      const elsewhere = job ? runs.split(job).join('') : runs;
      if (/--maxWorkers/.test(elsewhere)) offenders.push(name);
    }
    expect(offenders, 'a lane other than windows-unit caps concurrency').toEqual([]);
  });

  it('leaves the timeout alone — the cap is concurrency, never the budget', async () => {
    // A lane-specific budget is the ruled FALLBACK, and adopting it silently
    // would blind the lane it applies to. Both the count and the distinct set
    // are asserted: counting distinct values alone stays green if a lane drops
    // the flag entirely (`security-scanner`, round 1).
    const figures: string[] = [];
    for (const { body } of await workflows()) {
      for (const m of executable(body).matchAll(/--testTimeout=(\d+)/g)) figures.push(m[1]!);
    }
    expect(figures.length, 'no workflow passes --testTimeout any more').toBeGreaterThan(0);
    expect(new Set(figures).size, 'the workflows carry more than one --testTimeout figure').toBe(1);
  });

  it('brackets the suite with a spawn baseline, so a slowdown DURING it is visible', async () => {
    const ci = (await workflows()).find((w) => w.name === 'ci.yml')!;
    const job = windowsJob(executable(ci.body))!;
    // One reading at t0 characterises the runner before the load; the timeouts
    // happen under it. Two readings bracket the suite, which is what tells a
    // contended run from a slow one without querying neighbouring heads.
    const readings = [...job.matchAll(/node -e/g)];
    expect(
      readings.length,
      'the Windows lane does not bracket the suite with spawn timings',
    ).toBeGreaterThanOrEqual(2);
    // The second must survive a red suite, or it is absent exactly when needed.
    expect(job, 'the post-suite baseline does not run on a failed suite').toMatch(
      /if:\s*always\(\)/,
    );
  });
});
