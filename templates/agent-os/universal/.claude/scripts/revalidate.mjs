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
 *   untracked or unreadable claim state is `UNVERIFIABLE` and exits 2. So is a
 *   tracker whose adapter this script cannot READ (RP-64) — that one means the
 *   question was never put, rather than that the claim record is unreadable.
 *   ⚠ Reads, precisely: the queue CONFIG failing to resolve at all — an unknown
 *   adapter name, a malformed `queue.json` — is exit 1, the refusal path, not a
 *   hold. It no longer prints a stack trace either, but it is the operator's to
 *   fix rather than a claim waiting on a tracker.
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
import {
  revalidateClaim,
  targetShaOf,
  unverifiableResult,
  withAdditionalDrift,
} from './lib/claim-records.mjs';
import { DEFAULT_SCAN_LIMIT, findSecretValues } from './lib/secrets.mjs';

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

/**
 * The adapter's own message, unless it carries something credential-shaped.
 *
 * The messages this is written for name environment VARIABLES rather than their
 * values, and naming them is exactly what the caller acts on. But an adapter is
 * free to put a URL or a response body into a message, and this text is
 * published to stdout and into a verdict a run journals — neither of which
 * `guard-secret-file` or `validate-no-secrets` can see — so it is checked
 * against the one credential vocabulary this repository has before it goes
 * anywhere.
 *
 * ⚠ **It is defence in depth, not a general redacter.** Measured on the shapes
 * an adapter could plausibly produce: an Atlassian token value, an opaque token
 * after a credential keyword, and a token in a query string are caught by
 * `findSecretValues`; `Authorization: Bearer <opaque>` and `Authorization: Basic
 * <base64>` are NOT, and no shape outside the vocabulary is.
 *
 * 🔴 **URL userinfo is matched HERE rather than left to the vocabulary, because
 * it is reachable through the adapter this repository configures.** `jira.mjs`
 * builds its own errors from method, route and status — but its network arm
 * re-raises the underlying error untouched, and `requireCredentials` accepts any
 * `JIRA_BASE_URL` that begins with `https://`, userinfo included. Undici then
 * throws "Request cannot be constructed from a URL that includes credentials:
 * https://user:<password>@host/…". `findSecretValues` does not see that shape,
 * and unlike the pre-RP-64 crash — which put it on stderr — this path PERSISTS
 * it into the run journal. So the reason is withheld on userinfo as well.
 *
 * An earlier version of this comment argued the blind spots were acceptable
 * because no adapter here produces them. That was false, and resting a safety
 * property on a claim about every present and future adapter is the wrong shape
 * of argument regardless.
 *
 * All-or-nothing on purpose: `findSecretValues` never returns the matched text,
 * so redacting in place would need a second matcher, and a partial redacter is
 * where redacters leak.
 *
 * Exported so the control itself is testable rather than only reachable through
 * a subprocess. Pinned in the generator's `test/template/revalidate-adapter.test.ts`
 * — absent in a generated rig — › "publishes a message that names only environment variables"
 * and › "withholds a message carrying a credential-shaped value".
 */
/**
 * Credentials in a URL's userinfo — `//user:secret@host`. One forward pass, both
 * character classes negated and bounded, so it cannot backtrack.
 */
const URL_USERINFO = /\/\/[^\s/@:]+(?::[^\s/@]*)?@/;

export const safeReason = (text) => {
  // Scan and publish the SAME prefix: findSecretValues reads at most
  // DEFAULT_SCAN_LIMIT, and publishing more than was scanned would ship the
  // unscanned tail verbatim.
  const scanned = String(text ?? '').slice(0, DEFAULT_SCAN_LIMIT);
  return findSecretValues(scanned).length === 0 && !URL_USERINFO.test(scanned)
    ? scanned
    : 'the queue adapter could not be read; its message is withheld because it carries a credential-shaped value';
};

/**
 * The revalidation boundary for a tracker that cannot be read (RP-64).
 *
 * 🔴 It answers `UNVERIFIABLE` and exits 2 — the same hold path a real drift
 * takes, and never 0. "The adapter was unreachable" is not evidence that the
 * branch is still the branch the run took up, and a caller that read it as a
 * pass would carry an unchecked claim into a PR. A drift the adapter DID report
 * still comes back as `hold`, and an unchanged claim still as `continue`;
 * this only replaces the crash. Pinned in the generator's
 * `test/template/revalidate-adapter.test.ts` — absent in a generated rig — ›
 * "holds the same way at BEFORE_CLOSE, which reads the adapter through a different call"
 * and › "still refuses an unusable invocation as before — this did not swallow argument errors".
 *
 * The detection `identity` names the point and the operation and NOT the
 * message, so it is stable across retries of the same outage — which also means
 * two unrelated failures at one operation share an id, and one `outcome`
 * answers both.
 */
const answerUnverifiable = ({ runDir, ticket, point, json }, operation, cause) => {
  const result = unverifiableResult({
    ticket: { id: ticket },
    point,
    reason: safeReason(
      `the queue adapter could not be read (${operation}): ${cause?.message ?? cause}`,
    ),
    identity: `adapter-unreadable:${operation}`,
  });
  if (runDir) {
    // Announce, never throw: a stale or unwritable RIG_RUN_DIR made these throw
    // INSIDE the catch that was handling the adapter failure, and the run ended
    // on the Node stack trace this whole change exists to remove.
    try {
      recordEvent({ runDir, kind: 'revalidation', data: result, now: new Date().toISOString() });
      recordRevalidationHold(runDir, result);
    } catch (error) {
      process.stderr.write(
        `could not journal this revalidation into ${runDir}: ${error?.message ?? error}\n`,
      );
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `revalidate ${point}: ${ticket} unverifiable — the queue adapter could not be read (${operation})\n`,
    );
    process.stdout.write(`  ${result.evidence.error}\n`);
    process.stdout.write(
      '  this is NOT a pass: nothing about the claim was observed. Fix the adapter and run it again.\n',
    );
  }
  process.exit(2);
};

/** Every adapter call in this script goes through here, or it can still crash. */
const readAdapter = async (operation, read, context) => {
  try {
    return await read();
  } catch (error) {
    answerUnverifiable(context, operation, error);
  }
  // Reached only if answerUnverifiable failed to exit. Throwing rather than
  // returning null keeps a null ticket from reaching revalidateClaim and
  // resolving to `continue` — the silent pass this whole change forbids.
  //
  // Outside the catch on purpose, and it carries no `cause`: the caught error
  // is the raw adapter message, the one thing the frame above exists to
  // withhold, and Node's uncaught printer walks a cause chain.
  throw new Error('unreachable: answerUnverifiable did not exit');
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
  // 🔴 The queue CONFIG, not the tracker behind it. `readAdapter` covers every
  // adapter CALL, but resolving the config sat outside it, so an unknown
  // adapter name or a malformed `queue.json` still crashed with the raw Node
  // stack trace this script exists to remove — and the `[cause]` chain of the
  // malformed case printed the parse error underneath it.
  //
  // It stays exit 1 rather than becoming `UNVERIFIABLE`: a config the operator
  // has to fix is the command refusing, not a claim held pending a tracker
  // that might come back. `refuse` is the path this file already uses for that.
  let config;
  let adapter;
  try {
    config = loadConfig(configPath);
    adapter = await resolveAdapter(config.adapter ?? 'plan-md');
  } catch (error) {
    refuse(
      `the queue configuration at ${configPath} could not be resolved: ` +
        safeReason(error?.message ?? String(error)),
    );
  }
  const options = optionsWithPlanPath(config.options, configPath);
  const claimRoot = projectRootOfConfig(configPath) ?? projectRoot;

  if (args.point === 'BEFORE_CLOSE') {
    const context = { runDir, ticket: args.ticket, point: args.point, json: args.json };
    const ticket = await readAdapter('find', () => adapter.find(args.ticket, options), context);
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
      dependantState[dependant] =
        (await readAdapter('find dependant', () => adapter.find(dependant, options), context))
          ?.state ?? 'missing';
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

  const tickets = await readAdapter('listEligible', () => adapter.listEligible(options), {
    runDir,
    ticket: args.ticket,
    point: args.point,
    json: args.json,
  });
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
