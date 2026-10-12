// RP-355 slice A: `.claude/scripts/lib/evidence-query.mjs` — item occurrences
// read out of run journals, and the first two outcome signals computed over a
// named run set — plus `release-evidence.mjs --outcome`, which prints them.
//
// Every expected number below is a literal counted by hand from the fixture
// the test builds; none is computed by calling the module.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const evidenceScript = path.join(scriptsDir, 'release-evidence.mjs');
const queryModule = path.join(scriptsDir, 'lib', 'evidence-query.mjs');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const { SIGNALS } = (await import(
  pathToFileURL(path.join(scriptsDir, 'lib', 'outcome-signals.mjs')).href
)) as { SIGNALS: ReadonlyArray<{ name: string; signalVersion: number }> };

const { readRuns } = (await import(
  pathToFileURL(path.join(scriptsDir, 'revalidation-report.mjs')).href
)) as { readRuns: (runsDir: string) => RunEntry[] };

interface JournalRecord {
  seq: number;
  at: string;
  kind?: string;
  gate?: string;
  verdict?: string;
  headSha?: string;
  reviewers?: string[];
  data?: unknown;
  [key: string]: unknown;
}

interface RunEntry {
  run: string;
  decisions?: JournalRecord[];
  events?: JournalRecord[];
  error?: string;
}

const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
  recordDecision: (input: {
    runDir: string;
    gate: string;
    verdict: string;
    headSha?: string;
    reviewers?: string[];
    now: string;
  }) => JournalRecord;
  recordEvent: (input: {
    runDir: string;
    kind: string;
    data?: unknown;
    now: string;
  }) => JournalRecord;
  readRun: (input: { runDir: string }) => { decisions: JournalRecord[]; events: JournalRecord[] };
};

interface Occurrence {
  run: string;
  ticket: string;
  seq: number;
  at: string;
  records: JournalRecord[];
}

interface VerdictCounts {
  SHIP: number;
  HOLD: number;
  other: number;
}

interface Signal {
  name: string;
  signalVersion: number;
  eligible: number;
  observed: number;
  unknown: number;
  result: unknown;
}

interface Outcome {
  schemaVersion: number;
  runs: { read: string[]; skipped: Array<{ run: string; why: string }> };
  signals: Signal[];
}

let query: {
  itemOccurrences: (entry: RunEntry) => Occurrence[];
  outcomeOf: (input: { runs: RunEntry[] }) => Outcome;
} | null = null;
try {
  query = (await import(pathToFileURL(queryModule).href)) as typeof query;
} catch {
  query = null;
}

const mod = () => {
  expect(query, 'lib/evidence-query.mjs does not exist yet').not.toBeNull();
  return query!;
};

const runsRoot = () => mkdtemp(path.join(tmpdir(), 'evidence-query-runs-'));

/** A run directory plus writers that stamp strictly increasing times. */
const newRun = async (runsDir: string, name: string, startMinute = 0) => {
  const runDir = path.join(runsDir, name);
  await mkdir(runDir, { recursive: true });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1, 0, startMinute, ++tick)).toISOString();
  const dec = (
    gate: string,
    verdict: string,
    extra: { headSha?: string; reviewers?: string[] } = {},
  ) => journal.recordDecision({ runDir, gate, verdict, ...extra, now: now() });
  const ev = (kind: string, data: unknown = null) =>
    journal.recordEvent({ runDir, kind, data, now: now() });
  return {
    runDir,
    dec,
    ev,
    take: (ticket: string) => dec('item-selection', `taken ${ticket}`),
    stop: () => dec('item-selection', 'stopped empty-queue'),
    route: (lane: string, reviewers: string[]) =>
      dec(`review-routing:${lane}`, 'route', { reviewers }),
    fanOut: (headSha: string | undefined, reviewers: string[]) =>
      dec(
        'reviewer-fan-out',
        'launched',
        headSha === undefined ? { reviewers } : { headSha, reviewers },
      ),
    verdict: (reviewer: string, word: string, headSha: string) => dec(reviewer, word, { headSha }),
    closed: (ticket: string) => ev('item-closed', { id: ticket }),
    entry: (): RunEntry => {
      const { decisions, events } = journal.readRun({ runDir });
      return { run: name, decisions, events };
    },
  };
};

const signal = (outcome: Outcome, name: string): Signal => {
  const found = outcome.signals.find((s) => s.name === name);
  expect(found, `no ${name} signal in ${JSON.stringify(outcome.signals)}`).toBeDefined();
  return found!;
};

/** Every `<run>/<file>` below `runsDir` — the fixture is exactly two levels deep. */
const snapshot = async (runsDir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const run of await readdir(runsDir)) {
    for (const file of await readdir(path.join(runsDir, run))) {
      out[`${run}/${file}`] = await readFile(path.join(runsDir, run, file), 'utf8');
    }
  }
  return out;
};

const cli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [evidenceScript, ...args],
      { cwd: repoRoot, env: withoutGitLocation() },
      (error, stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });

describe('evidence-query itemOccurrences', () => {
  it('opens one occurrence per taken selection and closes it at the next selection', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.ev('note', { before: 'any selection' }); // seq 1
    r.take('RP-1'); // seq 2
    r.route('model', ['code-reviewer']); // seq 3
    r.ev('note', { inside: 'RP-1' }); // seq 4
    r.stop(); // seq 5
    r.ev('note', { after: 'stop' }); // seq 6
    r.take('RP-2'); // seq 7
    r.fanOut('aaa', ['code-reviewer']); // seq 8
    r.ev('note', { inside: 'RP-2' }); // seq 9

    const occurrences = mod().itemOccurrences(r.entry());
    expect(occurrences.map((o) => [o.run, o.ticket, o.seq])).toEqual([
      ['run-a', 'RP-1', 2],
      ['run-a', 'RP-2', 7],
    ]);
    expect(occurrences[0]!.at).toBe('2026-10-01T00:00:02.000Z');
    expect(occurrences[0]!.records.map((rec) => rec.seq)).toEqual([3, 4]);
    expect(occurrences[1]!.records.map((rec) => rec.seq)).toEqual([8, 9]);
    expect(occurrences[1]!.records[0]!.gate).toBe('reviewer-fan-out');
    expect(occurrences[1]!.records[1]!.kind).toBe('note');
  });
});

describe('evidence-query outcomeOf: first-shipping-verdict', () => {
  it('first-shipping-verdict reads the first head, with the reviewer set of its last fan-out', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    // RP-10: the re-recorded fan-out at head aaa adds security-scanner, which
    // HOLDs; the later head bbb ships clean and must not be read.
    r.take('RP-10');
    r.route('model', ['code-reviewer']);
    r.fanOut('aaa', ['code-reviewer']);
    r.fanOut('aaa', ['code-reviewer', 'security-scanner']);
    r.verdict('code-reviewer', 'SHIP', 'aaa');
    r.verdict('security-scanner', 'HOLD', 'aaa');
    r.fanOut('bbb', ['code-reviewer', 'security-scanner']);
    r.verdict('code-reviewer', 'SHIP', 'bbb');
    r.verdict('security-scanner', 'SHIP', 'bbb');
    // RP-11: SHIP at its first head.
    r.take('RP-11');
    r.route('model', ['code-reviewer']);
    r.fanOut('ccc', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'ccc');
    // RP-12: neither all SHIP nor any HOLD.
    r.take('RP-12');
    r.route('model', ['code-reviewer', 'prose-reviewer']);
    r.fanOut('ddd', ['code-reviewer', 'prose-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'ddd');
    r.verdict('prose-reviewer', 'incomplete', 'ddd');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'first-shipping-verdict');
    expect([s.eligible, s.observed, s.unknown]).toEqual([3, 3, 0]);
    expect(s.result).toEqual({
      SHIP: 1,
      HOLD: 1,
      other: 1,
      lanes: { model: 3 },
      byLane: { model: { SHIP: 1, HOLD: 1, other: 1 } },
    });
  });

  it('a reviewer missing at the first head makes the occurrence unknown, not HOLD', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    // RP-20: security-scanner answered only at a later head.
    r.take('RP-20');
    r.route('model', ['code-reviewer', 'security-scanner']);
    r.fanOut('eee', ['code-reviewer', 'security-scanner']);
    r.verdict('code-reviewer', 'HOLD', 'eee');
    r.fanOut('fff', ['code-reviewer', 'security-scanner']);
    r.verdict('code-reviewer', 'SHIP', 'fff');
    r.verdict('security-scanner', 'SHIP', 'fff');
    // RP-21: the fan-out names no head.
    r.take('RP-21');
    r.route('model', ['code-reviewer']);
    r.fanOut(undefined, ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'ggg');
    // RP-22: no fan-out at all — not eligible.
    r.take('RP-22');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'first-shipping-verdict');
    expect([s.eligible, s.observed, s.unknown]).toEqual([2, 0, 2]);
    const result = s.result as VerdictCounts & { byLane: Record<string, VerdictCounts> };
    expect([result.SHIP, result.HOLD, result.other]).toEqual([0, 0, 0]);
    for (const lane of Object.values(result.byLane)) {
      expect([lane.SHIP, lane.HOLD, lane.other]).toEqual([0, 0, 0]);
    }
  });

  it('groups first verdicts by the routed lane', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.take('RP-30');
    r.route('model', ['code-reviewer']);
    r.fanOut('h30', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'h30');
    // RP-31: a declined lane is recorded before the one taken.
    r.take('RP-31');
    r.dec('review-routing:deterministic', 'decline');
    r.route('fast-path', ['prose-reviewer']);
    r.fanOut('h31', ['prose-reviewer']);
    r.verdict('prose-reviewer', 'HOLD', 'h31');
    r.take('RP-32');
    r.route('model', ['code-reviewer']);
    r.fanOut('h32', ['code-reviewer']);
    r.verdict('code-reviewer', 'HOLD', 'h32');
    // RP-33: no routing decision in the window.
    r.take('RP-33');
    r.fanOut('h33', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'h33');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'first-shipping-verdict');
    expect([s.eligible, s.observed, s.unknown]).toEqual([4, 4, 0]);
    expect(s.result).toEqual({
      SHIP: 2,
      HOLD: 2,
      other: 0,
      lanes: { model: 2, 'fast-path': 1, unknown: 1 },
      byLane: {
        model: { SHIP: 1, HOLD: 1, other: 0 },
        'fast-path': { SHIP: 0, HOLD: 1, other: 0 },
        unknown: { SHIP: 1, HOLD: 0, other: 0 },
      },
    });
  });

  it('shows a deterministic lane with an empty fan-out in lanes, outside the verdict population', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.take('RP-5');
    r.route('deterministic', []);
    r.fanOut('d1', []);

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'first-shipping-verdict');
    expect([s.eligible, s.observed, s.unknown]).toEqual([0, 0, 0]);
    const result = s.result as { lanes: Record<string, number>; byLane: Record<string, unknown> };
    expect(result.lanes).toEqual({ deterministic: 1 });
    expect(result.byLane).toEqual({});
  });

  it('counts a lane named __proto__ under its own key and leaves Object.prototype alone', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.take('RP-35');
    r.route('__proto__', ['code-reviewer']);
    r.fanOut('h35', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'h35');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'first-shipping-verdict');
    const json = JSON.stringify(s.result);
    expect(json).toContain('"byLane":{"__proto__":{"SHIP":1,"HOLD":0,"other":0}}');
    expect(json).toContain('"lanes":{"__proto__":1}');
    expect(({} as Record<string, unknown>).SHIP).toBeUndefined();
  });

  it('reads a non-string gate as no routing, not a crash', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.take('RP-37');
    r.fanOut('h37', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'h37');
    const entry = r.entry();
    entry.decisions!.push({
      seq: 99,
      at: '2026-10-01T00:01:00.000Z',
      gate: 7 as unknown as string,
      verdict: 'route',
    });

    const s = signal(mod().outcomeOf({ runs: [entry] }), 'first-shipping-verdict');
    expect((s.result as { lanes: Record<string, number> }).lanes).toEqual({ unknown: 1 });
  });

  it('reads the first answer at the first head: HOLD then SHIP at that head is HOLD', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.take('RP-13');
    r.route('model', ['code-reviewer']);
    r.fanOut('h13', ['code-reviewer']);
    r.verdict('code-reviewer', 'HOLD', 'h13');
    r.verdict('code-reviewer', 'SHIP', 'h13');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'first-shipping-verdict');
    expect([s.eligible, s.observed, s.unknown]).toEqual([1, 1, 0]);
    const result = s.result as VerdictCounts & { byLane: Record<string, VerdictCounts> };
    expect([result.SHIP, result.HOLD, result.other]).toEqual([0, 1, 0]);
    expect(result.byLane).toEqual({ model: { SHIP: 0, HOLD: 1, other: 0 } });
  });
});

describe('evidence-query outcomeOf: gate-rounds', () => {
  it('gate-rounds counts distinct fan-out heads and never reports 0 for an item without fan-out', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    // RP-40: heads h1, h1 (re-recorded), h2 — two rounds.
    r.take('RP-40');
    r.fanOut('h1', ['code-reviewer']);
    r.fanOut('h1', ['code-reviewer', 'security-scanner']);
    r.fanOut('h2', ['code-reviewer']);
    r.closed('RP-40');
    r.take('RP-41');
    r.fanOut('h3', ['code-reviewer']);
    r.closed('RP-41');
    // RP-42: closed with no fan-out.
    r.take('RP-42');
    r.closed('RP-42');
    r.take('RP-43');
    r.fanOut('h4', ['code-reviewer']);
    r.fanOut('h5', ['code-reviewer']);
    r.closed('RP-43');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'gate-rounds');
    expect([s.eligible, s.observed, s.unknown]).toEqual([4, 3, 1]);
    expect(s.result).toEqual({ distribution: { '1': 1, '2': 2 } });
  });

  it('an occurrence without item-closed is unknown for gate-rounds', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.closed('RP-50'); // before RP-50 is taken — outside its window
    r.take('RP-50');
    r.fanOut('h7', ['code-reviewer']);
    r.take('RP-51');
    r.fanOut('h8', ['code-reviewer']);
    r.closed('RP-51');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'gate-rounds');
    expect([s.eligible, s.observed, s.unknown]).toEqual([2, 1, 1]);
    expect(s.result).toEqual({ distribution: { '1': 1 } });
  });
});

describe('evidence-query outcomeOf: an item across runs', () => {
  it('joins an item taken again in a later run: rounds from both runs, first verdict from the earlier run', async () => {
    const runsDir = await runsRoot();
    const first = await newRun(runsDir, 'run-1');
    first.take('RP-4');
    first.fanOut('a1', ['code-reviewer']);
    first.fanOut('a2', ['code-reviewer']);
    first.fanOut('a3', ['code-reviewer']);
    first.verdict('code-reviewer', 'HOLD', 'a1');
    first.stop();
    const second = await newRun(runsDir, 'run-2', 10);
    second.take('RP-4');
    second.fanOut('b1', ['code-reviewer']);
    second.verdict('code-reviewer', 'SHIP', 'b1');
    second.closed('RP-4');

    // The later run is passed first: order comes from `at`, not from the list.
    const outcome = mod().outcomeOf({ runs: [second.entry(), first.entry()] });
    const rounds = signal(outcome, 'gate-rounds');
    expect([rounds.eligible, rounds.observed, rounds.unknown]).toEqual([1, 1, 0]);
    expect(rounds.result).toEqual({ distribution: { '4': 1 } });
    const verdict = signal(outcome, 'first-shipping-verdict');
    expect([verdict.eligible, verdict.observed, verdict.unknown]).toEqual([1, 1, 0]);
    const result = verdict.result as VerdictCounts;
    expect([result.SHIP, result.HOLD, result.other]).toEqual([0, 1, 0]);
  });
});

describe('evidence-query outcomeOf: report shape', () => {
  it('every signal carries name, signalVersion, eligible, observed, unknown and result', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.take('RP-60');
    r.route('model', ['code-reviewer']);
    r.fanOut('h60', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'h60');
    r.closed('RP-60');

    const outcome = mod().outcomeOf({ runs: [r.entry()] });
    expect(outcome.schemaVersion).toBe(1);
    expect(outcome.signals.map((s) => s.name)).toEqual([
      'first-shipping-verdict',
      'gate-rounds',
      'claim-to-merge',
      'interventions',
      'continuation',
      'tokens-per-ship',
    ]);
    for (const s of outcome.signals) {
      expect(Object.keys(s).sort()).toEqual(
        ['eligible', 'name', 'observed', 'result', 'signalVersion', 'unknown'].sort(),
      );
      const definition = SIGNALS.find((d) => d.name === s.name);
      expect(definition, `${s.name} is not defined in outcome-signals.mjs`).toBeDefined();
      expect(s.signalVersion).toBe(definition!.signalVersion);
      for (const count of [s.eligible, s.observed, s.unknown])
        expect(Number.isInteger(count)).toBe(true);
      // RP-60 posted no continuation and recorded no claim, so those two
      // populations are empty.
      // tokens-per-ship is not computed, so its one shipped item is unknown.
      const expected = ['continuation', 'claim-to-merge'].includes(s.name)
        ? [0, 0, 0]
        : s.name === 'tokens-per-ship'
          ? [1, 0, 1]
          : [1, 1, 0];
      expect([s.eligible, s.observed, s.unknown]).toEqual(expected);
    }
  });

  it('first-shipping-verdict and gate-rounds are signalVersion 2', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    r.take('RP-61');

    const outcome = mod().outcomeOf({ runs: [r.entry()] });
    expect(signal(outcome, 'first-shipping-verdict').signalVersion).toBe(2);
    expect(signal(outcome, 'gate-rounds').signalVersion).toBe(2);
  });

  it('a run readRuns refused is listed as skipped with why', async () => {
    const runsDir = await runsRoot();
    const good = await newRun(runsDir, 'run-good');
    good.take('RP-70');
    good.fanOut('h70', ['code-reviewer']);
    good.closed('RP-70');
    const bad = path.join(runsDir, 'run-bad');
    await mkdir(bad);
    // seq 1 then 3: readRun refuses a broken sequence.
    await writeFile(
      path.join(bad, 'events.jsonl'),
      [
        JSON.stringify({ seq: 1, at: '2026-10-01T00:00:01.000Z', kind: 'note', data: null }),
        JSON.stringify({ seq: 3, at: '2026-10-01T00:00:02.000Z', kind: 'note', data: null }),
      ].join('\n') + '\n',
    );

    const outcome = mod().outcomeOf({ runs: readRuns(runsDir) });
    expect(outcome.runs.read).toEqual(['run-good']);
    expect(outcome.runs.skipped).toHaveLength(1);
    expect(outcome.runs.skipped[0]!.run).toBe('run-bad');
    expect(outcome.runs.skipped[0]!.why).toMatch(/seq|sequence/i);
    const rounds = signal(outcome, 'gate-rounds');
    expect([rounds.eligible, rounds.observed]).toEqual([1, 1]);
  });
});

describe('evidence-query outcomeOf: interventions', () => {
  it('counts recorded escalations and delegated decisions, and a run without that evidence is unknown', async () => {
    const runsDir = await runsRoot();
    const recorded = await newRun(runsDir, 'run-new');
    recorded.take('RP-70');
    recorded.ev('item-escalated', { schemaVersion: 1, ticket: 'RP-70', stop: 'escalation' });
    recorded.ev('delegated-decision', { ticket: 'RP-70', decision: 'extra-gate-round' });
    recorded.take('RP-71');
    recorded.closed('RP-71');
    // A run that carries none of the item-tied events cannot tell "none" from
    // "not recorded".
    const older = await newRun(runsDir, 'run-old');
    older.take('RP-72');

    const s = signal(mod().outcomeOf({ runs: [recorded.entry(), older.entry()] }), 'interventions');
    expect([s.eligible, s.observed, s.unknown]).toEqual([3, 2, 1]);
    expect(s.result).toEqual({
      escalations: 1,
      delegatedDecisions: 1,
      distribution: { '0': 1, '2': 1 },
    });
  });
});

describe('evidence-query outcomeOf: continuation', () => {
  it('reads an unresolved continuation as unknown when a named run could not be read', async () => {
    const r = await newRun(await runsRoot(), 'run-1');
    r.take('RP-85');
    r.ev('continuation', { schemaVersion: 1, ticket: 'RP-85', stop: 'pause', head: 'h85' });

    const s = signal(
      mod().outcomeOf({ runs: [r.entry(), { run: 'run-2', error: 'not found' }] }),
      'continuation',
    );
    expect([s.eligible, s.observed, s.unknown]).toEqual([1, 0, 1]);
    expect(s.result).toEqual({ resolved: { closed: 0, reEscalated: 0 }, unresolved: 0 });
  });

  it('reads a continuation as resolved only by a close or re-escalation in a later run', async () => {
    const runsDir = await runsRoot();
    const first = await newRun(runsDir, 'run-1');
    first.take('RP-80');
    first.ev('continuation', { schemaVersion: 1, ticket: 'RP-80', stop: 'pause', head: 'h80' });
    // RP-81 escalates in the same run as its note: §6 posts the note and then
    // escalates, so that is the stop itself, not a resolution.
    first.take('RP-81');
    first.ev('continuation', {
      schemaVersion: 1,
      ticket: 'RP-81',
      stop: 'escalation',
      head: 'h81',
    });
    first.ev('item-escalated', { schemaVersion: 1, ticket: 'RP-81', stop: 'escalation' });
    first.take('RP-82');
    first.ev('continuation', { schemaVersion: 1, ticket: 'RP-82', stop: 'blocker', head: 'h82' });
    const second = await newRun(runsDir, 'run-2');
    for (let i = 0; i < 20; i += 1) second.ev('note', null); // later than every run-1 record
    second.take('RP-80');
    second.closed('RP-80');
    second.take('RP-82');
    second.ev('item-escalated', { schemaVersion: 1, ticket: 'RP-82', stop: 'escalation' });

    const s = signal(mod().outcomeOf({ runs: [first.entry(), second.entry()] }), 'continuation');
    expect([s.eligible, s.observed, s.unknown]).toEqual([3, 3, 0]);
    expect(s.result).toEqual({ resolved: { closed: 1, reEscalated: 1 }, unresolved: 1 });
  });
});

describe('evidence-query outcomeOf: claim-to-merge', () => {
  it('measures total wall time from the first valid claim to the merged commit, and excludes an item without both', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    // RP-90: claimed at 00:00:02, its merge commit committed at 01:00:02.
    r.take('RP-90');
    r.ev('revalidation', { ticket: 'RP-90', point: 'SELECT', action: 'continue' });
    r.ev('revalidation', {
      ticket: 'RP-90',
      point: 'BEFORE_CLOSE',
      action: 'hold',
      evidence: { ownMergeAdvance: { from: 'a'.repeat(40), to: 'b'.repeat(40) } },
    });
    // RP-91: a held claim is not a valid one, and nothing records its merge.
    r.take('RP-91');
    r.ev('revalidation', { ticket: 'RP-91', point: 'SELECT', action: 'hold' });
    // RP-92: claimed, but its merge commit is not in this clone.
    r.take('RP-92');
    r.ev('revalidation', { ticket: 'RP-92', point: 'SELECT', action: 'continue' });
    r.ev('revalidation', {
      ticket: 'RP-92',
      point: 'BEFORE_CLOSE',
      action: 'continue',
      evidence: { ownMergeAdvance: { from: 'a'.repeat(40), to: 'c'.repeat(40) } },
    });
    const commitTime = (sha: string): string | null =>
      sha === 'b'.repeat(40) ? '2026-10-01T01:00:03.000Z' : null;

    const s = signal(mod().outcomeOf({ runs: [r.entry()], commitTime } as never), 'claim-to-merge');
    expect([s.eligible, s.observed, s.unknown]).toEqual([3, 1, 2]);
    // The SELECT event is the run's second record: 2026-10-01T00:00:02Z.
    expect(s.result).toEqual({ wallTimeMs: { min: 3601000, median: 3601000, max: 3601000 } });
  });
});

describe('evidence-query outcomeOf: tokens-per-ship', () => {
  it('states tokens-per-ship as not computed, with every SHIP verdict unknown and the reason', async () => {
    const r = await newRun(await runsRoot(), 'run-a');
    // Three SHIP verdicts: two reviewers at h95, and one at RP-96's second head.
    r.take('RP-95');
    r.fanOut('h95', ['code-reviewer', 'security-scanner']);
    r.verdict('code-reviewer', 'SHIP', 'h95');
    r.verdict('security-scanner', 'SHIP', 'h95');
    r.take('RP-96');
    r.fanOut('h96a', ['code-reviewer']);
    r.verdict('code-reviewer', 'HOLD', 'h96a');
    r.fanOut('h96b', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'h96b');
    r.take('RP-97');
    r.fanOut('h97', ['code-reviewer']);
    r.verdict('code-reviewer', 'HOLD', 'h97');

    const s = signal(mod().outcomeOf({ runs: [r.entry()] }), 'tokens-per-ship');
    expect(s.signalVersion).toBe(2);
    expect([s.eligible, s.observed, s.unknown]).toEqual([3, 0, 3]);
    const result = s.result as { computed: boolean; reason: string };
    expect(result.computed).toBe(false);
    expect(result.reason).toMatch(/dispatch usage/);
  });
});

describe('evidence-query compareOutcome', () => {
  const rounds = (
    signalVersion: number,
    observed: number,
    distribution: Record<string, number>,
  ) => ({
    name: 'gate-rounds',
    signalVersion,
    eligible: observed,
    observed,
    unknown: 0,
    result: { distribution },
  });

  it('names a repository by its origin URL without credentials', () => {
    const { repositoryIdentity } = mod() as unknown as {
      repositoryIdentity: (url: string) => string;
    };
    const token = 'ghp_' + 'F'.repeat(36);
    expect(repositoryIdentity(`https://alice:${token}@example.invalid/o/r.git`)).toBe(
      'https://example.invalid/o/r.git',
    );
    expect(repositoryIdentity(`https://${token}@example.invalid/o/r.git`)).toBe(
      'https://example.invalid/o/r.git',
    );
    expect(repositoryIdentity('ssh://git@example.invalid/o/r.git')).toBe(
      'ssh://example.invalid/o/r.git',
    );
    expect(repositoryIdentity('git@example.invalid:o/r.git')).toBe('git@example.invalid:o/r.git');
    expect(repositoryIdentity('https://example.invalid/o/r.git')).toBe(
      'https://example.invalid/o/r.git',
    );
  });

  it('refuses to compare reports of different repositories, or one that names none', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const report = (repository?: string) => ({
      schemaVersion: 1,
      ...(repository === undefined ? {} : { repository }),
      signals: [rounds(2, 2, { '1': 2 })],
    });

    expect(compare({ baseline: report('a'), current: report('a') }).signals[0]).toMatchObject({
      comparison: 'comparable',
    });
    for (const [before, after] of [
      ['a', 'b'],
      [undefined, 'a'],
      ['a', undefined],
    ] as const) {
      const s = compare({ baseline: report(before), current: report(after) }).signals[0];
      expect(s, `${before} vs ${after}`).toMatchObject({ comparison: 'not comparable' });
      expect(String(s!.reason)).toMatch(/repository/);
    }
  });

  it('refuses a lane mix whose share of any lane moved by more than a fifth', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const report = (lanes: Record<string, number>) => ({
      schemaVersion: 1,
      repository: 'r',
      signals: [
        {
          name: 'first-shipping-verdict',
          signalVersion: 2,
          eligible: 10,
          observed: 10,
          unknown: 0,
          result: { SHIP: 5, HOLD: 5, other: 0, lanes, byLane: {} },
        },
      ],
    });
    // model share 0.9 -> 0.1: same lanes, materially different mix.
    const shifted = compare({
      baseline: report({ model: 9, 'fast-path': 1 }),
      current: report({ model: 1, 'fast-path': 9 }),
    }).signals[0];
    expect(shifted).toMatchObject({ comparison: 'not comparable' });
    expect(String(shifted!.reason)).toMatch(/lane/);
    // model share 0.6 -> 0.5: within a fifth.
    const close = compare({
      baseline: report({ model: 6, 'fast-path': 4 }),
      current: report({ model: 5, 'fast-path': 5 }),
    }).signals[0];
    expect(close).toMatchObject({ comparison: 'comparable' });
  });

  it('refuses every lane-dependent signal when the run sets reviewed through different lanes', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const report = (lanes: Record<string, number>) => ({
      schemaVersion: 1,
      repository: 'r',
      signals: [
        {
          name: 'first-shipping-verdict',
          signalVersion: 2,
          eligible: 4,
          observed: 4,
          unknown: 0,
          result: { SHIP: 2, HOLD: 2, other: 0, lanes, byLane: {} },
        },
        rounds(2, 4, { '1': 4 }),
      ],
    });

    const gate = compare({
      baseline: report({ model: 4 }),
      current: report({ deterministic: 4 }),
    }).signals.find((s) => s.name === 'gate-rounds');
    expect(gate).toMatchObject({
      comparison: 'not comparable',
      lanes: { baseline: { model: 4 }, current: { deterministic: 4 } },
    });
    expect(String(gate!.reason)).toMatch(/lane/);
  });

  it('compares first verdicts only over the same lanes, and prints both lane mixes', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const verdicts = (lanes: Record<string, number>, ship: number, hold: number) => ({
      schemaVersion: 1,
      repository: 'r',
      signals: [
        {
          name: 'first-shipping-verdict',
          signalVersion: 2,
          eligible: ship + hold,
          observed: ship + hold,
          unknown: 0,
          result: { SHIP: ship, HOLD: hold, other: 0, lanes, byLane: {} },
        },
      ],
    });

    const same = compare({
      baseline: verdicts({ model: 4 }, 1, 3),
      current: verdicts({ model: 4 }, 3, 1),
    }).signals[0];
    expect(same).toMatchObject({
      comparison: 'comparable',
      measure: 'share of observed items whose first verdict was SHIP',
      baseline: 0.25,
      current: 0.75,
      delta: 0.5,
      lanes: { baseline: { model: 4 }, current: { model: 4 } },
    });

    const shifted = compare({
      baseline: verdicts({ model: 4 }, 1, 3),
      current: verdicts({ model: 2, deterministic: 2 }, 1, 1),
    }).signals[0];
    expect(shifted).toMatchObject({
      comparison: 'not comparable',
      lanes: { baseline: { model: 4 }, current: { model: 2, deterministic: 2 } },
    });
    expect(String(shifted!.reason)).toMatch(/lane/);
  });

  it('states a measure for every computed signal, and refuses a signal that is not computed', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const report = (k: number) => ({
      schemaVersion: 1,
      repository: 'r',
      signals: [
        {
          name: 'claim-to-merge',
          signalVersion: 1,
          eligible: 2,
          observed: 2,
          unknown: 0,
          result: { wallTimeMs: { min: 1000, median: 1000 * k, max: 9000 } },
        },
        {
          name: 'interventions',
          signalVersion: 2,
          eligible: 2,
          observed: 2,
          unknown: 0,
          result: { escalations: k, delegatedDecisions: 0, distribution: { '0': 2 - k, '1': k } },
        },
        {
          name: 'continuation',
          signalVersion: 1,
          eligible: 2,
          observed: 2,
          unknown: 0,
          result: { resolved: { closed: k, reEscalated: 0 }, unresolved: 2 - k },
        },
        {
          name: 'tokens-per-ship',
          signalVersion: 2,
          eligible: 2,
          observed: 0,
          unknown: 2,
          result: { computed: false, reason: 'not computed' },
        },
      ],
    });

    const byName = Object.fromEntries(
      compare({ baseline: report(1), current: report(2) }).signals.map((s) => [s.name, s]),
    );
    expect(byName['claim-to-merge']).toMatchObject({
      comparison: 'comparable',
      measure: 'median total wall time, milliseconds',
      baseline: 1000,
      current: 2000,
      delta: 1000,
    });
    expect(byName.interventions).toMatchObject({
      comparison: 'comparable',
      measure: 'mean recorded interventions per observed item',
      baseline: 0.5,
      current: 1,
      delta: 0.5,
    });
    expect(byName.continuation).toMatchObject({
      comparison: 'comparable',
      measure: 'share of observed continuations resolved',
      baseline: 0.5,
      current: 1,
      delta: 0.5,
    });
    expect(byName['tokens-per-ship']).toMatchObject({ comparison: 'not comparable' });
    expect(String(byName['tokens-per-ship']!.reason)).toMatch(/not computed/);
  });

  it('never compares a side that observed nothing, even at a zero threshold', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown; minCoverage?: number }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const nothing = {
      schemaVersion: 1,
      repository: 'r',
      signals: [{ ...rounds(2, 0, {}), eligible: 3, unknown: 3 }],
    };
    const some = { schemaVersion: 1, repository: 'r', signals: [rounds(2, 2, { '1': 2 })] };

    const s = compare({ baseline: nothing, current: some, minCoverage: 0 }).signals[0];
    expect(s).toMatchObject({ comparison: 'insufficient' });
    expect(s).not.toHaveProperty('delta');
  });

  it('reads too little coverage on either side as insufficient', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown; minCoverage?: number }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const thin = {
      schemaVersion: 1,
      repository: 'r',
      signals: [{ ...rounds(2, 1, { '1': 1 }), eligible: 4, unknown: 3 }],
    };
    const full = { schemaVersion: 1, repository: 'r', signals: [rounds(2, 2, { '1': 2 })] };
    const empty = {
      schemaVersion: 1,
      repository: 'r',
      signals: [{ ...rounds(2, 0, {}), eligible: 0 }],
    };

    expect(compare({ baseline: thin, current: full }).signals[0]).toMatchObject({
      comparison: 'insufficient',
    });
    expect(compare({ baseline: full, current: empty }).signals[0]).toMatchObject({
      comparison: 'insufficient',
    });
    // At a 25% threshold one observed item in four is enough.
    expect(compare({ baseline: thin, current: full, minCoverage: 0.25 }).signals[0]).toMatchObject({
      comparison: 'comparable',
    });
  });

  it('gives a numeric delta for a comparable signal and refuses a signalVersion mismatch', () => {
    const compare = (
      mod() as unknown as {
        compareOutcome: (input: { baseline: unknown; current: unknown }) => {
          signals: Array<Record<string, unknown>>;
        };
      }
    ).compareOutcome;
    const baseline = {
      schemaVersion: 1,
      repository: 'r',
      signals: [rounds(2, 2, { '1': 1, '3': 1 })],
    };
    const sameVersion = { schemaVersion: 1, repository: 'r', signals: [rounds(2, 2, { '1': 2 })] };
    const otherVersion = { schemaVersion: 1, repository: 'r', signals: [rounds(3, 2, { '1': 2 })] };

    const [comparable] = compare({ baseline, current: sameVersion }).signals;
    expect(comparable).toEqual({
      name: 'gate-rounds',
      signalVersion: 2,
      comparison: 'comparable',
      measure: 'mean rounds per observed item',
      baseline: 2,
      current: 1,
      delta: -1,
    });
    expect(JSON.stringify(comparable)).not.toMatch(/improv|regress|better|worse/i);

    const [refused] = compare({ baseline, current: otherVersion }).signals;
    expect(refused).toMatchObject({ name: 'gate-rounds', comparison: 'not comparable' });
    expect(String(refused!.reason)).toMatch(/signalVersion/);
  });
});

describe('release-evidence.mjs --outcome', () => {
  it('the CLI --outcome prints the named runs only and leaves the runs directory unchanged', async () => {
    const runsDir = await runsRoot();
    for (const [name, ticket, word] of [
      ['run-a', 'RP-80', 'SHIP'],
      ['run-b', 'RP-81', 'HOLD'],
      ['run-c', 'RP-82', 'HOLD'],
      ['run-d', 'RP-83', 'HOLD'],
    ] as const) {
      const r = await newRun(runsDir, name);
      r.take(ticket);
      r.route('model', ['code-reviewer']);
      r.fanOut(`h-${name}`, ['code-reviewer']);
      r.verdict('code-reviewer', word, `h-${name}`);
      r.closed(ticket);
    }

    const before = await snapshot(runsDir);
    const result = await cli([
      '--outcome',
      '--runs',
      runsDir,
      '--run',
      'run-a',
      '--run',
      'run-c',
      '--run',
      'run-missing',
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout) as Outcome;
    expect(outcome.runs.read).toEqual(['run-a', 'run-c']);
    expect(outcome.runs.skipped).toEqual([{ run: 'run-missing', why: 'not found' }]);
    const first = signal(outcome, 'first-shipping-verdict');
    expect([first.eligible, first.observed]).toEqual([2, 2]);
    expect(first.result).toEqual({
      SHIP: 1,
      HOLD: 1,
      other: 0,
      lanes: { model: 2 },
      byLane: { model: { SHIP: 1, HOLD: 1, other: 0 } },
    });
    expect(signal(outcome, 'gate-rounds').result).toEqual({ distribution: { '1': 2 } });
    expect(await snapshot(runsDir)).toEqual(before);
  });

  it('the CLI reads the merge time from the commit in this checkout', async () => {
    const git = (args: string[]): Promise<string> =>
      new Promise((resolve, reject) =>
        execFile('git', args, { cwd: repoRoot, env: withoutGitLocation() }, (error, out) =>
          error ? reject(error) : resolve(out.trim()),
        ),
      );
    const sha = await git(['rev-parse', 'HEAD']);
    const committed = Date.parse(await git(['show', '-s', '--format=%cI', sha]));
    const runsDir = await runsRoot();
    const r = await newRun(runsDir, 'run-a');
    r.take('RP-95');
    const claim = r.ev('revalidation', { ticket: 'RP-95', point: 'SELECT', action: 'continue' });
    r.ev('revalidation', {
      ticket: 'RP-95',
      point: 'BEFORE_CLOSE',
      action: 'continue',
      evidence: { ownMergeAdvance: { from: sha, to: sha } },
    });

    const result = await cli(['--outcome', '--runs', runsDir, '--run', 'run-a']);
    expect(result.code, result.stderr).toBe(0);
    const s = signal(JSON.parse(result.stdout) as Outcome, 'claim-to-merge');
    expect([s.eligible, s.observed]).toEqual([1, 1]);
    const wall = committed - Date.parse(claim.at);
    expect(s.result).toEqual({ wallTimeMs: { min: wall, median: wall, max: wall } });
  });

  it('the CLI reads a repeated --run name once', async () => {
    const runsDir = await runsRoot();
    const r = await newRun(runsDir, 'run-a');
    r.take('RP-85');
    r.fanOut('h85', ['code-reviewer']);
    r.verdict('code-reviewer', 'SHIP', 'h85');
    r.closed('RP-85');

    const result = await cli(['--outcome', '--runs', runsDir, '--run', 'run-a', '--run', 'run-a']);
    expect(result.code, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout) as Outcome;
    expect(outcome.runs.read).toEqual(['run-a']);
    expect(signal(outcome, 'gate-rounds').eligible).toBe(1);
  });

  it('the CLI takes the coverage threshold from --min-coverage and refuses one outside (0, 1]', async () => {
    const runsDir = await runsRoot();
    for (const name of ['run-base', 'run-now']) {
      const r = await newRun(runsDir, name);
      r.take(`RP-${name}`);
      r.fanOut(`h-${name}`, ['code-reviewer']);
      r.closed(`RP-${name}`);
    }
    const args = ['--outcome', '--runs', runsDir, '--run', 'run-now', '--baseline', 'run-base'];

    const set = await cli([...args, '--min-coverage', '0.9']);
    expect(set.code, set.stderr).toBe(0);
    expect(
      (JSON.parse(set.stdout) as { comparison: { minCoverage: number } }).comparison.minCoverage,
    ).toBe(0.9);
    for (const bad of ['0', '1.5', 'half']) {
      const refused = await cli([...args, '--min-coverage', bad]);
      expect(refused.code, bad).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('--min-coverage');
    }
  });

  it('the CLI compares the named runs against named baseline runs', async () => {
    const runsDir = await runsRoot();
    for (const [name, ticket, heads] of [
      ['run-base', 'RP-61', ['b1', 'b2', 'b3']],
      ['run-now', 'RP-62', ['n1']],
    ] as const) {
      const r = await newRun(runsDir, name);
      r.take(ticket);
      for (const head of heads) r.fanOut(head, ['code-reviewer']);
      r.closed(ticket);
    }

    const result = await cli([
      '--outcome',
      '--runs',
      runsDir,
      '--run',
      'run-now',
      '--baseline',
      'run-base',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as {
      runs: { read: string[] };
      comparison: {
        baseline: { runs: { read: string[] } };
        signals: Array<Record<string, unknown>>;
      };
    };
    expect(out.runs.read).toEqual(['run-now']);
    expect(out.comparison.baseline.runs.read).toEqual(['run-base']);
    expect(out.comparison.signals.find((s) => s.name === 'gate-rounds')).toMatchObject({
      comparison: 'comparable',
      baseline: 3,
      current: 1,
      delta: -2,
    });
  });

  it('the CLI refuses --outcome without a named run, and --outcome with --since', async () => {
    const runsDir = await runsRoot();
    const r = await newRun(runsDir, 'run-a');
    r.take('RP-90');

    const unnamed = await cli(['--outcome', '--runs', runsDir]);
    expect(unnamed.code).toBe(1);
    expect(unnamed.stdout).toBe('');
    expect(unnamed.stderr).toContain('named run');

    const windowed = await cli([
      '--outcome',
      '--runs',
      runsDir,
      '--run',
      'run-a',
      '--since',
      '2026-09-01T00:00:00.000Z',
    ]);
    expect(windowed.code).toBe(1);
    expect(windowed.stdout).toBe('');
    expect(windowed.stderr.trim()).not.toBe('');
  });
});
