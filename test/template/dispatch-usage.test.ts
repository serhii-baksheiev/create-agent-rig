import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
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
// The reader, `token-report.mjs` (RP-228, merged into this branch), consumes
// exactly `usage: { evidenceSource, requests, inputTokens, outputTokens,
// cacheCreationInputTokens, cacheReadInputTokens }` off a `dispatch-end`
// event's `data.usage`.

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

    // token-report.mjs is RP-228's own script (merged into this branch) —
    // read here as the real consumer, not vendored or re-implemented, so a
    // future contract drift between the two tickets fails this test rather
    // than going unnoticed.
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

// ── RP-226 fix round — code-reviewer-r1.md B2 ──────────────────────────────
//
// An empty (zero-byte) transcript, or one containing only records that never
// carry a keyed assistant `usage` (e.g. only `type: 'user'` records), must
// resolve to `usageUnavailable` with a specific reason code — never
// `usage: { requests: 0 }`, which `hasFiniteNumericField` in token-report.mjs
// reads as measured (0 is finite) and which nulls a real sibling's sum in the
// same dispatch group (code-reviewer-r1.md B2, probed and reproduced there).
describe('record-dispatch.mjs — an empty or usage-less transcript is usageUnavailable, never usage: {requests: 0} (code-reviewer-r1.md B2)', () => {
  it('reports usageUnavailable with code transcript-empty for a zero-byte transcript', async () => {
    const agentId = 'b2-empty-file';
    const file = path.join(transcriptDir, `agent-${agentId}.jsonl`);
    await writeFile(file, '', 'utf8');
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('transcript-empty');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with code no-usage-records for a transcript containing only user records', async () => {
    const agentId = 'b2-user-only';
    const file = await writeTranscript(agentId, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('no-usage-records');
    expect('usage' in data).toBe(false);
  });
});

describe('token-report.mjs — a group with a real dispatch and unmeasured siblings is not nulled by them (code-reviewer-r1.md B2)', () => {
  it('sums only the measured dispatch; the two usageUnavailable siblings neither null the sum nor count toward withUsage', async () => {
    const e = env();
    const sessionId = 'sess-b2-group';

    const realAgentId = 'b2-group-real';
    const realFile = await writeTranscript(realAgentId, [
      assistantLine({ requestId: 'req-real', usage: { input_tokens: 100, output_tokens: 50 } }),
    ]);

    const emptyAgentId = 'b2-group-empty';
    const emptyFile = path.join(transcriptDir, `agent-${emptyAgentId}.jsonl`);
    await writeFile(emptyFile, '', 'utf8');

    const userOnlyAgentId = 'b2-group-user-only';
    const userOnlyFile = await writeTranscript(userOnlyAgentId, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    ]);

    for (const { agentId, file } of [
      { agentId: realAgentId, file: realFile },
      { agentId: emptyAgentId, file: emptyFile },
      { agentId: userOnlyAgentId, file: userOnlyFile },
    ]) {
      await runHook(
        JSON.stringify(
          dispatch({
            hook_event_name: 'SubagentStart',
            session_id: sessionId,
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
            session_id: sessionId,
            agent_id: agentId,
            agent_transcript_path: file,
          }),
        ),
        e,
        ['--harness=claude'],
      );
    }

    const { readRun } = (await import(runJournalUrl)) as {
      readRun(input: { runDir: string }): { decisions: unknown[]; events: JournalRecord[] };
    };
    const run = readRun({ runDir });

    const { tokenReportOf } = (await import(pathToFileURL(tokenReportPath).href)) as {
      tokenReportOf(input: {
        runs: Array<{ run: string; decisions: unknown[]; events: JournalRecord[] }>;
        since: string;
      }): {
        dispatchGroups: Array<{
          dispatches: { ended: number; noEndObserved: number; withUsage?: number };
          usage: { claude: Record<string, unknown> | null };
        }>;
        money: { line: string };
      };
    };
    const report = tokenReportOf({
      runs: [{ run: 'fixture-run-b2-group', decisions: run.decisions, events: run.events }],
      since: '2000-01-01T00:00:00.000Z',
    });

    // All three dispatches share the same run/controller/harness/ticket
    // (no-ticket)/agentType/model/effort, so this is one group — exactly the
    // shape code-reviewer-r1.md's own probe used.
    expect(report.dispatchGroups).toHaveLength(1);
    const group = report.dispatchGroups[0];
    expect(group).toBeDefined();
    // Only the real dispatch carried usage: withUsage = 1, out of 3 ended.
    expect(group?.dispatches).toEqual({ ended: 3, noEndObserved: 0, withUsage: 1 });
    // The group's sum reflects ONLY the measured dispatch — not nulled by
    // the two usageUnavailable siblings, and cache counters (absent from the
    // one contributing raw) stay null rather than being inferred as zero.
    expect(group?.usage.claude).toEqual({
      evidenceSource: 'claude-subagent-transcript',
      requests: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    expect(report.money.line).toBe('usage measured; monetary cost unavailable');
  });
});

// ── RP-226 fix round — code-reviewer-r1.md B3 ──────────────────────────────
//
// The 3 s wall-time bound (`MAX_TRANSCRIPT_MS`, checked between read chunks)
// has no test that demonstrates it, and a real sleep-based test would be a
// timing race. This drives the bound deterministically by importing the
// hook's own reader with an injected clock — the Green step must export:
//
//   export function readClaudeTranscriptUsage(
//     file: string,
//     options?: { now?: () => number },
//   ): { usage: {...} } | { usageUnavailable: string }
//
// where the internal wall-clock reads (`Date.now()`, currently hardcoded at
// the top of the function and inside the read loop) go through `now` instead,
// defaulting to `Date.now` so every existing call site is unaffected.
describe('record-dispatch.mjs — readClaudeTranscriptUsage: a deterministic 3 s wall-time bound (code-reviewer-r1.md B3)', () => {
  it('reports transcript-timeout when an injected clock crosses the 3 s bound between two read chunks', async () => {
    const module = (await import(pathToFileURL(hookPath).href)) as {
      readClaudeTranscriptUsage?: (
        file: string,
        options?: { now?: () => number },
      ) => { usage?: Record<string, unknown>; usageUnavailable?: string };
    };
    expect(
      typeof module.readClaudeTranscriptUsage,
      'record-dispatch.mjs must export readClaudeTranscriptUsage(file, { now }) for this test to drive its 3 s bound deterministically',
    ).toBe('function');

    const agentId = 'b3-clock-timeout';
    // At least two 64 KiB read chunks, so the between-chunk clock check runs
    // more than once — the second call is where the injected jump lands.
    const lines: string[] = [];
    let total = 0;
    let i = 0;
    while (total < 150 * 1024) {
      const line = assistantLine({
        requestId: `req-${i}`,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      lines.push(line);
      total += line.length + 1;
      i += 1;
    }
    const file = await writeTranscript(agentId, lines);

    // start = now() -> 0; iteration 1's check: 0 - 0 = 0 (proceeds, reads a
    // chunk); iteration 2's check: 5000 - 0 = 5000 > 3000 (times out) —
    // never a real sleep.
    const clockValues = [0, 0, 5000];
    let callIndex = 0;
    const now = (): number => {
      const value = clockValues[callIndex] ?? clockValues[clockValues.length - 1] ?? 0;
      callIndex += 1;
      return value;
    };

    const result = module.readClaudeTranscriptUsage!(file, { now });
    expect(result).toEqual({ usageUnavailable: 'transcript-timeout' });
  });
});

// ── RP-226 fix round — code-reviewer-r1.md B1 ──────────────────────────────
//
// The reader re-copies (`Buffer.concat`, then `Buffer.from`) and rescans
// (`indexOf` from 0) the pending line on every 64 KiB chunk, which costs
// O(line-length²). code-reviewer-r1.md measured four ~8 MiB lines
// (33,553,704 bytes total, inside both the 32 MiB total and 8 MiB per-line
// bounds) timing out at 3279 ms. A genuine one-pass reader — new chunk
// scanned for `\n`, pending fragments tracked as a running length or a list
// of slices, concatenated once per complete line — processes the same input
// in a small fraction of that time.
//
// This is a real-clock bound, not a byte-counting structural oracle: an
// injectable copy/scan counter would need a stable instrumentation contract
// this fix round does not yet define (it depends on which one-pass shape the
// Green step picks — a running-length carry vs. a list of chunk slices), and
// inventing one is an implementation decision, not a test-writer's call. The
// bound below is deliberately generous — under 2000 ms against a measured
// 3279 ms failure and an expected low-hundreds-of-ms pass — to stay clear of
// both the reviewer's own measured timeout and ordinary host jitter.
describe('record-dispatch.mjs — readClaudeTranscriptUsage: one forward pass, not quadratic in line length (code-reviewer-r1.md B1)', () => {
  it('processes four ~7.9 MiB lines (inside both size bounds) well within the 3 s bound', async () => {
    const module = (await import(pathToFileURL(hookPath).href)) as {
      readClaudeTranscriptUsage?: (
        file: string,
        options?: { now?: () => number },
      ) => { usage?: Record<string, unknown>; usageUnavailable?: string };
    };
    expect(
      typeof module.readClaudeTranscriptUsage,
      'record-dispatch.mjs must export readClaudeTranscriptUsage(file, { now }) for this test to call it directly, without subprocess/journal overhead',
    ).toBe('function');

    const agentId = 'b1-one-pass';
    const file = path.join(transcriptDir, `agent-${agentId}.jsonl`);
    const LINE_CONTENT_BYTES = Math.floor(7.9 * 1024 * 1024);
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(file, { encoding: 'utf8' });
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      for (let i = 0; i < 4; i += 1) {
        const line = assistantLine({
          requestId: `req-big-${i}`,
          usage: { input_tokens: 10, output_tokens: 5 },
          content: 'x'.repeat(LINE_CONTENT_BYTES),
        });
        stream.write(`${line}\n`);
      }
      stream.end();
    });

    const startedAt = performance.now();
    const result = module.readClaudeTranscriptUsage!(file, { now: Date.now });
    const elapsedMs = performance.now() - startedAt;

    expect(
      elapsedMs,
      `readClaudeTranscriptUsage took ${elapsedMs}ms (in-bound input must not approach the 3 s bound)`,
    ).toBeLessThan(2000);
    expect(result.usageUnavailable).toBeUndefined();
    expect(result.usage?.requests).toBe(4);
    expect(result.usage?.inputTokens).toBe(40);
    expect(result.usage?.outputTokens).toBe(20);
  }, 20_000);
});

// ── RP-226 fix round — security-scanner-r1.md A1 ───────────────────────────
//
// `measuredModel` is currently journalled verbatim with no shape or length
// check, bounded only by the 8 MiB per-line cap — a forged transcript line
// can put up to ~8 MiB of arbitrary text (including terminal escapes) into
// the run journal. This pins an allowlist in the style of the hook's own
// `AGENT_TYPE_RE`: at most 128 characters, matching
// `^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$`. A model failing the allowlist means the
// dispatch still gets `usage` — only `measuredModel` is omitted. Token
// counters that are negative or fractional make the whole record
// `usageUnavailable: 'invalid-usage-counter'`, never a sum built from an
// out-of-range number.
describe('record-dispatch.mjs — measuredModel is allowlisted, and invalid usage counters refuse (security-scanner-r1.md A1)', () => {
  it('does not record measuredModel when message.model is a 7 KiB string, but still records usage', async () => {
    const agentId = 'a1-model-oversized';
    const hugeModel = 'm'.repeat(7 * 1024);
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        model: hugeModel,
        usage: { input_tokens: 10, output_tokens: 5 },
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
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.requests).toBe(1);
    expect(usage?.inputTokens).toBe(10);
  });

  it('does not record measuredModel when message.model contains an ESC control character, but still records usage, and ESC never reaches the journal', async () => {
    const agentId = 'a1-model-esc';
    const hostileModel = 'claude-sonnet-5\x1b[31mHACKED';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        model: hostileModel,
        usage: { input_tokens: 10, output_tokens: 5 },
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
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.requests).toBe(1);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('\x1b');
  });

  it('does not record measuredModel when it is 129 characters — one over the 128-character allowlist bound — but still records usage', async () => {
    const agentId = 'a1-model-over-bound';
    const overBoundModel = 'a'.repeat(129);
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        model: overBoundModel,
        usage: { input_tokens: 10, output_tokens: 5 },
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
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.requests).toBe(1);
  });

  it('records measuredModel at exactly the 128-character allowlist bound — a guard against an off-by-one in the Green step’s fix', async () => {
    const agentId = 'a1-model-at-bound';
    const atBoundModel = 'a'.repeat(128);
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        model: atBoundModel,
        usage: { input_tokens: 10, output_tokens: 5 },
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
    expect(data.measuredModel).toBe(atBoundModel);
  });

  it('records measuredModel for a normal Claude model id shape (claude-haiku-4-5-20251001) — a guard against the Green step’s allowlist rejecting real ids', async () => {
    const agentId = 'a1-model-normal-haiku';
    const file = await writeTranscript(agentId, [
      assistantLine({
        requestId: 'req-1',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 10, output_tokens: 5 },
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
    expect(data.measuredModel).toBe('claude-haiku-4-5-20251001');
  });

  it('reports usageUnavailable with code invalid-usage-counter for a negative token counter, not a sum', async () => {
    const agentId = 'a1-counter-negative';
    const file = await writeTranscript(agentId, [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: -5, output_tokens: 5 } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('invalid-usage-counter');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with code invalid-usage-counter for a fractional token counter, not a sum', async () => {
    const agentId = 'a1-counter-fractional';
    const file = await writeTranscript(agentId, [
      assistantLine({ requestId: 'req-1', usage: { input_tokens: 10.5, output_tokens: 5 } }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('invalid-usage-counter');
    expect('usage' in data).toBe(false);
  });
});
