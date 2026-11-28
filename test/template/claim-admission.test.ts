import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

// RP-554: a tracker write is admitted only by a current, native duplicate-work
// pass that can be durably recorded for this SELECT and scoped run.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, '.claude', 'scripts', 'git-env.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };
const queueDir = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'queue',
);
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const load = (file: string) =>
  import(`${pathToFileURL(path.join(queueDir, file)).href}?rp554=${Date.now()}-${Math.random()}`);
const T0 = '2026-11-28T00:00:00.000Z';
const ticket = {
  id: 'RP-554',
  title: 'admission fixture',
  state: 'open',
  labels: [],
  blockedBy: [],
  blocks: [],
  priority: 1,
  createdAt: T0,
  updatedAt: T0,
};

const nativeSelectEvidence = (
  selection: Record<string, unknown>,
  selectedTicket: { updatedAt: string | null },
  from: string | null = null,
) => ({ ...selection, task: { from, to: selectedTicket.updatedAt } });

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    env: withoutGitLocation(),
    timeout: 30_000,
  }).trim();

const project = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rp554-admission-'));
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
  const runDir = path.join(root, '.claude', 'runs', 'rp554');
  await mkdir(runDir, { recursive: true });
  return { root, runDir };
};

class FakeJira {
  posts = 0;
  atFirstPost: { nativeCheckRan: boolean; evidencePersisted: boolean } | null = null;
  state = 'new';
  updated = T0;
  histories: Array<{ created: string; items: Array<{ field: string }> }> = [];

  constructor(
    private readonly observeAtPost:
      (() => { nativeCheckRan: boolean; evidencePersisted: boolean }) | null = null,
  ) {}

  reply(url: string, method: string) {
    const pathname = new URL(url).pathname;
    if (method === 'POST' && pathname.endsWith('/transitions')) {
      if (this.posts === 0 && this.observeAtPost) this.atFirstPost = this.observeAtPost();
      this.posts += 1;
      this.state = 'indeterminate';
      this.updated = new Date(new Date(this.updated).getTime() + 1_000).toISOString();
      this.histories.push({ created: this.updated, items: [{ field: 'status' }] });
      return { status: 204 };
    }
    if (method === 'GET' && pathname.endsWith('/changelog'))
      return { status: 200, json: { total: this.histories.length, values: this.histories } };
    if (method === 'GET' && pathname.includes('/issue/'))
      return {
        status: 200,
        json: {
          fields: {
            status: {
              name: this.state === 'new' ? 'To Do' : 'In Progress',
              statusCategory: { key: this.state },
            },
            updated: this.updated,
            assignee: null,
          },
        },
      };
    return { status: 404, json: {} };
  }
}

describe('claim admission (RP-554)', () => {
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

  const selectedBaseline = async ({ tracked = true }: { tracked?: boolean } = {}) => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);
    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    const baselinePath = claims.claimPathFor(root, ticket);
    if (tracked) {
      git(['add', '.rig/claims/RP-554.json'], root);
      git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    }
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });
    return { root, runDir, journal, baselinePath };
  };

  const claimWithCleanNativeCheck = async (root: string, runDir: string) => {
    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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
    return { fake, nativeMarker, result };
  };

  it('refuses a Jira claim before its first transition when the scoped run has no native SELECT admission', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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

    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim before its first transition when the declared native journal has a malformed complete record', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    // A complete newline-terminated line is not a live writer's partial tail:
    // `readRun` must reject it rather than shortening the ordering evidence.
    await writeFile(path.join(runDir, 'events.jsonl'), 'not-json\n');
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const pending = claim(ticket, {
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

    await expect(pending).resolves.toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'journal-unreadable',
    });
    const result = await pending;
    expect(typeof result.detail).toBe('string');
    expect(result.detail).toMatch(/journal|run|trust/i);
    expect(fake.posts).toBe(0);
  });

  it('refuses a new Jira claim before its first transition when RIG_RUN_DIR is undeclared', async () => {
    const { root } = await project();
    roots.push(root);
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;
    const claimEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JIRA_BASE_URL: 'https://example.invalid',
      JIRA_EMAIL: 'fixture@example.invalid',
      JIRA_API_TOKEN: 'fixture-token',
    };
    delete claimEnv.RIG_RUN_DIR;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, { transitionId: '21', projectRoot: root, env: claimEnv });

    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim with duplicate-work admission when native duplicate-work exits 2', async () => {
    const { root, runDir, journal } = await selectedBaseline();
    const nativeMarker = path.join(root, 'native-duplicate-work-duplicate.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: JSON.stringify([{ number: 7, title: 'RP-554 already underway', head: { ref: 'other-rp-554', repo: { id: 2 } }, base: { repo: { id: 1 } }, html_url: 'https://example.invalid/pr/7' }]) };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'duplicate-work' }),
        }),
      ]),
    );
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'duplicate-work',
    });
    expect(fake.posts).toBe(0);
  });

  it('permits the first Jira transition only after native duplicate-work evidence is persisted for a native SELECT', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira(() => ({
      nativeCheckRan: existsSync(nativeMarker),
      evidencePersisted:
        existsSync(path.join(runDir, 'events.jsonl')) &&
        readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').includes('"kind":"duplicate-work"'),
    }));
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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

    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    expect(fake.posts).toBe(1);
    expect(fake.atFirstPost).toEqual({ nativeCheckRan: true, evidencePersisted: true });
  });

  it('permits a first Jira claim from an untracked native SELECT baseline', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    expect(git(['ls-files', '--', '.rig/claims/RP-554.json'], root)).toBe('');
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira(() => ({
      nativeCheckRan: existsSync(nativeMarker),
      evidencePersisted:
        existsSync(path.join(runDir, 'events.jsonl')) &&
        readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').includes('"kind":"duplicate-work"'),
    }));
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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

    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    expect(fake.posts).toBe(1);
    expect(fake.atFirstPost).toEqual({ nativeCheckRan: true, evidencePersisted: true });
  });

  it('refuses a Jira claim when its selected run differs from this checkout’s armed unattended run', async () => {
    const { root } = await project();
    const selectedRunDir = path.join(root, '.claude', 'runs', 'rp554-selected-b');
    const flaggedRunDir = path.join(root, '.claude', 'runs', 'rp554-flagged-a');
    const flagHome = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-home-'));
    const flagUserProfile = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-profile-'));
    roots.push(root, flagHome, flagUserProfile);
    await mkdir(selectedRunDir, { recursive: true });
    await mkdir(flaggedRunDir, { recursive: true });
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir: selectedRunDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir: selectedRunDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const flagEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: flagHome,
      USERPROFILE: flagUserProfile,
      CLAUDE_PROJECT_DIR: root,
    };
    const { writeUnattended, readUnattended, clearUnattended } = (await import(
      pathToFileURL(path.join(scriptsDir, 'unattended-flag.mjs')).href
    )) as {
      writeUnattended: (
        flag: { item: string; runDir: string; allow: string[] },
        env?: NodeJS.ProcessEnv,
      ) => string[];
      readUnattended: (env?: NodeJS.ProcessEnv) => {
        on: boolean;
        item?: string | null;
        runDir?: string | null;
      };
      clearUnattended: (env?: NodeJS.ProcessEnv) => string[];
    };
    writeUnattended({ item: 'RP-554', runDir: flaggedRunDir, allow: [] }, flagEnv);
    expect(readUnattended(flagEnv)).toMatchObject({
      on: true,
      item: 'RP-554',
      runDir: flaggedRunDir,
    });

    try {
      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        projectRoot: root,
        env: {
          ...flagEnv,
          JIRA_BASE_URL: 'https://example.invalid',
          JIRA_EMAIL: 'fixture@example.invalid',
          JIRA_API_TOKEN: 'fixture-token',
          RIG_RUN_DIR: selectedRunDir,
        },
      });

      expect(result).toMatchObject({ ok: false, claimed: false });
      expect(typeof result.reason).toBe('string');
      expect(fake.posts).toBe(0);
    } finally {
      clearUnattended(flagEnv);
    }
  });

  it('refuses a Jira claim when this checkout’s armed unattended item differs from its selected ticket', async () => {
    const { root } = await project();
    const selectedRunDir = path.join(root, '.claude', 'runs', 'rp554-selected-b');
    const flagHome = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-home-'));
    const flagUserProfile = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-profile-'));
    roots.push(root, flagHome, flagUserProfile);
    await mkdir(selectedRunDir, { recursive: true });
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir: selectedRunDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir: selectedRunDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const flagEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: flagHome,
      USERPROFILE: flagUserProfile,
      CLAUDE_PROJECT_DIR: root,
    };
    const { writeUnattended, readUnattended, clearUnattended } = (await import(
      pathToFileURL(path.join(scriptsDir, 'unattended-flag.mjs')).href
    )) as {
      writeUnattended: (
        flag: { item: string; runDir: string; allow: string[] },
        env?: NodeJS.ProcessEnv,
      ) => string[];
      readUnattended: (env?: NodeJS.ProcessEnv) => {
        on: boolean;
        item?: string | null;
        runDir?: string | null;
      };
      clearUnattended: (env?: NodeJS.ProcessEnv) => string[];
    };
    writeUnattended({ item: 'RP-555', runDir: selectedRunDir, allow: [] }, flagEnv);
    expect(readUnattended(flagEnv)).toMatchObject({
      on: true,
      item: 'RP-555',
      runDir: selectedRunDir,
    });

    try {
      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        projectRoot: root,
        env: {
          ...flagEnv,
          JIRA_BASE_URL: 'https://example.invalid',
          JIRA_EMAIL: 'fixture@example.invalid',
          JIRA_API_TOKEN: 'fixture-token',
          RIG_RUN_DIR: selectedRunDir,
        },
      });

      expect(result).toMatchObject({ ok: false, claimed: false });
      expect(typeof result.reason).toBe('string');
      expect(fake.posts).toBe(0);
    } finally {
      clearUnattended(flagEnv);
    }
  });

  it('permits a Jira claim when this checkout’s armed unattended scope matches its selected ticket and run', async () => {
    const { root, runDir } = await project();
    const flagHome = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-home-'));
    const flagUserProfile = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-profile-'));
    roots.push(root, flagHome, flagUserProfile);
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira(() => ({
      nativeCheckRan: existsSync(nativeMarker),
      evidencePersisted:
        existsSync(path.join(runDir, 'events.jsonl')) &&
        readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').includes('"kind":"duplicate-work"'),
    }));
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const flagEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: flagHome,
      USERPROFILE: flagUserProfile,
      CLAUDE_PROJECT_DIR: root,
    };
    const { writeUnattended, readUnattended, clearUnattended } = (await import(
      pathToFileURL(path.join(scriptsDir, 'unattended-flag.mjs')).href
    )) as {
      writeUnattended: (
        flag: { item: string; runDir: string; allow: string[] },
        env?: NodeJS.ProcessEnv,
      ) => string[];
      readUnattended: (env?: NodeJS.ProcessEnv) => {
        on: boolean;
        item?: string | null;
        runDir?: string | null;
      };
      clearUnattended: (env?: NodeJS.ProcessEnv) => string[];
    };
    writeUnattended({ item: 'RP-554', runDir, allow: [] }, flagEnv);
    expect(readUnattended(flagEnv)).toMatchObject({ on: true, item: 'RP-554', runDir });

    try {
      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        projectRoot: root,
        env: {
          ...flagEnv,
          JIRA_BASE_URL: 'https://example.invalid',
          JIRA_EMAIL: 'fixture@example.invalid',
          JIRA_API_TOKEN: 'fixture-token',
          RIG_RUN_DIR: runDir,
        },
      });

      expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
      expect(fake.posts).toBe(1);
      expect(fake.atFirstPost).toEqual({ nativeCheckRan: true, evidencePersisted: true });
    } finally {
      clearUnattended(flagEnv);
    }
  });

  it('refuses a Jira claim when its armed unattended item changes during the native duplicate-work read', async () => {
    const { root, runDir } = await project();
    const flagHome = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-home-'));
    const flagUserProfile = await mkdtemp(path.join(tmpdir(), 'rp554-unattended-profile-'));
    roots.push(root, flagHome, flagUserProfile);
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const flagEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: flagHome,
      USERPROFILE: flagUserProfile,
      CLAUDE_PROJECT_DIR: root,
    };
    const unattendedUrl = pathToFileURL(path.join(scriptsDir, 'unattended-flag.mjs')).href;
    const { writeUnattended, readUnattended, clearUnattended } = (await import(unattendedUrl)) as {
      writeUnattended: (
        flag: { item: string; runDir: string; allow: string[] },
        env?: NodeJS.ProcessEnv,
      ) => string[];
      readUnattended: (env?: NodeJS.ProcessEnv) => {
        on: boolean;
        item?: string | null;
        runDir?: string | null;
      };
      clearUnattended: (env?: NodeJS.ProcessEnv) => string[];
    };
    writeUnattended({ item: 'RP-554', runDir, allow: [] }, flagEnv);
    expect(readUnattended(flagEnv)).toMatchObject({ on: true, item: 'RP-554', runDir });

    const flagChanged = path.join(root, 'rp554-unattended-flag-changed');
    const controller = path.join(root, 'change-unattended-flag-during-native-check.mjs');
    await writeFile(
      controller,
      [
        "import { writeFileSync } from 'node:fs';",
        `import { clearUnattended, writeUnattended } from ${JSON.stringify(unattendedUrl)};`,
        `const env = { ...process.env, HOME: ${JSON.stringify(flagHome)}, USERPROFILE: ${JSON.stringify(flagUserProfile)}, CLAUDE_PROJECT_DIR: ${JSON.stringify(root)} };`,
        'clearUnattended(env);',
        `writeUnattended({ item: 'RP-555', runDir: ${JSON.stringify(runDir)}, allow: [] }, env);`,
        `writeFileSync(${JSON.stringify(flagChanged)}, 'changed\\n');`,
      ].join('\n'),
    );
    const ghStub = await stubCommand(
      'gh',
      [
        "if (args[0] === 'api' && args[1]?.includes('/pulls?state=open') && !require('node:fs').existsSync(" +
          JSON.stringify(flagChanged) +
          ')) {',
        '  const env = { ...process.env, HOME: ' +
          JSON.stringify(flagHome) +
          ', USERPROFILE: ' +
          JSON.stringify(flagUserProfile) +
          ', CLAUDE_PROJECT_DIR: ' +
          JSON.stringify(root) +
          ' };',
        '  delete env.__STUB_COMMAND; delete env.NODE_OPTIONS;',
        "  require('node:child_process').execFileSync(process.execPath, [" +
          JSON.stringify(controller) +
          "], { env, stdio: 'inherit' });",
        '}',
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    gh = ghStub;
    Object.assign(flagEnv, ghStub.env);
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        projectRoot: root,
        env: {
          ...flagEnv,
          JIRA_BASE_URL: 'https://example.invalid',
          JIRA_EMAIL: 'fixture@example.invalid',
          JIRA_API_TOKEN: 'fixture-token',
          RIG_RUN_DIR: runDir,
        },
      });

      expect(existsSync(flagChanged)).toBe(true);
      expect(readUnattended(flagEnv)).toMatchObject({ on: true, item: 'RP-555', runDir });
      expect(journal.readRun({ runDir }).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'duplicate-work',
            data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
          }),
        ]),
      );
      expect(result).toMatchObject({ ok: false, claimed: false });
      expect(typeof result.reason).toBe('string');
      expect(fake.posts).toBe(0);
    } finally {
      clearUnattended(flagEnv);
    }
  });

  it('refuses a new Jira claim when a fresh native duplicate-work check is unavailable despite an older clean event', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'duplicate-work',
      data: { ticket: ticket.id, verdict: 'clean', matches: [], sources: [] },
      now: T0,
    });

    const nativeMarker = path.join(root, 'native-duplicate-work-failed.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "process.stderr.write('gh unavailable\\n'); return { exitCode: 127 };",
      ].join('\n'),
    );
    const fake = new FakeJira(() => ({
      nativeCheckRan: existsSync(nativeMarker),
      evidencePersisted: readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').includes(
        '"kind":"duplicate-work"',
      ),
    }));
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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
    });
    expect(fake.posts).toBe(0);
  });

  it('refuses a new Jira claim when a clean native check cannot persist its fresh journal receipt', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'duplicate-work',
      data: { ticket: ticket.id, verdict: 'clean', matches: [], sources: [] },
      now: T0,
    });

    const nativeMarker = path.join(root, 'native-duplicate-work-clean.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    await writeFile(path.join(runDir, '.journal.lock'), `${process.pid}:0123456789abcdef`);
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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
    const duplicateEvents =
      readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').match(/"kind":"duplicate-work"/g) ??
      [];
    expect(duplicateEvents).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim from an enclosing checkout when a nested worktree selected the same ticket', async () => {
    const claimingProject = await project();
    roots.push(claimingProject.root);
    const origin = path.join(claimingProject.root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], claimingProject.root);
    git(['remote', 'add', 'origin', origin], claimingProject.root);
    git(['push', '-q', '-u', 'origin', 'master'], claimingProject.root);
    git(['fetch', '-q', 'origin'], claimingProject.root);
    const selectedRoot = path.join(claimingProject.root, '.claude', 'worktrees', 'rp554-foreign');
    await mkdir(path.dirname(selectedRoot), { recursive: true });
    git(
      ['worktree', 'add', '-q', '-b', 'rp554-foreign', selectedRoot, 'master'],
      claimingProject.root,
    );
    const selectedRunDir = path.join(selectedRoot, '.claude', 'runs', 'rp554');
    await mkdir(selectedRunDir, { recursive: true });

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: selectedRoot,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(selectedRoot),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], selectedRoot);
    git(['commit', '-q', '-m', 'record selected claim baseline'], selectedRoot);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir: selectedRunDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir: selectedRunDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });
    const selectedEventsBefore = readFileSync(path.join(selectedRunDir, 'events.jsonl'));
    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );

    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: claimingProject.root,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: selectedRunDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'checkout-unverifiable',
    });
    expect(fake.posts).toBe(0);
    expect(readFileSync(path.join(selectedRunDir, 'events.jsonl'))).toEqual(selectedEventsBefore);
  });

  it('allows a Jira claim from a nested worktree using that worktree’s own selected run', async () => {
    const claimingProject = await project();
    roots.push(claimingProject.root);
    const origin = path.join(claimingProject.root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], claimingProject.root);
    git(['remote', 'add', 'origin', origin], claimingProject.root);
    git(['push', '-q', '-u', 'origin', 'master'], claimingProject.root);
    git(['fetch', '-q', 'origin'], claimingProject.root);
    const selectedRoot = path.join(claimingProject.root, '.claude', 'worktrees', 'rp554-own');
    await mkdir(path.dirname(selectedRoot), { recursive: true });
    git(['worktree', 'add', '-q', '-b', 'rp554-own', selectedRoot, 'master'], claimingProject.root);
    const selectedRunDir = path.join(selectedRoot, '.claude', 'runs', 'rp554');
    await mkdir(selectedRunDir, { recursive: true });

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: selectedRoot,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(selectedRoot),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], selectedRoot);
    git(['commit', '-q', '-m', 'record selected claim baseline'], selectedRoot);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir: selectedRunDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir: selectedRunDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const nativeMarker = path.join(selectedRoot, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira(() => ({
      nativeCheckRan: existsSync(nativeMarker),
      evidencePersisted:
        existsSync(path.join(selectedRunDir, 'events.jsonl')) &&
        readFileSync(path.join(selectedRunDir, 'events.jsonl'), 'utf8').includes(
          '"kind":"duplicate-work"',
        ),
    }));
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: selectedRoot,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: selectedRunDir,
      },
    });

    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    expect(fake.posts).toBe(1);
    expect(fake.atFirstPost).toEqual({ nativeCheckRan: true, evidencePersisted: true });
  });

  it('refuses a Jira claim from an enclosing checkout when caller Git configuration names that checkout as the worktree', async () => {
    const claimingProject = await project();
    roots.push(claimingProject.root);
    const origin = path.join(claimingProject.root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], claimingProject.root);
    git(['remote', 'add', 'origin', origin], claimingProject.root);
    git(['push', '-q', '-u', 'origin', 'master'], claimingProject.root);
    git(['fetch', '-q', 'origin'], claimingProject.root);
    const selectedRoot = path.join(
      claimingProject.root,
      '.claude',
      'worktrees',
      'rp554-configured-foreign',
    );
    await mkdir(path.dirname(selectedRoot), { recursive: true });
    git(
      ['worktree', 'add', '-q', '-b', 'rp554-configured-foreign', selectedRoot, 'master'],
      claimingProject.root,
    );
    const selectedRunDir = path.join(selectedRoot, '.claude', 'runs', 'rp554');
    await mkdir(selectedRunDir, { recursive: true });

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: selectedRoot,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(selectedRoot),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], selectedRoot);
    git(['commit', '-q', '-m', 'record selected claim baseline'], selectedRoot);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir: selectedRunDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir: selectedRunDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });
    const selectedEventsBefore = readFileSync(path.join(selectedRunDir, 'events.jsonl'));
    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );

    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: claimingProject.root,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: selectedRunDir,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.worktree',
        GIT_CONFIG_VALUE_0: claimingProject.root,
      },
    });

    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
    expect(readFileSync(path.join(selectedRunDir, 'events.jsonl'))).toEqual(selectedEventsBefore);
  });

  it('refuses an older Jira ticket after a later native SELECT made another ticket current', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const currentTicket = { ...ticket, id: 'RP-555', title: 'current selection fixture' };
    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const firstSelection = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(firstSelection.result, JSON.stringify(firstSelection)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record first selected claim baseline'], root);
    const currentSelection = claims.revalidateClaim({
      projectRoot: root,
      ticket: currentTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(currentSelection.result, JSON.stringify(currentSelection)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-555.json'], root);
    git(['commit', '-q', '-m', 'record current selected claim baseline'], root);

    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(firstSelection, ticket),
      now: T0,
    });
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-555',
      why: currentTicket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(currentSelection, currentTicket),
      now: T0,
    });
    // This looks like a SELECT for 554 but has no matching later decision;
    // it cannot replace the run's latest native item-selection authority.
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(firstSelection, ticket),
      now: T0,
    });

    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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

    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim while an earlier changed SELECT has no typed resolution', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const baseline = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(baseline.result, JSON.stringify(baseline)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const changed = claims.revalidateClaim({
      projectRoot: root,
      ticket: { ...ticket, title: 'admission fixture changed after selection' },
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: false,
      isResume: false,
    });
    expect(changed.result, JSON.stringify(changed)).toBe('CHANGED');
    const current = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: false,
      isResume: false,
    });
    expect(current.result, JSON.stringify(current)).toBe('CURRENT');

    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(baseline, ticket),
      now: T0,
    });
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: 'changed selection',
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(changed, ticket),
      now: T0,
    });
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
      data: nativeSelectEvidence(current, ticket),
      now: T0,
    });

    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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

    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('permits a Jira claim after the official outcome resolves an earlier changed SELECT and a fresh SELECT is current', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const fixtureNow = '2026-11-26T00:00:00.000Z';
    const fixtureTicket = { ...ticket, createdAt: fixtureNow, updatedAt: fixtureNow };
    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const baseline = claims.revalidateClaim({
      projectRoot: root,
      ticket: fixtureTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(baseline.result, JSON.stringify(baseline)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const changed = claims.revalidateClaim({
      projectRoot: root,
      ticket: { ...fixtureTicket, title: 'admission fixture changed after selection' },
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: false,
      isResume: false,
    });
    expect(changed.result, JSON.stringify(changed)).toBe('CHANGED');

    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: fixtureTicket.title,
      now: fixtureNow,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(baseline, fixtureTicket),
      now: fixtureNow,
    });
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: 'changed selection',
      now: fixtureNow,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(changed, fixtureTicket),
      now: fixtureNow,
    });

    execFileSync(
      process.execPath,
      [
        path.join(scriptsDir, 'revalidate.mjs'),
        'outcome',
        '--point',
        'SELECT',
        '--ticket',
        fixtureTicket.id,
        '--action-changed',
        'false',
        '--detection',
        changed.id,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...withoutGitLocation(process.env), RIG_RUN_DIR: runDir },
        timeout: 30_000,
      },
    );
    expect(
      journal
        .readRun({ runDir })
        .events.find(
          (event: { kind?: string; data?: { detectionId?: string } }) =>
            event.kind === 'revalidation-outcome' && event.data?.detectionId === changed.id,
        ),
    ).toBeTruthy();

    const current = claims.revalidateClaim({
      projectRoot: root,
      ticket: fixtureTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: false,
      isResume: false,
    });
    expect(current.result, JSON.stringify(current)).toBe('CURRENT');
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: fixtureTicket.title,
      now: fixtureNow,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: nativeSelectEvidence(current, fixtureTicket),
      now: fixtureNow,
    });

    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );
    const fake = new FakeJira();
    fake.updated = fixtureNow;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(fixtureTicket, {
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

    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    expect(fake.posts).toBe(1);
  });

  it('refuses an older Jira claim when another controller selects a new ticket during its native duplicate-work PR read', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);

    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const currentTicket = { ...ticket, id: 'RP-555', title: 'concurrent controller selection' };
    const controllerMarker = path.join(root, 'rp555-controller-complete');
    const controller = path.join(root, 'select-rp555-during-duplicate-work.mjs');
    await writeFile(
      controller,
      [
        "import { execFileSync } from 'node:child_process';",
        `import { revalidateClaim, targetShaOf } from ${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href)};`,
        `import { recordDecision, recordEvent } from ${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)};`,
        "import { writeFileSync } from 'node:fs';",
        `const root = ${JSON.stringify(root)};`,
        `const runDir = ${JSON.stringify(runDir)};`,
        `const ticket = ${JSON.stringify(currentTicket)};`,
        `const selected = revalidateClaim({ projectRoot: root, ticket, point: 'SELECT', claimedState: 'in-progress', targetSha: targetShaOf(root), allowCreate: true, isResume: false });`,
        "if (selected.result !== 'BASELINE_CREATED') throw new Error(`RP-555 SELECT failed: ${JSON.stringify(selected)}`);",
        "execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '.rig/claims/RP-555.json'], { cwd: root });",
        "execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'record concurrent selected claim baseline'], { cwd: root });",
        `recordDecision({ runDir, gate: 'item-selection', verdict: 'taken RP-555', why: ticket.title, now: ${JSON.stringify(T0)} });`,
        `recordEvent({ runDir, kind: 'revalidation', data: { ...selected, task: { from: null, to: ticket.updatedAt } }, now: ${JSON.stringify(T0)} });`,
        `writeFileSync(${JSON.stringify(controllerMarker)}, 'complete\\n');`,
      ].join('\n'),
    );

    gh = await stubCommand(
      'gh',
      [
        "if (args[0] === 'api' && args[1]?.includes('/pulls?state=open') && !require('node:fs').existsSync(" +
          JSON.stringify(controllerMarker) +
          ')) {',
        '  const env = { ...process.env }; delete env.__STUB_COMMAND; delete env.NODE_OPTIONS;',
        "  require('node:child_process').execFileSync(process.execPath, [" +
          JSON.stringify(controller) +
          "], { env, stdio: 'inherit' });",
        '}',
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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

    expect(existsSync(controllerMarker)).toBe(true);
    expect(git(['show', 'HEAD:.rig/claims/RP-555.json'], root)).toContain('"ticket": "RP-555"');
    expect(journal.readRun({ runDir }).decisions.at(-1)).toMatchObject({
      gate: 'item-selection',
      verdict: 'taken RP-555',
    });
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'revalidation',
          data: expect.objectContaining({
            point: 'SELECT',
            ticket: 'RP-555',
            result: 'BASELINE_CREATED',
          }),
        }),
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-unverifiable' });
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim when native duplicate-work sees an unresolved changed SELECT during its PR read', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);

    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const controllerMarker = path.join(root, 'rp554-changed-controller-complete');
    const controller = path.join(root, 'record-rp554-changed-during-duplicate-work.mjs');
    await writeFile(
      controller,
      [
        `import { revalidateClaim, targetShaOf } from ${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href)};`,
        `import { recordEvent } from ${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)};`,
        "import { writeFileSync } from 'node:fs';",
        `const root = ${JSON.stringify(root)};`,
        `const runDir = ${JSON.stringify(runDir)};`,
        `const ticket = ${JSON.stringify({ ...ticket, title: 'admission fixture changed during native check' })};`,
        `const changed = revalidateClaim({ projectRoot: root, ticket, point: 'SELECT', claimedState: 'in-progress', targetSha: targetShaOf(root), allowCreate: false, isResume: false });`,
        "if (changed.result !== 'CHANGED') throw new Error(`RP-554 changed SELECT failed: ${JSON.stringify(changed)}`);",
        `recordEvent({ runDir, kind: 'revalidation', data: { ...changed, task: { from: null, to: ticket.updatedAt } }, now: ${JSON.stringify(T0)} });`,
        `writeFileSync(${JSON.stringify(controllerMarker)}, 'complete\\n');`,
      ].join('\n'),
    );

    gh = await stubCommand(
      'gh',
      [
        "if (args[0] === 'api' && args[1]?.includes('/pulls?state=open') && !require('node:fs').existsSync(" +
          JSON.stringify(controllerMarker) +
          ')) {',
        '  const env = { ...process.env }; delete env.__STUB_COMMAND; delete env.NODE_OPTIONS;',
        "  require('node:child_process').execFileSync(process.execPath, [" +
          JSON.stringify(controller) +
          "], { env, stdio: 'inherit' });",
        '}',
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
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

    const run = journal.readRun({ runDir });
    expect(existsSync(controllerMarker)).toBe(true);
    expect(run.decisions).toEqual([
      expect.objectContaining({ gate: 'item-selection', verdict: 'taken RP-554' }),
    ]);
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'revalidation',
          data: expect.objectContaining({ point: 'SELECT', ticket: 'RP-554', result: 'CHANGED' }),
        }),
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(
      run.events.some((event: { kind?: string }) => event.kind === 'revalidation-outcome'),
    ).toBe(false);
    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-unverifiable' });
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim when its selected baseline disappears during the native duplicate-work read', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claimRecordsUrl = pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href;
    const claims = await import(`${claimRecordsUrl}?rp554=${Date.now()}-${Math.random()}`);
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
    const baselinePath = claims.claimPathFor(root, ticket);
    expect(existsSync(baselinePath)).toBe(true);
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const baselineRemoved = path.join(root, 'rp554-baseline-removed');
    const controller = path.join(root, 'remove-rp554-baseline-during-native-check.mjs');
    await writeFile(
      controller,
      [
        "import { unlinkSync, writeFileSync } from 'node:fs';",
        `import { claimPathFor } from ${JSON.stringify(claimRecordsUrl)};`,
        `const root = ${JSON.stringify(root)};`,
        `const ticket = ${JSON.stringify(ticket)};`,
        'unlinkSync(claimPathFor(root, ticket));',
        `writeFileSync(${JSON.stringify(baselineRemoved)}, 'removed\\n');`,
      ].join('\n'),
    );
    const ghStub = await stubCommand(
      'gh',
      [
        "if (args[0] === 'api' && args[1]?.includes('/pulls?state=open') && !require('node:fs').existsSync(" +
          JSON.stringify(baselineRemoved) +
          ')) {',
        '  const env = { ...process.env }; delete env.__STUB_COMMAND; delete env.NODE_OPTIONS;',
        "  require('node:child_process').execFileSync(process.execPath, [" +
          JSON.stringify(controller) +
          "], { env, stdio: 'inherit' });",
        '}',
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    gh = ghStub;
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: root,
      env: {
        ...process.env,
        ...ghStub.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: runDir,
      },
    });

    expect(existsSync(baselineRemoved)).toBe(true);
    expect(existsSync(baselinePath)).toBe(false);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim whose caller snapshot is newer than its native SELECT task snapshot', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const selectedTicket = { ...ticket, updatedAt: T0 };
    const callerTicket = { ...ticket, updatedAt: '2026-11-28T00:00:02.000Z' };
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: root,
      ticket: selectedTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: selectedTicket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: selectedTicket.updatedAt } },
      now: T0,
    });
    expect(journal.readRun({ runDir }).events.at(-1)).toMatchObject({
      kind: 'revalidation',
      data: { point: 'SELECT', ticket: 'RP-554', result: 'BASELINE_CREATED', task: { to: T0 } },
    });

    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );
    const fake = new FakeJira();
    fake.updated = callerTicket.updatedAt;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(callerTicket, {
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

    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('permits a Jira claim when a fresh native CURRENT SELECT task snapshot matches the caller', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const baselineTicket = { ...ticket, updatedAt: T0 };
    const currentTicket = { ...ticket, updatedAt: '2026-11-28T00:00:02.000Z' };
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const baseline = claims.revalidateClaim({
      projectRoot: root,
      ticket: baselineTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(baseline.result, JSON.stringify(baseline)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const current = claims.revalidateClaim({
      projectRoot: root,
      ticket: currentTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: false,
      isResume: false,
    });
    expect(current.result, JSON.stringify(current)).toBe('CURRENT');
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: currentTicket.title,
      now: currentTicket.updatedAt,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...current, task: { from: baselineTicket.updatedAt, to: currentTicket.updatedAt } },
      now: currentTicket.updatedAt,
    });
    expect(journal.readRun({ runDir }).events.at(-1)).toMatchObject({
      kind: 'revalidation',
      data: {
        point: 'SELECT',
        ticket: 'RP-554',
        result: 'CURRENT',
        task: { to: currentTicket.updatedAt },
      },
    });

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira(() => ({
      nativeCheckRan: existsSync(nativeMarker),
      evidencePersisted:
        existsSync(path.join(runDir, 'events.jsonl')) &&
        readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').includes('"kind":"duplicate-work"'),
    }));
    fake.updated = currentTicket.updatedAt;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(currentTicket, {
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

    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    expect(fake.posts).toBe(1);
    expect(fake.atFirstPost).toEqual({ nativeCheckRan: true, evidencePersisted: true });
  });

  it('refuses a Jira claim when its native SELECT task snapshot is null even if the caller is epoch-dated', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const epoch = '1970-01-01T00:00:00.000Z';
    const epochTicket = { ...ticket, updatedAt: epoch };
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: root,
      ticket: epochTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: epochTicket.title,
      now: epoch,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: null } },
      now: epoch,
    });
    expect(journal.readRun({ runDir }).events.at(-1)).toMatchObject({
      kind: 'revalidation',
      data: { point: 'SELECT', ticket: 'RP-554', result: 'BASELINE_CREATED', task: { to: null } },
    });

    gh = await stubCommand(
      'gh',
      ["if (args[0] === 'api') return { stdout: '[]' };", 'return { exitCode: 2 };'].join('\n'),
    );
    const fake = new FakeJira();
    fake.updated = epoch;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(scripted.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(epochTicket, {
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

    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim when an initially unassigned item is reassigned during native duplicate-work', async () => {
    const { root, runDir } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
    git(['commit', '-q', '-m', 'record selected claim baseline'], root);
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
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
      data: nativeSelectEvidence(selected, ticket),
      now: T0,
    });

    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    const reassignedMarker = path.join(root, 'reassigned-to-other-actor');
    gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(nativeMarker)}, 'checked\\n');`,
        "if (args[0] === 'api' && String(args[1] || '').includes('/pulls?') && !require('node:fs').existsSync(" +
          JSON.stringify(reassignedMarker) +
          ")) require('node:fs').writeFileSync(" +
          JSON.stringify(reassignedMarker) +
          ", 'other\\n');",
        "if (args[0] === 'api') return { stdout: '[]' };",
        'return { exitCode: 2 };',
      ].join('\n'),
    );
    const fake = new FakeJira();
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const scripted = fake.reply(String(input), String(init.method ?? 'GET'));
      const pathname = new URL(String(input)).pathname;
      const json =
        pathname.includes('/issue/') && String(init.method ?? 'GET') === 'GET'
          ? {
              ...(scripted.json ?? {}),
              fields: {
                ...(scripted.json?.fields ?? {}),
                assignee: existsSync(reassignedMarker) ? { accountId: 'other-actor' } : null,
              },
            }
          : (scripted.json ?? {});
      return Promise.resolve({
        ok: scripted.status < 300,
        status: scripted.status,
        statusText: '',
        headers: { get: () => null },
        json: () => Promise.resolve(json),
        text: () => Promise.resolve(JSON.stringify(json)),
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

    expect(existsSync(reassignedMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(typeof result.reason).toBe('string');
    expect(result).not.toMatchObject({ workflowClaimRecorded: true });
    expect(fake.posts).toBe(0);
  });

  it('refuses a Jira claim when a tracked selected baseline scope value changes after SELECT', async () => {
    const { root, runDir, journal, baselinePath } = await selectedBaseline();
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.fingerprints.scope.value = 'a'.repeat(64);
    const tampered = `${JSON.stringify(baseline, null, 2)}\n`;
    await writeFile(baselinePath, tampered);
    expect(git(['status', '--short', '--', '.rig/claims/RP-554.json'], root)).not.toBe('');

    const { fake, nativeMarker, result } = await claimWithCleanNativeCheck(root, runDir);

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'claim-baseline-unverifiable',
    });
    expect(result).not.toMatchObject({ workflowClaimRecorded: true });
    expect(fake.posts).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe(tampered);
  });

  it('refuses a Jira claim when an untracked selected baseline target SHA changes after SELECT', async () => {
    const { root, runDir, journal, baselinePath } = await selectedBaseline({ tracked: false });
    expect(git(['ls-files', '--', '.rig/claims/RP-554.json'], root)).toBe('');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.fingerprints.scope.targetSha = 'f'.repeat(40);
    const tampered = `${JSON.stringify(baseline, null, 2)}\n`;
    await writeFile(baselinePath, tampered);
    expect(git(['status', '--short', '--', '.rig/claims/RP-554.json'], root)).not.toBe('');

    const { fake, nativeMarker, result } = await claimWithCleanNativeCheck(root, runDir);

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(result).not.toMatchObject({ workflowClaimRecorded: true });
    expect(fake.posts).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe(tampered);
  });

  it('refuses a Jira claim when stored selected baseline commentary value and count change after SELECT', async () => {
    const { root, runDir, journal, baselinePath } = await selectedBaseline();
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.fingerprints.commentary.value = 'b'.repeat(64);
    baseline.fingerprints.commentary.count = 1;
    const tampered = `${JSON.stringify(baseline, null, 2)}\n`;
    await writeFile(baselinePath, tampered);
    expect(git(['status', '--short', '--', '.rig/claims/RP-554.json'], root)).not.toBe('');

    const { fake, nativeMarker, result } = await claimWithCleanNativeCheck(root, runDir);

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(result).not.toMatchObject({ workflowClaimRecorded: true });
    expect(fake.posts).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe(tampered);
  });

  it('refuses a Jira claim when a workflow claim is forged into the selected baseline before first claim', async () => {
    const { root, runDir, journal, baselinePath } = await selectedBaseline();
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.workflowClaim = { claimedState: 'in-progress' };
    const tampered = `${JSON.stringify(baseline, null, 2)}\n`;
    await writeFile(baselinePath, tampered);
    expect(git(['status', '--short', '--', '.rig/claims/RP-554.json'], root)).not.toBe('');

    const { fake, nativeMarker, result } = await claimWithCleanNativeCheck(root, runDir);

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(result).not.toMatchObject({ workflowClaimRecorded: true });
    expect(fake.posts).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe(tampered);
  });

  it('refuses a Jira claim when a changed selected baseline is committed as a new head after SELECT', async () => {
    const { root, runDir, journal, baselinePath } = await selectedBaseline();
    const headAtSelect = git(['rev-parse', 'HEAD'], root);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.fingerprints.scope.value = 'c'.repeat(64);
    const tampered = `${JSON.stringify(baseline, null, 2)}\n`;
    await writeFile(baselinePath, tampered);
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'tamper selected baseline after native SELECT'], root);
    expect(git(['rev-parse', 'HEAD'], root)).not.toBe(headAtSelect);

    const { fake, nativeMarker, result } = await claimWithCleanNativeCheck(root, runDir);

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(result).not.toMatchObject({ workflowClaimRecorded: true });
    expect(fake.posts).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe(tampered);
  });

  it('permits a Jira claim after an unchanged selected baseline is checkpoint-committed after SELECT', async () => {
    const { root, runDir, journal, baselinePath } = await selectedBaseline({ tracked: false });
    const headAtSelect = git(['rev-parse', 'HEAD'], root);
    const baselineAtSelect = readFileSync(baselinePath, 'utf8');
    expect(git(['ls-files', '--', '.rig/claims/RP-554.json'], root)).toBe('');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'checkpoint after native SELECT'], root);
    expect(git(['rev-parse', 'HEAD'], root)).not.toBe(headAtSelect);
    expect(readFileSync(baselinePath, 'utf8')).toBe(baselineAtSelect);
    expect(git(['ls-files', '--', '.rig/claims/RP-554.json'], root).trim()).toBe(
      '.rig/claims/RP-554.json',
    );
    expect(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], root).trim()).toBe(
      '.rig/claims/RP-554.json',
    );

    const { fake, nativeMarker, result } = await claimWithCleanNativeCheck(root, runDir);

    expect(existsSync(nativeMarker)).toBe(true);
    expect(journal.readRun({ runDir }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-work',
          data: expect.objectContaining({ ticket: 'RP-554', verdict: 'clean' }),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    expect(fake.posts).toBe(1);
  });

  it('binds created and commentary-tolerant current SELECTs to the original stored baseline object', async () => {
    const { root } = await project();
    roots.push(root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);
    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554=${Date.now()}-${Math.random()}`
    );
    const selectedTicket = {
      ...ticket,
      commentary: { ids: ['comment-1'], count: 1, complete: true },
    };
    const created = claims.revalidateClaim({
      projectRoot: root,
      ticket: selectedTicket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(created.result, JSON.stringify(created)).toBe('BASELINE_CREATED');
    expect(git(['ls-files', '--', '.rig/claims/RP-554.json'], root)).toBe('');
    const baselinePath = claims.claimPathFor(root, selectedTicket);
    const baselineBytes = readFileSync(baselinePath, 'utf8');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'checkpoint unchanged selected baseline'], root);
    expect(readFileSync(baselinePath, 'utf8')).toBe(baselineBytes);
    const selectionBaseline = {
      claimObject: git(['rev-parse', 'HEAD:.rig/claims/RP-554.json'], root),
    };

    expect(created).toMatchObject({ selectionBaseline });

    const current = claims.revalidateClaim({
      projectRoot: root,
      ticket: {
        ...selectedTicket,
        commentary: { ids: ['comment-1', 'comment-2'], count: 2, complete: true },
      },
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: false,
      isResume: false,
    });

    expect(current).toMatchObject({
      result: 'CURRENT',
      action: 'continue',
      evidence: { observedFingerprintSet: ['commentary'] },
      selectionBaseline,
    });
  });
});
