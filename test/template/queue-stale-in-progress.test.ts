import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-223 — advisory stale-in-progress hygiene.
 *
 * Surfaces an in-progress item whose tracker `updated` timestamp is older than a
 * configurable threshold (default 3 days). Advisory only: no automatic takeover,
 * no automatic reassignment, no heartbeat, no background daemon — a human or
 * controller decides through the tracker.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const queueDir = path.join(universal, '.claude', 'scripts', 'queue');
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

// --- the pure decision --------------------------------------------------------

interface Ticket {
  id: string;
  title: string;
  state: string;
  labels: string[];
  tier: string;
  blockedBy: Array<{ id: string; resolved: boolean }>;
  blocks: string[];
  priority: number;
  createdAt: string | null;
  updatedAt: string | null;
  body: string | null;
  triage: boolean;
  trigger: string | null;
  owner: string | null;
  lifecycle: string | null;
  parked: boolean;
}

// Same shape as queue-lifecycle.test.ts's fixture — one Ticket, read the same
// way regardless of which file exercises it.
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'T-1',
  title: 't',
  state: 'open',
  labels: [],
  tier: 'normal',
  blockedBy: [],
  blocks: [],
  priority: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: null,
  body: null,
  triage: false,
  trigger: null,
  owner: null,
  lifecycle: null,
  parked: false,
  ...over,
});

const NOW = '2026-09-24T12:00:00.000Z';
const daysBefore = (days: number): string =>
  new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();

describe('DEFAULT_STALE_IN_PROGRESS_DAYS', () => {
  it('is 3, the candidate the brief confirmed', async () => {
    const { DEFAULT_STALE_IN_PROGRESS_DAYS } = await load('core.mjs');
    expect(DEFAULT_STALE_IN_PROGRESS_DAYS).toBe(3);
  });
});

describe('staleInProgressOf — pure, now injected (.claude/rules/node-ts.md)', () => {
  it('flags an in-progress item whose updatedAt is older than the default 3-day threshold', async () => {
    const { staleInProgressOf } = await load('core.mjs');
    const updatedAt = daysBefore(4);
    const finding = staleInProgressOf(ticket({ id: 'RP-9', state: 'in-progress', updatedAt }), {
      now: NOW,
    });
    expect(finding).toMatchObject({ kind: 'stale-in-progress', id: 'RP-9' });
    // the evidence: the last-updated instant, the age (one decimal is fine), the
    // threshold, and the takeover decision named as human/controller work done
    // in the tracker — never automatic.
    expect(finding!.why).toContain(updatedAt);
    expect(finding!.why).toMatch(/4(\.0)?\s*days?/i);
    expect(finding!.why).toMatch(/3\s*days?/i);
    expect(finding!.why).toMatch(/human|controller/i);
    expect(finding!.why).toMatch(/tracker/i);
    expect(finding!.why).toMatch(/automatic/i);
  });

  it('is null exactly at the threshold, and under it', async () => {
    const { staleInProgressOf } = await load('core.mjs');
    expect(
      staleInProgressOf(ticket({ state: 'in-progress', updatedAt: daysBefore(3) }), { now: NOW }),
    ).toBeNull();
    expect(
      staleInProgressOf(ticket({ state: 'in-progress', updatedAt: daysBefore(1) }), { now: NOW }),
    ).toBeNull();
  });

  it('is null for an open or a closed item, however old its updatedAt is', async () => {
    const { staleInProgressOf } = await load('core.mjs');
    const updatedAt = daysBefore(30);
    expect(staleInProgressOf(ticket({ state: 'open', updatedAt }), { now: NOW })).toBeNull();
    expect(staleInProgressOf(ticket({ state: 'closed', updatedAt }), { now: NOW })).toBeNull();
  });

  it('is null for an escalated in-progress item — it is left in progress on purpose', async () => {
    const { staleInProgressOf } = await load('core.mjs');
    const updatedAt = daysBefore(30);
    expect(
      staleInProgressOf(ticket({ state: 'in-progress', labels: ['escalated'], updatedAt }), {
        now: NOW,
      }),
    ).toBeNull();
  });

  it('is null when updatedAt is missing or unparseable — cannot judge, not a crash', async () => {
    const { staleInProgressOf } = await load('core.mjs');
    expect(
      staleInProgressOf(ticket({ state: 'in-progress', updatedAt: null }), { now: NOW }),
    ).toBeNull();
    expect(
      staleInProgressOf(ticket({ state: 'in-progress', updatedAt: 'not-a-date' }), { now: NOW }),
    ).toBeNull();
    expect(staleInProgressOf(ticket({ state: 'in-progress' }), { now: NOW })).toBeNull();
  });

  it('honours a custom days threshold', async () => {
    const { staleInProgressOf } = await load('core.mjs');
    const updatedAt = daysBefore(10);
    expect(
      staleInProgressOf(ticket({ id: 'RP-1', state: 'in-progress', updatedAt }), {
        now: NOW,
        days: 20,
      }),
    ).toBeNull();
    const finding = staleInProgressOf(ticket({ id: 'RP-1', state: 'in-progress', updatedAt }), {
      now: NOW,
      days: 5,
    });
    expect(finding).toMatchObject({ kind: 'stale-in-progress', id: 'RP-1' });
    expect(finding!.why).toMatch(/10(\.0)?\s*days?/i);
    expect(finding!.why).toMatch(/5\s*days?/i);
  });
});

// --- the CLI --------------------------------------------------------------

const indexPath = path.join(queueDir, 'index.mjs');
const indexUrl = pathToFileURL(indexPath).href;

const runCli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [indexPath, ...args], {}, (e, out, err) =>
      resolve({
        code: e && typeof e.code === 'number' ? e.code : 0,
        stdout: String(out),
        stderr: String(err),
      }),
    );
  });

/** Real wall-clock offset: the CLI's edge uses `Date.now()`, never an injected clock. */
const realDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const jiraIssue = (over: Record<string, unknown> = {}) => ({
  key: 'AR-1',
  fields: {
    summary: 'do the work',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    labels: [] as string[],
    priority: null,
    created: '2026-07-01T00:00:00.000+0000',
    updated: realDaysAgo(4),
    issuelinks: [],
    ...((over.fields as Record<string, unknown>) ?? {}),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'fields')),
});

/** A `.claude/queue.json` for the jira adapter, using its offline `issues`/`existing` seam. */
const rigWithJira = async (options: Record<string, unknown>): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'stale-cli-'));
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  const configPath = path.join(dir, '.claude', 'queue.json');
  await writeFile(configPath, JSON.stringify({ adapter: 'jira', options }));
  return configPath;
};

describe('CLI hygiene reports stale-in-progress next to another finding for the same item', () => {
  it('appears in text and --json output alongside owner-mismatch', async () => {
    const issue = jiraIssue({ fields: { labels: ['owner-rig-platform'] } });
    const cfg = await rigWithJira({
      project: 'AR',
      issues: [issue],
      existing: [],
      owner: 'create-agent-rig',
    });

    const text = await runCli(['hygiene', '--config', cfg]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/\[stale-in-progress\] AR-1 —/);
    expect(text.stdout).toMatch(/\[owner-mismatch\] AR-1 —/);

    const json = await runCli(['hygiene', '--config', cfg, '--json']);
    expect(json.code, json.stderr).toBe(0);
    const { findings } = JSON.parse(json.stdout) as {
      findings: Array<{ kind: string; id: string }>;
    };
    const kindsForItem = findings.filter((f) => f.id === 'AR-1').map((f) => f.kind);
    expect(kindsForItem).toContain('stale-in-progress');
    expect(kindsForItem).toContain('owner-mismatch');
  });
});

describe('CLI hygiene honours options.staleInProgressDays', () => {
  it('a 4-day-old item is stale under the default and silent under a wider window', async () => {
    const issue = jiraIssue();
    const defaultCfg = await rigWithJira({ project: 'AR', issues: [issue], existing: [] });
    const wideCfg = await rigWithJira({
      project: 'AR',
      issues: [issue],
      existing: [],
      staleInProgressDays: 10,
    });

    const withDefault = await runCli(['hygiene', '--config', defaultCfg]);
    expect(withDefault.code, withDefault.stderr).toBe(0);
    expect(withDefault.stdout).toMatch(/\[stale-in-progress\] AR-1 —/);

    const withWideWindow = await runCli(['hygiene', '--config', wideCfg]);
    expect(withWideWindow.code, withWideWindow.stderr).toBe(0);
    expect(withWideWindow.stdout).not.toMatch(/stale-in-progress/);
  });
});

describe('CLI hygiene refuses an invalid staleInProgressDays instead of silently defaulting', () => {
  it.each([0, -1, 'x'])('exit 1, naming the key, for %j', async (bad) => {
    const cfg = await rigWithJira({
      project: 'AR',
      issues: [jiraIssue()],
      existing: [],
      staleInProgressDays: bad,
    });
    const result = await runCli(['hygiene', '--config', cfg]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/staleInProgressDays/);
  });
});

describe('CLI hygiene never mutates the tracker while reporting a stale item', () => {
  it('the only network call reading a stale in-progress item is the search POST, never a write', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stale-fetch-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    const configPath = path.join(dir, '.claude', 'queue.json');
    // No offline `issues` seam here on purpose: this is the one test that has to
    // go through a real `fetch`, or "no mutating request" would be true only
    // because nothing was requested at all.
    await writeFile(
      configPath,
      JSON.stringify({ adapter: 'jira', options: { project: 'AR', existing: [] } }),
    );
    const issue = jiraIssue();

    const script = `
globalThis.fetch = async (url, init = {}) => {
  const method = String((init && init.method) || 'GET').toUpperCase();
  const pathname = new URL(String(url)).pathname;
  process.stderr.write('STALE_TEST_CALL ' + method + ' ' + pathname + '\\n');
  if (pathname.includes('/search/jql')) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => (${JSON.stringify({ issues: [issue] })}) };
  }
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) };
};
process.argv[1] = ${JSON.stringify(indexPath)};
process.argv.length = 2;
process.argv.push('hygiene', '--config', ${JSON.stringify(configPath)});
await import(${JSON.stringify(indexUrl)});
`;

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          ['--input-type=module', '-e', script],
          {
            env: {
              ...process.env,
              JIRA_BASE_URL: 'https://example.invalid',
              JIRA_EMAIL: 'a@b.c',
              JIRA_API_TOKEN: 'x',
            },
          },
          (e, out, err) =>
            resolve({
              code:
                e && typeof (e as { code?: number }).code === 'number'
                  ? (e as { code: number }).code
                  : 0,
              stdout: String(out),
              stderr: String(err),
            }),
        );
      },
    );

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\[stale-in-progress\] AR-1 —/);

    const calls = result.stderr
      .split('\n')
      .filter((line) => line.startsWith('STALE_TEST_CALL '))
      .map((line) => line.replace('STALE_TEST_CALL ', ''));
    expect(calls.length, 'the read path was exercised at least once').toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, 'only a GET, or the search POST, ever reaches the tracker').toMatch(
        /^GET |^POST \/rest\/api\/3\/search\/jql$/,
      );
    }
  });
});

describe('the loop skill names the new hygiene finding and its option', () => {
  it('§0 mentions stale-in-progress, staleInProgressDays, and points at this test', async () => {
    const skill = await readFile(
      path.join(universal, '.claude', 'skills', 'loop', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toMatch(/stale-in-progress/);
    expect(skill).toMatch(/staleInProgressDays/);
    expect(skill).toMatch(/queue-stale-in-progress\.test\.ts/);
  });
});
