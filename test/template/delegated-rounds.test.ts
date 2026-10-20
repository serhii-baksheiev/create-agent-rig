// RP-442: bounded delegated gate rounds.
//
// Builds on RP-340 (`delegated-decision.mjs`, see `delegated-decision.test.ts`)
// and RP-341/RP-342 (`queue/stop-class.mjs`, see `stop-class.test.ts` —
// `gate-round-cap` now names the delegable `extra-gate-round` decision).
//
// Round 1 of this design is already implemented (production) and already
// pinned below:
//
//   - `options.maxDelegatedRounds` in the queue config: default 1 when
//     absent; a non-negative integer; anything else refused (exit 1,
//     nothing counted). `options.maxGateRounds` (the base cap, default 3)
//     is unaffected.
//   - `delegated-decision.mjs record --decision extra-gate-round` now
//     REQUIRES `--head <sha>`: refused (nothing written) when it is
//     missing, when it differs from the checkout's actual HEAD, or on a
//     detached checkout. Every other decision id is unaffected — no
//     `--head` requirement, no budget (`delegated-decision.test.ts` already
//     exercises the general CLI through a different, unaffected decision
//     id, `tracker-correction`, precisely so this feature's blast radius
//     does not silently reach that file's unrelated coverage).
//   - `queue/index.mjs gate-round --branch <b> --ticket <id> --authorized`:
//     past the base cap, it consults `.rig/decisions/<ticket>.jsonl` for a
//     record matching ticket + branch + the checkout's current HEAD that
//     has not yet been "spent" by a reviewer verdict at that same head
//     (`run-journal.mjs`'s `decisions.jsonl`, `gate` one of the reviewers,
//     `headSha` equal to that head) — read from the checkout's own
//     `.claude/runs/` or, when declared, `RIG_RUN_DIR`.
//
// Round 1's own budget check counted `extra-gate-round` records per FREE
// `--ticket` string (one file per ticket, `.rig/decisions/<ticket>.jsonl`)
// rather than per branch, and only at `record` time. A reviewer reproduced
// two ways through that gap: (1) a second, made-up ticket id on the same
// branch gets its own empty file and its own fresh budget; (2) a second
// `extra-gate-round` line appended BY HAND to an existing ticket's file
// (never through `record`, so none of its checks ran) is still read back by
// `gate-round --authorized`, which never compares the record count to the
// budget at all. This file's round 2 (implemented) closes both:
//
//   - the budget is the BRANCH's, counted across every
//     `.rig/decisions/*.jsonl`, whatever ticket each record names —
//     checked in `record` (refuses a new record once the branch already
//     holds `maxDelegatedRounds` records) AND in `gate-round --authorized`
//     (refuses — exit 2, nothing counted — the moment the branch holds MORE
//     `extra-gate-round` records than the budget, which is evidence of a
//     bypass rather than a close call);
//   - `record`'s success message names which delegated round it just spent,
//     e.g. "delegated round 1 of 1";
//   - a reviewer verdict's `headSha` is matched to the authorization's
//     covered heads without regard to case, so an uppercase SHA cannot hide
//     a verdict from the consumed-once check.
//
// Round 2's own "more records than the budget" check still reads only the
// CURRENT contents of `.rig/decisions/*.jsonl`, and a reviewer found two
// ways through THAT gap that never change the record count at all: (1)
// rewriting an already-consumed record's own `--head <sha>` field IN PLACE
// to a new, not-yet-verdicted commit — the count stays the same, but the
// rewritten record's chain no longer carries the head the reviewer verdict
// was recorded against, so the consumed-once check finds nothing to match
// and calls it fresh; (2) deleting a ticket's decisions file outright and
// recording a brand-new authorization in its place — the count of records on
// the branch never exceeds the budget at any single instant, because the
// deletion and the fresh record never coexist in the same read. This file's
// total-cap case (RP-442, further round) closes both the same way: once the
// branch's OWN counted rounds (`gate-round`'s own counter file, read before
// any decision record is even consulted) already reach `maxGateRounds +
// maxDelegatedRounds`, `--authorized` refuses — exit 2, nothing counted —
// whatever the decision records on disk claim, tampered or genuine alike.
//
// Every expected literal below (exit codes, file counts, the stored record's
// own fields) is declared by this file, independently of the production
// modules under test (`.claude/rules/invariants.md`, the independent-oracle
// rule) — never by calling the thing being tested and comparing it to
// itself.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const delegatedDecisionScript = scriptPath('delegated-decision.mjs');
const queueIndexScript = path.join(queueDir, 'index.mjs');

const { withoutGitLocation } = (await import(pathToFileURL(scriptPath('git-env.mjs')).href)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};
const { recordDecision } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
  recordDecision: (input: {
    runDir: string;
    gate: string;
    verdict: string;
    headSha?: string;
    reviewers?: string[];
    why?: string;
    now: string;
  }) => unknown;
};

type RunResult = { code: number; stdout: string; stderr: string; out: string };

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> =>
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

const runDelegated = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  run(process.execPath, [delegatedDecisionScript, ...args], cwd, env);

const runGateRound = async (args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
  // A successful consume needs its own admission before a durable, exact-head
  // fan-out. Read-only preflight remains a direct public CLI call.
  if (env.RIG_RUN_DIR && !args.includes('--check')) {
    const reserved = await run(
      process.execPath,
      [queueIndexScript, 'gate-round', ...args, '--reserve'],
      cwd,
      env,
    );
    if (reserved.code !== 0) return reserved;
    const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
    if (!token)
      throw new Error(`gate-round --reserve did not emit a reservation token: ${reserved.stdout}`);
    await recordFanOut(cwd, env.RIG_RUN_DIR, `gate-round reservation: ${token}`);
    return run(
      process.execPath,
      [queueIndexScript, 'gate-round', ...args, '--reservation', token],
      cwd,
      env,
    );
  }
  return run(process.execPath, [queueIndexScript, 'gate-round', ...args], cwd, env);
};

let fixtureGitEnv = withoutGitLocation();

const discoverFixtureGitEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const env = withoutGitLocation();
  if (process.platform === 'win32') {
    const execPath = await run('git', ['--exec-path'], repoRoot, env);
    if (execPath.code === 0) {
      const directGit = path.resolve(execPath.stdout.trim(), '..', '..', 'bin', 'git.exe');
      try {
        if ((await stat(directGit)).isFile()) {
          const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
          if (pathKey !== undefined) {
            env[pathKey] = `${path.dirname(directGit)}${path.delimiter}${env[pathKey]}`;
          }
        }
      } catch {
        // Keep the original sanitised environment when direct Git is unavailable.
      }
    }
  }
  return env;
};

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      ...args,
    ],
    cwd,
    fixtureGitEnv,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

const head = (cwd: string) => git(['rev-parse', 'HEAD'], cwd);

const recordFanOut = async (cwd: string, runDir: string, why?: string): Promise<void> => {
  await mkdir(runDir, { recursive: true });
  recordDecision({
    runDir,
    gate: 'reviewer-fan-out',
    verdict: 'launched',
    headSha: await head(cwd),
    reviewers: ['code-reviewer'],
    why,
    now: new Date().toISOString(),
  });
};

/** `RIG_RUN_DIR` set ONLY for this one spawn — never on `process.env`. */
const envFor = (runDir: string | undefined): NodeJS.ProcessEnv => {
  const env = { ...fixtureGitEnv };
  if (runDir !== undefined) env.RIG_RUN_DIR = runDir;
  else delete env.RIG_RUN_DIR;
  return env;
};

const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'delegated-rounds-run-'));

/**
 * Declares the run's authority the supported way: `run-state.mjs authority
 * <word>` — since RP-467, a hand-written `decisionAuthority` in `state.json`
 * is refused; only a journalled declaration is read back by
 * `delegated-decision.mjs`.
 */
const declareAuthority = async (runDir: string, word: string): Promise<void> => {
  const result = await run(
    process.execPath,
    [scriptPath('run-state.mjs'), 'authority', word],
    repoRoot,
    envFor(runDir),
  );
  if (result.code !== 0) throw new Error(`run-state authority ${word} failed: ${result.out}`);
};

/** A delegated-authority run directory, ready for `record`. */
const delegatedRunDir = async (): Promise<string> => {
  const runDir = await newRunDir();
  await declareAuthority(runDir, 'delegated');
  return runDir;
};

/**
 * The seven git spawns that build a project with a bare remote are identical
 * on every call, so RP-476 builds that pair ONCE per file, lazily, the way
 * RP-426 did for `revalidate.test.ts`. Each case still gets its own fully
 * independent copy: `newPushedProject` copies the template and repoints
 * `origin`. Never written to directly — only copied from — and left for the
 * suite teardown to remove after every dependent fixture has finished.
 */
const fixtureRoots = new Set<string>();
const baseCapRunDirs = new Set<string>();
let pushedTemplateRoot: Promise<string> | null = null;

const buildPushedTemplate = async (initialQueueConfig?: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'delegated-rounds-template-'));
  fixtureRoots.add(root);
  const dir = path.join(root, 'repo');
  const remote = path.join(root, 'remote');
  await mkdir(dir);
  await mkdir(remote);
  await git(['init', '--bare', '-q'], remote);
  await git(['init', '-q', '-b', 'main'], dir);
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(
    path.join(dir, '.gitignore'),
    '.claude/*.gate-rounds.json\n.claude/queue.state.json\n.claude/runs/\n',
  );
  await writeFile(path.join(dir, 'README.md'), 'x\n');
  if (initialQueueConfig !== undefined) {
    await writeFile(path.join(dir, '.claude', 'queue.json'), JSON.stringify(initialQueueConfig));
  }
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);
  await git(['remote', 'add', 'origin', remote], dir);
  await git(['push', '-q', '-u', 'origin', 'main'], dir);
  return root;
};

/** A fresh git project with a bare remote, on `main` — the same shape
 * `gate-round`'s own AR-141 `checkoutIsShippable` requires. */
const newPushedProject = async (roots?: string[]): Promise<{ dir: string }> => {
  if (!pushedTemplateRoot) pushedTemplateRoot = buildPushedTemplate();
  const template = await pushedTemplateRoot;
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'delegated-rounds-repo-')));
  roots?.push(dir);
  const remote = await mkdtemp(path.join(tmpdir(), 'delegated-rounds-remote-'));
  roots?.push(remote);
  await cp(path.join(template, 'repo'), dir, { recursive: true });
  await cp(path.join(template, 'remote'), remote, { recursive: true });
  await git(['remote', 'set-url', 'origin', remote], dir);
  return { dir };
};

const writeAndPushConfig = async (dir: string, contents: unknown): Promise<string> => {
  const file = path.join(dir, '.claude', 'queue.json');
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', 'config'], dir);
  await git(['push', '-q'], dir);
  return file;
};

const branchAndPush = async (dir: string, branch: string): Promise<void> => {
  await git(['checkout', '-q', '-b', branch], dir);
  await git(['push', '-q', '-u', 'origin', branch], dir);
};

/** Push three ordinary gate rounds, exhausting the default cap of 3. */
const exhaustBaseCap = async (dir: string, branch: string, cfg: string): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    const runDir = await newRunDir();
    baseCapRunDirs.add(runDir);
    const result = await runGateRound(['--branch', branch, '--config', cfg], dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
  }
};

/**
 * Several cases need the same fully shippable precondition: a pushed `fix/a`
 * branch, a committed budget-two config, and the three real ordinary rounds
 * already spent. Build that state once, then copy it exactly as
 * `newPushedProject` does. Default-budget cases commit their own real config
 * over the private copy before their authorization path starts. Every caller
 * gets its own repo and bare remote; no authorization records, commits,
 * pushes, or authorized calls under test touch this immutable template.
 */
let preparedBudgetTwoTemplateRoot: Promise<string> | null = null;

const buildPreparedBudgetTwoTemplate = async (): Promise<string> => {
  const root = await buildPushedTemplate({
    adapter: 'plan-md',
    options: { maxDelegatedRounds: 2 },
  });
  const dir = path.join(root, 'repo');
  const cfg = path.join(dir, '.claude', 'queue.json');
  await branchAndPush(dir, 'fix/a');
  await exhaustBaseCap(dir, 'fix/a', cfg);
  return root;
};

const newPreparedBudgetTwoProject = async (
  roots: string[],
): Promise<{ dir: string; cfg: string }> => {
  if (!preparedBudgetTwoTemplateRoot) {
    preparedBudgetTwoTemplateRoot = buildPreparedBudgetTwoTemplate();
  }
  const template = await preparedBudgetTwoTemplateRoot;
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'delegated-rounds-budget-two-')));
  roots.push(root);
  await cp(template, root, { recursive: true });

  const dir = path.join(root, 'repo');
  const remote = path.join(root, 'remote');
  await git(['remote', 'set-url', 'origin', remote], dir);
  return { dir, cfg: path.join(dir, '.claude', 'queue.json') };
};

beforeAll(async () => {
  fixtureGitEnv = await discoverFixtureGitEnv();
  if (!preparedBudgetTwoTemplateRoot) {
    preparedBudgetTwoTemplateRoot = buildPreparedBudgetTwoTemplate();
  }
  await preparedBudgetTwoTemplateRoot;
});

// The prepared fixture's three journalled rounds are evidence for the later
// authorized calls. Keep every helper-created run until the shared fixture ends.
afterAll(async () => {
  await Promise.all([...baseCapRunDirs, ...fixtureRoots].map((root) => removeFixture(root)));
  baseCapRunDirs.clear();
  fixtureRoots.clear();
});

const roundsFileFor = (cfg: string) => cfg.replace(/(\.json)?$/, '.gate-rounds.json');
const roundsFor = async (cfg: string, branch: string): Promise<number> => {
  const raw = JSON.parse(await readFile(roundsFileFor(cfg), 'utf8')) as Record<string, number>;
  return raw[branch] ?? 0;
};

const decisionsFile = (dir: string, ticket: string) =>
  path.join(dir, '.rig', 'decisions', `${ticket}.jsonl`);

const readDecisionLines = async (
  dir: string,
  ticket: string,
): Promise<Array<Record<string, unknown>>> =>
  (await readFile(decisionsFile(dir, ticket), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

/**
 * Append a well-formed `extra-gate-round` line directly to a ticket's
 * decisions file — bypassing `delegated-decision.mjs record` entirely, so
 * none of its own checks (budget included) ever ran. Used only to build the
 * over-budget state a bypass would leave behind.
 */
const appendForgedDecisionLine = async (
  dir: string,
  ticket: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  const file = decisionsFile(dir, ticket);
  let existing: string;
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    existing = '';
  }
  const record = {
    schemaVersion: 1,
    ticket,
    release: null,
    decision: 'extra-gate-round',
    authority: 'delegated',
    summary: 'forged — appended directly to the file, bypassing record',
    evidence: null,
    branch: 'fix/a',
    head: '',
    at: new Date().toISOString(),
    ...overrides,
  };
  await writeFile(file, `${existing}${JSON.stringify(record)}\n`);
};

// --- options.maxDelegatedRounds — config validation -----------------------

describe('options.maxDelegatedRounds — the config value delegated-decision.mjs record reads for extra-gate-round', () => {
  it('a non-integer, negative or non-numeric maxDelegatedRounds refuses record, naming it, and writes nothing', async () => {
    const roots: string[] = [];
    try {
      for (const bad of [-1, 1.5, 'two', null]) {
        const { dir } = await newPushedProject(roots);
        await writeFile(
          path.join(dir, '.claude', 'queue.json'),
          JSON.stringify({ adapter: 'plan-md', options: { maxDelegatedRounds: bad } }),
        );
        const runDir = await delegatedRunDir();
        const h = await head(dir);
        const result = await runDelegated(
          [
            'record',
            '--ticket',
            'RP-1',
            '--decision',
            'extra-gate-round',
            '--summary',
            'ok',
            '--head',
            h,
          ],
          dir,
          envFor(runDir),
        );
        expect(result.code, `${JSON.stringify(bad)}: ${result.out}`).toBe(1);
        expect(result.out, JSON.stringify(bad)).toMatch(/maxDelegatedRounds/);
        await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
      }
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('absent maxDelegatedRounds defaults to 1: a first record succeeds, a second for the same ticket+branch is refused', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      // No .claude/queue.json at all — record works with none (mirrors the
      // existing `tracker-correction` coverage), and the default budget
      // still applies.
      const runDir = await delegatedRunDir();
      const h1 = await head(dir);
      const first = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'first',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(first.code, first.out).toBe(0);

      await writeFile(path.join(dir, 'more.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      const h2 = await head(dir);
      const second = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'second',
          '--head',
          h2,
        ],
        dir,
        envFor(runDir),
      );
      expect(second.code, second.out).not.toBe(0);
      const lines = await readDecisionLines(dir, 'RP-1');
      expect(lines).toHaveLength(1);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('a higher configured budget (2) allows a second record and refuses a third', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      await writeFile(
        path.join(dir, '.claude', 'queue.json'),
        JSON.stringify({ adapter: 'plan-md', options: { maxDelegatedRounds: 2 } }),
      );
      const runDir = await delegatedRunDir();

      const h1 = await head(dir);
      const first = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'one',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(first.code, first.out).toBe(0);

      await writeFile(path.join(dir, 'fix1.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix1'], dir);
      const h2 = await head(dir);
      const second = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'two',
          '--head',
          h2,
        ],
        dir,
        envFor(runDir),
      );
      expect(second.code, second.out).toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(2);

      await writeFile(path.join(dir, 'fix2.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix2'], dir);
      const h3 = await head(dir);
      const third = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'three',
          '--head',
          h3,
        ],
        dir,
        envFor(runDir),
      );
      expect(third.code, third.out).not.toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(2);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('a second ticket id on the same branch cannot record once the branch budget is spent', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      // No .claude/queue.json — the default budget (1) is per BRANCH, not
      // per the free-text --ticket string.
      const runDir = await delegatedRunDir();
      const h1 = await head(dir);
      const first = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(first.code, first.out).toBe(0);

      await writeFile(path.join(dir, 'fix.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      const h2 = await head(dir);

      // A DIFFERENT, made-up ticket id on the SAME branch — a fresh file,
      // but the same branch's already-spent budget.
      const second = await runDelegated(
        [
          'record',
          '--ticket',
          'FAKE-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h2,
        ],
        dir,
        envFor(runDir),
      );
      expect(second.code, second.out).not.toBe(0);
      await expect(readFile(decisionsFile(dir, 'FAKE-1'), 'utf8')).rejects.toThrow();
      // RP-1's own record is untouched by the refused attempt.
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(1);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('maxDelegatedRounds: 0 refuses the very first record as budget-exhausted, not as a config error', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      await writeFile(
        path.join(dir, '.claude', 'queue.json'),
        JSON.stringify({ adapter: 'plan-md', options: { maxDelegatedRounds: 0 } }),
      );
      const runDir = await delegatedRunDir();
      const h = await head(dir);
      const result = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).not.toBe(0);
      await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});

// --- the budget is the branch's, not any one ticket's (RP-442 round 2) ----

describe('the delegated-round budget is spent by the BRANCH, whatever ticket each record names', () => {
  it('with maxDelegatedRounds: 2, RP-1 and RP-2 on the same branch each get one authorized round, and RP-3 is refused', async () => {
    const roots: string[] = [];
    try {
      const { dir, cfg } = await newPreparedBudgetTwoProject(roots);

      const h1 = await head(dir);
      const runDir = await delegatedRunDir();
      const firstRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'one',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(firstRecord.code, firstRecord.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-rp1'], dir);
      await git(['push', '-q'], dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      const h2 = await head(dir);
      const secondRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-2',
          '--decision',
          'extra-gate-round',
          '--summary',
          'two',
          '--head',
          h2,
        ],
        dir,
        envFor(runDir),
      );
      expect(secondRecord.code, secondRecord.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-rp2'], dir);
      await git(['push', '-q'], dir);

      const round5 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-2', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(round5.code, round5.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(5);

      // The budget — not a per-ticket count — is what refuses a THIRD
      // ticket: --head here is the current checkout HEAD, past the second
      // authorization's own record-only commit.
      const h3 = await head(dir);
      const thirdRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-3',
          '--decision',
          'extra-gate-round',
          '--summary',
          'three',
          '--head',
          h3,
        ],
        dir,
        envFor(runDir),
      );
      expect(thirdRecord.code).not.toBe(0);
      await expect(readFile(decisionsFile(dir, 'RP-3'), 'utf8')).rejects.toThrow();
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});

// --- record's success message names the delegated round (RP-442 round 2) --

describe('record names the delegated round it just spent in its success message', () => {
  it('names "delegated round 1 of 1" under the default budget', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const runDir = await delegatedRunDir();
      const h = await head(dir);
      const result = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).toBe(0);
      expect(result.out).toMatch(/delegated round 1 of 1/);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('names "delegated round 2 of 2" for a second ticket on the same branch under a configured budget of 2', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      await writeFile(
        path.join(dir, '.claude', 'queue.json'),
        JSON.stringify({ adapter: 'plan-md', options: { maxDelegatedRounds: 2 } }),
      );
      const runDir = await delegatedRunDir();
      const h1 = await head(dir);
      const first = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'one',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(first.code, first.out).toBe(0);

      await writeFile(path.join(dir, 'fix.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      const h2 = await head(dir);

      const second = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-2',
          '--decision',
          'extra-gate-round',
          '--summary',
          'two',
          '--head',
          h2,
        ],
        dir,
        envFor(runDir),
      );
      expect(second.code, second.out).toBe(0);
      expect(second.out).toMatch(/delegated round 2 of 2/);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});

// --- record --decision extra-gate-round requires --head --------------------

describe('delegated-decision.mjs record --decision extra-gate-round requires --head', () => {
  it('refuses with nothing written when --head is missing entirely', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const runDir = await delegatedRunDir();
      const result = await runDelegated(
        ['record', '--ticket', 'RP-1', '--decision', 'extra-gate-round', '--summary', 'ok'],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).not.toBe(0);
      expect(result.out).toMatch(/--head/);
      await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses with nothing written when --head differs from the checkout HEAD', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const runDir = await delegatedRunDir();
      const result = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          '0'.repeat(40),
        ],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).not.toBe(0);
      await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses on a detached checkout, nothing written', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const h = await head(dir);
      await git(['checkout', '-q', '--detach', h], dir);
      const runDir = await delegatedRunDir();
      const result = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).not.toBe(0);
      await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('succeeds when --head matches the checkout HEAD exactly, and the stored record carries branch and head', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const runDir = await delegatedRunDir();
      const h = await head(dir);
      const result = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).toBe(0);
      const lines = await readDecisionLines(dir, 'RP-1');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ decision: 'extra-gate-round', branch: 'main', head: h });
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('a decision other than extra-gate-round never requires --head', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const runDir = await delegatedRunDir();
      const result = await runDelegated(
        ['record', '--ticket', 'RP-1', '--decision', 'tracker-correction', '--summary', 'ok'],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(1);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});

// --- queue/index.mjs gate-round --authorized -------------------------------

describe('queue/index.mjs gate-round --branch <b> --ticket <id> --authorized (RP-442)', () => {
  it("without --authorized, behaviour past the cap is exactly today's: exit 2", async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--config', cfg],
        dir,
        withoutGitLocation(),
      );
      expect(result.code).toBe(2);
      // RP-442: an exhausted plain call is not counted — the branch still
      // reads 3, the base cap it already spent, not a phantom fourth round.
      // Unaffected by `--ticket` being present with no `--authorized`.
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('exits 2 when no authorization record exists at all', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      // Every OTHER check on the path passes: a declared delegated authority
      // for the consuming call itself — so this refusal is isolated to there
      // being no authorization record at all.
      const runDir = await delegatedRunDir();
      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('lets --check --authorized pass at the base cap without consuming the delegated round', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const authorizedRun = await delegatedRunDir();
      roots.push(authorizedRun);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'preflight',
          '--head',
          await head(dir),
        ],
        dir,
        envFor(authorizedRun),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const checked = await runGateRound(
        ['--check', '--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(authorizedRun),
      );
      expect(checked.code, checked.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('does not consume a valid delegated round when no reviewer fan-out was recorded', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const authorizedRun = await delegatedRunDir();
      roots.push(authorizedRun);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'no fan-out',
          '--head',
          await head(dir),
        ],
        dir,
        envFor(authorizedRun),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const result = await run(
        process.execPath,
        [
          queueIndexScript,
          'gate-round',
          '--branch',
          'fix/a',
          '--ticket',
          'RP-1',
          '--authorized',
          '--config',
          cfg,
        ],
        dir,
        envFor(authorizedRun),
      );
      expect(result.code, result.out).toBe(1);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
      const checked = await run(
        process.execPath,
        [
          queueIndexScript,
          'gate-round',
          '--check',
          '--branch',
          'fix/a',
          '--ticket',
          'RP-1',
          '--authorized',
          '--config',
          cfg,
        ],
        dir,
        envFor(authorizedRun),
      );
      expect(checked.code, checked.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('acknowledges a replayed delegated fan-out without spending another total-cap round', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const runDir = await delegatedRunDir();
      roots.push(runDir);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'replay',
          '--head',
          await head(dir),
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const args = ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg];
      const reserved = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(runDir),
      );
      expect(reserved.code, reserved.out).toBe(0);
      const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
      expect(token).toBeDefined();
      await recordFanOut(dir, runDir, `gate-round reservation: ${token!}`);
      const first = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reservation', token!],
        dir,
        envFor(runDir),
      );
      expect(first.code, first.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
      const replay = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reservation', token!],
        dir,
        envFor(runDir),
      );
      expect(replay.code, replay.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses a new delegated fan-out at the total cap without recording round five', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const runDir = await delegatedRunDir();
      roots.push(runDir);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'total-cap',
          '--head',
          await head(dir),
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const args = ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg];
      const round4 = await runGateRound(args, dir, envFor(runDir));
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
      const round5 = await runGateRound(args, dir, envFor(runDir));
      expect(round5.code, round5.out).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses a delegated fan-out when another controller fills the final total-cap slot before authorization returns', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const runDir = await delegatedRunDir();
      roots.push(runDir);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'racing total cap',
          '--head',
          await head(dir),
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const rounds = roundsFileFor(cfg);
      // `runDir` may use macOS's `/var` spelling while the production
      // journal resolves it to `/private/var`; the preload observes the
      // latter, so compare the supported canonical alias.
      const state = await realpath(path.join(runDir, 'state.json'));
      const trace = path.join(runDir, 'racing-write.trace');
      const preload = path.join(runDir, 'fill-final-slot.mjs');
      await writeFile(
        preload,
        [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          'const original = fs.readFileSync;',
          'let fired = false;',
          'fs.readFileSync = function(file, ...args) {',
          '  const value = original.call(this, file, ...args);',
          `  if (!fired && String(file) === ${JSON.stringify(state)}) {`,
          '    fired = true;',
          `    const current = JSON.parse(original.call(this, ${JSON.stringify(rounds)}, 'utf8'));`,
          "    current['fix/a'] = 4;",
          `    fs.writeFileSync(${JSON.stringify(rounds)}, JSON.stringify(current, null, 2) + '\\n');`,
          `    fs.writeFileSync(${JSON.stringify(trace)}, 'filled\\n');`,
          '  }',
          '  return value;',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );
      const args = ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg];
      const result = await run(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          queueIndexScript,
          'gate-round',
          ...args,
          '--reserve',
        ],
        dir,
        envFor(runDir),
      );
      expect(await readFile(trace, 'utf8')).toBe('filled\n');
      expect(result.code, result.out).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('serializes an unbound root-journal reviewer verdict written at the authorized counter-lock boundary', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const authorizationHead = await head(dir);
      const delegated = await delegatedRunDir();
      roots.push(delegated);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'counter-lock verdict race',
          '--head',
          authorizationHead,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // This is deliberately neither the consuming delegated run nor an
      // existing reservation binding: eligibility scans root journals too,
      // so its public writer must share the admission boundary.
      const rootReviewRun = path.join(dir, '.claude', 'runs', 'r4-root-verdict');
      const rounds = roundsFileFor(cfg);
      const trace = path.join(delegated, 'counter-lock-verdict.trace');
      const preload = path.join(delegated, 'write-verdict-at-counter-lock.mjs');
      await mkdir(rootReviewRun, { recursive: true });
      await writeFile(
        preload,
        [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          `import { recordDecision } from ${JSON.stringify(pathToFileURL(scriptPath('run-journal.mjs')).href)};`,
          'const original = fs.openSync;',
          'let injected = false;',
          'fs.openSync = function(file, ...args) {',
          `  if (!injected && String(file) === ${JSON.stringify(`${rounds}.lock`)}) {`,
          '    injected = true;',
          '    recordDecision({',
          '      runDir: process.env.RP521_REVIEW_RUN,',
          "      gate: 'code-reviewer',",
          "      verdict: 'HOLD',",
          '      headSha: process.env.RP521_AUTHORIZATION_HEAD,',
          '      now: new Date().toISOString(),',
          '    });',
          `    fs.writeFileSync(${JSON.stringify(trace)}, 'persisted\\n');`,
          '  }',
          '  return original.call(this, file, ...args);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );
      const result = await run(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          queueIndexScript,
          'gate-round',
          '--reserve',
          '--branch',
          'fix/a',
          '--ticket',
          'RP-1',
          '--authorized',
          '--config',
          cfg,
        ],
        dir,
        {
          ...envFor(delegated),
          RP521_REVIEW_RUN: rootReviewRun,
          RP521_AUTHORIZATION_HEAD: authorizationHead,
        },
      );

      expect(await readFile(trace, 'utf8')).toBe('persisted\n');
      expect(result.code, result.out).toBe(2);
      expect(result.stdout).not.toMatch(/\breservation\s+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses a covered-head verdict from a root journal created at the counter-lock boundary', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const authorizationHead = await head(dir);
      const delegated = await delegatedRunDir();
      roots.push(delegated);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'new root journal verdict race',
          '--head',
          authorizationHead,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // Do not create this directory before `authorizedRoundFor` takes its
      // initial snapshot. The public journal writer creates it only when the
      // counter lock opens, which forces a fresh eligibility scan to discover
      // a newly-created root-run directory rather than reuse old membership.
      const rootReviewRun = path.join(dir, '.claude', 'runs', 'r4-late-root-verdict');
      const rounds = roundsFileFor(cfg);
      const trace = path.join(delegated, 'late-root-verdict.trace');
      const preload = path.join(delegated, 'write-late-root-verdict.mjs');
      await writeFile(
        preload,
        [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          `import { recordDecision } from ${JSON.stringify(pathToFileURL(scriptPath('run-journal.mjs')).href)};`,
          'const original = fs.openSync;',
          'let injected = false;',
          'fs.openSync = function(file, ...args) {',
          `  if (!injected && String(file) === ${JSON.stringify(`${rounds}.lock`)}) {`,
          '    injected = true;',
          '    fs.mkdirSync(process.env.RP521_REVIEW_RUN, { recursive: true });',
          '    recordDecision({',
          '      runDir: process.env.RP521_REVIEW_RUN,',
          "      gate: 'code-reviewer',",
          "      verdict: 'HOLD',",
          '      headSha: process.env.RP521_AUTHORIZATION_HEAD,',
          '      now: new Date().toISOString(),',
          '    });',
          `    fs.writeFileSync(${JSON.stringify(trace)}, 'persisted\\n');`,
          '  }',
          '  return original.call(this, file, ...args);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );

      const result = await run(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          queueIndexScript,
          'gate-round',
          '--reserve',
          '--branch',
          'fix/a',
          '--ticket',
          'RP-1',
          '--authorized',
          '--config',
          cfg,
        ],
        dir,
        {
          ...envFor(delegated),
          RP521_REVIEW_RUN: rootReviewRun,
          RP521_AUTHORIZATION_HEAD: authorizationHead,
        },
      );

      expect(await readFile(trace, 'utf8')).toBe('persisted\n');
      expect(result.code, result.out).toBe(2);
      expect(result.stdout).not.toMatch(/\breservation\s+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses a covered-head verdict from a root journal created at final counter persistence', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const authorizationHead = await head(dir);
      const delegated = await delegatedRunDir();
      roots.push(delegated);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'late final root journal verdict race',
          '--head',
          authorizationHead,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // This distinct root run is absent at every earlier eligibility read.
      // Its public writer races exactly with the final counter persistence.
      const rootReviewRun = path.join(dir, '.claude', 'runs', 'r4-late-final-root-verdict');
      const rounds = roundsFileFor(cfg);
      const trace = path.join(delegated, 'late-final-root-verdict.trace');
      const preload = path.join(delegated, 'write-late-final-root-verdict.mjs');
      await writeFile(
        preload,
        [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          `import { recordDecision } from ${JSON.stringify(pathToFileURL(scriptPath('run-journal.mjs')).href)};`,
          'const original = fs.renameSync;',
          'let injected = false;',
          'fs.renameSync = function(source, destination, ...args) {',
          `  if (!injected && String(destination) === ${JSON.stringify(rounds)}) {`,
          '    injected = true;',
          '    fs.mkdirSync(process.env.RP521_REVIEW_RUN, { recursive: true });',
          '    recordDecision({',
          '      runDir: process.env.RP521_REVIEW_RUN,',
          "      gate: 'security-scanner',",
          "      verdict: 'HOLD',",
          '      headSha: process.env.RP521_AUTHORIZATION_HEAD,',
          '      now: new Date().toISOString(),',
          '    });',
          `    fs.writeFileSync(${JSON.stringify(trace)}, 'persisted\\n');`,
          '  }',
          '  return original.call(this, source, destination, ...args);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );

      const beforeCounter = await readFile(rounds, 'utf8');
      const result = await run(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          queueIndexScript,
          'gate-round',
          '--reserve',
          '--branch',
          'fix/a',
          '--ticket',
          'RP-1',
          '--authorized',
          '--config',
          cfg,
        ],
        dir,
        {
          ...envFor(delegated),
          RP521_REVIEW_RUN: rootReviewRun,
          RP521_AUTHORIZATION_HEAD: authorizationHead,
        },
      );

      expect(await readFile(trace, 'utf8')).toBe('persisted\n');
      expect(result.code, result.out).toBe(2);
      expect(result.stdout).not.toMatch(/\breservation\s+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
      expect(await readFile(rounds, 'utf8')).toBe(beforeCounter);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('serializes a real unbound root-journal verdict at final counter persistence before admitting its token', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const authorizationHead = await head(dir);
      const delegated = await delegatedRunDir();
      roots.push(delegated);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'final-persistence verdict race',
          '--head',
          authorizationHead,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // A second eligibility read outside the shared writer boundary would
      // pass the preceding test, then still mint a token here after the
      // independent root-journal writer has persisted its verdict.
      const rootReviewRun = path.join(dir, '.claude', 'runs', 'r4-final-verdict');
      const rounds = roundsFileFor(cfg);
      const trace = path.join(delegated, 'final-persistence-verdict.trace');
      const preload = path.join(delegated, 'write-verdict-at-final-persistence.mjs');
      await mkdir(rootReviewRun, { recursive: true });
      await writeFile(
        preload,
        [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          `import { recordDecision } from ${JSON.stringify(pathToFileURL(scriptPath('run-journal.mjs')).href)};`,
          'const original = fs.renameSync;',
          'let injected = false;',
          'fs.renameSync = function(source, destination, ...args) {',
          `  if (!injected && String(destination) === ${JSON.stringify(rounds)}) {`,
          '    injected = true;',
          '    try {',
          '      recordDecision({',
          '        runDir: process.env.RP521_REVIEW_RUN,',
          "        gate: 'security-scanner',",
          "        verdict: 'HOLD',",
          '        headSha: process.env.RP521_AUTHORIZATION_HEAD,',
          '        now: new Date().toISOString(),',
          '      });',
          `      fs.writeFileSync(${JSON.stringify(trace)}, 'persisted\\n');`,
          '    } catch (error) {',
          `      fs.writeFileSync(${JSON.stringify(trace)}, \`refused:\${error.failure}:\${error.message}\\n\`);`,
          '    }',
          '  }',
          '  return original.call(this, source, destination, ...args);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );

      const result = await run(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          queueIndexScript,
          'gate-round',
          '--reserve',
          '--branch',
          'fix/a',
          '--ticket',
          'RP-1',
          '--authorized',
          '--config',
          cfg,
        ],
        dir,
        {
          ...envFor(delegated),
          RP521_REVIEW_RUN: rootReviewRun,
          RP521_AUTHORIZATION_HEAD: authorizationHead,
        },
      );

      const writer = await readFile(trace, 'utf8');
      const token = result.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
      expect(writer).toMatch(/^(persisted|refused:busy:)/s);
      if (writer === 'persisted\n') {
        expect(result.code, result.out).toBe(2);
        expect(token).toBeUndefined();
        expect(await roundsFor(cfg, 'fix/a')).toBe(3);
      } else {
        expect(result.code, result.out).toBe(0);
        expect(token).toBeDefined();
        expect(await roundsFor(cfg, 'fix/a')).toBe(3);
      }
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('rolls back a post-persistence journal failure before returning an authorized reservation', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const authorizationHead = await head(dir);
      const delegated = await delegatedRunDir();
      roots.push(delegated);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'post-persist journal failure',
          '--head',
          authorizationHead,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // The root run appears only after the reservation's first counter write.
      // Its real fresh journal lock makes `afterPersist` fail after persistence.
      const lateRun = path.join(dir, '.claude', 'runs', 'r6-late-journal-lock');
      const lock = path.join(lateRun, '.journal.lock');
      const rounds = roundsFileFor(cfg);
      const trace = path.join(delegated, 'post-persist-journal-lock.trace');
      const preload = path.join(delegated, 'fail-after-reservation-persist.mjs');
      await writeFile(
        preload,
        [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          'const original = fs.renameSync;',
          'let injected = false;',
          'fs.renameSync = function(source, destination, ...args) {',
          `  if (!injected && String(destination) === ${JSON.stringify(rounds)}) {`,
          '    injected = true;',
          '    fs.mkdirSync(process.env.RP521_LATE_RUN, { recursive: true });',
          `    fs.writeFileSync(${JSON.stringify(lock)}, 'held\\n');`,
          `    fs.writeFileSync(${JSON.stringify(trace)}, 'locked\\n');`,
          '  }',
          '  return original.call(this, source, destination, ...args);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );
      const args = ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg];
      const beforeCounter = await readFile(rounds, 'utf8');
      const failed = await run(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          queueIndexScript,
          'gate-round',
          ...args,
          '--reserve',
        ],
        dir,
        { ...envFor(delegated), RP521_LATE_RUN: lateRun },
      );

      expect(await readFile(trace, 'utf8')).toBe('locked\n');
      expect(failed.code, failed.out).not.toBe(0);
      expect(failed.stdout).not.toMatch(/\breservation\s+/i);
      expect(await readFile(rounds, 'utf8')).toBe(beforeCounter);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);

      // Remove only the fixture fault. A new, ordinary admission must now
      // succeed once, while a replay for the same run and head stays pending.
      await rm(lock);
      const fresh = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(delegated),
      );
      expect(fresh.code, fresh.out).toBe(0);
      expect(fresh.stdout).toMatch(/\breservation\s+[^\s]+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);

      const replay = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(delegated),
      );
      expect(replay.code, replay.out).not.toBe(0);
      expect(replay.stdout).not.toMatch(/\breservation\s+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('counts a reserved delegated fan-out after a reviewer verdict makes a new admission ineligible', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      const authorizationHead = await head(dir);
      const runDir = await delegatedRunDir();
      roots.push(runDir);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'fast verdict',
          '--head',
          authorizationHead,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const args = ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg];
      const reserved = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(runDir),
      );
      expect(reserved.code, reserved.out).toBe(0);
      const token = reserved.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
      expect(token).toBeDefined();
      await recordFanOut(dir, runDir, `gate-round reservation: ${token!}`);

      const reviewRun = path.join(dir, '.claude', 'runs', 'r1');
      await mkdir(reviewRun, { recursive: true });
      recordDecision({
        runDir: reviewRun,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        headSha: authorizationHead,
        now: new Date().toISOString(),
      });
      const consumed = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reservation', token!],
        dir,
        envFor(runDir),
      );
      expect(consumed.code, consumed.out).toBe(0);
      expect(consumed.stdout).toMatch(/round 4 of 4/);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('does not let maxDelegatedRounds: 2 reuse one committed authorization for a second reservation', async () => {
    const roots: string[] = [];
    try {
      const { dir, cfg } = await newPreparedBudgetTwoProject(roots);
      const runDir = await delegatedRunDir();
      roots.push(runDir);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'one token',
          '--head',
          await head(dir),
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const args = ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg];
      const first = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(runDir),
      );
      expect(first.code, first.out).toBe(0);
      const token = first.stdout.match(/\breservation\s+([^\s]+)/i)?.[1];
      expect(token).toBeDefined();
      await recordFanOut(dir, runDir, `gate-round reservation: ${token!}`);
      const consumed = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reservation', token!],
        dir,
        envFor(runDir),
      );
      expect(consumed.code, consumed.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      const repeated = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(runDir),
      );
      expect(repeated.code).toBe(2);
      expect(repeated.stdout).not.toMatch(/\breservation\s+[^\s]+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('does not let a second declared run reserve an unconsumed committed authorization', async () => {
    const roots: string[] = [];
    try {
      const { dir, cfg } = await newPreparedBudgetTwoProject(roots);
      const authorizingRun = await delegatedRunDir();
      const otherRun = await delegatedRunDir();
      roots.push(authorizingRun, otherRun);
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'active token',
          '--head',
          await head(dir),
        ],
        dir,
        envFor(authorizingRun),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const args = ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg];
      const first = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(authorizingRun),
      );
      expect(first.code, first.out).toBe(0);
      expect(first.stdout).toMatch(/\breservation\s+[^\s]+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);

      const second = await run(
        process.execPath,
        [queueIndexScript, 'gate-round', ...args, '--reserve'],
        dir,
        envFor(otherRun),
      );

      expect(second.code).toBe(2);
      expect(second.stdout).not.toMatch(/\breservation\s+[^\s]+/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('exits 0 and counts the round when a matching, not-yet-verdicted authorization exists', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);

      // Durable means committed: `gate-round` refuses a dirty or unpushed
      // checkout before counting anything, so the authorization only
      // matters once a record-only commit (changing nothing but
      // `.rig/decisions/`) lands it on the branch.
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Rule (a): the authorization survives moving HEAD, as long as every
  // commit on top of the recorded head changes nothing but
  // `.rig/decisions/` — which committing the authorization itself always
  // does.
  it('a record-only commit on top of the authorized head still matches', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);

      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      // The commit genuinely moved HEAD off the head the record names — the
      // match below is the chain-walk, not an accidental equality.
      expect(await head(dir)).not.toBe(h);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Rule (b): a commit that lands the authorization but ALSO changes code
  // is not a record-only commit, so it breaks the chain `authorizedRoundFor`
  // walks — exit 2, nothing counted, exactly as if no authorization existed.
  it('a commit that also changes code on top of the authorized head does not match', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);

      await writeFile(path.join(dir, 'code.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization and a fix'], dir);
      await git(['push', '-q'], dir);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('exits 2 when the authorization is for a different ticket', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-9',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('exits 2 when the authorization is for a different branch', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      // Authorise under a DIFFERENT checked-out branch at the same head.
      await branchAndPush(dir, 'fix/b');
      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      await git(['checkout', '-q', 'fix/a'], dir);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('exits 2 when the authorization is for an older head (a fix commit landed since)', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h1 = await head(dir);
      const runDir = await delegatedRunDir();
      await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );

      await writeFile(path.join(dir, 'fix.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      await git(['push', '-q'], dir);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Consume-once: once a reviewer has left a verdict for the authorized
  // head, that one authorization is spent — a second `--authorized` call at
  // the SAME head (no new commit, no new record) is refused.
  it('exits 2 on a second --authorized call at the same head once a reviewer verdict is recorded for it', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPreparedBudgetTwoProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });

      const h = await head(dir);
      const delegated = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const firstAuthorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(firstAuthorized.code, firstAuthorized.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      // The reviewer fan-out's own verdict, at the head the RECORD itself
      // names (`h`) rather than the record-only commit's own head — still
      // inside the chain `authorizedRoundFor` covers. Written into a run
      // directory under THIS checkout's own `.claude/runs/`, which
      // `authorizedRoundFor` always scans regardless of the consuming call's
      // own declared `RIG_RUN_DIR` (used below only for its authority).
      const reviewRunDir = path.join(dir, '.claude', 'runs', 'r1');
      await mkdir(reviewRunDir, { recursive: true });
      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        headSha: h,
        now: new Date().toISOString(),
      });

      const secondAuthorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(secondAuthorized.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Same consume-once check, but the reviewer verdict lives under a
  // declared RIG_RUN_DIR instead of the checkout's own `.claude/runs/`.
  it('also finds the reviewer verdict under a declared RIG_RUN_DIR', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const delegated = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const committedHead = await head(dir);
      expect(committedHead).not.toBe(h);

      const firstAuthorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(firstAuthorized.code, firstAuthorized.out).toBe(0);

      // This time the verdict is recorded at the RECORD-ONLY COMMIT's own
      // head (not the head the record names) — the other end of the chain
      // `authorizedRoundFor` covers, and still consumption. Also a
      // delegated-authority run directory, since it is what the second
      // `--authorized` call below is told as its own `RIG_RUN_DIR`.
      const reviewRunDir = await delegatedRunDir();
      roots.push(reviewRunDir);
      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'SHIP',
        headSha: committedHead,
        now: new Date().toISOString(),
      });

      const secondAuthorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(reviewRunDir),
      );
      expect(secondAuthorized.code).toBe(2);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // R5 under the DEFAULT budget (1): the single record was already spent at
  // H1 (consumed by the round-4 authorization above); a fix commit (H2)
  // cannot get a second record at all (`record`'s own budget refusal,
  // pinned above), so `--authorized` at H2 has nothing to match.
  it('exits 2 on a fix commit past the default budget — no second authorization exists to match', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h1 = await head(dir);
      const delegated = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h1,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      await writeFile(path.join(dir, 'fix.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      await git(['push', '-q'], dir);
      const h2 = await head(dir);

      const refusedRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'again',
          '--head',
          h2,
        ],
        dir,
        envFor(delegated),
      );
      expect(refusedRecord.code).not.toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(1);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // With a configured budget of 2, the SAME fix-commit story goes through:
  // the second record at H2 succeeds, and `--authorized` there counts round 5.
  it('with maxDelegatedRounds: 2, a second authorization at a fix commit (H2) proceeds, and a third record is refused', async () => {
    const roots: string[] = [];
    try {
      const { dir, cfg } = await newPreparedBudgetTwoProject(roots);

      const h1 = await head(dir);
      const delegated = await delegatedRunDir();
      const firstRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h1,
        ],
        dir,
        envFor(delegated),
      );
      expect(firstRecord.code, firstRecord.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      await writeFile(path.join(dir, 'fix.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      await git(['push', '-q'], dir);
      const h2 = await head(dir);

      const secondRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'again',
          '--head',
          h2,
        ],
        dir,
        envFor(delegated),
      );
      expect(secondRecord.code, secondRecord.out).toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(2);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-2'], dir);
      await git(['push', '-q'], dir);

      const round5 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round5.code, round5.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(5);

      // The budget — not a head mismatch — is what refuses the third
      // record: --head here is the CURRENT checkout HEAD (past the second
      // authorization's own record-only commit).
      const h3 = await head(dir);
      const thirdRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'third',
          '--head',
          h3,
        ],
        dir,
        envFor(delegated),
      );
      expect(thirdRecord.code).not.toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(2);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Cross-clone replay: `.rig/decisions/` is read from the git tree, so an
  // authorization another session recorded and pushed is visible from a
  // SECOND, independent clone that never ran `record` itself.
  //
  // 🔴 Known limit, stated rather than tested as a positive case: consumption
  // (the "has a reviewer already verdicted this head" check) is read from
  // THIS checkout's own local `.claude/runs/` or `RIG_RUN_DIR` — never
  // committed, never shared across clones. A second clone that never ran a
  // reviewer fan-out locally has no way to see one recorded elsewhere; this
  // test's second clone succeeds in part BECAUSE it has no local run
  // journal of its own, not despite it.
  it('an authorization recorded and pushed from one clone is consumable from a second, independent clone', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');

      const h = await head(dir);
      const delegated = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const remote = await git(['config', '--get', 'remote.origin.url'], dir);
      const clone = await realpath(await mkdtemp(path.join(tmpdir(), 'delegated-rounds-clone-')));
      roots.push(clone);
      await git(['clone', '-q', '--branch', 'fix/a', remote, clone], tmpdir());
      const cloneCfg = path.join(clone, '.claude', 'queue.json');

      await exhaustBaseCap(clone, 'fix/a', cloneCfg);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cloneCfg],
        clone,
        envFor(delegated),
      );
      expect(result.code, result.out).toBe(0);
      expect(await roundsFor(cloneCfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // RP-442 round 2: `record` is not the only way a line can land in
  // `.rig/decisions/` — a line appended by hand, never through `record`,
  // carries none of that command's checks. `--authorized` has to notice the
  // branch holds more `extra-gate-round` records than the budget allows and
  // refuse on that alone, even though the matching record's own chain to
  // HEAD is otherwise intact and unconsumed.
  it('refuses --authorized when the branch holds MORE extra-gate-round records than the budget — evidence of a bypass', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' }); // default budget 1
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h1 = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const h2 = await head(dir);

      // The bypass: a second `extra-gate-round` line appended BY HAND,
      // naming the record-only commit's own head so the chain walk below
      // still matches it — committed on its own, still a record-only
      // commit.
      await appendForgedDecisionLine(dir, 'RP-1', { branch: 'fix/a', head: h2 });
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'forged second authorization'], dir);
      await git(['push', '-q'], dir);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // RP-442 round 2: a verdict's `headSha` is free text a reviewer process
  // writes, not a value this module controls — case alone must not hide it
  // from the consumed-once check, since git's own canonical SHA text is
  // always lowercase and a case mismatch is exactly the gap a bypass would
  // exploit.
  it('a reviewer verdict recorded with an UPPERCASE headSha still counts as consumption', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const delegated = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const firstAuthorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(firstAuthorized.code, firstAuthorized.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      const reviewRunDir = path.join(dir, '.claude', 'runs', 'r1');
      await mkdir(reviewRunDir, { recursive: true });
      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        headSha: h.toUpperCase(),
        now: new Date().toISOString(),
      });

      const secondAuthorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(secondAuthorized.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // RP-442, further round — the total cap is maxGateRounds + maxDelegatedRounds
  // (3 + 1 = 4 under the default budget), and it is checked from the
  // branch's OWN counted rounds, never from a decision record's content.
  //
  // Probe 3: once round 4 is counted and the reviewer verdict that consumed
  // it is on record, an in-place rewrite of the SINGLE existing RP-1 line —
  // changing only its `head` field to a commit no verdict was ever recorded
  // against — keeps the record COUNT at 1 (so the "more records than the
  // budget" check in round 2 never fires) while escaping the consumed-once
  // check entirely. `--authorized` must still refuse: the branch has already
  // spent its 4 rounds, independent of what the rewritten record claims.
  it('an in-place rewrite of the single counted record to a new, unverdicted head cannot buy a round past the total cap (probe 3)', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h1 = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);
      const hA = await head(dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(round4.code, round4.out).toBe(0);
      // The total cap this project has: maxGateRounds (3, the default) plus
      // maxDelegatedRounds (1, the default) — declared here, not read from
      // production.
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      // Consume the authorization exactly the way an honest reviewer fan-out
      // would: a verdict at the record's own declared head.
      const reviewRunDir = path.join(dir, '.claude', 'runs', 'r1');
      await mkdir(reviewRunDir, { recursive: true });
      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        headSha: h1,
        now: new Date().toISOString(),
      });

      // The tamper: rewrite the one existing RP-1 line in place so its own
      // `head` names the current real HEAD (`hA`) instead of `h1` — no
      // verdict was ever recorded against `hA`, so the rewritten record
      // reads as fresh. The rewrite itself is committed, and it changes
      // nothing but `.rig/decisions/`.
      const beforeRewrite = await readDecisionLines(dir, 'RP-1');
      expect(beforeRewrite).toHaveLength(1);
      const rewritten = { ...beforeRewrite[0], head: hA };
      await writeFile(decisionsFile(dir, 'RP-1'), `${JSON.stringify(rewritten)}\n`);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'rewrite record in place'], dir);
      await git(['push', '-q'], dir);

      // The rewrite changed the one line's content, not the line count.
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(1);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      // Nothing was counted — still exactly the total cap from round 4.
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Probe 4: deleting a ticket's decisions file and recording a brand-new
  // authorization in its place also keeps the branch's record count inside
  // the budget at every single read (the deletion and the fresh record never
  // coexist), and the fresh record's head carries no verdict at all — yet
  // the branch has already spent its total cap and `--authorized` must
  // refuse regardless.
  it('deleting a ticket decisions file and re-recording a fresh authorization cannot buy a round past the total cap (probe 4)', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h1 = await head(dir);
      const runDir = await delegatedRunDir();
      const firstRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h1,
        ],
        dir,
        envFor(runDir),
      );
      expect(firstRecord.code, firstRecord.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      // Consume round 4's authorization, so a plain replay of the SAME
      // record could never explain what follows.
      const reviewRunDir = path.join(dir, '.claude', 'runs', 'r1');
      await mkdir(reviewRunDir, { recursive: true });
      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        headSha: h1,
        now: new Date().toISOString(),
      });

      // The tamper: delete the ticket's decisions file outright (never
      // through `record`), then run the OFFICIAL `record` command again —
      // it succeeds, because the branch's record count is 0 the instant it
      // is checked.
      await git(['rm', '-q', path.join('.rig', 'decisions', 'RP-1.jsonl')], dir);
      await git(['commit', '-q', '-m', 'delete decision record'], dir);
      await git(['push', '-q'], dir);
      const h2 = await head(dir);

      const secondRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'again',
          '--head',
          h2,
        ],
        dir,
        envFor(runDir),
      );
      expect(secondRecord.code, secondRecord.out).toBe(0);
      expect(secondRecord.out).toMatch(/delegated round 1 of 1/);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-2'], dir);
      await git(['push', '-q'], dir);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      // Nothing was counted — still exactly the total cap from round 4.
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // The total cap is maxGateRounds + maxDelegatedRounds generally, not just
  // under the default budget of 1: with maxDelegatedRounds: 2, rounds 4 and
  // 5 are authorized exactly as the legitimate-budget tests above already
  // pin, and the total cap (3 + 2 = 5) still refuses a tampered round 6.
  it('with maxDelegatedRounds: 2, rounds 4 and 5 authorize legitimately and a rewritten-in-place record still cannot buy round 6', async () => {
    const roots: string[] = [];
    try {
      const { dir, cfg } = await newPreparedBudgetTwoProject(roots);

      const h1 = await head(dir);
      const delegated = await delegatedRunDir();
      const firstRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'one',
          '--head',
          h1,
        ],
        dir,
        envFor(delegated),
      );
      expect(firstRecord.code, firstRecord.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      const reviewRunDir = path.join(dir, '.claude', 'runs', 'r1');
      await mkdir(reviewRunDir, { recursive: true });
      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        headSha: h1,
        now: new Date().toISOString(),
      });

      await writeFile(path.join(dir, 'fix.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      await git(['push', '-q'], dir);
      const h2 = await head(dir);

      const secondRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'two',
          '--head',
          h2,
        ],
        dir,
        envFor(delegated),
      );
      expect(secondRecord.code, secondRecord.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-2'], dir);
      await git(['push', '-q'], dir);
      const hB = await head(dir);

      const round5 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round5.code, round5.out).toBe(0);
      // The total cap with a configured budget of 2: 3 + 2 = 5.
      expect(await roundsFor(cfg, 'fix/a')).toBe(5);

      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'SHIP',
        headSha: h2,
        now: new Date().toISOString(),
      });

      // The tamper: rewrite the SECOND record in place so its own `head`
      // names the current real HEAD (`hB`, the commit that landed it) —
      // not `h2`, the head the reviewer verdict above was recorded against.
      // The record count stays 2.
      const beforeRewrite = await readDecisionLines(dir, 'RP-1');
      expect(beforeRewrite).toHaveLength(2);
      const rewritten = beforeRewrite.map((line, index) =>
        index === 1 ? { ...line, head: hB } : line,
      );
      await writeFile(
        decisionsFile(dir, 'RP-1'),
        `${rewritten.map((line) => JSON.stringify(line)).join('\n')}\n`,
      );
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'rewrite record 2 in place'], dir);
      await git(['push', '-q'], dir);

      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(2);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(result.code).toBe(2);
      // Nothing was counted — still exactly the total cap from round 5.
      expect(await roundsFor(cfg, 'fix/a')).toBe(5);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // RP-442, round-3 fix: pr-ship step 0 (SKILL.md's own step 0) runs a PLAIN
  // `gate-round` first — no `--ticket` — and only on exit 2 does the loop
  // record the delegated authorization and retry with `--ticket --authorized`.
  // Today, the exhausted plain call still COUNTS before computing its exit
  // code, so by the time the documented `--authorized` retry runs, the
  // branch already reads as having spent the total cap (maxGateRounds +
  // maxDelegatedRounds) and the retry is refused — the delegated round this
  // project's config grants is unreachable through the documented order.
  it('pr-ship order: an exhausted plain call does not count, so the documented --authorized retry still buys round 4', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);

      // pr-ship step 0's own first call: plain, no --ticket.
      const exhausted = await runGateRound(
        ['--branch', 'fix/a', '--config', cfg],
        dir,
        withoutGitLocation(),
      );
      expect(exhausted.code).toBe(2);
      // An exhausted call is not a round (RP-442): the branch still reads 3,
      // not 4 — this is the assertion the round-3 bug violates.
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);

      // pr-ship's documented recovery: record the delegated authorization at
      // HEAD, commit it alone, push.
      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // And step 0's documented retry: --ticket --authorized.
      const authorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(authorized.code, authorized.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // RP-442, round-3 fix: once the branch has spent round 4 (the one
  // delegated round the default budget grants) and a reviewer has verdicted
  // the authorized head, the authorization is both consumed AND the branch
  // sits at its total cap. Neither a further plain call nor a further
  // --authorized call may move the counter from there — and, per the fix,
  // the plain call must refuse WITHOUT counting, exactly like the
  // authorized one already does.
  it('past the total cap and a consumed authorization, a further plain call and a further --authorized call both refuse without counting', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      // The reviewer fan-out's own verdict on the authorized head — spends
      // the one authorization record just like the earlier consume-once
      // tests above.
      const reviewRunDir = path.join(dir, '.claude', 'runs', 'r1');
      await mkdir(reviewRunDir, { recursive: true });
      recordDecision({
        runDir: reviewRunDir,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        headSha: h,
        now: new Date().toISOString(),
      });

      const furtherPlain = await runGateRound(
        ['--branch', 'fix/a', '--config', cfg],
        dir,
        withoutGitLocation(),
      );
      expect(furtherPlain.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      const furtherAuthorized = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(furtherAuthorized.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('the repository-composed budget admits the H5 grant for R8, then refuses a sixth grant and R9 without counting it', async () => {
    const roots: string[] = [];
    try {
      // This is the real composed queue this repository runs, copied into an
      // otherwise independent pushed Git fixture. It is deliberately not a
      // hand-written maxDelegatedRounds: 2 test configuration.
      const repositoryQueue = JSON.parse(
        await readFile(path.join(repoRoot, '.claude', 'queue.json'), 'utf8'),
      ) as unknown;
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, repositoryQueue);
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const delegated = await delegatedRunDir();
      roots.push(delegated);
      const h1 = await head(dir);
      const firstRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'first repository-composed grant',
          '--head',
          h1,
        ],
        dir,
        envFor(delegated),
      );
      expect(firstRecord.code, firstRecord.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      const round4 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round4.code, round4.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      await writeFile(path.join(dir, 'fix.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix'], dir);
      await git(['push', '-q'], dir);
      const h2 = await head(dir);

      const secondRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'second repository-composed grant',
          '--head',
          h2,
        ],
        dir,
        envFor(delegated),
      );
      expect(secondRecord.code, secondRecord.out).toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(2);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-2'], dir);
      await git(['push', '-q'], dir);

      const round5 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round5.code, round5.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(5);

      // A third authorization must be bound to a real new source head, not
      // the prior authorization-only child that consumed R5.
      await writeFile(path.join(dir, 'fix-third.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix-third'], dir);
      await git(['push', '-q'], dir);
      const h3 = await head(dir);
      const thirdRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'third repository-composed grant',
          '--head',
          h3,
        ],
        dir,
        envFor(delegated),
      );
      expect(thirdRecord.code, thirdRecord.out).toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(3);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-3'], dir);
      await git(['push', '-q'], dir);

      const round6 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round6.code, round6.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(6);

      // A fourth authorization is likewise bound to an ordinary source
      // commit, never to the authorization-only child that consumed R6.
      await writeFile(path.join(dir, 'fix-fourth.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix-fourth'], dir);
      await git(['push', '-q'], dir);
      const h4 = await head(dir);
      const fourthRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'fourth repository-composed grant',
          '--head',
          h4,
        ],
        dir,
        envFor(delegated),
      );
      expect(fourthRecord.code, fourthRecord.out).toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(4);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-4'], dir);
      await git(['push', '-q'], dir);

      const round7 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round7.code, round7.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(7);

      // The fifth grant also starts from an ordinary source commit, never an
      // authorization-only child from the preceding delegated round.
      await writeFile(path.join(dir, 'fix-fifth.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'fix-fifth'], dir);
      await git(['push', '-q'], dir);
      const h5 = await head(dir);
      const fifthRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'fifth repository-composed grant',
          '--head',
          h5,
        ],
        dir,
        envFor(delegated),
      );
      expect(fifthRecord.code, fifthRecord.out).toBe(0);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(5);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization-5'], dir);
      await git(['push', '-q'], dir);

      const round8 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round8.code, round8.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(8);

      const h6 = await head(dir);
      const sixthRecord = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'sixth repository-composed grant',
          '--head',
          h6,
        ],
        dir,
        envFor(delegated),
      );
      expect(sixthRecord.code, sixthRecord.out).not.toBe(0);
      expect(sixthRecord.out).toMatch(/delegated gate-round budget is spent.*5 of 5/i);
      expect(await readDecisionLines(dir, 'RP-1')).toHaveLength(5);

      const round9 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(round9.code, round9.out).toBe(2);
      expect(round9.out).toMatch(/spent 8 gate rounds, the cap of 8/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(8);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});

// --- the consuming call's own commit and authority requirements -----------
//
// security-scanner, reproduced on 92edefbe: `authorizedRoundFor` read
// `.rig/decisions/*.jsonl` from the WORKING TREE, not HEAD's committed tree,
// and checked no authority of the consuming `--authorized` run at all. A
// record hand-written straight to disk — never through `record`, never
// committed, never journalled — was honoured, and so was a consuming run
// that declared no delegated authority whatsoever.
//
// The rules these tests pin: only a COMMITTED record
// counts, read from HEAD's own tree; and the consuming call must itself run
// under a journalled delegated authority (`RIG_RUN_DIR` set, `run-state.mjs
// authority delegated` declared) — the same authority check `record` already
// runs on its own side.
describe('gate-round --authorized refuses a bypass of the committed-record and consuming-authority rules (RP-442, security-scanner)', () => {
  it('refuses when a matching extra-gate-round line exists only in the WORKING TREE, never committed', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);

      // Hide `.rig/decisions/` from `git status` via a LOCAL, never-committed
      // exclude — so the generic dirty-tree check (`checkoutIsShippable`)
      // does not refuse first, and the refusal below is isolated to whether
      // the authorization itself is committed.
      await writeFile(path.join(dir, '.git', 'info', 'exclude'), '.rig/decisions/\n');

      // A well-formed `extra-gate-round` line, matching ticket/branch/head
      // exactly — written directly to disk, bypassing `record` entirely, and
      // never committed.
      await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
      await appendForgedDecisionLine(dir, 'RP-1', { branch: 'fix/a', head: h });

      const statusAfterExclude = await git(['status', '--porcelain'], dir);
      expect(statusAfterExclude, statusAfterExclude).toBe('');

      // Every OTHER check on the path passes: a declared delegated authority
      // for the consuming call itself.
      const runDir = await delegatedRunDir();

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/commit/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses a committed, otherwise-valid authorization when RIG_RUN_DIR is unset on the consuming call', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // RIG_RUN_DIR deliberately UNSET on the consuming `--authorized` call —
      // the only thing this test varies from the documented happy path.
      const result2 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(undefined),
      );
      expect(result2.code).not.toBe(0);
      expect(result2.out).toMatch(/RIG_RUN_DIR|authority/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  it('refuses a committed, otherwise-valid authorization when RIG_RUN_DIR is set but its journalled authority is owner, not delegated', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const delegated = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // The consuming call's OWN run directory declares owner authority, not
      // delegated — the only thing this test varies from the documented
      // happy path.
      const ownerRunDir = await newRunDir();
      roots.push(ownerRunDir);
      await declareAuthority(ownerRunDir, 'owner');

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(ownerRunDir),
      );
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/delegated|authority/i);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Control: the same committed, matching authorization, consumed by a call
  // that DOES run under a journalled delegated authority — exactly the
  // documented happy path, which none of the three refusals above may touch.
  it('grants the round for a committed authorization consumed under a journalled delegated authority', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);
      const delegated = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          h,
        ],
        dir,
        envFor(delegated),
      );
      expect(record.code, record.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization'], dir);
      await git(['push', '-q'], dir);

      // The one difference from the three refusals above: the consuming
      // call itself runs under the SAME delegated-authority run directory.
      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(delegated),
      );
      expect(result.code, result.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // The committed-record rule above is checked by reading HEAD's tree
  // through plain `git cat-file`/`ls-tree` (and `rev-list`/`diff-tree` for
  // the record-only chain) — every one of which honours a `git replace` ref
  // by default. An attacker never commits or pushes the authorization at
  // all: they stage the forged line into a REPLACEMENT commit object for
  // HEAD's own SHA (`commit-tree` off a copy of HEAD's tree plus the forged
  // file, same parent(s)), then `git replace <HEAD> <copy>` — a purely local
  // mapping that makes every "HEAD:…" read resolve to the forged tree while
  // HEAD and `@{u}` themselves (plain SHA values, never dereferenced through
  // replace) are untouched, and the real index/working tree already match
  // the forged tree (that is what was just staged), so `git status
  // --porcelain` has nothing to report either. No commit holding the record
  // exists anywhere, reachable or not — only the replace mapping does.
  it('refuses an extra-gate-round record that exists only behind a replace ref for HEAD, never in any commit (RP-442, security-scanner)', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const h = await head(dir);

      // Stage the forged record into the real index/working tree — the
      // replacement commit's tree is built FROM this staged state, so the
      // two already agree; nothing needs removing afterwards.
      await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
      await appendForgedDecisionLine(dir, 'RP-1', { branch: 'fix/a', head: h });
      await git(['add', '-A'], dir);
      const forgedTree = await git(['write-tree'], dir);
      const parentsRaw = await git(['log', '--pretty=%P', '-1', h], dir);
      const parentArgs = parentsRaw
        .split(' ')
        .filter(Boolean)
        .flatMap((p) => ['-p', p]);
      const replacement = await git(
        [
          'commit-tree',
          forgedTree,
          ...parentArgs,
          '-m',
          'forged — never reachable except via replace',
        ],
        dir,
      );
      await git(['replace', h, replacement], dir);

      // The dirty-tree check cannot be what refuses below: the checkout is
      // clean and HEAD/@{u} are exactly the pushed commit, unmoved.
      const statusAfterReplace = await git(['status', '--porcelain'], dir);
      expect(statusAfterReplace, statusAfterReplace).toBe('');
      expect(await git(['rev-parse', 'HEAD'], dir)).toBe(h);
      expect(await git(['rev-parse', '@{u}'], dir)).toBe(h);

      // Every OTHER check on the path passes: a declared delegated authority
      // for the consuming call itself — isolating the refusal to whether the
      // record is genuinely committed, not merely readable through a local
      // replace mapping.
      const runDir = await delegatedRunDir();
      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).not.toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // The size probe alone is not enough: when the committed file at HEAD is
  // real and small, just not authorizing (a `tracker-correction` line,
  // committed and pushed for real), the size probe sees that genuine blob and
  // raises nothing, so only a content read that honoured replace refs could
  // see the matching `extra-gate-round` line a replacement commit for HEAD's
  // own SHA carries. This pins that the content read does not.
  it('refuses a matching extra-gate-round line visible only through a replace ref, when the REAL committed file at HEAD holds an unrelated record (RP-442, security-scanner)', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      // A genuine, committed, pushed, non-authorizing record at this
      // ticket's path: `tracker-correction` is a delegable decision id, but
      // not `extra-gate-round`, so it is filtered out long before any
      // match/budget check runs.
      const correctionRunDir = await delegatedRunDir();
      const correction = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'tracker-correction',
          '--summary',
          'unrelated',
        ],
        dir,
        envFor(correctionRunDir),
      );
      expect(correction.code, correction.out).toBe(0);
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'tracker correction'], dir);
      await git(['push', '-q'], dir);

      const h = await head(dir);

      // Overwrite the SAME committed path's content, in the real
      // index/working tree, with a matching `extra-gate-round` line, then
      // bury it behind a replacement commit for HEAD's own SHA — the exact
      // technique from the previous test, this time over a real file rather
      // than an uncommitted one.
      const matching = {
        schemaVersion: 1,
        ticket: 'RP-1',
        release: null,
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary: 'forged — visible only through the replace ref',
        evidence: null,
        branch: 'fix/a',
        head: h,
        at: new Date().toISOString(),
      };
      await writeFile(decisionsFile(dir, 'RP-1'), `${JSON.stringify(matching)}\n`);
      await git(['add', '-A'], dir);
      const forgedTree = await git(['write-tree'], dir);
      const parentsRaw = await git(['log', '--pretty=%P', '-1', h], dir);
      const parentArgs = parentsRaw
        .split(' ')
        .filter(Boolean)
        .flatMap((p) => ['-p', p]);
      const replacement = await git(
        [
          'commit-tree',
          forgedTree,
          ...parentArgs,
          '-m',
          'forged — never reachable except via replace',
        ],
        dir,
      );
      await git(['replace', h, replacement], dir);

      // Same oracle as before: clean status, HEAD and @{u} both still the
      // real, pushed commit — the refusal below cannot be the dirty-tree or
      // unpushed-head check.
      const statusAfterReplace = await git(['status', '--porcelain'], dir);
      expect(statusAfterReplace, statusAfterReplace).toBe('');
      expect(await git(['rev-parse', 'HEAD'], dir)).toBe(h);
      expect(await git(['rev-parse', '@{u}'], dir)).toBe(h);

      const runDir = await delegatedRunDir();
      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).not.toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // diff-tree bypass (RP-442, security-scanner): `recordOnlyChain`'s own
  // `diff-tree` read is what decides whether a commit that also changes code
  // may be mistaken for one that changes only `.rig/decisions/` (pinned
  // above, "a commit that also changes code on top of the authorized head
  // does not match"). Without `--no-replace-objects` on that read, a `git
  // replace` ref for HEAD's own SHA can present a DIFFERENT commit object to
  // the diff — one whose tree is the authorized head's own tree plus only
  // the decisions blob the real commit carries, same parent — while HEAD,
  // `@{u}` and the real index/working tree stay exactly the real,
  // code-changing commit, unmoved and clean. The WALK itself (`rev-list`) is
  // a separate read with its own bypass, pinned below rather than here.
  it('refuses when the record-only chain is read through a replace ref that hides a real code change in the committed diff', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      const x = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          x,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);

      // R: the authorization AND a real code change, landed in one commit —
      // on an honest walk this is exactly the "also changes code" case
      // pinned above, and must never match.
      await writeFile(path.join(dir, 'code.txt'), 'x');
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'authorization and a fix'], dir);
      await git(['push', '-q'], dir);
      const r = await head(dir);

      // R': the commit a record-only landing of the SAME authorization would
      // have produced — X's own tree plus only the decisions blob R actually
      // carries, parent X. Built in a throwaway index; the real working tree
      // and index are untouched by this step.
      const decisionsBlobSha = await git(['rev-parse', `${r}:.rig/decisions/RP-1.jsonl`], dir);
      const tmpIndexDir = await mkdtemp(path.join(tmpdir(), 'delegated-rounds-index-'));
      roots.push(tmpIndexDir);
      const tmpIndex = path.join(tmpIndexDir, 'index');
      const indexEnv = { ...withoutGitLocation(), GIT_INDEX_FILE: tmpIndex };
      const plumb = async (args: string[]): Promise<string> => {
        const result = await run(
          'git',
          [
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.email=t@example.invalid',
            '-c',
            'user.name=t',
            ...args,
          ],
          dir,
          indexEnv,
        );
        if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
        return result.stdout.trim();
      };
      await plumb(['read-tree', x]);
      await plumb([
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${decisionsBlobSha},.rig/decisions/RP-1.jsonl`,
      ]);
      const replacementTree = await plumb(['write-tree']);
      const parentsRaw = await git(['log', '--pretty=%P', '-1', r], dir);
      const parentArgs = parentsRaw
        .split(' ')
        .filter(Boolean)
        .flatMap((p) => ['-p', p]);
      const replacement = await git(
        [
          'commit-tree',
          replacementTree,
          ...parentArgs,
          '-m',
          'forged record-only replacement, never reachable except via replace',
        ],
        dir,
      );
      await git(['replace', r, replacement], dir);

      // Hide R's real code change from the index/status view too, so the
      // refusal below cannot be the dirty-tree check: the real index is made
      // to agree with the REPLACED tree (no code.txt), and the file left on
      // disk is excluded locally.
      await git(['rm', '-q', '--cached', 'code.txt'], dir);
      await writeFile(path.join(dir, '.git', 'info', 'exclude'), 'code.txt\n');

      const statusAfterReplace = await git(['status', '--porcelain'], dir);
      expect(statusAfterReplace, statusAfterReplace).toBe('');
      expect(await git(['rev-parse', 'HEAD'], dir)).toBe(r);
      expect(await git(['rev-parse', '@{u}'], dir)).toBe(r);

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Walk-skip bypass via `rev-list` (RP-442, security-scanner): each commit
  // the chain visits already gets an honest `diff-tree` (`--no-replace-objects`
  // pinned above), but the WALK itself (`recordOnlyChain`'s own `rev-list
  // --first-parent`) still honours a `git replace` ref. Re-parenting the
  // record-only tip directly onto the authorized head — same tree, parent
  // changed only — makes a replace-honouring walk skip the intervening
  // code-changing commit entirely: the tip's own `diff-tree` still reads
  // honestly (against its REAL parent, since `diff-tree` already carries
  // `--no-replace-objects`) and still looks record-only on its own, but the
  // code-changing commit in between is never visited at all, so its change
  // is never checked.
  it('refuses when a replace ref re-parents the record-only tip onto the authorized head, skipping an intervening code-changing commit in the rev-list walk', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

      // X: the authorized head — a real, pre-existing commit, named by the
      // record's own `--head` field; it never itself carries the record.
      const x = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          x,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);

      // C: a commit on top of X that changes ONLY a code file — the
      // decisions file `record` just wrote stays uncommitted and unstaged
      // through this commit.
      await writeFile(path.join(dir, 'code.txt'), 'x');
      await git(['add', 'code.txt'], dir);
      await git(['commit', '-q', '-m', 'a fix, no authorization yet'], dir);

      // R: a commit on top of C that changes ONLY `.rig/decisions` — the
      // record-only landing of the authorization `record` wrote above.
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'record-only landing of the authorization'], dir);
      await git(['push', '-q'], dir);
      const r = await head(dir);

      // The replacement: R's own tree, unchanged — built through the same
      // throwaway-index `plumb` technique as the neighbouring test, never
      // touching the real index or working tree — but re-parented onto X
      // directly, skipping C. HEAD, `@{u}` and the real index/working tree
      // stay exactly the real R, unmoved and clean.
      const tmpIndexDir = await mkdtemp(path.join(tmpdir(), 'delegated-rounds-index-'));
      roots.push(tmpIndexDir);
      const tmpIndex = path.join(tmpIndexDir, 'index');
      const indexEnv = { ...withoutGitLocation(), GIT_INDEX_FILE: tmpIndex };
      const plumb = async (args: string[]): Promise<string> => {
        const result = await run(
          'git',
          [
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.email=t@example.invalid',
            '-c',
            'user.name=t',
            ...args,
          ],
          dir,
          indexEnv,
        );
        if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
        return result.stdout.trim();
      };
      await plumb(['read-tree', r]);
      const replacementTree = await plumb(['write-tree']);
      const replacement = await git(
        [
          'commit-tree',
          replacementTree,
          '-p',
          x,
          '-m',
          'forged — re-parented onto X, skipping C, never reachable except via replace',
        ],
        dir,
      );
      await git(['replace', r, replacement], dir);

      const statusAfterReplace = await git(['status', '--porcelain'], dir);
      expect(statusAfterReplace, statusAfterReplace).toBe('');
      expect(await git(['rev-parse', 'HEAD'], dir)).toBe(r);
      expect(await git(['rev-parse', '@{u}'], dir)).toBe(r);

      const result2 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result2.code, result2.out).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });

  // Budget undercount via `ls-tree` (RP-442, security-scanner): the "more
  // records than the budget" refusal (pinned above, "refuses --authorized
  // when the branch holds MORE extra-gate-round records than the budget")
  // depends on `committedDecisionTickets`'s own `ls-tree` enumerating EVERY
  // ticket file committed at HEAD. Without `--no-replace-objects` there, a
  // `git replace` ref for HEAD's own SHA can present a tree that is missing
  // one ticket's file — while every other read (the per-ticket `cat-file`,
  // the chain's `rev-list`/`diff-tree`) still sees the real, two-ticket
  // commit, and HEAD/`@{u}`/the working tree stay the real commit, unmoved
  // and clean.
  it('refuses a branch holding more extra-gate-round records than the budget even when ls-tree is fooled into enumerating only one ticket', async () => {
    const roots: string[] = [];
    try {
      const { dir } = await newPreparedBudgetTwoProject(roots);
      const cfg = await writeAndPushConfig(dir, { adapter: 'plan-md' }); // default budget 1

      const x = await head(dir);
      const runDir = await delegatedRunDir();
      const record = await runDelegated(
        [
          'record',
          '--ticket',
          'RP-1',
          '--decision',
          'extra-gate-round',
          '--summary',
          'ok',
          '--head',
          x,
        ],
        dir,
        envFor(runDir),
      );
      expect(record.code, record.out).toBe(0);

      // A second ticket's authorization, forged directly onto disk —
      // bypassing `record`'s own branch budget check entirely — so once both
      // land in the same commit, the branch genuinely holds TWO
      // extra-gate-round records, one more than the default budget of 1.
      await appendForgedDecisionLine(dir, 'RP-2', { branch: 'fix/a', head: x });
      await git(['add', '-A'], dir);
      await git(['commit', '-q', '-m', 'two authorizations'], dir);
      await git(['push', '-q'], dir);
      const r = await head(dir);

      // R': the real commit's own tree, minus the RP-2 ticket file alone —
      // same parent, built in a throwaway index that never touches the real
      // working tree or index.
      const tmpIndexDir = await mkdtemp(path.join(tmpdir(), 'delegated-rounds-index-'));
      roots.push(tmpIndexDir);
      const tmpIndex = path.join(tmpIndexDir, 'index');
      const indexEnv = { ...withoutGitLocation(), GIT_INDEX_FILE: tmpIndex };
      const plumb = async (args: string[]): Promise<string> => {
        const result = await run(
          'git',
          [
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.email=t@example.invalid',
            '-c',
            'user.name=t',
            ...args,
          ],
          dir,
          indexEnv,
        );
        if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
        return result.stdout.trim();
      };
      await plumb(['read-tree', r]);
      await plumb(['update-index', '--force-remove', '.rig/decisions/RP-2.jsonl']);
      const replacementTree = await plumb(['write-tree']);
      const parentsRaw = await git(['log', '--pretty=%P', '-1', r], dir);
      const parentArgs = parentsRaw
        .split(' ')
        .filter(Boolean)
        .flatMap((p) => ['-p', p]);
      const replacement = await git(
        [
          'commit-tree',
          replacementTree,
          ...parentArgs,
          '-m',
          'forged — hides RP-2 from a plain ls-tree, never reachable except via replace',
        ],
        dir,
      );
      await git(['replace', r, replacement], dir);

      // Hide RP-2's real file from the index/status view too: the real
      // index is made to agree with the REPLACED tree (no RP-2.jsonl), and
      // the file left on disk is excluded locally.
      await git(['rm', '-q', '--cached', path.join('.rig', 'decisions', 'RP-2.jsonl')], dir);
      await writeFile(path.join(dir, '.git', 'info', 'exclude'), '.rig/decisions/RP-2.jsonl\n');

      const statusAfterReplace = await git(['status', '--porcelain'], dir);
      expect(statusAfterReplace, statusAfterReplace).toBe('');
      expect(await git(['rev-parse', 'HEAD'], dir)).toBe(r);
      expect(await git(['rev-parse', '@{u}'], dir)).toBe(r);

      const result2 = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        envFor(runDir),
      );
      expect(result2.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(3);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});
