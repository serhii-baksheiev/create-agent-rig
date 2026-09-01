import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-94. `pr-ship` names owner-directed / hotfix work with no queue item as a
// legitimate path — step 4 tells the fan-out to say "no item" and have the
// reviewer skip the item-contract check openly. Step 1 then made that path
// unexecutable: it called `revalidate.mjs` with an unconditional `--ticket`,
// and the script refused without one. The contradiction was found downstream
// on published 0.7.0 (`gitHead` 6589db36).
//
// The fix is a SECOND explicit mode, never an inferred one and never a skip:
// `--owner-directed` runs the same main-vs-branch drift comparison without a
// tracker, and is refused wherever it could become a way around the claim
// chain.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const revalidateScript = path.join(scriptsDir, 'revalidate.mjs');
const skillPath = path.join(universal, '.claude', 'skills', 'pr-ship', 'SKILL.md');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
  recordDecision: (input: {
    runDir: string;
    gate: string;
    verdict: string;
    blockers?: Array<{ file: string; rule: string; note: string }>;
    now: string;
  }) => unknown;
  readRun: (input: { runDir: string }) => {
    events: Array<{ kind: string; data: Record<string, unknown> | null }>;
  };
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  out: string;
}

const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

/**
 * A repository with no queue item and no claim record — the shape owner-directed
 * work actually has. `origin/master` is a real remote-tracking ref, and
 * `moveMain` lands a commit on it through a second clone so the default branch
 * moves without the branch doing anything.
 *
 * Deliberately NOT the `revalidate.test.ts` fixture: that one exists to build a
 * tracked claim baseline, and the absence of one is the condition under test.
 */
interface Fixture {
  clone: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
  moveMain: (files: string[]) => Promise<void>;
}

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'owner-directed-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');
  const other = path.join(root, 'other');
  await mkdir(origin);
  await git(['init', '--bare', '-b', 'master'], origin);
  await git(['clone', '-q', origin, clone], root);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await writeFile(path.join(clone, name), `${name} v1\n`);
  }
  await git(['add', '-A'], clone);
  await git(['commit', '-q', '-m', 'seed'], clone);
  await git(['push', '-q', '-u', 'origin', 'master'], clone);
  await git(['checkout', '-q', '-b', 'hotfix/owner-directed'], clone);
  await writeFile(path.join(clone, 'a.txt'), 'a.txt on the branch\n');
  await git(['commit', '-q', '-a', '-m', 'the hotfix touches a.txt'], clone);

  const moveMain = async (files: string[]): Promise<void> => {
    await git(['clone', '-q', origin, other], root).catch(() => '');
    await git(['pull', '-q', 'origin', 'master'], other);
    for (const name of files) {
      await writeFile(path.join(other, name), `${name} moved on main\n`);
    }
    await git(['add', '-A'], other);
    await git(['commit', '-q', '-m', `main touches ${files.join(',')}`], other);
    await git(['push', '-q', 'origin', 'HEAD:master'], other);
    await git(['fetch', '-q', 'origin'], clone);
  };

  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  return { clone, runDir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir }, moveMain };
};

const revalidate = (f: Fixture, args: string[]) =>
  run(process.execPath, [revalidateScript, ...args], f.clone, f.env);

const ownerDirected = (f: Fixture, extra: string[] = []) =>
  revalidate(f, ['--point', 'BEFORE_PR', '--owner-directed', '--base', 'origin/master', ...extra]);

interface Result {
  ticket: string | null;
  mode?: string;
  point: string;
  action: 'hold' | 'continue' | 'unverifiable';
  source: string[];
  changed: boolean | null;
  main: { base: string; mergeBase: string; cited: string[]; changed: string[] };
  evidence?: Record<string, unknown>;
}

const jsonOf = async (r: Run): Promise<Result> => {
  expect(r.stdout, r.out).not.toBe('');
  return JSON.parse(r.stdout) as Result;
};

const revalidationEvents = (runDir: string) =>
  journal.readRun({ runDir }).events.filter((e) => e.kind === 'revalidation');

describe('revalidate.mjs — the owner-directed BEFORE_PR mode (RP-94)', () => {
  it('runs BEFORE_PR with no item and no claim when the default branch did not move under the branch', async () => {
    const f = await fixture();
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(0);
    const result = await jsonOf(r);
    expect(result.action).toBe('continue');
    expect(result.source).toEqual([]);
    // No fictitious item id is invented for the record.
    expect(result.ticket).toBeNull();
    expect(result.mode).toBe('owner-directed');
  });

  it('journals one explicit revalidation event naming the mode, with no ticket', async () => {
    const f = await fixture();
    expect((await ownerDirected(f)).code).toBe(0);
    const events = revalidationEvents(f.runDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.data?.mode).toBe('owner-directed');
    expect(events[0]?.data?.ticket).toBeNull();
    expect(events[0]?.data?.point).toBe('BEFORE_PR');
  });

  it('HOLDs when the default branch moved under a path the branch touches', async () => {
    const f = await fixture();
    await f.moveMain(['a.txt']);
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(2);
    const result = await jsonOf(r);
    expect(result.action).toBe('hold');
    expect(result.source).toEqual(['main:a.txt']);
    expect(result.main.changed).toEqual(['a.txt']);
  });

  it('does not hold when the default branch moved under an unrelated path', async () => {
    const f = await fixture();
    await f.moveMain(['b.txt']);
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(0);
    expect((await jsonOf(r)).action).toBe('continue');
  });

  it('HOLDs when the default branch moved under a path a check-premises record cited', async () => {
    const f = await fixture();
    journal.recordDecision({
      runDir: f.runDir,
      gate: 'check-premises',
      verdict: 'HOLD',
      blockers: [{ file: 'c.txt', rule: 'premise', note: 'the hotfix rests on c.txt' }],
      now: '2026-09-02T10:00:00.000Z',
    });
    await f.moveMain(['c.txt']);
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(2);
    const result = await jsonOf(r);
    expect(result.source).toEqual(['main:c.txt']);
    expect(result.main.cited).toContain('c.txt');
  });

  it('needs no tracker credentials: an adapter name that cannot resolve is never reached', async () => {
    const f = await fixture();
    const configPath = path.join(f.clone, 'broken-queue.json');
    await writeFile(configPath, JSON.stringify({ adapter: 'no-such-adapter' }));
    const bare = { ...f.env };
    for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete bare[key];
    const r = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_PR',
        '--owner-directed',
        '--base',
        'origin/master',
        '--config',
        configPath,
      ],
      f.clone,
      bare,
    );
    expect(r.code, r.out).toBe(0);
    // The ticketed mode on the same config is the control: it DOES resolve one.
    const ticketed = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_PR',
        '--ticket',
        'RP-1',
        '--base',
        'origin/master',
        '--config',
        configPath,
      ],
      f.clone,
      bare,
    );
    expect(ticketed.code, ticketed.out).toBe(1);
    expect(ticketed.stderr).toMatch(/could not be resolved/);
  });
});

describe('revalidate.mjs — the mode is always explicit (RP-94)', () => {
  it('refuses both modes at once: exit 1, stderr only, nothing journaled', async () => {
    const f = await fixture();
    const r = await revalidate(f, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'RP-1',
      '--owner-directed',
      '--base',
      'origin/master',
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--ticket/);
    expect(r.stderr).toMatch(/--owner-directed/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses neither mode: exit 1, and the message names both ways forward', async () => {
    const f = await fixture();
    const r = await revalidate(f, ['--point', 'BEFORE_PR', '--base', 'origin/master']);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--ticket/);
    expect(r.stderr).toMatch(/--owner-directed/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses owner-directed at BEFORE_CLOSE — the mode exists for BEFORE_PR only', async () => {
    const f = await fixture();
    const r = await revalidate(f, ['--point', 'BEFORE_CLOSE', '--owner-directed']);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/BEFORE_CLOSE/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses owner-directed on an outcome — an outcome answers a ticketed revalidation', async () => {
    const f = await fixture();
    const r = await revalidate(f, [
      'outcome',
      '--point',
      'BEFORE_PR',
      '--owner-directed',
      '--action-changed',
      'false',
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
  });
});

describe('revalidate.mjs — owner-directed is never a way around the claim chain (RP-94)', () => {
  it('refuses when the declared run already carries a take-up', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.runDir, 'state.json'),
      JSON.stringify({ takeUps: { 'RP-1': '2026-09-01T00:00:00.000Z' } }),
    );
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/take-up/);
    expect(r.stderr).toMatch(/RP-1/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses when the branch diff adds a tracked claim record', async () => {
    const f = await fixture();
    await mkdir(path.join(f.clone, '.rig', 'claims'), { recursive: true });
    await writeFile(
      path.join(f.clone, '.rig', 'claims', 'RP-1.json'),
      JSON.stringify({ schemaVersion: 1, ticket: 'RP-1' }),
    );
    await git(['add', '.rig/claims/RP-1.json'], f.clone);
    await git(['commit', '-q', '-m', 'a claim record on the branch'], f.clone);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/\.rig\/claims\/RP-1\.json/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses when the branch diff modifies a tracked claim record', async () => {
    const f = await fixture();
    // The record exists on the default branch, so the branch MODIFIES it.
    await mkdir(path.join(f.clone, '.rig', 'claims'), { recursive: true });
    await writeFile(
      path.join(f.clone, '.rig', 'claims', 'RP-2.json'),
      JSON.stringify({ schemaVersion: 1, ticket: 'RP-2' }),
    );
    await git(['add', '.rig/claims/RP-2.json'], f.clone);
    await git(['commit', '-q', '-m', 'seed the claim'], f.clone);
    await git(['push', '-q', 'origin', 'HEAD:master'], f.clone);
    await git(['fetch', '-q', 'origin'], f.clone);
    await writeFile(
      path.join(f.clone, '.rig', 'claims', 'RP-2.json'),
      JSON.stringify({ schemaVersion: 1, ticket: 'RP-2', tampered: true }),
    );
    await git(['commit', '-q', '-a', '-m', 'rewrite the claim'], f.clone);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/\.rig\/claims\/RP-2\.json/);
  });

  it('leaves the ticketed mode exactly as it was: a missing claim is UNVERIFIABLE and holds', async () => {
    const f = await fixture();
    const configPath = path.join(f.clone, 'queue.json');
    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'jira',
        options: {
          project: 'RP',
          issues: [
            {
              key: 'RP-1',
              fields: {
                summary: 'an item',
                status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
                labels: ['in-progress'],
                priority: null,
                created: '2026-07-01T00:00:00.000+0000',
                updated: '2026-07-01T00:00:00.000+0000',
                issuelinks: [],
              },
            },
          ],
        },
      }),
    );
    const r = await revalidate(f, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'RP-1',
      '--base',
      'origin/master',
      '--config',
      configPath,
      '--json',
    ]);
    expect(r.code, r.out).toBe(2);
    const result = await jsonOf(r);
    expect(result.action).toBe('unverifiable');
    expect(result.ticket).toBe('RP-1');
  });
});

describe('pr-ship states both BEFORE_PR paths, and skips neither (RP-94)', () => {
  const surfaces = [
    ['universal (canonical)', skillPath],
    ['the synced Claude tree', path.join(repoRoot, '.claude', 'skills', 'pr-ship', 'SKILL.md')],
    ['the Codex projection', path.join(repoRoot, '.agents', 'skills', 'pr-ship', 'SKILL.md')],
    [
      'the templates Codex projection',
      path.join(universal, '.agents', 'skills', 'pr-ship', 'SKILL.md'),
    ],
  ] as const;

  it.each(surfaces)('%s carries the owner-directed BEFORE_PR call', async (_label, file) => {
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/revalidate\.mjs --point BEFORE_PR --ticket <item-id>/);
    expect(text).toMatch(/revalidate\.mjs --point BEFORE_PR --owner-directed/);
  });

  it('every surface carries the same BEFORE_PR step, byte for byte', async () => {
    const texts = await Promise.all(surfaces.map(([, file]) => readFile(file, 'utf8')));
    const stepOf = (text: string) => {
      const start = text.indexOf('--point BEFORE_PR --ticket');
      const end = text.indexOf('--point BEFORE_PR --owner-directed');
      expect(start, 'the ticketed call is missing').toBeGreaterThan(-1);
      expect(end, 'the owner-directed call is missing').toBeGreaterThan(-1);
      return text.slice(Math.min(start, end), Math.max(start, end) + 200);
    };
    const [first, ...rest] = texts.map(stepOf);
    for (const other of rest) expect(other).toBe(first);
  });

  // 🔴 The mutation this pins: "owner-directed work simply skips BEFORE_PR".
  // That is the cheap fix the ticket forbids, and prose is where it would be
  // written. A skill that tells a run to skip the checkpoint fails here.
  it('never offers skipping BEFORE_PR as the answer for work with no item', async () => {
    const text = await readFile(skillPath, 'utf8');
    expect(text).not.toMatch(/skip (?:the )?(?:step 1|BEFORE_PR|revalidation)/i);
    expect(text).not.toMatch(/BEFORE_PR (?:is|can be) skipped/i);
  });

  // The fan-out consequence stays exactly one check wide.
  it('says the fan-out is told `no item — owner-directed`, and only that check is skipped', async () => {
    const text = await readFile(skillPath, 'utf8');
    expect(text).toMatch(/no item — owner-directed/);
    // `\s+`, not a literal space: markdown wraps, and a term split across two
    // lines is the same term. Nothing about the claim is weakened by it.
    expect(text).toMatch(/item-contract\s+check/);
  });
});
