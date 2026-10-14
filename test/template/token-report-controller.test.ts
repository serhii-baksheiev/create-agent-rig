import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// RP-511 PR C — `token-report.mjs` reads the `controller-usage` snapshots
// `record-session-usage.mjs` journals (PR B) and reports them beside the
// existing subagent dispatch groups. Accepted accounting (owner decision
// 2026-10-14):
//
//   - a snapshot is a cumulative running total: the LAST one per (run,
//     controller) is reported and snapshots are never summed;
//   - a counter that goes DOWN between two snapshots makes that controller's
//     usage `null` with `usageUnavailable: 'non-monotonic-snapshots'` and
//     `coverage.incomplete: true`; the raw counters stay beside it;
//   - controller usage is attributed to the run only (`attribution.mode:
//     'run'`), with the run's taken tickets listed, never credited to one;
//   - `totals.<harness>.combined` (controller + subagents) is printed when
//     every controller entry and every dispatch group of the harness carries
//     usage and the last snapshot of every (run, controller) names a
//     `harnessVersion` on which parent/subagent exclusivity was verified;
//     a harness with controller entries and no dispatch group prints the
//     controller alone; otherwise it is `null` with a reason;
//   - `schemaVersion` is 2 and `accountingBasis` states what every number
//     rests on; `money` keeps its exact `{ line, estimate }` shape.
//
// The oracle for the sums is a second, deliberately duplicated addition
// written here rather than imported.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const reportUrl = pathToFileURL(path.join(scriptsDir, 'token-report.mjs')).href;
const journalUrl = pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href;

interface JournalRecord {
  seq: number;
  at: string;
  [key: string]: unknown;
}

interface Journal {
  recordDecision(input: {
    runDir: string;
    gate: string;
    verdict: string;
    evidence?: string[];
    now: string;
  }): JournalRecord;
  recordEvent(input: {
    runDir: string;
    kind: string;
    data?: Record<string, unknown> | null;
    now: string;
  }): JournalRecord;
  readRun(input: { runDir: string }): { decisions: JournalRecord[]; events: JournalRecord[] };
}

type Counters = Record<string, number | null>;

interface ControllerEntry {
  run: string;
  controller: string;
  harness: string;
  snapshots: number;
  lastTrigger: string;
  harnessVersion: string | null;
  usage: (Counters & { evidenceSource: string | null }) | null;
  usageUnavailable?: string;
  coverage: Record<string, unknown> | null;
  sessionAggregate: Record<string, unknown> | null;
  attribution: { mode: string; tickets: string[] };
  snapshotCounters?: Counters[];
}

interface HarnessTotals {
  controller: Counters | null;
  controllerRuns: { withSnapshot: number; unavailable: number; withoutSnapshot: number };
  subagents: Counters | null;
  subagentGroups: { total: number; withUsage: number };
  combined: Counters | null;
  combinedUnavailable: string | null;
  unverifiedHarnessVersions: string[];
}

interface Report {
  schemaVersion: number;
  tickets: Array<{ ticket: string; occurrences: Array<Record<string, unknown>> }>;
  accountingBasis: Record<string, unknown>;
  controllers: ControllerEntry[];
  totals: { claude: HarnessTotals; codex: HarnessTotals };
  usageEvidence: {
    controller: { available: boolean; snapshots: number; runsWithoutSnapshot: number };
  };
  money: { line: string; estimate: null };
}

interface ReportModule {
  tokenReportOf(input: {
    runs: Array<{ run: string; decisions?: JournalRecord[]; events?: JournalRecord[] }>;
    since: string;
    wiring?: Record<string, string>;
  }): Report;
  render(report: Report): string;
}

let journal: Journal;
let reportModule: ReportModule;

beforeAll(async () => {
  journal = (await import(journalUrl)) as Journal;
  reportModule = (await import(reportUrl)) as ReportModule;
});

const SINCE = '2026-09-01T00:00:00.000Z';
const at = (n: number) => `2026-10-14T06:00:${String(n).padStart(2, '0')}.000Z`;

const claudeCounters = (over: Partial<Record<string, number>> = {}) => ({
  requests: 10,
  inputTokens: 100,
  outputTokens: 200,
  cacheCreationInputTokens: 300,
  cacheReadInputTokens: 400,
  ...over,
});

const snapshot = (runDir: string, n: number, over: Record<string, unknown> = {}): JournalRecord =>
  journal.recordEvent({
    runDir,
    kind: 'controller-usage',
    data: {
      schema: 1,
      harness: 'claude',
      controller: 'ctrl-1',
      trigger: 'Stop',
      cumulative: true,
      harnessVersion: '2.1.296',
      usage: { evidenceSource: 'claude-controller-transcript', ...claudeCounters() },
      coverage: { basis: 'assistant-records-last-per-request', dedupedRequests: 10 },
      ...over,
    },
    now: at(n),
  });

const dispatchPair = (
  runDir: string,
  n: number,
  usage: Record<string, number>,
  harness = 'claude',
): void => {
  const base = { harness, controller: 'ctrl-1', agentType: 'code-reviewer', agentRef: `ref-${n}` };
  journal.recordEvent({ runDir, kind: 'dispatch-start', data: { schema: 1, ...base }, now: at(n) });
  journal.recordEvent({
    runDir,
    kind: 'dispatch-end',
    data: { schema: 1, ...base, usage: { evidenceSource: 'claude-subagent-transcript', ...usage } },
    now: at(n + 1),
  });
};

const taken = (runDir: string, n: number, ticket: string): JournalRecord =>
  journal.recordDecision({
    runDir,
    gate: 'item-selection',
    verdict: `taken ${ticket}`,
    now: at(n),
  });

const runsRoot = () => mkdtemp(path.join(tmpdir(), 'token-report-controller-'));

const mkrun = async (root: string, name: string): Promise<string> => {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
};

const readRuns = (root: string, names: string[]) =>
  names.map((name) => ({ run: name, ...journal.readRun({ runDir: path.join(root, name) }) }));

const report = (root: string, names: string[]): Report =>
  reportModule.tokenReportOf({ runs: readRuns(root, names), since: SINCE });

describe('token-report.mjs — controller usage (RP-511)', () => {
  it('reports schemaVersion 2, an accountingBasis, and keeps money as exactly {line, estimate}', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const data = report(root, ['run-a']);
    expect(data.schemaVersion).toBe(2);
    expect(data.accountingBasis).toMatchObject({ version: 1, controller: { attribution: 'run' } });
    expect(Object.keys(data.money).sort()).toEqual(['estimate', 'line']);
  });

  it('controller-only run: the snapshot is the controller usage, subagents are null, and combined equals the controller on a verified harness version', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const data = report(root, ['run-a']);
    expect(data.controllers).toHaveLength(1);
    const entry = data.controllers[0]!;
    expect(entry.usage).toEqual({
      evidenceSource: 'claude-controller-transcript',
      ...claudeCounters(),
    });
    expect(entry.attribution).toEqual({ mode: 'run', tickets: [] });
    expect(entry.harnessVersion).toBe('2.1.296');
    expect(data.totals.claude.controller).toEqual(claudeCounters());
    expect(data.totals.claude.subagents).toBeNull();
    expect(data.totals.claude.combined).toEqual(claudeCounters());
    expect(data.totals.claude.combinedUnavailable).toBeNull();
    expect(data.usageEvidence.controller).toMatchObject({
      available: true,
      snapshots: 1,
      runsWithoutSnapshot: 0,
    });
  });

  it('subagent-only run: no controller snapshot is absent evidence — runsWithoutSnapshot counts it and combined is null with a reason', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    dispatchPair(dir, 1, {
      requests: 1,
      inputTokens: 5,
      outputTokens: 6,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 8,
    });
    const data = report(root, ['run-a']);
    expect(data.controllers).toHaveLength(0);
    expect(data.totals.claude.controller).toBeNull();
    expect(data.totals.claude.subagents).toEqual({
      requests: 1,
      inputTokens: 5,
      outputTokens: 6,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 8,
    });
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('no-controller-snapshot');
    expect(data.totals.claude.controllerRuns.withoutSnapshot).toBe(1);
    expect(data.usageEvidence.controller.available).toBe(false);
  });

  // Pins a stated LIMIT of schema v2, not a goal: a run read without a
  // controller snapshot is counted but does not withhold the combined total.
  // The owner's correction (RP-511 PR D) replaces this with a per-run,
  // per-harness refusal; until then the report must say what it does.
  it('a run read without a controller snapshot is counted but does not withhold the combined total on this schema version', async () => {
    const root = await runsRoot();
    const a = await mkrun(root, 'run-a');
    const b = await mkrun(root, 'run-b');
    const sub = {
      requests: 1,
      inputTokens: 5,
      outputTokens: 6,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 8,
    };
    snapshot(a, 1);
    dispatchPair(a, 2, sub);
    dispatchPair(b, 1, sub);
    const data = report(root, ['run-a', 'run-b']);
    expect(data.totals.claude.controllerRuns.withoutSnapshot).toBe(1);
    expect(data.totals.codex.controllerRuns.withoutSnapshot).toBe(1); // one count, both harnesses
    expect(data.totals.claude.combined).not.toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBeNull();
  });

  it('controller plus two subagents: combined is the disjoint sum, checked against an independent addition', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    taken(dir, 1, 'RP-1');
    const a = {
      requests: 2,
      inputTokens: 11,
      outputTokens: 12,
      cacheCreationInputTokens: 13,
      cacheReadInputTokens: 14,
    };
    const b = {
      requests: 3,
      inputTokens: 21,
      outputTokens: 22,
      cacheCreationInputTokens: 23,
      cacheReadInputTokens: 24,
    };
    dispatchPair(dir, 2, a);
    dispatchPair(dir, 4, b);
    snapshot(dir, 6);
    const data = report(root, ['run-a']);
    const oracle: Record<string, number> = {};
    for (const field of Object.keys(claudeCounters())) {
      oracle[field] =
        (claudeCounters() as Record<string, number>)[field]! +
        a[field as keyof typeof a] +
        b[field as keyof typeof b];
    }
    expect(data.totals.claude.combined).toEqual(oracle);
    expect(data.controllers[0]!.attribution).toEqual({ mode: 'run', tickets: ['RP-1'] });
  });

  it('an absent or unverified harness version leaves combined null — exclusivity is a per-version fact, not an assumption', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, { harnessVersion: '2.1.999' });
    dispatchPair(dir, 2, {
      requests: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 1,
    });
    const data = report(root, ['run-a']);
    expect(data.totals.claude.controller).toEqual(claudeCounters());
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe(
      'exclusivity-unverified-for-harness-version',
    );
    expect(data.totals.claude.unverifiedHarnessVersions).toEqual(['2.1.999']);

    const dir2 = await mkrun(root, 'run-b');
    const { harnessVersion: _omit, ...withoutVersion } = { harnessVersion: 'x' };
    void _omit;
    snapshot(dir2, 1, { ...withoutVersion, harnessVersion: undefined });
    const data2 = report(root, ['run-b']);
    expect(data2.controllers[0]!.harnessVersion).toBeNull();
    expect(data2.totals.claude.combinedUnavailable).toBe(
      'exclusivity-unverified-for-harness-version',
    );
    expect(data2.totals.claude.unverifiedHarnessVersions).toEqual(['absent']);
  });

  it('three growing snapshots are never summed: the last one is the controller usage', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ outputTokens: 10 }),
      },
    });
    snapshot(dir, 2, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ outputTokens: 20 }),
      },
    });
    snapshot(dir, 3, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ outputTokens: 30 }),
      },
      trigger: 'SessionEnd',
    });
    const data = report(root, ['run-a']);
    const entry = data.controllers[0]!;
    expect(entry.snapshots).toBe(3);
    expect(entry.lastTrigger).toBe('SessionEnd');
    expect(entry.usage?.outputTokens).toBe(30);
  });

  it('a counter that goes down between snapshots makes the controller unavailable, keeps the raw counters, and blocks combined', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ outputTokens: 30 }),
      },
    });
    snapshot(dir, 2, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ outputTokens: 5 }),
      },
    });
    const data = report(root, ['run-a']);
    const entry = data.controllers[0]!;
    expect(entry.usage).toBeNull();
    expect(entry.usageUnavailable).toBe('non-monotonic-snapshots');
    expect(entry.coverage).toMatchObject({ incomplete: true });
    expect(entry.snapshotCounters?.map((c) => c.outputTokens)).toEqual([30, 5]);
    expect(data.totals.claude.controller).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('controller-usage-unavailable');
  });

  it('multi-ticket run: controller usage stays run-level and names every taken ticket; no ticket is credited', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    taken(dir, 1, 'RP-1');
    taken(dir, 2, 'RP-2');
    snapshot(dir, 3);
    const data = report(root, ['run-a']);
    expect(data.controllers[0]!.attribution).toEqual({ mode: 'run', tickets: ['RP-1', 'RP-2'] });
    // No ticket occurrence carries controller usage: the only controller
    // figures in the report are the run-level entries and totals.
    for (const ticket of data.tickets) {
      for (const occurrence of ticket.occurrences) {
        expect(Object.keys(occurrence)).not.toContain('controller');
        expect(Object.keys(occurrence)).not.toContain('usage');
      }
    }
  });

  it('a counter missing on one side of the combination is null on that total, never a partial sum', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    dispatchPair(dir, 2, { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 });
    const data = report(root, ['run-a']);
    expect(data.totals.claude.subagents?.cacheCreationInputTokens).toBeNull();
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('counter-missing-on-one-side');
  });

  it('a codex controller snapshot is reported with its own counters and verified against the codex version list', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      harness: 'codex',
      harnessVersion: '0.162.1',
      usage: {
        evidenceSource: 'codex-controller-rollout',
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 100,
        reasoningOutputTokens: 20,
      },
    });
    const data = report(root, ['run-a']);
    expect(data.totals.codex.combined).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 100,
      reasoningOutputTokens: 20,
    });
    expect(data.totals.claude.combinedUnavailable).toBe('no-controller-snapshot');
  });

  it('a snapshot whose counters are not non-negative safe integers is unavailable rather than summed', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ inputTokens: -1 }),
      },
    });
    const data = report(root, ['run-a']);
    expect(data.controllers[0]!.usage).toBeNull();
    expect(data.controllers[0]!.usageUnavailable).toBe('invalid-usage-counter');
  });

  it('the text render lists controllers and totals and still ends with the money line', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const data = report(root, ['run-a']);
    const text = reportModule.render(data);
    expect(text).toContain('controllers: 1');
    expect(text).toContain('attribution=run');
    expect(text).toMatch(/totals claude: controller=\{/);
    expect(text).toContain('controller=measured(snapshots=1)');
    expect(text.trimEnd().split('\n').at(-1)).toBe(data.money.line);
  });
});
