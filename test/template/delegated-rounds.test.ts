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
      const { dir } = await newPushedProject(roots);
      const cfg = await writeAndPushConfig(dir, {
        adapter: 'plan-md',
        options: { maxDelegatedRounds: 2 },
      });
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
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
        withoutGitLocation(),
      );
      expect(furtherAuthorized.code).toBe(2);
      expect(await roundsFor(cfg, 'fix/a')).toBe(4);
    } finally {
      await Promise.all(roots.map((root) => removeFixture(root)));
    }
  });
});
