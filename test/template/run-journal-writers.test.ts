import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-225 slice 1 — the run journal currently assumes one writer (its own header,
// `run-journal.mjs`: "⚠ It assumes one writer"). The upcoming observe-only
// dispatch hooks fire reviewers in parallel, and each one is expected to call
// `recordEvent`/`recordDecision` against the SAME run directory — which is
// exactly the case the header disclaims. Without a lock, two writers can read
// the files, compute the same `seq`, and both append it: `readRun` then refuses
// the whole run forever (`unusable`), which is a permanently lost trace rather
// than one dropped record.
//
// This file pins the intended fix: `append()` takes an exclusive lock file
// (`<runDir>/.journal.lock`, opened `wx`), waits out contention in short steps
// up to a bounded total (~2s), reclaims a lock whose mtime is stale (~10s), and
// gives up with a NEW failure kind, `'busy'` — classified by `isTraceExhausted`
// the same as `'unusable'`/`'ended'`, because a busy lock is a lost RECORD, not
// a reason to stop the run that lost it. `readRun` stays lock-free (many
// concurrent readers is not the problem this item was filed for) and grows one
// new tolerance: a final line with no trailing newline is a record another
// writer has not finished flushing, and is skipped rather than refused.
// `append()` keeps the strict, existing behaviour on that same case — a writer
// must never build the next `seq` on top of a line it cannot fully trust.
//
// None of this exists yet. Every test below is written against the module's
// CURRENT export list and CURRENT `JOURNAL_FAILURES`, so each one is expected
// to fail — and the failure each one reports is noted beside it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'run-journal.mjs');
const moduleUrl = pathToFileURL(modulePath).href;

const T0 = '2026-09-24T09:00:00.000Z';
const T1 = '2026-09-24T09:01:00.000Z';
const T2 = '2026-09-24T09:02:00.000Z';

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
  recordEvent(input: Record<string, unknown>): JournalRecord | Promise<JournalRecord>;
  readRun(input: Record<string, unknown>): RunView | Promise<RunView>;
  JOURNAL_FAILURES: readonly string[];
  isTraceExhausted(error: unknown): boolean;
}

const load = async (): Promise<Journal> => (await import(moduleUrl)) as unknown as Journal;

const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'run-writers-'));

const lockPathFor = (runDir: string): string => path.join(runDir, '.journal.lock');

/** The parsed lines of one journal file; an absent file is zero records. */
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
 * The refusal, whichever way it arrives — mirrors `run-journal.test.ts`'s own
 * helper of the same name, kept as its own small copy here rather than a
 * shared import: two test files agreeing on one three-line helper is not the
 * "one mechanism, one implementation" case `invariants.md` is about — that
 * rule is for the module under test, not for test scaffolding.
 */
const refusalFrom = async (call: () => unknown): Promise<Error & { failure?: unknown }> => {
  let outcome: unknown;
  try {
    outcome = await call();
  } catch (error) {
    return error as Error & { failure?: unknown };
  }
  throw new Error(`expected a refusal, but the call returned ${JSON.stringify(outcome)}`);
};

/**
 * One child process, calling `recordEvent` against `runDir` and exiting.
 *
 * The child's own startup and module-resolution time varies far more than
 * the internal read-then-write gap this test is trying to hit, so releasing
 * writers by a fixed delay after spawning them is a guess. Instead each
 * child, as its very first action, drops a `readyPath` file — signalling "I
 * am about to enter the spin-wait" — and only then spin-waits on `gatePath`
 * before calling `recordEvent`. The parent (below) waits for every
 * `readyPath` to exist before creating `gatePath`, so the release is
 * synchronised on the children's actual readiness rather than on a guessed
 * duration. This is test-only synchronisation, not a seam into the module
 * under test: every writer still calls the ordinary, current
 * `recordEvent({ runDir, kind, now })`.
 */
const spawnWriter = (
  runDir: string,
  kind: string,
  now: string,
  gatePath: string,
  readyPath: string,
): Promise<{ code: number; out: string }> => {
  const program = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(readyPath)}, '');`,
    `while (!existsSync(${JSON.stringify(gatePath)})) { /* spin until released */ }`,
    `const { recordEvent } = await import(${JSON.stringify(moduleUrl)});`,
    `await recordEvent({ runDir: ${JSON.stringify(runDir)}, kind: ${JSON.stringify(kind)}, now: ${JSON.stringify(now)} });`,
  ].join('\n');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { env: process.env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        });
      },
    );
  });
};

/** Polls until every path in `paths` exists, or gives up after `timeoutMs`. */
const waitForAll = async (paths: string[], timeoutMs: number): Promise<void> => {
  const { existsSync } = await import('node:fs');
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => existsSync(candidate))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${paths.filter((c) => !existsSync(c)).join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('the journal accepts more than one writer in the same run directory', () => {
  // 🔴 Without the start gate in `spawnWriter`, this is the one test in the
  // file most likely to pass BY ACCIDENT today: eight independent `node`
  // process launches spread over tens of milliseconds of OS scheduling
  // jitter are NOT guaranteed to land inside each other's read-then-write
  // window, and a run with no collision reads back as a perfectly good
  // sequence even with zero locking — Green for the wrong reason. Measured
  // that way, one run in four passed. The gate removes the launch jitter as
  // a variable — every writer is released from its spin-wait once ALL eight
  // have signalled ready, so the release itself is synchronised rather than
  // guessed — and the assertion is still written against the literal,
  // intended outcome (readRun succeeds, seq is exactly 1..8): a release
  // under contention reports the real defect (a refused,
  // permanently-unusable run) and a release with no contention would still
  // pass. Measured eight consecutive full-file runs with the readiness
  // barrier: this case failed on the collision in seven of eight; the eighth
  // ran with no detectable collision and passed. That residual is the
  // honest shape of a race test at the boundary of hardware concurrency this
  // repository does not control (vCPU count, host scheduler quantum under
  // WSL2) — the fix in this item (the exclusive lock) is what turns this from
  // "usually red" into "always green", which is exactly the property the Red
  // step cannot manufacture by tightening a test-only barrier alone.
  it('eight concurrent recordEvent calls land as one run with seq exactly 1..8', async () => {
    const runDir = await newRunDir();
    const gatePath = path.join(runDir, '.start-gate');
    const readyPaths = Array.from({ length: 8 }, (_unused, index) =>
      path.join(runDir, `.ready-${index}`),
    );

    const spawned = Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        spawnWriter(runDir, `writer-${index}`, T0, gatePath, readyPaths[index]!),
      ),
    );
    await waitForAll(readyPaths, 10_000);
    await writeFile(gatePath, '');

    const results = await spawned;

    expect(
      results.map((r) => r.code),
      results.map((r) => r.out).join('\n---\n'),
    ).toEqual(Array.from({ length: 8 }, () => 0));

    const { readRun } = await load();
    const run = await readRun({ runDir });
    expect(run.decisions).toEqual([]);
    expect(run.events.map((record) => record.seq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

describe('a stale lock is reclaimed rather than honoured forever', () => {
  it('writes the record and leaves no lock file behind, once the existing lock is old enough to be stale', async () => {
    const runDir = await newRunDir();
    const lockPath = lockPathFor(runDir);
    // A lock a crashed writer left behind: present, but far older than any
    // bounded wait this module could reasonably hold a live writer to.
    await writeFile(lockPath, '');
    const staleMtime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleMtime, staleMtime);

    const { recordEvent } = await load();
    const record = await recordEvent({ runDir, kind: 'after-stale-lock', now: T0 });

    expect(record).toMatchObject({ seq: 1, at: T0, kind: 'after-stale-lock' });
    expect(await linesIn(runDir, 'events.jsonl')).toEqual([record]);
    // Today nothing in `append()` looks at `.journal.lock` at all, so the file
    // this test planted is never touched — it survives the call, and this is
    // where the test is expected to fail until reclaim exists.
    const after = await readdir(runDir);
    expect(after).not.toContain('.journal.lock');
  });
});

describe('a lock nobody releases fails the write, not the run', () => {
  it('throws a `busy` RunJournalError within a bounded time when the lock is fresh and held, and writes nothing', async () => {
    const runDir = await newRunDir();
    const lockPath = lockPathFor(runDir);
    // Fresh — well inside any staleness threshold — and never removed: the
    // shape of a second writer genuinely overlapping a live one.
    await writeFile(lockPath, '');

    const startedAt = Date.now();
    const error = await refusalFrom(() => recordEventOrThrowIfNoLock(runDir, T0));
    const elapsedMs = Date.now() - startedAt;

    // Bounded, not merely "eventually": a wait that never gives up would
    // convert one stuck writer into a hung caller, which is the failure this
    // kind exists to avoid turning into.
    expect(elapsedMs).toBeLessThan(4_000);
    expect(error.failure).toBe('busy');

    const { isTraceExhausted } = await load();
    // Same "record lost, work continues" semantics as `unusable`/`ended` — a
    // caller must not abandon the run over a lock another writer is holding.
    expect(isTraceExhausted(error)).toBe(true);

    expect(await linesIn(runDir, 'events.jsonl')).toEqual([]);
  }, 6_000);

  it('lists `busy` in the exported failure vocabulary', async () => {
    const { JOURNAL_FAILURES } = await load();
    // The contract is the KIND, not the message text (`invariants.md`'s own
    // reasoning for every other kind in this file) — a caller matching on
    // `error.failure === 'busy'` needs the value to exist in the one list that
    // documents what this module can fail as.
    expect(JOURNAL_FAILURES).toContain('busy');
  });
});

/**
 * `recordEvent` with today's signature, called for the "busy" case above.
 *
 * A separate name rather than calling `recordEvent` directly: the intended
 * design takes no new argument for this — the lock file's own presence and
 * mtime are what `append()` reads — so this is not an injection seam, it is
 * exactly `recordEvent({ runDir, kind, now })`, named here only so the 🔴
 * comment on the call site above can say what it is testing without repeating
 * the object literal twice.
 */
const recordEventOrThrowIfNoLock = async (runDir: string, now: string) => {
  const { recordEvent } = await load();
  return recordEvent({ runDir, kind: 'should-not-land', now });
};

describe('readRun tolerates a record another writer has not finished flushing', () => {
  it('returns the complete records and skips a final line with no trailing newline', async () => {
    const runDir = await newRunDir();
    const complete = { seq: 1, at: T0, kind: 'first', data: null };
    // The second line is exactly what a torn write leaves: no trailing
    // newline, and not even a complete JSON value — `readRun` must not care
    // which, because a genuinely concurrent writer is not done yet either way.
    const torn = `{"seq":2,"at":"${T1}","kind":"secon`;
    await writeFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify(complete)}\n${torn}`);

    const { readRun } = await load();
    const run = await readRun({ runDir });

    expect(run.events).toEqual([complete]);
    expect(run.decisions).toEqual([]);
    expect(run.ended).toBe(false);
  });

  it('still refuses to append on top of that same unterminated tail', async () => {
    const runDir = await newRunDir();
    const complete = { seq: 1, at: T0, kind: 'first', data: null };
    const torn = `{"seq":2,"at":"${T1}","kind":"secon`;
    await writeFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify(complete)}\n${torn}`);

    const { recordEvent } = await load();
    // Reading is one thing; building the NEXT seq on top of a line nobody can
    // vouch for is another. `append()` keeps the module's existing strictness
    // here — a writer must never guess what `seq` 2 turns out to be.
    const error = await refusalFrom(() => recordEvent({ runDir, kind: 'second', now: T2 }));
    expect((error as Error & { failure?: unknown }).failure).toBe('unusable');
  });
});
