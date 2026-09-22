import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

// RP-208: `listEligible` and `listProposals` each read ONE capped
// `gh issue list` window. Open and closed issues shared that window, so in a
// repository with more than `limit` issues the older OPEN issues could be
// pushed out by closed history, and nothing said so. This file pins the fix:
// open and closed are fetched as two separate `--state` windows, and a window
// that comes back exactly at the limit is announced on stderr — the same
// shape `queue-jira.test.ts` › "stops at hardCap and says on stderr that the
// list was capped" already pins for the Jira adapter.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const queueDir = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'queue',
);
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: unknown[];
  url: string | null;
  createdAt: string | null;
}

const issue = (over: Partial<Issue> = {}): Issue => ({
  number: 1,
  title: 't',
  body: '',
  state: 'OPEN',
  labels: [],
  url: null,
  createdAt: null,
  ...over,
});

const manyIssues = (count: number, state: 'OPEN' | 'CLOSED', startNumber: number): Issue[] =>
  Array.from({ length: count }, (_, i) =>
    issue({ number: startNumber + i, state, title: `${state} ${i}` }),
  );

interface Proposal {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: unknown[];
  url: string | null;
  createdAt: string | null;
}

const manyProposals = (count: number): Proposal[] =>
  Array.from({ length: count }, (_, i) => ({
    number: 2000 + i,
    title: `proposal ${i}`,
    body: `proposal ${i}`,
    state: 'OPEN' as const,
    labels: ['triage'],
    url: null,
    createdAt: null,
  }));

/**
 * A `gh` on PATH that answers `issue list` differently per `--state` (and
 * separately for the `--label triage` window), logging every call's argv one
 * line per call so a test can assert which window each call asked for.
 */
const installGh = async (responses: {
  open?: Issue[];
  closed?: Issue[];
  all?: Issue[];
  triage?: Proposal[];
}): Promise<{ stub: StubHandle; logFile: string; calls: () => Promise<string[]> }> => {
  const bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-pg-'));
  const logFile = path.join(bin, 'calls.log');
  const stub = await stubCommand(
    'gh',
    `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');
     const responses = ${JSON.stringify(responses)};
     if (args[0] === 'issue' && args[1] === 'list') {
       if (args.includes('triage')) return { stdout: JSON.stringify(responses.triage || []) + '\\n' };
       const stateIdx = args.indexOf('--state');
       const state = stateIdx === -1 ? null : args[stateIdx + 1];
       const list = (state && responses[state]) || [];
       return { stdout: JSON.stringify(list) + '\\n' };
     }
     return { stdout: '[]\\n' };`,
  );
  return {
    stub,
    logFile,
    calls: async () => (await readFile(logFile, 'utf8')).split('\n').filter(Boolean),
  };
};

describe('github-issues: open and closed issues are fetched as separate windows', () => {
  const stderr: string[] = [];
  let realStderrWrite: typeof process.stderr.write;
  let stub: StubHandle | undefined;

  beforeEach(() => {
    stderr.length = 0;
    realStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    stub?.restore();
    stub = undefined;
  });

  it('keeps an older OPEN issue even when 100 CLOSED issues would fill a shared window', async () => {
    // Today's `listEligible` asks ONE `--state all` window; a repository whose
    // 100 newest issues are all closed pushes an older open issue out of it.
    const closedNewest = manyIssues(100, 'CLOSED', 1000);
    const olderOpen = issue({ number: 5, state: 'OPEN', title: 'older open item' });
    const installed = await installGh({
      all: closedNewest,
      open: [olderOpen],
      closed: closedNewest,
    });
    stub = installed.stub;

    const { listEligible } = await load('github-issues.mjs');
    const result = listEligible() as Array<{ id: string }>;

    expect(
      result.map((t) => t.id),
      'the older open issue must survive a full window of closed history',
    ).toContain('5');
    const calls = await installed.calls();
    expect(
      calls.some((line) => line.startsWith('issue list') && line.includes('--state open')),
      calls.join('\n'),
    ).toBe(true);
    expect(
      calls.some((line) => line.startsWith('issue list') && line.includes('--state closed')),
      calls.join('\n'),
    ).toBe(true);
  });

  it.each(['open', 'closed'] as const)(
    'a --state %s window that comes back exactly at the limit is announced on stderr',
    async (state) => {
      const full = manyIssues(3, state === 'open' ? 'OPEN' : 'CLOSED', 1);
      const other = manyIssues(1, state === 'open' ? 'CLOSED' : 'OPEN', 900);
      const installed = await installGh(
        state === 'open' ? { open: full, closed: other } : { open: other, closed: full },
      );
      stub = installed.stub;

      const { listEligible } = await load('github-issues.mjs');
      listEligible({ limit: 3 });

      expect(stderr.join(''), 'nothing announced the cap').toMatch(/capped/i);
      expect(stderr.join(''), 'the announcement does not say which window filled').toMatch(
        new RegExp(state, 'i'),
      );
      expect(stderr.join(''), 'the announcement does not name the limit').toContain('3');
    },
  );

  it('a window below the limit writes nothing to stderr', async () => {
    const installed = await installGh({
      open: manyIssues(2, 'OPEN', 1),
      closed: manyIssues(2, 'CLOSED', 100),
    });
    stub = installed.stub;

    const { listEligible } = await load('github-issues.mjs');
    listEligible({ limit: 3 });

    expect(stderr.join('')).toBe('');
  });
});

describe('github-issues: listProposals reports a full triage window on stderr', () => {
  const stderr: string[] = [];
  let realStderrWrite: typeof process.stderr.write;
  let stub: StubHandle | undefined;

  beforeEach(() => {
    stderr.length = 0;
    realStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    stub?.restore();
    stub = undefined;
  });

  it('a triage window that comes back exactly at the cap (100) is announced on stderr', async () => {
    const installed = await installGh({ triage: manyProposals(100) });
    stub = installed.stub;

    const { listProposals } = await load('github-issues.mjs');
    const result = listProposals() as Array<{ id: string }>;

    expect(result).toHaveLength(100);
    expect(stderr.join(''), 'nothing announced the cap').toMatch(/capped/i);
  });

  it('a triage window below the cap writes nothing to stderr', async () => {
    const installed = await installGh({ triage: manyProposals(2) });
    stub = installed.stub;

    const { listProposals } = await load('github-issues.mjs');
    listProposals();

    expect(stderr.join('')).toBe('');
  });
});
