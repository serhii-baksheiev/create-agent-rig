#!/usr/bin/env node
// All upstream test pointers in this script name the generator suite, absent in a generated rig.
/**
 * The Revalidation Experiment's report — what the evidence log says, over the
 * run directories of this rig since a date (AR-136).
 *
 *   node .claude/scripts/revalidation-report.mjs --since <ISO date> [--runs <dir>] [--json]
 *
 * It reads `<runs>/<run-id>/` — `--runs <dir>`, or by default `.claude/runs/`
 * under the MAIN checkout, resolved through `queue/checkout.mjs` so a report
 * run from a linked worktree reads the runs the loop actually declared
 * (revalidation-evidence.test.ts › "reads the main checkout's runs by default,
 * even from a linked worktree") — through `run-journal.mjs` › readRun, the same
 * reader every gate uses, with the same refusal: a journal whose sequence is
 * broken is not read. Such a run is COUNTED under `skipped`, with the reason,
 * never dropped silently; a report that quietly narrowed its own base would be
 * the kind of number the journal README says will be believed.
 *
 * Per point (SELECT, BEFORE_PR, BEFORE_CLOSE), over `revalidation` events at
 * or after `since`:
 *   opportunities — every event; catches — `changed: true`;
 *   unverifiable — `changed: null`;
 *   actionChanged — catches whose `revalidation-outcome` says true;
 *   falseHolds — catches whose outcome says false;
 *   unresolved — catches with no outcome at all (the run skipped the re-read).
 * An outcome answers the revalidation whose seq its `answers` names, in the
 * SAME run — an outcome cannot reach across runs. `noise` counts the sources
 * behind the false holds, which is where the mechanism's cost is.
 *
 * The primary metric is `actionChanged`, not `opportunities` or `catches`: a
 * hold that changed nothing is noise, and the report says so by name.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from './queue/checkout.mjs';
import { readRun } from './run-journal.mjs';
import { POINTS } from './lib/revalidation-points.mjs';

export { POINTS };

const emptyCounts = () => ({
  opportunities: 0,
  catches: 0,
  unverifiable: 0,
  actionChanged: 0,
  falseHolds: 0,
  unresolved: 0,
});

/** The report over already-read runs — pure, so the counting is testable alone. */
export const reportOf = ({ runs, since }) => {
  const sinceMs = Date.parse(since);
  const points = Object.fromEntries(POINTS.map((point) => [point, emptyCounts()]));
  const noise = {};
  const read = [];
  const skipped = [];
  for (const { run, events, error } of runs) {
    if (error) {
      skipped.push({ run, why: error });
      continue;
    }
    read.push(run);
    const outcomes = new Map();
    for (const event of events) {
      if (event.kind === 'revalidation-outcome' && Number.isInteger(event.data?.answers)) {
        outcomes.set(event.data.answers, event.data);
      }
    }
    for (const event of events) {
      if (event.kind !== 'revalidation') continue;
      // Written as "inside the window", so an `at` that does not parse falls
      // OUT — the NaN comparison would otherwise count it in.
      if (!(Date.parse(event.at) >= sinceMs)) continue;
      const bucket = points[event.data?.point];
      if (!bucket) continue;
      bucket.opportunities += 1;
      if (event.data.changed === null) bucket.unverifiable += 1;
      if (event.data.changed !== true) continue;
      bucket.catches += 1;
      const outcome = outcomes.get(event.seq);
      if (!outcome) bucket.unresolved += 1;
      else if (outcome.actionChanged === true) bucket.actionChanged += 1;
      else {
        bucket.falseHolds += 1;
        for (const source of Array.isArray(event.data.source) ? event.data.source : []) {
          noise[source] = (noise[source] ?? 0) + 1;
        }
      }
    }
  }
  const totals = emptyCounts();
  for (const counts of Object.values(points)) {
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  return { since, points, noise, totals, runs: { read: read.length, skipped } };
};

/** Every run directory under `runsDir`, read or refused — never both, never neither. */
export const readRuns = (runsDir) => {
  let names;
  try {
    names = readdirSync(runsDir).filter((name) => statSync(join(runsDir, name)).isDirectory());
  } catch (error) {
    throw new Error(`cannot list runs in ${runsDir}: ${error.message}`, { cause: error });
  }
  return names.sort().map((run) => {
    try {
      const { events } = readRun({ runDir: join(runsDir, run) });
      return { run, events };
    } catch (error) {
      return { run, error: String(error?.message ?? error) };
    }
  });
};

export const render = (report) => {
  const line = (name, c) =>
    `${name}: ${c.opportunities} opportunities, ${c.catches} catches, ${c.actionChanged} actionChanged, ` +
    `${c.falseHolds} falseHolds, ${c.unresolved} unresolved, ${c.unverifiable} unverifiable`;
  const lines = [`revalidation since ${report.since}`];
  for (const point of POINTS) lines.push(line(point, report.points[point]));
  lines.push(line('totals', report.totals));
  const noise = Object.entries(report.noise);
  lines.push(
    noise.length === 0
      ? 'noise: none'
      : `noise: ${noise.map(([source, count]) => `${source} ×${count}`).join(', ')}`,
  );
  lines.push(`runs: ${report.runs.read} read, ${report.runs.skipped.length} skipped`);
  for (const { run, why } of report.runs.skipped) lines.push(`  skipped ${run} — ${why}`);
  return `${lines.join('\n')}\n`;
};

const parseArgs = (argv) => {
  const args = { since: null, runs: null, json: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--since') args.since = argv[++i] ?? null;
    else if (arg === '--runs') args.runs = argv[++i] ?? null;
    else if (args.bad === null) args.bad = arg;
  }
  return args;
};

const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const args = parseArgs(process.argv.slice(2));
  const refuse = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };
  if (args.bad !== null) refuse(`unrecognised argument: ${args.bad}`);
  if (!args.since || Number.isNaN(Date.parse(args.since))) {
    refuse(`--since needs an ISO date (got ${args.since ?? '(none)'}); a report with no window reports nothing honest.`);
  }
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const runsDir =
    args.runs ?? join(mainCheckoutRoot(join(scriptsDir, '..', '..')), '.claude', 'runs');
  let runs;
  try {
    runs = readRuns(runsDir);
  } catch (error) {
    refuse(error.message);
  }
  const report = reportOf({ runs, since: new Date(args.since).toISOString() });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
}
