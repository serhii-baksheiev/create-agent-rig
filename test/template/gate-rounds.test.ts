import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR-69, the half that needs no verdict schema: a cap on gate rounds.
//
// Every other stop in `autonomy.md` has something red behind it. A gate that keeps
// finding fixable prose has nothing red at all, so three strikes never fires and a
// run has no reason to stop re-entering it. The count therefore lives on disk, and
// passing it is a refusal rather than a judgement by the session that has already
// sunk two rounds into shipping.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, '.claude/scripts/git-env.mjs')).href
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
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

/** A counts file in its own directory, so nothing here can touch the checkout. */
const roundsFile = async (contents?: unknown): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gate-rounds-'));
  const file = path.join(dir, 'gate-rounds.json');
  if (contents !== undefined) {
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return file;
};

describe('the count is on disk, so a fresh session cannot restart it', () => {
  it('reads no rounds before any gate has run', async () => {
    const { gateRoundsFor } = await load('gate-rounds.mjs');
    expect(gateRoundsFor({ roundsPath: await roundsFile(), branch: 'feat/x' })).toBe(0);
  });

  it('counts per branch, so two tasks in flight do not share a budget', async () => {
    const { recordGateRound, gateRoundsFor } = await load('gate-rounds.mjs');
    const roundsPath = await roundsFile();

    expect(recordGateRound({ roundsPath, branch: 'fix/a' }).rounds).toBe(1);
    expect(recordGateRound({ roundsPath, branch: 'fix/a' }).rounds).toBe(2);
    expect(recordGateRound({ roundsPath, branch: 'fix/b' }).rounds).toBe(1);

    expect(gateRoundsFor({ roundsPath, branch: 'fix/a' })).toBe(2);
    expect(gateRoundsFor({ roundsPath, branch: 'fix/b' })).toBe(1);
  });

  // 🔴 The failure a review round found in the version that kept the count in
  // `queue.state.json`: a forgiving reader plus a whole-file writer means an
  // unparseable file reads as `{}` and is then written back as a fresh snapshot —
  // silently, exit 0. There the lost field was `lastCompletedTier`, the permissive
  // value that lets a second elevated item straight through. The counter has its own
  // file now and refuses instead, because reading a broken counter as zero hands the
  // branch a full cap at the exact moment something is already wrong with it.
  it('refuses a counts file it cannot parse, rather than starting the count over', async () => {
    const { gateRoundsFor, recordGateRound } = await load('gate-rounds.mjs');
    for (const broken of ['{"fix/a": 2', 'null', '[1,2]', '"two"', '42']) {
      const roundsPath = await roundsFile(broken);
      expect(() => gateRoundsFor({ roundsPath, branch: 'fix/a' }), broken).toThrow(
        /cannot be read|not valid JSON/,
      );
      expect(() => recordGateRound({ roundsPath, branch: 'fix/a' }), broken).toThrow(
        /cannot be read|not valid JSON/,
      );
    }
  });

  // One bad entry is not one bad file: dropping the entry costs that branch a fresh
  // cap, while refusing would block every branch in the checkout.
  it('drops a single malformed entry and keeps the rest', async () => {
    const { gateRoundsFor } = await load('gate-rounds.mjs');
    const roundsPath = await roundsFile({ 'fix/a': 'many', 'fix/b': -1, 'fix/c': 2 });
    expect(gateRoundsFor({ roundsPath, branch: 'fix/a' })).toBe(0);
    expect(gateRoundsFor({ roundsPath, branch: 'fix/b' })).toBe(0);
    expect(gateRoundsFor({ roundsPath, branch: 'fix/c' })).toBe(2);
  });

  // 🔴 `git rev-parse --abbrev-ref HEAD` prints the literal `HEAD` on a detached
  // checkout — mid-rebase, after `gh pr checkout` of a fork, in CI. It is a
  // non-empty string, so an "is it a string" check accepts it and every task in the
  // directory shares one budget. A review round found exactly that hole under a
  // comment claiming it was closed.
  it('refuses the literal HEAD and an absent branch', async () => {
    const { recordGateRound } = await load('gate-rounds.mjs');
    const roundsPath = await roundsFile();
    expect(() => recordGateRound({ roundsPath, branch: 'HEAD' })).toThrow(/detached/);
    for (const bad of [undefined, null, '', '   ', 7]) {
      expect(() => recordGateRound({ roundsPath, branch: bad }), JSON.stringify(bad)).toThrow(
        /counted per branch/,
      );
    }
  });

  // 🔴 A branch named `__proto__` resolved to an inherited value rather than a count,
  // so the increment produced the string `"[object Object]1"` — and every numeric
  // comparison against the cap answers false, which is unlimited rounds. Silent.
  it('counts a branch named after an Object prototype key like any other', async () => {
    const { recordGateRound, gateRoundsFor } = await load('gate-rounds.mjs');
    const roundsPath = await roundsFile();
    for (const hostile of ['__proto__', 'constructor', 'toString']) {
      expect(recordGateRound({ roundsPath, branch: hostile }).rounds, hostile).toBe(1);
      expect(recordGateRound({ roundsPath, branch: hostile }).rounds, hostile).toBe(2);
      expect(gateRoundsFor({ roundsPath, branch: hostile }), hostile).toBe(2);
    }
    // and the file it wrote is readable as plain data, not as a prototype trick
    expect(JSON.parse(await readFile(roundsPath, 'utf8'))).toMatchObject({ constructor: 2 });
  });

  it('leaves no temp file behind, so the reader never meets a half-written one', async () => {
    const { recordGateRound } = await load('gate-rounds.mjs');
    const roundsPath = await roundsFile();
    recordGateRound({ roundsPath, branch: 'fix/a' });
    expect(await readdir(path.dirname(roundsPath))).toEqual(['gate-rounds.json']);
  });
});

describe('the verdict on a round count is pure, so the rule is one implementation', () => {
  it('passes up to the cap and refuses past it', async () => {
    const { gateRoundVerdict, DEFAULT_MAX_GATE_ROUNDS } = await load('core.mjs');
    expect(DEFAULT_MAX_GATE_ROUNDS).toBe(2);

    // `rounds` includes the round about to run, so a cap of 2 allows 1 and 2.
    expect(gateRoundVerdict(1).exceeded).toBe(false);
    expect(gateRoundVerdict(2).exceeded).toBe(false);
    expect(gateRoundVerdict(3).exceeded).toBe(true);
    expect(gateRoundVerdict(3).max).toBe(2);
  });

  it('takes the cap from the queue config when it names one', async () => {
    const { gateRoundVerdict } = await load('core.mjs');
    expect(gateRoundVerdict(4, 5).exceeded).toBe(false);
    expect(gateRoundVerdict(6, 5).exceeded).toBe(true);
  });

  it('refuses a cap that would block the first round', async () => {
    const { gateRoundVerdict } = await load('core.mjs');
    for (const bad of [0, -1, 'two', null, 1.5]) {
      expect(() => gateRoundVerdict(1, bad), JSON.stringify(bad)).toThrow(/maxGateRounds/);
    }
  });

  it('names the stop the loop escalates on, and keeps it out of the skip vocabulary', async () => {
    const { SKIP_CAUSES, gateRoundVerdict } = await load('core.mjs');
    expect(gateRoundVerdict(3).stop).toBe('documented-stall');
    // `SKIP_CAUSES` are reasons an item was passed over in selection; this ends a
    // task. One vocabulary for both makes every sentence about either one wrong.
    expect(SKIP_CAUSES).not.toContain('documented-stall');
  });
});

describe('the CLI is what pr-ship calls, so the two failures have different exit codes', () => {
  // 🔴 Every case passes `--config`. `projectRoot` comes from the SCRIPT's location,
  // not the cwd, so an earlier version of these tests that set `cwd` to a temp
  // directory silently counted rounds into this repository's own state — visible
  // only because a later case inherited six rounds from earlier ones.
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(queueDir, 'index.mjs'), ...args], {}, (e, out, err) => {
        resolve({
          code: e && typeof e.code === 'number' ? e.code : 0,
          stdout: String(out),
          stderr: String(err),
        });
      });
    });

  // A config at `<repo>/.claude/queue.json` inside a committed, pushed temp
  // repository: since AR-141 the command refuses to count on a checkout that
  // cannot ship, and it finds that checkout from the config's root.
  const gitIn = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        // Sanitised: a hook-exported GIT_DIR would aim this at the shared repo (AR-148).
        ...withoutGitLocation(),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();

  const repo = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gate-cli-'));
    const remote = await mkdtemp(path.join(tmpdir(), 'gate-remote-'));
    gitIn(remote, ['init', '--bare', '-q']);
    gitIn(dir, ['init', '-q', '-b', 'main']);
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, '.gitignore'),
      '.claude/*.gate-rounds.json\n.claude/queue.state.json\n',
    );
    await writeFile(path.join(dir, 'README.md'), 'x\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'init']);
    gitIn(dir, ['remote', 'add', 'origin', remote]);
    gitIn(dir, ['push', '-q', '-u', 'origin', 'main']);
    return dir;
  };

  const config = async (contents: unknown = { adapter: 'plan-md' }): Promise<string> => {
    const dir = await repo();
    const file = path.join(dir, '.claude', 'queue.json');
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'config']);
    gitIn(dir, ['push', '-q']);
    return file;
  };

  // AR-141: a round names a head; a head that is not committed and pushed is
  // not one the reviewers or CI will ever see.
  describe('refuses to count on a checkout that cannot ship', () => {
    const countsFile = (cfg: string) => cfg.replace(/(\.json)?$/, '.gate-rounds.json');

    it('refuses to count a round on a dirty tree, and counts nothing', async () => {
      const cfg = await config();
      await writeFile(path.join(path.dirname(cfg), '..', 'scratch.txt'), 'uncommitted');
      const result = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/working tree is dirty/);
      expect(result.stderr).toMatch(/nothing was counted/);
      expect(result.stderr).toMatch(/NOT an exhausted cap/);
      expect(existsSync(countsFile(cfg))).toBe(false);
    });

    it('refuses to count a round on a HEAD its upstream has not seen', async () => {
      const cfg = await config();
      const dir = path.join(path.dirname(cfg), '..');
      await writeFile(path.join(dir, 'more.txt'), 'x');
      gitIn(dir, ['add', '-A']);
      gitIn(dir, ['commit', '-q', '-m', 'unpushed']);
      const result = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/1 commit\(s\) ahead of its upstream/);
      expect(existsSync(countsFile(cfg))).toBe(false);
    });

    it('refuses to count a round on a branch with no upstream', async () => {
      const cfg = await config();
      const dir = path.join(path.dirname(cfg), '..');
      gitIn(dir, ['checkout', '-q', '-b', 'fix/a']);
      const result = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/no upstream/);
      expect(existsSync(countsFile(cfg))).toBe(false);
    });

    it('counts once the branch is committed and pushed', async () => {
      const cfg = await config();
      const dir = path.join(path.dirname(cfg), '..');
      gitIn(dir, ['checkout', '-q', '-b', 'fix/a']);
      gitIn(dir, ['push', '-q', '-u', 'origin', 'fix/a']);
      const result = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/round 1 of 2/);
    });
  });

  it('counts a round and exits 0 while inside the cap', async () => {
    const cfg = await config();
    const first = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/round 1 of 2/);

    const second = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/round 2 of 2/);
    expect(second.stdout).toMatch(/last round this branch gets/);
  });

  // 🔴 Exit 2 is pinned as a NUMBER, not as "non-zero". `pr-ship` ends the task on
  // it, so collapsing it with exit 1 makes a broken config escalate a healthy item —
  // which is what the first version of this skill's prose told the reader to do.
  it('exits 2 — and only 2 — when the rounds are spent', async () => {
    const cfg = await config();
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);

    const third = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(third.code).toBe(2);
    expect(third.stderr).toMatch(/GATE ROUNDS EXHAUSTED/);
    expect(third.stderr).toMatch(/documented-stall/);
  });

  // AR-115: the refusal states the cap, not a verdict on convergence. On one branch
  // the blockers went 8 -> 3 -> 8 and the granted third round found that round 2's
  // fix had opened the mirror of the bug it closed — a message asserting "the fixes
  // are not converging" argued against the round that paid, having measured nothing.
  it('states the round count and the cap, and passes no judgement on convergence', async () => {
    const cfg = await config();
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);

    const third = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(third.code).toBe(2);
    expect(third.stderr).toMatch(/3 rounds on fix\/a, cap is 2/);
    expect(third.stderr).not.toMatch(/converg/i);
    expect(third.stderr).not.toMatch(/thrash/i);
    expect(third.stderr).toMatch(/this command measured only the count/);
  });

  it('exits 1 on its own failures, and says it is not an exhausted cap', async () => {
    const broken = await run(['gate-round', '--branch', 'fix/a', '--config', await config('{')]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toMatch(/NOT an exhausted cap/);

    const badCap = await run([
      'gate-round',
      '--branch',
      'fix/a',
      '--config',
      await config({ adapter: 'plan-md', options: { maxGateRounds: 0 } }),
    ]);
    expect(badCap.code).toBe(1);
    expect(badCap.stderr).toMatch(/maxGateRounds/);

    const detached = await run(['gate-round', '--branch', 'HEAD', '--config', await config()]);
    expect(detached.code).toBe(1);
    expect(detached.stderr).toMatch(/detached/);

    const noBranch = await run(['gate-round', '--config', await config()]);
    expect(noBranch.code).toBe(1);
    expect(noBranch.stderr).toMatch(/counted per branch/);
  });

  it('takes maxGateRounds from the queue config', async () => {
    const cfg = await config({ adapter: 'plan-md', options: { maxGateRounds: 1 } });
    const first = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/round 1 of 1/);
    expect((await run(['gate-round', '--branch', 'fix/a', '--config', cfg])).code).toBe(2);
  });

  // 🔴 The counter must not be able to damage the ration, which is why it has its own
  // file. This is the assertion that keeps it there: a round leaves
  // `queue.state.json` untouched, so no number of gate rounds can lose the tier that
  // spaces elevated work.
  it('never writes the queue state file', async () => {
    const cfg = await config();
    const statePath = cfg.replace(/queue\.json$/, 'queue.state.json');
    await writeFile(statePath, JSON.stringify({ lastCompletedTier: 'elevated-mechanism' }));

    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);

    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      lastCompletedTier: 'elevated-mechanism',
    });
  });

  it('counts without reaching the tracker, so an outage cannot grant free rounds', async () => {
    // `jira` needs credentials and network, so every other command fails here. This
    // one must not care: a tracker outage that stopped the counter would hand the run
    // unlimited rounds.
    const cfg = await config({ adapter: 'jira', options: { project: 'NOPE' } });
    const result = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/round 1 of 2/);
  });

  it('lists the command, so the unknown-command message stays honest', async () => {
    const { COMMANDS } = await load('index.mjs');
    expect(COMMANDS).toContain('gate-round');
  });
});
