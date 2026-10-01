import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-325 — Jira can return an empty search to an authenticated account that
// cannot browse the configured project. An empty response is a valid queue only
// after the adapter has established that the configured project is visible.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const load = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);

const credentials = {
  JIRA_BASE_URL: 'https://jira.example.invalid',
  JIRA_EMAIL: 'rig@example.invalid',
  JIRA_API_TOKEN: 'test-token',
};

type Call = { method: string; pathname: string; search: string };

const response = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? 'Not Found' : status === 403 ? 'Forbidden' : 'OK',
  headers: { get: () => null },
  json: async () => body,
});

let realFetch: typeof globalThis.fetch;
let previousEnv: Record<string, string | undefined>;
const tempRoots: string[] = [];

const mockFetch = (reply: (call: Call) => ReturnType<typeof response>) => {
  const calls: Call[] = [];
  globalThis.fetch = ((input: unknown, init: RequestInit = {}) => {
    const call = {
      method: init.method ?? 'GET',
      pathname: new URL(String(input)).pathname,
      search: new URL(String(input)).search,
    };
    calls.push(call);
    return Promise.resolve(reply(call));
  }) as unknown as typeof globalThis.fetch;
  return calls;
};

beforeEach(() => {
  realFetch = globalThis.fetch;
  previousEnv = Object.fromEntries(Object.keys(credentials).map((key) => [key, process.env[key]]));
  Object.assign(process.env, credentials);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => removeFixture(root)));
});

describe('Jira project visibility', () => {
  it.each([
    [
      'reports BROWSE_PROJECTS absent',
      response(200, { permissions: { BROWSE_PROJECTS: { havePermission: false } } }),
    ],
    ['receives a malformed permission response', response(200, { permissions: {} })],
    ['is forbidden from reading permissions', response(403)],
  ])(
    'fails closed before treating an empty search as an empty queue when Jira %s',
    async (_case, permission) => {
      const calls = mockFetch((call) =>
        call.pathname === '/rest/api/3/mypermissions' ? permission : response(200, { issues: [] }),
      );
      const { listEligible } = await load('queue/jira.mjs');

      await expect(listEligible({ project: 'RP', env: credentials })).rejects.toThrow(
        /BROWSE_PROJECTS|configured Jira project RP.*not visible|not visible.*configured Jira project RP|403/i,
      );
      expect(calls).toEqual([
        { method: 'POST', pathname: '/rest/api/3/search/jql', search: '' },
        {
          method: 'GET',
          pathname: '/rest/api/3/mypermissions',
          search: '?projectKey=RP&permissions=BROWSE_PROJECTS',
        },
      ]);
    },
  );

  it('accepts a genuinely empty queue after the configured project is confirmed visible', async () => {
    const calls = mockFetch((call) =>
      call.pathname === '/rest/api/3/mypermissions'
        ? response(200, { permissions: { BROWSE_PROJECTS: { havePermission: true } } })
        : response(200, { issues: [] }),
    );
    const { listEligible } = await load('queue/jira.mjs');

    await expect(listEligible({ project: 'RP', env: credentials })).resolves.toEqual([]);
    expect(calls).toEqual([
      { method: 'POST', pathname: '/rest/api/3/search/jql', search: '' },
      {
        method: 'GET',
        pathname: '/rest/api/3/mypermissions',
        search: '?projectKey=RP&permissions=BROWSE_PROJECTS',
      },
    ]);
  });

  it('makes preflight STOP when its configured Jira project is hidden', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jira-visibility-'));
    tempRoots.push(root);
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(
      path.join(root, '.claude', 'queue.json'),
      `${JSON.stringify({ adapter: 'jira', options: { project: 'RP' } })}\n`,
    );
    const calls = mockFetch((call) =>
      call.pathname === '/rest/api/3/mypermissions' ? response(403) : response(200, { issues: [] }),
    );
    const { checkQueue, verdictOf } = await load('preflight.mjs');

    const queue = await checkQueue(root);

    expect(queue).toMatchObject({ ok: false });
    expect(queue.detail).toMatch(
      /BROWSE_PROJECTS|configured Jira project RP.*not visible|not visible.*configured Jira project RP|403/i,
    );
    expect(verdictOf({ queue })).toBe('STOP');
    expect(calls).toEqual([
      { method: 'POST', pathname: '/rest/api/3/search/jql', search: '' },
      {
        method: 'GET',
        pathname: '/rest/api/3/mypermissions',
        search: '?projectKey=RP&permissions=BROWSE_PROJECTS',
      },
    ]);
  });
});
