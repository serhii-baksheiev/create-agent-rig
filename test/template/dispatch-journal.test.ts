import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-225 slice 2 — the observe-only dispatch lifecycle hook
// (`record-dispatch.mjs`). It is a `SubagentStart`/`SubagentStop` hook, wired
// with no matcher, that appends a `dispatch-start`/`dispatch-end` EVENT to the
// run journal (`.claude/scripts/run-journal.mjs`, already a multi-writer-safe
// append since RP-225 slice 1) — never a decision, never a blocker, never a
// tool-call refusal. Its own contract, restated here because this file is the
// first thing to enforce it:
//
//   - exits 0 on EVERY path and writes NOTHING to stdout (a `SubagentStop`
//     stdout decision can block a real session — an observe-only hook must
//     never carry that power by accident);
//   - never throws out of `main()`;
//   - acts only on `hook_event_name` `SubagentStart`/`SubagentStop` carrying a
//     string `agent_id` — everything else is a silent no-op;
//   - writes only into a run directory already DECLARED: `RIG_RUN_DIR` when
//     set, else the armed unattended flag's `runDir`, else nothing;
//   - swallows every `RunJournalError` (a missing run dir, an ended run, lock
//     contention) rather than letting one surface as a crash or a stall.
//
// The record it writes is bounded by one allowlist, `DISPATCH_FIELDS`,
// which the hook filters every record's `data` through before the write.
// The test below keeps its OWN literal copy rather than importing that export
// for the allowlist assertion — `invariants.md`'s independent-oracle rule: a
// test that only ever compares the export to itself cannot see a field that
// should never have been added.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const hookPath = path.join(hooksDir, 'record-dispatch.mjs');
const runJournalUrl = pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href;
const unattendedFlagUrl = pathToFileURL(path.join(scriptsDir, 'unattended-flag.mjs')).href;

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

/** The independent copy of the allowlist the hook may write into `data`. */
const EXPECTED_DISPATCH_FIELDS = [
  'schema',
  'harness',
  'controller',
  'agentType',
  'agentRef',
  'declaredModel',
  'declaredEffort',
  'declaredSource',
].sort();

/** `ref(x) = sha256(basename(runDir) + "\0" + x).slice(0, 16)` — the design's own formula, reimplemented here rather than imported. */
const ref = (runDir: string, value: string): string =>
  createHash('sha256')
    .update(`${path.basename(runDir)}\0${value}`)
    .digest('hex')
    .slice(0, 16);

/** Spawn the hook exactly as a harness would: argv flags, a JSON (or raw) payload on stdin. */
function runHook(stdin: string, env: NodeJS.ProcessEnv, argv: string[] = []): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookPath, ...argv],
      { env, timeout: 10_000 },
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

const dispatch = (fields: Record<string, unknown>): unknown => ({
  hook_event_name: 'SubagentStart',
  session_id: 'sess-abc123',
  agent_id: 'agent-001',
  agent_type: 'code-reviewer',
  cwd: '/private/workdir',
  permission_mode: 'default',
  agent_transcript_path: '/private/workdir/.claude/transcripts/agent-001.jsonl',
  ...fields,
});

async function readEvents(runDir: string): Promise<JournalRecord[]> {
  const { readRun } = (await import(runJournalUrl)) as {
    readRun(input: { runDir: string }): { events: JournalRecord[] };
  };
  return readRun({ runDir }).events;
}

async function eventsFileBytes(runDir: string): Promise<string> {
  try {
    return await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * RP-263 — `writeUnattended` mirrors a scoped flag into `os.userInfo().homedir`
 * regardless of `env.HOME` (`unattended-flag.mjs`'s two-home lookup,
 * `stop-flag.mjs:31-34` shares the same reasoning). A test that writes one and
 * never calls `clearUnattended` leaves a real
 * `__PROJECT_NAME__-<hash>-loop-UNATTENDED` file behind in the machine's own
 * home on every run. This lists (never deletes — the owner sweeps leaks
 * separately) the names present under the REAL home's `.claude`, so a test can
 * assert no new one survived it.
 */
async function realHomeUnattendedFlagNames(): Promise<string[]> {
  try {
    const entries = await readdir(path.join(userInfo().homedir, '.claude'));
    return entries.filter((name) => name.includes('-loop-UNATTENDED')).sort();
  } catch {
    return [];
  }
}

let home: string;
let runDir: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'record-dispatch-home-'));
  runDir = await mkdtemp(path.join(tmpdir(), 'record-dispatch-run-'));
});

afterEach(async () => {
  await removeFixture(home);
  await removeFixture(runDir);
});

/** No unattended flag armed, no project dir declared, isolated HOME/APPDATA. */
const isolatedEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  APPDATA: home,
  CLAUDE_PROJECT_DIR: '',
  RIG_RUN_DIR: '',
  ...overrides,
});

describe('record-dispatch.mjs — a run directory has to be declared before it writes anything', () => {
  it('exits 0 and prints nothing when RIG_RUN_DIR is unset and no unattended flag is armed', async () => {
    const result = await runHook(JSON.stringify(dispatch({})), isolatedEnv(), ['--harness=claude']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 and writes nothing when RIG_RUN_DIR names a directory that does not exist', async () => {
    const missing = path.join(runDir, 'never-created');
    const result = await runHook(
      JSON.stringify(dispatch({})),
      isolatedEnv({ RIG_RUN_DIR: missing }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 and writes nothing more once the run already carries its end marker', async () => {
    const { endRun, readRun } = (await import(runJournalUrl)) as {
      endRun(input: Record<string, unknown>): unknown;
      readRun(input: { runDir: string }): { events: JournalRecord[] };
    };
    endRun({ runDir, stop: 'test fixture', now: '2026-09-24T09:00:00.000Z' });
    const before = readRun({ runDir }).events.length;

    const result = await runHook(
      JSON.stringify(dispatch({})),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(readRun({ runDir }).events.length).toBe(before);
  });

  it('exits 0 and writes nothing on garbage, non-JSON stdin', async () => {
    const result = await runHook('not { json at all', isolatedEnv({ RIG_RUN_DIR: runDir }), [
      '--harness=claude',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(await eventsFileBytes(runDir)).toBe('');
  });

  it('exits 0 and writes nothing on a byte-order-marked payload that is not an object once stripped', async () => {
    // The BOM is stripped by the shared reader (`lib/hook-input.mjs`); what is
    // left here parses as the number 42, not a hook payload.
    const result = await runHook('﻿42', isolatedEnv({ RIG_RUN_DIR: runDir }), ['--harness=claude']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(await eventsFileBytes(runDir)).toBe('');
  });

  it('exits 0 and writes nothing when the payload parses to a non-object (an array)', async () => {
    const result = await runHook('[1,2,3]', isolatedEnv({ RIG_RUN_DIR: runDir }), [
      '--harness=claude',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(await eventsFileBytes(runDir)).toBe('');
  });

  it('exits 0 and writes nothing for a lifecycle event this hook does not observe', async () => {
    const result = await runHook(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'agent-001' }),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(await eventsFileBytes(runDir)).toBe('');
  });

  it('exits 0 and writes nothing when agent_id is absent or not a string', async () => {
    for (const agentId of [undefined, null, 42, ['agent-001']]) {
      const payload = dispatch({ agent_id: agentId });
      const result = await runHook(JSON.stringify(payload), isolatedEnv({ RIG_RUN_DIR: runDir }), [
        '--harness=claude',
      ]);
      expect(result.code, JSON.stringify(agentId)).toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(await eventsFileBytes(runDir)).toBe('');
  });
});

describe('record-dispatch.mjs — where the run directory comes from', () => {
  // RP-263 guard: an armed-then-unarmed unattended flag must leave nothing
  // behind in the REAL home this process actually runs under — never mind
  // that every test here points HOME/APPDATA at an isolated fixture.
  let unattendedFlagNamesBefore: string[];

  beforeEach(async () => {
    unattendedFlagNamesBefore = await realHomeUnattendedFlagNames();
  });

  afterEach(async () => {
    const after = await realHomeUnattendedFlagNames();
    const leaked = after.filter((name) => !unattendedFlagNamesBefore.includes(name));
    expect(leaked, `unattended flag(s) leaked into the real home: ${leaked.join(', ')}`).toEqual(
      [],
    );
  });

  it('writes into RIG_RUN_DIR when it is declared', async () => {
    const result = await runHook(
      JSON.stringify(dispatch({})),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('dispatch-start');
  });

  it('falls back to the armed unattended flag’s runDir when RIG_RUN_DIR is unset', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-project-'));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const env = isolatedEnv({ CLAUDE_PROJECT_DIR: project });
    try {
      writeUnattended({ item: 'RP-225', runDir, allow: [] }, env);

      const result = await runHook(JSON.stringify(dispatch({})), env, ['--harness=claude']);
      expect(result.code).toBe(0);
      const events = await readEvents(runDir);
      expect(events).toHaveLength(1);
    } finally {
      // Disarm BEFORE removing `project`: the flag's mirrored path is derived
      // from `realpath(project)` (RP-263) — once `project` is gone,
      // `clearUnattended` would resolve a different (non-existent) path and
      // leave the real, already-written flag behind.
      clearUnattended(env);
      await removeFixture(project);
    }
  });

  it('prefers RIG_RUN_DIR over an armed unattended flag naming a different run', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-project-'));
    const otherRunDir = await mkdtemp(path.join(tmpdir(), 'record-dispatch-other-run-'));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const env = isolatedEnv({ CLAUDE_PROJECT_DIR: project, RIG_RUN_DIR: runDir });
    try {
      writeUnattended({ item: 'RP-225', runDir: otherRunDir, allow: [] }, env);

      const result = await runHook(JSON.stringify(dispatch({})), env, ['--harness=claude']);
      expect(result.code).toBe(0);
      expect(await readEvents(runDir)).toHaveLength(1);
      expect(await readEvents(otherRunDir)).toHaveLength(0);
    } finally {
      // Disarm BEFORE removing `project` — same reasoning as the sibling test
      // above (RP-263): the flag path is keyed off `realpath(project)`.
      clearUnattended(env);
      await removeFixture(project);
      await removeFixture(otherRunDir);
    }
  });
});

describe('record-dispatch.mjs — start/end pairing and the event it writes', () => {
  it('records a dispatch-start event on SubagentStart, keyed by agentRef', async () => {
    const result = await runHook(
      JSON.stringify(dispatch({ hook_event_name: 'SubagentStart', agent_id: 'agent-001' })),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('dispatch-start');
    expect((events[0]?.data as Record<string, unknown>)?.agentRef).toBe(ref(runDir, 'agent-001'));
  });

  it('records a dispatch-end event on SubagentStop, with the same agentRef as the matching start', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    await runHook(
      JSON.stringify(dispatch({ hook_event_name: 'SubagentStart', agent_id: 'agent-002' })),
      env,
      ['--harness=claude'],
    );
    await runHook(
      JSON.stringify(
        dispatch({
          hook_event_name: 'SubagentStop',
          agent_id: 'agent-002',
          last_assistant_message: 'done',
        }),
      ),
      env,
      ['--harness=claude'],
    );

    const events = await readEvents(runDir);
    expect(events).toHaveLength(2);
    const [start, end] = events;
    expect(start?.kind).toBe('dispatch-start');
    expect(end?.kind).toBe('dispatch-end');
    const startRef = (start?.data as Record<string, unknown>)?.agentRef;
    const endRef = (end?.data as Record<string, unknown>)?.agentRef;
    expect(startRef).toBe(endRef);
    expect(startRef).toBe(ref(runDir, 'agent-002'));
  });

  it('a dispatch-end event carries no outcome field', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    await runHook(
      JSON.stringify(dispatch({ hook_event_name: 'SubagentStop', agent_id: 'agent-003' })),
      env,
      ['--harness=claude'],
    );
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('outcome' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — six concurrent SubagentStart hooks sharing one run directory', () => {
  it('leaves a run readRun can still read, with one dispatch-start per agent', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    const agentIds = Array.from({ length: 6 }, (_unused, index) => `concurrent-agent-${index}`);

    const results = await Promise.all(
      agentIds.map((agentId) =>
        runHook(
          JSON.stringify(dispatch({ hook_event_name: 'SubagentStart', agent_id: agentId })),
          env,
          ['--harness=claude'],
        ),
      ),
    );

    for (const result of results) expect(result.code).toBe(0);

    const events = await readEvents(runDir);
    expect(events).toHaveLength(6);
    const refs = events.map((event) => (event.data as Record<string, unknown>)?.agentRef).sort();
    expect(refs).toEqual(agentIds.map((agentId) => ref(runDir, agentId)).sort());
  });
});

describe('record-dispatch.mjs — harness is read from argv, never guessed from the payload', () => {
  it('reports "claude" when spawned with --harness=claude', async () => {
    await runHook(JSON.stringify(dispatch({})), isolatedEnv({ RIG_RUN_DIR: runDir }), [
      '--harness=claude',
    ]);
    const events = await readEvents(runDir);
    expect((events[0]?.data as Record<string, unknown>)?.harness).toBe('claude');
  });

  it('reports "codex" when spawned with --harness=codex', async () => {
    await runHook(JSON.stringify(dispatch({})), isolatedEnv({ RIG_RUN_DIR: runDir }), [
      '--harness=codex',
    ]);
    const events = await readEvents(runDir);
    expect((events[0]?.data as Record<string, unknown>)?.harness).toBe('codex');
  });

  it('omits `harness` when no --harness flag is given', async () => {
    await runHook(JSON.stringify(dispatch({})), isolatedEnv({ RIG_RUN_DIR: runDir }), []);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('harness' in data).toBe(false);
  });

  it('omits `harness` for an unrecognised marker', async () => {
    await runHook(JSON.stringify(dispatch({})), isolatedEnv({ RIG_RUN_DIR: runDir }), [
      '--harness=gemini',
    ]);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('harness' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — controller (Claude only)', () => {
  it('carries controller = ref(runDir, session_id) on Claude, when session_id is a string', async () => {
    await runHook(
      JSON.stringify(dispatch({ session_id: 'sess-xyz' })),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=claude'],
    );
    const events = await readEvents(runDir);
    expect((events[0]?.data as Record<string, unknown>)?.controller).toBe(ref(runDir, 'sess-xyz'));
  });

  it('omits controller on Codex, even when session_id is present', async () => {
    await runHook(
      JSON.stringify(dispatch({ session_id: 'sess-xyz' })),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=codex'],
    );
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('controller' in data).toBe(false);
  });

  it('omits controller on Claude when session_id is absent', async () => {
    const payload = dispatch({}) as Record<string, unknown>;
    delete payload.session_id;
    await runHook(JSON.stringify(payload), isolatedEnv({ RIG_RUN_DIR: runDir }), [
      '--harness=claude',
    ]);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('controller' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — agentType is a narrow, allowlisted token', () => {
  it('carries agentType when it matches the allowed shape', async () => {
    await runHook(
      JSON.stringify(dispatch({ agent_type: 'code-reviewer' })),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=claude'],
    );
    const events = await readEvents(runDir);
    expect((events[0]?.data as Record<string, unknown>)?.agentType).toBe('code-reviewer');
  });

  it('omits agentType when the payload value contains a character outside the allowed shape', async () => {
    await runHook(
      JSON.stringify(dispatch({ agent_type: 'code reviewer/evil' })),
      isolatedEnv({ RIG_RUN_DIR: runDir }),
      ['--harness=claude'],
    );
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('agentType' in data).toBe(false);
  });
});

describe('record-dispatch.mjs — declared model/effort, read from the agent definition', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-declared-'));
  });

  afterEach(async () => {
    await removeFixture(project);
  });

  it('reads declaredModel/declaredEffort/declaredSource from Claude agent frontmatter', async () => {
    const agents = path.join(project, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(
      path.join(agents, 'code-reviewer.md'),
      [
        '---',
        'name: code-reviewer',
        'description: fixture',
        'model: claude-opus-5',
        'effort: high',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
    const result = await runHook(
      JSON.stringify(dispatch({ agent_type: 'code-reviewer' })),
      isolatedEnv({ RIG_RUN_DIR: runDir, CLAUDE_PROJECT_DIR: project }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.declaredModel).toBe('claude-opus-5');
    expect(data.declaredEffort).toBe('high');
    expect(data.declaredSource).toBe('agent-definition');
  });

  it('reads declaredModel/declaredEffort/declaredSource from a Codex agent profile', async () => {
    const agents = path.join(project, '.codex', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(
      path.join(agents, 'code-reviewer.toml'),
      [
        'name = "code-reviewer"',
        'description = "fixture"',
        'model = "gpt-5-codex"',
        'model_reasoning_effort = "medium"',
        '',
      ].join('\n'),
    );
    const result = await runHook(
      JSON.stringify(dispatch({ agent_type: 'code-reviewer' })),
      isolatedEnv({ RIG_RUN_DIR: runDir, CLAUDE_PROJECT_DIR: project }),
      ['--harness=codex'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.declaredModel).toBe('gpt-5-codex');
    expect(data.declaredEffort).toBe('medium');
    expect(data.declaredSource).toBe('agent-definition');
  });

  it('omits declaredModel/declaredEffort/declaredSource when no agent definition is found', async () => {
    const result = await runHook(
      JSON.stringify(dispatch({ agent_type: 'no-such-agent' })),
      isolatedEnv({ RIG_RUN_DIR: runDir, CLAUDE_PROJECT_DIR: project }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('declaredModel' in data).toBe(false);
    expect('declaredEffort' in data).toBe(false);
    expect('declaredSource' in data).toBe(false);
  });

  it('omits declaredEffort alone when the frontmatter names a value outside the accepted enum', async () => {
    const agents = path.join(project, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(
      path.join(agents, 'code-reviewer.md'),
      [
        '---',
        'name: code-reviewer',
        'description: fixture',
        'model: claude-opus-5',
        'effort: ultra',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
    const result = await runHook(
      JSON.stringify(dispatch({ agent_type: 'code-reviewer' })),
      isolatedEnv({ RIG_RUN_DIR: runDir, CLAUDE_PROJECT_DIR: project }),
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.declaredModel).toBe('claude-opus-5');
    expect('declaredEffort' in data).toBe(false);
    // `declaredSource` still names where `declaredModel` came from.
    expect(data.declaredSource).toBe('agent-definition');
  });
});

describe('record-dispatch.mjs — the event-data allowlist (DISPATCH_FIELDS)', () => {
  it('exports DISPATCH_FIELDS equal to this test’s own independent copy, in both directions', async () => {
    const module = (await import(pathToFileURL(hookPath).href)) as {
      DISPATCH_FIELDS?: readonly string[];
    };
    expect(Array.isArray(module.DISPATCH_FIELDS)).toBe(true);
    const exported = [...(module.DISPATCH_FIELDS ?? [])].sort();
    expect(exported).toEqual(EXPECTED_DISPATCH_FIELDS);
  });

  it('never writes a data key outside the allowlist, on a payload carrying every observed field', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-allowlist-'));
    try {
      const agents = path.join(project, '.claude', 'agents');
      await mkdir(agents, { recursive: true });
      await writeFile(
        path.join(agents, 'code-reviewer.md'),
        [
          '---',
          'name: code-reviewer',
          'description: fixture',
          'model: claude-opus-5',
          'effort: high',
          '---',
          '',
          'Body.',
          '',
        ].join('\n'),
      );
      const env = isolatedEnv({ RIG_RUN_DIR: runDir, CLAUDE_PROJECT_DIR: project });
      await runHook(
        JSON.stringify(
          dispatch({
            hook_event_name: 'SubagentStop',
            agent_type: 'code-reviewer',
            last_assistant_message: 'reviewer@example.invalid finished the review',
          }),
        ),
        env,
        ['--harness=claude'],
      );
      const events = await readEvents(runDir);
      const data = (events[0]?.data ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        expect(EXPECTED_DISPATCH_FIELDS, `unexpected data key: ${key}`).toContain(key);
      }
    } finally {
      await removeFixture(project);
    }
  });
});

describe('record-dispatch.mjs — never persists the payload fields the item forbids', () => {
  it('leaves no trace of cwd, transcript paths, last_assistant_message, or raw session_id/agent_id in events.jsonl', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    const canaryEmail = 'reviewer+canary@example.invalid';
    const rawSessionId = 'session-do-not-persist-8f31';
    const rawAgentId = 'agent-do-not-persist-4c02';
    const cwdCanary = '/Users/do-not-persist/workdir';
    const transcriptCanary = '/Users/do-not-persist/.claude/transcripts/agent.jsonl';

    await runHook(
      JSON.stringify(
        dispatch({
          hook_event_name: 'SubagentStop',
          session_id: rawSessionId,
          agent_id: rawAgentId,
          cwd: cwdCanary,
          agent_transcript_path: transcriptCanary,
          last_assistant_message: `Review complete. Contact ${canaryEmail} with questions.`,
        }),
      ),
      env,
      ['--harness=claude'],
    );

    const bytes = await eventsFileBytes(runDir);
    expect(bytes.length).toBeGreaterThan(0);
    for (const canary of [
      canaryEmail,
      rawSessionId,
      rawAgentId,
      cwdCanary,
      transcriptCanary,
      'do-not-persist',
    ]) {
      expect(bytes, `canary leaked: ${canary}`).not.toContain(canary);
    }
  });
});

/**
 * Mutation-style proof for the allowlist check above: this pins that the
 * CHECKER itself — not just today's hook output — would catch a hook that
 * regressed into writing a forbidden key such as `cwd` straight into `data`.
 * It exercises no process; it is a property of the assertion, proven against
 * a synthetic record the real hook must never produce.
 */
describe('record-dispatch.mjs — the allowlist checker names the offending key (mutation proof)', () => {
  const offendingKeys = (data: Record<string, unknown>, allowed: readonly string[]): string[] =>
    Object.keys(data).filter((key) => !allowed.includes(key));

  it('flags `cwd` when a synthetic record carries it alongside allowed fields', () => {
    const mutated = { schema: 1, agentRef: 'abc123', cwd: '/private/workdir' };
    expect(offendingKeys(mutated, EXPECTED_DISPATCH_FIELDS)).toEqual(['cwd']);
  });

  it('flags nothing for a record built only from allowed fields', () => {
    const clean = { schema: 1, agentType: 'code-reviewer', agentRef: 'abc123' };
    expect(offendingKeys(clean, EXPECTED_DISPATCH_FIELDS)).toEqual([]);
  });
});
