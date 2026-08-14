import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR3-4: the run journal — the machine-readable trace BEHIND `## Journal`, not a
// replacement for it. Gate verdicts land in `decisions.jsonl`, everything else in
// `events.jsonl`, both append-only, both under one per-run directory.
//
// 🔴 Two riders ride inside this item and each has its own describe block:
//   SCRUM-390 — the run-end marker exists from day one. A run whose end can be
//     followed by more records has no end, so the marker also CLOSES the run.
//   SCRUM-87  — the journal's ordering invariant is ASSERTED, never documented.
//     A journal whose order the reader cannot trust is worse than none, so
//     `readRun` refuses rather than handing back a sequence it cannot vouch for.
//
// AR3-25 (still open, deliberately NOT built here) owns the run-id convention
// `.claude/runs/<run-id>/` and its gitignore. This module owns no run-id policy
// and no rotation: it is handed a `runDir` and uses it verbatim.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'run-journal.mjs');
const queueCli = path.join(scriptsDir, 'queue', 'index.mjs');

// Every child this file spawns gets an explicit environment, and the list of what
// leaves is the ONE the shipped scripts export — a hand-rolled second copy here is
// the defect `invariants.md` names ("one mechanism, one implementation"). Under
// pre-commit an inherited relative `GIT_INDEX_FILE` is a live scar in this repo.
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'git-env.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

/** Every argument object this module takes is a bag; the refusal tests omit keys. */
type Input = Record<string, unknown>;

interface JournalRecord {
  seq: number;
  at: string;
  [key: string]: unknown;
}

interface RunView {
  decisions: JournalRecord[];
  events: JournalRecord[];
  ended: boolean;
}

interface Journal {
  recordDecision(input: Input): JournalRecord | Promise<JournalRecord>;
  recordEvent(input: Input): JournalRecord | Promise<JournalRecord>;
  endRun(input: Input): JournalRecord | Promise<JournalRecord>;
  readRun(input: Input): RunView | Promise<RunView>;
}

/**
 * Every call site below `await`s the result, so nothing here pins the module to a
 * synchronous or an asynchronous implementation — that choice is the Green step's,
 * and a test that decided it would be pinning a detail this item never stated.
 */
const load = async (): Promise<Journal & Record<string, unknown>> =>
  (await import(pathToFileURL(modulePath).href)) as Journal & Record<string, unknown>;

const T0 = '2026-08-14T09:00:00.000Z';
const T1 = '2026-08-14T09:01:00.000Z';
const T2 = '2026-08-14T09:02:00.000Z';
const T3 = '2026-08-14T09:03:00.000Z';

/** A run directory that already exists — AR3-25 makes them, this module does not. */
const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'run-'));

/** The parsed lines of one journal file; an absent file is zero records, not an error. */
const linesIn = async (runDir: string, file: string): Promise<JournalRecord[]> => {
  let raw: string;
  try {
    raw = await readFile(path.join(runDir, file), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalRecord);
};

/**
 * The refusal, whichever way it arrives. A sync `throw` and a rejected promise are
 * both a refusal; "returned a value" is not, and is reported as itself rather than
 * as a confusing assertion about `undefined`.
 */
const refusalFrom = async (call: () => unknown): Promise<Error> => {
  let outcome: unknown;
  try {
    outcome = await call();
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected a refusal, but the call returned ${JSON.stringify(outcome)}`);
};

describe('the two files carry two different kinds of record', () => {
  it('writes a gate verdict to the decisions file and nowhere else', async () => {
    const { recordDecision } = await load();
    const runDir = await newRunDir();

    const record = await recordDecision({
      runDir,
      gate: 'code-reviewer',
      verdict: 'SHIP',
      why: 'no blocking findings',
      now: T0,
    });

    expect(await linesIn(runDir, 'decisions.jsonl')).toEqual([record]);
    expect(await linesIn(runDir, 'events.jsonl')).toEqual([]);
    expect(record).toMatchObject({ gate: 'code-reviewer', verdict: 'SHIP', seq: 1, at: T0 });
  });

  it('writes everything that is not a gate verdict to the events file and nowhere else', async () => {
    const { recordEvent } = await load();
    const runDir = await newRunDir();

    const record = await recordEvent({
      runDir,
      kind: 'branch-created',
      data: { branch: 'feat/ar3-4' },
      now: T0,
    });

    expect(await linesIn(runDir, 'events.jsonl')).toEqual([record]);
    expect(await linesIn(runDir, 'decisions.jsonl')).toEqual([]);
    expect(record).toMatchObject({ kind: 'branch-created', seq: 1, at: T0 });
  });
});

describe('the journal is append-only', () => {
  it('keeps the first record byte-identical when a second one lands', async () => {
    const { recordEvent } = await load();
    const runDir = await newRunDir();
    const file = path.join(runDir, 'events.jsonl');

    await recordEvent({ runDir, kind: 'task-taken', data: { id: 'AR3-4' }, now: T0 });
    const afterFirst = await readFile(file, 'utf8');

    await recordEvent({ runDir, kind: 'test-red', data: null, now: T1 });
    const afterSecond = await readFile(file, 'utf8');

    // Not "both records are present" — the first record's BYTES are untouched. A
    // rewrite that happened to reproduce the same two lines would still be a file
    // this run can no longer prove it did not edit.
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);

    const records = await linesIn(runDir, 'events.jsonl');
    expect(records.map((r) => r.kind)).toEqual(['task-taken', 'test-red']);
  });
});

describe('the run-end marker exists from day one', () => {
  it('reports a run with no marker as not ended', async () => {
    const { recordDecision, readRun } = await load();
    const runDir = await newRunDir();

    await recordDecision({ runDir, gate: 'item-selection', verdict: 'taken', now: T0 });

    expect((await readRun({ runDir })).ended).toBe(false);
  });

  it('reports a run as ended once the marker is written', async () => {
    const { endRun, readRun } = await load();
    const runDir = await newRunDir();

    await endRun({ runDir, stop: 'queue-empty', now: T0 });

    expect((await readRun({ runDir })).ended).toBe(true);
  });

  it('records the end as a journal record with its own place in the sequence', async () => {
    const { recordEvent, endRun } = await load();
    const runDir = await newRunDir();
    const before = await readdir(runDir);

    await recordEvent({ runDir, kind: 'task-closed', data: { id: 'AR3-4' }, now: T0 });
    const marker = await endRun({ runDir, stop: 'queue-empty', now: T1 });

    // 🔴 A real record, not a sentinel file. A `.ended` touch-file would satisfy
    // `ended: true` while carrying no time, no sequence position and no reason —
    // and the trace would be unable to say WHEN or WHY the run stopped.
    expect(marker).toMatchObject({ seq: 2, at: T1, stop: 'queue-empty' });

    const written = [
      ...(await linesIn(runDir, 'decisions.jsonl')),
      ...(await linesIn(runDir, 'events.jsonl')),
    ];
    expect(written).toContainEqual(marker);

    // and no third file appeared to carry it. WHICH of the two files holds the
    // marker is deliberately left open — the item names two files and a marker,
    // not a third one.
    const after = await readdir(runDir);
    expect(before).toEqual([]);
    expect(after.filter((name) => !['decisions.jsonl', 'events.jsonl'].includes(name))).toEqual([]);
  });

  it('refuses a gate verdict recorded after the run ended', async () => {
    const { recordDecision, endRun } = await load();
    const runDir = await newRunDir();

    await endRun({ runDir, stop: 'queue-empty', now: T0 });

    const error = await refusalFrom(() =>
      recordDecision({ runDir, gate: 'code-reviewer', verdict: 'SHIP', now: T1 }),
    );
    expect(error.message).toMatch(/run[- ]end|ended|marker/i);
  });

  it('refuses an event recorded after the run ended', async () => {
    const { recordEvent, endRun } = await load();
    const runDir = await newRunDir();

    await endRun({ runDir, stop: 'kill-switch', now: T0 });

    const error = await refusalFrom(() => recordEvent({ runDir, kind: 'late', now: T1 }));
    expect(error.message).toMatch(/run[- ]end|ended|marker/i);
  });

  it('leaves the journal untouched when it refuses a record after the end', async () => {
    const { recordEvent, endRun } = await load();
    const runDir = await newRunDir();

    await endRun({ runDir, stop: 'queue-empty', now: T0 });
    const files = await readdir(runDir);
    const before = await Promise.all(files.map((f) => readFile(path.join(runDir, f), 'utf8')));

    await refusalFrom(() => recordEvent({ runDir, kind: 'late', now: T1 }));

    expect(await readdir(runDir)).toEqual(files);
    expect(await Promise.all(files.map((f) => readFile(path.join(runDir, f), 'utf8')))).toEqual(
      before,
    );
  });

  it('refuses to end a run that has already ended', async () => {
    const { endRun } = await load();
    const runDir = await newRunDir();

    await endRun({ runDir, stop: 'queue-empty', now: T0 });

    // The marker is itself a record, so the rule above covers it: a second end is
    // a second answer to "when did this run stop", and a reader cannot pick one.
    const error = await refusalFrom(() => endRun({ runDir, stop: 'budget', now: T1 }));
    expect(error.message).toMatch(/run[- ]end|ended|marker/i);
  });
});

describe('the ordering is asserted, never merely documented', () => {
  /** A hand-written journal file — the shape a crashed writer or an edit leaves. */
  const handWrite = (runDir: string, file: string, records: Array<Record<string, unknown>>) =>
    writeFile(
      path.join(runDir, file),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

  it('refuses a run whose sequence has a gap', async () => {
    const { readRun } = await load();
    const runDir = await newRunDir();
    await handWrite(runDir, 'decisions.jsonl', [
      { seq: 1, at: T0, gate: 'item-selection', verdict: 'taken' },
      { seq: 3, at: T2, gate: 'code-reviewer', verdict: 'SHIP' },
    ]);

    const error = await refusalFrom(() => readRun({ runDir }));
    // The reader is told the ordering is the problem — a missing record means the
    // remaining ones are a trace of something else, not a shorter trace of this run.
    expect(error.message).toMatch(/order|sequence/i);
    expect(error.message).toMatch(/trust/i);
  });

  it('refuses a run whose records are out of order', async () => {
    const { readRun } = await load();
    const runDir = await newRunDir();
    // No gap here — 1 and 2 are both present. Only the ORDER is wrong, which is
    // exactly the case a reader cannot detect by eye and would read newest-first.
    await handWrite(runDir, 'decisions.jsonl', [
      { seq: 2, at: T1, gate: 'code-reviewer', verdict: 'SHIP' },
      { seq: 1, at: T0, gate: 'item-selection', verdict: 'taken' },
    ]);

    const error = await refusalFrom(() => readRun({ runDir }));
    expect(error.message).toMatch(/order|sequence/i);
    expect(error.message).toMatch(/trust/i);
  });

  it('hands back the records of a run whose sequence is intact', async () => {
    const { recordDecision, recordEvent, readRun } = await load();
    const runDir = await newRunDir();

    const decision = await recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken',
      now: T0,
    });
    const event = await recordEvent({ runDir, kind: 'branch-created', now: T1 });

    const run = await readRun({ runDir });
    expect(run.decisions).toEqual([decision]);
    expect(run.events).toEqual([event]);
    expect(run.ended).toBe(false);
  });
});

describe('the sequence counter belongs to the run, not to a file', () => {
  it('numbers interleaved decisions and events 1, 2, 3, 4 across both files', async () => {
    const { recordDecision, recordEvent } = await load();
    const runDir = await newRunDir();

    await recordDecision({ runDir, gate: 'item-selection', verdict: 'taken', now: T0 });
    await recordEvent({ runDir, kind: 'branch-created', now: T1 });
    await recordDecision({ runDir, gate: 'code-reviewer', verdict: 'SHIP', now: T2 });
    await recordEvent({ runDir, kind: 'merged', now: T3 });

    // 🔴 Per-file counters would give 1,2 in each — two records claiming to be
    // first, and no way to interleave the two files back into what happened.
    expect((await linesIn(runDir, 'decisions.jsonl')).map((r) => r.seq)).toEqual([1, 3]);
    expect((await linesIn(runDir, 'events.jsonl')).map((r) => r.seq)).toEqual([2, 4]);
  });
});

describe('the clock is injected, never read', () => {
  it('stamps each record with the value it was given', async () => {
    const { recordDecision, recordEvent } = await load();
    const runDir = await newRunDir();

    const decision = await recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken',
      now: T0,
    });
    const event = await recordEvent({ runDir, kind: 'branch-created', now: T2 });

    expect(decision.at).toBe(T0);
    expect(event.at).toBe(T2);
  });

  it('refuses to record without a clock rather than reaching for one', async () => {
    const { recordDecision, recordEvent, endRun } = await load();
    const runDir = await newRunDir();

    for (const call of [
      () => recordDecision({ runDir, gate: 'code-reviewer', verdict: 'SHIP' }),
      () => recordEvent({ runDir, kind: 'branch-created' }),
      () => endRun({ runDir, stop: 'queue-empty' }),
    ]) {
      const error = await refusalFrom(call);
      expect(error.message).toMatch(/now|clock/i);
    }
  });

  it('names no clock of its own anywhere in the module', async () => {
    const source = await readFile(modulePath, 'utf8');
    // One forward pass, both shapes at once. The literal call counts even inside a
    // comment: "the clock is injected" is the sentence to write, and a guard that
    // allowed the call in prose would have to parse the file to know the difference.
    const clock = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/g;
    expect([...source.matchAll(clock)].map((match) => match[0])).toEqual([]);
  });
});

describe('the module owns no run-id policy and no rotation', () => {
  it('exports the four record operations and nothing that could invent a run', async () => {
    const module = await load();
    const exported = Object.keys(module).sort();

    expect(exported).toEqual(
      expect.arrayContaining(['endRun', 'readRun', 'recordDecision', 'recordEvent']),
    );
    // AR3-25 owns `.claude/runs/<run-id>/`. An export here that minted, derived or
    // rotated an id would be a second owner of that convention, and the two would
    // disagree the first time either one changed.
    for (const name of exported) {
      expect(name, `${name} looks like run-id or rotation policy`).not.toMatch(
        /run.?id|rotat|prune|newrun|createrun|nextrun|currentrun|runsdir/i,
      );
    }
  });

  it('refuses to record without being told which run directory to write to', async () => {
    const { recordDecision, recordEvent, endRun, readRun } = await load();

    for (const call of [
      () => recordDecision({ gate: 'code-reviewer', verdict: 'SHIP', now: T0 }),
      () => recordEvent({ kind: 'branch-created', now: T0 }),
      () => endRun({ stop: 'queue-empty', now: T0 }),
      () => readRun({}),
    ]) {
      const error = await refusalFrom(call);
      expect(error.message).toMatch(/rundir|run directory/i);
    }
  });

  it('writes into the directory it was handed, without a subdirectory of its own', async () => {
    const { recordDecision, endRun } = await load();
    const runDir = await newRunDir();

    await recordDecision({ runDir, gate: 'item-selection', verdict: 'taken', now: T0 });
    await endRun({ runDir, stop: 'queue-empty', now: T1 });

    const entries = await readdir(runDir, { withFileTypes: true });
    expect(entries.some((entry) => entry.isDirectory())).toBe(false);
    // Everything this module wrote is one of its two files, sitting directly in
    // the directory it was handed — no `<runDir>/<something-it-invented>/`.
    expect(
      entries
        .map((entry) => entry.name)
        .filter((name) => !['decisions.jsonl', 'events.jsonl'].includes(name)),
    ).toEqual([]);
    expect(entries).not.toHaveLength(0);
  });
});

// A journal nothing calls records nothing. This is the caller the item requires,
// and it is also where the boundary above is paid for: the CLI declares the run
// directory, the module writes into it, and neither invents one.
describe('the queue CLI records its selection when a run directory is declared', () => {
  const run = (
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [queueCli, ...args], { cwd, env }, (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        });
      });
    });

  const project = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'run-caller-'));
    await writeFile(
      path.join(dir, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- add a route\n\n## Journal\n',
    );
    return dir;
  };

  it('writes one item-selection decision into the declared run directory', async () => {
    const dir = await project();
    const runDir = await newRunDir();

    const result = await run(['next', '--json'], dir, {
      ...withoutGitLocation(),
      RIG_RUN_DIR: runDir,
    });

    expect(result.code, result.out).toBe(0);
    const decisions = await linesIn(runDir, 'decisions.jsonl');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ gate: 'item-selection', seq: 1 });
  });

  it('writes nothing at all when no run directory is declared', async () => {
    const dir = await project();
    const env = withoutGitLocation();
    delete env.RIG_RUN_DIR;

    const result = await run(['next', '--json'], dir, env);

    expect(result.code, result.out).toBe(0);
    // Not "no journal in the temp project" alone: the CLI resolves a project root
    // from its OWN location, so a default run directory would land in the template
    // tree — a session's trace committed into the thing this repo ships.
    const inProject = await readdir(dir, { recursive: true });
    expect(inProject.filter((entry) => entry.endsWith('.jsonl'))).toEqual([]);
    await expect(stat(path.join(universal, '.claude', 'runs'))).rejects.toThrow();
  });
});
