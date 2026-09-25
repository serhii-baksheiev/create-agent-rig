import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-227 — passive Codex usage capture, added to the RP-225 dispatch-end
// event by `record-dispatch.mjs` on `SubagentStop --harness=codex`, reading
// it after the fact from the child rollout (Jira RP-227, comment 20584 —
// the live correlation probe on codex-cli 0.156.1). Accepted design:
//
//   - SubagentStart/SubagentStop `agent_id` = the child rollout's
//     `session_meta.payload.id` = `token_usage_record.payload.thread_id`;
//   - reads ONLY the payload's `agent_transcript_path` (the CHILD rollout on
//     SubagentStop) — `transcript_path` is the PARENT on SubagentStop and is
//     never consulted, exactly as RP-226 never falls back to it for Claude;
//   - refuses the path — before opening anything — when it is not absolute
//     ('rollout-path-not-absolute'), is UNC-shaped ('rollout-path-unc'), or
//     is absent/empty (reusing RP-226's 'transcript-path-missing');
//   - refuses a symlink, FIFO, or other non-regular file the same way RP-226
//     already refuses a non-regular Claude transcript: lstat, check
//     `isFile()`, never follow (reusing RP-226's 'transcript-unreadable');
//   - reuses RP-226's read bounds verbatim (32 MiB total, 8 MiB per line,
//     3 s) and their reason codes ('transcript-too-large',
//     'transcript-line-too-large', 'transcript-timeout',
//     'transcript-malformed-line', 'transcript-empty') — a Codex rollout is
//     JSONL exactly as a Claude transcript is, and the failure shape is the
//     same;
//   - identity: the rollout's `session_meta.payload.id` must equal the
//     payload's own `agent_id`, or the record is
//     `usageUnavailable: 'rollout-identity-mismatch'` — a rollout with no
//     `session_meta` record at all is the same failure;
//   - once identity holds, the LAST `token_usage_record` whose
//     `payload.thread_id === agent_id` is used; no such record is
//     `usageUnavailable: 'no-usage-records'` (reusing RP-226's code);
//   - that record's `thread_token_usage` — the CUMULATIVE total for the
//     thread, never `turn_token_usage` (one turn) or `usage` (this event's
//     own delta) — is read, never summed across multiple records (it is
//     already a running total, so summing would double count);
//   - `input_tokens`/`cached_input_tokens`/`output_tokens`/
//     `reasoning_output_tokens` map onto `inputTokens`/`cachedInputTokens`/
//     `outputTokens`/`reasoningOutputTokens` — exactly the four fields
//     `token-report.mjs`'s own `codexUsageOf` already sums (RP-228, merged
//     into this branch); a field absent from `thread_token_usage` stays
//     absent, never zero; a present-but-negative-or-fractional field makes
//     the whole record `usageUnavailable: 'invalid-usage-counter'` (reusing
//     RP-226's code), never a partial number;
//   - `usage.evidenceSource` is always `'codex-subagent-rollout'`;
//   - Claude behaviour (`--harness=claude`) is unchanged by this ticket —
//     pinned here as one regression case, the rest lives in
//     dispatch-usage.test.ts (RP-226);
//   - usage is only ever attempted on `SubagentStop`, exactly as RP-226 —
//     `SubagentStart` carries the same `agent_transcript_path`, but a Codex
//     rollout is no more complete at start than a Claude transcript is.
//
// The reader is exported as `readCodexRolloutUsage(file, agentId, { now } =
// {})`, `now` defaulting to `Date.now`, mirroring RP-226's
// `readClaudeTranscriptUsage(file, { now })` so the 3 s bound is
// deterministic here too.
//
// ROUND 2 (review of PR #333, head 3b82189) — code-reviewer-r1.md B1/B2,
// security-scanner-r1.md B1:
//
//   - B1: identity is taken from the FIRST `session_meta` record, never the
//     last. A Codex child spawned with forked context writes TWO
//     `session_meta` records — the child's own (ordinal 0, carrying
//     `forked_from_id`/`parent_thread_id`), then a second record naming the
//     PARENT. Confirmed by reading one real forked rollout on this machine,
//     read-only: `~/.codex/sessions/2026/09/23/
//     rollout-2026-09-23T16-59-32-01a0ce59-....jsonl` — its first
//     `session_meta.payload.id` is the child id and carries
//     `forked_from_id`/`parent_thread_id` naming the parent; its second
//     `session_meta.payload.id` is the parent id with neither field. A
//     rollout whose first `session_meta` does not name `agent_id` is
//     `rollout-identity-mismatch` even when a later one does;
//   - B2: a matched `token_usage_record` whose `thread_token_usage` is
//     absent, `null`, `{}`, or not an object is `usageUnavailable:
//     'no-usage-counters'` — never `{ usage: { evidenceSource } }` with no
//     counters, which reads as "measured" to any caller checking `'usage' in
//     data`;
//   - security B1: `UNC_PATH_RE` must also refuse a MIXED-separator leading
//     pair — `/\host\share\...` and `\/host/share/...` — not just `\\` and
//     `//`. On Windows both are UNC paths (`\\?\UNC\...`) that the
//     unfixed regex let through to `lstatSync`/`openSync`; on POSIX (where
//     this suite actually runs) the first is merely absolute-and-unmatched
//     and the second fails the absolute check entirely — both must still
//     resolve to `rollout-path-unc`, with nothing opened, on every platform.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const hookPath = path.join(hooksDir, 'record-dispatch.mjs');
const runJournalUrl = pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href;
const tokenReportPath = path.join(scriptsDir, 'token-report.mjs');

// AR-93: a platform skip is legitimate only for a capability genuinely
// absent there, named and justified — never a bare platform check spelled
// directly inside skipIf/runIf (platform-skips.test.ts).
// `mkfifo` is a POSIX utility; Windows has no FIFO-creation primitive at all.
const canCreateFifo = process.platform !== 'win32';

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

/** Spawn the hook exactly as Codex's projected hook would: argv flags, JSON payload on stdin. */
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
  agent_id: 'usage-agent',
  agent_type: 'code-reviewer',
  cwd: '/private/workdir',
  permission_mode: 'default',
  // The PARENT's own transcript on SubagentStop — a decoy in every test
  // below, proven never read by a sentinel value none of them may leak.
  transcript_path: '/private/workdir/.codex/sessions/parent-decoy.jsonl',
  agent_transcript_path: '/private/workdir/.codex/sessions/agent-usage-agent.jsonl',
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

/** One JSONL line shaped like a Codex rollout's `session_meta` record. */
function sessionMetaLine(id: string): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-09-25T00:00:00.000Z',
      cwd: '/work',
      originator: 'codex_exec',
      cli_version: '0.156.1',
    },
  });
}

interface TokenUsageRecordInput {
  threadId: string;
  usage?: Record<string, number>;
  turnTokenUsage?: Record<string, number>;
  threadTokenUsage?: Record<string, number>;
  /** Padding/canary only — never a real rollout field. */
  content?: string;
}

/** One JSONL line shaped like a Codex rollout's `token_usage_record`. */
function tokenUsageLine({
  threadId,
  usage,
  turnTokenUsage,
  threadTokenUsage,
  content,
}: TokenUsageRecordInput): string {
  const payload: Record<string, unknown> = { thread_id: threadId };
  if (usage !== undefined) payload.usage = usage;
  if (turnTokenUsage !== undefined) payload.turn_token_usage = turnTokenUsage;
  if (threadTokenUsage !== undefined) payload.thread_token_usage = threadTokenUsage;
  if (content !== undefined) payload.content = content;
  return JSON.stringify({ type: 'token_usage_record', payload });
}

/**
 * `token_usage_record` builder that accepts an arbitrary `thread_token_usage`
 * value (including `null`, `{}`, or a non-object) — `tokenUsageLine`'s typed
 * `Record<string, number>` can't express those shapes, and round 2's B2 cases
 * need exactly them. `JSON.stringify` drops an `undefined`-valued key on its
 * own, so passing `undefined` here reproduces the "field absent entirely"
 * case without any extra branching; `null`/`{}`/a non-object are written
 * verbatim.
 */
function tokenUsageLineRaw(threadId: string, threadTokenUsage: unknown): string {
  const payload: Record<string, unknown> = {
    thread_id: threadId,
    thread_token_usage: threadTokenUsage,
  };
  return JSON.stringify({ type: 'token_usage_record', payload });
}

/**
 * One JSONL line shaped like a FORKED CHILD's own `session_meta` record — the
 * FIRST of the two such records a forked child rollout carries. Shape
 * confirmed by reading one real forked rollout on this machine, read-only
 * (round 2, code-reviewer-r1.md B1):
 * `~/.codex/sessions/2026/09/23/rollout-2026-09-23T16-59-32-01a0ce59-....jsonl`
 * — ordinal 0's `session_meta.payload` carries the child's own `id` plus
 * `forked_from_id`/`parent_thread_id` naming the parent, and
 * `thread_source: 'subagent'`.
 */
function forkedChildSessionMetaLine(id: string, parentId: string): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id,
      forked_from_id: parentId,
      parent_thread_id: parentId,
      timestamp: '2026-09-25T00:00:00.000Z',
      cwd: '/work',
      originator: 'codex_exec',
      cli_version: '0.156.1',
      thread_source: 'subagent',
    },
  });
}

/**
 * One JSONL line shaped like the SECOND `session_meta` record of a forked
 * child rollout — the PARENT's own record (same real rollout as above,
 * ordinal 1: `payload.id` is the parent id, neither `forked_from_id` nor
 * `parent_thread_id` is present, and `thread_source: 'user'`).
 */
function forkedParentSessionMetaLine(parentId: string): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id: parentId,
      timestamp: '2026-09-25T00:00:00.000Z',
      cwd: '/work',
      originator: 'codex_exec',
      cli_version: '0.156.1',
      thread_source: 'user',
    },
  });
}

let rolloutDir: string;
let runDir: string;

beforeEach(async () => {
  rolloutDir = await mkdtemp(path.join(tmpdir(), 'dispatch-usage-codex-rollouts-'));
  runDir = await mkdtemp(path.join(tmpdir(), 'dispatch-usage-codex-run-'));
});

afterEach(async () => {
  await removeFixture(rolloutDir);
  await removeFixture(runDir);
});

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  RIG_RUN_DIR: runDir,
  CLAUDE_PROJECT_DIR: '',
});

/** Writes `lines` (already-JSON strings) to `<rolloutDir>/<name>`. */
async function writeRollout(name: string, lines: string[]): Promise<string> {
  const file = path.join(rolloutDir, name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

describe('record-dispatch.mjs — Codex usage capture on SubagentStop (RP-227)', () => {
  it('reads thread_token_usage from the LAST matching token_usage_record, maps its four counters, and sets evidenceSource', async () => {
    const agentId = 'happy-path';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: {
          input_tokens: 50,
          cached_input_tokens: 5,
          output_tokens: 20,
          reasoning_output_tokens: 3,
        },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usage).toEqual({
      evidenceSource: 'codex-subagent-rollout',
      inputTokens: 50,
      cachedInputTokens: 5,
      outputTokens: 20,
      reasoningOutputTokens: 3,
    });
    expect('usageUnavailable' in data).toBe(false);
  });

  it('uses the LAST token_usage_record for the agent — a later, smaller thread_token_usage is not summed with an earlier one', async () => {
    const agentId = 'last-wins';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 1000, output_tokens: 1000 },
      }),
      // A second, later snapshot — the true cumulative total as of the end
      // of the turn. If the reader summed instead of taking the last one,
      // this would read 1100/1100 instead of 100/100.
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 100, output_tokens: 100 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(100);
  });

  it('ignores a token_usage_record for a DIFFERENT thread_id, even when it appears after the matching one', async () => {
    const agentId = 'ignore-other-thread';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 42, output_tokens: 7 },
      }),
      tokenUsageLine({
        threadId: 'some-other-thread',
        threadTokenUsage: { input_tokens: 999999, output_tokens: 999999 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.inputTokens).toBe(42);
    expect(usage?.outputTokens).toBe(7);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('999999');
  });

  it('a counter absent from thread_token_usage stays absent — never zero, never inferred', async () => {
    const agentId = 'partial-counters';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 10, output_tokens: 4 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    // Asserted first and positively: if usage were never populated at all
    // (today's behaviour), this would already fail — the absence checks
    // below are meaningful only once usage is actually captured.
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(4);
    expect(usage?.cachedInputTokens ?? null).toBeNull();
    expect(usage?.reasoningOutputTokens ?? null).toBeNull();
  });

  it('does not attempt usage capture on SubagentStart — only SubagentStop reads the rollout', async () => {
    const agentId = 'start-not-stop';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(
        dispatch({
          hook_event_name: 'SubagentStart',
          agent_id: agentId,
          agent_transcript_path: file,
        }),
      ),
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

describe('record-dispatch.mjs — Codex usage identity: session_meta.payload.id must equal the payload agent_id (RP-227)', () => {
  it("reports usageUnavailable with rollout-identity-mismatch when session_meta.payload.id differs from the dispatch's agent_id", async () => {
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine('some-other-agent'),
      tokenUsageLine({
        threadId: 'claimed-agent',
        threadTokenUsage: { input_tokens: 555555, output_tokens: 555555 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: 'claimed-agent', agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('rollout-identity-mismatch');
    expect('usage' in data).toBe(false);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('555555');
  });

  it('reports usageUnavailable with rollout-identity-mismatch when the rollout has no session_meta record at all', async () => {
    const agentId = 'no-session-meta';
    const file = await writeRollout('rollout.jsonl', [
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('rollout-identity-mismatch');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with no-usage-records when identity holds but no token_usage_record names this thread_id', async () => {
    const agentId = 'identity-ok-no-usage';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: 'a-completely-different-thread',
        threadTokenUsage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('no-usage-records');
    expect('usage' in data).toBe(false);
  });

  // Round 2 — code-reviewer-r1.md B1. A forked child rollout carries TWO
  // session_meta records (real shape read from
  // ~/.codex/sessions/2026/09/23/rollout-2026-09-23T16-59-32-01a0ce59-....jsonl,
  // read-only, on this machine): the child's own FIRST, the parent's SECOND.
  // Identity must be taken from the FIRST.
  it("identifies a forked child rollout from its FIRST session_meta record (the child's own, carrying forked_from_id/parent_thread_id) — not the parent's second record", async () => {
    const childId = 'forked-child-first-wins';
    const parentId = 'forked-parent-of-first-wins';
    const file = await writeRollout('rollout.jsonl', [
      forkedChildSessionMetaLine(childId, parentId),
      forkedParentSessionMetaLine(parentId),
      tokenUsageLine({
        threadId: childId,
        threadTokenUsage: { input_tokens: 70, output_tokens: 30 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: childId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    expect(usage?.inputTokens).toBe(70);
    expect(usage?.outputTokens).toBe(30);
    expect('usageUnavailable' in data).toBe(false);
  });

  it('reports usageUnavailable with rollout-identity-mismatch when the FIRST session_meta does not match agent_id, even when a LATER session_meta does', async () => {
    const agentId = 'first-must-match';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine('a-different-thread-entirely'),
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 888888, output_tokens: 888888 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('rollout-identity-mismatch');
    expect('usage' in data).toBe(false);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('888888');
  });
});

describe('record-dispatch.mjs — a matched token_usage_record with no usable thread_token_usage is usageUnavailable, never a counterless usage (RP-227 round 2, code-reviewer-r1.md B2)', () => {
  it('reports usageUnavailable (no usage key at all) when the matched token_usage_record has no thread_token_usage field', async () => {
    const agentId = 'b2-absent';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLineRaw(agentId, undefined),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable (no usage key at all) when thread_token_usage is null', async () => {
    const agentId = 'b2-null';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLineRaw(agentId, null),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable (no usage key at all) when thread_token_usage is an empty object', async () => {
    const agentId = 'b2-empty-object';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLineRaw(agentId, {}),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable (no usage key at all) when thread_token_usage is not an object (a string)', async () => {
    const agentId = 'b2-non-object';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLineRaw(agentId, 'not-an-object'),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
  });

  it('pins the specific reason code no-usage-counters (distinct from no-usage-records, which means "never matched at all")', async () => {
    const agentId = 'b2-specific-code';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLineRaw(agentId, {}),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('no-usage-counters');
  });
});

describe('record-dispatch.mjs — Codex rollout path is refused before anything is opened (RP-227)', () => {
  it('reports usageUnavailable and never reads transcript_path (the parent) when agent_transcript_path is absent', async () => {
    const parentFile = await writeRollout('parent-decoy.jsonl', [
      sessionMetaLine('no-agent-transcript-path'),
      tokenUsageLine({
        threadId: 'no-agent-transcript-path',
        threadTokenUsage: { input_tokens: 424242, output_tokens: 424242 },
      }),
    ]);
    const payload = dispatch({ agent_id: 'no-agent-transcript-path', transcript_path: parentFile });
    delete payload.agent_transcript_path;
    const result = await runHook(JSON.stringify(payload), env(), ['--harness=codex']);
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('424242');
    expect(bytes).not.toContain(parentFile);
  });

  it('reports usageUnavailable with rollout-path-not-absolute for a relative agent_transcript_path', async () => {
    const result = await runHook(
      JSON.stringify(
        dispatch({ agent_id: 'relative-path', agent_transcript_path: 'relative/rollout.jsonl' }),
      ),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('rollout-path-not-absolute');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with rollout-path-unc for a UNC-shaped agent_transcript_path', async () => {
    // POSIX-absolute (leading "/") AND UNC-shaped (leading "//") at once —
    // proving the UNC check is a real, separate check rather than a
    // byproduct of the absolute-path check.
    const result = await runHook(
      JSON.stringify(
        dispatch({
          agent_id: 'unc-path',
          agent_transcript_path: '//codex-host/share/rollout.jsonl',
        }),
      ),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('rollout-path-unc');
    expect('usage' in data).toBe(false);
  });

  // Win32 treats "/" and "\" as the same separator, so a MIXED leading pair
  // is UNC-shaped too; the earlier regex, which matched only two
  // same-character separators, let both mixed forms through to
  // lstatSync/openSync. Pinned here as a reason-code assertion that runs on
  // every platform — a real host would need to exist for the bypass to leak
  // content, but the wrong reason code alone already proves the path was
  // NOT refused at the UNC check.
  it('reports usageUnavailable with rollout-path-unc for a mixed-separator UNC path (leading "/\\\\") — never opens anything', async () => {
    const result = await runHook(
      JSON.stringify(
        dispatch({
          agent_id: 'unc-mixed-forward-back',
          agent_transcript_path: '/\\attacker.example\\share\\r.jsonl',
        }),
      ),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('rollout-path-unc');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with rollout-path-unc for a mixed-separator UNC path (leading "\\\\/") — never opens anything', async () => {
    const result = await runHook(
      JSON.stringify(
        dispatch({
          agent_id: 'unc-mixed-back-forward',
          agent_transcript_path: '\\/attacker.example/share/r.jsonl',
        }),
      ),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('rollout-path-unc');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable, never following it, when agent_transcript_path is a symlink to a real usage-bearing rollout', async () => {
    const agentId = 'symlink-target';
    const real = await writeRollout('real-rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 313131, output_tokens: 313131 },
      }),
    ]);
    const link = path.join(rolloutDir, 'linked-rollout.jsonl');
    await symlink(real, link, 'file');
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: link })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain('313131');
  });

  it.skipIf(!canCreateFifo)(
    'reports usageUnavailable when agent_transcript_path is a FIFO — mkfifo is POSIX-only, so this is skipped on win32',
    async () => {
      const fifoPath = path.join(rolloutDir, 'rollout.fifo');
      execFileSync('mkfifo', [fifoPath]);
      const result = await runHook(
        JSON.stringify(dispatch({ agent_id: 'fifo-agent', agent_transcript_path: fifoPath })),
        env(),
        ['--harness=codex'],
      );
      expect(result.code).toBe(0);
      const events = await readEvents(runDir);
      const data = (events[0]?.data ?? {}) as Record<string, unknown>;
      expect(typeof data.usageUnavailable).toBe('string');
      expect('usage' in data).toBe(false);
    },
  );

  it('reports usageUnavailable when agent_transcript_path names a file that does not exist', async () => {
    const missing = path.join(rolloutDir, 'never-written.jsonl');
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: 'missing-file', agent_transcript_path: missing })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(typeof data.usageUnavailable).toBe('string');
    expect('usage' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — Codex rollout read bounds reuse RP-226 verbatim (RP-227)', () => {
  it('reports usageUnavailable with transcript-empty for a zero-byte rollout', async () => {
    const file = path.join(rolloutDir, 'empty.jsonl');
    await writeFile(file, '', 'utf8');
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: 'empty-rollout', agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('transcript-empty');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with transcript-malformed-line for a malformed JSON line anywhere in the rollout', async () => {
    const agentId = 'malformed-line';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      '{not valid json at all',
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 11, output_tokens: 22 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('transcript-malformed-line');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with transcript-line-too-large, with no partial numbers, when a single line exceeds 8 MiB', async () => {
    const agentId = 'oversized-line';
    const MAX_LINE_BYTES = 8 * 1024 * 1024;
    const padding = 'x'.repeat(MAX_LINE_BYTES + 200_000);
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 999, output_tokens: 999 },
        content: padding,
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('transcript-line-too-large');
    expect('usage' in data).toBe(false);
  }, 20_000);

  it('reports usageUnavailable with transcript-too-large, with no partial numbers, when the rollout exceeds 32 MiB total', async () => {
    const agentId = 'oversized-total';
    const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
    const targetBytes = MAX_TOTAL_BYTES + 2 * 1024 * 1024;
    const lines: string[] = [sessionMetaLine(agentId)];
    let total = lines[0]!.length + 1;
    let index = 0;
    while (total < targetBytes) {
      const line = tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 1, output_tokens: 1 },
        content: 'y'.repeat(900),
      });
      lines.push(line);
      total += line.length + 1;
      index += 1;
    }
    const file = await writeRollout('rollout.jsonl', lines);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('transcript-too-large');
    expect('usage' in data).toBe(false);
    expect(index).toBeGreaterThan(0); // sanity: the loop actually ran
  }, 20_000);
});

describe('record-dispatch.mjs — readCodexRolloutUsage: a deterministic 3 s wall-time bound (RP-227, mirrors RP-226 B3)', () => {
  it('reports transcript-timeout when an injected clock crosses the 3 s bound between two read chunks', async () => {
    const module = (await import(pathToFileURL(hookPath).href)) as {
      readCodexRolloutUsage?: (
        file: string,
        agentId: string,
        options?: { now?: () => number },
      ) => { usage?: Record<string, unknown>; usageUnavailable?: string };
    };
    expect(
      typeof module.readCodexRolloutUsage,
      'record-dispatch.mjs must export readCodexRolloutUsage(file, agentId, { now }) for this test to drive its 3 s bound deterministically',
    ).toBe('function');

    const agentId = 'codex-clock-timeout';
    const lines: string[] = [sessionMetaLine(agentId)];
    let total = lines[0]!.length + 1;
    let i = 0;
    while (total < 150 * 1024) {
      const line = tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: i, output_tokens: i },
      });
      lines.push(line);
      total += line.length + 1;
      i += 1;
    }
    const file = await writeRollout('rollout.jsonl', lines);

    const clockValues = [0, 0, 5000];
    let callIndex = 0;
    const now = (): number => {
      const value = clockValues[callIndex] ?? clockValues[clockValues.length - 1] ?? 0;
      callIndex += 1;
      return value;
    };

    const result = module.readCodexRolloutUsage!(file, agentId, { now });
    expect(result).toEqual({ usageUnavailable: 'transcript-timeout' });
  });
});

describe('record-dispatch.mjs — Codex invalid usage counters refuse rather than sum (RP-227, mirrors RP-226 A1)', () => {
  it('reports usageUnavailable with invalid-usage-counter for a negative thread_token_usage counter, not a partial record', async () => {
    const agentId = 'counter-negative';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: -5, output_tokens: 5 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('invalid-usage-counter');
    expect('usage' in data).toBe(false);
  });

  it('reports usageUnavailable with invalid-usage-counter for a fractional thread_token_usage counter, not a partial record', async () => {
    const agentId = 'counter-fractional';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: { input_tokens: 10.5, output_tokens: 5 },
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.usageUnavailable).toBe('invalid-usage-counter');
    expect('usage' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — Codex usage capture never leaks the rollout path or unrelated content (RP-227)', () => {
  it('never carries the rollout path, the padding/canary content, or turn_token_usage/usage (the non-cumulative fields) in the journal record', async () => {
    const agentId = 'no-leak';
    const canary = 'SENTINEL-DO-NOT-PERSIST-ROLLOUT-CONTENT';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        usage: { input_tokens: 111111, output_tokens: 111111 },
        turnTokenUsage: { input_tokens: 222222, output_tokens: 222222 },
        threadTokenUsage: { input_tokens: 9, output_tokens: 4 },
        content: canary,
      }),
    ]);
    const result = await runHook(
      JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
      env(),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    // Only thread_token_usage's numbers reach the journal — never this
    // event's own delta (`usage`) or the turn's own (`turn_token_usage`).
    expect(usage?.inputTokens).toBe(9);
    expect(usage?.outputTokens).toBe(4);
    const bytes = await eventsFileBytes(runDir);
    expect(bytes).not.toContain(canary);
    expect(bytes).not.toContain(file);
    expect(bytes).not.toContain(rolloutDir);
    expect(bytes).not.toContain('111111');
    expect(bytes).not.toContain('222222');
  });
});

describe('token-report.mjs — reads Codex usage off a dispatch-end event (RP-227 × RP-228)', () => {
  it('shows the Codex usage and the "usage measured; monetary cost unavailable" money line for a run with a measured dispatch-end', async () => {
    const agentId = 'e2e-codex-agent';
    const file = await writeRollout('rollout.jsonl', [
      sessionMetaLine(agentId),
      tokenUsageLine({
        threadId: agentId,
        threadTokenUsage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 50,
          reasoning_output_tokens: 5,
        },
      }),
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
      ['--harness=codex'],
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
      ['--harness=codex'],
    );

    const { readRun } = (await import(runJournalUrl)) as {
      readRun(input: { runDir: string }): { decisions: unknown[]; events: JournalRecord[] };
    };
    const run = readRun({ runDir });

    // token-report.mjs's own `codexUsageOf` (RP-228, merged into this
    // branch) is read here as the real consumer, not vendored or
    // re-implemented — a future field-name drift between the two tickets
    // fails this test rather than going unnoticed.
    const { tokenReportOf } = (await import(pathToFileURL(tokenReportPath).href)) as {
      tokenReportOf(input: {
        runs: Array<{ run: string; decisions: unknown[]; events: JournalRecord[] }>;
        since: string;
      }): {
        dispatchGroups: Array<{ usage: { codex: Record<string, unknown> | null } }>;
        money: { line: string };
      };
    };
    const report = tokenReportOf({
      runs: [{ run: 'fixture-run-codex', decisions: run.decisions, events: run.events }],
      since: '2000-01-01T00:00:00.000Z',
    });

    expect(report.money.line).toBe('usage measured; monetary cost unavailable');
    const group = report.dispatchGroups[0];
    expect(group?.usage.codex).toEqual({
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 50,
      reasoningOutputTokens: 5,
    });
  });
});

describe('record-dispatch.mjs — Claude usage capture is unchanged by RP-227 (regression)', () => {
  it('still sums input/output tokens from a Claude transcript on --harness=claude, unaffected by the Codex rollout reader', async () => {
    const claudeTranscriptDir = await mkdtemp(
      path.join(tmpdir(), 'dispatch-usage-codex-claude-regress-'),
    );
    try {
      const agentId = 'claude-regression';
      const file = path.join(claudeTranscriptDir, `agent-${agentId}.jsonl`);
      const message = {
        id: 'msg-1',
        role: 'assistant',
        usage: { input_tokens: 30, output_tokens: 12 },
      };
      await writeFile(file, `${JSON.stringify({ type: 'assistant', message })}\n`, 'utf8');
      const result = await runHook(
        JSON.stringify(dispatch({ agent_id: agentId, agent_transcript_path: file })),
        env(),
        ['--harness=claude'],
      );
      expect(result.code).toBe(0);
      const events = await readEvents(runDir);
      const data = (events[0]?.data ?? {}) as Record<string, unknown>;
      const usage = data.usage as Record<string, unknown> | undefined;
      expect(usage?.evidenceSource).toBe('claude-subagent-transcript');
      expect(usage?.inputTokens).toBe(30);
      expect(usage?.outputTokens).toBe(12);
    } finally {
      await removeFixture(claudeTranscriptDir);
    }
  });
});
