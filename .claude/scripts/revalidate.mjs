#!/usr/bin/env node
// All upstream test pointers in this script name the generator suite, absent in a generated rig.
/**
 * Revalidation at BEFORE_PR — is the branch about to ship still the branch the
 * run took up?
 *
 *   node .claude/scripts/revalidate.mjs --point BEFORE_PR --ticket <id> [--base origin/master] [--config <queue.json>] [--json]
 *   node .claude/scripts/revalidate.mjs --point BEFORE_PR --owner-directed [--base origin/master] [--json]
 *
 * BEFORE_PR has two mutually exclusive modes and neither is inferred (RP-94):
 * `--ticket` for a branch that is an item's take-up, `--owner-directed` for
 * owner-directed work or a hotfix that has no item — the path `pr-ship` step 4
 * already named while step 1 could not execute it. Passing both, or neither,
 * is exit 1 — owner-directed-revalidation.test.ts › "refuses both modes at
 * once: exit 1, stderr only, nothing journaled" and › "refuses neither mode:
 * exit 1, and the message names both ways forward".
 *
 * Owner-directed mode runs the `main:<path>` comparison below and nothing
 * else. It resolves no queue config, so no tracker or adapter is reached and
 * no credential is needed — owner-directed-revalidation.test.ts › "needs no
 * tracker credentials: an adapter name that cannot resolve is never reached".
 * A `hold` there is the same exit 2 as the ticketed path's — › "HOLDs when the
 * default branch moved under a path the branch touches".
 *
 * FOUR refusals keep it from becoming a way around the claim chain — exit 1,
 * nothing journalled, each with its own test in that file:
 *
 * - an unresolved `revalidationHold` in this run's state, which is what the
 *   ticketed path writes when it holds or answers UNVERIFIABLE — › "refuses
 *   when this run carries an unresolved revalidation hold";
 * - a take-up this run declares — › "refuses when the declared run already
 *   carries a take-up";
 * - a tracked `.rig/claims/*.json` this branch touches, added, modified,
 *   removed or renamed — › "refuses when the branch diff adds a tracked claim
 *   record", › "refuses when the branch diff modifies a tracked claim record",
 *   › "refuses when the branch RENAMES a claim record — the case
 *   --diff-filter=AM could not see" and › "refuses when the branch DELETES its
 *   claim record";
 * - `BEFORE_CLOSE` — › "refuses owner-directed at BEFORE_CLOSE — the mode
 *   exists for BEFORE_PR only".
 *
 * The first of those is the one this mode most needs, and the first version
 * shipped without it: a ticketed call that had already held was re-run here and
 * exited 0 with nothing in the repository changed.
 *
 * ⚠ Its limits, stated because the mode is a governance surface. What makes a
 * call owner-directed is the CALLER's word plus those four refusals: nothing
 * here can prove an item does not exist. Three specific gaps, each measured
 * rather than reasoned:
 *
 * - with no `RIG_RUN_DIR` there is no run state, so the hold and take-up
 *   refusals have nothing to read and cannot fire — and nothing is journalled
 *   either. The result says so in `evidence.runState`, and the report on
 *   stdout says so out loud — › "says out loud that an undeclared run checked
 *   neither the hold nor the take-up".
 * - the claim refusal reads the branch DIFF, so a claim record already on the
 *   default branch, or written but not committed, is not seen.
 * - `--base` decides more here than the verdict. The claim comparison that
 *   would otherwise survive a wrong base is absent, AND the claim-touch refusal
 *   reads the same `mergeBase..HEAD` range — so `--base HEAD` empties the
 *   branch diff and disarms that refusal as well as reporting `continue`. Pass
 *   the up-to-date `origin/<default>`; `pr-ship` step 1 refreshes it, since
 *   this script never talks to a remote itself.
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
 *   hold, and it is the operator's to fix rather than a claim waiting on a
 *   tracker. Pinned in the generator's
 *   `test/template/revalidate-adapter.test.ts` — absent in a generated rig —
 *   › "refuses an adapter name it cannot resolve with a readable message, not a
 *   stack trace" and › "refuses a queue config that is not valid JSON with a
 *   readable message, not a stack trace".
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
 * `outcome --point <P> {--ticket <id> | --owner-directed} --action-changed
 * true|false [--note …]` (AR-136, extended by RP-94) is the second half of the
 * evidence: after the re-read, it appends a `revalidation-outcome` record whose
 * `answers` is the seq of the latest matching `revalidation` at that point in
 * this run — the join a report needs, made by the writer rather than guessed by
 * the reader.
 *
 * **Which revalidation it matches depends on the mode, and the two never
 * cross.** `--ticket` matches by key and skips owner-directed detections
 * outright; `--owner-directed` matches by `mode`, because such a detection
 * carries `ticket: null` and cannot be addressed by key — and a ticketed
 * `--ticket null` must not answer it either. Pinned in the generator's
 * `test/template/owner-directed-revalidation.test.ts` (absent in a generated
 * rig) › "answers an owner-directed hold with an owner-directed outcome", ›
 * "refuses a ticketed outcome aimed at an owner-directed detection" and ›
 * "refuses an owner-directed outcome when a ticketed hold is the only one this
 * run carries — and leaves that hold latched".
 *
 * It refuses without a run, without a matching revalidation, and with any word
 * but `true`/`false`, and writes nothing then. The typed resolution names the
 * stable detection id and clears only the matching run-level hold — and only a
 * hold whose id it actually names, which is why an owner-directed outcome
 * cannot release a ticketed one. Exit 2 on `hold` or `unverifiable`, 0 on
 * `continue`, and 1 when the call cannot be acted on (unknown point, neither
 * mode or both, a base that is not a revision — or, on the paths that reach it,
 * a queue config that does not resolve) — and then nothing is journalled,
 * because a refusal is not an answer.
 *
 * ⚠ It reads `<base>` as it is in this checkout and never updates the remote
 * ref itself; `pr-ship` step 1 does that before calling this. A stale ref
 * makes this compare against yesterday's main and report `continue` — see
 * revalidate.test.ts › "reads the ref as it is: a stale origin/master reports
 * continue".
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutGitLocation } from './git-env.mjs';
import { readRun, recordEvent } from './run-journal.mjs';
import {
  clearRevalidationHold,
  readState,
  readStateForSelection,
  recordRevalidationHold,
} from './run-state.mjs';
import { POINTS as ALL_POINTS, REVALIDATES } from './lib/revalidation-points.mjs';
import { takeUpEvidenceOf } from './queue/core.mjs';
import { loadConfig, optionsWithPlanPath, resolveAdapter } from './queue/index.mjs';
import { projectRootOfConfig } from './queue/index.mjs';
import {
  CLAIM_SCHEMA_VERSION,
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
    ownerDirected: false,
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
    else if (arg === '--owner-directed') args.ownerDirected = true;
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
 * Userinfo present in a URL at all — `//<anything but a slash or space>@host`.
 * One forward pass, one negated bounded class, so it cannot backtrack.
 *
 * 🔴 It matches the CLASS, not a list of spellings, and that is the whole
 * lesson of how it got here. It first required `user:pass@`, which published
 * `//<token>@host`. Widened to make the password optional, it published
 * `//:<token>@host` — the shape `https://${JIRA_EMAIL}:${JIRA_API_TOKEN}@host`
 * degrades to when the first variable is unset, so the likeliest accident of
 * the three. Two rounds of enumerating forms; the invariant was always "there
 * is userinfo here", and it is shorter than any enumeration of it.
 *
 * The class excludes `/` and whitespace, which is what keeps an ordinary URL,
 * a bare email address in prose, and a registry path carrying an `@scope`
 * published. Pinned in the generator's `test/template/revalidate-adapter.test.ts`
 * — absent in a generated rig — › "withholds a URL whose userinfo is %s — every
 * shape, not the ones enumerated so far" and › "still publishes a message
 * carrying %s", which are tables rather than cases so a future narrowing that
 * handles the known spellings and reopens the class goes red.
 */
const URL_USERINFO = /\/\/[^\s/@]*@/;

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

/**
 * A tracked claim record, by repository-relative path (RP-94).
 *
 * ⚠ It is a SECOND spelling of the path `claimPathFor` builds, and the two are
 * kept in step by `test/template/owner-directed-revalidation.test.ts` (absent
 * in a generated rig) › "matches the path claimPathFor actually builds, from
 * the repository root and from a nested rig root" — a correspondence check
 * rather than a comment asking the next reader to remember. The leading
 * `(^|/)` is why a rig whose root sits below the git root is still matched;
 * this mode resolves no queue config, so it cannot ask where that root is.
 */
const CLAIM_RECORD = /(^|\/)\.rig\/claims\/[^/]+\.json$/;

const OWNER_DIRECTED = 'owner-directed';

/**
 * The BEFORE_PR verdict for work that has no item (RP-94).
 *
 * It carries the SAME `main:<path>` drift decision the ticketed path reaches —
 * this mode drops the claim comparison because there is no claim, and drops
 * nothing else. `ticket` is `null` rather than a placeholder: a record naming
 * an item that does not exist is worse than one that admits it has none, and
 * every reader downstream distinguishes them by that field.
 *
 * Pinned in the generator's `test/template/owner-directed-revalidation.test.ts`
 * — absent in a generated rig — › "runs BEFORE_PR with no item and no claim
 * when the default branch did not move under the branch" and › "HOLDs when the
 * default branch moved under a path the branch touches".
 */
const ownerDirectedResult = ({ point, base, mergeBase, cited, changed, now, runDeclared }) => {
  const source = changed.map((path) => `main:${path}`);
  const held = source.length > 0;
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    // 🔴 `mergeBase` is in the hash, and it is what keeps this id from being a
    // CONSTANT. Without it the digest was `{mode, point, source}` alone — the
    // same value for every `continue` that has ever run, and the same for any
    // two holds naming the same paths. `revalidation-report.mjs` flattens every
    // run into one typed-resolution index, so one `--action-changed false`
    // recorded last week would mark a genuine hold today as already answered:
    // the metric the report exists to produce, quietly wrong. It stays stable
    // across RETRIES of the same checkpoint on the same branch, which is the
    // property `answerUnverifiable`'s identity has and the one that matters.
    id: createHash('sha256')
      .update(JSON.stringify({ mode: OWNER_DIRECTED, point, mergeBase, source }))
      .digest('hex'),
    ticket: null,
    mode: OWNER_DIRECTED,
    point,
    checkpoint: point,
    result: held ? 'CHANGED' : 'CURRENT',
    changed: held,
    source,
    action: held ? 'hold' : 'continue',
    movedFingerprintSet: [],
    sourcePointer: null,
    evidence: {
      claim: 'not compared: owner-directed work has no item, so there is no claim record',
      tracker: 'not read: owner-directed mode resolves no queue adapter',
      // 🔴 "Could not check" is recorded as itself, never as "checked and
      // clean". With no run directory the hold and take-up refusals have
      // nothing to read, and a reader who saw only `continue` would take the
      // pair for having passed.
      runState: runDeclared
        ? 'read fail-closed: no unresolved revalidation hold, no declared take-up'
        : 'NOT read: no RIG_RUN_DIR, so neither the revalidation hold nor the take-up was checked',
    },
    observedAt: now,
    task: { changed: null, from: null, to: null },
    main: { base, mergeBase, cited, changed },
  };
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
  // RP-94. BEFORE_PR has two modes, and neither is ever inferred. `pr-ship`
  // already named owner-directed work with no item as a legitimate path while
  // this script refused every call without `--ticket`, so that path could not
  // be walked at all. The mode is now stated at the call site — silence is a
  // refusal, not a default, because a mode chosen by absence is a mode nobody
  // reviewed.
  if (args.ticket && args.ownerDirected) {
    refuse(
      '--ticket and --owner-directed are mutually exclusive: a branch that is an item\'s ' +
        'take-up is not owner-directed work. Pass exactly one.',
    );
  }
  if (args.ownerDirected) {
    if (args.point !== 'BEFORE_PR') {
      refuse(
        `--owner-directed is a BEFORE_PR mode only; ${args.point} compares the claim record ` +
          'itself and still needs --ticket.',
      );
    }
  } else if (!args.ticket) {
    refuse(
      '--ticket is required: the item whose take-up this branch is. For owner-directed ' +
        'work or a hotfix that has no item, pass --owner-directed instead.',
    );
  }

  const runDir = process.env.RIG_RUN_DIR || null;

  if (args.outcome) {
    if (!runDir) refuse('outcome needs RIG_RUN_DIR: an outcome answers a revalidation in a run, and there is none.');
    if (args.actionChanged !== 'true' && args.actionChanged !== 'false') {
      refuse(`--action-changed must be true or false, got ${args.actionChanged ?? '(none)'}.`);
    }
    const { events } = readRun({ runDir });
    // RP-94. An owner-directed detection carries `ticket: null`, so it cannot
    // be addressed by key — `String(null)` would also match a literal ticket
    // named "null". It is addressed by MODE instead, which is the only thing
    // that distinguishes it. Without this, a `hold` the owner-directed path
    // returned had no way to be answered at all: the skill's stated exit-2
    // remedy was a command the script refused, which is the same shape of
    // contradiction RP-94 exists to remove.
    const subject = args.ownerDirected ? `${OWNER_DIRECTED} work` : args.ticket;
    const target = [...events]
      .reverse()
      .find(
        (e) =>
          e.kind === 'revalidation' &&
          e.data?.point === args.point &&
          (args.ownerDirected
            ? e.data?.mode === OWNER_DIRECTED
            : e.data?.mode !== OWNER_DIRECTED &&
              String(e.data?.ticket) === String(args.ticket)),
      );
    if (!target) {
      refuse(`no revalidation of ${subject} at ${args.point} in ${runDir} for this outcome to answer.`);
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
        // `null`, never a placeholder, for the same reason the detection this
        // answers carries none.
        ticket: args.ownerDirected ? null : args.ticket,
        ...(args.ownerDirected ? { mode: OWNER_DIRECTED } : {}),
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
        : `revalidation-outcome: ${subject} at ${args.point} answers seq ${target.seq} — actionChanged ${args.actionChanged}\n`,
    );
    process.exit(0);
  }

  if (args.ownerDirected) {
    // RP-94. BEFORE_PR for work that has no item: the same main-vs-branch drift
    // comparison, with no tracker, no adapter and no claim record.
    //
    // 🔴 It sits ABOVE the queue-config resolution on purpose. "This mode reads
    // no tracker" has to be a property of the control flow rather than a
    // promise in a comment — nothing below this block runs, so a missing
    // credential or an adapter name that does not resolve cannot reach it.
    // Pinned by › "needs no tracker credentials: an adapter name that cannot
    // resolve is never reached".
    //
    // The refusals below are what keep the mode from becoming a way around the
    // claim chain, and every one is decided BEFORE anything is journalled: a
    // refusal is not an answer, so it leaves no revalidation record behind.
    //
    // 🔴 Read FAIL-CLOSED. `readState` is the permissive reader and its own
    // header forbids exactly this use — "a corrupt file there may be hiding a
    // persisted stop" — so an unreadable run refuses here instead of reading as
    // "this run declares nothing". The first version used `readState`, and a
    // truncated `state.json` carrying a take-up was measured continuing.
    let state = {};
    if (runDir) {
      try {
        state = readStateForSelection(runDir);
      } catch (error) {
        refuse(
          `--owner-directed refused: this run's state could not be read (${runDir}): ` +
            `${error.message}. An unreadable run may be hiding a stop.`,
        );
      }
    }

    // 🔴 The refusal this mode most needs, and the one its first version did
    // not have. A ticketed BEFORE_PR that holds or comes back UNVERIFIABLE
    // latches `revalidationHold`; re-running the same checkpoint here was
    // MEASURED exiting 0 with nothing in the repository changed — the exact
    // bypass RP-94 names. Neither other refusal can fire in that state, and
    // that is structural rather than unlucky: `takeUps` is never populated on
    // the default `plan-md` adapter at all, and the commonest hold is a
    // MISSING claim record, which is precisely when the branch writes none.
    // This one is adapter-independent because `recordRevalidationHold` is.
    const hold = state.revalidationHold;
    if (hold) {
      // A malformed hold still refuses — it is a hold either way — but it must
      // not print `undefined at undefined`, which reads as a broken command
      // rather than as the stop it is.
      const describe = (value, fallback) => (typeof value === 'string' ? value : fallback);
      refuse(
        `--owner-directed refused: this run carries an unresolved revalidation hold ` +
          `(${describe(hold.ticket, 'an unnamed item')} at ` +
          `${describe(hold.checkpoint, 'an unnamed checkpoint')}, ` +
          `${describe(hold.result, 'result unrecorded')}, detection ` +
          `${describe(hold.detectionId, 'unrecorded')}). ` +
          'Resolve it with `revalidate.mjs outcome`; re-running the checkpoint in the other ' +
          'mode is not a resolution, it is the bypass this mode refuses.',
      );
    }

    const takeUps = state.takeUps;
    // A present-but-unreadable take-up record is a refusal, not an empty one:
    // `Object.keys` answers `[]` for a number and for a list, which would turn
    // "this cannot be read" into "there is nothing here".
    if (
      takeUps !== undefined &&
      (typeof takeUps !== 'object' || takeUps === null || Array.isArray(takeUps))
    ) {
      refuse(
        `--owner-directed refused: this run's take-up record is not readable ` +
          `(takeUps is ${Array.isArray(takeUps) ? 'a list' : typeof takeUps}, expected an object).`,
      );
    }
    const takenUp = Object.keys(takeUps ?? {});
    if (takenUp.length > 0) {
      refuse(
        `--owner-directed refused: this run already declares a take-up (${takenUp.join(', ')}). ` +
          'A run holding an item revalidates with --ticket; owner-directed is for work with none.',
      );
    }

    let mergeBase;
    try {
      mergeBase = git(['merge-base', args.base, 'HEAD']).trim();
    } catch (error) {
      refuse(
        `--base ${args.base} is not a revision this checkout can compare against: ${error.message}`,
      );
    }

    // Any claim record this branch TOUCHES, in either direction.
    //
    // 🔴 `--no-renames`, and no `--diff-filter`, because both narrower forms
    // were measured letting a claim record through. `--diff-filter=AM` reports
    // NOTHING for `git mv .rig/claims/RP-1.json .rig/claims/RP-2.json` — git
    // calls it `R100` — so a branch that demonstrably ends up carrying a claim
    // record passed the check. And a branch that DELETES its claim makes the
    // ticketed call `UNVERIFIABLE`, so excluding `D` left the deletion on the
    // bypass path rather than out of scope. `--no-renames` splits a rename back
    // into its delete and its add, which is what puts both halves in front of
    // the filter. Match the CLASS — "this branch touched the claim store" —
    // rather than enumerating the statuses that class can wear.
    const claimsTouched = pathsOf(
      git(['diff', '--name-only', '--no-renames', '-z', mergeBase, 'HEAD']),
    ).filter((path) => CLAIM_RECORD.test(path));
    if (claimsTouched.length > 0) {
      refuse(
        `--owner-directed refused: this branch touches tracked claim records ` +
          `(${claimsTouched.join(', ')}). A branch that writes, moves or removes a claim is ` +
          "an item's take-up; revalidate it with --ticket.",
      );
    }

    const branchPaths = pathsOf(git(['diff', '--name-only', '-z', mergeBase, 'HEAD']));
    const mainPaths = pathsOf(git(['diff', '--name-only', '-z', mergeBase, args.base]));
    const cited = [...new Set([...branchPaths, ...citedByPremises(runDir)])];
    const mainChanged = mainPaths.filter((path) => cited.includes(path));
    const result = ownerDirectedResult({
      point: args.point,
      base: args.base,
      mergeBase,
      cited,
      changed: mainChanged,
      now: new Date().toISOString(),
      runDeclared: Boolean(runDir),
    });

    if (runDir) {
      recordEvent({ runDir, kind: 'revalidation', data: result, now: result.observedAt });
      // 🔴 No run-level revalidation hold is recorded here, and the reason is
      // NOT the one first written down. That said "a hold written here could
      // never be cleared" — which stopped being true the moment `outcome
      // --owner-directed` computed the very id `clearRevalidationHold` matches
      // on. The real reason is narrower: `recordRevalidationHold` requires a
      // string ticket, and this mode has none to give it without inventing
      // one, which is the thing the whole mode refuses to do.
      //
      // ⚠ **State the asymmetry rather than let a reader assume symmetry.** A
      // ticketed hold has TWO stops — the exit code, and a latch that
      // `queue/index.mjs` and `unresolvedBlockingDetectionOf` both read (the
      // latter also requires a string ticket, so it skips this one). An
      // owner-directed hold has ONE: the exit code below. A caller who ignores
      // it is not stopped a second time. Widening the latch to a ticketless
      // hold is a run-state schema change — Tier 2, and not this hotfix's.
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const detail = result.source.length > 0 ? ` — ${result.source.join(', ')}` : '';
      process.stdout.write(
        `revalidate ${args.point}: ${OWNER_DIRECTED} (no item) ${result.action}${detail}\n`,
      );
      if (!runDir) {
        // Loud, on the normal path, not only in the JSON: a run this command
        // could not inspect must not read as a run it inspected and cleared.
        process.stdout.write(
          '  ⚠ no RIG_RUN_DIR: the revalidation-hold and take-up refusals were NOT checked,\n' +
            '    and nothing was journalled. This is not evidence that neither exists.\n',
        );
      }
      if (result.action === 'hold') {
        process.stdout.write(
          '  re-read the default branch on those paths before opening or updating the PR,\n' +
            '  then record what the re-read concluded:\n' +
            `    node .claude/scripts/revalidate.mjs outcome --point ${args.point} --owner-directed --action-changed <true | false>\n`,
        );
      }
    }
    process.exit(result.action === 'hold' ? 2 : 0);
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
