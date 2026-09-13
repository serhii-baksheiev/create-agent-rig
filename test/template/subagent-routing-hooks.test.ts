import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fifosAvailable, skipUnless } from '../helpers/env.js';

/**
 * RP-173: the two Claude-only routing hooks, spawned exactly as Claude Code
 * spawns them — the real hook file, a JSON payload on stdin, exit 2 + stderr
 * to block.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');

interface HookResult {
  code: number;
  stderr: string;
  stdout: string;
}

/** `timeout` kills a hook that has not answered after that many ms; 0 waits for ever. */
function runHookRaw(
  script: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeout = 0,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      { env, timeout },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr, stdout });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    // A hook that exits before reading stdin closes the pipe; that is its
    // verdict to report through the exit code, not a crash of this runner.
    child.stdin.on('error', () => undefined);
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('guard-subagent-model hook (a call-site model never overrides a pinned role)', () => {
  let root: string;

  const agentFile = (name: string, pins: string[]): string =>
    [
      '---',
      `name: ${name}`,
      'description: fixture agent',
      ...pins,
      'tools: Read',
      '---',
      '',
      'Fixture body.',
      '',
    ].join('\n');

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'guard-subagent-model-'));
    const agents = path.join(root, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(
      path.join(agents, 'code-reviewer.md'),
      agentFile('code-reviewer', ['model: claude-opus-5', 'effort: high']),
    );
    await writeFile(path.join(agents, 'free-agent.md'), agentFile('free-agent', []));
    await writeFile(
      path.join(agents, 'inherit-agent.md'),
      agentFile('inherit-agent', ['model: inherit']),
    );
    // Pinned, but outside `.claude/agents/`: only a climbing name could reach it.
    await writeFile(
      path.join(root, '.claude', 'evil.md'),
      agentFile('evil', ['model: claude-opus-5', 'effort: high']),
    );
    // A frontmatter that never closes: 70 000 bytes of `x` lines after the opener.
    await writeFile(
      path.join(agents, 'big.md'),
      `---\nname: big\n${`${'x'.repeat(99)}\n`.repeat(700)}`,
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const guard = (payload: unknown, timeout?: number) =>
    runHookRaw(
      'guard-subagent-model.mjs',
      JSON.stringify(payload),
      { ...process.env, CLAUDE_PROJECT_DIR: root },
      timeout,
    );

  /** The Agent tool payload measured on Claude Code 2.1.269. */
  const dispatch = (toolInput: Record<string, unknown>) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: 'fixture dispatch',
      prompt: 'review the change',
      run_in_background: false,
      ...toolInput,
    },
    cwd: root,
  });

  it('blocks a call-site model on a project agent that pins one, and says to re-dispatch without it', async () => {
    const result = await guard(dispatch({ subagent_type: 'code-reviewer', model: 'haiku' }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('code-reviewer');
    expect(result.stderr).toContain('claude-opus-5');
    expect(result.stderr).toMatch(/without .?model/i);
    expect(result.stderr).toMatch(/policy change/i);
  });

  it('allows the pinned project agent when the call names no model', async () => {
    const result = await guard(dispatch({ subagent_type: 'code-reviewer' }));
    expect(result.code).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an ad-hoc subagent with no subagent_type', { model: 'haiku' }],
    ['the built-in general-purpose agent', { subagent_type: 'general-purpose', model: 'haiku' }],
    [
      'a project agent whose frontmatter names no model',
      { subagent_type: 'free-agent', model: 'haiku' },
    ],
    ['a project agent that inherits its model', { subagent_type: 'inherit-agent', model: 'haiku' }],
  ])('allows a call-site model for %s', async (_case, toolInput) => {
    const result = await guard(dispatch(toolInput));
    expect(result.code).toBe(0);
  });

  it.each([
    ['a name that climbs out of the agents directory', '../evil'],
    ['a plugin-qualified agent name', 'some-plugin:code-reviewer'],
  ])('never resolves %s to a project agent file, so the call is allowed', async (_case, name) => {
    const result = await guard(dispatch({ subagent_type: name, model: 'haiku' }));
    expect(result.code).toBe(0);
  });

  // The limits the guard's header states, held so the header cannot drift from
  // what the guard does: it reads a `model:` LINE, and it finds an agent by the
  // dispatched name's FILE. Both cases below really are pinned agents, and both
  // really are allowed.
  it('does not see a pin spelled as a quoted YAML key, the limit its header states', async () => {
    const agents = path.join(root, '.claude', 'agents');
    await writeFile(
      path.join(agents, 'quoted-key.md'),
      agentFile('quoted-key', ['"model": claude-opus-5', 'effort: high']),
    );
    const result = await guard(dispatch({ subagent_type: 'quoted-key', model: 'haiku' }));
    expect(result.code).toBe(0);
  });

  it('does not match a pinned agent whose frontmatter name differs from its file name, the limit its header states', async () => {
    const agents = path.join(root, '.claude', 'agents');
    await writeFile(
      path.join(agents, 'renamed-file.md'),
      agentFile('frontmatter-name', ['model: claude-opus-5', 'effort: high']),
    );
    const result = await guard(dispatch({ subagent_type: 'frontmatter-name', model: 'haiku' }));
    expect(result.code).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a model that is not a string', { subagent_type: 'code-reviewer', model: 42 }],
    ['a subagent_type that is not a string', { subagent_type: 42, model: 'haiku' }],
  ])('refuses to inspect %s and says to resend it, not to split it', async (_case, toolInput) => {
    const result = await guard(dispatch(toolInput));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/resend/i);
    expect(result.stderr).not.toMatch(/split/i);
  });

  it.each<[string, unknown]>([
    ['a string', 'x'],
    ['an array', ['x']],
  ])(
    'refuses to inspect a tool_input that is %s and says to resend it, not to split it',
    async (_case, toolInput) => {
      const result = await guard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: toolInput,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/resend/i);
      expect(result.stderr).not.toMatch(/split/i);
    },
  );

  it('refuses an agent file whose frontmatter does not close within the read bound, and names the bound', async () => {
    const result = await guard(dispatch({ subagent_type: 'big', model: 'haiku' }));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/bytes|limit|bound/i);
  });

  it('echoes a model pinned in the agent file bounded and escaped', async () => {
    const esc = String.fromCharCode(0x1b);
    await writeFile(
      path.join(root, '.claude', 'agents', 'long-pin.md'),
      agentFile('long-pin', [`model: ${'a'.repeat(200)}${esc}[31mred`, 'effort: high']),
    );
    const result = await guard(dispatch({ subagent_type: 'long-pin', model: 'haiku' }));
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain(esc);
    expect(result.stderr).not.toContain('a'.repeat(65));
  });

  // The case above proves the bound and nothing else: its control byte sits past
  // the 64-character cut, so it would pass with no escaping at all. Here the byte
  // is inside what the refusal repeats, on both sides of the comparison.
  it('escapes a control byte inside the echoed part of both model names', async () => {
    const esc = String.fromCharCode(0x1b);
    await writeFile(
      path.join(root, '.claude', 'agents', 'esc-pin.md'),
      agentFile('esc-pin', [`model: x${esc}[31mred`, 'effort: high']),
    );
    const result = await guard(dispatch({ subagent_type: 'esc-pin', model: `m${esc}[2J` }));
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain(esc);
    expect(result.stderr).toContain('x\\u001b[31mred');
    expect(result.stderr).toContain('m\\u001b[2J');
  });

  it('reads a pin in an agent file that starts with a byte-order mark', async () => {
    const bom = String.fromCharCode(0xfeff);
    await writeFile(
      path.join(root, '.claude', 'agents', 'bom-agent.md'),
      `${bom}${agentFile('bom-agent', ['model: claude-opus-5', 'effort: high'])}`,
    );
    const result = await guard(dispatch({ subagent_type: 'bom-agent', model: 'haiku' }));
    expect(result.code).toBe(2);
  });

  it('allows a call-site model without waiting when the agent path is not a regular file', async (ctx) => {
    skipUnless(ctx, fifosAvailable().ok, fifosAvailable().reason);
    const fifo = path.join(root, '.claude', 'agents', 'fifo-agent.md');
    execFileSync('mkfifo', [fifo]);
    // Opening a FIFO waits for a writer that never comes. The kill turns that
    // wait into a failed assertion rather than a hook process left behind.
    const result = await guard(dispatch({ subagent_type: 'fifo-agent', model: 'haiku' }), 5_000);
    expect(result.code, 'the hook answered instead of waiting on the FIFO').toBe(0);
  }, 10_000);

  it('allows a call-site model when the agent path is a directory', async () => {
    await mkdir(path.join(root, '.claude', 'agents', 'dir-agent.md'));
    const result = await guard(dispatch({ subagent_type: 'dir-agent', model: 'haiku' }));
    expect(result.code).toBe(0);
  });

  it.each([
    ['empty stdin', ''],
    ['stdin that is not JSON', '{not json'],
  ])('fails open on %s', async (_case, stdin) => {
    const result = await runHookRaw('guard-subagent-model.mjs', stdin, {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
    });
    expect(result.code).toBe(0);
  });

  it('ignores an event that is not PreToolUse, even for a pinned agent with a model', async () => {
    const result = await guard({
      ...dispatch({ subagent_type: 'code-reviewer', model: 'haiku' }),
      hook_event_name: 'PostToolUse',
    });
    expect(result.code).toBe(0);
  });
});

describe('warn-subagent-routing hook (a session learns when its environment voids the pinned routing)', () => {
  const ROUTING_ENV = ['AI_AGENT', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_EFFORT_LEVEL'];
  const SUPPORTED = 'claude-code_2-1-269_harness';

  /** The suite may itself run inside Claude Code, so the inherited routing env is removed first. */
  const sessionEnv = (overrides: Record<string, string>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ROUTING_ENV) delete env[name];
    return { ...env, ...overrides };
  };

  const startSession = (overrides: Record<string, string>) =>
    runHookRaw(
      'warn-subagent-routing.mjs',
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      sessionEnv(overrides),
    );

  it('stays silent on a supported version with neither override set', async () => {
    const result = await startSession({ AI_AGENT: SUPPORTED });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/WARNING/);
    expect(result.stdout).not.toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
    expect(result.stdout).not.toContain('CLAUDE_CODE_EFFORT_LEVEL');
  });

  it.each(['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_EFFORT_LEVEL'])(
    'warns when %s is set, and never blocks the session',
    async (variable) => {
      const result = await startSession({ AI_AGENT: SUPPORTED, [variable]: '1' });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/WARNING/);
      expect(result.stdout).toContain(variable);
    },
  );

  it('does not warn about an override set to the empty string', async () => {
    const result = await startSession({
      AI_AGENT: SUPPORTED,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '',
      CLAUDE_CODE_EFFORT_LEVEL: '',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/WARNING/);
  });

  it('warns on a Claude Code older than 2.1.251 and names the minimum', async () => {
    const result = await startSession({ AI_AGENT: 'claude-code_2-1-250_harness' });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/WARNING/);
    expect(result.stdout).toContain('2.1.251');
  });

  it.each(['claude-code_2-1-251_harness', 'claude-code_3-0-0_agent'])(
    'does not warn about the version when AI_AGENT is %s',
    async (agent) => {
      const result = await startSession({ AI_AGENT: agent });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toMatch(/WARNING/);
    },
  );

  it.each<[string, Record<string, string>]>([
    ['AI_AGENT is unset', {}],
    ['AI_AGENT cannot be parsed', { AI_AGENT: 'cursor-agent' }],
  ])('warns that it could not determine the version when %s', async (_case, overrides) => {
    const result = await startSession(overrides);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/WARNING/);
    expect(result.stdout).toMatch(/could not determine|unknown/i);
  });

  it('reports every routing problem at once, and still never blocks the session', async () => {
    const result = await startSession({
      AI_AGENT: 'claude-code_2-1-250_harness',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
    expect(result.stdout).toContain('CLAUDE_CODE_EFFORT_LEVEL');
    expect(result.stdout).toContain('2.1.251');
  });
});
