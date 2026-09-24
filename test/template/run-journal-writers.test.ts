import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { modeBitsDeny, skipUnless } from '../helpers/env.js';

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
    const after = await readdir(runDir);
    expect(after).not.toContain('.journal.lock');
  });
});

// code-reviewer r1 (fa745a0): "stat-then-rm reclaim and path-only release: two
// writers seeing a stale lock both hold it; 19 of 30 stress runs broke
// readRun." `acquireLock`'s reclaim is stat-the-path, then (after a gap where
// another process runs the same steps) rm-the-path and retry — nothing ties
// the stat, the rm, or the eventual open to one process's OWN attempt. Two
// writers that both see the same stale lock can interleave as: A removes the
// original stale file and opens a fresh one of its own; B, already committed
// to reclaiming, then removes THAT fresh file (by path, not by any check that
// it is the one B saw) and opens its own — both now believe they hold the one
// lock `append()` was supposed to make exclusive, and the same path-only
// unlink in `releaseLock` repeats the mistake on the way out. This is also
// checklist item 6's ownership defect, not a second one next to it: a release
// or a reclaim that never checks whose lock is on disk is exactly "a writer
// whose lock was taken over removes another writer's lock" — the two
// blockers describe one gap in the same two functions. There is no seam in
// today's module to plant a foreign owner's token directly (the lock file
// carries no content to distinguish writers), so this stress is the only
// test in this file for that gap; it is written to make the interleaving
// likely rather than merely possible.
describe('a stale lock reclaimed by two writers at once must not double-admit', () => {
  it('runs the eight-writer race against a pre-planted stale lock repeatedly, and readRun never breaks', async () => {
    // Kept well under this project's testTimeout: 15_000 — measured at
    // 5.0-6.6s total for all 20 iterations on this host (5 runs), leaving
    // comfortable headroom. The race itself is probabilistic, not guaranteed
    // per iteration — measured at 1 of 20, 2 of 20 across 5 runs on this host,
    // one run clean — so the count below is chosen to make a genuine
    // interleaving LIKELY across the run, not to guarantee one every time; a
    // single clean run is a property of the race, not a sign the fixture is
    // wrong. If a slower host needs more headroom, the number to lower is this
    // one, not the budget.
    const iterations = 20;
    const failures: string[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const runDir = await newRunDir();
      const lockPath = lockPathFor(runDir);
      await writeFile(lockPath, '');
      const staleMtime = new Date(Date.now() - 60_000);
      await utimes(lockPath, staleMtime, staleMtime);

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

      if (results.some((result) => result.code !== 0)) {
        failures.push(
          `iteration ${iteration}: a writer process exited nonzero\n` +
            results.map((result) => result.out).join('\n---\n'),
        );
        continue;
      }

      const wanted = Array.from({ length: 8 }, (_unused, index) => index + 1);
      try {
        const { readRun } = await load();
        const run = await readRun({ runDir });
        const seqs = run.events.map((record) => record.seq).sort((a, b) => a - b);
        if (JSON.stringify(seqs) !== JSON.stringify(wanted)) {
          failures.push(`iteration ${iteration}: seq ${JSON.stringify(seqs)}, wanted 1..8`);
        }
      } catch (error) {
        failures.push(`iteration ${iteration}: readRun refused — ${(error as Error).message}`);
      }
    }

    // Every iteration runs to completion rather than stopping at the first
    // collision, so the failure COUNT is itself evidence — the same shape the
    // reviewer measured against this exact fixture (19 of 30 runs unusable).
    expect(failures, `${failures.length} of ${iterations} iterations broke readRun`).toEqual([]);
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

// code-reviewer's advisory list, promoted: "EACCES/EPERM on a non-writable dir
// read as contention". `acquireLock`'s `openSync(lockPath, 'wx')` fails with
// EACCES when the DIRECTORY cannot be written to, not only when a lock file is
// genuinely held — and today's `contended` check treats EACCES exactly like
// EEXIST. With no lock file ever planted here, `statSync(lockPath)` then finds
// nothing to reclaim, so the loop just keeps retrying the doomed open until
// `LOCK_WAIT_MS` elapses and reports `'busy'` — "another writer is holding it",
// about a directory that never had one. `'busy'` also tells a caller the record
// is merely lost and a later retry might land; an unwritable directory does not
// become writable by waiting, so that is the wrong instruction as well as the
// wrong word.
describe('a run directory with no write permission is not "busy"', () => {
  beforeEach((ctx) => skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason));

  const rootless = process.getuid === undefined || process.getuid() !== 0;

  it.runIf(rootless)(
    'fails fast as a non-busy refusal when the directory cannot even hold a lock file',
    async () => {
      const runDir = await newRunDir();
      await chmod(runDir, 0o555);

      const startedAt = Date.now();
      const error = await refusalFrom(() => recordEventOrThrowIfNoLock(runDir, T0));
      const elapsedMs = Date.now() - startedAt;

      await chmod(runDir, 0o755);

      // Not `'busy'`: no lock file was ever planted, so there is no other
      // writer to report as holding one.
      expect((error as Error & { failure?: unknown }).failure).not.toBe('busy');
      // And fast — today's misclassification spins out the whole LOCK_WAIT_MS
      // (~2s) bound before giving up; a correct refusal has no wait to do at
      // all, since the directory was never going to become writable.
      expect(elapsedMs).toBeLessThan(500);
    },
  );
});
