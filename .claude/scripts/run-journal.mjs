/**
 * The run journal — the machine-readable trace BEHIND the human `## Journal`.
 *
 * Gate verdicts go to `decisions.jsonl`, everything else to `events.jsonl`, both
 * append-only, both inside one per-run directory the caller hands over. It
 * answers *what did the run decide, and on what basis*; it never answers *was
 * that the right call*, and it replaces neither `## Journal` nor `PLAN.md`.
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
 * machines all produce timestamps that do not order. A counter the writer
 * increments cannot.
 *
 * **What this module deliberately does NOT own** (`AR3-25` owns it): the run-id
 * convention `.claude/runs/<run-id>/`, creating the directory, and rotation. It
 * is handed a `runDir` and uses it verbatim. Two owners of one convention
 * disagree the first time either changes, and a rotation scheme for files nobody
 * has accumulated is invention.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DECISIONS = 'decisions.jsonl';
const EVENTS = 'events.jsonl';

/** The end marker is an ordinary record; this is the field that makes it one. */
const RUN_END = 'run-end';

const requireRunDir = (runDir) => {
  if (typeof runDir !== 'string' || runDir.trim() === '') {
    throw new Error(
      'the run journal needs a runDir: the run directory is the caller\'s to choose ' +
        '(the convention is `.claude/runs/<run-id>/`), and this module deliberately ' +
        'invents none — a default would be a second owner of that convention.',
    );
  }
  return runDir;
};

const requireClock = (now) => {
  // 🔴 Reading the clock here instead would make every record untestable and
  // every replay a different file. The caller stamps; this module records.
  if (typeof now !== 'string' || now.trim() === '') {
    throw new Error(
      'the run journal needs `now` (an ISO timestamp): the clock is injected, never ' +
        'read here, which is what makes these records reproducible in a test.',
    );
  }
  return now;
};

/**
 * One journal file, parsed.
 *
 * An absent file is zero records — a run that has not written that kind yet is
 * the normal state. A file that exists and does not parse is NOT: folding it
 * into an empty list would silently shorten the trace, and a shorter trace of a
 * run is indistinguishable from a trace of a shorter run.
 */
const linesOf = (runDir, file) => {
  const path = join(runDir, file);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw new Error(
      `${path} exists but could not be read (${error?.code ?? 'unknown error'}), so this ` +
        'run\'s trace cannot be trusted to be complete. Refusing rather than reading ' +
        'the readable half as the whole.',
      { cause: error },
    );
  }

  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
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
 *     a lost record; a duplicate is two records claiming one position, which is
 *     what concurrent writers into one run directory produce.
 */
const readBoth = (runDir) => {
  const decisions = linesOf(runDir, DECISIONS);
  const events = linesOf(runDir, EVENTS);

  const refuse = (why) => {
    throw new Error(
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
 * Append one record, after the two questions every write has to answer first:
 * is this run already over, and what number is this record.
 *
 * Both answers come from the files themselves rather than from memory, because
 * every caller is its own short-lived process — the CLI that selects an item and
 * the gate that returns a verdict never share a variable.
 */
const append = (runDir, file, fields, now) => {
  requireRunDir(runDir);
  requireClock(now);

  const { all } = readBoth(runDir);

  // 🔴 A run whose end can be followed by more records has no end. The marker
  // exists to remove exactly one ambiguity — "did this run stop, or is it still
  // going" — and a late record puts it straight back.
  if (all.some((record) => record.kind === RUN_END)) {
    throw new Error(
      `the run in ${runDir} already carries its run-end marker, so nothing more may be ` +
        'recorded against it. A second record after the end would make "when did this ' +
        'run stop" have two answers and give the reader no way to pick one.',
    );
  }

  const record = { seq: all.length + 1, at: now, ...fields };
  appendFileSync(join(runDir, file), `${JSON.stringify(record)}\n`);
  return record;
};

/** A gate verdict: what was decided, and on what basis. */
export const recordDecision = ({ runDir, gate, verdict, why = null, now } = {}) =>
  append(runDir, DECISIONS, { gate, verdict, why }, now);

/** Everything that is not a gate verdict. */
export const recordEvent = ({ runDir, kind, data = null, now } = {}) =>
  append(runDir, EVENTS, { kind, data }, now);

/**
 * The run-end marker — shipped from day one, not added once someone is confused.
 *
 * It is a record and not a sentinel file on purpose: a touch-file would satisfy
 * "did it end" while carrying no time, no position in the sequence and no
 * reason, and the trace could not say when or why the run stopped. The scar is
 * live in this project's own plan — a journal entry reading *"stopped at —
 * checkpoint, still running"* left by a run that ended long ago.
 */
export const endRun = ({ runDir, stop, now } = {}) =>
  append(runDir, EVENTS, { kind: RUN_END, stop }, now);

/**
 * The run as a reader sees it: both files, and whether it ended.
 *
 * It refuses rather than returning a sequence it cannot vouch for — see
 * `readBoth`. That refusal IS the ordering invariant; documenting the ordering
 * and checking nothing is what this module was ported to stop doing.
 */
export const readRun = ({ runDir } = {}) => {
  requireRunDir(runDir);
  const { decisions, events, all } = readBoth(runDir);
  return { decisions, events, ended: all.some((record) => record.kind === RUN_END) };
};
