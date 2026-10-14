import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-511 PR B — controller-session usage, the observe-only `Stop`/`SessionEnd`
// hook `record-session-usage.mjs` and the two controller readers in
// `hooks/lib/usage-readers.mjs`. Accepted design (owner decision 2026-10-14):
//
//   - one `controller-usage` event per snapshot, `cumulative: true`, keyed by
//     the same hashed `controller` a `dispatch-start` carries; the raw
//     `session_id` never reaches the journal;
//   - the path is refused before anything is opened unless its basename
//     carries the payload's own session id (`<id>.jsonl` on Claude,
//     `rollout-<stamp>-<id>.jsonl` on Codex);
//   - Claude: only records whose `sessionId` is the payload's are summed —
//     a resumed/forked file's foreign records are COUNTED, never summed;
//   - Codex: the first `session_meta.payload.id` must be the session id, and
//     the last own-thread `token_usage_record.thread_token_usage` is read as
//     the cumulative total (never summed across records);
//   - `sessionAggregate` (Claude `cost-state`) is carried as a diagnostic
//     only — marked undocumented, non-authoritative, non-additive — and its
//     `costUSD` is never copied; its absence changes nothing else;
//   - a repeated identical snapshot is not written twice; a changed one is;
//   - unknown is never zero: a counter absent from every record stays absent.
//
// The real-fixture case reads `test/fixtures/usage/claude-controller-2.1.296.jsonl`,
// a content-stripped copy of a live Claude Code 2.1.296 transcript: every
// record keeps `type`/`sessionId` (a `user` record keeps nothing else), an
// assistant record keeps `version`/`requestId`/`apiBlockIndex`/
// `message.{id,model,usage}`, `compact_boundary` markers keep their `subtype`,
// and the `cost-state` record keeps `modelUsage` as the harness wrote it —
// counters AND the `costUSD`/`totalCostUSD`/`webSearchRequests` fields the
// reader is shown to drop. No prompt, response or path text survives. The
// oracle is independent — a second, deliberately duplicated dedupe written
// here rather than imported (`.claude/rules/invariants.md`, the
// independent-oracle invariant).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const hookPath = path.join(hooksDir, 'record-session-usage.mjs');
const readersUrl = pathToFileURL(path.join(hooksDir, 'lib', 'usage-readers.mjs')).href;
const runJournalUrl = pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href;
const realFixture = path.join(
  repoRoot,
  'test',
  'fixtures',
  'usage',
  'claude-controller-2.1.296.jsonl',
);
const REAL_SESSION = '9a07ae2a-b3b3-5a79-a4ca-18d25e1676ac';

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface JournalRecord {
  seq: number;
  kind?: string;
  data?: Record<string, unknown> | null;
}

type Usage = Record<string, unknown>;

interface ReadResult {
  usage?: Usage;
  usageUnavailable?: string;
  coverage?: Record<string, unknown>;
  harnessVersion?: string;
  sessionAggregate?: Record<string, unknown>;
}

interface Readers {
  readClaudeControllerUsage(file: string, sessionId: string): ReadResult;
  readCodexControllerUsage(file: string, sessionId: string): ReadResult;
}

function runHook(stdin: string, env: NodeJS.ProcessEnv, argv: string[] = []): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookPath, ...argv],
      { env, timeout: 15_000 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.on('error', () => undefined);
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function readEvents(dir: string): Promise<JournalRecord[]> {
  const { readRun } = (await import(runJournalUrl)) as {
    readRun(input: { runDir: string }): { events: JournalRecord[] };
  };
  return readRun({ runDir: dir }).events;
}

const readers = async (): Promise<Readers> => (await import(readersUrl)) as Readers;

const SESSION = 'sess-ctrl-1';

interface ClaudeLine {
  sessionId?: string;
  requestId?: string;
  messageId?: string;
  model?: string;
  version?: string;
  usage?: Record<string, number>;
}

const claudeAssistant = ({
  sessionId = SESSION,
  requestId,
  messageId = 'msg-x',
  model = 'claude-sonnet-5',
  version = '2.1.296',
  usage,
}: ClaudeLine): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId,
    version,
    ...(requestId === undefined ? {} : { requestId }),
    message: { id: messageId, role: 'assistant', model, ...(usage === undefined ? {} : { usage }) },
  });

const compactBoundary = (sessionId = SESSION): string =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId });

const costState = (modelUsage: Record<string, unknown>, sessionId = SESSION): string =>
  JSON.stringify({ type: 'cost-state', sessionId, totalCostUSD: 12.5, modelUsage });

const codexMeta = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'session_meta',
    payload: { id, cli_version: '0.162.1', thread_source: 'user', ...extra },
  });

const codexUsage = (
  threadId: string,
  threadTokenUsage: Record<string, number>,
  responseId = `resp-${Math.random().toString(36).slice(2, 8)}`,
): string =>
  JSON.stringify({
    type: 'token_usage_record',
    payload: {
      response_id: responseId,
      root_turn_id: 'turn-1',
      session_id: threadId,
      thread_id: threadId,
      turn_id: 'turn-1',
      usage: { input_tokens: 1, output_tokens: 1 },
      turn_token_usage: threadTokenUsage,
      thread_token_usage: threadTokenUsage,
    },
  });

let dir: string;
let runDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'session-usage-files-'));
  runDir = await mkdtemp(path.join(tmpdir(), 'session-usage-run-'));
});

afterEach(async () => {
  await removeFixture(dir);
  await removeFixture(runDir);
});

async function writeLines(name: string, lines: string[]): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  RIG_RUN_DIR: runDir,
  CLAUDE_PROJECT_DIR: '',
});

const stopPayload = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    hook_event_name: 'Stop',
    session_id: SESSION,
    stop_hook_active: false,
    cwd: '/private/workdir',
    ...fields,
  });

describe('usage-readers.mjs — readClaudeControllerUsage (RP-511)', () => {
  it('sums only the payload session, dedupes by requestId with the last record winning, and counts foreign records', async () => {
    const file = await writeLines('t.jsonl', [
      claudeAssistant({
        requestId: 'req-1',
        messageId: 'a',
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 },
      }),
      claudeAssistant({
        requestId: 'req-1',
        messageId: 'a',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100 },
      }),
      claudeAssistant({
        requestId: 'req-2',
        messageId: 'b',
        usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 50 },
      }),
      claudeAssistant({
        sessionId: 'previous-session',
        requestId: 'req-old',
        usage: { input_tokens: 999_999, output_tokens: 1 },
      }),
      compactBoundary(),
      compactBoundary('previous-session'),
    ]);
    const { readClaudeControllerUsage } = await readers();
    const result = readClaudeControllerUsage(file, SESSION);
    expect(result.usage).toEqual({
      evidenceSource: 'claude-controller-transcript',
      requests: 2,
      inputTokens: 15,
      outputTokens: 10,
      cacheReadInputTokens: 150,
    });
    expect(result.coverage).toEqual({
      basis: 'assistant-records-last-per-request',
      assistantRecords: 3,
      dedupedRequests: 2,
      foreignSessionRecords: 1,
      compactBoundaries: 1,
    });
    expect(result.harnessVersion).toBe('2.1.296');
    expect(result.sessionAggregate).toBeUndefined();
    // unknown is never zero: cache_creation was on no record, so it is absent
    expect(result.usage).not.toHaveProperty('cacheCreationInputTokens');
  });

  it('reports no-usage-records when every usage-bearing record belongs to another session', async () => {
    const file = await writeLines('t.jsonl', [
      claudeAssistant({
        sessionId: 'other',
        requestId: 'r',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);
    const { readClaudeControllerUsage } = await readers();
    expect(readClaudeControllerUsage(file, SESSION)).toEqual({
      usageUnavailable: 'no-usage-records',
    });
  });

  it('carries cost-state as a labelled diagnostic without costUSD, and omits a harness version the records disagree on', async () => {
    const file = await writeLines('t.jsonl', [
      claudeAssistant({
        requestId: 'r1',
        version: '2.1.296',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      costState({
        'claude-sonnet-5': {
          inputTokens: 7,
          outputTokens: 8,
          cacheReadInputTokens: 9,
          cacheCreationInputTokens: 10,
          thinkingTokens: 0,
          costUSD: 1.25,
        },
        'bad model name!': { inputTokens: 1 },
      }),
      claudeAssistant({
        requestId: 'r2',
        version: '2.1.297',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ]);
    const { readClaudeControllerUsage } = await readers();
    const result = readClaudeControllerUsage(file, SESSION);
    expect(result.harnessVersion).toBeUndefined();
    expect(result.sessionAggregate).toEqual({
      evidenceSource: 'claude-cost-state',
      documented: false,
      authoritative: false,
      additive: false,
      models: {
        'claude-sonnet-5': {
          inputTokens: 7,
          outputTokens: 8,
          thinkingTokens: 0,
          cacheReadInputTokens: 9,
          cacheCreationInputTokens: 10,
        },
      },
      recordsBehind: 1,
    });
    expect(JSON.stringify(result)).not.toContain('costUSD');
    expect(JSON.stringify(result)).not.toContain('1.25');
  });

  it('rejects the whole read on one out-of-range counter, never a partial sum', async () => {
    const file = await writeLines('t.jsonl', [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 1, output_tokens: 2 } }),
      claudeAssistant({ requestId: 'r2', usage: { input_tokens: -5, output_tokens: 2 } }),
    ]);
    const { readClaudeControllerUsage } = await readers();
    expect(readClaudeControllerUsage(file, SESSION)).toEqual({
      usageUnavailable: 'invalid-usage-counter',
    });
  });

  it('agrees with an independent dedupe on the real 2.1.296 transcript fixture, and the fixture carries no prompt or response text', async () => {
    const raw = await readFile(realFixture, 'utf8');
    // The oracle: a second implementation of "own session, assistant records
    // with usage, last record per requestId ?? message.id wins, sum".
    const byKey = new Map<string, Record<string, number>>();
    let foreign = 0;
    let own = 0;
    let compactions = 0;
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      const record = JSON.parse(line) as {
        type: string;
        subtype?: string;
        sessionId?: string;
        requestId?: string;
        message?: { id?: string; usage?: Record<string, number>; content?: unknown };
      };
      expect(record.message?.content, 'fixture must carry no content').toBeUndefined();
      if (
        record.type === 'system' &&
        record.subtype === 'compact_boundary' &&
        record.sessionId === REAL_SESSION
      )
        compactions += 1;
      if (record.type !== 'assistant' || !record.message?.usage) continue;
      if (record.sessionId !== REAL_SESSION) {
        foreign += 1;
        continue;
      }
      own += 1;
      byKey.set(record.requestId ?? record.message.id ?? '', record.message.usage);
    }
    const sum = (field: string): number =>
      [...byKey.values()].reduce((acc, u) => acc + (u[field] ?? 0), 0);

    const { readClaudeControllerUsage } = await readers();
    const result = readClaudeControllerUsage(realFixture, REAL_SESSION);
    expect(result.usage).toEqual({
      evidenceSource: 'claude-controller-transcript',
      requests: byKey.size,
      inputTokens: sum('input_tokens'),
      outputTokens: sum('output_tokens'),
      cacheCreationInputTokens: sum('cache_creation_input_tokens'),
      cacheReadInputTokens: sum('cache_read_input_tokens'),
    });
    expect(result.coverage).toEqual({
      basis: 'assistant-records-last-per-request',
      assistantRecords: own,
      dedupedRequests: byKey.size,
      foreignSessionRecords: foreign,
      compactBoundaries: compactions,
    });
    expect(result.harnessVersion).toBe('2.1.296');
    // Measured live (L1/L3, 2026-10-14): the transcript's own records are
    // exclusive of the subagent that ran in this session, while cost-state's
    // haiku line carries exactly that subagent's 79 157 cache-creation tokens.
    const haiku = (result.sessionAggregate as { models: Record<string, Record<string, number>> })
      .models['claude-haiku-5-5'];
    expect(haiku?.cacheCreationInputTokens).toBe(79_157);
    expect(own).toBeGreaterThan(byKey.size); // several records per request: the dedupe is load-bearing
  });
});

describe('usage-readers.mjs — readCodexControllerUsage (RP-511)', () => {
  it('reads the last own-thread cumulative total, counts foreign-thread and compacted records, and never sums', async () => {
    const file = await writeLines('rollout.jsonl', [
      codexMeta('thread-A'),
      codexUsage(
        'thread-A',
        {
          input_tokens: 100,
          cached_input_tokens: 50,
          output_tokens: 10,
          reasoning_output_tokens: 2,
          total_tokens: 110,
        },
        'resp-1',
      ),
      JSON.stringify({ type: 'compacted', payload: {} }),
      codexUsage(
        'thread-A',
        {
          input_tokens: 300,
          cached_input_tokens: 150,
          output_tokens: 30,
          reasoning_output_tokens: 6,
          total_tokens: 330,
        },
        'resp-2',
      ),
      codexUsage('thread-child', { input_tokens: 999, output_tokens: 999 }, 'resp-3'),
    ]);
    const { readCodexControllerUsage } = await readers();
    const result = readCodexControllerUsage(file, 'thread-A');
    expect(result.usage).toEqual({
      evidenceSource: 'codex-controller-rollout',
      inputTokens: 300,
      cachedInputTokens: 150,
      outputTokens: 30,
      reasoningOutputTokens: 6,
    });
    expect(result.coverage).toEqual({
      basis: 'thread-cumulative-last-record',
      tokenUsageRecords: 2,
      distinctResponseIds: 2,
      foreignThreadRecords: 1,
      compactedRecords: 1,
    });
    expect(result.harnessVersion).toBe('0.162.1');
  });

  it('refuses a rollout whose first session_meta names another thread — a forked child carrying the parent meta second is still the child', async () => {
    const file = await writeLines('rollout.jsonl', [
      codexMeta('thread-child', { thread_source: 'subagent', parent_thread_id: 'thread-A' }),
      codexMeta('thread-A'),
      codexUsage('thread-A', { input_tokens: 1, output_tokens: 1 }),
    ]);
    const { readCodexControllerUsage } = await readers();
    expect(readCodexControllerUsage(file, 'thread-A')).toEqual({
      usageUnavailable: 'session-identity-mismatch',
    });
  });

  it('reports no-usage-records for an own rollout with no own-thread usage record', async () => {
    const file = await writeLines('rollout.jsonl', [
      codexMeta('thread-A'),
      codexUsage('thread-other', { input_tokens: 1 }),
    ]);
    const { readCodexControllerUsage } = await readers();
    expect(readCodexControllerUsage(file, 'thread-A')).toEqual({
      usageUnavailable: 'no-usage-records',
    });
  });
});

describe('record-session-usage.mjs — the Stop/SessionEnd hook (RP-511)', () => {
  it('journals one controller-usage event on Stop with only allowlisted fields and a hashed controller, exits 0 and prints nothing', async () => {
    const file = await writeLines(`${SESSION}.jsonl`, [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 4 } }),
    ]);
    const result = await runHook(stopPayload({ transcript_path: file }), env(), [
      '--harness=claude',
    ]);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });

    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe('controller-usage');
    const data = event.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        'controller',
        'coverage',
        'cumulative',
        'harness',
        'harnessVersion',
        'schema',
        'trigger',
        'usage',
      ].sort(),
    );
    expect(data.harness).toBe('claude');
    expect(data.trigger).toBe('Stop');
    expect(data.cumulative).toBe(true);
    expect(data.controller).toMatch(/^[0-9a-f]{16}$/);
    expect(data.controller).not.toBe(SESSION);
    expect(await readFile(path.join(runDir, 'events.jsonl'), 'utf8')).not.toContain(SESSION);
    expect(data.usage).toEqual({
      evidenceSource: 'claude-controller-transcript',
      requests: 1,
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  it('does not write a second event for an identical snapshot, but does for a changed one, and SessionEnd is a trigger too', async () => {
    const file = await writeLines(`${SESSION}.jsonl`, [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 4 } }),
    ]);
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    expect(await readEvents(runDir)).toHaveLength(1);

    await writeFile(
      file,
      `${claudeAssistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 4 } })}\n${claudeAssistant({ requestId: 'r2', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
    );
    await runHook(
      stopPayload({ hook_event_name: 'SessionEnd', transcript_path: file, reason: 'other' }),
      env(),
      ['--harness=claude'],
    );
    const events = await readEvents(runDir);
    expect(events).toHaveLength(2);
    const last = events[1]!.data as { trigger: string; usage: { requests: number } };
    expect(last.trigger).toBe('SessionEnd');
    expect(last.usage.requests).toBe(2);
  });

  it('still writes a lower snapshot after a higher one — the reader, not the hook, judges a non-monotonic sequence', async () => {
    const file = await writeLines(`${SESSION}.jsonl`, [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 30, output_tokens: 40 } }),
    ]);
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    await writeFile(
      file,
      `${claudeAssistant({ requestId: 'r9', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
    );
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    const events = await readEvents(runDir);
    expect(
      events.map((e) => (e.data as { usage: { inputTokens: number } }).usage.inputTokens),
    ).toEqual([30, 1]);
  });

  it('records usageUnavailable: transcript-path-mismatch when the basename does not carry the session id, without opening the file', async () => {
    const file = await writeLines('someone-else.jsonl', [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 4 } }),
    ]);
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    const [event] = await readEvents(runDir);
    expect((event!.data as Record<string, unknown>).usageUnavailable).toBe(
      'transcript-path-mismatch',
    );
    expect(event!.data).not.toHaveProperty('usage');
  });

  it('refuses a missing, UNC-shaped (any separator mix) or relative transcript_path before opening anything, on both harnesses', async () => {
    // None of these paths exists, so a reader that opened them would report
    // transcript-unreadable — the refusal codes prove nothing was opened.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['claude', {}, 'transcript-path-missing'],
      ['claude', { transcript_path: '' }, 'transcript-path-missing'],
      ['claude', { transcript_path: 42 }, 'transcript-path-missing'],
      ['claude', { transcript_path: `//host/share/${SESSION}.jsonl` }, 'transcript-path-unc'],
      ['claude', { transcript_path: `\\\\host\\share\\${SESSION}.jsonl` }, 'transcript-path-unc'],
      ['claude', { transcript_path: `/\\host\\share\\${SESSION}.jsonl` }, 'transcript-path-unc'],
      ['claude', { transcript_path: `\\/host/share/${SESSION}.jsonl` }, 'transcript-path-unc'],
      ['claude', { transcript_path: `relative/${SESSION}.jsonl` }, 'transcript-path-not-absolute'],
      ['codex', {}, 'transcript-path-missing'],
      [
        'codex',
        { transcript_path: `//host/share/rollout-2026-10-14T00-00-00-${SESSION}.jsonl` },
        'transcript-path-unc',
      ],
      [
        'codex',
        { transcript_path: `rollouts/rollout-2026-10-14T00-00-00-${SESSION}.jsonl` },
        'transcript-path-not-absolute',
      ],
      // A Codex basename that carries the id but is not a rollout file.
      ['codex', { transcript_path: `${dir}/${SESSION}.jsonl` }, 'transcript-path-mismatch'],
      ['codex', { transcript_path: `${dir}/other-${SESSION}.jsonl` }, 'transcript-path-mismatch'],
    ];
    // One run directory per case: an identical repeated snapshot — the same
    // reason code twice — is deduped on purpose, which would hide a case.
    for (const [harness, fields, expected] of cases) {
      const caseRun = await mkdtemp(path.join(tmpdir(), 'session-usage-refusal-'));
      const result = await runHook(stopPayload(fields), { ...env(), RIG_RUN_DIR: caseRun }, [
        `--harness=${harness}`,
      ]);
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      const events = await readEvents(caseRun);
      expect(events, JSON.stringify(fields)).toHaveLength(1);
      const data = events[0]!.data as Record<string, unknown>;
      expect(data.usageUnavailable, JSON.stringify(fields)).toBe(expected);
      expect(data).not.toHaveProperty('usage');
      await removeFixture(caseRun);
    }
  });

  it('names the controller by the same ref() a dispatch-start of the same session carries, never by the raw session id', async () => {
    const file = await writeLines(`${SESSION}.jsonl`, [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 4 } }),
    ]);
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    // The dispatch hook, fed a SubagentStart of the SAME session into the
    // same run directory.
    const dispatchHook = path.join(hooksDir, 'record-dispatch.mjs');
    await new Promise<void>((resolve) => {
      const child = execFile(
        process.execPath,
        [dispatchHook, '--harness=claude'],
        { env: env(), timeout: 15_000 },
        () => resolve(),
      );
      child.stdin?.end(
        JSON.stringify({
          hook_event_name: 'SubagentStart',
          session_id: SESSION,
          agent_id: 'agent-1',
          agent_type: 'code-reviewer',
          cwd: '/private/workdir',
          permission_mode: 'default',
        }),
      );
    });
    const events = await readEvents(runDir);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['controller-usage', 'dispatch-start']);
    const controller = (events[0]!.data as Record<string, unknown>).controller;
    expect(controller).toMatch(/^[0-9a-f]{16}$/);
    expect(controller).not.toBe(SESSION);
    expect((events[1]!.data as Record<string, unknown>).controller).toBe(controller);
  });

  it('writes a repeated snapshot regardless once the journal is past the repeated-snapshot check bound', async () => {
    const file = await writeLines(`${SESSION}.jsonl`, [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 4 } }),
    ]);
    const { recordEvent } = (await import(runJournalUrl)) as {
      recordEvent(input: {
        runDir: string;
        kind: string;
        data: Record<string, unknown>;
        now: string;
      }): JournalRecord;
    };
    // One event whose data is larger than MAX_SNAPSHOT_CHECK_BYTES (4 MiB)
    // puts events.jsonl past the bound; nothing in it is a controller-usage.
    recordEvent({
      runDir,
      kind: 'padding',
      data: { pad: 'x'.repeat(4 * 1024 * 1024 + 1) },
      now: '2026-10-14T00:00:00.000Z',
    });
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=claude']);
    const events = await readEvents(runDir);
    expect(events.map((e) => e.kind)).toEqual(['padding', 'controller-usage', 'controller-usage']);
  });

  it('binds a Codex rollout by its basename and reads the parent thread total with --harness=codex', async () => {
    const file = await writeLines(`rollout-2026-10-14T06-13-58-${SESSION}.jsonl`, [
      codexMeta(SESSION),
      codexUsage(SESSION, {
        input_tokens: 12,
        cached_input_tokens: 6,
        output_tokens: 3,
        reasoning_output_tokens: 1,
      }),
    ]);
    await runHook(stopPayload({ transcript_path: file }), env(), ['--harness=codex']);
    const [event] = await readEvents(runDir);
    const data = event!.data as Record<string, unknown>;
    expect(data.harness).toBe('codex');
    expect(data.usage).toEqual({
      evidenceSource: 'codex-controller-rollout',
      inputTokens: 12,
      cachedInputTokens: 6,
      outputTokens: 3,
      reasoningOutputTokens: 1,
    });
    expect(data.harnessVersion).toBe('0.162.1');
  });

  it('writes nothing for another event, for a missing harness flag, for no run directory, or for malformed stdin — and always exits 0 silently', async () => {
    const file = await writeLines(`${SESSION}.jsonl`, [
      claudeAssistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 4 } }),
    ]);
    const cases: Array<[string, NodeJS.ProcessEnv, string[]]> = [
      [
        stopPayload({ hook_event_name: 'SubagentStop', transcript_path: file }),
        env(),
        ['--harness=claude'],
      ],
      [stopPayload({ transcript_path: file }), env(), []],
      [
        stopPayload({ transcript_path: file }),
        { ...env(), RIG_RUN_DIR: '', HOME: dir, USERPROFILE: dir },
        ['--harness=claude'],
      ],
      ['{not json', env(), ['--harness=claude']],
    ];
    for (const [stdin, e, argv] of cases) {
      const result = await runHook(stdin, e, argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(await readEvents(runDir)).toHaveLength(0);
  });
});
