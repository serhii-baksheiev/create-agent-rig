import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR-69, the half that needs no verdict schema: a mechanical cap on gate rounds.
//
// The measured problem, from the journal: gate rounds per item in the last five
// single-item runs were 5, 4, 2, 7, 8. Nothing bounded them — `autonomy.md`'s
// three-strikes rule counts red CHECK runs, and every check was green, so a PR can
// loop through `pr-ship` indefinitely while the suite passes. The `budget` stop
// fired "later than it should have" by its own entry.
//
// So the count becomes state, and passing it becomes a refusal rather than a
// judgement call by the session that is already invested in shipping.

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

const stateFile = async (contents?: unknown): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gate-rounds-'));
  const file = path.join(dir, 'queue.state.json');
  if (contents !== undefined) await writeFile(file, `${JSON.stringify(contents, null, 2)}\n`);
  return file;
};

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

describe('the round cap is a count on disk, so a fresh session cannot restart it', () => {
  it('reads no rounds at all before any gate has run', async () => {
    const { gateRoundsFor } = await load('state.mjs');
    // An absent file is "no rounds yet", never an error: the first `pr-ship` on a
    // branch runs before anything has written state.
    expect(gateRoundsFor({ statePath: await stateFile(), branch: 'feat/x' })).toBe(0);
    expect(
      gateRoundsFor({ statePath: await stateFile({ lastCompletedTier: 'normal' }), branch: 'x' }),
    ).toBe(0);
  });

  it('counts per branch, so two tasks in flight do not share a budget', async () => {
    const { recordGateRound, gateRoundsFor } = await load('state.mjs');
    const statePath = await stateFile();

    expect(recordGateRound({ statePath, branch: 'fix/a' }).rounds).toBe(1);
    expect(recordGateRound({ statePath, branch: 'fix/a' }).rounds).toBe(2);
    expect(recordGateRound({ statePath, branch: 'fix/b' }).rounds).toBe(1);

    expect(gateRoundsFor({ statePath, branch: 'fix/a' })).toBe(2);
    expect(gateRoundsFor({ statePath, branch: 'fix/b' })).toBe(1);
  });

  // 🔴 The premise this ticket got wrong, and it would have deleted the counter on
  // the first close. `recordCompletedTier` writes `queue.state.json` with a
  // whole-file `writeFileSync` and its own comment says it "owns its file
  // outright". Adding a second field to that file therefore only works if BOTH
  // writers merge — a fact no test covered, because until now there was one field.
  it('keeps the rounds when a close writes the tier, and the tier when a round is recorded', async () => {
    const { recordGateRound } = await load('state.mjs');
    const statePath = await stateFile({ lastCompletedTier: 'elevated-mechanism' });

    recordGateRound({ statePath, branch: 'fix/a' });
    expect((await readJson(statePath)).lastCompletedTier).toBe('elevated-mechanism');

    const { recordCompletedTier } = await load('state.mjs');
    recordCompletedTier({
      changedFiles: ['docs/decisions/x.md'],
      projectRoot: repoRoot,
      statePath,
    });

    const after = await readJson(statePath);
    expect(after.lastCompletedTier).toBe('elevated-prose');
    expect(after.gateRounds, 'a close must not reset a branch that is still in gate').toEqual({
      'fix/a': 1,
    });
  });

  it('survives a state file whose gateRounds is the wrong shape, rather than throwing', async () => {
    const { gateRoundsFor, recordGateRound } = await load('state.mjs');
    // Same reasoning `readState` already applies to the tier: syntax is not shape,
    // and a malformed counter must read as "no rounds" rather than crash the gate.
    for (const bad of [null, 42, 'two', ['fix/a'], { 'fix/a': 'many' }, { 'fix/a': -1 }]) {
      const statePath = await stateFile({ gateRounds: bad });
      expect(gateRoundsFor({ statePath, branch: 'fix/a' }), JSON.stringify(bad)).toBe(0);
      expect(recordGateRound({ statePath, branch: 'fix/a' }).rounds, JSON.stringify(bad)).toBe(1);
    }
  });
});

describe('the verdict on a round count is pure, so the rule is one implementation', () => {
  it('passes up to the cap and refuses past it', async () => {
    const { gateRoundVerdict, DEFAULT_MAX_GATE_ROUNDS } = await load('core.mjs');
    expect(DEFAULT_MAX_GATE_ROUNDS).toBe(2);

    // The cap counts rounds ALREADY recorded including this one, so round 2 is the
    // last one allowed and round 3 is the refusal.
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

  // A cap of 0 would refuse the FIRST gate, which is a configuration that turns
  // the gate off rather than bounding it — the opposite of this ticket.
  it('refuses a cap that would block the first round', async () => {
    const { gateRoundVerdict } = await load('core.mjs');
    for (const bad of [0, -1, 'two', null, 1.5]) {
      expect(() => gateRoundVerdict(1, bad), JSON.stringify(bad)).toThrow(/maxGateRounds/);
    }
  });

  it('names the stop kind the loop escalates on, from the closed vocabulary', async () => {
    const { SKIP_CAUSES, gateRoundVerdict } = await load('core.mjs');
    // `documented-stall` is the escalation this ticket asks for. It is a STOP, not
    // a selection filter, so it must not silently join the skip vocabulary.
    expect(gateRoundVerdict(3).stop).toBe('documented-stall');
    expect(SKIP_CAUSES).not.toContain('documented-stall');
  });
});

describe('the CLI is what pr-ship calls, so the refusal is an exit code', () => {
  // 🔴 Every case passes `--config`, and that is not tidiness — the first version
  // of these tests set `cwd` to a temp directory and asserted from there, which
  // does nothing: `projectRoot` is derived from the SCRIPT's own location, so the
  // runs counted into this repository's real `.claude/queue.state.json` and read
  // this repository's real config. The failure was visible only because a later
  // case inherited six rounds from earlier ones. A test that writes to the
  // checkout it is running in is a defect even when it passes.
  //
  // `--config` is the documented pairing: the state file travels with the config
  // (`statePathFor`), so a temp config keeps a temp counter.
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(queueDir, 'index.mjs'), ...args],
        {},
        (error, stdout, stderr) => {
          resolve({
            code: error && typeof error.code === 'number' ? error.code : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });

  /** A queue config in its own directory, so its state file is its own too. */
  const config = async (options: Record<string, unknown> = {}): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gate-cli-'));
    const file = path.join(dir, 'queue.json');
    await writeFile(file, `${JSON.stringify({ adapter: 'plan-md', options }, null, 2)}\n`);
    return file;
  };

  it('counts a round, prints it, and exits 0 while inside the cap', async () => {
    const cfg = await config();
    const first = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/round 1 of 2/);

    const second = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/round 2 of 2/);
    // The last allowed round says so, so the author is not surprised by the refusal.
    expect(second.stdout).toMatch(/last round this branch gets/);
  });

  // 🔴 The whole point: the third round is refused by the tool, not by the
  // judgement of a session that has already sunk two rounds into shipping.
  it('refuses the round past the cap with a non-zero exit and names the stop', async () => {
    const cfg = await config();
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);

    const third = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(third.code).not.toBe(0);
    expect(third.stderr).toMatch(/documented-stall/);
    expect(third.stderr).toMatch(/escalate/i);
  });

  it('takes maxGateRounds from the queue config', async () => {
    const cfg = await config({ maxGateRounds: 1 });
    const first = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/round 1 of 1/);

    const second = await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    expect(second.code).not.toBe(0);
  });

  it('counts per branch through the CLI too', async () => {
    const cfg = await config();
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    await run(['gate-round', '--branch', 'fix/a', '--config', cfg]);
    // A second branch sharing the checkout starts at one, not at three.
    const other = await run(['gate-round', '--branch', 'fix/b', '--config', cfg]);
    expect(other.code, other.stderr).toBe(0);
    expect(other.stdout).toMatch(/round 1 of 2/);
  });

  it('refuses without a branch rather than sharing one counter', async () => {
    const cfg = await config();
    const result = await run(['gate-round', '--config', cfg]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/branch/);
  });

  it('lists the command, so an unknown command message stays honest', async () => {
    const { COMMANDS } = await load('index.mjs');
    expect(COMMANDS).toContain('gate-round');
  });
});
