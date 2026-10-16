// RP-415: the Probity gate — a Rig-owned, process-layer PreToolUse hook that
// stays INERT unless this repository has declared the upstream `@nizos/probity`
// integration for the invoking harness, and otherwise delegates the
// UNMODIFIED hook payload to the project-local Probity launcher and relays its
// answer verbatim. It owns no TDD-enforcement logic of its own — it is a seam,
// not a reimplementation — so every behaviour here is about: when it stays
// silent, what it forwards and to whom, what it says when the dependency it
// was told to call is missing, and that it fails open (never hangs, never
// throws) exactly like every other hook `.claude/rules/invariants.md` names.
//
// The hook does not exist yet (`templates/agent-os/universal/.claude/hooks/
// probity-gate.mjs`). Every case below is RED for that reason until it is
// written — this file pins the behaviour, not the implementation.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const hook = path.join(universal, '.claude', 'hooks', 'probity-gate.mjs');
const unattendedFlagScript = path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs');

// Env vars the fake launchers use to report what they saw, without the test
// having to scrape process output that is also under test. A well-behaved
// spawn inherits the parent's environment unless the implementation
// deliberately strips it — exactly the default every other hook in this
// template spawns its own children with.
const MARKER_ENV = 'RIG_TEST_PROBITY_FAKE_MARKER';
const PID_ENV = 'RIG_TEST_PROBITY_FAKE_PID_FILE';

interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the gate exactly as a harness does: argv flag, payload on stdin, root via env. */
function runGate(
  args: string[],
  payload: string | Buffer,
  env: NodeJS.ProcessEnv,
): Promise<GateResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hook, ...args],
      { env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    // A gate that decides early and exits closes the pipe under us; that is
    // the gate working, not the test failing.
    child.stdin.on('error', () => {});
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** `.rig/integrations.json` content for a declared `probity` entry. */
function declaration(harnesses: string[], selected?: boolean, required?: boolean): unknown {
  const entry: Record<string, unknown> = { id: 'probity', version: '1.10.1', harnesses };
  if (selected !== undefined) entry.selected = selected;
  if (required !== undefined) entry.required = required;
  return { schemaVersion: 1, integrations: [entry] };
}

interface FixtureOptions {
  /** Written verbatim (string) or JSON-stringified (object) to `.rig/integrations.json`. Omit for "no declaration". */
  integrations?: unknown;
  /** Written to `node_modules/@nizos/probity/dist/bin.js`. Omit for "launcher missing". */
  launcherScript?: string;
}

/** A scratch project root: declaration file and/or fake launcher, as asked for. */
async function makeFixture(options: FixtureOptions): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'probity-gate-'));
  if (options.integrations !== undefined) {
    const rigDir = path.join(root, '.rig');
    await mkdir(rigDir, { recursive: true });
    const content =
      typeof options.integrations === 'string'
        ? options.integrations
        : JSON.stringify(options.integrations);
    await writeFile(path.join(rigDir, 'integrations.json'), content);
  }
  if (options.launcherScript !== undefined) {
    const binDir = path.join(root, 'node_modules', '@nizos', 'probity', 'dist');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'bin.js'), options.launcherScript);
  }
  return root;
}

/** A fake launcher that records it ran (argv + exact stdin bytes) and relays a fixed response. */
function relayLauncherScript(responseText: string): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const marker = process.env.${MARKER_ENV};`,
    'const chunks = [];',
    "process.stdin.on('data', (chunk) => { chunks.push(chunk); });",
    "process.stdin.on('end', () => {",
    '  if (marker) {',
    '    const stdin = Buffer.concat(chunks);',
    "    fs.writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), stdinBase64: stdin.toString('base64') }));",
    '  }',
    `  process.stdout.write(${JSON.stringify(responseText)});`,
    '  process.exit(0);',
    '});',
  ].join('\n');
}

/** A fake launcher that records its own pid and then never exits. */
function hangingLauncherScript(): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const pidFile = process.env.${PID_ENV};`,
    'if (pidFile) fs.writeFileSync(pidFile, String(process.pid));',
    '// never read stdin, never exit — the thing under test is the gate timing out on us',
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

/** A fake launcher that prints part of an answer, then never exits. */
function partialThenHangLauncherScript(partial: string): string {
  return [
    "'use strict';",
    `process.stdout.write(${JSON.stringify(partial)});`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

/** A fake launcher that prints `bytes` bytes of output and exits 0. */
function floodLauncherScript(bytes: number): string {
  return [
    "'use strict';",
    'process.stdin.resume();',
    "process.stdin.on('end', () => {",
    `  process.stdout.write('x'.repeat(${bytes}), () => process.exit(0));`,
    '});',
  ].join('\n');
}

async function spawnFaultPreloader(
  root: string,
  fault: 'async-error' | 'sync-throw',
): Promise<string> {
  const preloader = path.join(root, `.probity-spawn-${fault}.mjs`);
  const replacement =
    fault === 'sync-throw'
      ? "childProcess.spawn = () => { throw new Error('injected synchronous spawn failure'); };"
      : [
          'childProcess.spawn = () => {',
          '  const child = new EventEmitter();',
          '  child.stdin = new PassThrough();',
          '  child.stdout = new PassThrough();',
          "  queueMicrotask(() => child.emit('error', new Error('injected asynchronous spawn failure')));",
          '  return child;',
          '};',
        ].join('\n');
  await writeFile(
    preloader,
    [
      "import childProcess from 'node:child_process';",
      "import { EventEmitter } from 'node:events';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "import { PassThrough } from 'node:stream';",
      replacement,
      'syncBuiltinESMExports();',
    ].join('\n'),
  );
  return pathToFileURL(preloader).href;
}

// ── Payload builders — the exact shapes Claude Code / Codex send ──

const claudeWrite = (filePath = 'notes.txt') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content: 'hello\n' },
});

const claudeEdit = (filePath = 'notes.txt') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'x', new_string: 'y' },
});

const claudeNotebookEdit = (filePath = 'notes.ipynb') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'NotebookEdit',
  tool_input: { notebook_path: filePath, new_source: 'print(1)\n' },
});

const claudeMultiEdit = (filePath = 'notes.txt') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'MultiEdit',
  tool_input: { file_path: filePath, edits: [{ old_string: 'x', new_string: 'y' }] },
});

const claudeBash = () => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
});

const codexApplyPatch = (filePath = 'notes.txt') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: {
    command: ['*** Begin Patch', `*** Add File: ${filePath}`, '+hello', '*** End Patch'].join('\n'),
  },
});

const codexBash = () => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
});

const itOnWindows = process.platform === 'win32' ? it : it.skip;
const itOnPosix = process.platform === 'win32' ? it.skip : it;

const loadUnattendedFlag = () =>
  import(pathToFileURL(unattendedFlagScript).href) as Promise<{
    writeUnattended: (
      input: { item: string; runDir?: string | null; allow?: string[] },
      env: NodeJS.ProcessEnv,
    ) => string[];
  }>;

describe('probity-gate: ships as a hook file at the path the wiring will name', () => {
  it('exists under templates/agent-os/universal/.claude/hooks/', async () => {
    await expect(readFile(hook, 'utf8')).resolves.toBeTypeOf('string');
  });
});

describe('probity-gate: inert when nothing selected it for this harness', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('no .rig/integrations.json at all: exits 0, prints nothing, never spawns the launcher', async () => {
    const markerFile = path.join(tmpdir(), `probity-marker-absent-${Date.now()}.json`);
    const root = await makeFixture({ launcherScript: relayLauncherScript('{"ignored":true}') });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [
      'harnesses does not include this one (selected: true, harnesses: ["codex"], invoked --harness=claude)',
      declaration(['codex'], true),
      ['--harness=claude'] as const,
    ],
    [
      'selected is explicitly false, even though harnesses includes this one',
      declaration(['claude-code', 'codex'], false),
      ['--harness=claude'] as const,
    ],
    [
      'selected is absent entirely',
      declaration(['claude-code', 'codex']),
      ['--harness=claude'] as const,
    ],
  ])('%s: exits 0, prints nothing, never spawns the launcher', async (_why, integrations, args) => {
    const markerFile = path.join(
      tmpdir(),
      `probity-marker-inert-${Date.now()}-${Math.random()}.json`,
    );
    const root = await makeFixture({
      integrations,
      launcherScript: relayLauncherScript('{"ignored":true}'),
    });
    roots.push(root);

    const result = await runGate(args as unknown as string[], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not spawn the launcher or relay a decision for a wholly foreign absolute Codex apply_patch path', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-foreign-marker.json');
    const payload = JSON.stringify(
      codexApplyPatch(path.join(tmpdir(), 'probity-foreign-patch.txt')),
    );

    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('probity-gate: declared and selected, launcher present — the forwarded tools relay verbatim', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('Claude Write: spawns the launcher with --agent claude-code and the exact payload bytes, and relays its stdout verbatim', async () => {
    const markerFile = path.join(tmpdir(), `probity-marker-relay-claude-${Date.now()}.json`);
    const response = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Probity: fake',
      },
    });
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript(response),
    });
    roots.push(root);

    const payload = JSON.stringify(claudeWrite());
    const result = await runGate(['--harness=claude'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(response);

    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as {
      argv: string[];
      stdinBase64: string;
    };
    expect(recorded.argv).toContain('--agent');
    expect(recorded.argv).toContain('claude-code');
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('Codex apply_patch: spawns the launcher with --agent codex and the exact payload bytes, and relays its stdout verbatim', async () => {
    const markerFile = path.join(tmpdir(), `probity-marker-relay-codex-${Date.now()}.json`);
    const response = JSON.stringify({ decision: 'block', reason: 'Probity: fake codex' });
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript(response),
    });
    roots.push(root);

    const payload = JSON.stringify(codexApplyPatch());
    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(response);

    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as {
      argv: string[];
      stdinBase64: string;
    };
    expect(recorded.argv).toContain('--agent');
    expect(recorded.argv).toContain('codex');
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });
});

describe('probity-gate: every forwarded tool reaches the launcher with its harness agent', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it.each([
    ['claude', 'Write', 'claude-code'],
    ['claude', 'Edit', 'claude-code'],
    ['claude', 'NotebookEdit', 'claude-code'],
    ['codex', 'apply_patch', 'codex'],
    ['codex', 'Edit', 'codex'],
    ['codex', 'Write', 'codex'],
  ] as const)('--harness=%s forwards %s with --agent %s', async (harness, toolName, agent) => {
    const markerFile = path.join(
      tmpdir(),
      `probity-marker-forward-${harness}-${toolName}-${Date.now()}.json`,
    );
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{}'),
    });
    roots.push(root);

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: {},
    });
    const result = await runGate([`--harness=${harness}`], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { argv: string[] };
    expect(recorded.argv.slice(-2)).toEqual(['--agent', agent]);
  });
});

describe('probity-gate: tool filtering — only the named tools are ever forwarded', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it.each([
    ['Claude MultiEdit', ['--harness=claude'] as const, claudeMultiEdit],
    ['Claude Bash', ['--harness=claude'] as const, claudeBash],
    ['Codex Bash', ['--harness=codex'] as const, codexBash],
  ])(
    '%s is declared and the launcher is present, but is never forwarded: exits 0, prints nothing, no spawn',
    async (_label, args, payloadFn) => {
      const markerFile = path.join(
        tmpdir(),
        `probity-marker-filtered-${Date.now()}-${Math.random()}.json`,
      );
      const root = await makeFixture({
        integrations: declaration(['claude-code', 'codex'], true),
        launcherScript: relayLauncherScript('{"ignored":true}'),
      });
      roots.push(root);

      const result = await runGate(args as unknown as string[], JSON.stringify(payloadFn()), {
        CLAUDE_PROJECT_DIR: root,
        [MARKER_ENV]: markerFile,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

describe('probity-gate: project scope — edits provably outside the project are inert', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('does not spawn the launcher or relay a decision for a wholly foreign absolute Claude Write path', async () => {
    const markerFile = path.join(tmpdir(), `probity-marker-foreign-${Date.now()}.json`);
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);

    const result = await runGate(
      ['--harness=claude'],
      JSON.stringify(claudeWrite(path.join(tmpdir(), 'probity-foreign-write.txt'))),
      { CLAUDE_PROJECT_DIR: root, [MARKER_ENV]: markerFile },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forwards a lexical project path below an alias whose canonical target is foreign', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'probity-foreign-alias-'));
    roots.push(root, foreignRoot);
    const alias = path.join(root, 'linked-outside');
    await symlink(foreignRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const markerFile = path.join(root, '.probity-alias-marker.json');
    const payload = JSON.stringify(claudeWrite(path.join(alias, 'owned-spelling.txt')));

    const result = await runGate(['--harness=claude'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('does not spawn the launcher or relay a decision for a wholly foreign absolute Claude Edit path', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-foreign-edit-marker.json');

    const result = await runGate(
      ['--harness=claude'],
      JSON.stringify(claudeEdit(path.join(tmpdir(), 'probity-foreign-edit.txt'))),
      { CLAUDE_PROJECT_DIR: root, [MARKER_ENV]: markerFile },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not spawn the launcher or relay a decision for a wholly foreign absolute Claude NotebookEdit path', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-foreign-notebook-marker.json');

    const result = await runGate(
      ['--harness=claude'],
      JSON.stringify(claudeNotebookEdit(path.join(tmpdir(), 'probity-foreign-notebook.ipynb'))),
      { CLAUDE_PROJECT_DIR: root, [MARKER_ENV]: markerFile },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forwards a foreign lexical Write path below a dangling alias whose missing target is inside the project', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'probity-foreign-dangling-alias-'));
    roots.push(root, foreignRoot);
    const target = path.join(root, 'missing-target-directory');
    const alias = path.join(foreignRoot, 'link-into-project');
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const markerFile = path.join(root, '.probity-dangling-alias-marker.json');
    const payload = JSON.stringify(claudeWrite(path.join(alias, 'notes.txt')));

    const result = await runGate(['--harness=claude'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('forwards a mixed Codex patch with a foreign add and an owned add without changing its bytes', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-mixed-patch-marker.json');
    const command = [
      '*** Begin Patch',
      `*** Add File: ${path.join(tmpdir(), 'probity-foreign-mixed-add.txt')}`,
      '+foreign',
      '*** Add File: owned-mixed-add.txt',
      '+owned',
      '*** End Patch',
    ].join('\n');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    });

    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('forwards a Codex Move from an owned source to a foreign destination without changing its bytes', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-owned-to-foreign-move-marker.json');
    const command = [
      '*** Begin Patch',
      '*** Update File: owned-move-source.txt',
      `*** Move to: ${path.join(tmpdir(), 'probity-foreign-move-destination.txt')}`,
      '*** End Patch',
    ].join('\n');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    });

    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('forwards a Codex patch when its 129th section is an owned add after 128 foreign adds', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-section-budget-marker.json');
    const foreignSections = Array.from(
      { length: 128 },
      (_, index) =>
        `*** Add File: ${path.join(tmpdir(), `probity-foreign-section-${index}.txt`)}\n+foreign`,
    );
    const command = [
      '*** Begin Patch',
      ...foreignSections,
      '*** Add File: owned-after-section-budget.txt',
      '+owned',
      '*** End Patch',
    ].join('\n');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    });

    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('forwards a Codex patch with a malformed command shape without changing its bytes', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-malformed-command-marker.json');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: ['*** Begin Patch', 42, '*** End Patch'] },
    });

    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('forwards an incomplete Codex patch string with a foreign Add header without changing its bytes', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-incomplete-patch-marker.json');
    const command = [
      '*** Begin Patch',
      `*** Add File: ${path.join(tmpdir(), 'probity-foreign-incomplete-add.txt')}`,
      '+foreign',
    ].join('\n');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    });

    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('forwards a Claude Write whose file path is a malformed JSON object without changing its bytes', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const markerFile = path.join(root, '.probity-malformed-direct-path-marker.json');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: { toString: 'broken', valueOf: 'broken' }, content: 'hello\n' },
    });

    const result = await runGate(['--harness=claude'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"decision":"block"}');
    const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
    expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('does not spawn the launcher for a wholly foreign Codex Move with an existing foreign source', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'probity-foreign-move-'));
    roots.push(root, foreignRoot);
    const source = path.join(foreignRoot, 'existing-source.txt');
    await writeFile(source, 'foreign source\n');
    const markerFile = path.join(root, '.probity-foreign-move-marker.json');
    const command = [
      '*** Begin Patch',
      `*** Update File: ${source}`,
      `*** Move to: ${path.join(foreignRoot, 'destination.txt')}`,
      '*** End Patch',
    ].join('\n');
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    });

    const result = await runGate(['--harness=codex'], payload, {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  itOnPosix(
    'forwards a literal trailing-space foreign symlink leaf that resolves to an owned file',
    async () => {
      const root = await makeFixture({
        integrations: declaration(['claude-code', 'codex'], true),
        launcherScript: relayLauncherScript('{"decision":"block"}'),
      });
      const foreignRoot = await mkdtemp(path.join(tmpdir(), 'probity-foreign-literal-leaf-'));
      roots.push(root, foreignRoot);
      const owned = path.join(root, 'owned.txt');
      await writeFile(owned, 'owned\n');
      const alias = path.join(foreignRoot, 'link ');
      await symlink(owned, alias);
      const markerFile = path.join(root, '.probity-literal-leaf-marker.json');
      const payload = JSON.stringify(claudeWrite(alias));

      const result = await runGate(['--harness=claude'], payload, {
        CLAUDE_PROJECT_DIR: root,
        [MARKER_ENV]: markerFile,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe('{"decision":"block"}');
      const recorded = JSON.parse(await readFile(markerFile, 'utf8')) as { stdinBase64: string };
      expect(Buffer.from(recorded.stdinBase64, 'base64').toString('utf8')).toBe(payload);
    },
  );
});

describe('probity-gate: opaque Windows roots do not prove a local-drive path foreign', () => {
  itOnWindows(
    'keeps a local candidate unknown when the project root is only an admin-share spelling',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'probity-opaque-unc-root-'));
      try {
        const drive = path.parse(root).root[0];
        const opaqueRoot = `\\\\localhost\\${drive}$${root.slice(2)}`;
        const candidate = path.join(root, 'candidate.txt');
        const { adminShareDriveSpelling } = (await import(
          pathToFileURL(path.join(universal, '.claude', 'hooks', 'lib', 'canonical-path.mjs')).href
        )) as { adminShareDriveSpelling: (value: string) => string | undefined };
        const { isKnownForeignAbsolutePath } = (await import(
          pathToFileURL(path.join(universal, '.claude', 'hooks', 'lib', 'edit-input.mjs')).href
        )) as {
          isKnownForeignAbsolutePath: (
            value: string,
            repoRoot: string,
            lexicalRoot?: string,
          ) => boolean;
        };

        expect(adminShareDriveSpelling(opaqueRoot)).toBe(root);
        expect(isKnownForeignAbsolutePath(candidate, opaqueRoot, opaqueRoot)).toBe(false);
      } finally {
        await removeFixture(root);
      }
    },
  );
});

describe('probity-gate: declared, launcher missing — enforcement was promised, so silent allow is refused', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('Claude Write: denies with a reason naming @nizos/probity and how to install it', async () => {
    const root = await makeFixture({ integrations: declaration(['claude-code', 'codex'], true) });
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), env);

      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain('@nizos/probity');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain(
        'npm install -D @nizos/probity',
      );
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });

  it('Codex apply_patch: blocks with a reason naming @nizos/probity and how to install it', async () => {
    const root = await makeFixture({ integrations: declaration(['claude-code', 'codex'], true) });
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=codex'], JSON.stringify(codexApplyPatch()), env);

      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as { decision?: string; reason?: string };
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('@nizos/probity');
      expect(parsed.reason).toContain('npm install -D @nizos/probity');
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });
});

describe('probity-gate: selected Probity availability', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('warns but allows when an attended selected optional Probity launcher is missing', async () => {
    const root = await makeFixture({ integrations: declaration(['claude-code'], true) });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/@nizos\/probity|not installed/i);
  });

  it('blocks when a selected required Probity launcher emits an asynchronous spawn error', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code'], true, true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const preloader = await spawnFaultPreloader(root, 'async-error');

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      NODE_OPTIONS: `--import=${preloader}`,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('blocks when a selected required Probity launcher throws synchronously during spawn', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code'], true, true),
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    roots.push(root);
    const preloader = await spawnFaultPreloader(root, 'sync-throw');

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      NODE_OPTIONS: `--import=${preloader}`,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('blocks when a selected required Probity launcher exits nonzero', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code'], true, true),
      launcherScript: [
        'process.stdin.resume();',
        "process.stdin.on('end', () => process.exit(17));",
      ].join('\n'),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /Probity|launcher|required/i,
    );
  });

  it('blocks a selected required Probity launcher timeout without relaying its partial answer and kills it', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code'], true, true),
      launcherScript: [
        "const fs = require('node:fs');",
        `fs.writeFileSync(process.env.${PID_ENV}, String(process.pid));`,
        'process.stdout.write(\'{\\"partial\\":\');',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    });
    roots.push(root);
    const pidFile = path.join(root, '.required-timeout-pid');

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      RIG_PROBITY_GATE_TIMEOUT_MS: '1500',
      [PID_ENV]: pidFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('blocking required control');
    expect(result.stdout).not.toContain('partial');
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /Probity|timeout|required/i,
    );

    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    const deadline = Date.now() + 3000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    expect(alive).toBe(false);
  });

  it('blocks when a selected required Probity launcher exceeds the existing output cap', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code'], true, true),
      launcherScript: floodLauncherScript(1024 * 1024 + 1),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('blocking required control');
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(/Probity|output|required/i);
  });

  it('blocks an armed unattended run when the present Probity declaration is malformed', async () => {
    const root = await makeFixture({
      integrations: '{ not valid json',
      launcherScript: relayLauncherScript('{"decision":"block"}'),
    });
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), env);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
        /Probity|declaration|repair/i,
      );
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });

  it('blocks an armed unattended run when the present Probity declaration is parseable but null', async () => {
    const root = await makeFixture({ integrations: 'null' });
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), env);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
        /Probity|declaration|repair/i,
      );
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });

  it('blocks an armed unattended run when the present Probity declaration root is an array', async () => {
    const root = await makeFixture({ integrations: '[]' });
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), env);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
        /Probity|declaration|repair/i,
      );
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });

  it('blocks an armed unattended run when the present Probity declaration root is a number', async () => {
    const root = await makeFixture({ integrations: '42' });
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), env);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
        /Probity|declaration|repair/i,
      );
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });

  it('blocks an attended selected required Probity entry whose harness metadata is malformed', async () => {
    const root = await makeFixture({
      integrations: {
        schemaVersion: 1,
        integrations: [
          {
            id: 'probity',
            version: '1.10.1',
            selected: true,
            required: true,
            harnesses: 'claude-code',
          },
        ],
      },
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /Probity|harness|repair|required/i,
    );
  });

  it('blocks an armed unattended selected Probity entry whose required flag is not a boolean', async () => {
    const root = await makeFixture({
      integrations: {
        schemaVersion: 1,
        integrations: [
          {
            id: 'probity',
            version: '1.10.1',
            selected: true,
            required: 'true',
            harnesses: ['claude-code'],
          },
        ],
      },
      launcherScript: [
        'process.stdin.resume();',
        "process.stdin.on('end', () => process.exit(0));",
      ].join('\n'),
    });
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), env);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
        /Probity|required|repair/i,
      );
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });

  it('blocks an attended known-required Probity selection when an earlier duplicate has an invalid required flag', async () => {
    const root = await makeFixture({
      integrations: {
        schemaVersion: 1,
        integrations: [
          {
            id: 'probity',
            version: '1.10.1',
            selected: true,
            required: 'true',
            harnesses: ['claude-code'],
          },
          {
            id: 'probity',
            version: '1.10.1',
            selected: true,
            required: true,
            harnesses: ['claude-code'],
          },
        ],
      },
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /Probity|required|invalid|repair/i,
    );
  });

  it('blocks an armed unattended run when the present Probity declaration cannot be read', async () => {
    const root = await makeFixture({ integrations: declaration(['claude-code'], true) });
    const declarationPath = path.join(root, '.rig', 'integrations.json');
    await rm(declarationPath);
    await mkdir(declarationPath);
    const home = await mkdtemp(path.join(tmpdir(), 'probity-unattended-home-'));
    roots.push(root, home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
    const { writeUnattended } = await loadUnattendedFlag();
    const flags = writeUnattended({ item: 'RP-522', runDir: root, allow: [] }, env);
    try {
      const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), env);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
        /Probity|declaration|repair/i,
      );
    } finally {
      await Promise.all(flags.map((flag) => rm(flag, { force: true })));
    }
  });

  it('blocks duplicate selected Probity entries when a later required entry cannot be overridden by the first optional one', async () => {
    const root = await makeFixture({
      integrations: {
        schemaVersion: 1,
        integrations: [
          { id: 'probity', version: '1.10.1', selected: true, harnesses: ['claude-code'] },
          {
            id: 'probity',
            version: '1.10.1',
            selected: true,
            required: true,
            harnesses: ['claude-code'],
          },
        ],
      },
      launcherScript: [
        'process.stdin.resume();',
        "process.stdin.on('end', () => process.exit(0));",
      ].join('\n'),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /Probity|duplicate|required|repair/i,
    );
  });

  it('keeps a completed empty response from a selected required Probity launcher as an upstream allow', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code'], true, true),
      launcherScript: [
        'process.stdin.resume();',
        "process.stdin.on('end', () => process.exit(0));",
      ].join('\n'),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('blocks when an attended selected required Probity launcher is missing', async () => {
    const root = await makeFixture({ integrations: declaration(['claude-code'], true, true) });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain('@nizos/probity');
  });

  it('preserves a completed optional launcher deny response even when that launcher exits nonzero', async () => {
    const response = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'upstream optional deny',
      },
    });
    const root = await makeFixture({
      integrations: declaration(['claude-code'], true),
      launcherScript: [
        'process.stdin.resume();',
        "process.stdin.on('end', () => {",
        `  process.stdout.write(${JSON.stringify(response)});`,
        '  process.exit(17);',
        '});',
      ].join('\n'),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(response);
  });
});

describe('probity-gate: a declaration file it cannot read is a fail-open, not a crash', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('malformed .rig/integrations.json (not JSON): exits 0, prints nothing, never spawns, and says so on stderr', async () => {
    const markerFile = path.join(tmpdir(), `probity-marker-malformed-${Date.now()}.json`);
    const root = await makeFixture({
      integrations: '{ this is not json',
      launcherScript: relayLauncherScript('{"ignored":true}'),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      [MARKER_ENV]: markerFile,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('probity-gate: a launcher that never exits is a bounded fail-open, not a hang', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('returns within the configured bound, fails open, names the timeout on stderr, and kills the launcher child', async () => {
    const pidFile = path.join(tmpdir(), `probity-fake-pid-${Date.now()}.txt`);
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: hangingLauncherScript(),
    });
    roots.push(root);

    const startedAt = Date.now();
    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      RIG_PROBITY_GATE_TIMEOUT_MS: '1500',
      [PID_ENV]: pidFile,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/timed out|timeout/i);
    // Comfortably under vitest's own per-case budget — proves the gate's own
    // bound governed this, not an external kill.
    expect(elapsedMs).toBeLessThan(8000);

    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(pid)).toBe(true);

    // Bounded poll for the child's death (platform-tolerant: `kill(pid, 0)`
    // throws once nothing holds that pid any more, on every platform Node
    // supports this existence check on).
    const pollDeadline = Date.now() + 3000;
    let alive = true;
    while (Date.now() < pollDeadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    expect(alive, 'the launcher child should have been killed once the gate gave up on it').toBe(
      false,
    );
  });
});

describe('probity-gate: only a launcher that finished in time and within the output cap is relayed', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('relays nothing of an answer the launcher had only partly printed when the bound expired', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: partialThenHangLauncherScript(
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"de',
      ),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
      RIG_PROBITY_GATE_TIMEOUT_MS: '1500',
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/timed out|timeout/i);
  });

  it('relays nothing when the launcher prints more than 1 MiB, and names the cap on stderr', async () => {
    const root = await makeFixture({
      integrations: declaration(['claude-code', 'codex'], true),
      launcherScript: floodLauncherScript(1024 * 1024 + 1),
    });
    roots.push(root);

    const result = await runGate(['--harness=claude'], JSON.stringify(claudeWrite()), {
      CLAUDE_PROJECT_DIR: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/1048576|1 MiB/);
  });
});

describe('probity-gate: wiring — both harnesses invoke it on the same matcher as guard-secret-file', () => {
  it('Claude settings.json: the Write|Edit|MultiEdit|NotebookEdit|apply_patch PreToolUse group runs probity-gate.mjs with --harness=claude', async () => {
    const settings = JSON.parse(
      await readFile(path.join(universal, '.claude', 'settings.json'), 'utf8'),
    ) as {
      hooks: {
        PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      };
    };
    const group = settings.hooks.PreToolUse.find(
      (candidate) => candidate.matcher === 'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    );
    expect(group, 'no PreToolUse group with that matcher').toBeDefined();
    const entry = group?.hooks.find((candidate) => candidate.command.includes('probity-gate.mjs'));
    expect(entry, 'no probity-gate.mjs entry in that group').toBeDefined();
    expect(entry?.command).toContain('--harness=claude');
  });

  it('Codex hooks.json: the same PreToolUse group runs probity-gate.mjs with --harness=codex, in both command and commandWindows', async () => {
    const config = JSON.parse(
      await readFile(path.join(universal, '.codex', 'hooks.json'), 'utf8'),
    ) as {
      hooks: {
        PreToolUse: Array<{
          matcher?: string;
          hooks: Array<{ command: string; commandWindows?: string }>;
        }>;
      };
    };
    const group = config.hooks.PreToolUse.find(
      (candidate) => candidate.matcher === 'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    );
    expect(group, 'no PreToolUse group with that matcher').toBeDefined();
    const entry = group?.hooks.find((candidate) => candidate.command.includes('probity-gate.mjs'));
    expect(entry, 'no probity-gate.mjs entry in that group').toBeDefined();
    expect(entry?.command).toContain('--harness=codex');
    expect(entry?.command).not.toContain('--harness=claude');

    const encoded = entry?.commandWindows?.match(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
    )?.[1];
    expect(encoded, 'commandWindows is not an EncodedCommand').toBeDefined();
    const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');
    expect(windowsScript).toContain('probity-gate.mjs');
    expect(windowsScript).toContain('--harness=codex');
    expect(windowsScript).not.toContain('--harness=claude');
  });
});

describe('probity-gate: layer — Lean Core, because its wiring lives in .claude/settings.json', () => {
  it('is listed under the `process` array in layers.json', async () => {
    const layers = JSON.parse(await readFile(path.join(universal, 'layers.json'), 'utf8')) as {
      process?: string[];
      workflow?: string[];
    };
    expect(layers.process ?? []).toContain('.claude/hooks/probity-gate.mjs');
    expect(layers.workflow ?? []).not.toContain('.claude/hooks/probity-gate.mjs');
  });
});
