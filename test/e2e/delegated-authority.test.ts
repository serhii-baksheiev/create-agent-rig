import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * RP-344 — acceptance of the 1.5.0 controller-authority model end to end, on a
 * generated workflow-layer rig, driven exactly as an operator or controller
 * drives it: the installed `.claude/scripts/*.mjs` CLIs, the installed
 * `.claude/hooks/guard-bash.mjs`, and the built CLI `packages/cli/dist/index.js`.
 *
 * Live Codex is unavailable until 2026-10-10 (usage limit, measured; Jira
 * RP-344 comment 23319), so this file is the deterministic acceptance of the
 * MECHANISMS the 1.5 authority contract is built from
 * (`.claude/scripts/lib/authority.mjs`, `delegated-decision.mjs`,
 * `queue/stop-class.mjs`, `run-state.mjs`, `guard-bash.mjs`, the CLI
 * `doctor`) — never presented here as a substitute for a live session on
 * either harness. Modelled on `test/e2e/unattended-posture.test.ts` (RP-283):
 * one fixture repo (`init --layer workflow`), a FAKE HOME for every flag and
 * brake file, hand-written expected outcomes, and the guard driven through
 * BOTH the Claude Code hook invocation and the literal Codex `hooks.json`
 * command.
 *
 * Every scenario below is numbered to match the RP-344 acceptance brief. The
 * `it`s share one fixture repo and run across it as one controller session
 * (session A), because the brief is a journey — a cold start, an ordinary
 * decision, a non-delegable stop, the kill switch, the publication boundary —
 * ending in a SECOND, independent session (session B) reading session A's
 * durable evidence back. They therefore run in file order, intentionally, the
 * same way `unattended-posture.test.ts`'s own fixtures build on `beforeEach`
 * rather than isolating every assertion.
 *
 * `checkoutIdFor`/`plantedFlagPath` below are a deliberately separate,
 * hand-written reimplementation of `unattended-flag.mjs`'s own
 * `checkoutId`/`scopedBasename` derivation — never an import of production's
 * own function — the same independent-oracle shape
 * `packages/cli/test/doctor-authority.test.ts` uses, and for the same reason
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant"): this
 * file must be able to tell a flag that production reads correctly apart from
 * one that merely satisfies production's own derivation of where to look.
 *
 * Every flag, brake and run-authority file this test plants is written under
 * the FAKE `home` fixture only — `.claude/scripts/unattended-flag.mjs on` is
 * never invoked, because that command mirrors into the real OS home via its
 * own `homesOf` lookup, and this file must never read or write the real
 * `~/.claude`. Two independent checks hold that: every planted path is
 * asserted, at the point it is built, to start with the fake `home` and never
 * with the real `os.homedir()` (scenarios 4 and 5); and scenario 7, the last
 * test in the file, snapshots the FAKE home's own `.claude` directory before
 * anything plants a file there and again after every scenario has cleaned up
 * after itself, so a script that wrote somewhere this file never asked it to
 * would show up as a leftover. The real home is deliberately never read at
 * all — not even to diff it — because this process runs inside a live Claude
 * Code session whose own tool use writes to the real `~/.claude` for reasons
 * that have nothing to do with the code under test, which would make a
 * real-home diff flicker red on unrelated activity.
 */

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

type RunResult = { code: number; stdout: string; stderr: string };

let repo: string;
let home: string;
let runDirA: string;
let ownerRunDir: string;
let fakeHomeClaudeListingBefore: string[] | null;

const preflightPath = (): string => path.join(repo, '.claude', 'scripts', 'preflight.mjs');
const runStatePath = (): string => path.join(repo, '.claude', 'scripts', 'run-state.mjs');
const delegatedDecisionPath = (): string =>
  path.join(repo, '.claude', 'scripts', 'delegated-decision.mjs');
const queueIndexPath = (): string => path.join(repo, '.claude', 'scripts', 'queue', 'index.mjs');
const guardBashPath = (): string => path.join(repo, '.claude', 'hooks', 'guard-bash.mjs');
const decisionsFilePath = (ticket: string): string =>
  path.join(repo, '.rig', 'decisions', `${ticket}.jsonl`);

/** Every spawn's base environment: the fake HOME, never the real one, and never a leaked RIG_RUN_DIR. */
function baseEnv(): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...gitEnv(), HOME: home, USERPROFILE: home, APPDATA: home };
  delete merged.RIG_RUN_DIR;
  return merged;
}

async function run(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  cwd: string = repo,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, args, {
      cwd,
      env: { ...baseEnv(), ...extraEnv },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function runJson(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  cwd: string = repo,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each script's --json shape differs by command
): Promise<any> {
  const result = await run(args, extraEnv, cwd);
  return JSON.parse(result.stdout);
}

/** One run directory per declared session/task — never reused across scenarios that must not interfere. */
async function makeRunDir(label: string): Promise<string> {
  return mkdtemp(path.join(repo, '.claude', 'runs', `${label}-`));
}

async function projectName(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
  ) as { project: { name: string } };
  return manifest.project.name;
}

/**
 * Deliberately a second copy of the installed `unattended-flag.mjs`'s own
 * `checkoutId` — `sha256(realpath-or-resolve(checkout)).hex().slice(0, 16)` —
 * rather than an import of production's own function. See the module header.
 */
function checkoutIdFor(dir: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(dir);
  } catch {
    canonical = path.resolve(dir);
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** The real, substituted flag path the INSTALLED rig computes for itself. */
async function plantedFlagPath(forRepo: string = repo): Promise<string> {
  const project = await projectName();
  const id = checkoutIdFor(forRepo);
  return path.join(home, '.claude', `${project}-${id}-loop-UNATTENDED`);
}

/**
 * A metadata-only listing of every file under `<root>/.claude` — never file
 * CONTENT, so this stays cheap to call for the fake home's own directory.
 * Path + size + mtime is already enough to detect any write, addition or
 * deletion. `null` when `.claude` does not exist there at all.
 */
async function snapshotHomeClaudeListing(root: string): Promise<string[] | null> {
  const claudeDir = path.join(root, '.claude');
  let entries;
  try {
    entries = await readdir(claudeDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const rows = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = path.join(entry.parentPath, entry.name);
        const info = await stat(full);
        return `${path.relative(claudeDir, full)}:${info.size}:${info.mtimeMs}`;
      }),
  );
  return rows.sort();
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-delegated-authority-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-delegated-authority-home-'));

  // Scenario 7's baseline: read BEFORE anything in this file plants a single
  // byte under the fake home, so a later mismatch cannot be blamed on
  // pre-existing state. The real home is never read at all — see the module
  // header for why a real-home diff would be unreliable in this environment.
  fakeHomeClaudeListingBefore = await snapshotHomeClaudeListing(home);

  await exec('git', ['init', '-q', repo], { env: gitEnv() });
  await exec(process.execPath, [cliBin, 'init', '--layer', 'workflow'], { cwd: repo });
  // Scenario 6 clones this fixture to simulate a second machine; the clone
  // needs the whole scaffold (`.claude/scripts/*`, not just a later decision
  // file) to run anything at all, so the generated rig is committed here,
  // once, the way a real checkout would be.
  await exec('git', ['add', '-A'], { cwd: repo, env: gitEnv() });
  await exec(
    'git',
    [
      '-c',
      'user.email=rp344-fixture@example.com',
      '-c',
      'user.name=RP-344 fixture',
      'commit',
      '-q',
      '-m',
      'generated rig scaffold',
    ],
    { cwd: repo, env: gitEnv() },
  );
  await mkdir(path.join(repo, '.claude', 'runs'), { recursive: true });
}, 120_000);

afterAll(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

describe('the 1.5.0 delegated-authority model end to end on a generated workflow rig (RP-344 acceptance)', () => {
  it('scenario 1: a cold start under delegated authority reports the full posture and declares the run', async () => {
    const pre = await runJson([
      preflightPath(),
      '--unattended',
      '--decision-authority',
      'delegated',
      '--json',
    ]);
    expect(pre.authority).toEqual({
      schemaVersion: 1,
      executionMode: 'unattended',
      decisionAuthority: 'delegated',
      publicationAuthority: 'owner',
    });

    runDirA = await makeRunDir('session-a');
    const declared = await run([runStatePath(), 'authority', 'delegated'], {
      RIG_RUN_DIR: runDirA,
    });
    expect(declared.code).toBe(0);
    expect(declared.stdout).toContain('decisionAuthority');
    expect(declared.stdout).toContain('delegated');

    const state = JSON.parse(await readFile(path.join(runDirA, 'state.json'), 'utf8')) as {
      decisionAuthority?: string;
    };
    expect(state.decisionAuthority).toBe('delegated');
  }, 120_000);

  it('scenario 2: an ordinary owner-decision condition escalates under owner authority and resolves under delegated authority', async () => {
    ownerRunDir = await makeRunDir('session-owner');
    const declaredOwner = await run([runStatePath(), 'authority', 'owner'], {
      RIG_RUN_DIR: ownerRunDir,
    });
    expect(declaredOwner.code).toBe(0);

    const ownerResolve = await runJson(
      [delegatedDecisionPath(), 'resolve', '--stop', 'elevated-path-scope', '--json'],
      { RIG_RUN_DIR: ownerRunDir },
    );
    expect(ownerResolve).toMatchObject({
      stop: 'elevated-path-scope',
      decision: 'elevated-change-acceptance',
      authority: 'owner',
      resolution: 'escalate-item',
    });

    const delegatedResolve = await runJson(
      [delegatedDecisionPath(), 'resolve', '--stop', 'elevated-path-scope', '--json'],
      { RIG_RUN_DIR: runDirA },
    );
    expect(delegatedResolve).toMatchObject({
      stop: 'elevated-path-scope',
      decision: 'elevated-change-acceptance',
      authority: 'delegated',
      resolution: 'decide-and-continue',
    });

    const recorded = await run(
      [
        delegatedDecisionPath(),
        'record',
        '--ticket',
        'RP-1',
        '--decision',
        'elevated-change-acceptance',
        '--summary',
        'Accepted a Tier-2-only change because it reaches a declared elevated path; review and required checks already passed on this head.',
        '--release',
        'rel-1.5.0',
      ],
      { RIG_RUN_DIR: runDirA },
    );
    expect(recorded.code).toBe(0);

    const lines = (await readFile(decisionsFilePath('RP-1'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 1,
      ticket: 'RP-1',
      decision: 'elevated-change-acceptance',
      authority: 'delegated',
      release: 'rel-1.5.0',
    });

    const ownerRecordAttempt = await run(
      [
        delegatedDecisionPath(),
        'record',
        '--ticket',
        'RP-2',
        '--decision',
        'elevated-change-acceptance',
        '--summary',
        'an owner-authority run must never be able to record this decision',
      ],
      { RIG_RUN_DIR: ownerRunDir },
    );
    expect(ownerRecordAttempt.code).not.toBe(0);
    await expect(readFile(decisionsFilePath('RP-2'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 120_000);

  it('scenario 3: true non-delegable stops fail closed under delegated authority', async () => {
    const nonDelegable: Array<[string, string]> = [
      ['RP-10', 'publication'],
      ['RP-11', 'kill-switch'],
    ];
    for (const [ticket, decision] of nonDelegable) {
      const attempt = await run(
        [
          delegatedDecisionPath(),
          'record',
          '--ticket',
          ticket,
          '--decision',
          decision,
          '--summary',
          'never recorded, under any authority',
        ],
        { RIG_RUN_DIR: runDirA },
      );
      expect(attempt.code, `"${decision}" must be refused under delegated authority`).not.toBe(0);
      await expect(readFile(decisionsFilePath(ticket), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }

    for (const stop of [
      'surprise-scope',
      'invariant-conflict',
      'gate-round-cap',
      'premise-false',
    ]) {
      const resolved = await runJson(
        [delegatedDecisionPath(), 'resolve', '--stop', stop, '--json'],
        { RIG_RUN_DIR: runDirA },
      );
      expect(resolved.resolution, stop).toBe('escalate-item');
      expect(resolved.resolution, stop).not.toBe('decide-and-continue');
    }

    const unreadableRunDir = await makeRunDir('session-unreadable-state');
    const declared = await run([runStatePath(), 'authority', 'delegated'], {
      RIG_RUN_DIR: unreadableRunDir,
    });
    expect(declared.code).toBe(0);
    await writeFile(path.join(unreadableRunDir, 'state.json'), '{ not valid json');

    // No --config: this reads the FIXTURE's own `.claude/queue.json`
    // (plan-md, the default `init --layer workflow` ships) rather than a
    // test-authored one.
    const next = await run([queueIndexPath(), 'next', '--json'], { RIG_RUN_DIR: unreadableRunDir });
    expect(next.code).toBe(1);
    const parsed = JSON.parse(next.stdout) as {
      stop: { kind: string; success: boolean; stopClass: string };
      revalidation: unknown;
    };
    expect(parsed.stop).toMatchObject({
      kind: 'run-state-unreadable',
      success: false,
      stopClass: 'systemic-wall',
    });
    expect(parsed.revalidation).toBeNull();
  }, 120_000);

  it('scenario 4: the kill switch and guard-bash stay intact under delegated authority, on both harness surfaces', async () => {
    const aState = JSON.parse(await readFile(path.join(runDirA, 'state.json'), 'utf8')) as {
      decisionAuthority?: string;
    };
    expect(aState.decisionAuthority).toBe('delegated');

    const guardPath = guardBashPath();
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 1' },
      cwd: repo,
    });

    const withStdin = (
      executable: string,
      args: string[],
      options: Parameters<typeof execFile>[2],
    ): Promise<{ code: number }> =>
      new Promise((resolve, reject) => {
        const child = execFile(executable, args, options, (error) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ code });
        });
        if (!child.stdin) {
          reject(new Error('no stdin'));
          return;
        }
        child.stdin.write(payload);
        child.stdin.end();
      });

    const runClaudeGuard = (): Promise<{ code: number }> =>
      withStdin(process.execPath, [guardPath], {
        env: { ...baseEnv(), CLAUDE_PROJECT_DIR: repo, RIG_RUN_DIR: runDirA },
      });

    type CodexHookEntry = { command: string; commandWindows?: string };

    async function findCodexGuardEntry(): Promise<CodexHookEntry> {
      const raw = await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        hooks?: { PreToolUse?: { hooks?: CodexHookEntry[] }[] };
      };
      for (const matcher of parsed.hooks?.PreToolUse ?? []) {
        for (const hook of matcher.hooks ?? []) {
          if (hook.command.includes('guard-bash.mjs')) return hook;
        }
      }
      throw new Error('no Codex PreToolUse hook entry found for guard-bash.mjs');
    }

    /** The literal Codex `hooks.json` wiring, never a direct node call — mirrors
     * `unattended-posture.test.ts`'s `runCodexGuard` shape exactly. */
    const runCodexGuard = async (): Promise<{ code: number }> => {
      const entry = await findCodexGuardEntry();
      const guardEnv: NodeJS.ProcessEnv = { ...baseEnv(), RIG_RUN_DIR: runDirA };
      if (process.platform === 'win32') {
        if (entry.commandWindows === undefined) {
          throw new Error('no commandWindows on the Codex hook entry');
        }
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

    // Brake absent: allowed on both surfaces.
    expect((await runClaudeGuard()).code).toBe(0);
    expect((await runCodexGuard()).code).toBe(0);

    // Hand-plant the brake under the FAKE home only — never via a helper that
    // mirrors into the real OS home, and never the real home itself.
    const brakeName = `${await projectName()}-loop-STOP`;
    const brakePath = path.join(home, '.claude', brakeName);
    expect(brakePath.startsWith(home)).toBe(true);
    expect(brakePath.startsWith(homedir())).toBe(false);
    await mkdir(path.dirname(brakePath), { recursive: true });
    await writeFile(brakePath, '');

    expect((await runClaudeGuard()).code).toBe(2);
    expect((await runCodexGuard()).code).toBe(2);

    await rm(brakePath);
  }, 120_000);

  it('scenario 5: the publication boundary holds across preflight, delegated-decision and doctor', async () => {
    const preOwner = await runJson([preflightPath(), '--decision-authority', 'owner', '--json']);
    expect(preOwner.authority.publicationAuthority).toBe('owner');
    expect(preOwner.authority.decisionAuthority).toBe('owner');
    // `record --decision publication` refusing under delegated authority is
    // pinned in scenario 3 above — never recorded, under any authority.

    const flagRunDir = await makeRunDir('session-doctor');
    const declared = await run([runStatePath(), 'authority', 'delegated'], {
      RIG_RUN_DIR: flagRunDir,
    });
    expect(declared.code).toBe(0);

    const flagPath = await plantedFlagPath(repo);
    expect(flagPath.startsWith(home)).toBe(true);
    expect(flagPath.startsWith(homedir())).toBe(false);
    await mkdir(path.dirname(flagPath), { recursive: true });
    await writeFile(
      flagPath,
      `${JSON.stringify({ item: 'RP-344', runDir: flagRunDir, allow: [] })}\n`,
    );

    const doctor = await runJson([cliBin, 'doctor', '--json'], { CLAUDE_PROJECT_DIR: repo });
    expect(doctor.authority).toMatchObject({
      executionMode: 'unattended',
      decisionAuthority: 'delegated',
      publicationAuthority: 'owner',
    });

    await rm(flagPath);
  }, 120_000);

  it("scenario 6: a second controller session (B) reads session A's delegated decision back as durable evidence", async () => {
    await exec('git', ['add', '.rig/decisions/RP-1.jsonl'], { cwd: repo, env: gitEnv() });
    await exec(
      'git',
      [
        '-c',
        'user.email=rp344-fixture@example.com',
        '-c',
        'user.name=RP-344 fixture',
        'commit',
        '-m',
        'record the RP-1 delegated decision',
      ],
      { cwd: repo, env: gitEnv() },
    );

    const runDirB = await makeRunDir('session-b');
    const listWithRunDir = await runJson(
      [delegatedDecisionPath(), 'list', '--ticket', 'RP-1', '--json'],
      { RIG_RUN_DIR: runDirB },
    );
    expect(listWithRunDir).toHaveLength(1);
    expect(listWithRunDir[0]).toMatchObject({
      ticket: 'RP-1',
      decision: 'elevated-change-acceptance',
      authority: 'delegated',
      release: 'rel-1.5.0',
    });

    // A fresh process with RIG_RUN_DIR not set at all — `list` needs no run
    // directory and no declared authority to read durable evidence back.
    const listWithNoRunDir = await runJson([
      delegatedDecisionPath(),
      'list',
      '--ticket',
      'RP-1',
      '--json',
    ]);
    expect(listWithNoRunDir).toEqual(listWithRunDir);

    const listForAnotherTicket = await runJson([
      delegatedDecisionPath(),
      'list',
      '--ticket',
      'RP-999',
      '--json',
    ]);
    expect(listForAnotherTicket).toEqual([]);

    // Simulate a second machine: clone the fixture repo and read from there.
    const clone = await mkdtemp(path.join(tmpdir(), 'caf-delegated-authority-clone-'));
    try {
      await exec('git', ['clone', '--quiet', repo, clone], { env: gitEnv() });
      const cloneResult = await run(
        [
          path.join(clone, '.claude', 'scripts', 'delegated-decision.mjs'),
          'list',
          '--ticket',
          'RP-1',
          '--json',
        ],
        {},
        clone,
      );
      expect(cloneResult.code).toBe(0);
      expect(JSON.parse(cloneResult.stdout)).toEqual(listWithRunDir);
    } finally {
      await removeFixture(clone);
    }
  }, 120_000);

  it('scenario 7: nothing in this journey left a stray write under the fake HOME, and every planted path stayed out of the real one', async () => {
    // Every planted path across scenarios 4 and 5 was already asserted, at
    // the point it was built, to start with the fake `home` and never with
    // the real `os.homedir()` — this is the complementary check: once every
    // scenario above has cleaned up what it planted, the fake home's own
    // `.claude` directory is back to exactly what it held before any of them
    // ran. A script that wrote something this file never asked for — and
    // never cleaned up — would show up here as a leftover.
    // An absent `.claude` directory (`null`) and an empty, still-present one
    // (`[]`) both mean "no files" — the directory itself surviving a cleanup
    // that only ever `rm`'d the files it planted is not a stray write.
    const after = (await snapshotHomeClaudeListing(home)) ?? [];
    expect(after).toEqual(fakeHomeClaudeListingBefore ?? []);
  });
});
