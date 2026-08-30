#!/usr/bin/env node
// All upstream test pointers in this script name the generator suite, absent in a generated rig.
/**
 * Revalidation at BEFORE_PR — is the branch about to ship still the branch the
 * run took up?
 *
 *   node .claude/scripts/revalidate.mjs --point BEFORE_PR --ticket <id> [--base origin/master] [--config <queue.json>] [--json]
 *
 * One existing checkpoint chain, with one authoritative durable baseline:
 *
 * - `.rig/claims/<ticket>.json` carries versioned, content-blind `scope` and
 *   `commentary` fingerprint sets. Scope is authoritative at BEFORE_PR;
 *   commentary is observed but does not hold until BEFORE_CLOSE. Missing,
 *   untracked or unreadable claim state is `UNVERIFIABLE` and exits 2.
 * - `main:<path>` — what the default branch changed since this branch forked
 *   (`git merge-base <base> HEAD` … `<base>`), intersected with the CITED
 *   paths. Cited is a labelled assumption, not a recorded fact: the paths the
 *   branch itself touches, plus every `blockers[].file` of a `check-premises`
 *   record in this run's journal — the files the run said its premises rest
 *   on. An unrelated change on the default branch does not hold.
 *
 * `updatedAt` and `takeUps` are still projected into `task` as compatibility
 * evidence, but never contribute a source or action.
 *
 * At BEFORE_CLOSE (AR-135) there is no main comparison: both claim fingerprint
 * sets are authoritative. Workflow state is already inside `claim:scope`,
 * normalised to the adapter's expected claimed state, so an expected claim
 * transition stays current while a close or rollback moves scope. The item comes
 * from the adapter's `find`, which sees closed items where `listEligible`
 * drops them; one the tracker no longer offers at all reads `missing`, and
 * holds on `claim:scope` (revalidate.test.ts › "holds on claim:scope when
 * someone already closed the item", › "holds on claim:scope when the item was
 * moved back to open"). The result lists the item's dependants (`blocks`)
 * and re-reads each one's state through the same `find` (revalidate.test.ts ›
 * "re-reads each dependant's state, and names one the tracker no longer
 * offers") for the loop's write-back.
 *
 * `outcome --point <P> --ticket <id> --action-changed true|false [--note …]`
 * (AR-136) is the second half of the evidence: after the re-read, it appends a
 * `revalidation-outcome` record whose `answers` is the seq of the latest
 * `revalidation` for that ticket and point in this run — the join a report
 * needs, made by the writer rather than guessed by the reader. It refuses
 * without a run, without a matching revalidation, and with any word but
 * `true`/`false`, and writes nothing then. The typed resolution names the
 * stable detection id and clears only the matching run-level hold. Exit 2 on
 * `hold` or `unverifiable`, 0 on `continue`, and 1 when
 * the arguments cannot be acted on (unknown point, no ticket, a base that is
 * not a revision) — and then nothing is journalled, because a refusal is not
 * an answer.
 *
 * ⚠ It reads `<base>` as it is in this checkout and never updates the remote
 * ref itself; `pr-ship` step 1 does that before calling this. A stale ref
 * makes this compare against yesterday's main and report `continue` — see
 * revalidate.test.ts › "reads the ref as it is: a stale origin/master reports
 * continue".
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutGitLocation } from './git-env.mjs';
import { readRun, recordEvent } from './run-journal.mjs';
import { clearRevalidationHold, readState, recordRevalidationHold } from './run-state.mjs';
import { POINTS as ALL_POINTS, REVALIDATES } from './lib/revalidation-points.mjs';
import { takeUpEvidenceOf } from './queue/core.mjs';
import { loadConfig, optionsWithPlanPath, resolveAdapter } from './queue/index.mjs';
import { projectRootOfConfig } from './queue/index.mjs';
import { revalidateClaim, targetShaOf, withAdditionalDrift } from './lib/claim-records.mjs';

// Derived from the one source, never restated here (AR-137).
export const POINTS = REVALIDATES;

const revisionOrNull = (value) =>
  typeof value === 'string' && value !== '' && !value.startsWith('-') ? value : null;

const parseArgs = (argv) => {
  const args = {
    outcome: false,
    point: null,
    ticket: null,
    base: 'origin/master',
    config: null,
    json: false,
    actionChanged: null,
    note: null,
    bad: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (i === 0 && arg === 'outcome') args.outcome = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--action-changed') args.actionChanged = argv[++i] ?? null;
    else if (arg === '--note') args.note = argv[++i] ?? null;
    else if (arg === '--point') args.point = argv[++i] ?? null;
    else if (arg === '--ticket') {
      // The id reaches git-free paths only, but on github-issues it becomes a
      // `gh` argv element: a value starting with `-` would be read as an option.
      const value = revisionOrNull(argv[++i]);
      if (value === null) args.bad = arg;
      else args.ticket = value;
    }
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
const citedByPremises = (runDir) => {
  if (!runDir) return [];
  const { decisions } = readRun({ runDir });
  return decisions
    .filter((record) => record.gate === 'check-premises')
    .flatMap((record) => (Array.isArray(record.blockers) ? record.blockers : []))
    .map((blocker) => blocker?.file)
    .filter((file) => typeof file === 'string' && file !== '');
};

/** The last compatibility marker observed for this item, at any revalidation point. */
const lastValidationOf = (runDir, id) => {
  if (!runDir) return null;
  const { events } = readRun({ runDir });
  const last = [...events]
    .reverse()
    .find((e) => e.kind === 'revalidation' && String(e.data?.ticket) === String(id));
  const to = last?.data?.task?.to;
  return typeof to === 'string' ? to : null;
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
  // An outcome may answer any point, SELECT included — that one is written by
  // `queue/index.mjs next`, so it is not in POINTS, which names what THIS
  // script can revalidate.
  const known = args.outcome ? ALL_POINTS : POINTS;
  if (!known.includes(args.point)) {
    refuse(`unknown point: ${args.point ?? '(none)'}. This script knows ${known.join(', ')}.`);
  }
  if (!args.ticket) refuse('--ticket is required: the item whose take-up this branch is.');

  const runDir = process.env.RIG_RUN_DIR || null;

  if (args.outcome) {
    if (!runDir) refuse('outcome needs RIG_RUN_DIR: an outcome answers a revalidation in a run, and there is none.');
    if (args.actionChanged !== 'true' && args.actionChanged !== 'false') {
      refuse(`--action-changed must be true or false, got ${args.actionChanged ?? '(none)'}.`);
    }
    const { events } = readRun({ runDir });
    const target = [...events]
      .reverse()
      .find(
        (e) =>
          e.kind === 'revalidation' &&
          String(e.data?.ticket) === String(args.ticket) &&
          e.data?.point === args.point,
      );
    if (!target) {
      refuse(`no revalidation of ${args.ticket} at ${args.point} in ${runDir} for this outcome to answer.`);
    }
    const now = new Date().toISOString();
    const actionRequired = args.actionChanged === 'true';
    const record = recordEvent({
      runDir,
      kind: 'revalidation-outcome',
      data: {
        detectionId: target.data?.id,
        action: actionRequired ? 'semantic decision' : 'continue',
        actionRequired,
        driftOrigin: 'unknown',
        resolvedAt: now,
        ticket: args.ticket,
        point: args.point,
        actionChanged: actionRequired,
        note: args.note,
        answers: target.seq,
      },
      now,
    });
    clearRevalidationHold(runDir, target.data?.id);
    process.stdout.write(
      args.json
        ? `${JSON.stringify(record, null, 2)}\n`
        : `revalidation-outcome: ${args.ticket} at ${args.point} answers seq ${target.seq} — actionChanged ${args.actionChanged}\n`,
    );
    process.exit(0);
  }

  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const configPath = args.config ?? join(projectRoot, '.claude', 'queue.json');
  const config = loadConfig(configPath);
  const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
  const options = optionsWithPlanPath(config.options, configPath);
  const claimRoot = projectRootOfConfig(configPath) ?? projectRoot;

  if (args.point === 'BEFORE_CLOSE') {
    const ticket = await adapter.find(args.ticket, options);
    const takeUp = runDir ? (readState(runDir).takeUps?.[args.ticket] ?? null) : null;
    // Preserve the newest compatibility marker as evidence. This comparison
    // never decides drift; the durable claim below is the authority.
    // ISO strings compare as text; a missing side yields to the other.
    const lastValidation = lastValidationOf(runDir, args.ticket);
    const baseline =
      lastValidation !== null && takeUp !== null
        ? takeUp > lastValidation
          ? takeUp
          : lastValidation
        : (lastValidation ?? takeUp);
    const task =
      ticket && baseline !== null
        ? takeUpEvidenceOf({ ticket, snapshot: baseline })
        : { changed: null, task: { from: baseline, to: ticket?.updatedAt ?? null } };
    // Not found is not "in progress": the tracker no longer offers the item.
    const actual = ticket ? ticket.state : 'missing';
    // The dependants' state is RE-READ, not copied off the item: what this close
    // releases is only what is still waiting, and a dependant somebody closed
    // ahead of its blocker is reported as such for the write-back.
    const dependants = Array.isArray(ticket?.blocks) ? ticket.blocks : [];
    const dependantState = {};
    for (const dependant of dependants) {
      dependantState[dependant] = (await adapter.find(dependant, options))?.state ?? 'missing';
    }
    const claim = revalidateClaim({
      projectRoot: claimRoot,
      ticket: ticket ?? { id: args.ticket },
      point: 'BEFORE_CLOSE',
      claimedState: adapter.claimedState,
      // Close has no caller-selected comparison base. Resolve the same default
      // target SELECT pinned, so a missing `origin/master` cannot turn an
      // otherwise current local rig into claim:scope drift.
      targetSha: targetShaOf(claimRoot),
    });
    const result = {
      ...claim,
      observedAt: new Date().toISOString(),
      task: { changed: task.changed, from: task.task.from, to: task.task.to },
      state: { expected: adapter.claimedState, actual },
      dependants,
      dependantState,
    };
    if (runDir) {
      recordEvent({ runDir, kind: 'revalidation', data: result, now: new Date().toISOString() });
      if (result.action === 'hold' || result.action === 'unverifiable') {
        recordRevalidationHold(runDir, result);
      }
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const detail = result.source.length > 0 ? ` — ${result.source.join(', ')}` : '';
      process.stdout.write(`revalidate BEFORE_CLOSE: ${args.ticket} ${result.action}${detail}\n`);
      if (result.action === 'hold') {
        process.stdout.write('  re-read the item before closing it; a late change is not published as Done.\n');
      }
    }
    process.exit(result.action === 'hold' || result.action === 'unverifiable' ? 2 : 0);
  }

  let mergeBase;
  try {
    mergeBase = git(['merge-base', args.base, 'HEAD']).trim();
  } catch (error) {
    refuse(`--base ${args.base} is not a revision this checkout can compare against: ${error.message}`);
  }

  const tickets = await adapter.listEligible(options);
  const ticket = tickets.find((candidate) => String(candidate.id) === String(args.ticket)) ?? null;

  const snapshot = runDir ? (readState(runDir).takeUps?.[args.ticket] ?? null) : null;
  // BEFORE_PR reports this run's marker snapshot as compatibility evidence.
  // A missing marker is evidence that cannot be compared, but it does not make
  // the authoritative claim unverifiable; `revalidateClaim` decides that.
  const unverifiable = { changed: null, task: { from: snapshot, to: ticket?.updatedAt ?? null } };
  const task = ticket && snapshot !== null ? takeUpEvidenceOf({ ticket, snapshot }) : unverifiable;

  const branchPaths = pathsOf(git(['diff', '--name-only', '-z', mergeBase, 'HEAD']));
  const mainPaths = pathsOf(git(['diff', '--name-only', '-z', mergeBase, args.base]));
  const cited = [...new Set([...branchPaths, ...citedByPremises(runDir)])];
  const mainChanged = mainPaths.filter((path) => cited.includes(path));

  const claim = revalidateClaim({
    projectRoot: claimRoot,
    ticket: ticket ?? { id: args.ticket },
    point: 'BEFORE_PR',
    claimedState: adapter.claimedState,
    targetSha: targetShaOf(claimRoot, args.base),
  });
  const aggregate = withAdditionalDrift(
    claim,
    mainChanged.map((path) => `main:${path}`),
  );
  const result = {
    ...aggregate,
    observedAt: new Date().toISOString(),
    task: { changed: task.changed, from: task.task.from, to: task.task.to },
    main: { base: args.base, mergeBase, cited, changed: mainChanged },
  };

  if (runDir) {
    recordEvent({ runDir, kind: 'revalidation', data: result, now: new Date().toISOString() });
    if (result.action === 'hold' || result.action === 'unverifiable') {
      recordRevalidationHold(runDir, result);
    }
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
  process.exit(result.action === 'hold' || result.action === 'unverifiable' ? 2 : 0);
}
