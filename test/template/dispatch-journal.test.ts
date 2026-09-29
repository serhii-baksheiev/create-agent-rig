import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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

/**
 * The independent copy of the allowlist the hook may write into `data`.
 * `usage`/`usageUnavailable`/`measuredModel` are RP-226's Claude usage-capture
 * fields — see dispatch-usage.test.ts (absent in a generated rig) › "exports
 * DISPATCH_FIELDS containing usage, usageUnavailable, and measuredModel".
 * `orphan` is RP-294's field: present (`true`) only on a `dispatch-end` whose
 * `agentRef` has no earlier `dispatch-start` anywhere in this run AND whose
 * payload carries no `agent_type` (round 2, B4) — see the
 * "record-dispatch.mjs — a dispatch-end whose agent never started in this
 * run is marked orphan (RP-294)" describe block below.
 */
const EXPECTED_DISPATCH_FIELDS = [
  'schema',
  'harness',
  'controller',
  'agentType',
  'agentRef',
  'declaredModel',
  'declaredEffort',
  'declaredSource',
  'usage',
  'usageUnavailable',
  'measuredModel',
  'orphan',
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
 * regardless of `env.HOME` (`unattended-flag.mjs`'s two-home lookup, `homesOf`
 * in `stop-flag.mjs` shares the same reasoning). A test that writes one and
 * never calls `clearUnattended` leaves a real
 * `__PROJECT_NAME__-<hash>-loop-UNATTENDED` file behind in the machine's own
 * home on every run.
 *
 * The path returned here is computed independently of
 * `unattended-flag.mjs`'s own `checkoutId`/`scopedBasename`
 * (`invariants.md`'s independent-oracle rule): `sha256(realpath(project)).slice(0, 16)`,
 * the design's own formula reimplemented here rather than imported. An
 * earlier shape of this guard diffed the WHOLE real-home `.claude` listing
 * between `beforeEach` and `afterEach`; that raced every sibling test file
 * that mirrors and clears its OWN scoped flag in a parallel worker —
 * `unattended-flag.test.ts` names the same race at about line 90 — so this
 * returns only the one path a given test could itself have written, never the
 * whole directory.
 */
function expectedRealHomeFlagPath(projectRealPath: string): string {
  const id = createHash('sha256').update(projectRealPath).digest('hex').slice(0, 16);
  return path.join(userInfo().homedir, '.claude', `__PROJECT_NAME__-${id}-loop-UNATTENDED`);
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
    // RP-263: capture the realpath BEFORE `project` is removed below — the
    // mirrored flag path is keyed off it, and once the directory is gone
    // `realpath` resolves somewhere else (or throws).
    const expectedFlagPath = expectedRealHomeFlagPath(await realpath(project));
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
    // RP-263 guard: nothing survives at the exact real-home path this test
    // itself could have written — never a diff of the whole real-home
    // `.claude` listing, which races a sibling test file's own scoped flag in
    // a parallel worker.
    expect(existsSync(expectedFlagPath)).toBe(false);
  });

  it('prefers RIG_RUN_DIR over an armed unattended flag naming a different run', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-project-'));
    const expectedFlagPath = expectedRealHomeFlagPath(await realpath(project));
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
    expect(existsSync(expectedFlagPath)).toBe(false);
  });
});

// RP-287 — the RP-231 pilot measured this exact shape: the Claude controller
// session was started in checkout A while the loop's run/flag lived in
// checkout B. The hook found no flag scoped to A (`resolveRunDir` found
// neither `RIG_RUN_DIR` nor an armed flag for A) and silently wrote nothing
// for ~15 subagents — indistinguishable from a genuinely attended session
// with nothing armed anywhere (the existing "no flag armed" tests above,
// which must stay silent). The fix this file pins: a checkout sitting next
// to someone ELSE's armed unattended flag is not silence — it is a bounded,
// single-line stderr notice naming the root this hook checked, never the
// other checkout's runDir or flag contents.
describe('record-dispatch.mjs — a checkout with no armed flag of its own, while ANOTHER checkout has one, is not silence (RP-287)', () => {
  it('prints exactly one bounded stderr notice naming the checked root, and writes nothing, when the armed flag belongs to a DIFFERENT checkout', async () => {
    const checkoutA = await mkdtemp(path.join(tmpdir(), 'record-dispatch-checkout-a-'));
    const checkoutB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-checkout-b-'));
    const runDirB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-rundir-b-'));
    const realCheckoutA = await realpath(checkoutA);
    const expectedFlagPathB = expectedRealHomeFlagPath(await realpath(checkoutB));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const envB = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutB });
    const envA = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutA });
    try {
      writeUnattended({ item: 'RP-225', runDir: runDirB, allow: [] }, envB);

      const result = await runHook(JSON.stringify(dispatch({})), envA, ['--harness=claude']);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');

      const lines = result.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines, result.stderr).toHaveLength(1);
      const notice = lines[0] ?? '';
      expect(notice.length).toBeLessThanOrEqual(512);
      expect(notice.startsWith('record-dispatch:')).toBe(true);
      expect(notice.includes(checkoutA) || notice.includes(realCheckoutA)).toBe(true);
      expect(notice).not.toContain(runDirB);

      expect(await eventsFileBytes(runDirB)).toBe('');
    } finally {
      clearUnattended(envB);
      await removeFixture(checkoutA);
      await removeFixture(checkoutB);
      await removeFixture(runDirB);
    }
    expect(existsSync(expectedFlagPathB)).toBe(false);
  });

  it('emits no stderr notice when the armed unattended flag matches CLAUDE_PROJECT_DIR (the same run still records)', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-project-notice-match-'));
    const expectedFlagPath = expectedRealHomeFlagPath(await realpath(project));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const env = isolatedEnv({ CLAUDE_PROJECT_DIR: project });
    try {
      writeUnattended({ item: 'RP-225', runDir, allow: [] }, env);

      const result = await runHook(JSON.stringify(dispatch({})), env, ['--harness=claude']);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const events = await readEvents(runDir);
      expect(events).toHaveLength(1);
    } finally {
      clearUnattended(env);
      await removeFixture(project);
    }
    expect(existsSync(expectedFlagPath)).toBe(false);
  });

  it('an unrelated file in <home>/.claude (the STOP flag, or a random file) never triggers the mismatch notice', async () => {
    const claudeHomeDir = path.join(home, '.claude');
    await mkdir(claudeHomeDir, { recursive: true });
    await writeFile(path.join(claudeHomeDir, '__PROJECT_NAME__-loop-STOP'), '');
    await writeFile(path.join(claudeHomeDir, 'some-unrelated-file.json'), '{}');
    const project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-project-unrelated-'));
    try {
      const result = await runHook(
        JSON.stringify(dispatch({})),
        isolatedEnv({ CLAUDE_PROJECT_DIR: project }),
        ['--harness=claude'],
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      await removeFixture(project);
    }
  });
});

describe('record-dispatch.mjs — the loop skill names the risk this hook cannot see for itself (RP-287)', () => {
  it('SKILL.md §1 states the session must start from the checkout whose run directory it declares, or dispatch evidence is lost', async () => {
    const skillPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'skills',
      'loop',
      'SKILL.md',
    );
    const text = await readFile(skillPath, 'utf8');
    expect(text).toMatch(/started from the checkout/);
    expect(text).toMatch(/record-dispatch/);
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

// RP-294 — the RP-231 controller run (rel110-20260928-213527, read-only
// evidence, never committed here) journaled ~25 dispatch-end events with NO
// matching dispatch-start anywhere in the run: no agentType, no
// declaredModel/declaredEffort/declaredSource, always
// usageUnavailable: 'transcript-unreadable', spaced roughly 15-30s apart
// while real subagents ran. They read as harness-internal SubagentStop
// firings this hook cannot distinguish from a real dispatch by shape alone —
// so the policy is structural: a dispatch-end whose agentRef has no earlier
// dispatch-start recorded anywhere in THIS run's own journal is marked
// `orphan: true`, preserving the raw record (never dropped) while giving a
// reader — token-report.mjs among others — the one bit needed to exclude it
// from a dispatch count. See token-report.test.ts (absent in a generated
// rig) › "excludes an orphan dispatch-end (orphan: true, no matching start)
// from every dispatch count, and reports it as its own orphanEnds count" for
// the read side of this same policy.
describe('record-dispatch.mjs — a dispatch-end whose agent never started in this run is marked orphan (RP-294)', () => {
  it('marks orphan: true on a dispatch-end with no dispatch-start for the same agentRef anywhere earlier in this run, and no agent_type on the payload', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    // B4 (round 2): orphan requires BOTH conditions — no earlier start AND no
    // agent_type on the payload — so this fixture must explicitly drop the
    // shared `dispatch()` helper's default `agent_type`.
    const payload = dispatch({
      hook_event_name: 'SubagentStop',
      agent_id: 'agent-orphan-1',
    }) as Record<string, unknown>;
    delete payload.agent_type;
    const result = await runHook(JSON.stringify(payload), env, ['--harness=claude']);
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('dispatch-end');
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.orphan).toBe(true);
  });

  it('does not mark orphan on a dispatch-end that pairs with an earlier dispatch-start in this run', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    await runHook(
      JSON.stringify(dispatch({ hook_event_name: 'SubagentStart', agent_id: 'agent-paired-1' })),
      env,
      ['--harness=claude'],
    );
    await runHook(
      JSON.stringify(dispatch({ hook_event_name: 'SubagentStop', agent_id: 'agent-paired-1' })),
      env,
      ['--harness=claude'],
    );
    const events = await readEvents(runDir);
    expect(events).toHaveLength(2);
    const end = events[1];
    expect(end?.kind).toBe('dispatch-end');
    const data = (end?.data ?? {}) as Record<string, unknown>;
    expect('orphan' in data).toBe(false);
  });

  it('never marks orphan on a dispatch-start event', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    await runHook(
      JSON.stringify(dispatch({ hook_event_name: 'SubagentStart', agent_id: 'agent-start-only' })),
      env,
      ['--harness=claude'],
    );
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('orphan' in data).toBe(false);
  });

  it('marks orphan independently per agentRef: a real agent’s start does not cover an unrelated agent’s orphaned end', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    await runHook(
      JSON.stringify(dispatch({ hook_event_name: 'SubagentStart', agent_id: 'agent-real' })),
      env,
      ['--harness=claude'],
    );
    // B4: the harness-internal end must also carry no agent_type, or the
    // second condition alone would keep it from being marked orphan.
    const orphanPayload = dispatch({
      hook_event_name: 'SubagentStop',
      agent_id: 'agent-harness-internal',
    }) as Record<string, unknown>;
    delete orphanPayload.agent_type;
    await runHook(JSON.stringify(orphanPayload), env, ['--harness=claude']);
    const events = await readEvents(runDir);
    expect(events).toHaveLength(2);
    const orphanEnd = events.find(
      (event) =>
        event.kind === 'dispatch-end' &&
        (event.data as Record<string, unknown>)?.agentRef === ref(runDir, 'agent-harness-internal'),
    );
    expect(orphanEnd).toBeDefined();
    expect((orphanEnd?.data as Record<string, unknown>)?.orphan).toBe(true);
  });
});

// RP-294 round 2 (B4, code-reviewer HOLD on PR #356): the rel110 evidence
// this ticket started from shows the real, distinguishing signal was never
// "no matching start" alone — a real dispatch-end always carried agentType
// (the payload's own agent_type, echoed back by every paired end in that
// journal), and every orphan end carried none. Marking orphan on "no start"
// alone would also fire on an ordinary start/end RACE: a SubagentStop whose
// SubagentStart hook has not finished writing yet, for a real agent whose
// payload DOES carry agent_type. Gating on agent_type as well narrows that
// false positive to the one shape the evidence actually supports: harness
// internal events that never carried agent_type in the first place.
describe('record-dispatch.mjs — orphan requires BOTH no earlier start AND no agent_type on the payload (RP-294 round 2, B4)', () => {
  it('marks orphan: true when there is no earlier dispatch-start for this agentRef AND the payload carries no agent_type', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    const payload = dispatch({
      hook_event_name: 'SubagentStop',
      agent_id: 'agent-b4-no-type',
    }) as Record<string, unknown>;
    delete payload.agent_type;
    const result = await runHook(JSON.stringify(payload), env, ['--harness=claude']);
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.orphan).toBe(true);
    expect('agentType' in data).toBe(false);
  });

  it('does NOT mark orphan when there is no earlier dispatch-start but the payload DOES carry agent_type — the start/end race case', async () => {
    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    const result = await runHook(
      JSON.stringify(
        dispatch({
          hook_event_name: 'SubagentStop',
          agent_id: 'agent-b4-with-type',
          agent_type: 'code-reviewer',
        }),
      ),
      env,
      ['--harness=claude'],
    );
    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    expect(events).toHaveLength(1);
    const data = (events[0]?.data ?? {}) as Record<string, unknown>;
    expect('orphan' in data).toBe(false);
    expect(data.agentType).toBe('code-reviewer');
  });
});

// RP-294 round 2 (B1, code-reviewer HOLD on PR #356): `hasEarlierDispatchStart`
// called `readRun` — a full read and parse of the run's ENTIRE events.jsonl —
// before ever checking MAX_ORPHAN_CHECK_EVENTS, so the "bound" only limited
// what happened AFTER the unbounded read, not the read itself. The fix this
// pins: a size check (`statSync`, a ~4 MiB byte cap per the design) BEFORE
// any read, so an oversized journal is never opened for this check at all —
// `orphan` is left absent exactly as when `readRun` fails outright. This is
// proven deterministically, with no timing assertion: a large but internally
// VALID events.jsonl (so the ordinary, pre-existing, unrelated
// `recordEvent`/`append()` write path — which always fully reads the file
// for its own seq bookkeeping, an existing cost this ticket does not touch —
// still succeeds and the new dispatch-end really lands), carrying no
// dispatch-start for the tested agentRef and no agent_type on the payload
// (B4) anywhere in it. If the orphan check ignored the size cap and read
// through it, it would find genuinely no start and mark orphan: true — the
// absence of `orphan` here is possible only because the check gave up before
// reading.
describe('record-dispatch.mjs — the orphan check is bounded by file size, not merely by event count after an unbounded read (RP-294 round 2, B1)', () => {
  it('leaves orphan absent, but still records the dispatch-end, when events.jsonl is larger than the byte cap — even with FEW events (well under the existing 4096-event cap), and no dispatch-start for this agentRef, and no agent_type, anywhere in it', async () => {
    // Deliberately FEW, large lines rather than many small ones: a fixture
    // built from many small filler events would cross the pre-existing
    // MAX_ORPHAN_CHECK_EVENTS (4096) bail-out on its own, so a test built
    // that way would pass even against the UNFIXED implementation — it
    // would prove nothing about the byte cap specifically. Here the event
    // COUNT stays trivially small (well under 4096) while the file's BYTE
    // size alone crosses the ~4 MiB cap the design names, so only a
    // size-first check (statSync before any read) — never a check that
    // still fully parses the file first — can leave `orphan` absent: the
    // unfixed implementation parses this fine (small event count, valid
    // JSON), finds genuinely no start for this agentRef, and marks
    // orphan: true.
    const lines: string[] = [];
    let bytes = 0;
    let seq = 1;
    const target = 4.5 * 1024 * 1024; // comfortably past the ~4 MiB byte cap the design names
    const padding = 'x'.repeat(80_000);
    while (bytes < target) {
      const line = JSON.stringify({
        seq,
        at: '2026-09-24T09:00:00.000Z',
        kind: 'dispatch-start',
        data: { agentRef: `filler-${seq}`, junk: padding },
      });
      lines.push(line);
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      seq += 1;
    }
    expect(seq - 1).toBeLessThan(4096); // the fixture itself must stay under the event-count cap
    await writeFile(path.join(runDir, 'events.jsonl'), `${lines.join('\n')}\n`);

    const env = isolatedEnv({ RIG_RUN_DIR: runDir });
    const payload = dispatch({
      hook_event_name: 'SubagentStop',
      agent_id: 'agent-oversized-orphan',
    }) as Record<string, unknown>;
    delete payload.agent_type;
    const result = await runHook(JSON.stringify(payload), env, ['--harness=claude']);

    expect(result.code).toBe(0);
    const events = await readEvents(runDir);
    const end = events[events.length - 1];
    expect(end?.kind).toBe('dispatch-end');
    const data = (end?.data ?? {}) as Record<string, unknown>;
    expect(data.agentRef).toBe(ref(runDir, 'agent-oversized-orphan'));
    expect('orphan' in data).toBe(false);
  }, 30_000);
});

// RP-294 review round on #340 (RP-287): the sanitiser guarding the RP-287
// mismatch notice (`CONTROL_CHARS_RE`) only ever covered C0 (`\x00`-`\x1f`)
// and DEL (`\x7f`) — the C1 range (`\x80`-`\x9f`, including CSI `\x9b`) and
// the Unicode line/paragraph separators U+2028/U+2029 passed through
// unreplaced into a notice the header promises stays "one line". Both are
// exactly the RP-226 dispatch-usage reader's own definition of "control
// range" (`measuredModel`'s omission tests already cover C1 there) — this is
// the RP-287 probe's own, separate sanitiser, and it never had the same
// coverage.
describe('record-dispatch.mjs — the mismatch notice sanitises C1 controls and the Unicode line/paragraph separators, not just C0/DEL (RP-294)', () => {
  it('replaces a C1 control character (U+0085, NEL) in the checked root before it reaches the notice', async () => {
    const checkoutA = await mkdtemp(path.join(tmpdir(), 'record-dispatch-c1-a-'));
    const checkoutB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-c1-b-'));
    const runDirB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-c1-rundir-b-'));
    const expectedFlagPathB = expectedRealHomeFlagPath(await realpath(checkoutB));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const poisonedProjectDir = `${checkoutA}\u0085`;
    const envB = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutB });
    const envA = isolatedEnv({ CLAUDE_PROJECT_DIR: poisonedProjectDir });
    try {
      writeUnattended({ item: 'RP-225', runDir: runDirB, allow: [] }, envB);

      const result = await runHook(JSON.stringify(dispatch({})), envA, ['--harness=claude']);

      expect(result.code).toBe(0);
      const lines = result.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines, result.stderr).toHaveLength(1);
      expect(lines[0] ?? '').not.toContain('\u0085');
    } finally {
      clearUnattended(envB);
      await removeFixture(checkoutA);
      await removeFixture(checkoutB);
      await removeFixture(runDirB);
    }
    expect(existsSync(expectedFlagPathB)).toBe(false);
  });

  it('replaces U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) in the checked root', async () => {
    const checkoutA = await mkdtemp(path.join(tmpdir(), 'record-dispatch-ls-a-'));
    const checkoutB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-ls-b-'));
    const runDirB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-ls-rundir-b-'));
    const expectedFlagPathB = expectedRealHomeFlagPath(await realpath(checkoutB));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const poisonedProjectDir = `${checkoutA}\u2028mid\u2029`;
    const envB = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutB });
    const envA = isolatedEnv({ CLAUDE_PROJECT_DIR: poisonedProjectDir });
    try {
      writeUnattended({ item: 'RP-225', runDir: runDirB, allow: [] }, envB);

      const result = await runHook(JSON.stringify(dispatch({})), envA, ['--harness=claude']);

      expect(result.code).toBe(0);
      const lines = result.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines, result.stderr).toHaveLength(1);
      const notice = lines[0] ?? '';
      expect(notice).not.toContain('\u2028');
      expect(notice).not.toContain('\u2029');
    } finally {
      clearUnattended(envB);
      await removeFixture(checkoutA);
      await removeFixture(checkoutB);
      await removeFixture(runDirB);
    }
    expect(existsSync(expectedFlagPathB)).toBe(false);
  });
});

// RP-294 round 2 (B2, code-reviewer HOLD on PR #356): the round-1 tests above
// pinned the NEW ranges the fix added (C1, U+2028/U+2029) but never pinned
// the original C0 case the fix was supposed to already cover — an
// unexercised claim is exactly the gap the round-1 review flagged elsewhere
// in this same file.
describe('record-dispatch.mjs — the mismatch notice sanitises C0 controls, including ESC and \\x01 (RP-294 round 2, B2)', () => {
  it('replaces ESC (\\x1b) and \\x01 in the checked root before they reach the notice', async () => {
    const checkoutA = await mkdtemp(path.join(tmpdir(), 'record-dispatch-c0-a-'));
    const checkoutB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-c0-b-'));
    const runDirB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-c0-rundir-b-'));
    const expectedFlagPathB = expectedRealHomeFlagPath(await realpath(checkoutB));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const poisonedProjectDir = `${checkoutA}\x1b\x01mid`;
    const envB = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutB });
    const envA = isolatedEnv({ CLAUDE_PROJECT_DIR: poisonedProjectDir });
    try {
      writeUnattended({ item: 'RP-225', runDir: runDirB, allow: [] }, envB);

      const result = await runHook(JSON.stringify(dispatch({})), envA, ['--harness=claude']);

      expect(result.code).toBe(0);
      const lines = result.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines, result.stderr).toHaveLength(1);
      const notice = lines[0] ?? '';
      expect(notice).not.toContain('\x1b');
      expect(notice).not.toContain('\x01');
    } finally {
      clearUnattended(envB);
      await removeFixture(checkoutA);
      await removeFixture(checkoutB);
      await removeFixture(runDirB);
    }
    expect(existsSync(expectedFlagPathB)).toBe(false);
  });
});

// RP-294 round 2 (C1, code-reviewer HOLD on PR #356): the round-1 C1 test
// only ever exercised U+0085 (NEL); CSI (\x9b) sits in the same `\x80`-`\x9f`
// range the header's own prose already claims, but nothing exercised it.
describe('record-dispatch.mjs — the mismatch notice sanitises CSI (\\x9b), the rest of the C1 range (RP-294 round 2, C1)', () => {
  it('replaces CSI (\\x9b) in the checked root before it reaches the notice', async () => {
    const checkoutA = await mkdtemp(path.join(tmpdir(), 'record-dispatch-csi-a-'));
    const checkoutB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-csi-b-'));
    const runDirB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-csi-rundir-b-'));
    const expectedFlagPathB = expectedRealHomeFlagPath(await realpath(checkoutB));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const poisonedProjectDir = `${checkoutA}\x9bmid`;
    const envB = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutB });
    const envA = isolatedEnv({ CLAUDE_PROJECT_DIR: poisonedProjectDir });
    try {
      writeUnattended({ item: 'RP-225', runDir: runDirB, allow: [] }, envB);

      const result = await runHook(JSON.stringify(dispatch({})), envA, ['--harness=claude']);

      expect(result.code).toBe(0);
      const lines = result.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines, result.stderr).toHaveLength(1);
      const notice = lines[0] ?? '';
      expect(notice).not.toContain('\x9b');
    } finally {
      clearUnattended(envB);
      await removeFixture(checkoutA);
      await removeFixture(checkoutB);
      await removeFixture(runDirB);
    }
    expect(existsSync(expectedFlagPathB)).toBe(false);
  });
});

// RP-294 round 2 (security advisory, security-scanner SHIP-with-advisories on
// PR #356): bidi-control and zero-width characters (U+061C, U+200B-U+200F,
// U+202A-U+202E, U+2060-U+2069, U+FEFF) are invisible-rendering the same way
// a control character is, and can be used to make a notice's visible text
// misrepresent the bytes actually present (the classic "Trojan Source"
// technique). RLO (U+202E, RIGHT-TO-LEFT OVERRIDE) is the representative
// case this pins.
describe('record-dispatch.mjs — the mismatch notice sanitises bidi-control and zero-width characters (RP-294 round 2, security advisory)', () => {
  it('replaces RLO (\\u202E, RIGHT-TO-LEFT OVERRIDE) in the checked root before it reaches the notice', async () => {
    const checkoutA = await mkdtemp(path.join(tmpdir(), 'record-dispatch-rlo-a-'));
    const checkoutB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-rlo-b-'));
    const runDirB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-rlo-rundir-b-'));
    const expectedFlagPathB = expectedRealHomeFlagPath(await realpath(checkoutB));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    const poisonedProjectDir = `${checkoutA}\u202Emid`;
    const envB = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutB });
    const envA = isolatedEnv({ CLAUDE_PROJECT_DIR: poisonedProjectDir });
    try {
      writeUnattended({ item: 'RP-225', runDir: runDirB, allow: [] }, envB);

      const result = await runHook(JSON.stringify(dispatch({})), envA, ['--harness=claude']);

      expect(result.code).toBe(0);
      const lines = result.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines, result.stderr).toHaveLength(1);
      const notice = lines[0] ?? '';
      expect(notice).not.toContain('\u202E');
    } finally {
      clearUnattended(envB);
      await removeFixture(checkoutA);
      await removeFixture(checkoutB);
      await removeFixture(runDirB);
    }
    expect(existsSync(expectedFlagPathB)).toBe(false);
  });
});

// RP-294: neither cap the RP-287 probe declares (`MAX_NOTICE_LENGTH`,
// `MAX_HOME_ENTRIES_EXAMINED`) had a test of its own — only a loose
// `<=512` assertion on a notice whose root never came close to the bound.
describe('record-dispatch.mjs — the mismatch notice is capped at 512 characters even when the checked root alone would exceed it (RP-294)', () => {
  it('truncates the notice to exactly 512 characters for a very long checked root', async () => {
    const checkoutB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-cap-b-'));
    const runDirB = await mkdtemp(path.join(tmpdir(), 'record-dispatch-cap-rundir-b-'));
    const expectedFlagPathB = expectedRealHomeFlagPath(await realpath(checkoutB));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    // The fixed template text around the root is well under 512 characters
    // on its own, so a 700-character root alone forces truncation.
    const longRoot = `/tmp/${'x'.repeat(700)}`;
    const envB = isolatedEnv({ CLAUDE_PROJECT_DIR: checkoutB });
    const envA = isolatedEnv({ CLAUDE_PROJECT_DIR: longRoot });
    try {
      writeUnattended({ item: 'RP-225', runDir: runDirB, allow: [] }, envB);

      const result = await runHook(JSON.stringify(dispatch({})), envA, ['--harness=claude']);

      expect(result.code).toBe(0);
      const lines = result.stderr.split('\n').filter((line) => line.length > 0);
      expect(lines, result.stderr).toHaveLength(1);
      expect(lines[0]?.length).toBe(512);
    } finally {
      clearUnattended(envB);
      await removeFixture(checkoutB);
      await removeFixture(runDirB);
    }
    expect(existsSync(expectedFlagPathB)).toBe(false);
  });
});

// RP-294 round 2 (B3, code-reviewer HOLD on PR #356): the previous version of
// this test asserted an elapsed-time bound on a directory with no matching
// flag anywhere in it — which a bounded scan and an unbounded one both
// satisfy just as fast, so it proved only that the hook finds nothing here,
// never that the scan is capped. Directory enumeration order is
// filesystem-defined, so a black-box test still cannot deterministically
// place a genuinely matching flag PAST the cap and prove it invisible. The
// cap itself is now pinned directly, against the exported pure function
// below, in the next describe block.
describe('record-dispatch.mjs — the mismatch probe still finds nothing in a home directory with thousands of unrelated entries (RP-294)', () => {
  it('exits 0, with no notice, when the scanned home directory has thousands of unrelated entries and no armed flag of any checkout', async () => {
    const claudeHomeDir = path.join(home, '.claude');
    await mkdir(claudeHomeDir, { recursive: true });
    const count = 3000;
    await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        writeFile(path.join(claudeHomeDir, `unrelated-file-${index}.json`), '{}'),
      ),
    );
    const project = await mkdtemp(path.join(tmpdir(), 'record-dispatch-bounded-probe-'));
    try {
      const result = await runHook(
        JSON.stringify(dispatch({})),
        isolatedEnv({ CLAUDE_PROJECT_DIR: project }),
        ['--harness=claude'],
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      await removeFixture(project);
    }
  });
});

// RP-294 round 2 (B3): the 1024-entry cap itself is untestable black-box —
// directory enumeration order is filesystem-defined, so a fixture cannot
// deterministically place a matching entry PAST index 1024 and prove it
// invisible to a real `opendirSync`/`readSync` scan. The fix this pins: the
// scan's bound DECISION is extracted into a small, exported, pure function —
// `firstForeignFlag(names, isForeign, cap = 1024)` — that examines at most
// `cap` entries pulled from an arbitrary iterable and returns the first one
// `isForeign` accepts, or `undefined`. Against a plain generator (not a real
// directory), entry order is exactly what the test controls, so the cap
// boundary is provable outright: a match one past the cap is invisible, a
// match exactly at the cap is found, and the iterable is never pulled more
// than `cap` times either way.
describe('record-dispatch.mjs — firstForeignFlag: the bounded scan decision extracted into a testable pure function (RP-294 round 2, B3)', () => {
  type FirstForeignFlag = (
    names: Iterable<string>,
    isForeign: (name: string) => boolean,
    cap?: number,
  ) => string | undefined;

  const loadFirstForeignFlag = async (): Promise<FirstForeignFlag> => {
    const module = (await import(pathToFileURL(hookPath).href)) as {
      firstForeignFlag?: FirstForeignFlag;
    };
    expect(typeof module.firstForeignFlag).toBe('function');
    return module.firstForeignFlag as FirstForeignFlag;
  };

  it('returns undefined when the only matching name sits at index 1024 — one past the 1024-entry cap', async () => {
    const firstForeignFlag = await loadFirstForeignFlag();
    let pulled = 0;
    function* names(): Generator<string> {
      for (let i = 0; i < 1024; i += 1) {
        pulled += 1;
        yield `unrelated-${i}`;
      }
      pulled += 1;
      yield 'matching-flag';
    }
    const isForeign = (name: string) => name === 'matching-flag';
    const found = firstForeignFlag(names(), isForeign, 1024);
    expect(found).toBeUndefined();
    expect(pulled).toBeLessThanOrEqual(1024);
  });

  it('finds a match sitting exactly at index 1023 — the 1024th entry, still inside the cap', async () => {
    const firstForeignFlag = await loadFirstForeignFlag();
    let pulled = 0;
    function* names(): Generator<string> {
      for (let i = 0; i < 1023; i += 1) {
        pulled += 1;
        yield `unrelated-${i}`;
      }
      pulled += 1;
      yield 'matching-flag';
    }
    const isForeign = (name: string) => name === 'matching-flag';
    const found = firstForeignFlag(names(), isForeign, 1024);
    expect(found).toBe('matching-flag');
    expect(pulled).toBeLessThanOrEqual(1024);
  });

  it('pulls no more than `cap` entries from a far larger iterable that never matches', async () => {
    const firstForeignFlag = await loadFirstForeignFlag();
    let pulled = 0;
    function* names(): Generator<string> {
      for (let i = 0; i < 10_000; i += 1) {
        pulled += 1;
        yield `unrelated-${i}`;
      }
    }
    const found = firstForeignFlag(names(), () => false, 1024);
    expect(found).toBeUndefined();
    expect(pulled).toBeLessThanOrEqual(1024);
  });
});

// RP-294 review round on #340: no test pinned that the RP-287 probe scans
// ONLY the env-declared home (`env.HOME`/`env.USERPROFILE`) — a revert to
// `homesOf`/`os.userInfo().homedir()` (stop-flag.mjs's own two-home lookup,
// which the header explicitly says this probe must NOT reuse) would still
// pass every existing test here, because every existing fixture keeps
// `env.HOME` and the real machine home in sync (or never arms a real-home
// flag at all). This test forces them apart.
describe('record-dispatch.mjs — the mismatch probe reads only the env-declared home, never the real OS home (RP-294)', () => {
  it('never notices another checkout’s flag mirrored into the REAL machine home when HOME/USERPROFILE are pointed elsewhere', async () => {
    const flagOwnerProject = await mkdtemp(path.join(tmpdir(), 'record-dispatch-realhome-owner-'));
    const flagOwnerRunDir = await mkdtemp(path.join(tmpdir(), 'record-dispatch-realhome-rundir-'));
    const thisCheckout = await mkdtemp(path.join(tmpdir(), 'record-dispatch-realhome-this-'));
    const isolatedHome = await mkdtemp(path.join(tmpdir(), 'record-dispatch-realhome-isolated-'));
    const expectedFlagPath = expectedRealHomeFlagPath(await realpath(flagOwnerProject));
    const { writeUnattended, clearUnattended } = (await import(unattendedFlagUrl)) as {
      writeUnattended(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
      clearUnattended(env: NodeJS.ProcessEnv): string[];
    };
    // Written with the REAL process env (only CLAUDE_PROJECT_DIR
    // overridden): writeUnattended mirrors into os.userInfo().homedir()
    // regardless of env.HOME (RP-263) — this genuinely arms a flag in the
    // machine's real home, for a DIFFERENT checkout than the one below.
    const ownerEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: flagOwnerProject };
    try {
      writeUnattended({ item: 'RP-225', runDir: flagOwnerRunDir, allow: [] }, ownerEnv);
      expect(existsSync(expectedFlagPath)).toBe(true);

      // This checkout's own env declares HOME/USERPROFILE at an isolated,
      // empty temp dir — never the real machine home. A probe that fell back
      // to homesOf/os.userInfo().homedir() would still find the real home's
      // armed flag above and print a mismatch notice; this probe must not.
      const runEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: isolatedHome,
        APPDATA: isolatedHome,
        USERPROFILE: isolatedHome,
        CLAUDE_PROJECT_DIR: thisCheckout,
        RIG_RUN_DIR: '',
      };

      const result = await runHook(JSON.stringify(dispatch({})), runEnv, ['--harness=claude']);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      clearUnattended(ownerEnv);
      await removeFixture(flagOwnerProject);
      await removeFixture(flagOwnerRunDir);
      await removeFixture(thisCheckout);
      await removeFixture(isolatedHome);
    }
    expect(existsSync(expectedFlagPath)).toBe(false);
  });
});
