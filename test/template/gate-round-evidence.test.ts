import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
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
const prShipSkill = path.join(universal, '.claude', 'skills', 'pr-ship', 'SKILL.md');

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
  why,
}: {
  runDir: string;
  headSha: string;
  reviewers: string[];
  why?: string;
}) => {
  const { recordDecision } = await journal();
  recordDecision({
    runDir,
    gate: 'reviewer-fan-out',
    verdict: 'launched',
    headSha,
    reviewers,
    why,
    now: '2026-10-18T00:00:00.000Z',
  });
};

const reserve = async (args: string[], env: NodeJS.ProcessEnv): Promise<string> => {
  const result = await run([...args, '--reserve'], env);
  if (result.code !== 0) throw new Error(`gate-round --reserve failed: ${result.stderr}`);
  const token = result.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
  if (!token)
    throw new Error(`gate-round --reserve did not emit a reservation token: ${result.stdout}`);
  return token;
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

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/fan-out|evidence|reservation|launch/i);
    const checked = await run(
      ['gate-round', '--check', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );
    expect(checked.code, checked.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses a post-launch call when no run directory is declared', async () => {
    const value = await newFixture();

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: undefined },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/run|evidence|reservation|fan-out/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses reconciliation when no declared run can scope the historic evidence', async () => {
    const value = await newFixture();

    const result = await run(
      ['gate-round', '--reconcile', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: undefined },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/run|reconcile|evidence/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('makes pr-ship reserve a durable slot before launch and fail when its fan-out cannot be recorded', async () => {
    const skill = await readFile(prShipSkill, 'utf8');

    expect(skill).toMatch(/gate-round\s+--reserve/);
    expect(skill).toMatch(/fan-out[^\n]*(fail|refus)|(?:fail|refus)[^\n]*fan-out/i);
    expect(skill).not.toMatch(
      /catch\s*\([^)]*isTraceExhausted[^)]*\)[\s\S]{0,300}?(?:return|continue)/,
    );
  });

  it('reserves an unspent slot with an opaque token without regranting it to a shared run', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reserve-shared-run-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];

    const created = await run([...args, '--reserve'], env);
    expect(created.code, created.stderr).toBe(0);
    const token = created.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();
    expect(await counterAt(value.configPath, value.branch)).toBe(0);

    const resumed = await run([...args, '--reserve', '--reservation', token!], env);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toMatch(/reservation.*resum|resum.*reservation/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);

    const duplicate = await run([...args, '--reserve'], env);
    expect(duplicate.code).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('requires a post-reservation fan-out bound to the reservation token instead of reusing an older event', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reservation-seq-floor-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });

    const reserved = await run([...args, '--reserve'], env);
    expect(reserved.code, reserved.stderr).toBe(0);
    const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();

    const oldEvent = await run([...args, '--reservation', token!], env);
    expect(oldEvent.code).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);

    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token!}`,
    });
    const counted = await run([...args, '--reservation', token!], env);
    expect(counted.code, counted.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('accounts for every launch under a duplicated reservation token before refusing further use', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reservation-double-fanout-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const reserved = await run([...args, '--reserve'], env);
    expect(reserved.code, reserved.stderr).toBe(0);
    const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token!}`,
    });
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['security-scanner'],
      why: `gate-round reservation: ${token!}`,
    });

    const consumed = await run([...args, '--reservation', token!], env);

    expect(consumed.code).toBe(1);
    expect(consumed.stderr).toMatch(/fan-out|evidence|reservation|reconcile/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
    const replay = await run([...args, '--reservation', token!], env);
    expect(replay.code).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('acknowledges a replayed consumed reservation token without recounting its fan-out', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reservation-replay-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const reserved = await run([...args, '--reserve'], env);
    expect(reserved.code, reserved.stderr).toBe(0);
    const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token!}`,
    });
    const consumed = await run([...args, '--reservation', token!], env);
    expect(consumed.code, consumed.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    const replay = await run([...args, '--reservation', token!], env);

    expect(replay.code, replay.stderr).toBe(0);
    expect(replay.stdout).toMatch(/reservation|already|consumed/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('accounts for a later fan-out under a completed reservation token before refusing reuse', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-completed-late-fanout-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['security-scanner'],
      why: `gate-round reservation: ${token}`,
    });
    const late = await run([...args, '--reservation', token], env);

    expect(late.code).toBe(1);
    expect(late.stderr).toMatch(/fan-out|evidence|reservation|reuse/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
    const replay = await run([...args, '--reservation', token], env);
    expect(replay.code).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('acknowledges concurrent consumption of one reservation token without recounting its fan-out', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reservation-concurrent-replay-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const reserved = await run([...args, '--reserve'], env);
    expect(reserved.code, reserved.stderr).toBe(0);
    const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token!}`,
    });

    const results = await Promise.all([
      run([...args, '--reservation', token!], env),
      run([...args, '--reservation', token!], env),
    ]);

    expect(results.map(({ code }) => code).sort()).toEqual([0, 0]);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('refuses a post-launch call without the durable fan-out bound to its reservation', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reservation-no-fanout-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const reserved = await run([...args, '--reserve'], env);
    expect(reserved.code, reserved.stderr).toBe(0);
    const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();

    const postLaunch = await run([...args, '--reservation', token!], env);

    expect(postLaunch.code).toBe(1);
    expect(postLaunch.stderr).toMatch(/fan-out|evidence|reservation|launch/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('releases an unused reservation so a different declared run can reserve the slot', async () => {
    const value = await newFixture();
    const firstRun = await mkdtemp(path.join(tmpdir(), 'rp521-release-first-'));
    const secondRun = await mkdtemp(path.join(tmpdir(), 'rp521-release-second-'));
    roots.push(firstRun, secondRun);
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const created = await run([...args, '--reserve'], { ...process.env, RIG_RUN_DIR: firstRun });
    expect(created.code, created.stderr).toBe(0);
    const token = created.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();

    const released = await run([...args, '--release', '--reservation', token!], {
      ...process.env,
      RIG_RUN_DIR: firstRun,
    });
    expect(released.code, released.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);

    const next = await run([...args, '--reserve'], { ...process.env, RIG_RUN_DIR: secondRun });
    expect(next.code, next.stderr).toBe(0);
    expect(next.stdout).toMatch(/\breservation\s+[^\s]+/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses to release a reservation once its token-bound fan-out was launched', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-release-launched-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });

    const released = await run([...args, '--release', '--reservation', token], env);

    expect(released.code).toBe(1);
    expect(released.stderr).toMatch(/fan-out|evidence|reservation|launch/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses a completed reservation token from a different declared run', async () => {
    const value = await newFixture();
    const ownerRun = await mkdtemp(path.join(tmpdir(), 'rp521-completed-owner-'));
    const otherRun = await mkdtemp(path.join(tmpdir(), 'rp521-completed-other-'));
    roots.push(ownerRun, otherRun);
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const ownerEnv = { ...process.env, RIG_RUN_DIR: ownerRun };
    const token = await reserve(args, ownerEnv);
    await fanOut({
      runDir: ownerRun,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    expect((await run([...args, '--reservation', token], ownerEnv)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    const foreign = await run([...args, '--reservation', token], {
      ...process.env,
      RIG_RUN_DIR: otherRun,
    });

    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toMatch(/reservation|branch|head|run/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('refuses a second reservation when spent rounds and an active reservation fill the base cap', async () => {
    const value = await newFixture();
    const firstRun = await mkdtemp(path.join(tmpdir(), 'rp521-reserve-cap-first-'));
    const secondRun = await mkdtemp(path.join(tmpdir(), 'rp521-reserve-cap-second-'));
    roots.push(firstRun, secondRun);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    await writeFile(counterPath, JSON.stringify({ [value.branch]: 2 }));
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];

    const first = await run([...args, '--reserve'], { ...process.env, RIG_RUN_DIR: firstRun });
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/\breservation\s+[^\s]+/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);

    const blocked = await run([...args, '--reserve'], { ...process.env, RIG_RUN_DIR: secondRun });
    expect(blocked.code).toBe(2);
    expect(blocked.stdout).not.toMatch(/\breservation\s+[^\s]+/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('admits only one simultaneous final-slot reservation across declared runs', async () => {
    const value = await newFixture();
    const firstRun = await mkdtemp(path.join(tmpdir(), 'rp521-reserve-race-first-'));
    const secondRun = await mkdtemp(path.join(tmpdir(), 'rp521-reserve-race-second-'));
    roots.push(firstRun, secondRun);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    await writeFile(counterPath, JSON.stringify({ [value.branch]: 2 }));
    const args = [
      'gate-round',
      '--branch',
      value.branch,
      '--config',
      value.configPath,
      '--reserve',
    ];

    const results = await Promise.all([
      run(args, { ...process.env, RIG_RUN_DIR: firstRun }),
      run(args, { ...process.env, RIG_RUN_DIR: secondRun }),
    ]);

    expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
    expect(results.filter((result) => /\breservation\s+[^\s]+/i.test(result.stdout))).toHaveLength(
      1,
    );
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('refuses to resume a reservation token from a different declared run', async () => {
    const value = await newFixture();
    const ownerRun = await mkdtemp(path.join(tmpdir(), 'rp521-reservation-owner-'));
    const otherRun = await mkdtemp(path.join(tmpdir(), 'rp521-reservation-other-'));
    roots.push(ownerRun, otherRun);
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const created = await run([...args, '--reserve'], { ...process.env, RIG_RUN_DIR: ownerRun });
    expect(created.code, created.stderr).toBe(0);
    const token = created.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();

    const foreign = await run([...args, '--reserve', '--reservation', token!], {
      ...process.env,
      RIG_RUN_DIR: otherRun,
    });

    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toMatch(/reservation|branch|head|run/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);

    const foreignRelease = await run([...args, '--release', '--reservation', token!], {
      ...process.env,
      RIG_RUN_DIR: otherRun,
    });
    expect(foreignRelease.code).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
    const ownerResume = await run([...args, '--reserve', '--reservation', token!], {
      ...process.env,
      RIG_RUN_DIR: ownerRun,
    });
    expect(ownerResume.code, ownerResume.stderr).toBe(0);
  });

  it('keeps --check read-only so another run can reserve the final available slot', async () => {
    const value = await newFixture();
    const checkedRun = await mkdtemp(path.join(tmpdir(), 'rp521-check-read-only-'));
    const reservingRun = await mkdtemp(path.join(tmpdir(), 'rp521-check-reserve-after-'));
    roots.push(checkedRun, reservingRun);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    await writeFile(counterPath, JSON.stringify({ [value.branch]: 2 }));
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];

    const checked = await run([...args, '--check'], { ...process.env, RIG_RUN_DIR: checkedRun });
    expect(checked.code, checked.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);

    const reserved = await run([...args, '--reserve'], {
      ...process.env,
      RIG_RUN_DIR: reservingRun,
    });
    expect(reserved.code, reserved.stderr).toBe(0);
    expect(reserved.stdout).toMatch(/\breservation\s+[^\s]+/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('refuses conflicting --check --reserve flags without creating a held slot', async () => {
    const value = await newFixture();
    const checkedRun = await mkdtemp(path.join(tmpdir(), 'rp521-check-reserve-conflict-'));
    const reservingRun = await mkdtemp(path.join(tmpdir(), 'rp521-check-reserve-next-'));
    const reconcileRun = await mkdtemp(path.join(tmpdir(), 'rp521-check-reconcile-conflict-'));
    roots.push(checkedRun, reservingRun, reconcileRun);
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];

    const conflicting = await run([...args, '--check', '--reserve'], {
      ...process.env,
      RIG_RUN_DIR: checkedRun,
    });

    expect(conflicting.code).toBe(1);
    expect(conflicting.stdout).not.toMatch(/\breservation\s+[^\s]+/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);

    const next = await run([...args, '--reserve'], { ...process.env, RIG_RUN_DIR: reservingRun });
    expect(next.code, next.stderr).toBe(0);
    expect(next.stdout).toMatch(/\breservation\s+[^\s]+/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);

    const token = next.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();
    const checkRelease = await run([...args, '--check', '--release', '--reservation', token!], {
      ...process.env,
      RIG_RUN_DIR: reservingRun,
    });
    expect(checkRelease.code).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
    expect(
      (
        await run([...args, '--reserve', '--reservation', token!], {
          ...process.env,
          RIG_RUN_DIR: reservingRun,
        })
      ).code,
    ).toBe(0);

    await fanOut({ runDir: reconcileRun, headSha: value.head, reviewers: ['code-reviewer'] });
    const checkReconcile = await run([...args, '--check', '--reconcile'], {
      ...process.env,
      RIG_RUN_DIR: reconcileRun,
    });
    expect(checkReconcile.code).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses --reserve --release without creating a held slot', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reserve-release-conflict-'));
    roots.push(runDir);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');

    const result = await run(
      [
        'gate-round',
        '--branch',
        value.branch,
        '--config',
        value.configPath,
        '--reserve',
        '--release',
      ],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(existsSync(counterPath)).toBe(false);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses --reserve --reconcile without creating a held slot', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reserve-reconcile-conflict-'));
    roots.push(runDir);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');

    const result = await run(
      [
        'gate-round',
        '--branch',
        value.branch,
        '--config',
        value.configPath,
        '--reserve',
        '--reconcile',
      ],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(existsSync(counterPath)).toBe(false);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses --release --reconcile without changing counter state', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-release-reconcile-conflict-'));
    roots.push(runDir);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');

    const result = await run(
      [
        'gate-round',
        '--branch',
        value.branch,
        '--config',
        value.configPath,
        '--release',
        '--reconcile',
      ],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(existsSync(counterPath)).toBe(false);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses --reconcile with a reservation token without consuming tokenless evidence', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-reconcile-reservation-conflict-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');

    const result = await run(
      [
        'gate-round',
        '--branch',
        value.branch,
        '--config',
        value.configPath,
        '--reconcile',
        '--reservation',
        'not-a-reservation',
      ],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(existsSync(counterPath)).toBe(false);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses a pre-existing counter lock without removing it or changing rounds', async () => {
    const value = await newFixture();
    const roundsPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const lockPath = `${roundsPath}.lock`;
    const reservationToken = `${process.pid}-${Date.now()}`;
    await writeFile(roundsPath, JSON.stringify({ [value.branch]: 1 }));
    await writeFile(lockPath, 'held\n');
    const beforeRounds = await readFile(roundsPath, 'utf8');
    const beforeLock = await readFile(lockPath, 'utf8');
    const { reserveGateRound } = await import(
      pathToFileURL(path.join(scriptsDir, 'queue', 'gate-rounds.mjs')).href
    );

    expect(() =>
      reserveGateRound({
        branch: value.branch,
        roundsPath,
        max: 3,
        reservation: {
          branch: value.branch,
          head: value.head,
          runDir: value.root,
          seqFloor: 0,
          token: reservationToken,
          ticket: null,
          authorizationHead: null,
        },
      }),
    ).toThrow(/remained held/);
    expect(await readFile(roundsPath, 'utf8')).toBe(beforeRounds);
    expect(await readFile(lockPath, 'utf8')).toBe(beforeLock);
  });

  it('shares the default counter path across linked worktrees but not independent clones', async () => {
    const value = await newFixture();
    const projectRoot = path.join(value.root, 'repo');
    const linked = path.join(value.root, 'linked-worktree');
    const clone = await mkdtemp(path.join(tmpdir(), 'rp521-independent-clone-'));
    roots.push(clone);
    git(projectRoot, ['worktree', 'add', '-q', '-b', 'fix/rp-521-linked', linked]);
    git(projectRoot, ['clone', '-q', path.join(value.root, 'remote'), clone]);
    const { gateRoundsPathFor } = await import(
      pathToFileURL(path.join(scriptsDir, 'queue', 'gate-rounds.mjs')).href
    );

    expect(gateRoundsPathFor(linked)).toBe(
      path.join(await realpath(projectRoot), '.claude', 'gate-rounds.json'),
    );
    expect(gateRoundsPathFor(clone)).toBe(
      path.join(await realpath(clone), '.claude', 'gate-rounds.json'),
    );
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

  it('refuses --check with a valid reservation token without mutating its evidence', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-check-reservation-token-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const before = await readFile(counterPath, 'utf8');

    const checked = await run([...args, '--check', '--reservation', token], env);

    expect(checked.code).toBe(1);
    expect(await readFile(counterPath, 'utf8')).toBe(before);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
    expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('refuses --check --reservation --authorized below the base cap without mutating its evidence', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-check-authorized-reservation-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const before = await readFile(counterPath, 'utf8');

    const checked = await run(
      [...args, '--check', '--reservation', token, '--authorized', '--ticket', 'RP-521'],
      env,
    );

    expect(checked.code).toBe(1);
    expect(await readFile(counterPath, 'utf8')).toBe(before);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
    expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('makes --check refuse at the base cap even when its declared run only has consumed evidence', async () => {
    const value = await newFixture();
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    let latestEnv: NodeJS.ProcessEnv | null = null;

    for (let round = 0; round < 3; round += 1) {
      const runDir = await mkdtemp(path.join(tmpdir(), `rp521-check-cap-${round}-`));
      roots.push(runDir);
      latestEnv = { ...process.env, RIG_RUN_DIR: runDir };
      const token = await reserve(args, latestEnv);
      await fanOut({
        runDir,
        headSha: value.head,
        reviewers: ['code-reviewer'],
        why: `gate-round reservation: ${token}`,
      });
      expect((await run([...args, '--reservation', token], latestEnv)).code).toBe(0);
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
    const consumed: Array<{ env: NodeJS.ProcessEnv; token: string }> = [];

    for (let round = 0; round < 3; round += 1) {
      const runDir = await mkdtemp(path.join(tmpdir(), `rp521-replay-cap-${round}-`));
      roots.push(runDir);
      const env = { ...process.env, RIG_RUN_DIR: runDir };
      const token = await reserve(args, env);
      await fanOut({
        runDir,
        headSha: value.head,
        reviewers: ['code-reviewer'],
        why: `gate-round reservation: ${token}`,
      });
      expect((await run([...args, '--reservation', token], env)).code).toBe(0);
      consumed.push({ env, token });
    }
    expect(await counterAt(value.configPath, value.branch)).toBe(3);

    const replay = await run([...args, '--reservation', consumed[0]!.token], consumed[0]!.env);
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

    expect(result.code, result.stderr).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('refuses a tokenless exact-head fan-out until explicit reconciliation', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-tokenless-valid-fanout-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });

    const result = await run(
      ['gate-round', '--branch', value.branch, '--config', value.configPath],
      { ...process.env, RIG_RUN_DIR: runDir },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/reservation|reconcile|fan-out|evidence/i);
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

    expect(result.code, result.stderr).toBe(1);
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

    expect(result.code, result.stderr).toBe(1);
    expect(await counterAt(value.configPath, value.branch)).toBe(0);
  });

  it('consumes one recorded non-empty fan-out once when a resumed invocation sees the same evidence again', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-repeat-evidence-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });

    const first = await run([...args, '--reservation', token], env);
    expect(first.code, first.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    const resumed = await run([...args, '--reservation', token], env);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('does not recount the same fan-out when a resumed run names its directory through a symlink', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-symlink-evidence-'));
    const aliasRoot = await mkdtemp(path.join(tmpdir(), 'rp521-symlink-alias-'));
    const alias = path.join(aliasRoot, 'run');
    roots.push(runDir, aliasRoot);
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const token = await reserve(args, { ...process.env, RIG_RUN_DIR: runDir });
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });

    expect(
      (await run([...args, '--reservation', token], { ...process.env, RIG_RUN_DIR: runDir })).code,
    ).toBe(0);
    await symlink(runDir, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const resumed = await run([...args, '--reservation', token], {
      ...process.env,
      RIG_RUN_DIR: alias,
    });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('never recounts a fan-out after an older numeric-only writer drops receipt metadata', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-legacy-writer-'));
    roots.push(runDir);
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });

    expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const modern = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const legacyProjection = Object.fromEntries(
      Object.entries(modern).filter(([, entry]) => typeof entry === 'number'),
    ) as Record<string, number>;
    legacyProjection['fix/another-controller'] = 1;
    await writeFile(counterPath, JSON.stringify(legacyProjection));

    const replay = await run([...args, '--reservation', token], env);
    expect([0, 1]).toContain(replay.code);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('consumes a separately recorded later fan-out for the same head as another round', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-second-fanout-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const firstToken = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${firstToken}`,
    });

    expect((await run([...args, '--reservation', firstToken], env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);

    const secondToken = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['security-scanner'],
      why: `gate-round reservation: ${secondToken}`,
    });
    const second = await run([...args, '--reservation', secondToken], env);
    expect(second.code, second.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('reconciles every tokenless historic fan-out at one head exactly once without creating a new admission', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-ambiguous-fanout-'));
    roots.push(runDir);
    await fanOut({ runDir, headSha: value.head, reviewers: ['code-reviewer'] });
    await fanOut({ runDir, headSha: value.head, reviewers: ['security-scanner'] });

    const args = [
      'gate-round',
      '--reconcile',
      '--branch',
      value.branch,
      '--config',
      value.configPath,
    ];
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const result = await run(args, env);

    expect(result.code, result.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
    const replay = await run(args, env);
    expect(replay.code, replay.stderr).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);
  });

  it('reconciles every over-cap tokenless historic fan-out before refusing further rounds', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-over-cap-reconcile-'));
    roots.push(runDir);
    for (const reviewer of [
      'code-reviewer',
      'security-scanner',
      'prose-reviewer',
      'architecture-reviewer',
    ]) {
      await fanOut({ runDir, headSha: value.head, reviewers: [reviewer] });
    }
    const args = [
      'gate-round',
      '--reconcile',
      '--branch',
      value.branch,
      '--config',
      value.configPath,
    ];
    const env = { ...process.env, RIG_RUN_DIR: runDir };

    const reconciled = await run(args, env);

    expect(reconciled.code).toBe(2);
    expect(await counterAt(value.configPath, value.branch)).toBe(4);
    const replay = await run(args, env);
    expect(replay.code).toBe(2);
    expect(await counterAt(value.configPath, value.branch)).toBe(4);
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
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const stored = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const receiptKey = Object.keys(stored).find((key) =>
      key.startsWith('\u0000rig:gate-round-evidence:'),
    );
    expect(receiptKey).toBeDefined();
    stored[receiptKey!] = 0;
    await writeFile(counterPath, JSON.stringify(stored));

    const replay = await run([...args, '--reservation', token], env);

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
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const stored = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const receiptKey = Object.keys(stored).find((key) =>
      key.startsWith('\u0000rig:gate-round-evidence:'),
    );
    expect(receiptKey).toBeDefined();
    stored[receiptKey!] = 'one';
    await writeFile(counterPath, JSON.stringify(stored));

    const replay = await run([...args, '--reservation', token], env);

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
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    const counterPath = value.configPath.replace(/(\.json)?$/, '.gate-rounds.json');
    const stored = JSON.parse(await readFile(counterPath, 'utf8')) as Record<string, unknown>;
    const receiptKey = Object.keys(stored).find((key) =>
      key.startsWith('\u0000rig:gate-round-evidence:'),
    );
    expect(receiptKey).toBeDefined();
    delete stored[receiptKey!];
    stored['\u0000rig:gate-round-evidence:[not-json'] = 1;
    await writeFile(counterPath, JSON.stringify(stored));

    const replay = await run([...args, '--reservation', token], env);

    expect(replay.code).toBe(1);
    expect(replay.stderr).toMatch(/evidence|receipt|counter|round/i);
    expect(await counterAt(value.configPath, value.branch)).toBe(1);
  });

  it('records concurrent attempts to consume the same fan-out exactly once', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-concurrent-replay-'));
    roots.push(runDir);
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const token = await reserve(args, env);
    await fanOut({
      runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });

    const results = await Promise.all([
      run([...args, '--reservation', token], env),
      run([...args, '--reservation', token], env),
    ]);

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
      const env = { ...process.env, RIG_RUN_DIR: runDir };
      return { runDir, env };
    };

    const first = await nextRun('rp521-concurrent-cap-first-');
    const second = await nextRun('rp521-concurrent-cap-second-');
    const firstToken = await reserve(args, first.env);
    const secondToken = await reserve(args, second.env);
    await fanOut({
      runDir: first.runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${firstToken}`,
    });
    await fanOut({
      runDir: second.runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${secondToken}`,
    });
    expect((await run([...args, '--reservation', firstToken], first.env)).code).toBe(0);
    expect((await run([...args, '--reservation', secondToken], second.env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(2);

    const [left, right] = await Promise.all([
      nextRun('rp521-concurrent-cap-left-'),
      nextRun('rp521-concurrent-cap-right-'),
    ]);
    const results = await Promise.all([
      run([...args, '--reserve'], left.env),
      run([...args, '--reserve'], right.env),
    ]);

    expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
    const winner =
      results[0].code === 0 ? { result: results[0], ...left } : { result: results[1], ...right };
    const token = winner.result.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    expect(token).toBeDefined();
    await fanOut({
      runDir: winner.runDir,
      headSha: value.head,
      reviewers: ['code-reviewer'],
      why: `gate-round reservation: ${token}`,
    });
    expect((await run([...args, '--reservation', token!], winner.env)).code).toBe(0);
    expect(await counterAt(value.configPath, value.branch)).toBe(3);
  });

  it('preserves the cap after three distinct recorded fan-outs', async () => {
    const value = await newFixture();
    const runDir = await mkdtemp(path.join(tmpdir(), 'rp521-cap-'));
    roots.push(runDir);
    const env = { ...process.env, RIG_RUN_DIR: runDir };
    const args = ['gate-round', '--branch', value.branch, '--config', value.configPath];

    for (const reviewer of ['code-reviewer', 'security-scanner', 'prose-reviewer']) {
      const token = await reserve(args, env);
      await fanOut({
        runDir,
        headSha: value.head,
        reviewers: [reviewer],
        why: `gate-round reservation: ${token}`,
      });
      expect((await run([...args, '--reservation', token], env)).code).toBe(0);
    }
    expect(await counterAt(value.configPath, value.branch)).toBe(3);

    const exhausted = await run([...args, '--reserve'], env);
    expect(exhausted.code).toBe(2);
    expect(await counterAt(value.configPath, value.branch)).toBe(3);
  });
});
