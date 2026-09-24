// RP-228: `.claude/scripts/token-report.mjs` — a read-only report turning the
// dispatch evidence RP-225 already journals (`dispatch-start`/`dispatch-end`
// events, `.claude/hooks/record-dispatch.mjs`) into engineering economics: how
// many tokens moved, for which ticket, dispatched by which controller/harness,
// as which agent role, declared for which model/effort — correlated with the
// selection loop's own `item-selection` decisions and the reviewer fan-out's
// `reviewer-fan-out`/per-reviewer decisions already in the run journal.
//
// It is shaped like its siblings in the same directory
// (`release-evidence.mjs`, `revalidation-report.mjs`): a pure function over
// already-read runs (`tokenReportOf({ runs, since })`), reusing
// `revalidation-report.mjs`'s `readRuns` (a run `readRun` refuses is counted
// under `runs.skipped`, with why, never dropped silently), plus a thin CLI —
//
//   node .claude/scripts/token-report.mjs --since <ISO> [--runs <dir>] [--json]
//
// — that is read-only and refuses `--pricing` (and anything else it does not
// know) as an unrecognised argument: this PR ships usage-measurement only,
// never a monetary estimate. The default text output, and the JSON output's
// `money.line`, is exactly one of two sentences (Jira RP-225 comment 20198):
//
//   'usage measured; monetary cost unavailable'      — at least one dispatch
//                                                       anywhere in the runs
//                                                       read carries a `usage`
//                                                       object
//   'usage unavailable; monetary cost unavailable'    — otherwise
//
// `money.estimate` is always `null` — the optional API-equivalent estimate
// from a user-supplied dated pricing file is explicitly deferred, not in this
// PR.
//
// THE CONTRACT THIS FILE PINS (assumed — token-report.mjs does not exist yet,
// so every test below is Red on the same "Cannot find module" reason):
//
//   tokenReportOf({ runs, since }) => {
//     since,
//     runs: { read: number, skipped: [{ run, why }] },
//
//     // One row per (run, controller, harness, ticket, agentType, model,
//     // effort) combination actually seen in a `dispatch-start` event — the
//     // grouping order the item names: run -> controller/harness -> ticket
//     // -> agentType -> model/effort. `controller`/`harness`/`agentType` are
//     // `'unknown'` when the dispatch record carries no such field (never
//     // guessed); `ticket` is `'no-ticket'` before the run's first `taken`
//     // selection. `model`/`effort` are the dispatch's own `declaredModel`/
//     // `declaredEffort` when present (`modelSource`/`effortSource`:
//     // `'declared'`), else `'unknown'` (`modelSource`/`effortSource`:
//     // `'unknown'`) — this PR never infers a model from anywhere else.
//     dispatchGroups: [{
//       key, run, controller, harness, ticket, agentType,
//       model, modelSource, effort, effortSource,
//       dispatches: { ended: number, noEndObserved: number },
//       usage: {
//         claude: null | { evidenceSource, requests, inputTokens, outputTokens,
//                           cacheCreationInputTokens, cacheReadInputTokens },
//         codex: null | { inputTokens, cachedInputTokens, outputTokens,
//                          reasoningOutputTokens },
//       },
//     }],
//
//     // One entry per ticket id seen across EVERY run read (attempts is a
//     // count across runs, not scoped to one run) — plus one `'no-ticket'`
//     // entry for dispatch/decision activity before any run's first `taken`
//     // selection. Ticket ATTRIBUTION (which ticket a record belongs to) is
//     // the latest `item-selection` decision whose verdict matches
//     // `/^taken (.+)$/` at a smaller seq — a `stopped ...` selection is
//     // invisible to attribution and does not open a new ticket. Each
//     // `taken <id>` selection opens exactly one OCCURRENCE, whose WINDOW
//     // (used for gateRounds/reviewerOutcomes/outcome/wallTimeMs/dispatches
//     // below) runs from that decision's own seq up to the seq of the very
//     // next `item-selection` decision of ANY verdict (including `stopped`),
//     // or the run end when there is none after it.
//     tickets: [{
//       ticket, attempts: number,
//       occurrences: [{
//         run, seq, at,
//         gateRounds: number,               // count of `reviewer-fan-out`
//                                            // decisions in the window
//         reviewerOutcomes: {                // verdict tally per reviewer
//           [reviewerGateName]: { [verdict]: number },
//         },
//         outcome: null | { [reviewerGateName]: verdict }, // the LAST
//                                            // reviewer-fan-out round's
//                                            // verdicts in the window; null
//                                            // when the window has none
//         wallTimeMs: number | null,        // null for the synthetic
//                                            // 'no-ticket' bucket, which has
//                                            // no selection to measure from
//         dispatches: 'unavailable' | { ended: number, noEndObserved: number },
//       }],
//     }],
//
//     money: { line: string, estimate: null },
//   }
//
// Dispatch pairing: a `dispatch-start`/`dispatch-end` pair sharing the same
// `agentRef` is `ended`; a `dispatch-start` with no matching `dispatch-end`
// is `noEndObserved`; a run that journals NO dispatch event at all (neither
// kind) reports `dispatches: 'unavailable'` for every occurrence in that run
// — never `0`, which would read as "checked and found none" (the same
// distinction `lib/gate-coverage.mjs`'s `witness` answer makes for the same
// underlying evidence).
//
// Usage categories are never summed across harnesses: a Claude dispatch and a
// Codex dispatch are different `dispatchGroups` rows (different `harness`),
// each carrying only its own harness's usage object; the other harness's slot
// stays `null` on that row rather than a merged/zeroed total.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const reportScript = path.join(scriptsDir, 'token-report.mjs');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

interface JournalRecord {
  seq: number;
  at: string;
  kind?: string;
  gate?: string;
  verdict?: string;
  headSha?: string;
  reviewers?: string[];
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
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
  endRun: (input: { runDir: string; stop: string; now: string }) => JournalRecord;
  readRun: (input: { runDir: string }) => {
    decisions: JournalRecord[];
    events: JournalRecord[];
    ended: boolean;
  };
};

// Only imported once the module exists — every test below fails on this
// import until then, which is the expected Red-step reason.
let reportModule: {
  tokenReportOf: (input: { runs: unknown[]; since: string }) => Report;
} | null = null;
try {
  reportModule = (await import(pathToFileURL(reportScript).href)) as typeof reportModule;
} catch {
  reportModule = null;
}

interface ClaudeUsage {
  evidenceSource: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface DispatchGroup {
  key: string;
  run: string;
  controller: string;
  harness: string;
  ticket: string;
  agentType: string;
  model: string;
  modelSource: 'declared' | 'unknown';
  effort: string;
  effortSource: 'declared' | 'unknown';
  dispatches: { ended: number; noEndObserved: number };
  usage: { claude: ClaudeUsage | null; codex: CodexUsage | null };
}

interface Occurrence {
  run: string;
  seq: number | null;
  at: string | null;
  gateRounds: number;
  reviewerOutcomes: Record<string, Record<string, number>>;
  outcome: Record<string, string> | null;
  wallTimeMs: number | null;
  dispatches: 'unavailable' | { ended: number; noEndObserved: number };
}

interface TicketGroup {
  ticket: string;
  attempts: number;
  occurrences: Occurrence[];
}

interface Report {
  since: string;
  runs: { read: number; skipped: Array<{ run: string; why: string }> };
  dispatchGroups: DispatchGroup[];
  tickets: TicketGroup[];
  money: { line: string; estimate: null };
}

const SINCE = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-24T10:00:00.000Z';
const T2 = '2026-09-24T10:00:05.000Z';
const T3 = '2026-09-24T10:00:10.000Z';
const T4 = '2026-09-24T10:00:15.000Z';
const T5 = '2026-09-24T10:00:20.000Z';
const T6 = '2026-09-24T10:00:25.000Z';

const HEAD = 'abc1234';

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const node = (script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  run(process.execPath, [script, ...args], cwd, env);

const cli = (args: string[], cwd = repoRoot) => node(reportScript, args, cwd, withoutGitLocation());

const cliJson = async (args: string[]): Promise<{ code: number; out: string; data: Report }> => {
  const result = await cli([...args, '--json']);
  expect(result.stdout, result.out).not.toBe('');
  return { code: result.code, out: result.out, data: JSON.parse(result.stdout) as Report };
};

/** A fresh empty run-directories root — never removed explicitly, matching
 * the sibling report tests (`release-evidence.test.ts`). */
const runsRoot = () => mkdtemp(path.join(tmpdir(), 'token-report-runs-'));

const mkrun = async (runsDir: string, name: string): Promise<string> => {
  const dir = path.join(runsDir, name);
  await mkdir(dir, { recursive: true });
  return dir;
};

/** Every run directory under `runsDir`, read through the same `readRun` every
 * gate uses — deliberately independent of whatever internal reading
 * `token-report.mjs` does itself. */
const readRuns = async (
  runsDir: string,
): Promise<
  Array<{ run: string; decisions?: JournalRecord[]; events?: JournalRecord[]; error?: string }>
> => {
  const names = (await readdir(runsDir)).sort();
  return names.map((name) => {
    try {
      const { decisions, events } = journal.readRun({ runDir: path.join(runsDir, name) });
      return { run: name, decisions, events };
    } catch (error) {
      return { run: name, error: String((error as Error)?.message ?? error) };
    }
  });
};

/** Snapshot of file contents below `dir`, keyed by relative path. */
const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (sub: string) => {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.posix.join(sub, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else out[rel] = await readFile(path.join(dir, rel), 'utf8');
    }
  };
  await walk('.');
  return out;
};

const dispatchStart = (runDir: string, now: string, data: Record<string, unknown>): JournalRecord =>
  journal.recordEvent({ runDir, kind: 'dispatch-start', data: { schema: 1, ...data }, now });

const dispatchEnd = (runDir: string, now: string, data: Record<string, unknown>): JournalRecord =>
  journal.recordEvent({ runDir, kind: 'dispatch-end', data: { schema: 1, ...data }, now });

const claudeUsage = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
  evidenceSource: 'transcript',
  requests: 3,
  inputTokens: 1000,
  outputTokens: 200,
  cacheCreationInputTokens: 50,
  cacheReadInputTokens: 10,
  ...over,
});

const codexUsage = (over: Partial<CodexUsage> = {}): CodexUsage => ({
  inputTokens: 800,
  cachedInputTokens: 40,
  outputTokens: 150,
  reasoningOutputTokens: 60,
  ...over,
});

describe('token-report.mjs is read-only', () => {
  it('leaves the run-directory tree byte-identical after tokenReportOf and the CLI both run', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-1',
      now: T1,
    });
    dispatchStart(runA, T2, { harness: 'claude', agentType: 'code-reviewer', agentRef: 'r1' });
    dispatchEnd(runA, T3, { harness: 'claude', agentType: 'code-reviewer', agentRef: 'r1' });

    const before = await snapshot(runsDir);
    expect(reportModule, 'token-report.mjs does not export tokenReportOf yet').not.toBeNull();
    reportModule!.tokenReportOf({ runs: await readRuns(runsDir), since: SINCE });
    const result = await cli(['--runs', runsDir, '--since', SINCE, '--json']);
    expect(result.code, result.out).toBe(0);
    const after = await snapshot(runsDir);
    expect(after).toEqual(before);
  });

  it('contains no write-call literal in its own source', async () => {
    const source = await readFile(reportScript, 'utf8');
    for (const literal of [
      'writeFileSync(',
      'appendFileSync(',
      'mkdirSync(',
      'rmSync(',
      'unlinkSync(',
      'writeFile(',
      'appendFile(',
    ]) {
      expect(source, `${reportScript} calls ${literal}`).not.toContain(literal);
    }
  });
});

describe('token-report.mjs money line', () => {
  it('reads "usage measured; monetary cost unavailable" when any dispatch anywhere carries usage', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-1',
      now: T1,
    });
    dispatchStart(runA, T2, { harness: 'claude', agentType: 'code-reviewer', agentRef: 'r1' });
    dispatchEnd(runA, T3, {
      harness: 'claude',
      agentType: 'code-reviewer',
      agentRef: 'r1',
      usage: claudeUsage(),
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.money).toEqual({
      line: 'usage measured; monetary cost unavailable',
      estimate: null,
    });
  });

  it('reads "usage unavailable; monetary cost unavailable" when no dispatch anywhere carries usage', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-1',
      now: T1,
    });
    dispatchStart(runA, T2, { harness: 'claude', agentType: 'code-reviewer', agentRef: 'r1' });
    dispatchEnd(runA, T3, { harness: 'claude', agentType: 'code-reviewer', agentRef: 'r1' });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.money).toEqual({
      line: 'usage unavailable; monetary cost unavailable',
      estimate: null,
    });
  });

  it('an empty runs directory reads the unavailable money line, with zero runs read', async () => {
    const runsDir = await runsRoot();
    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.money.line).toBe('usage unavailable; monetary cost unavailable');
    expect(data.runs.read).toBe(0);
  });

  it('the text render ends with the money line', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-1',
      now: T1,
    });
    dispatchStart(runA, T2, { harness: 'claude', agentType: 'code-reviewer', agentRef: 'r1' });
    dispatchEnd(runA, T3, {
      harness: 'claude',
      agentType: 'code-reviewer',
      agentRef: 'r1',
      usage: claudeUsage(),
    });

    const result = await cli(['--runs', runsDir, '--since', SINCE]);
    expect(result.code, result.out).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('usage measured; monetary cost unavailable');
  });
});

describe('token-report.mjs dispatch grouping: run -> controller/harness -> ticket -> agentType -> model/effort', () => {
  it('groups one dispatch pair by its declared model/effort, with the ticket the selection named', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-10',
      now: T1,
    });
    dispatchStart(runA, T2, {
      harness: 'claude',
      controller: 'ctrl-1',
      agentType: 'code-reviewer',
      agentRef: 'r1',
      declaredModel: 'claude-sonnet-5',
      declaredEffort: 'high',
      declaredSource: 'agent-definition',
    });
    dispatchEnd(runA, T3, {
      harness: 'claude',
      controller: 'ctrl-1',
      agentType: 'code-reviewer',
      agentRef: 'r1',
      usage: claudeUsage(),
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.dispatchGroups).toHaveLength(1);
    const group = data.dispatchGroups[0]!;
    expect(group.run).toBe('run-a');
    expect(group.controller).toBe('ctrl-1');
    expect(group.harness).toBe('claude');
    expect(group.ticket).toBe('RP-10');
    expect(group.agentType).toBe('code-reviewer');
    expect(group.model).toBe('claude-sonnet-5');
    expect(group.modelSource).toBe('declared');
    expect(group.effort).toBe('high');
    expect(group.effortSource).toBe('declared');
    expect(group.dispatches).toEqual({ ended: 1, noEndObserved: 0 });
    expect(group.usage.claude).toEqual(claudeUsage());
    expect(group.usage.codex).toBeNull();
  });

  it('reports unknown (never guessed) for every field a dispatch record omits', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    dispatchStart(runA, T1, { agentRef: 'r1' });
    dispatchEnd(runA, T2, { agentRef: 'r1' });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.dispatchGroups).toHaveLength(1);
    const group = data.dispatchGroups[0]!;
    expect(group.controller).toBe('unknown');
    expect(group.harness).toBe('unknown');
    expect(group.ticket).toBe('no-ticket');
    expect(group.agentType).toBe('unknown');
    expect(group.model).toBe('unknown');
    expect(group.modelSource).toBe('unknown');
    expect(group.effort).toBe('unknown');
    expect(group.effortSource).toBe('unknown');
  });

  it('a Claude dispatch and a Codex dispatch under the same ticket and agent role render as two separate groups, never summed', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-11',
      now: T1,
    });
    dispatchStart(runA, T2, {
      harness: 'claude',
      agentType: 'code-reviewer',
      agentRef: 'r1',
    });
    dispatchEnd(runA, T3, {
      harness: 'claude',
      agentType: 'code-reviewer',
      agentRef: 'r1',
      usage: claudeUsage({ inputTokens: 111 }),
    });
    dispatchStart(runA, T4, {
      harness: 'codex',
      agentType: 'code-reviewer',
      agentRef: 'r2',
    });
    dispatchEnd(runA, T5, {
      harness: 'codex',
      agentType: 'code-reviewer',
      agentRef: 'r2',
      usage: codexUsage({ inputTokens: 222 }),
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.dispatchGroups).toHaveLength(2);
    const claude = data.dispatchGroups.find((g) => g.harness === 'claude')!;
    const codex = data.dispatchGroups.find((g) => g.harness === 'codex')!;
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    expect(claude.usage.claude?.inputTokens).toBe(111);
    expect(claude.usage.codex).toBeNull();
    expect(codex.usage.codex?.inputTokens).toBe(222);
    expect(codex.usage.claude).toBeNull();
  });
});

describe('token-report.mjs ticket attribution', () => {
  it('a dispatch before any selection in the run is bucketed under no-ticket', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    dispatchStart(runA, T1, { agentType: 'code-reviewer', agentRef: 'r1' });
    dispatchEnd(runA, T2, { agentType: 'code-reviewer', agentRef: 'r1' });
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-20',
      now: T3,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const noTicket = data.tickets.find((t) => t.ticket === 'no-ticket');
    expect(noTicket, JSON.stringify(data.tickets)).toBeDefined();
    expect(noTicket!.attempts).toBe(0);
    expect(data.dispatchGroups.find((g) => g.agentType === 'code-reviewer')!.ticket).toBe(
      'no-ticket',
    );
  });

  it('a "stopped" selection is invisible to attribution: dispatches after it still belong to the last taken ticket', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-30',
      now: T1,
    });
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'stopped budget',
      now: T2,
    });
    dispatchStart(runA, T3, { agentType: 'code-reviewer', agentRef: 'r1' });
    dispatchEnd(runA, T4, { agentType: 'code-reviewer', agentRef: 'r1' });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const group = data.dispatchGroups.find((g) => g.agentType === 'code-reviewer');
    expect(group, JSON.stringify(data.dispatchGroups)).toBeDefined();
    expect(group!.ticket).toBe('RP-30');
  });

  it('attempts counts "taken <id>" across every run read, not scoped to one run', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    const runB = await mkrun(runsDir, 'run-b');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-40',
      now: T1,
    });
    journal.recordDecision({
      runDir: runB,
      gate: 'item-selection',
      verdict: 'taken RP-40',
      now: T1,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-40');
    expect(ticket, JSON.stringify(data.tickets)).toBeDefined();
    expect(ticket!.attempts).toBe(2);
    expect(ticket!.occurrences).toHaveLength(2);
    expect(ticket!.occurrences.map((o) => o.run).sort()).toEqual(['run-a', 'run-b']);
  });
});

describe('token-report.mjs gate rounds, reviewer outcomes and final outcome', () => {
  it('counts reviewer-fan-out decisions in the window, tallies every round, and reports the last round as the outcome', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-50',
      now: T1,
    });
    journal.recordDecision({
      runDir: runA,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['code-reviewer'],
      headSha: HEAD,
      now: T2,
    });
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      headSha: HEAD,
      now: T3,
    });
    journal.recordDecision({
      runDir: runA,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['code-reviewer'],
      headSha: HEAD,
      now: T4,
    });
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'SHIP',
      headSha: HEAD,
      now: T5,
    });
    journal.endRun({ runDir: runA, stop: 'done', now: T6 });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-50');
    expect(ticket, JSON.stringify(data.tickets)).toBeDefined();
    const occurrence = ticket!.occurrences[0]!;
    expect(occurrence.gateRounds).toBe(2);
    expect(occurrence.reviewerOutcomes).toEqual({ 'code-reviewer': { HOLD: 1, SHIP: 1 } });
    expect(occurrence.outcome).toEqual({ 'code-reviewer': 'SHIP' });
  });

  it('a window with no reviewer-fan-out at all reports zero gate rounds and a null outcome', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-51',
      now: T1,
    });
    journal.endRun({ runDir: runA, stop: 'done', now: T2 });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-51');
    expect(ticket, JSON.stringify(data.tickets)).toBeDefined();
    const occurrence = ticket!.occurrences[0]!;
    expect(occurrence.gateRounds).toBe(0);
    expect(occurrence.outcome).toBeNull();
  });
});

describe('token-report.mjs wall time', () => {
  it('measures from the selection to the next selection, whatever its verdict', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-60',
      now: T1,
    });
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'stopped budget',
      now: T4,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-60');
    expect(ticket, JSON.stringify(data.tickets)).toBeDefined();
    expect(ticket!.occurrences[0]!.wallTimeMs).toBe(Date.parse(T4) - Date.parse(T1));
  });

  it('measures to the run end when there is no next selection', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-61',
      now: T1,
    });
    journal.endRun({ runDir: runA, stop: 'done', now: T5 });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-61');
    expect(ticket, JSON.stringify(data.tickets)).toBeDefined();
    expect(ticket!.occurrences[0]!.wallTimeMs).toBe(Date.parse(T5) - Date.parse(T1));
  });
});

describe('token-report.mjs dispatch pairing', () => {
  it('pairs a dispatch-start and dispatch-end sharing agentRef as ended', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-70',
      now: T1,
    });
    dispatchStart(runA, T2, { agentType: 'code-reviewer', agentRef: 'r1' });
    dispatchEnd(runA, T3, { agentType: 'code-reviewer', agentRef: 'r1' });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-70');
    expect(ticket!.occurrences[0]!.dispatches).toEqual({ ended: 1, noEndObserved: 0 });
    expect(data.dispatchGroups[0]!.dispatches).toEqual({ ended: 1, noEndObserved: 0 });
  });

  it('a dispatch-start with no matching dispatch-end counts as noEndObserved', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-71',
      now: T1,
    });
    dispatchStart(runA, T2, { agentType: 'code-reviewer', agentRef: 'r1' });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-71');
    expect(ticket!.occurrences[0]!.dispatches).toEqual({ ended: 0, noEndObserved: 1 });
    expect(data.dispatchGroups[0]!.dispatches).toEqual({ ended: 0, noEndObserved: 1 });
  });

  it('a run with no dispatch events at all reports dispatches as unavailable, never zero', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'item-selection',
      verdict: 'taken RP-72',
      now: T1,
    });
    journal.endRun({ runDir: runA, stop: 'done', now: T2 });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const ticket = data.tickets.find((t) => t.ticket === 'RP-72');
    expect(ticket, JSON.stringify(data.tickets)).toBeDefined();
    expect(ticket!.occurrences[0]!.dispatches).toBe('unavailable');
    expect(data.dispatchGroups).toEqual([]);
  });
});

describe('token-report.mjs skipped runs', () => {
  it('a run readRun refuses is counted under skipped, with why, and excluded from every other section', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    // seq 1 then 3 — the same gap shape `revalidation-evidence.test.ts` and
    // `release-evidence.test.ts` use to prove `readRun` refuses a broken
    // sequence.
    await writeFile(
      path.join(runA, 'events.jsonl'),
      [
        JSON.stringify({ seq: 1, at: T1, kind: 'dispatch-start', data: { agentRef: 'r1' } }),
        JSON.stringify({ seq: 3, at: T2, kind: 'dispatch-end', data: { agentRef: 'r1' } }),
      ].join('\n') + '\n',
    );

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.runs.read).toBe(0);
    expect(data.runs.skipped).toHaveLength(1);
    expect(data.runs.skipped[0]!.run).toBe('run-a');
    expect(data.runs.skipped[0]!.why).toMatch(/seq|sequence/i);
    expect(data.dispatchGroups).toEqual([]);
    expect(data.tickets).toEqual([]);
    expect(data.money.line).toBe('usage unavailable; monetary cost unavailable');
  });
});

describe('token-report.mjs CLI', () => {
  it('exits 0 with a JSON document on --json', async () => {
    const runsDir = await runsRoot();
    const result = await cli(['--runs', runsDir, '--since', SINCE, '--json']);
    expect(result.code, result.out).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('exits 1 on an unrecognised argument, without printing anything to stdout', async () => {
    const runsDir = await runsRoot();
    const result = await cli(['--runs', runsDir, '--since', SINCE, '--bogus']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
  });

  it('refuses --pricing as an unrecognised argument — the optional estimate is deferred, not in this PR', async () => {
    const runsDir = await runsRoot();
    const result = await cli(['--runs', runsDir, '--since', SINCE, '--pricing', 'rates.json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
  });

  it('exits 1 without --since', async () => {
    const runsDir = await runsRoot();
    const result = await cli(['--runs', runsDir, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('exits 1 when the --runs directory cannot be listed', async () => {
    const runsDir = await runsRoot();
    const missing = path.join(runsDir, 'does-not-exist');
    const result = await cli(['--runs', missing, '--since', SINCE, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
  });
});
