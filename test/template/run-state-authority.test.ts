// RP-340: a delegated owner-gated decision has to survive compaction, session
// replacement and cold-start resume without depending on conversational
// memory. The first half of that contract is knowing WHICH authority mode a
// run is operating under right now — `run-state.mjs` already carries the
// per-run facts a stop condition needs (`lastDeployVerdict`, `budgetExhausted`,
// `triggersFired`…); this file pins the fourth: a new `authority` CLI command
// that records `decisionAuthority` into the SAME `state.json` the deploy and
// budget commands already write, read back by `readState(runDir)
// .decisionAuthority` — so `delegated-decision.mjs` (RP-340, a separate file)
// has somewhere durable to ask "is this run actually delegated" instead of
// trusting its own turn's memory of a conversation nobody can replay.
//
// `run-state.mjs` has no `authority` command yet — every test below is
// expected to fail because the CLI does not recognise the word, not because
// of a typo in the test. The command this file assumes:
//
//   RIG_RUN_DIR=<dir> node run-state.mjs authority owner|delegated
//
// writing `{ decisionAuthority: "owner" | "delegated" }` into `state.json`,
// case-normalised to LOWER CASE — the opposite direction from the existing
// `deploy`/`budget` words (`REGRESSION`/`HEALTHY`/`EXHAUSTED`, upper case),
// because the vocabulary it mirrors — `lib/authority.mjs`'s
// `DECISION_AUTHORITIES` (`'owner'`/`'delegated'`) — is itself lower case, and
// storing anything else would make `readState(runDir).decisionAuthority` need
// its own case fold before `authority.mjs`'s own `parseDecisionAuthority`
// could read it back.
//
// The independent oracle (`invariants.md`): the expected vocabulary
// (`owner`/`delegated`) is typed out by hand below, not imported from
// `lib/authority.mjs`'s `DECISION_AUTHORITIES` — so this test cannot be
// satisfied merely by the CLI and the contract module agreeing with each
// other while both drift from what RP-339 actually named.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const runStateScript = scriptPath('run-state.mjs');

const { withoutGitLocation } = (await import(pathToFileURL(scriptPath('git-env.mjs')).href)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

type RunResult = { code: number; stdout: string; stderr: string; out: string };

const runCli = (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(process.execPath, [runStateScript, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

/** A fresh run directory, never shared between tests and never exported globally. */
const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'run-state-authority-'));

/** `RIG_RUN_DIR` is set ONLY for this one spawn — never on `process.env`. */
const envFor = (runDir: string | undefined): NodeJS.ProcessEnv => {
  const env = withoutGitLocation();
  if (runDir !== undefined) env.RIG_RUN_DIR = runDir;
  else delete env.RIG_RUN_DIR;
  return env;
};

const stateOf = async (runDir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8')) as Record<string, unknown>;

const stateFileExists = async (runDir: string): Promise<boolean> => {
  try {
    await readFile(path.join(runDir, 'state.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
};

describe('run-state.mjs — the `authority` command (RP-340)', () => {
  it('writes decisionAuthority: "delegated" and prints the confirmation line', async () => {
    const runDir = await newRunDir();
    const result = await runCli(['authority', 'delegated'], repoRoot, envFor(runDir));

    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toBe('run state: decisionAuthority = "delegated"\n');
    expect(await stateOf(runDir)).toMatchObject({ decisionAuthority: 'delegated' });
  });

  it('writes decisionAuthority: "owner" and prints the confirmation line', async () => {
    const runDir = await newRunDir();
    const result = await runCli(['authority', 'owner'], repoRoot, envFor(runDir));

    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toBe('run state: decisionAuthority = "owner"\n');
    expect(await stateOf(runDir)).toMatchObject({ decisionAuthority: 'owner' });
  });

  it('case-normalises the word to LOWER case — the opposite direction from deploy/budget', async () => {
    const runDir = await newRunDir();
    const result = await runCli(['authority', 'DELEGATED'], repoRoot, envFor(runDir));

    expect(result.code, result.out).toBe(0);
    expect(await stateOf(runDir)).toMatchObject({ decisionAuthority: 'delegated' });
  });

  it('mixed case normalises the same way', async () => {
    const runDir = await newRunDir();
    const result = await runCli(['authority', 'Owner'], repoRoot, envFor(runDir));

    expect(result.code, result.out).toBe(0);
    expect(await stateOf(runDir)).toMatchObject({ decisionAuthority: 'owner' });
  });

  // --- refusals: exit 1, nothing written, the message names the two words ---

  const BAD_WORDS = ['yes', 'controller', ''];

  it.each(BAD_WORDS)(
    'refuses the word %j, naming owner and delegated, and writes nothing',
    async (word) => {
      const runDir = await newRunDir();
      const args = word === '' ? ['authority', ''] : ['authority', word];
      const result = await runCli(args, repoRoot, envFor(runDir));

      expect(result.code, result.out).not.toBe(0);
      expect(result.out).toMatch(/owner/i);
      expect(result.out).toMatch(/delegated/i);
      expect(await stateFileExists(runDir)).toBe(false);
    },
  );

  it('refuses with no word at all, and writes nothing', async () => {
    const runDir = await newRunDir();
    const result = await runCli(['authority'], repoRoot, envFor(runDir));

    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/owner/i);
    expect(result.out).toMatch(/delegated/i);
    expect(await stateFileExists(runDir)).toBe(false);
  });

  it('a refused word leaves a PRIOR recorded authority untouched', async () => {
    const runDir = await newRunDir();
    await runCli(['authority', 'delegated'], repoRoot, envFor(runDir));

    const result = await runCli(['authority', 'controller'], repoRoot, envFor(runDir));

    expect(result.code, result.out).not.toBe(0);
    expect(await stateOf(runDir)).toMatchObject({ decisionAuthority: 'delegated' });
  });

  it('refuses with no RIG_RUN_DIR declared, naming the variable', async () => {
    const result = await runCli(['authority', 'delegated'], repoRoot, envFor(undefined));

    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/RIG_RUN_DIR/);
  });

  // --- existing deploy/budget/trigger behaviour is unchanged -----------------

  it('the existing deploy command still normalises to UPPER case, unaffected by the new command', async () => {
    const runDir = await newRunDir();
    const result = await runCli(['deploy', 'healthy'], repoRoot, envFor(runDir));

    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toBe('run state: lastDeployVerdict = "HEALTHY"\n');
    expect(await stateOf(runDir)).toMatchObject({ lastDeployVerdict: 'HEALTHY' });
  });

  // --- the read side: readState(runDir).decisionAuthority ---------------------

  it('readState(runDir).decisionAuthority reads back exactly what the CLI wrote', async () => {
    const runDir = await newRunDir();
    await runCli(['authority', 'delegated'], repoRoot, envFor(runDir));

    const { readState } = (await import(pathToFileURL(runStateScript).href)) as {
      readState: (runDir: string) => { decisionAuthority?: string };
    };
    expect(readState(runDir).decisionAuthority).toBe('delegated');
  });

  it('readState(runDir).decisionAuthority is absent (never defaulted here) for a run that never declared it', async () => {
    const runDir = await newRunDir();
    await runCli(['deploy', 'HEALTHY'], repoRoot, envFor(runDir));

    const { readState } = (await import(pathToFileURL(runStateScript).href)) as {
      readState: (runDir: string) => { decisionAuthority?: string };
    };
    expect(readState(runDir).decisionAuthority).toBeUndefined();
  });
});
