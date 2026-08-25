#!/usr/bin/env node
/**
 * Revalidation at BEFORE_PR — is the branch about to ship still the branch the
 * run took up?
 *
 *   node .claude/scripts/revalidate.mjs --point BEFORE_PR --ticket <id> [--base origin/master] [--config <queue.json>] [--json]
 *
 * Two sources, compared and named separately, because a hold that cannot say
 * WHAT moved sends the run to re-read everything:
 *
 * - `task:updatedAt` — the item's marker now, read through the queue adapter,
 *   against the take-up snapshot `queue/index.mjs next` recorded in the run's
 *   `state.json` (`takeUps`, AR-133). No snapshot, no marker or no run → that
 *   source is `null`: not looked, never "unchanged".
 * - `main:<path>` — what the default branch changed since this branch forked
 *   (`git merge-base <base> HEAD` … `<base>`), intersected with the CITED
 *   paths. Cited is a labelled assumption, not a recorded fact: the paths the
 *   branch itself touches, plus every `blockers[].file` of a `check-premises`
 *   record in this run's journal — the files the run said its premises rest
 *   on. An unrelated change on the default branch does not hold.
 *
 * The aggregate is `queue/core.mjs` › beforePrRevalidationOf; this file is the
 * I/O around it. Exit 2 on `hold`, 0 on `continue` and `unverifiable`, 1 when
 * the arguments cannot be acted on (unknown point, no ticket, a base that is
 * not a revision) — and then nothing is journalled, because a refusal is not
 * an answer.
 *
 * ⚠ It reads `<base>` as it is in this checkout and never updates the remote
 * ref itself; `pr-ship` step 1 does that before calling this. A stale ref
 * makes this compare against yesterday's main and report `continue`.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutGitLocation } from './git-env.mjs';
import { readState } from './run-state.mjs';
import { beforePrRevalidationOf, revalidationOf } from './queue/core.mjs';
import { loadConfig, optionsWithPlanPath, resolveAdapter } from './queue/index.mjs';

export const POINTS = Object.freeze(['BEFORE_PR']);

const revisionOrNull = (value) =>
  typeof value === 'string' && value !== '' && !value.startsWith('-') ? value : null;

const parseArgs = (argv) => {
  const args = { point: null, ticket: null, base: 'origin/master', config: null, json: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--point') args.point = argv[++i] ?? null;
    else if (arg === '--ticket') args.ticket = argv[++i] ?? null;
    else if (arg === '--config') args.config = argv[++i] ?? null;
    else if (arg === '--base') {
      const value = revisionOrNull(argv[++i]);
      if (value === null) args.bad = arg;
      else args.base = value;
    } else if (args.bad === null) args.bad = arg;
  }
  return args;
};

const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    env: withoutGitLocation(),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

const pathsOf = (raw) => raw.split('\0').filter(Boolean);

/**
 * The paths a `check-premises` record in this run named. Only that gate: a
 * reviewer blocker names where a finding is, not what the task rests on.
 */
const citedByPremises = async (runDir) => {
  if (!runDir) return [];
  const journal = await import('./run-journal.mjs');
  const { decisions } = journal.readRun({ runDir });
  return decisions
    .filter((record) => record.gate === 'check-premises')
    .flatMap((record) => (Array.isArray(record.blockers) ? record.blockers : []))
    .map((blocker) => blocker?.file)
    .filter((file) => typeof file === 'string' && file !== '');
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

const refuse = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (invokedDirectly()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad !== null) refuse(`unrecognised or unusable argument: ${args.bad}`);
  if (!POINTS.includes(args.point)) {
    refuse(`unknown point: ${args.point ?? '(none)'}. This script knows ${POINTS.join(', ')}.`);
  }
  if (!args.ticket) refuse('--ticket is required: the item whose take-up this branch is.');

  let mergeBase;
  try {
    mergeBase = git(['merge-base', args.base, 'HEAD']).trim();
  } catch (error) {
    refuse(`--base ${args.base} is not a revision this checkout can compare against: ${error.message}`);
  }

  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const configPath = args.config ?? join(projectRoot, '.claude', 'queue.json');
  const config = loadConfig(configPath);
  const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
  const tickets = await adapter.listEligible(optionsWithPlanPath(config.options, configPath));
  const ticket = tickets.find((candidate) => String(candidate.id) === String(args.ticket)) ?? null;

  const runDir = process.env.RIG_RUN_DIR || null;
  const snapshot = runDir ? (readState(runDir).takeUps?.[args.ticket] ?? null) : null;
  // At SELECT a missing snapshot is the first sight and becomes the baseline;
  // here it is a comparison that cannot be made — the run never recorded a
  // take-up for this item, so `null`, not the SELECT point's `false`.
  const unverifiable = { changed: null, from: snapshot, to: ticket?.updatedAt ?? null };
  const task = ticket && snapshot !== null ? revalidationOf({ ticket, snapshot }) : unverifiable;

  const branchPaths = pathsOf(git(['diff', '--name-only', '-z', mergeBase, 'HEAD']));
  const mainPaths = pathsOf(git(['diff', '--name-only', '-z', mergeBase, args.base]));
  const cited = [...new Set([...branchPaths, ...(await citedByPremises(runDir))])];
  const mainChanged = mainPaths.filter((path) => cited.includes(path));

  const aggregate = beforePrRevalidationOf({ ticket: args.ticket, task, mainChanged });
  const result = {
    ...aggregate,
    task: { changed: task.changed, from: task.from ?? null, to: task.to ?? null },
    main: { base: args.base, mergeBase, cited, changed: mainChanged },
  };

  if (runDir) {
    const journal = await import('./run-journal.mjs');
    journal.recordEvent({ runDir, kind: 'revalidation', data: result, now: new Date().toISOString() });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const detail = result.source.length > 0 ? ` — ${result.source.join(', ')}` : '';
    process.stdout.write(`revalidate BEFORE_PR: ${args.ticket} ${result.action}${detail}\n`);
    if (result.action === 'hold') {
      process.stdout.write('  re-read the item and the default branch before opening or updating the PR.\n');
    }
  }
  process.exit(result.action === 'hold' ? 2 : 0);
}
