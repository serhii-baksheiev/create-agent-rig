import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// RP-511 PR C/PR D — `token-report.mjs` reads the `controller-usage` snapshots
// `record-session-usage.mjs` journals (PR B) and reports them beside the
// existing subagent dispatch groups. Accepted accounting (owner decision
// 2026-10-14, corrected for integration readiness the same day):
//
//   - a snapshot is a cumulative running total: the LAST one per (run,
//     controller) is reported and snapshots are never summed;
//   - a counter that goes DOWN between two snapshots makes that controller's
//     usage `null` with `usageUnavailable: 'non-monotonic-snapshots'` and
//     `coverage.incomplete: true`; the raw counters stay beside it;
//   - controller usage is attributed to the run only (`attribution.mode:
//     'run'`), with the run's taken tickets listed, never credited to one;
//   - `totals.<harness>.combined` (controller + subagents) is printed only when
//     EVERY run relevant to the harness carries a controller snapshot, every
//     controller and dispatch group is measured, no sum overflowed, and every
//     controller snapshot AND dispatch carries a `harnessVersion` on which
//     parent/subagent exclusivity was verified; otherwise it is `null` with a
//     reason, and it is never more than `measured-lower-bound-not-billing`;
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
  controllerPartialCounters: string[];
  controllerRuns: {
    relevant: number;
    withSnapshot: number;
    missingSnapshot: number;
    missingSnapshotRuns: string[];
    withoutDispatchEvidence: number;
    unavailable: number;
    partial: number;
    malformedSnapshots: number;
    unknownHarnessDispatchEvents: number;
    unpairedEnds: number;
  };
  subagents: Counters | null;
  subagentGroups: { total: number; measured: number };
  combined: Counters | null;
  combinedUnavailable: string | null;
  combinedBasis: string | null;
  combinedCaveats: string[];
  unverifiedHarnessVersions: string[];
}

interface DispatchGroup {
  harness: string;
  usage: { claude: Counters | null; codex: Counters | null };
  partialCounters: string[];
  harnessVersions: string[];
  counterOverflow: string[];
}

interface Report {
  schemaVersion: number;
  dispatchGroups: Array<{ dispatches: Record<string, number> }>;
  tickets: Array<{ ticket: string; occurrences: Array<Record<string, unknown>> }>;
  money: { line: string; estimate: null };
  accountingBasis: Record<string, unknown>;
  dispatchGroups: DispatchGroup[];
  controllers: ControllerEntry[];
  totals: { claude: HarnessTotals; codex: HarnessTotals };
  usageEvidence: {
    controller: { available: boolean; snapshots: number; runsWithoutSnapshot: number };
  };
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

/** `record-dispatch.mjs`'s `ref()` is 16 lowercase hex characters; a snapshot naming anything else is malformed. */
const CTRL = '0123456789abcdef';
const CLAUDE_VERSION = '2.1.296';
const CODEX_VERSION = '0.162.1';
const CONFIGURED = { claude: 'configured', codex: 'configured' };

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
      controller: CTRL,
      trigger: 'Stop',
      cumulative: true,
      harnessVersion: CLAUDE_VERSION,
      usage: { evidenceSource: 'claude-controller-transcript', ...claudeCounters() },
      coverage: { basis: 'assistant-records-last-per-request', dedupedRequests: 10 },
      ...over,
    },
    now: at(n),
  });

const dispatchPair = (
  runDir: string,
  n: number,
  usage: Record<string, unknown>,
  over: { harness?: string; harnessVersion?: string | null; end?: boolean } = {},
): void => {
  const harness = over.harness ?? 'claude';
  const base = { harness, controller: CTRL, agentType: 'code-reviewer', agentRef: `ref-${n}` };
  journal.recordEvent({ runDir, kind: 'dispatch-start', data: { schema: 1, ...base }, now: at(n) });
  if (over.end === false) return;
  const version =
    over.harnessVersion === null
      ? {}
      : {
          harnessVersion:
            over.harnessVersion ?? (harness === 'codex' ? CODEX_VERSION : CLAUDE_VERSION),
        };
  const evidenceSource =
    harness === 'codex' ? 'codex-subagent-rollout' : 'claude-subagent-transcript';
  journal.recordEvent({
    runDir,
    kind: 'dispatch-end',
    data: { schema: 1, ...base, ...version, usage: { evidenceSource, ...usage } },
    now: at(n + 1),
  });
};

const codexCounters = (over: Partial<Record<string, number>> = {}) => ({
  inputTokens: 1000,
  cachedInputTokens: 500,
  outputTokens: 100,
  reasoningOutputTokens: 20,
  ...over,
});

const codexSnapshot = (runDir: string, n: number): JournalRecord =>
  snapshot(runDir, n, {
    harness: 'codex',
    harnessVersion: CODEX_VERSION,
    usage: { evidenceSource: 'codex-controller-rollout', ...codexCounters() },
  });

const subUsage = (over: Partial<Record<string, number>> = {}) => ({
  requests: 1,
  inputTokens: 5,
  outputTokens: 6,
  cacheCreationInputTokens: 7,
  cacheReadInputTokens: 8,
  ...over,
});

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

const report = (
  root: string,
  names: string[],
  wiring: Record<string, string> = CONFIGURED,
): Report => reportModule.tokenReportOf({ runs: readRuns(root, names), since: SINCE, wiring });

/** The independent addition — a second copy, never the script's own. */
const add = (...parts: Array<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of parts) {
    for (const [field, value] of Object.entries(part)) out[field] = (out[field] ?? 0) + value;
  }
  return out;
};

describe('token-report.mjs — controller usage (RP-511)', () => {
  it('reports schemaVersion 2, an accountingBasis that calls combined non-authoritative, and keeps money as exactly {line, estimate}', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const data = report(root, ['run-a']);
    expect(data.schemaVersion).toBe(2);
    expect(data.accountingBasis).toMatchObject({
      version: 2,
      controller: { attribution: 'run' },
      combined: { authoritative: false },
    });
    expect(typeof data.accountingBasis.window).toBe('string');
    expect(Object.keys(data.money).sort()).toEqual(['estimate', 'line']);
  });

  it('controller-only run with the dispatch hook configured: the snapshot is the controller usage, subagents are null, and combined equals the controller on a verified harness version', async () => {
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
    expect(entry.harnessVersion).toBe(CLAUDE_VERSION);
    expect(data.totals.claude.controller).toEqual(claudeCounters());
    expect(data.totals.claude.subagents).toBeNull();
    expect(data.totals.claude.combined).toEqual(claudeCounters());
    expect(data.totals.claude.combinedUnavailable).toBeNull();
    expect(data.totals.claude.combinedBasis).toBe('measured-lower-bound-not-billing');
    // The subagent side of this run rests on hook configuration, not on a
    // witnessed dispatch — said on the total, never silently.
    expect(data.totals.claude.combinedCaveats).toEqual(['subagent-hook-configured-not-witnessed']);
    expect(data.totals.claude.controllerRuns).toMatchObject({
      relevant: 1,
      withSnapshot: 1,
      missingSnapshot: 0,
      missingSnapshotRuns: [],
      withoutDispatchEvidence: 1,
    });
    expect(data.money.line).toBe('usage measured; monetary cost unavailable');
    expect(data.usageEvidence.controller).toMatchObject({
      available: true,
      snapshots: 1,
      runsWithoutSnapshot: 0,
    });
  });

  it('controller-only run with the dispatch hook wiring unknown: the subagent side is unobserved, not empty, so combined is null', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const data = report(root, ['run-a'], {});
    expect(data.totals.claude.controller).toEqual(claudeCounters());
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('subagent-evidence-unobserved');
    expect(data.totals.claude.combinedBasis).toBeNull();
    expect(data.totals.claude.combinedCaveats).toEqual([]);
  });

  it('the per-run subagent rule does not transfer: a witnessed dispatch in run-a does not make run-b’s unobserved subagent side empty', async () => {
    const root = await runsRoot();
    const a = await mkrun(root, 'run-a');
    const b = await mkrun(root, 'run-b');
    snapshot(a, 1);
    dispatchPair(a, 2, subUsage());
    snapshot(b, 1);
    const data = report(root, ['run-a', 'run-b'], {});
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('subagent-evidence-unobserved');
    expect(data.totals.claude.controllerRuns.withoutDispatchEvidence).toBe(1);
  });

  it('a codex run with a snapshot and no dispatch event never combines on configuration alone — an untrusted Codex project hook is skipped silently', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    codexSnapshot(dir, 1);
    const data = report(root, ['run-a']);
    expect(data.totals.codex.controller).toEqual(codexCounters());
    expect(data.totals.codex.combined).toBeNull();
    expect(data.totals.codex.combinedUnavailable).toBe('subagent-evidence-unobserved');
  });

  it('a measured controller alone flips the money line to usage measured', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, { harnessVersion: '2.1.1' });
    const data = report(root, ['run-a'], {});
    expect(data.totals.claude.combined).toBeNull();
    expect(data.money.line).toBe('usage measured; monetary cost unavailable');
  });

  it('subagent-only run: no controller snapshot is absent evidence — runsWithoutSnapshot counts it and combined is null with a reason', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    dispatchPair(dir, 1, subUsage());
    const data = report(root, ['run-a']);
    expect(data.controllers).toHaveLength(0);
    expect(data.totals.claude.controller).toBeNull();
    expect(data.totals.claude.subagents).toEqual(subUsage());
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('no-controller-snapshot');
    expect(data.totals.claude.controllerRuns).toMatchObject({
      relevant: 1,
      missingSnapshot: 1,
      missingSnapshotRuns: ['run-a'],
    });
    expect(data.usageEvidence.controller.available).toBe(false);
    expect(data.usageEvidence.controller.runsWithoutSnapshot).toBe(1);
  });

  it('a usage-less snapshot between two valid ones is counted in snapshots but skipped in snapshotCounters', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ outputTokens: 30 }),
      },
    });
    snapshot(dir, 2, { usage: undefined, usageUnavailable: 'transcript-unreadable' });
    snapshot(dir, 3, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ outputTokens: 5 }),
      },
    });
    const data = report(root, ['run-a']);
    const entry = data.controllers[0]!;
    expect(entry.snapshots).toBe(3);
    expect(entry.usageUnavailable).toBe('non-monotonic-snapshots');
    expect(entry.snapshotCounters?.map((c) => c.outputTokens)).toEqual([30, 5]);
  });

  it('controller plus two subagents: combined is the disjoint sum, checked against an independent addition', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    taken(dir, 1, 'RP-1');
    const a = subUsage({ requests: 2, inputTokens: 11, outputTokens: 12 });
    const b = subUsage({ requests: 3, inputTokens: 21, outputTokens: 22 });
    dispatchPair(dir, 2, a);
    dispatchPair(dir, 4, b);
    snapshot(dir, 6);
    const data = report(root, ['run-a']);
    expect(data.totals.claude.subagents).toEqual(add(a, b));
    expect(data.totals.claude.combined).toEqual(add(claudeCounters(), a, b));
    expect(data.totals.claude.subagentGroups).toEqual({ total: 1, measured: 1 });
    expect(data.controllers[0]!.attribution).toEqual({ mode: 'run', tickets: ['RP-1'] });
  });

  // The regression fixture the owner correction asked for: several runs, one
  // of them with dispatches but no controller snapshot.
  it('three runs, one with dispatches and no controller snapshot: no combined total for the harness, and the run is named', async () => {
    const root = await runsRoot();
    const a = await mkrun(root, 'run-a');
    const b = await mkrun(root, 'run-b');
    const c = await mkrun(root, 'run-c');
    dispatchPair(a, 1, subUsage());
    snapshot(a, 3);
    dispatchPair(b, 1, subUsage({ inputTokens: 50 }));
    snapshot(c, 1, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ inputTokens: 1 }),
      },
    });
    const data = report(root, ['run-a', 'run-b', 'run-c']);
    // The two snapshots that exist are still reported — the gap is in the total, not the entries.
    expect(data.controllers.map((entry) => entry.run).sort()).toEqual(['run-a', 'run-c']);
    expect(data.totals.claude.controller).toEqual(
      add(claudeCounters(), claudeCounters({ inputTokens: 1 })),
    );
    expect(data.totals.claude.subagents).toEqual(add(subUsage(), subUsage({ inputTokens: 50 })));
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('controller-snapshot-missing-for-run');
    expect(data.totals.claude.controllerRuns).toMatchObject({
      relevant: 3,
      withSnapshot: 2,
      missingSnapshot: 1,
      missingSnapshotRuns: ['run-b'],
    });
    // With run-b left out of the read, the same evidence combines.
    const complete = report(root, ['run-a', 'run-c']);
    expect(complete.totals.claude.combined).toEqual(
      add(claudeCounters(), claudeCounters({ inputTokens: 1 }), subUsage()),
    );
  });

  it('a run that journalled records but no usage evidence for any harness is relevant to every harness — its controller is unaccounted for', async () => {
    const root = await runsRoot();
    const a = await mkrun(root, 'run-a');
    const b = await mkrun(root, 'run-b');
    snapshot(a, 1);
    taken(b, 1, 'RP-9');
    const data = report(root, ['run-a', 'run-b']);
    expect(data.totals.claude.combinedUnavailable).toBe('controller-snapshot-missing-for-run');
    expect(data.totals.claude.controllerRuns.missingSnapshotRuns).toEqual(['run-b']);
  });

  it('mixed-harness run: a codex controller snapshot does not stand in for the claude controller of the same run', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    dispatchPair(dir, 1, subUsage());
    const codexSub = {
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    };
    dispatchPair(dir, 3, codexSub, { harness: 'codex' });
    codexSnapshot(dir, 5);
    const data = report(root, ['run-a']);
    expect(data.totals.claude.combinedUnavailable).toBe('no-controller-snapshot');
    expect(data.totals.claude.controllerRuns.missingSnapshotRuns).toEqual(['run-a']);
    expect(data.totals.codex.combined).toEqual(add(codexCounters(), codexSub));
    expect(data.totals.codex.combinedCaveats).toEqual([]);
    expect(data.totals.codex.controllerRuns.missingSnapshot).toBe(0);
  });

  it('a dispatch of an unknown harness (hook wired without --harness=) refuses every combined total — its usage belongs to some harness’s subagent side', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const base = { controller: CTRL, agentType: 'code-reviewer', agentRef: 'ref-u' };
    journal.recordEvent({
      runDir: dir,
      kind: 'dispatch-start',
      data: { schema: 1, ...base },
      now: at(2),
    });
    journal.recordEvent({
      runDir: dir,
      kind: 'dispatch-end',
      data: {
        schema: 1,
        ...base,
        usage: { evidenceSource: 'claude-subagent-transcript', ...subUsage() },
      },
      now: at(3),
    });
    const data = report(root, ['run-a']);
    expect(data.dispatchGroups).toHaveLength(1);
    expect(data.dispatchGroups[0]!.harness).toBe('unknown');
    expect(data.totals.claude.controllerRuns.unknownHarnessDispatchEvents).toBe(2);
    expect(data.totals.claude.combinedUnavailable).toBe('dispatch-harness-unknown');
    expect(data.totals.codex.combinedUnavailable).toBe('no-controller-snapshot');
  });

  it('a non-orphan dispatch-end whose start fell before --since is unpaired: its usage is dropped, so combined is refused rather than printed with a hole', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    dispatchPair(dir, 1, subUsage());
    dispatchPair(dir, 10, subUsage({ inputTokens: 50 }));
    snapshot(dir, 20);
    const complete = report(root, ['run-a']);
    expect(complete.totals.claude.combined).toEqual(
      add(claudeCounters(), subUsage(), subUsage({ inputTokens: 50 })),
    );
    const windowed = reportModule.tokenReportOf({
      runs: readRuns(root, ['run-a']),
      since: at(2),
      wiring: CONFIGURED,
    });
    expect(windowed.totals.claude.controllerRuns.unpairedEnds).toBe(1);
    expect(windowed.totals.claude.combined).toBeNull();
    expect(windowed.totals.claude.combinedUnavailable).toBe('dispatch-end-unpaired');
  });

  it('a dispatch-start naming a second controller ref with no snapshot of its own leaves the run missing a snapshot — completeness is per (run, controller)', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const other = 'fedcba9876543210';
    const base = {
      harness: 'claude',
      controller: other,
      agentType: 'code-reviewer',
      agentRef: 'ref-o',
    };
    journal.recordEvent({
      runDir: dir,
      kind: 'dispatch-start',
      data: { schema: 1, ...base },
      now: at(2),
    });
    journal.recordEvent({
      runDir: dir,
      kind: 'dispatch-end',
      data: {
        schema: 1,
        ...base,
        harnessVersion: CLAUDE_VERSION,
        usage: { evidenceSource: 'claude-subagent-transcript', ...subUsage() },
      },
      now: at(3),
    });
    const data = report(root, ['run-a']);
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('controller-snapshot-missing-for-run');
    expect(data.totals.claude.controllerRuns.missingSnapshotRuns).toEqual(['run-a']);
    snapshot(dir, 4, { controller: other });
    const complete = report(root, ['run-a']);
    expect(complete.totals.claude.combined).toEqual(
      add(claudeCounters(), claudeCounters(), subUsage()),
    );
  });

  it('an absent or unverified CONTROLLER harness version leaves combined null — exclusivity is a per-version fact, not an assumption', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, { harnessVersion: '2.1.999' });
    dispatchPair(dir, 2, subUsage());
    const data = report(root, ['run-a']);
    expect(data.totals.claude.controller).toEqual(claudeCounters());
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe(
      'exclusivity-unverified-for-harness-version',
    );
    expect(data.totals.claude.unverifiedHarnessVersions).toEqual(['2.1.999']);

    const dir2 = await mkrun(root, 'run-b');
    snapshot(dir2, 1, { harnessVersion: undefined });
    const data2 = report(root, ['run-b']);
    expect(data2.controllers[0]!.harnessVersion).toBeNull();
    expect(data2.totals.claude.combinedUnavailable).toBe(
      'exclusivity-unverified-for-harness-version',
    );
    expect(data2.totals.claude.unverifiedHarnessVersions).toEqual(['absent']);
  });

  it('an absent or unverified DISPATCH harness version leaves combined null — the controller binary is never assumed for its subagents', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    dispatchPair(dir, 2, subUsage(), { harnessVersion: '2.1.100' });
    const data = report(root, ['run-a']);
    expect(data.dispatchGroups[0]!.harnessVersions).toEqual(['2.1.100']);
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe(
      'exclusivity-unverified-for-harness-version',
    );
    expect(data.totals.claude.unverifiedHarnessVersions).toEqual(['2.1.100']);

    const dir2 = await mkrun(root, 'run-b');
    snapshot(dir2, 1);
    dispatchPair(dir2, 2, subUsage(), { harnessVersion: null });
    const data2 = report(root, ['run-b']);
    expect(data2.dispatchGroups[0]!.harnessVersions).toEqual(['absent']);
    expect(data2.totals.claude.combinedUnavailable).toBe(
      'exclusivity-unverified-for-harness-version',
    );
    expect(data2.totals.claude.unverifiedHarnessVersions).toEqual(['absent']);
  });

  it('a dispatch group with a start that never ended is not measured, so combined is null', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    dispatchPair(dir, 2, subUsage());
    dispatchPair(dir, 4, subUsage(), { end: false });
    const data = report(root, ['run-a']);
    expect(data.totals.claude.subagents).toBeNull();
    expect(data.totals.claude.subagentGroups).toEqual({ total: 1, measured: 0 });
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('subagent-usage-incomplete');
  });

  it('a dispatch group where one ended dispatch carried no usage (withUsage under-count) is not measured', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    dispatchPair(dir, 2, subUsage());
    const base = {
      harness: 'claude',
      controller: CTRL,
      agentType: 'code-reviewer',
      agentRef: 'ref-x',
    };
    journal.recordEvent({
      runDir: dir,
      kind: 'dispatch-start',
      data: { schema: 1, ...base },
      now: at(4),
    });
    journal.recordEvent({
      runDir: dir,
      kind: 'dispatch-end',
      data: { schema: 1, ...base, usageUnavailable: 'transcript-unreadable' },
      now: at(5),
    });
    const data = report(root, ['run-a']);
    expect(data.totals.claude.subagents).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('subagent-usage-incomplete');
  });

  it('a dispatch whose usage names partialCounters is not a complete measurement: the group carries the names and combined is null', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    // Eight junk names ahead of the real one do not hide it.
    dispatchPair(dir, 2, {
      ...subUsage(),
      partialCounters: [...Array.from({ length: 8 }, () => 'bogus'), 'cacheReadInputTokens'],
    });
    const data = report(root, ['run-a']);
    expect(data.dispatchGroups[0]!.partialCounters).toEqual(['cacheReadInputTokens']);
    expect(data.totals.claude.subagentGroups).toEqual({ total: 1, measured: 0 });
    expect(data.totals.claude.combinedUnavailable).toBe('subagent-usage-incomplete');
  });

  it('a controller snapshot whose coverage names partialCounters is reported but never combined', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      coverage: {
        basis: 'assistant-records-last-per-request',
        partialCounters: ['cacheCreationInputTokens'],
      },
    });
    const data = report(root, ['run-a']);
    expect(data.controllers[0]!.coverage).toEqual({
      basis: 'assistant-records-last-per-request',
      partialCounters: ['cacheCreationInputTokens'],
    });
    // The partly covered counter is null in the total and named; the others sum.
    expect(data.totals.claude.controller).toEqual(
      claudeCounters({ cacheCreationInputTokens: null as unknown as number }),
    );
    expect(data.totals.claude.controllerPartialCounters).toEqual(['cacheCreationInputTokens']);
    expect(data.totals.claude.controllerRuns.partial).toBe(1);
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('controller-counters-partial');
  });

  it('a controller sum that leaves the safe-integer range is null with counter-overflow, never a wrapped number', async () => {
    const root = await runsRoot();
    const a = await mkrun(root, 'run-a');
    const b = await mkrun(root, 'run-b');
    const huge = claudeCounters({ inputTokens: Number.MAX_SAFE_INTEGER });
    snapshot(a, 1, { usage: { evidenceSource: 'claude-controller-transcript', ...huge } });
    snapshot(b, 1, { usage: { evidenceSource: 'claude-controller-transcript', ...huge } });
    const data = report(root, ['run-a', 'run-b']);
    expect(data.totals.claude.controller?.inputTokens).toBeNull();
    expect(data.totals.claude.controller?.outputTokens).toBe(400);
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('counter-overflow');
  });

  it('a subagent sum that leaves the safe-integer range is counter-overflow on the group and on the total', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    dispatchPair(dir, 2, subUsage({ inputTokens: Number.MAX_SAFE_INTEGER }));
    dispatchPair(dir, 4, subUsage({ inputTokens: Number.MAX_SAFE_INTEGER }));
    const data = report(root, ['run-a']);
    expect(data.dispatchGroups[0]!.usage.claude?.inputTokens).toBeNull();
    expect(data.dispatchGroups[0]!.counterOverflow).toEqual(['inputTokens']);
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('counter-overflow');
  });

  it('a combination that leaves the safe-integer range is counter-overflow even when each side fits', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      usage: {
        evidenceSource: 'claude-controller-transcript',
        ...claudeCounters({ inputTokens: Number.MAX_SAFE_INTEGER }),
      },
    });
    dispatchPair(dir, 2, subUsage({ inputTokens: 1 }));
    const data = report(root, ['run-a']);
    expect(data.totals.claude.controller?.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(data.totals.claude.subagents?.inputTokens).toBe(1);
    expect(data.totals.claude.combined).toBeNull();
    expect(data.totals.claude.combinedUnavailable).toBe('counter-overflow');
  });

  it('three growing snapshots are never summed: the last one is the controller usage', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    for (const [n, outputTokens, trigger] of [
      [1, 10, 'Stop'],
      [2, 20, 'Stop'],
      [3, 30, 'SessionEnd'],
    ] as const) {
      snapshot(dir, n, {
        usage: {
          evidenceSource: 'claude-controller-transcript',
          ...claudeCounters({ outputTokens }),
        },
        trigger,
      });
    }
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
    const codexSub = {
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    };
    dispatchPair(dir, 1, codexSub, { harness: 'codex' });
    codexSnapshot(dir, 3);
    const data = report(root, ['run-a']);
    expect(data.totals.codex.controller).toEqual(codexCounters());
    expect(data.totals.codex.combined).toEqual(add(codexCounters(), codexSub));
    expect(data.totals.claude.combinedUnavailable).toBe('no-controller-snapshot');

    const dir2 = await mkrun(root, 'run-b');
    dispatchPair(dir2, 1, codexSub, { harness: 'codex', harnessVersion: '0.1.0' });
    codexSnapshot(dir2, 3);
    const data2 = report(root, ['run-b']);
    expect(data2.totals.codex.combinedUnavailable).toBe(
      'exclusivity-unverified-for-harness-version',
    );
    expect(data2.totals.codex.unverifiedHarnessVersions).toEqual(['0.1.0']);
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

  // Malformed snapshots — journal content this report cannot attribute. A
  // harness literally named `constructor` used to reach
  // `CONTROLLER_COUNTER_FIELDS[harness]` and throw; now nothing but
  // `claude`/`codex` is read, and every such snapshot blocks combined.
  it('a snapshot with an unknown or prototype-named harness, a non-ref controller, or the wrong schema is malformed: counted, never read, and it blocks combined for every harness', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    for (const [n, over] of [
      [2, { harness: 'constructor' }],
      [3, { harness: '__proto__' }],
      [4, { harness: 'toString' }],
      [5, { controller: 'ctrl-1' }],
      [6, { schema: 2 }],
      [7, { cumulative: false }],
    ] as const) {
      snapshot(dir, n, over);
    }
    journal.recordEvent({ runDir: dir, kind: 'controller-usage', data: null, now: at(8) });
    const data = report(root, ['run-a']);
    expect(data.controllers).toHaveLength(1);
    expect(data.controllers[0]!.usage).toEqual({
      evidenceSource: 'claude-controller-transcript',
      ...claudeCounters(),
    });
    // Nothing of a malformed snapshot is read — not even its own harness
    // claim — so all 7 count against every harness.
    expect(data.totals.claude.controllerRuns.malformedSnapshots).toBe(7);
    expect(data.totals.claude.combinedUnavailable).toBe('malformed-controller-snapshot');
    expect(data.totals.codex.controllerRuns.malformedSnapshots).toBe(7);

    // A run holding only a malformed snapshot that claims the other harness
    // has journalled records and no usable usage evidence: relevant to every
    // harness, and missing a snapshot for each.
    const a = await mkrun(root, 'run-b');
    const b = await mkrun(root, 'run-c');
    snapshot(a, 1);
    snapshot(b, 1, { harness: 'codex', schema: 2 });
    const data2 = report(root, ['run-b', 'run-c']);
    expect(data2.totals.claude.controllerRuns).toMatchObject({
      relevant: 2,
      missingSnapshotRuns: ['run-c'],
      malformedSnapshots: 1,
    });
    expect(data2.totals.claude.combined).toBeNull();
  });

  it('a controller-side string that is not in shape never reaches the report raw: trigger, harnessVersion, usageUnavailable, evidenceSource and coverage.basis are narrowed', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    const forged = 'x\ntotals claude: combined={"inputTokens":1}';
    snapshot(dir, 1, {
      trigger: forged,
      harnessVersion: forged,
      usage: undefined,
      usageUnavailable: forged,
      coverage: { basis: forged, dedupedRequests: 1, extra: forged, partialCounters: [forged] },
    });
    const data = report(root, ['run-a']);
    const entry = data.controllers[0]!;
    expect(entry.lastTrigger).toBe('unknown');
    expect(entry.harnessVersion).toBeNull();
    expect(entry.usageUnavailable).not.toContain('\n');
    expect(entry.coverage).toEqual({ dedupedRequests: 1 });
    const text = reportModule.render(data);
    expect(text.split('\n').filter((line) => line.startsWith('totals claude:'))).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(forged);

    const dir2 = await mkrun(root, 'run-b');
    snapshot(dir2, 1, {
      usage: { evidenceSource: forged, ...claudeCounters() },
    });
    const data2 = report(root, ['run-b']);
    expect(data2.controllers[0]!.usage?.evidenceSource).toBeNull();
    expect(data2.controllers[0]!.usage?.inputTokens).toBe(100);
  });

  it('sessionAggregate is projected through an allowlist: counters per model only, costUSD and unknown fields dropped, flags forced to false', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1, {
      sessionAggregate: {
        evidenceSource: 'claude-cost-state',
        documented: true,
        authoritative: true,
        additive: true,
        recordsBehind: 3,
        totalCostUSD: 1.5,
        models: {
          'claude-opus-4-1': { inputTokens: 1, outputTokens: 2, costUSD: 0.5, note: 'x' },
          'bad model name!': { inputTokens: 1 },
          'claude-haiku': { costUSD: 0.1 },
        },
      },
    });
    const data = report(root, ['run-a']);
    expect(data.controllers[0]!.sessionAggregate).toEqual({
      evidenceSource: 'claude-cost-state',
      documented: false,
      authoritative: false,
      additive: false,
      models: { 'claude-opus-4-1': { inputTokens: 1, outputTokens: 2 } },
      recordsBehind: 3,
    });
    expect(JSON.stringify(data)).not.toContain('costUSD');
  });

  it('the text render lists controllers and totals, names the completeness counts, and still ends with the money line', async () => {
    const root = await runsRoot();
    const dir = await mkrun(root, 'run-a');
    snapshot(dir, 1);
    const data = report(root, ['run-a']);
    const text = reportModule.render(data);
    expect(text).toContain('controllers: 1');
    expect(text).toContain('attribution=run');
    expect(text).toMatch(/totals claude: controller=\{/);
    expect(text).toContain('caveats=["subagent-hook-configured-not-witnessed"]');
    expect(text).toContain('controllerRuns=1/1 missingSnapshot=0 malformedSnapshots=0');

    const dir2 = await mkrun(root, 'run-b');
    snapshot(dir2, 1, {
      coverage: { basis: 'assistant-records-last-per-request', partialCounters: ['inputTokens'] },
    });
    const text2 = reportModule.render(report(root, ['run-b']));
    expect(text2).toContain('controllerPartialCounters=["inputTokens"]');
    expect(text).toContain('controller=measured(snapshots=1)');
    expect(text.trimEnd().split('\n').at(-1)).toBe(data.money.line);
  });
});
