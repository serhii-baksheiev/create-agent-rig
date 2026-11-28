import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, '.claude', 'scripts', 'git-env.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const load = (file: string) =>
  import(
    `${pathToFileURL(path.join(queueDir, file)).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
  );
const T0 = '2026-11-28T00:00:00.000Z';
const ticket = {
  id: 'RP-554',
  title: 'admission diagnosis fixture',
  state: 'open',
  labels: [],
  blockedBy: [],
  blocks: [],
  priority: 1,
  createdAt: T0,
  updatedAt: T0,
};

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    env: withoutGitLocation(),
    timeout: 30_000,
  }).trim();

describe('claim admission diagnosis (RP-554)', () => {
  let fetchBefore: typeof globalThis.fetch;
  let gh: StubHandle | undefined;
  const roots: string[] = [];

  beforeEach(() => {
    fetchBefore = globalThis.fetch;
  });
  afterEach(async () => {
    globalThis.fetch = fetchBefore;
    gh?.restore();
    gh = undefined;
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('reports an allowlisted unavailable PR source after native duplicate-work exits 3 without reflecting child stderr', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-admission-diagnosis-'));
    roots.push(root);
    git(['init', '-q', '-b', 'master'], root);
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      JSON.stringify({
        schemaVersion: 1,
        detection: {
          mode: 'pull',
          sources: ['run-state', 'journal'],
          acceptedLatency: '24h',
          push: false,
        },
        pairedFacts: [],
      }),
    );
    git(['add', '.rig/revalidation.json'], root);
    git(['commit', '-q', '-m', 'seed'], root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected baseline'], root);
    const runDir = path.join(root, '.claude', 'runs', 'rp554-diagnosis');
    await mkdir(runDir, { recursive: true });
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: ticket.updatedAt } },
      now: T0,
    });

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    const bait = 'RP554-NATIVE-STDERR-BAIT-/tmp/not-for-diagnosis';
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        `process.stderr.write(${JSON.stringify(bait)} + '\\n'); return { exitCode: 127 };`,
      ].join('\n'),
    );
    let posts = 0;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const method = String(init.method ?? 'GET');
      const pathname = new URL(String(input)).pathname;
      if (method === 'POST' && pathname.endsWith('/transitions')) {
        posts += 1;
        return Promise.resolve({
          ok: true,
          status: 204,
          statusText: '',
          headers: { get: () => null },
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'GET' && pathname.endsWith('/changelog')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: '',
          headers: { get: () => null },
          json: () => Promise.resolve({ total: 0, values: [] }),
          text: () => Promise.resolve('{}'),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            fields: {
              status: { name: 'To Do', statusCategory: { key: 'new' } },
              updated: T0,
              assignee: null,
            },
          }),
        text: () => Promise.resolve('{}'),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: root,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: runDir,
      },
    });

    expect(existsSync(nativeMarker)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-source-unavailable',
      unavailableSources: ['pr'],
    });
    expect(JSON.stringify(result)).not.toContain(bait);
    expect(posts).toBe(0);
  });

  it('reports only branch when native duplicate-work exits 3 after its branch source is unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-admission-diagnosis-'));
    roots.push(root);
    git(['init', '-q', '-b', 'master'], root);
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      JSON.stringify({
        schemaVersion: 1,
        detection: {
          mode: 'pull',
          sources: ['run-state', 'journal'],
          acceptedLatency: '24h',
          push: false,
        },
        pairedFacts: [],
      }),
    );
    git(['add', '.rig/revalidation.json'], root);
    git(['commit', '-q', '-m', 'seed'], root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);
    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected baseline'], root);
    const runDir = path.join(root, '.claude', 'runs', 'rp554-diagnosis');
    await mkdir(runDir, { recursive: true });
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: ticket.updatedAt } },
      now: T0,
    });
    git(['remote', 'set-url', 'origin', path.join(root, '.missing-origin.git')], root);

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    let posts = 0;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const method = String(init.method ?? 'GET');
      const pathname = new URL(String(input)).pathname;
      if (method === 'POST' && pathname.endsWith('/transitions')) {
        posts += 1;
        return Promise.resolve({
          ok: true,
          status: 204,
          statusText: '',
          headers: { get: () => null },
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'GET' && pathname.endsWith('/changelog')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: '',
          headers: { get: () => null },
          json: () => Promise.resolve({ total: 0, values: [] }),
          text: () => Promise.resolve('{}'),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            fields: {
              status: { name: 'To Do', statusCategory: { key: 'new' } },
              updated: T0,
              assignee: null,
            },
          }),
        text: () => Promise.resolve('{}'),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: root,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: runDir,
      },
    });

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({
            ticket: 'RP-554',
            verdict: 'unverifiable',
            sources: [
              { name: 'branch', status: 'unavailable' },
              { name: 'pr', status: 'read' },
            ],
          }),
        }),
      ]),
    );
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-source-unavailable',
      unavailableSources: ['branch'],
    });
    expect(posts).toBe(0);
  });

  it('reports sorted branch and PR sources when both native duplicate-work sources are unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-admission-diagnosis-'));
    roots.push(root);
    git(['init', '-q', '-b', 'master'], root);
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      JSON.stringify({
        schemaVersion: 1,
        detection: {
          mode: 'pull',
          sources: ['run-state', 'journal'],
          acceptedLatency: '24h',
          push: false,
        },
        pairedFacts: [],
      }),
    );
    git(['add', '.rig/revalidation.json'], root);
    git(['commit', '-q', '-m', 'seed'], root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);
    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected baseline'], root);
    const runDir = path.join(root, '.claude', 'runs', 'rp554-diagnosis');
    await mkdir(runDir, { recursive: true });
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: ticket.updatedAt } },
      now: T0,
    });
    git(['remote', 'set-url', 'origin', path.join(root, '.missing-origin.git')], root);

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "process.stderr.write('pr unavailable\\n'); return { exitCode: 127 };",
      ].join('\n'),
    );
    let posts = 0;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const method = String(init.method ?? 'GET');
      const pathname = new URL(String(input)).pathname;
      if (method === 'POST' && pathname.endsWith('/transitions')) {
        posts += 1;
        return Promise.resolve({
          ok: true,
          status: 204,
          statusText: '',
          headers: { get: () => null },
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'GET' && pathname.endsWith('/changelog')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: '',
          headers: { get: () => null },
          json: () => Promise.resolve({ total: 0, values: [] }),
          text: () => Promise.resolve('{}'),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            fields: {
              status: { name: 'To Do', statusCategory: { key: 'new' } },
              updated: T0,
              assignee: null,
            },
          }),
        text: () => Promise.resolve('{}'),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: root,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: runDir,
      },
    });

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({
            ticket: 'RP-554',
            verdict: 'unverifiable',
            sources: [
              { name: 'branch', status: 'unavailable' },
              { name: 'pr', status: 'unavailable' },
            ],
          }),
        }),
      ]),
    );
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-source-unavailable',
      unavailableSources: ['branch', 'pr'],
    });
    expect(posts).toBe(0);
  });

  it('reports a fixed invocation diagnostic when only the native duplicate-work child terminates itself with SIGTERM', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-admission-diagnosis-'));
    roots.push(root);
    git(['init', '-q', '-b', 'master'], root);
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      JSON.stringify({
        schemaVersion: 1,
        detection: {
          mode: 'pull',
          sources: ['run-state', 'journal'],
          acceptedLatency: '24h',
          push: false,
        },
        pairedFacts: [],
      }),
    );
    git(['add', '.rig/revalidation.json'], root);
    git(['commit', '-q', '-m', 'seed'], root);
    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected baseline'], root);
    const runDir = path.join(root, '.claude', 'runs', 'rp554-diagnosis');
    await mkdir(runDir, { recursive: true });
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554diagnosis=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: ticket.updatedAt } },
      now: T0,
    });
    const preloadDir = await mkdtemp(path.join(tmpdir(), 'rp554-negative-only-native-signal-'));
    roots.push(preloadDir);
    const preload = path.join(preloadDir, 'terminate-duplicate-work.mjs');
    const marker = path.join(root, 'native-sigterm-marker');
    const bait = `RP554-NATIVE-SIGTERM-BAIT:${preloadDir}`;
    await writeFile(
      preload,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        '// NEGATIVE-ONLY: this preloader may terminate only the duplicate-work child.',
        "if (basename(process.argv[1] ?? '') === 'duplicate-work.mjs') {",
        `  writeFileSync(${JSON.stringify(marker)}, 'SIGTERM injected\\n');`,
        `  process.stderr.write(${JSON.stringify(bait)});`,
        "  process.kill(process.pid, 'SIGTERM');",
        '}',
      ].join('\n'),
    );
    let posts = 0;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      if (
        String(init.method ?? 'GET') === 'POST' &&
        new URL(String(input)).pathname.endsWith('/transitions')
      ) {
        posts += 1;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            fields: {
              status: { name: 'To Do', statusCategory: { key: 'new' } },
              updated: T0,
              assignee: null,
            },
          }),
        text: () => Promise.resolve('{}'),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: root,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: runDir,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
    });

    expect(existsSync(marker)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-invocation-failed',
    });
    expect(JSON.stringify(result)).not.toContain(bait);
    expect(JSON.stringify(result)).not.toContain(preloadDir);
    expect(posts).toBe(0);
  });
});
