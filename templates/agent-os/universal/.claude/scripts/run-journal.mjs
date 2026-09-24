/**
 * The run journal — the machine-readable trace BEHIND the human journal in
 * `journal/YYYY-MM.md`.
 *
 * Gate verdicts go to `decisions.jsonl`, everything else to `events.jsonl`, both
 * append-only, both inside one per-run directory the caller hands over. It
 * answers *what did the run decide, and on what basis*; it never answers *was
 * that the right call*, and it replaces neither the month file nor `PLAN.md`.
 *
 * The two are opposites and stay that way: this trace is append-only and
 * OLDEST-first, the month file is newest-on-top. Reading one as the other is
 * how a reader concludes a run did nothing.
 *
 * 🔴 **A journal with no call site records nothing.** The writer is the easy
 * half and the worthless one on its own — the shape this module is ported from
 * shipped the writer plus the rule and no gate ever called it, so a run that
 * looked instrumented produced empty directories. The caller ships with it:
 * `queue/index.mjs` records its `item-selection` verdict.
 *
 * 🔴 **The ordering is asserted here, not documented somewhere.** A journal
 * whose order the reader cannot trust is worse than none: a stale record reads
 * as the current one, which is the exact failure a journal exists to prevent.
 * So every record carries `seq`, the run-wide counter, and `readRun` REFUSES a
 * run whose sequence has a gap or runs backwards rather than handing back
 * records it cannot vouch for.
 *
 * ⚠ **`seq` is the authority on order, and the timestamp is data.** The clock is
 * injected, so it is whatever the caller passed — a re-synced host clock, a
 * caller stamping one value across a batch, or two callers on different
 * machines all produce timestamps that do not order. A counter incremented
 * under the lock below does — two writers sharing one run directory take
 * turns computing it rather than racing to the same number (see the
 * serialisation section that follows).
 *
 * **What this module deliberately does NOT own:** the run-id convention, creating
 * the directory, and rotation. Those belong to whatever drives the run — in this
 * rig, the `loop` skill, which declares `RIG_RUN_DIR` in its preflight. This
 * module is handed a `runDir` and uses it verbatim. Two owners of one convention
 * disagree the first time either changes, and a rotation scheme for files nobody
 * has accumulated is invention.
 *
 * ✅ **Writers in one run directory are serialised, not merely detected.**
 * `append()` takes an exclusive lock — `<runDir>/.journal.lock`, opened `wx` —
 * before it reads `seq` and before it writes, so two processes sharing one run
 * directory take turns rather than racing:
 * `test/template/run-journal-writers.test.ts` (absent in a generated rig) ›
 * "eight concurrent recordEvent calls land as one run with seq exactly 1..8".
 *
 * **The lock has an owner, not just a name on disk.** Its creator writes a
 * random token (`pid:hex`) into it before doing anything else; releasing it
 * removes the file only if its content is still that same token. A lock
 * reclaimed out from under a slow-but-alive writer therefore does not vanish
 * a second time when that writer finally calls `releaseLock` — it finds
 * somebody else's token there and leaves the file alone.
 *
 * **The wait is step-counted, never clock-read.** `acquireLock` makes at most
 * `LOCK_WAIT_MS / LOCK_STEP_MS` open attempts, sleeping one `LOCK_STEP_MS`
 * step (`Atomics.wait`, never a spin) between attempts that follow one
 * another; running out of attempts is the new failure kind, `'busy'`,
 * classified by `isTraceExhausted` exactly like `'unusable'`/`'ended'`: a busy
 * lock costs the caller one lost RECORD, never the run. See the same file ›
 * "throws a `busy` RunJournalError within a bounded time when the lock is
 * fresh and held, and writes nothing". This module reads no system clock at
 * all to do any of it — not the wall clock, not a monotonic timer, not the
 * process's own high-resolution one — see `test/template/run-journal.test.ts`
 * (absent in a generated rig) › "names no clock of its own anywhere in the
 * module" for the exact forbidden spellings, none of which appear anywhere in
 * this file, including the locking code below. Staleness is judged FS-clock
 * against FS-clock instead: a lock older than ~10s is a crashed writer's, and
 * "older" is read by comparing the lock file's own `mtime` against the
 * `mtime` of a marker file this call just created — never against a value
 * this process read from a system clock.
 *
 * **Reclaim is itself serialised, by a second exclusive marker.** Two writers
 * that both see the same stale lock cannot both act on it: each first has to
 * `openSync('<runDir>/.journal.lock.reclaim', 'wx')`, and only one of them
 * can. The winner re-reads the main lock *after* it holds the marker, confirms
 * it is still the same lock it judged stale (same token content, still stale
 * by the marker's own `mtime`), removes it, then removes the marker. A writer
 * that fails to create the marker does not retry for it — it just keeps
 * waiting its normal steps, so at most one reclaim attempt happens per
 * `acquireLock` call and reclaim can never turn into a retry loop. This closes
 * the gap a stat-then-rm reclaim left open: two writers each seeing the lock
 * as stale, each removing what the other had just (re)created, both believing
 * they held the one lock `append()` promises. See
 * `test/template/run-journal-writers.test.ts` (absent in a generated rig) ›
 * "writes the record and leaves no lock file behind, once the existing lock is
 * old enough to be stale" (the ordinary case) and ›
 * "runs the eight-writer race against a pre-planted stale lock repeatedly, and
 * readRun never breaks" (the race the marker exists to close). A reclaim
 * marker itself left behind by a writer that crashed between creating it and
 * removing it is a case this module deliberately does NOT recover from: it is
 * simpler, and its cost is bounded and visible — every later reclaim attempt
 * finds the marker already taken and every writer eventually reports `'busy'`
 * — rather than adding a second stale-marker judgement whose own race would
 * need the same proof this section exists to give the first one. A human
 * removes it.
 *
 * **Contention is told apart from a directory that simply refuses the
 * write.** `EEXIST` is ordinary contention. `EACCES`/`EPERM` count as
 * contention only when the lock path itself can be `lstat`-ed — i.e. some
 * other handle is the reason the open failed; when the path does not exist at
 * all, the directory is the one refusing the write, and no amount of waiting
 * makes it writable, so this fails fast as a non-`'busy'` refusal instead of
 * spending the whole bounded wait first. See the same file ›
 * "fails fast as a non-busy refusal when the directory cannot even hold a
 * lock file".
 *
 * `readRun` takes no lock at all — many concurrent readers is not the problem
 * this serialises — and tolerates a final line with no trailing newline as a
 * record another writer has not finished flushing yet, skipping it rather
 * than refusing the whole run: see the same file ›
 * "returns the complete records and skips a final line with no trailing
 * newline". `append()` keeps its existing strictness on that same case,
 * because a writer must never build the next `seq` on top of a line nobody
 * can vouch for: see the same file ›
 * "still refuses to append on top of that same unterminated tail". One run
 * directory per run remains the caller's part of the contract — this
 * serialises writers sharing one, it does not make sharing one across two
 * different runs safe (`docs/decisions/run-directory.md`).
 */

import {
  appendFileSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const DECISIONS = 'decisions.jsonl';
const EVENTS = 'events.jsonl';

/** The end marker is an ordinary record; this is the field that makes it one. */
const RUN_END = 'run-end';

/** The exclusive lock every `append()` call takes before it reads or writes. */
const LOCK_FILE = '.journal.lock';
/**
 * The second exclusive marker that serialises RECLAIM itself — only the
 * writer that creates this (`wx`) may judge and remove a stale main lock.
 */
const RECLAIM_FILE = '.journal.lock.reclaim';
/** Total time a caller waits for a held lock before giving up as `'busy'`. */
const LOCK_WAIT_MS = 2000;
/** One wait step — short, and never a busy spin (`Atomics.wait` blocks). */
const LOCK_STEP_MS = 25;
/** The bounded number of open attempts `acquireLock` makes — never a clock-read deadline. */
const LOCK_MAX_ATTEMPTS = Math.ceil(LOCK_WAIT_MS / LOCK_STEP_MS);
/** A lock older than this is a crashed writer's, not a live one's. */
const STALE_LOCK_MS = 10000;

/**
 * Why a journal call failed, as a value rather than a sentence.
 *
 * The caller has to act differently on two of these than on the rest, and the
 * only other way to tell them apart is to match on the message text — which puts
 * the decision in two files at once and lets them drift the day someone improves
 * the wording.
 */
export const JOURNAL_FAILURES = Object.freeze([
  'undeclared', // no runDir was passed at all
  'run-dir-missing', // a runDir was passed and there is no such directory
  'field-missing', // a record that would name neither its gate nor its verdict
  'field-invalid', // a field was supplied in a shape the record cannot carry
  'unusable', // the journal on disk cannot be trusted (sequence, or unreadable)
  'ended', // this run already carries its run-end marker
  'busy', // another writer held the lock past the bounded wait; the record is lost
]);

export class RunJournalError extends Error {
  constructor(failure, message, options) {
    super(message, options);
    this.name = 'RunJournalError';
    this.failure = failure;
  }
}

/**
 * Is this a failure of the TRACE alone, leaving the caller's own work valid?
 *
 * 🔴 The distinction is the difference between a lost trace and a stalled loop.
 * A journal that cannot accept records — a directory two sessions shared, one
 * reused after its run ended — is unrepairable by design: it is append-only, and
 * every later write re-reads it. If that stopped the caller, one collision would
 * make the queue unselectable **forever**, and the trace would have taken the
 * work down with it. The other failures are the caller's own mis-declaration,
 * caught before anything happened and fixed in a second.
 */
export const isTraceExhausted = (error) =>
  error instanceof RunJournalError &&
  (error.failure === 'unusable' || error.failure === 'ended' || error.failure === 'busy');

const requireRunDir = (runDir) => {
  if (typeof runDir !== 'string' || runDir.trim() === '') {
    throw new RunJournalError(
      'undeclared',
      'the run journal needs a runDir: the run directory is the caller\'s to choose ' +
        '(the convention is `.claude/runs/<run-id>/`), and this module deliberately ' +
        'invents none — a default would be a second owner of that convention.',
    );
  }
  return runDir;
};

/**
 * The directory has to exist, and its absence is an absence — never an empty run.
 *
 * A missing file inside the run directory is zero records, honestly: the run has
 * not written that kind yet. A missing DIRECTORY is a different fact entirely —
 * a typo in the declaration, or a directory someone deleted — and folding it into
 * the same answer would hand back "this run decided nothing and is still going"
 * about a run whose trace is simply not there. Checked in one place, for both the
 * read and the write path, so the two cannot disagree about it.
 */
const requireRunDirExists = (runDir) => {
  let stats;
  try {
    stats = statSync(runDir);
  } catch (error) {
    throw new RunJournalError(
      'run-dir-missing',
      `the run directory ${runDir} does not exist (${error?.code ?? 'unknown error'}), so ` +
        'there is no trace to read or append to. An absent directory is not an empty ' +
        'run: it is a declaration nobody honoured.',
      { cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new RunJournalError(
      'run-dir-missing',
      `the run directory ${runDir} exists but is not a directory, so this run's two ` +
        'journal files have nowhere to live.',
    );
  }
  return runDir;
};

const requireClock = (now) => {
  // 🔴 Reading the clock here instead would make every record untestable and
  // every replay a different file. The caller stamps; this module records.
  if (typeof now !== 'string' || now.trim() === '') {
    throw new RunJournalError(
      'field-missing',
      'the run journal needs `now` (an ISO timestamp): the clock is injected, never ' +
        'read here, which is what makes these records reproducible in a test.',
    );
  }
  return now;
};

/**
 * A record has to say what it is about.
 *
 * A verdict naming no gate, or a marker naming no reason for stopping, is a line
 * in a file that answers none of the questions the file exists for — and the
 * argument this module makes for a record over a sentinel file is precisely that
 * a record carries when and why. Writing one that carries neither would refute
 * its own header.
 */
const requireField = (name, value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunJournalError(
      'field-missing',
      `the run journal needs \`${name}\`: a record that does not name its ${name} ` +
        'answers none of the questions the journal is read for.',
    );
  }
  return value;
};

/**
 * One journal file, parsed.
 *
 * An absent file is zero records — a run that has not written that kind yet is
 * the normal state. A file that exists and does not parse is NOT: folding it
 * into an empty list would silently shorten the trace, and a shorter trace of a
 * run is indistinguishable from a trace of a shorter run.
 *
 * `tolerateUnterminatedTail` is `readRun`'s one exception to that rule: a file
 * whose last byte is not `\n` has a writer mid-flush, not a corrupt file, so
 * that one line is dropped rather than parsed. `append()` never opts in — it
 * must never build the next `seq` on top of a line nobody can vouch for.
 */
const linesOf = (runDir, file, { tolerateUnterminatedTail = false } = {}) => {
  const path = join(runDir, file);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw new RunJournalError(
      'unusable',
      `${path} exists but could not be read (${error?.code ?? 'unknown error'}), so this ` +
        'run\'s trace cannot be trusted to be complete. Refusing rather than reading ' +
        'the readable half as the whole.',
      { cause: error },
    );
  }

  let lines = raw.split('\n').filter((line) => line.trim() !== '');
  if (tolerateUnterminatedTail && lines.length > 0 && !raw.endsWith('\n')) {
    lines = lines.slice(0, -1);
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new RunJournalError(
        'unusable',
        `${path} line ${index + 1} is not a journal record, so the sequence cannot be ` +
          'checked and the order of this run cannot be trusted. A journal degrades ' +
          'loudly or not at all.',
        { cause: error },
      );
    }
  });
};

/**
 * Both files, with the ordering invariant enforced across them.
 *
 * Two checks, and they catch different things:
 *   - **within a file**, `seq` must increase down the lines. Append-only makes
 *     line order write order, so a decreasing pair means the file was edited or
 *     assembled — the case a reader cannot see by eye;
 *   - **across both files**, the union of `seq` must be exactly `1..N`. A gap is
 *     a lost record; a duplicate is two records claiming one position — the
 *     shape a hand-edited or reused directory leaves, now that `append()`
 *     itself serialises genuinely concurrent writers via the lock below.
 */
const readBoth = (runDir, { tolerateUnterminatedTail = false } = {}) => {
  const decisions = linesOf(runDir, DECISIONS, { tolerateUnterminatedTail });
  const events = linesOf(runDir, EVENTS, { tolerateUnterminatedTail });

  const refuse = (why) => {
    throw new RunJournalError(
      'unusable',
      `the run journal in ${runDir} cannot be trusted: ${why}. The sequence is what ` +
        'orders these records — with it broken, a stale record reads as the current ' +
        'one, which is the failure the journal exists to prevent.',
    );
  };

  for (const [file, records] of [
    [DECISIONS, decisions],
    [EVENTS, events],
  ]) {
    for (const [index, record] of records.entries()) {
      if (!Number.isInteger(record?.seq)) {
        refuse(`${file} line ${index + 1} carries no integer seq`);
      }
      if (index > 0 && record.seq <= records[index - 1].seq) {
        refuse(
          `${file} runs backwards at line ${index + 1} (seq ${records[index - 1].seq} ` +
            `then ${record.seq}), so its order is not its write order`,
        );
      }
    }
  }

  const all = [...decisions, ...events].sort((a, b) => a.seq - b.seq);
  for (const [index, record] of all.entries()) {
    if (record.seq !== index + 1) {
      refuse(
        `the records across both files are not a whole sequence — expected seq ` +
          `${index + 1}, found ${record.seq}`,
      );
    }
  }

  return { decisions, events, all };
};

/**
 * A synchronous, non-busy sleep: `Atomics.wait` blocks this thread for `ms`
 * without spinning it. `acquireLock` is the only caller.
 */
const sleepSync = (ms) => {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
};

/** A short random token, unique enough to tell this call's lock from any other's. */
const newToken = () => `${process.pid}:${randomBytes(8).toString('hex')}`;

/**
 * Is the error from `openSync(path, 'wx')` ordinary contention — another
 * handle already owns `path` — rather than the directory itself refusing the
 * write? `EEXIST` always is. `EACCES`/`EPERM` are contention only when `path`
 * can still be `lstat`-ed: some other handle is the reason the open failed.
 * When `path` does not exist at all, nothing is holding it — the directory
 * refused the write outright, and no amount of waiting fixes that, so the
 * caller must not spend the bounded wait on it: see
 * `test/template/run-journal-writers.test.ts` (absent in a generated rig) ›
 * "fails fast as a non-busy refusal when the directory cannot even hold a
 * lock file".
 */
const isLockContention = (error, path) => {
  if (error?.code === 'EEXIST') return true;
  if (error?.code !== 'EACCES' && error?.code !== 'EPERM') return false;
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * At most one attempt, per `acquireLock` call, to reclaim a lock that looks
 * stale — serialised across processes by a second exclusive marker so two
 * writers can never both act on the same stale lock (see the module header).
 *
 * Every filesystem call here is a single, non-looping step: one marker
 * creation, up to two stats, up to two reads, up to two removals. Failing to
 * create the marker (another writer already holds it, or the directory
 * refuses it too) is not an error for THIS call — it just means this writer
 * takes no part in reclaiming and falls through to its normal step-wait.
 */
const tryReclaimStaleLock = (runDir, lockPath) => {
  const markerPath = join(runDir, RECLAIM_FILE);
  let markerFd;
  try {
    markerFd = openSync(markerPath, 'wx');
  } catch {
    return; // someone else is already reclaiming, or the marker can't be made
  }
  try {
    closeSync(markerFd);
    // The marker's own mtime IS this call's reading of "now" — an FS
    // timestamp compared against another FS timestamp, never a value read
    // from a system clock (forbidden throughout this module:
    // `test/template/run-journal.test.ts`, absent in a generated rig, ›
    // "names no clock of its own anywhere in the module").
    let markerMtimeMs;
    let judgedToken;
    let judgedStale;
    try {
      markerMtimeMs = statSync(markerPath).mtimeMs;
      judgedToken = readFileSync(lockPath, 'utf8');
      judgedStale = markerMtimeMs - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
    } catch {
      return; // the lock vanished mid-check — another writer's release raced this
    }
    if (!judgedStale) return;

    // Re-read immediately before removing: only remove the lock if it is
    // STILL the exact one just judged stale — same token content, still
    // stale by the same marker mtime. A lock a live writer has taken over in
    // the meantime fails this check and is left alone.
    try {
      const currentToken = readFileSync(lockPath, 'utf8');
      const stillStale = markerMtimeMs - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
      if (currentToken === judgedToken && stillStale) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Gone already, or unreadable — nothing left for this call to remove.
    }
  } finally {
    try {
      rmSync(markerPath, { force: true });
    } catch {
      // Best-effort: a marker this call cannot remove is a crashed-reclaim
      // marker from here on — see the module header's documented limit.
    }
  }
};

/**
 * The exclusive lock every `append()` call takes before it reads `seq` or
 * writes — the mechanism that turns "detected" into "serialised" (see the
 * module header).
 *
 * Provably bounded, on every path: the wait is a fixed count of open
 * attempts — `LOCK_MAX_ATTEMPTS`, derived from `LOCK_WAIT_MS`/`LOCK_STEP_MS`
 * — with an `Atomics.wait(LOCK_STEP_MS)` step between attempts, never a
 * clock-read deadline; and at most one stale-lock reclaim attempt per call
 * (never a retry loop around it, so a lock some other process keeps
 * recreating cannot turn this into unbounded work).
 */
const acquireLock = (runDir) => {
  const lockPath = join(runDir, LOCK_FILE);
  const token = newToken();
  let reclaimAttempted = false;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, token);
      return { lockPath, fd, token };
    } catch (error) {
      if (!isLockContention(error, lockPath)) {
        throw new RunJournalError(
          'unusable',
          `the run journal in ${runDir} could not take its lock (${error?.code ?? 'unknown error'}), ` +
            'so this record was not written and nothing was modified.',
          { cause: error },
        );
      }
    }

    if (!reclaimAttempted) {
      reclaimAttempted = true;
      tryReclaimStaleLock(runDir, lockPath);
      // No sleep spent on this step: retry the open immediately, whether or
      // not the reclaim removed anything.
    } else if (attempt < LOCK_MAX_ATTEMPTS - 1) {
      sleepSync(LOCK_STEP_MS);
    }
  }

  throw new RunJournalError(
    'busy',
    `the run journal in ${runDir} could not take its lock within ~${LOCK_WAIT_MS}ms: ` +
      'another writer is holding it. This record is lost, not the run — the ' +
      "caller's own work continues.",
  );
};

/**
 * Release in the order the lock was taken in: close the handle, then remove
 * the file — but only if it still carries THIS call's own token. A lock
 * reclaimed out from under a slow-but-alive writer, and re-created by whoever
 * reclaimed it, must not be deleted a second time by the writer that no
 * longer owns it.
 */
const releaseLock = ({ lockPath, fd, token }) => {
  try {
    closeSync(fd);
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === token) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Gone already, or unreadable — nothing this call needs to remove.
    }
  }
};

/**
 * Append one record, after the two questions every write has to answer first:
 * is this run already over, and what number is this record.
 *
 * Both answers come from the files themselves rather than from memory, because
 * every caller is its own short-lived process — the CLI that selects an item and
 * the gate that returns a verdict never share a variable. The whole read-then-
 * write below runs under the exclusive lock, so two such processes sharing one
 * run directory take turns rather than computing the same `seq`.
 */
const append = (runDir, file, fields, now) => {
  requireRunDir(runDir);
  requireRunDirExists(runDir);
  requireClock(now);

  const lock = acquireLock(runDir);
  try {
    const { all } = readBoth(runDir);

    // 🔴 A run whose end can be followed by more records has no end. The marker
    // exists to remove exactly one ambiguity — "did this run stop, or is it still
    // going" — and a late record puts it straight back.
    if (all.some((record) => record.kind === RUN_END)) {
      throw new RunJournalError(
        'ended',
        `the run in ${runDir} already carries its run-end marker, so nothing more may be ` +
          'recorded against it. A second record after the end would make "when did this ' +
          'run stop" have two answers and give the reader no way to pick one.',
      );
    }

    const record = { seq: all.length + 1, at: now, ...fields };
    try {
      appendFileSync(join(runDir, file), `${JSON.stringify(record)}\n`);
    } catch (error) {
      // 🔴 The write door needs the same classification as the read door, and it
      // was the one fs call left unwrapped. A full disk or a file the run cannot
      // write reached the caller as a plain error, missed `isTraceExhausted`, and
      // withheld the work — reproducing from this side the exact failure the
      // classification exists to prevent. A journal that cannot take this record
      // will not take the next one either: the trace is over, the run is not.
      throw new RunJournalError(
        'unusable',
        `the run journal in ${runDir} could not be appended to ` +
          `(${error?.code ?? 'unknown error'}), so this run's trace stops here. The ` +
          'record was not written and nothing was modified.',
        { cause: error },
      );
    }
    return record;
  } finally {
    releaseLock(lock);
  }
};

/**
 * A gate verdict: what was decided, and on what basis.
 *
 * `blockers` is what a structured verdict carries beyond the word
 * (`lib/verdict.mjs`), and it is written verbatim — the blocker's own `rule` is
 * what the author acts on, so a record keeping only a count would be the prose
 * verdict again wearing a field name.
 *
 * 🔴 **Omitted is not empty.** With no `blockers` argument the key is absent
 * from the record; `[]` is a CLAIM — "this gate named none" — and a caller that
 * never passed the field never made it. Writing one in would let a later reader
 * conclude a gate ruled clean from a record whose writer said nothing at all.
 */
export const recordDecision = ({
  runDir,
  gate,
  verdict,
  why = null,
  blockers,
  headSha,
  reviewers,
  now,
} = {}) => {
  requireField('gate', gate);
  requireField('verdict', verdict);

  const fields = { gate, verdict, why };
  if (headSha !== undefined) {
    if (typeof headSha !== 'string' || headSha.trim() === '') {
      throw new RunJournalError(
        'field-invalid',
        'the run journal takes `headSha` as the commit the gate answered for. Absent is the ' +
          'honest answer when the gate did not say which one; a blank stands in for a commit ' +
          'and names none.',
      );
    }
    fields.headSha = headSha;
  }
  if (reviewers !== undefined) {
    if (!Array.isArray(reviewers) || reviewers.some((name) => typeof name !== 'string')) {
      throw new RunJournalError(
        'field-invalid',
        'the run journal takes `reviewers` as the list of reviewers a route asked for, or a ' +
          'gate launched. A summary sentence in its place cannot be compared against the ' +
          'verdicts that came back, which is the only thing this field is for.',
      );
    }
    // 🔴 No length check: `[]` is the answer for a lane that launches nobody,
    // and it has to be distinguishable from the key being absent. Absent means
    // the writer said nothing about reviewers at all — which is what every
    // record written before this field existed means.
    fields.reviewers = reviewers;
  }
  if (blockers !== undefined) {
    if (!Array.isArray(blockers)) {
      throw new RunJournalError(
        'field-invalid',
        'the run journal takes `blockers` as a list of the blockers a verdict named. A ' +
          'summary sentence in its place is the prose verdict this field exists to replace.',
      );
    }
    fields.blockers = blockers;
  }

  return append(runDir, DECISIONS, fields, now);
};

/**
 * Everything that is not a gate verdict.
 *
 * 🔴 It may not forge the end of the run. `kind` is a free string from the
 * caller and exactly one value is load-bearing, so without this an ordinary
 * event closes the run — and every later record is refused, by a marker nobody
 * meant to write and no reader can distinguish from a real one.
 */
export const recordEvent = ({ runDir, kind, data = null, now } = {}) => {
  requireField('kind', kind);
  if (kind === RUN_END) {
    throw new RunJournalError(
      'field-missing',
      `\`${RUN_END}\` is the marker's own kind and only \`endRun\` may write it: an ` +
        'event carrying it would end the run without naming why it stopped, and ' +
        'nothing downstream could tell the two apart.',
    );
  }
  return append(runDir, EVENTS, { kind, data }, now);
};

/**
 * The run-end marker — shipped from day one, not added once someone is confused.
 *
 * It is a record and not a sentinel file on purpose: a touch-file would satisfy
 * "did it end" while carrying no time, no position in the sequence and no
 * reason, and the trace could not say when or why the run stopped. The failure it
 * exists to prevent is an ordinary one — a journal entry reading *"stopped at —
 * checkpoint, still running"* outliving by weeks the run that wrote it, with
 * nothing in the file able to contradict it.
 */
export const endRun = ({ runDir, stop, now } = {}) => {
  requireField('stop', stop);
  return append(runDir, EVENTS, { kind: RUN_END, stop }, now);
};

/**
 * The run as a reader sees it: both files, and whether it ended.
 *
 * It refuses rather than returning a sequence it cannot vouch for — see
 * `readBoth`. That refusal IS the ordering invariant; documenting the ordering
 * and checking nothing is what this module was ported to stop doing.
 *
 * Lock-free, unlike `append()`: many concurrent readers is not the problem the
 * lock serialises. And tolerant of one specific shape a live writer leaves
 * behind — a final line with no trailing newline is a record another writer
 * has not finished flushing, skipped here rather than refused (see the module
 * header).
 */
export const readRun = ({ runDir } = {}) => {
  requireRunDir(runDir);
  requireRunDirExists(runDir);
  const { decisions, events, all } = readBoth(runDir, { tolerateUnterminatedTail: true });
  return { decisions, events, ended: all.some((record) => record.kind === RUN_END) };
};
