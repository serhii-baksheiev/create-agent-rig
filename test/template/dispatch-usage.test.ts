import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-226 — passive Claude usage capture, added to the RP-225 dispatch-end
// event by `record-dispatch.mjs` on `SubagentStop`. Accepted design (Jira
// RP-226 body):
//
//   - reads ONLY the hook payload's `agent_transcript_path`, and only when
//     its basename is exactly `agent-<agent_id>.jsonl` for the payload's own
//     `agent_id` — never falls back to `transcript_path` (the parent's);
//   - bounded: at most 32 MiB total, 8 MiB per line, 3s — exceeding any bound
//     records `usageUnavailable: '<reason>'`, never a partial number;
//   - parses JSONL assistant messages' `message.usage` (`input_tokens`,
//     `output_tokens`, `cache_creation_input_tokens`,
//     `cache_read_input_tokens`); dedupes by `requestId ?? message.id`, last
//     occurrence wins; sums; `requests` is the count of distinct ids;
//   - a counter absent from EVERY record in the transcript stays
//     absent/null — never inferred, never zero;
//   - `measuredModel` from `message.model` only when every record agrees;
//   - a malformed JSON line anywhere in the transcript makes the whole
//     dispatch `usageUnavailable` — pinned here, not "skip and count the
//     rest", for truthfulness;
//   - never persists a transcript path or message content into the journal;
//   - Codex is untouched by this ticket (RP-227).
//
// The reader, `token-report.mjs` (RP-228, not yet merged into this branch),
// consumes exactly `usage: { evidenceSource, requests, inputTokens,
// outputTokens, cacheCreationInputTokens, cacheReadInputTokens }` off a
// `dispatch-end` event's `data.usage`.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const hookPath = path.join(hooksDir, 'record-dispatch.mjs');
const runJournalUrl = pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href;
const tokenReportPath = path.join(scriptsDir, 'token-report.mjs');

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface JournalRecord {
  seq: number;
  at: string;
  kind?: string;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Spawn the hook exactly as Claude Code would: argv flags, JSON payload on stdin. */
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

const dispatch = (fields: Record<string, unknown>): Record<string, unknown> => ({
  hook_event_name: 'SubagentStop',
  session_id: 'sess-usage-1',
  agent_id: 'usage-agent',
  agent_type: 'code-reviewer',
  cwd: '/private/workdir',
  permission_mode: 'default',
  agent_transcript_path: '/private/workdir/.claude/transcripts/agent-usage-agent.jsonl',
  last_assistant_message: 'done',
  ...fields,
});

async function readEvents(dir: string): Promise<JournalRecord[]> {
  const { readRun } = (await import(runJournalUrl)) as {
    readRun(input: { runDir: string }): { events: JournalRecord[] };
  };
  return readRun({ runDir: dir }).events;
}

async function eventsFileBytes(dir: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(path.join(dir, 'events.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

interface AssistantRecordInput {
  requestId?: string;
  messageId?: string;
  model?: string;
  usage?: Record<string, number>;
  content?: string;
}

/** One JSONL line shaped like a Claude Code transcript's assistant message. */
function assistantLine({
  requestId,
  messageId = 'msg-default',
  model,
  usage,
  content,
}: AssistantRecordInput): string {
  const message: Record<string, unknown> = { id: messageId, role: 'assistant' };
  if (model !== undefined) message.model = model;
  if (usage !== undefined) message.usage = usage;
  if (content !== undefined) message.content = content;
  const record: Record<string, unknown> = { type: 'assistant', message };
  if (requestId !== undefined) record.requestId = requestId;
  return JSON.stringify(record);
}

let transcriptDir: string;
let runDir: string;

beforeEach(async () => {
  transcriptDir = await mkdtemp(path.join(tmpdir(), 'dispatch-usage-transcripts-'));
  runDir = await mkdtemp(path.join(tmpdir(), 'dispatch-usage-run-'));
});

afterEach(async () => {
  await removeFixture(transcriptDir);
  await removeFixture(runDir);
});

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  RIG_RUN_DIR: runDir,
  CLAUDE_PROJECT_DIR: '',
});

/** Writes `lines` (already-JSON strings) to `<transcriptDir>/agent-<agentId>.jsonl`. */
async function writeTranscript(agentId: string, lines: string[]): Promise<string> {
  const file = path.join(transcriptDir, `agent-${agentId}.jsonl`);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

describe('record-dispatch.mjs — Claude usage capture on SubagentStop (RP-226)', () => {
  it('sums input/output tokens across distinct requestIds, and counts requests as the number of distinct ids', async () => {
    const agentId = 'sum-basic';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        messageId: 'msg-1a',
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      assistantLine({
        requestId: 'req-2',
        messageId: 'msg-2',
        usage: { input_tokens: 200, output_tokens: 40 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.requests).toBe(2);
    expect(usage?.inputTokens).toBe(300);
    expect(usage?.outputTokens).toBe(60);
    expect(usage?.evidenceSource).toBe('claude-subagent-transcript');
  });

  it('dedupes by requestId: the same requestId appearing twice is counted once, with the LAST occurrence winning', async () => {
    const agentId = 'dedupe-requestid';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        messageId: 'msg-1a',
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      assistantLine({
        requestId: 'req-1',
        messageId: 'msg-1b',
        usage: { input_tokens: 150, output_tokens: 30 },
      }),
      assistantLine({
        requestId: 'req-2',
        messageId: 'msg-2',
        usage: { input_tokens: 200, output_tokens: 40 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    // req-1 must contribute its LAST occurrence's numbers (150/30), not the
    // first (100/20) and not both summed together.
    expect(usage?.requests).toBe(2);
    expect(usage?.inputTokens).toBe(350);
    expect(usage?.outputTokens).toBe(70);
  });

  it('falls back to message.id for dedup when a record carries no requestId', async () => {
    const agentId = 'dedupe-message-id';
    const file = await writeTranscript(agentId, [
      assistantLine({ messageId: 'msg-a', usage: { input_tokens: 10, output_tokens: 5 } }),
      assistantLine({ messageId: 'msg-a', usage: { input_tokens: 15, output_tokens: 8 } }),
      assistantLine({ messageId: 'msg-b', usage: { input_tokens: 20, output_tokens: 9 } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.requests).toBe(2);
    expect(usage?.inputTokens).toBe(35);
    expect(usage?.outputTokens).toBe(17);
  });

  it('sums a cache counter present on every assistant record in the transcript', async () => {
    const agentId = 'cache-present-all';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 1,
        },
      }),
      assistantLine({
        requestId: 'req-2',
        usage: {
          input_tokens: 20,
          output_tokens: 6,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.cacheCreationInputTokens).toBe(5);
    expect(usage?.cacheReadInputTokens).toBe(5);
  });

  it('sums a cache counter present on some assistant records and absent on others, from only the records that carry it', async () => {
    const agentId = 'cache-partial';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7 },
      }),
      assistantLine({
        requestId: 'req-2',
        usage: { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 3 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.cacheCreationInputTokens).toBe(7);
    expect(usage?.cacheReadInputTokens).toBe(3);
  });

  it('omits a cache counter absent from every assistant record in the transcript — never zero', async () => {
    const agentId = 'cache-absent-all';
    const file = await writeTranscript(agentId, [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: 10, output_tokens: 5 } }),
      assistantLine({ requestId: 'req-2', usage: { input_tokens: 20, output_tokens: 6 } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    // absent/null, never inferred, and never 0 standing in for "not measured".
    expect(usage?.cacheCreationInputTokens ?? null).toBeNull();
    expect(usage?.cacheReadInputTokens ?? null).toBeNull();
  });

  it('records measuredModel when every assistant record names the same model', async () => {
    const agentId = 'model-agree';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      assistantLine({
        requestId: 'req-2',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 20, output_tokens: 6 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.measuredModel).toBe('claude-sonnet-5');
  });

  it('omits measuredModel when assistant records disagree on the model', async () => {
    const agentId = 'model-disagree';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      assistantLine({
        requestId: 'req-2',
        model: 'claude-opus-5',
        usage: { input_tokens: 20, output_tokens: 6 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('measuredModel' in data).toBe(false);
  });

  it('does not attempt usage capture on Codex — neither usage nor usageUnavailable appears', async () => {
    const agentId = 'codex-untouched';
    const file = await writeTranscript(agentId, [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: 10, output_tokens: 5 } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('usage' in data).toBe(false);
    expect('usageUnavailable' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — usage is unavailable when the transcript cannot be trusted (RP-226)', () => {
  it('reports usageUnavailable when agent_transcript_path’s basename does not match agent-<agent_id>.jsonl for the payload’s own agent_id', async () => {
    const claimedAgentId = 'target-1';
    // Written under a DIFFERENT agent's correctly-shaped name — the basename
    // check must bind to the payload's OWN agent_id, not just the pattern.
    const file = await writeTranscript('someone-else', [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: 555555, output_tokens: 555555 } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: claimedAgentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect((data.usageUnavailable as string).length).toBeGreaterThan(0);
    expect('usage' in data).toBe(false);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('555555');
  });

  it('reports usageUnavailable and never reads transcript_path (the parent) when agent_transcript_path is absent', async () => {
    // A real usage-bearing file, but named via the PARENT field only. The
    // design forbids falling back to it — the sentinel below must never
    // appear, proving the file was never opened.
    const parentFile = await writeTranscript('parent-only', [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: 424242, output_tokens: 424242 } }),
    ]);
    const payload = dispatch({ agent_id: 'no-agent-transcript-path', transcript_path: parentFile });
    delete payload.agent_transcript_path;
    const result = await runHook(JSON.stringify(payload), env(), ['--harness=claude']);
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('424242');
    expect(bytes).not.toContain(parentFile);
  });

  it('reports usageUnavailable, with no partial numbers, when a single line exceeds the per-line bound (8 MiB)', async () => {
    const agentId = 'oversized-line';
    const MAX_LINE_BYTES = 8 * 1024 * 1024;
    const padding = 'x'.repeat(MAX_LINE_BYTES + 200_000); // safely over the 8 MiB per-line bound
    const oversized = assistantLine({
      requestId: 'req-oversized',
      usage: { input_tokens: 999, output_tokens: 999 },
      content: padding,
    });
    const file = await writeTranscript(agentId, [
      // A valid, small, earlier record — its numbers must NOT leak through as
      // a partial sum once the oversized line is hit.
      assistantLine({ requestId: 'req-small', usage: { input_tokens: 7, output_tokens: 3 } }),
      oversized,
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
    const bytes = await eventsFileBytes(runDir);
    // Neither the small record's numbers nor any fragment of the padding
    // reached the journal as a partial result.
    expect(bytes).not.toContain('"requests":1');
  }, 20_000);

  it('reports usageUnavailable, with no partial numbers, when the transcript exceeds the total-size bound (32 MiB)', async () => {
    const agentId = 'oversized-total';
    const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
    const lineTemplate = (index: number) =>
      assistantLine({
        requestId: `req-${index}`,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: 'y'.repeat(900),
      });
    const targetBytes = MAX_TOTAL_BYTES + 2 * 1024 * 1024; // safely over the 32 MiB total bound
    const lines: string[] = [];
    let total = 0;
    let index = 0;
    while (total < targetBytes) {
      const line = lineTemplate(index);
      lines.push(line);
      total += line.length + 1;
      index += 1;
    }
    const file = await writeTranscript(agentId, lines);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
    // `index` distinct requestIds were written; a partial sum would report
    // that many requests. It must report none at all.
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain(`"requests":${index}`);
  }, 20_000);

  it('reports usageUnavailable, not a partial sum, when the transcript contains a malformed JSON line', async () => {
    const agentId = 'malformed-line';
    const file = await writeTranscript(agentId, [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: 11, output_tokens: 22 } }),
      '{not valid json at all',
      assistantLine({ requestId: 'req-2', usage: { input_tokens: 33, output_tokens: 44 } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — usage capture never leaks transcript content or paths (RP-226)', () => {
  it('never carries the transcript path or assistant message content in the journal record', async () => {
    const agentId = 'no-leak';
    const canaryContent = 'SENTINEL-DO-NOT-PERSIST-ASSISTANT-CONTENT';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        usage: { input_tokens: 9, output_tokens: 4 },
        content: canaryContent,
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain(canaryContent);
    expect(bytes).not.toContain(file);
    expect(bytes).not.toContain(transcriptDir);
  });
});

describe('record-dispatch.mjs — usage/measuredModel are allowlisted DISPATCH_FIELDS (RP-226)', () => {
  it('exports DISPATCH_FIELDS containing usage, usageUnavailable, and measuredModel', async () => {
    const module = (await import(pathToFileURL(hookPath).href)) as {
      DISPATCH_FIELDS?: readonly string[];
    };
    const fields = new Set(module.DISPATCH_FIELDS ?? []);
    for (const key of ['usage', 'usageUnavailable', 'measuredModel']) {
      expect(fields.has(key), `DISPATCH_FIELDS is missing "${key}"`).toBe(true);
    }
  });
});

describe('token-report.mjs — reads Claude usage off a dispatch-end event (RP-226 × RP-228)', () => {
  it('shows the Claude usage and the "usage measured; monetary cost unavailable" money line for a run with a measured dispatch-end', async () => {
    const agentId = 'e2e-agent';
    const file = await writeTranscript(agentId, [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: 100, output_tokens: 50 } }),
    ]);
    const e = env();
    await runHook(
      JSON.stringify(
        dispatch({
          hook_event_name: 'SubagentStart',
          agent_id: agentId,
          agent_transcript_path: file,
        }),
      ),
      e,
      ['--harness=claude'],
    );
    await runHook(
      JSON.stringify(
        dispatch({
          hook_event_name: 'SubagentStop',
          agent_id: agentId,
          agent_transcript_path: file,
        }),
      ),
      e,
      ['--harness=claude'],
    );

    const { readRun } = (await import(runJournalUrl)) as {
      readRun(input: { runDir: string }): {
        decisions: unknown[];
        events: JournalRecord[];
      };
    };
    const run = readRun({ runDir });

    // token-report.mjs is RP-228's own script — read here, not vendored, so
    // this test fails on a missing module until RP-228 lands, exactly as the
    // Red step requires.
    const { tokenReportOf, render } = (await import(pathToFileURL(tokenReportPath).href)) as {
      tokenReportOf(input: {
        runs: Array<{ run: string; decisions: unknown[]; events: JournalRecord[] }>;
        since: string;
      }): {
        dispatchGroups: Array<{ usage: { claude: Record<string, unknown> | null } }>;
        money: { line: string };
      };
      render(report: unknown): string;
    };

    const report = tokenReportOf({
      runs: [{ run: 'fixture-run', decisions: run.decisions, events: run.events }],
      since: '2000-01-01T00:00:00.000Z',
    });

    expect(report.money.line).toBe('usage measured; monetary cost unavailable');
    const group = report.dispatchGroups[0];
    expect(group?.usage.claude).toMatchObject({ inputTokens: 100, outputTokens: 50, requests: 1 });

    const text = render(report);
    expect(text.endsWith('usage measured; monetary cost unavailable\n')).toBe(true);
  });
});
