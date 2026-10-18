import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-521 — review rounds are evidence of work that was actually launched, not
// attempts to enter a gate. The counter must consume one budget unit only for
// a non-empty `reviewer-fan-out` decision at this checkout's exact HEAD. The
// tests exercise the public queue CLI and the public run-journal writer, so
// they do not prescribe how the counter remembers consumed decision identities.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const queueCli = path.join(scriptsDir, 'queue', 'index.mjs');
const journalModule = path.join(scriptsDir, 'run-journal.mjs');

type Exit = { code: number; stdout: string; stderr: string };

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();

const run = (args: string[], env: NodeJS.ProcessEnv): Promise<Exit> =>
  new Promise((resolve) => {
    execFile(process.execPath, [queueCli, ...args], { env }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });

const counterAt = async (configPath: string, branch: string) => {
  const pathForCounter = configPath.replace(/(\.json)?$/, '.gate-rounds.json');
  if (!existsSync(pathForCounter)) return 0;
  return (
    (JSON.parse(await readFile(pathForCounter, 'utf8')) as Record<string, number>)[branch] ?? 0
  );
};

type Fixture = { configPath: string; branch: string; head: string; root: string };

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'gate-round-evidence-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote');
  await mkdir(repo);
  await mkdir(remote);
  git(remote, ['init', '--bare', '-q']);
  git(repo, ['init', '-q', '-b', 'main']);
  await mkdir(path.join(repo, '.claude'), { recursive: true });
  await writeFile(path.join(repo, '.gitignore'), '.claude/*.gate-rounds.json\n');
  await writeFile(path.join(repo, 'README.md'), 'x\n');
  await writeFile(path.join(repo, '.claude', 'queue.json'), JSON.stringify({ adapter: 'plan-md' }));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  const branch = 'fix/rp-521';
  git(repo, ['checkout', '-q', '-b', branch]);
  git(repo, ['push', '-q', '-u', 'origin', branch]);
  return {
    configPath: path.join(repo, '.claude', 'queue.json'),
    branch,
    head: git(repo, ['rev-parse', 'HEAD']),
    root,
  };
};

const journal = async () =>
  import(pathToFileURL(journalModule).href) as Promise<{
    recordDecision: (input: Record<string, unknown>) => unknown;
  }>;

const fanOut = async ({
  runDir,
  headSha,
  reviewers,
}: {
  runDir: string;
  headSha: string;
  reviewers: string[];
}) => {
  const { recordDecision } = await journal();
  recordDecision({
    runDir,
    gate: 'reviewer-fan-out',
    verdict: 'launched',
    headSha,
    reviewers,
    now: '2026-10-18T00:00:00.000Z',
  });
};

describe('RP-521 — gate-round consumes only recorded reviewer fan-out evidence', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  const newFixture = async () => {
    const value = await fixture();
    roots.push(value.root);
    return value;
  };

  it('does not consume a round when the declared run has no reviewer fan-out record', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-no-fanout-'));
    roots.push(runDir);

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('does not consume a round when no run directory is declared', async () => {
    const value = await newFixture();

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: undefined },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('lets --check pass below the cap without consuming a valid pending fan-out', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-check-under-cap-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });

    const result = await run(
      ['gate-round', '--check', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('makes --check refuse at the base cap even when its declared run only has consumed evidence', async () => {
    const value = await newFixture();
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    let latestEnv: NodeJS.ProcessEnv | null = null;

    for (let round = 0; round < 3; round += 1) {
      const runDir = await mkdtemp(path.join(tmpdir(), `rp521-check-cap-${round}-`));
      roots.push(runDir);
      await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
      latestEnv = { ...process.env, RIG_RUN_DIR: runDir };
      expect((await run(args, latestEnv)).code).toBe(0);
    }
    expect(await counterAt(value.configPath, value.branch)).toBe(3);

    const checked = await run(
      ['gate-round', '--check', '--branch', value.branch, '--config', value.configPath],
      latestEnv!,
    );
    expect(checked.code).toBe(2);
    expect(await counterAt(value.configPath, value.branch)).toBe(3);
  });

  it('lets a default replay acknowledge already-consumed evidence at the cap without changing it', async () => {
    const value = await newFixture();
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const consumed: NodeJS.ProcessEnv[] = [];

    for (let round = 0; round < 3; round += 1) {
      const runDir = await mkdtemp(path.join(tmpdir(), `rp521-replay-cap-${round}-`));
      roots.push(runDir);
      await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
      const env = { ...process.env, RIG_RUN_DIR: runDir };
      expect((await run(args, env)).code).toBe(0);
      consumed.push(env);
    }
    expect(await counterAt(value.configPath, value.branch)).toBe(3);

    const replay = await run(args, consumed[0]!);
    expect(replay.code, replay.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(3);
  });

  it('does not consume a round for an empty fan-out that launched no reviewer', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-empty-fanout-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: [] });

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('does not consume a round for a fan-out whose only reviewer name is blank', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-blank-reviewer-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['   '] });

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('does not consume a round for a non-empty fan-out recorded against a different exact head', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-other-head-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: 'f'.repeat(40), reviewers: ['code-reviewer'] });

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('consumes one recorded non-empty fan-out once when a resumed invocation sees the same evidence again', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-repeat-evidence-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const env = { ...process.env, RIG_RUN_DIR: runDir };

    const first = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      env,
    );
    expect(first.code, first.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    const resumed = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      env,
    );
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('does not recount the same fan-out when a resumed run names its directory through a symlink', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-symlink-evidence-'));
    const aliasRoot = await mkdtemp(path.join(tmpdir(), 'rp521-symlink-alias-'));
    const alias = path.join(aliasRoot, 'run');
    roots.push(runDir, aliasRoot);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];

    expect((await run(args, { ...process.env, RIG_RUN_DIR: runDir })).code).toBe(0);
    await symlink(runDir, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const resumed = await run(args, { ...process.env, RIG_RUN_DIR: alias });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('never recounts a fan-out after an older numeric-only writer drops receipt metadata', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-legacy-writer-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const env = { ...process.env, RIG_RUN_DIR: runDir };

    expect((await run(args, env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const modern = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const legacyProjection = Object.fromEntries(
      Object.entries(modern).filter(([, entry]) => typeof entry === 'number'),
    ) as Record<string, number>;
    legacyProjection['fix/another-controller'] = 1;
    await writeFile(counterPath, JSON.stringify(legacyProjection));

    const replay = await run(args, env);
    expect([0, 1]).toContain(replay.code);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('consumes a separately recorded later fan-out for the same head as another round', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-second-fanout-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });

    expect(
      (await run(['gate-round', '--branch', value.branch, '--config', value.configPath], env)).code,
    ).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    await fanOut({ runDir, headSha: value.head, reviewers: ['security-scanner'] });
    const second = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      env,
    );
    expect(second.code, second.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('refuses two unconsumed valid fan-outs at one head instead of silently selecting one', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-ambiguous-fanout-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    await fanOut({ runDir, headSha: value.head, reviewers: ['security-scanner'] });

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/fan-out|evidence|ambiguous|unconsumed/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses corrupt evidence receipts without resetting the branch count', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-corrupt-receipt-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    await writeFile(
      counterPath,
      JSON.stringify({
        [value.branch]: 1,
        '\u0000rig:gate-round-evidence': { [value.branch]: 'not a receipt list' },
      }),
    );

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/evidence|receipt|counter|round/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('refuses an unsupported intermediate receipt object without discarding its evidence', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-intermediate-receipt-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    await writeFile(
      counterPath,
      JSON.stringify({
        [value.branch]: 1,
        '\u0000rig:gate-round-evidence': { [value.branch]: ['["/prior-run",1]'] },
      }),
    );

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unsupported|evidence|receipt|counter|round/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('refuses a zero-valued current receipt without forgetting a counted fan-out', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-zero-current-receipt-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    expect((await run(args, env)).code).toBe(0);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const stored = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const receiptKey = Object.keys(stored).find((key) =>
      key.startsWith('\u0000rig:gate-round-evidence:'),
    );
    expect(receiptKey).toBeDefined();
    stored[receiptKey!] = 0;
    await writeFile(counterPath, JSON.stringify(stored));

    const replay = await run(args, env);

    expect(replay.code).toBe(1);
    expect(replay.stderr).toMatch(/evidence|receipt|counter|round/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('refuses a string-valued current receipt without forgetting a counted fan-out', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-string-current-receipt-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    expect((await run(args, env)).code).toBe(0);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const stored = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const receiptKey = Object.keys(stored).find((key) =>
      key.startsWith('\u0000rig:gate-round-evidence:'),
    );
    expect(receiptKey).toBeDefined();
    stored[receiptKey!] = 'one';
    await writeFile(counterPath, JSON.stringify(stored));

    const replay = await run(args, env);

    expect(replay.code).toBe(1);
    expect(replay.stderr).toMatch(/evidence|receipt|counter|round/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('refuses a current receipt key with malformed identity JSON without forgetting a counted fan-out', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-malformed-current-receipt-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    expect((await run(args, env)).code).toBe(0);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const stored = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const receiptKey = Object.keys(stored).find((key) =>
      key.startsWith('\u0000rig:gate-round-evidence:'),
    );
    expect(receiptKey).toBeDefined();
    delete stored[receiptKey!];
    stored['\u0000rig:gate-round-evidence:[not-json'] = 1;
    await writeFile(counterPath, JSON.stringify(stored));

    const replay = await run(args, env);

    expect(replay.code).toBe(1);
    expect(replay.stderr).toMatch(/evidence|receipt|counter|round/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('records concurrent attempts to consume the same fan-out exactly once', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-concurrent-replay-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const env = { ...process.env, RIG_RUN_DIR: runDir };

    const results = await Promise.all([run(args, env), run(args, env)]);

    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr).join('\n'),
    ).toEqual([0, 0]);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('lets only one concurrent distinct fan-out spend the final base-cap slot', async () => {
    const value = await newFixture();
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const nextRun = async (name: string) => {
      const runDir = await mkdtemp(path.join(tmpdir(), name));
      roots.push(runDir);
      await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
      return { ...process.env, RIG_RUN_DIR: runDir };
    };

    const first = await nextRun('rp521-concurrent-cap-first-');
    const second = await nextRun('rp521-concurrent-cap-second-');
    expect((await run(args, first)).code).toBe(0);
    expect((await run(args, second)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);

    const left = await nextRun('rp521-concurrent-cap-left-');
    const right = await nextRun('rp521-concurrent-cap-right-');
    const results = await Promise.all([run(args, left), run(args, right)]);

    expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
    expect(await counterAt(value.configPath, value.branch)).toBe(3);
  });

  it('preserves the cap after three distinct recorded fan-outs', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-cap-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };

    for (const reviewer of ['code-reviewer', 'security-scanner', 'prose-reviewer']) {
      await fanOut({ runDir, headSha: value.head, reviewers: [reviewer] });
      expect(
        (await run(['gate-round', '--branch', value.branch, '--config', value.configPath], env))
          .code,
      ).toBe(0);
    }
    expect(await counterAt(value.configPath, value.branch)).toBe(3);

    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const exhausted = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      env,
    );
    expect(exhausted.code).toBe(2);
    expect(await counterAt(value.configPath, value.branch)).toBe(3);
  });
});
