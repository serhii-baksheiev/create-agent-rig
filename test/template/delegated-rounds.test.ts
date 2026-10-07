// RP-442: bounded delegated gate rounds.
//
// Builds on RP-340 (`delegated-decision.mjs`, see `delegated-decision.test.ts`)
// and RP-341/RP-342 (`queue/stop-class.mjs`, see `stop-class.test.ts` —
// `gate-round-cap` now names the delegable `extra-gate-round` decision).
//
// This file pins the new, still-unimplemented design:
//
//   - `options.maxDelegatedRounds` in the queue config: default 1 when
//     absent; a non-negative integer; anything else refused (exit 1,
//     nothing counted). `options.maxGateRounds` (the base cap, default 3)
//     is unaffected.
//   - `delegated-decision.mjs record --decision extra-gate-round` now
//     REQUIRES `--head <sha>`: refused (nothing written) when it is
//     missing, when it differs from the checkout's actual HEAD, or on a
//     detached checkout. It also refuses once `.rig/decisions/<ticket>.jsonl`
//     already holds `maxDelegatedRounds` `extra-gate-round` records for the
//     same ticket and branch. Every other decision id is unaffected — no
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
// Every expected literal below (exit codes, file counts, the stored record's
// own fields) is declared by this file, independently of the production
// modules under test (`.claude/rules/invariants.md`, the independent-oracle
// rule) — never by calling the thing being tested and comparing it to
// itself.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
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

const runGateRound = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  run(process.execPath, [queueIndexScript, 'gate-round', ...args], cwd, env);

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
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

const head = (cwd: string) => git(['rev-parse', 'HEAD'], cwd);

/** `RIG_RUN_DIR` set ONLY for this one spawn — never on `process.env`. */
const envFor = (runDir: string | undefined): NodeJS.ProcessEnv => {
  const env = withoutGitLocation();
  if (runDir !== undefined) env.RIG_RUN_DIR = runDir;
  else delete env.RIG_RUN_DIR;
  return env;
};

const writeRunState = (runDir: string, state: Record<string, unknown>) =>
  writeFile(path.join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'delegated-rounds-run-'));

/** A delegated-authority run directory, ready for `record`. */
const delegatedRunDir = async (): Promise<string> => {
  const runDir = await newRunDir();
  await writeRunState(runDir, { decisionAuthority: 'delegated' });
  return runDir;
};

/** A fresh git project with a bare remote, on `main` — the same shape
 * `gate-round`'s own AR-141 `checkoutIsShippable` requires. */
const newPushedProject = async (roots?: string[]): Promise<{ dir: string }> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'delegated-rounds-repo-')));
  roots?.push(dir);
  const remote = await mkdtemp(path.join(tmpdir(), 'delegated-rounds-remote-'));
  roots?.push(remote);
  await git(['init', '--bare', '-q'], remote);
  await git(['init', '-q', '-b', 'main'], dir);
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(
    path.join(dir, '.gitignore'),
    '.claude/*.gate-rounds.json\n.claude/queue.state.json\n.claude/runs/\n',
  );
  await writeFile(path.join(dir, 'README.md'), 'x\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);
  await git(['remote', 'add', 'origin', remote], dir);
  await git(['push', '-q', '-u', 'origin', 'main'], dir);
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
    const result = await runGateRound(
      ['--branch', branch, '--config', cfg],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(0);
  }
};

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
      // Today's existing behaviour (pinned in gate-rounds.test.ts) always
      // records the attempt before computing the verdict, even a doomed
      // one — unaffected by `--ticket` being present with no `--authorized`.
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
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

      const result = await runGateRound(
        ['--branch', 'fix/a', '--ticket', 'RP-1', '--authorized', '--config', cfg],
        dir,
        withoutGitLocation(),
      );
      expect(result.code).toBe(2);
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
      );
      expect(firstAuthorized.code, firstAuthorized.out).toBe(0);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);

      // The reviewer fan-out's own verdict, at the head the RECORD itself
      // names (`h`) rather than the record-only commit's own head — still
      // inside the chain `authorizedRoundFor` covers. Written into a run
      // directory under THIS checkout's own `.claude/runs/`, since
      // gate-round is not told RIG_RUN_DIR here.
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
        withoutGitLocation(),
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
        withoutGitLocation(),
      );
      expect(firstAuthorized.code, firstAuthorized.out).toBe(0);

      // This time the verdict is recorded at the RECORD-ONLY COMMIT's own
      // head (not the head the record names) — the other end of the chain
      // `authorizedRoundFor` covers, and still consumption.
      const reviewRunDir = await newRunDir();
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, {
        adapter: 'plan-md',
        options: { maxDelegatedRounds: 2 },
      });
      await branchAndPush(dir, 'fix/a');
      await exhaustBaseCap(dir, 'fix/a', cfg);

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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
      );
      expect(result.code, result.out).toBe(0);
      expect(await roundsFor(cloneCfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});
