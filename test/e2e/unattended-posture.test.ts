import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * RP-283 — acceptance of the 1.4 unattended posture contract on a generated
 * workflow-layer rig: preflight (the installed `.claude/scripts/preflight.mjs`)
 * and `create-agent-rig doctor` (the built CLI) are run the way an operator
 * runs them, against the scenario matrix the item names. Every flag and brake
 * file is written under a fake HOME, never the real one. Expected outcomes are
 * written out by hand.
 */

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

type PreflightCheck = { ok: boolean | string; id: string; outcome: string; detail: string };
type Preflight = {
  verdict: string;
  checks: Record<string, PreflightCheck>;
  uncheckedConditions: { id: string; outcome: string }[];
};
type DoctorCondition = { id: string; outcome: string; status: string };
type Doctor = { status: string; unattended: { status: string; conditions: DoctorCondition[] } };

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-unattended-e2e-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-unattended-e2e-home-'));
  await exec('git', ['init', '-q', repo], { env: gitEnv() });
  await exec(process.execPath, [cliBin, 'init', '--layer', 'workflow'], { cwd: repo });
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

const env = (): NodeJS.ProcessEnv => ({ ...gitEnv(), HOME: home, USERPROFILE: home });

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(process.execPath, args, { cwd: repo, env: env() });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '' };
  }
}

async function preflight(): Promise<Preflight> {
  const result = await run([path.join(repo, '.claude', 'scripts', 'preflight.mjs'), '--json']);
  return JSON.parse(result.stdout) as Preflight;
}

async function doctor(): Promise<Doctor & { code: number }> {
  const result = await run([cliBin, 'doctor', '--json']);
  return { ...(JSON.parse(result.stdout) as Doctor), code: result.code };
}

async function projectName(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
  ) as { project: { name: string } };
  return manifest.project.name;
}

const doctorOutcome = (body: Doctor, id: string): string | undefined =>
  body.unattended.conditions.find((c) => c.id === id)?.outcome;

describe('the unattended posture on a generated workflow rig (RP-283 acceptance)', () => {
  it('a clean supported configuration: no required condition fails on either surface', async () => {
    const pre = await preflight();
    expect(pre.verdict).not.toBe('STOP');
    for (const check of Object.values(pre.checks)) {
      expect(check.outcome, check.id).not.toBe('fail');
    }
    const doc = await doctor();
    expect(doc.code).toBe(0);
    expect(doc.unattended.conditions.filter((c) => c.status === 'fail')).toEqual([]);
    expect(doctorOutcome(doc, 'workflow-layer-missing')).toBe('pass');
  }, 120_000);

  it('the kill switch armed: preflight stops and doctor fails it, consistently', async () => {
    const name = await projectName();
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', `${name}-loop-STOP`), '');

    const pre = await preflight();
    expect(pre.verdict).toBe('STOP');
    expect(pre.checks.killSwitch).toMatchObject({ id: 'kill-switch-armed', outcome: 'fail' });

    const doc = await doctor();
    expect(doctorOutcome(doc, 'kill-switch-armed')).toBe('fail');
  }, 120_000);

  it('an invalid or missing detection contract: preflight stops and doctor fails it, consistently', async () => {
    const contractPath = path.join(repo, '.rig', 'revalidation.json');

    await writeFile(contractPath, '{ not json');
    let pre = await preflight();
    expect(pre.verdict).toBe('STOP');
    expect(pre.checks.detectionContract?.outcome).toBe('fail');
    expect(pre.checks.detectionContract?.id).toBe('detection-contract-invalid');
    let doc = await doctor();
    expect(doctorOutcome(doc, 'detection-contract-invalid')).toBe('fail');

    await rm(contractPath);
    pre = await preflight();
    expect(pre.verdict).toBe('STOP');
    expect(pre.checks.detectionContract?.outcome).toBe('fail');
    expect(pre.checks.detectionContract?.id).toBe('detection-contract-invalid');
    doc = await doctor();
    expect(doctorOutcome(doc, 'detection-contract-invalid')).toBe('fail');
  }, 120_000);

  it('an unattended flag left for this checkout stops preflight; one scoped to another checkout does not', async () => {
    const { unattendedFlags } = (await import(
      pathToFileURL(path.join(repo, '.claude', 'scripts', 'unattended-flag.mjs')).href
    )) as { unattendedFlags: (env: NodeJS.ProcessEnv) => string[] };
    const flagContent = `${JSON.stringify({ item: 'RP-0', allow: [] })}\n`;

    const otherRoot = await mkdtemp(path.join(tmpdir(), 'caf-unattended-e2e-other-'));
    try {
      const otherFlagPath = unattendedFlags({
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_PROJECT_DIR: otherRoot,
      })[0];
      if (otherFlagPath === undefined)
        throw new Error('no flag path resolved for the other checkout');
      await mkdir(path.dirname(otherFlagPath), { recursive: true });
      await writeFile(otherFlagPath, flagContent);

      let pre = await preflight();
      expect(pre.checks.unattendedFlag?.outcome).toBe('pass');

      const repoFlagPath = unattendedFlags({
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_PROJECT_DIR: repo,
      })[0];
      if (repoFlagPath === undefined) throw new Error('no flag path resolved for this checkout');
      await mkdir(path.dirname(repoFlagPath), { recursive: true });
      await writeFile(repoFlagPath, flagContent);

      pre = await preflight();
      expect(pre.verdict).toBe('STOP');
      expect(pre.checks.unattendedFlag).toMatchObject({
        id: 'unattended-flag-stale',
        outcome: 'fail',
      });
    } finally {
      await removeFixture(otherRoot);
    }
  }, 120_000);

  it('changed hook wiring is reported by doctor; the native trust it cannot observe stays unknown', async () => {
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{}\n');

    const doc = await doctor();
    expect(doctorOutcome(doc, 'hook-wiring-missing')).toBe('fail');
    expect(doctorOutcome(doc, 'codex-hook-trust')).toBe('unknown');
  }, 120_000);

  it('changed Codex hook wiring is reported by doctor too', async () => {
    await writeFile(path.join(repo, '.codex', 'hooks.json'), '{}\n');

    const doc = await doctor();
    expect(doctorOutcome(doc, 'hook-wiring-missing')).toBe('fail');
  }, 120_000);

  it('unobservable native state is never reported as verified', async () => {
    const NOT_OBSERVABLE = [
      'harness-hooks-loaded',
      'workspace-trust',
      'native-sandbox-mode',
      'codex-hook-trust',
    ];
    const doc = await doctor();
    for (const id of NOT_OBSERVABLE) {
      expect(doctorOutcome(doc, id), id).toBe('unknown');
    }

    const result = await run([path.join(repo, '.claude', 'scripts', 'preflight.mjs'), '--json']);
    // Parse first, so a crash with empty stdout cannot pass the "ids are
    // absent" checks below by vacuously containing none of them.
    const parsedPre = JSON.parse(result.stdout) as Preflight;
    expect(typeof parsedPre.verdict).toBe('string');
    for (const id of NOT_OBSERVABLE) {
      expect(result.stdout).not.toContain(id);
    }
  }, 120_000);

  it('a guard refuses a rulebook edit under an armed unattended run, and allows it attended', async () => {
    const guardPath = path.join(repo, '.claude', 'hooks', 'guard-rulebook.mjs');
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, '.claude', 'rules', 'x.md'), content: 'x' },
      cwd: repo,
    };

    const withStdin = (
      executable: string,
      args: string[],
      options: Parameters<typeof execFile>[2],
    ): Promise<{ code: number; stdout: string }> =>
      new Promise((resolve, reject) => {
        const child = execFile(executable, args, options, (error, stdout) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ code, stdout: String(stdout) });
        });
        if (!child.stdin) {
          reject(new Error('no stdin'));
          return;
        }
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      });

    /** Invoke the hook exactly the way Claude Code does: a direct node call with
     * CLAUDE_PROJECT_DIR set by the harness itself. */
    const runClaudeGuard = (): Promise<{ code: number; stdout: string }> =>
      withStdin(process.execPath, [guardPath], { env: { ...env(), CLAUDE_PROJECT_DIR: repo } });

    type CodexHookEntry = { command: string; commandWindows?: string };

    async function findCodexGuardEntry(): Promise<CodexHookEntry> {
      const raw = await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        hooks?: { PreToolUse?: { hooks?: CodexHookEntry[] }[] };
      };
      for (const matcher of parsed.hooks?.PreToolUse ?? []) {
        for (const hook of matcher.hooks ?? []) {
          if (hook.command.includes('guard-rulebook.mjs')) return hook;
        }
      }
      throw new Error('no Codex PreToolUse hook entry found for guard-rulebook.mjs');
    }

    /** Invoke the hook exactly the way Codex runs it: the literal `command` /
     * `commandWindows` wired in repo/.codex/hooks.json, never a direct node call.
     * On POSIX the command derives CLAUDE_PROJECT_DIR itself from
     * `git rev-parse --show-toplevel`, so CLAUDE_PROJECT_DIR is left unset here
     * the same way Codex leaves it unset — on macOS that spells the fixture
     * root under /private/var while mkdtemp hands this test /var, the spelling
     * a past bypass hid behind. On win32 the wired command is already the
     * `powershell.exe -EncodedCommand <b64>` form Codex itself runs. */
    const runCodexGuard = async (): Promise<{ code: number; stdout: string }> => {
      const entry = await findCodexGuardEntry();
      const guardEnv = { ...env() };
      if (process.platform === 'win32') {
        if (entry.commandWindows === undefined)
          throw new Error('no commandWindows on the Codex hook entry');
        const parts = entry.commandWindows.trim().split(/\s+/);
        const encoded = parts[parts.length - 1];
        delete guardEnv.NoDefaultCurrentDirectoryInExePath;
        return withStdin(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', String(encoded)],
          { cwd: repo, env: guardEnv },
        );
      }
      delete guardEnv.CLAUDE_PROJECT_DIR;
      return withStdin('/bin/sh', ['-c', entry.command], { cwd: repo, env: guardEnv });
    };

    // Attended (no unattended flag on disk anywhere under HOME): guard-rulebook.mjs's
    // own header, point 1, reads an absent flag as an attended session and exits 0
    // for every edit — for both the direct Claude invocation and the real Codex
    // wiring read out of repo/.codex/hooks.json.
    expect((await runClaudeGuard()).code).toBe(0);
    expect((await runCodexGuard()).code).toBe(0);

    const { unattendedFlags } = (await import(
      pathToFileURL(path.join(repo, '.claude', 'scripts', 'unattended-flag.mjs')).href
    )) as { unattendedFlags: (env: NodeJS.ProcessEnv) => string[] };
    const flagPath = unattendedFlags({
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PROJECT_DIR: repo,
    })[0];
    if (flagPath === undefined) throw new Error('no flag path resolved for this checkout');
    await mkdir(path.dirname(flagPath), { recursive: true });
    await writeFile(flagPath, `${JSON.stringify({ item: 'RP-0', allow: [] })}\n`);

    // Armed: guard-rulebook.mjs's blocking contract (its final refusal branch,
    // "part of the rulebook … never edits the rulebook outside its item's
    // allow-list") is `process.exit(2)` with a BLOCKED reason on stderr — never a
    // JSON decision on stdout — so the assertion here is the exit code, for both
    // invocations.
    expect((await runClaudeGuard()).code).toBe(2);
    expect((await runCodexGuard()).code).toBe(2);
  }, 120_000);

  it('preflight and doctor change nothing in the repository', async () => {
    const status = async (): Promise<string> =>
      (
        await exec('git', ['status', '--porcelain=v1', '-uall'], {
          cwd: repo,
          env: gitEnv(),
        })
      ).stdout;
    // The harnesses' own configuration — where their permissions and trust
    // live. Not the whole HOME: preflight's `gh run list` writes gh's own
    // state there (.local/state/gh/device-id on CI), which is gh's, not Rig's.
    const HARNESS_HOME_DIRS = ['.claude', '.codex'];
    const homeListing = async (): Promise<string[]> =>
      (await readdir(home, { recursive: true }))
        .filter((entry) => HARNESS_HOME_DIRS.some((dir) => entry.split(/[\\/]/)[0] === dir))
        .sort();

    const statusBefore = await status();
    const homeBefore = await homeListing();

    await preflight();
    await doctor();

    expect(await status()).toBe(statusBefore);
    expect(await homeListing()).toEqual(homeBefore);
  }, 120_000);
});
