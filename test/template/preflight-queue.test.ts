import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

// RP-56 — preflight is the point before a run can select, claim, or journal.
// It may read exactly one adapter listing to prove that the configured queue is
// usable, but an empty listing is a usable queue and must not be mistaken for a
// failed probe.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const { createStageDiagnostics } = await import(
  pathToFileURL(path.join(repoRoot, 'test', 'template', 'lib', 'stage-diagnostics.mjs')).href
);
const probeStages = createStageDiagnostics();

interface CommandResult {
  code: number;
  out: string;
}

interface Fixture {
  configPath: string;
  root: string;
  planPath: string;
  journalPath: string;
  runPath: string;
}

const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  new Promise<CommandResult>((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        out: stdout + stderr,
      });
    });
  });

const contract = {
  schemaVersion: 1,
  detection: {
    mode: 'pull',
    sources: ['run-state', 'journal'],
    acceptedLatency: '24h',
    push: false,
  },
  pairedFacts: [],
};

const fixture = async (config: Record<string, unknown> | null = null): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'preflight-queue-'));
  const claude = path.join(root, '.claude');
  await mkdir(claude, { recursive: true });
  await cp(scriptsDir, path.join(claude, 'scripts'), { recursive: true });
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await writeFile(path.join(root, '.rig', 'revalidation.json'), `${JSON.stringify(contract)}\n`);
  if (config !== null)
    await writeFile(path.join(claude, 'queue.json'), `${JSON.stringify(config)}\n`);
  return {
    configPath: path.join(claude, 'queue.json'),
    root,
    planPath: path.join(root, 'PLAN.md'),
    journalPath: path.join(root, 'journal'),
    runPath: path.join(claude, 'runs'),
  };
};

let stubs: StubHandle[] = [];

afterEach(async () => {
  for (const stub of stubs.reverse()) stub.restore();
  stubs = [];
});

const stubProbes = async () => {
  // Queue reachability is the only subject here. The other preflight probes
  // receive determinate local answers, so no fixture reaches a network.
  stubs.push(
    await probeStages.run('preflight-git-stub-setup', () =>
      stubCommand(
        'git',
        "if (args.includes('symbolic-ref')) return { stdout: 'origin/master\\n' }; if (args.includes('rev-parse')) return { stdout: 'same-sha\\n' }; return {};",
      ),
    ),
  );
  stubs.push(
    await probeStages.run('preflight-gh-stub-setup', () =>
      stubCommand('gh', "return { stdout: '[]\\n' };"),
    ),
  );
};

const preflight = async (p: Fixture, extraEnv: NodeJS.ProcessEnv = {}) => {
  await stubProbes();
  const result = await probeStages.run('preflight-json-cli', () =>
    run(
      process.execPath,
      [path.join(p.root, '.claude', 'scripts', 'preflight.mjs'), '--json'],
      p.root,
      {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        RIG_RUN_DIR: undefined,
        JIRA_BASE_URL: undefined,
        JIRA_EMAIL: undefined,
        JIRA_API_TOKEN: undefined,
        ...extraEnv,
      },
    ),
  );
  expect(result.code, result.out).toBe(0);
  return JSON.parse(result.out) as {
    verdict: string;
    checks: Record<string, { ok: boolean | string; detail: string }>;
    unchecked: string[];
  };
};

describe('preflight — the configured queue must be readable before an unattended run begins', () => {
  it.each([
    ['missing PLAN.md', null, /PLAN\.md.*ENOENT|ENOENT.*PLAN\.md/i],
    [
      'an unknown adapter',
      { adapter: 'does-not-exist' },
      /unknown queue adapter.*does-not-exist|does-not-exist.*unknown queue adapter/i,
    ],
    [
      'a Jira adapter without credentials',
      { adapter: 'jira', options: { project: 'RP' } },
      /JIRA_BASE_URL.*JIRA_EMAIL.*JIRA_API_TOKEN/i,
    ],
  ])('stops when %s cannot be read', async (_case, config, diagnostic) => {
    const p = await fixture(config);
    try {
      const result = await preflight(p);

      expect(result.checks.queue).toMatchObject({ ok: false });
      expect(result.checks.queue?.detail).toMatch(diagnostic);
      expect(result.verdict).toBe('STOP');
      expect(result.unchecked.join('\n')).not.toMatch(/queue.*reachable|reachable.*queue/i);
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  });

  it('escapes terminal controls from an unknown adapter in JSON diagnostics and rendered output', async () => {
    const injectedAdapter =
      'does-not-exist\u001b]8;;https://example.invalid\u0007label\u001b]8;;\u0007\u009b';
    const stages = createStageDiagnostics();
    const p = await stages.run('terminal-fixture-setup', () =>
      fixture({ adapter: injectedAdapter }),
    );
    // Newlines delimit the human report; every other C0 control, DEL, and C1
    // byte is terminal input and must not reach either diagnostic surface.
    const hasUnsafeTerminalControl = (value: string) =>
      [...value].some((character) => {
        const code = character.codePointAt(0) ?? -1;
        return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
      });
    try {
      const json = await stages.run('terminal-json-preflight', () => preflight(p));
      expect(stubs).toHaveLength(2);
      const rendered = await stages.run('terminal-rendered-cli', () =>
        run(process.execPath, [path.join(p.root, '.claude', 'scripts', 'preflight.mjs')], p.root, {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          RIG_RUN_DIR: undefined,
          JIRA_BASE_URL: undefined,
          JIRA_EMAIL: undefined,
          JIRA_API_TOKEN: undefined,
        }),
      );
      expect(rendered.code, rendered.out).toBe(0);
      expect(stubs).toHaveLength(2);
      const detail = json.checks.queue?.detail ?? '';

      expect(json.checks.queue).toMatchObject({ ok: false });
      expect(detail).toMatch(/could not read queue.*unknown queue adapter.*Known adapters/i);
      expect(detail).toContain('\\u001b');
      expect(detail).toContain('\\u0007');
      expect(detail).toContain('\\u009b');
      expect(hasUnsafeTerminalControl(detail)).toBe(false);
      expect(rendered.out).toMatch(/could not read queue.*unknown queue adapter.*Known adapters/i);
      expect(rendered.out).toContain('\\u001b');
      expect(rendered.out).toContain('\\u0007');
      expect(rendered.out).toContain('\\u009b');
      expect(hasUnsafeTerminalControl(rendered.out)).toBe(false);
    } finally {
      await stages.run('terminal-fixture-teardown', () =>
        rm(p.root, { recursive: true, force: true }),
      );
    }
  });

  it('passes a readable empty queue without changing the other preflight verdict or queue state', async () => {
    const p = await fixture();
    const emptyQueue = '# Plan\n\n## Agent queue\n\n## Operator queue\n';
    await writeFile(p.planPath, emptyQueue);
    try {
      const result = await preflight(p);

      expect(existsSync(p.configPath)).toBe(false);
      expect(result.checks.queue).toMatchObject({ ok: true });
      // The stubbed deployment history is deliberately unavailable. A successful
      // queue probe must preserve that CAUTION instead of upgrading the run to GO.
      expect(result.checks.lastDeploy).toMatchObject({ ok: 'unknown' });
      expect(result.verdict).toBe('CAUTION');
      expect(await readFile(p.planPath, 'utf8')).toBe(emptyQueue);
      expect(existsSync(p.journalPath)).toBe(false);
      expect(existsSync(p.runPath)).toBe(false);
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  });

  it('stops when queue.json is a dangling link even though the default plan queue is readable', async () => {
    const p = await fixture();
    await writeFile(p.planPath, '## Agent queue\n\n');
    await symlink(
      path.join(p.root, 'missing-queue-config'),
      p.configPath,
      process.platform === 'win32' ? 'junction' : 'file',
    );
    try {
      const result = await preflight(p);

      expect(result.checks.queue).toMatchObject({ ok: false });
      expect(result.checks.queue?.detail).toMatch(/queue\.json.*could not be read.*ENOENT/i);
      expect(result.verdict).toBe('STOP');
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  });

  it('stops when queue.json is invalid JSON even though the default plan queue is readable', async () => {
    const p = await fixture();
    await writeFile(p.planPath, '## Agent queue\n\n');
    await writeFile(p.configPath, '{ not JSON }\n');
    try {
      const result = await preflight(p);

      expect(result.checks.queue).toMatchObject({ ok: false });
      expect(result.checks.queue?.detail).toMatch(
        /queue\.json.*valid JSON|valid JSON.*queue\.json/i,
      );
      expect(result.verdict).toBe('STOP');
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  });

  it('stops when queue.json is a directory even though the default plan queue is readable', async () => {
    const p = await fixture();
    await writeFile(p.planPath, '## Agent queue\n\n');
    await mkdir(p.configPath);
    try {
      const result = await preflight(p);

      expect(result.checks.queue).toMatchObject({ ok: false });
      expect(result.checks.queue?.detail).toMatch(
        /queue\.json.*(?:directory|EISDIR|read)|(?:directory|EISDIR|read).*queue\.json/i,
      );
      expect(result.verdict).toBe('STOP');
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  });

  it('reads exactly one adapter listing without selecting, claiming, or writing queue and run files', async () => {
    const p = await fixture({ adapter: 'plan-md' });
    const adapterPath = path.join(p.root, '.claude', 'scripts', 'queue', 'plan-md.mjs');
    const tracePath = path.join(p.root, 'adapter.trace');
    const journalFile = path.join(p.journalPath, '2026-09.md');
    const runFile = path.join(p.runPath, 'previous', 'state.json');
    const claimPath = path.join(p.root, '.rig', 'claims', '1.json');
    const plan = '## Agent queue\n- leave this item untouched\n';
    await writeFile(
      adapterPath,
      "import { appendFileSync } from 'node:fs';\n" +
        "const ticket = new Proxy({}, { get: () => { throw new Error('preflight must not select'); } });\n" +
        "export const listEligible = () => { appendFileSync(process.env.PREFLIGHT_QUEUE_TRACE, 'listEligible\\n'); return [ticket]; };\n" +
        "export const next = () => { throw new Error('preflight must not select'); };\n" +
        "export const claim = () => { throw new Error('preflight must not claim'); };\n",
    );
    await writeFile(p.planPath, plan);
    await mkdir(path.dirname(journalFile), { recursive: true });
    await mkdir(path.dirname(runFile), { recursive: true });
    await writeFile(journalFile, 'existing journal entry\n');
    await writeFile(runFile, '{"existing":"run state"}\n');
    try {
      const result = await preflight(p, { PREFLIGHT_QUEUE_TRACE: tracePath });

      expect(result.checks.queue).toMatchObject({ ok: true });
      expect(await readFile(tracePath, 'utf8')).toBe('listEligible\n');
      expect(await readFile(p.planPath, 'utf8')).toBe(plan);
      expect(await readFile(journalFile, 'utf8')).toBe('existing journal entry\n');
      expect(await readFile(runFile, 'utf8')).toBe('{"existing":"run state"}\n');
      expect(existsSync(claimPath)).toBe(false);
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  });
});
