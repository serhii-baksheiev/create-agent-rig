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
 * Use for a PRESENCE claim only. 🔴 Both strips were measured rather than
 * anticipated: `code-reviewer` showed a commented-out `env:` block satisfied
 * the first version of this test, and stripping whole-line comments alone then
 * let `run: pnpm test:unit … # --maxWorkers=2` pass, because YAML ends a plain
 * scalar at ` #` and the flag never reaches the command. A check a comment can
 * satisfy is not checking the workflow.
 *
 * 🔴 **Never use it for an ABSENCE claim**, and this is the correction to a
 * limit this file previously stated backwards. The strip is textual, so it also
 * truncates a ` #` inside a `run: |` block — where YAML does NOT start a
 * comment and the shell really does receive the rest of the line. `echo "cap #1
 * of 1" && pnpm test:unit --maxWorkers=1` genuinely caps a second lane, and
 * `executable()` would hide exactly that. Over-stripping is safe when it can
 * only turn a check red; it is unsafe the moment the check asserts something is
 * missing. Measured by `code-reviewer`, and this PR's own log prints
 * `bare node spawn #1: …` from such a block.
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
      // 🔴 RAW, not `executable()`. This asserts a token is ABSENT, so
      // stripping comments here would hide the very thing it looks for — see
      // that helper's own note. The cost is the opposite error: a mention of
      // `--maxWorkers` in a comment on another lane turns this red. That is the
      // safe direction, and the remedy is to not write it.
      const job = name === 'ci.yml' ? windowsJob(body) : undefined;
      const elsewhere = job ? body.split(job).join('') : body;
      if (/--maxWorkers/.test(elsewhere)) offenders.push(name);
    }
    expect(offenders, 'a lane other than windows-unit caps concurrency').toEqual([]);
  });

  it('leaves the timeout alone — the cap is concurrency, never the budget', async () => {
    // A lane-specific budget is the ruled FALLBACK, and adopting it silently
    // would blind the lane it applies to.
    const figures: string[] = [];
    for (const { body } of await workflows()) {
      for (const m of executable(body).matchAll(/--testTimeout=(\d+)/g)) figures.push(m[1]!);
    }
    expect(new Set(figures).size, 'the workflows carry more than one --testTimeout figure').toBe(1);

    // 🔴 And THIS lane specifically still passes one. An earlier version
    // asserted only `figures.length > 0`, and its comment claimed that caught a
    // lane dropping the flag — `code-reviewer` measured that it does not:
    // removing `--testTimeout` from the windows job alone stayed green across
    // this file, `vitest-timeouts` and `root-ci`, and the `unit` project would
    // silently fall back to vitest's 5 s default on the one lane this item
    // exists to stabilise. (The ubuntu lane is covered, but by
    // `root-ci.test.ts` — not by anything here.)
    const ci = (await workflows()).find((w) => w.name === 'ci.yml')!;
    const job = windowsJob(executable(ci.body));
    expect(job, 'the Windows lane no longer passes --testTimeout').toMatch(/--testTimeout=\d+/);
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

    // 🔴 Position, not just presence, and per step rather than job-wide.
    // `code-reviewer` measured that a job-wide count plus a job-wide
    // /if: always()/ stays GREEN when the second baseline is moved BEFORE the
    // suite, or when `always()` is moved onto the first one — leaving a test
    // named for bracketing that does not check it.
    const steps = job.split(/^ {6}- name:/m).slice(1);
    const suiteAt = steps.findIndex((s) => /run:\s*pnpm test:unit/.test(s));
    const afterSuite = steps.slice(suiteAt + 1);
    expect(suiteAt, 'no step in the job runs the suite').toBeGreaterThanOrEqual(0);
    expect(
      steps.slice(0, suiteAt).some((s) => /node -e/.test(s)),
      'nothing measures spawn latency before the suite',
    ).toBe(true);
    const post = afterSuite.find((s) => /node -e/.test(s));
    expect(post, 'nothing measures spawn latency after the suite').toBeDefined();
    // It must survive a red suite, or it is absent exactly when it is needed.
    expect(post, 'the post-suite baseline does not run on a failed suite').toMatch(
      /if:\s*always\(\)/,
    );
  });
});
