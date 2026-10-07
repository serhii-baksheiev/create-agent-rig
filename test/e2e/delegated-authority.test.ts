import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
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
 * decision, a non-delegable stop, the kill switch and guard-bash's own
 * Never-tier rule, the publication boundary — ending in a SECOND, independent
 * session (session B) reading session A's durable evidence back. They
 * therefore run in file order, intentionally — one shared fixture across
 * every numbered scenario, never isolated per assertion. The one exception is
 * the small, unnumbered `containsAnyMarker` suite below — a pure-function
 * check with no fixture of its own, placed ahead of the journey on purpose so
 * scenario 7, last, stays the journey's own closing assertion.
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
 * own `homesOf` lookup, and this file must never WRITE to the real
 * `~/.claude`, nor read any file's CONTENT there. Every planted path is
 * asserted, at the point it is built, to start with the fake `home` and never
 * with the real home a planted path could otherwise land in (scenarios 4 and
 * 5). Scenario 7, the last test in the file, snapshots the FAKE home's own
 * `.claude` directory before anything plants a file there and again after
 * every scenario has cleaned up after itself, so a script that wrote
 * somewhere this file never asked it to would show up as a leftover there.
 * It also lists the REAL home's own `.claude` directory — top-level entry
 * NAMES only, never a file's content, never a write — because
 * `stop-flag.mjs`'s own `homesOf` always adds `os.userInfo().homedir`
 * regardless of `HOME`, so a regression writing there would otherwise go
 * undetected by the fake-home snapshot alone; the check looks only for this
 * fixture's own unique project name and checkout id, so it cannot flicker on
 * unrelated Claude Code session activity using other names.
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
const gateStopDodPath = (): string => path.join(repo, '.claude', 'hooks', 'gate-stop-dod.mjs');
const dodChecksPath = (): string => path.join(repo, '.claude', 'hooks', 'dod-checks.json');
const decisionsFilePath = (ticket: string): string =>
  path.join(repo, '.rig', 'decisions', `${ticket}.jsonl`);

/**
 * Every spawn's base environment: the fake HOME, never the real one, and
 * never a leaked `CLAUDE_PROJECT_DIR`, `AGENT_LOOP_STOP` or `RIG_RUN_DIR` —
 * `gitEnv()` copies all of `process.env`, so a live session this file happens
 * to run inside (this very worktree checkout, a brake armed via the
 * `AGENT_LOOP_STOP` env var rather than a file) would otherwise leak into
 * every fixture process, and this suite must behave the same inside and
 * outside one.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...gitEnv(), HOME: home, USERPROFILE: home, APPDATA: home };
  delete merged.CLAUDE_PROJECT_DIR;
  delete merged.AGENT_LOOP_STOP;
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

/** Like {@link run}, but for a hook that reads its payload from stdin rather than argv. */
function runWithStdin(
  args: string[],
  stdin: string,
  extraEnv: NodeJS.ProcessEnv = {},
  cwd: string = repo,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      args,
      { cwd, env: { ...baseEnv(), ...extraEnv } },
      (error, stdout, stderr) => {
        const e = error as { code?: number } | null;
        resolve({ code: e ? (e.code ?? 1) : 0, stdout, stderr });
      },
    );
    if (!child.stdin) {
      reject(new Error('no stdin'));
      return;
    }
    child.stdin.write(stdin);
    child.stdin.end();
  });
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

/**
 * Every fixture commit's own `-c` identity, plus signing and hooks turned
 * off for THIS commit only — never the real global git config a developer's
 * machine has configured, which could carry a signing key `commit.gpgsign`
 * would try to use, or a `core.hooksPath` that runs that machine's own hooks
 * against this throwaway fixture tree.
 */
const FIXTURE_COMMIT_CONFIG = [
  '-c',
  'user.email=rp344-fixture@example.com',
  '-c',
  'user.name=RP-344 fixture',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=',
];

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
 * Whether any entry in `entries` contains one of `markers` as a substring —
 * kept separate from the real directory read in scenario 7 so it can be
 * exercised directly against a synthetic listing.
 */
function containsAnyMarker(entries: string[], markers: string[]): boolean {
  return entries.some((entry) => markers.some((marker) => entry.includes(marker)));
}

// Exercised directly against a synthetic listing — independent of the
// shared fixture below and of the real OS home — so scenario 7's negative
// result (no marker found in the real `~/.claude`) is shown to come from a
// check that really does go red on a planted match, not from a predicate
// that can never return true.
describe('containsAnyMarker (synthetic listing, independent of the real home)', () => {
  it('is true when an entry carries a planted marker as a substring', () => {
    expect(
      containsAnyMarker(
        ['some-other-dir', 'caf-delegated-authority-deadbeef-loop-STOP'],
        ['caf-delegated-authority-deadbeef'],
      ),
    ).toBe(true);
  });

  it('is false when no entry carries any of the markers', () => {
    expect(
      containsAnyMarker(
        ['some-other-dir', 'unrelated-project-abc123-loop-STOP'],
        ['caf-delegated-authority-deadbeef'],
      ),
    ).toBe(false);
  });
});

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

  // Scenario 7's fake-home baseline. The real home gets a narrow name search
  // instead — see the module header.
  fakeHomeClaudeListingBefore = await snapshotHomeClaudeListing(home);

  await exec('git', ['init', '-q', repo], { env: gitEnv() });
  await exec(process.execPath, [cliBin, 'init', '--layer', 'workflow'], { cwd: repo });
  // Scenario 6 clones this fixture to simulate a second machine; the clone
  // needs the whole scaffold (`.claude/scripts/*`, not just a later decision
  // file) to run anything at all, so the generated rig is committed here,
  // once, the way a real checkout would be.
  await exec('git', ['add', '-A'], { cwd: repo, env: gitEnv() });
  await exec('git', [...FIXTURE_COMMIT_CONFIG, 'commit', '-q', '-m', 'generated rig scaffold'], {
    cwd: repo,
    env: gitEnv(),
  });
  await mkdir(path.join(repo, '.claude', 'runs'), { recursive: true });
}, 120_000);

afterAll(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

describe('the 1.5.0 delegated-authority model end to end on a generated workflow rig (RP-344 acceptance)', () => {
  it('scenario 1: a cold start under delegated authority reports the full posture and declares the run', async () => {
    const pre = (await runJson([
      preflightPath(),
      '--unattended',
      '--decision-authority',
      'delegated',
      '--json',
    ])) as {
      verdict: string;
      checks: Record<string, { id: string; outcome: string }>;
      uncheckedConditions: Array<{ id: string; outcome: string }>;
      authority: unknown;
    };
    expect(pre.authority).toEqual({
      schemaVersion: 1,
      executionMode: 'unattended',
      decisionAuthority: 'delegated',
      publicationAuthority: 'owner',
    });

    // The rest of the full posture this same preflight call reports — the
    // shape and the verdict `loop/SKILL.md` §1 reads before the first
    // selection, never only the authority block alone. Each check's `id` is
    // the posture contract's own (`lib/posture.mjs`), and the two conditions
    // this script never scripts (`stray-worktree`, `budget-declared`) are
    // named as `unknown`, never silently dropped.
    const requiredPassing: Record<string, string> = {
      killSwitch: 'kill-switch-armed',
      runDirNotExported: 'run-dir-inherited',
      unattendedFlag: 'unattended-flag-stale',
      detectionContract: 'detection-contract-invalid',
      queue: 'queue-unreadable',
    };
    const advisoryUnknown: Record<string, string> = {
      defaultBranchFresh: 'default-branch-stale',
      lastDeploy: 'last-deploy-failed',
    };
    expect(Object.keys(pre.checks).sort()).toEqual(
      [...Object.keys(requiredPassing), ...Object.keys(advisoryUnknown)].sort(),
    );
    for (const [key, id] of Object.entries(requiredPassing)) {
      expect(pre.checks[key], key).toMatchObject({ id, outcome: 'pass' });
    }
    for (const [key, id] of Object.entries(advisoryUnknown)) {
      expect(pre.checks[key], key).toMatchObject({ id, outcome: 'unknown' });
    }
    expect(pre.uncheckedConditions.map((condition) => condition.id).sort()).toEqual([
      'budget-declared',
      'stray-worktree',
    ]);
    expect(pre.uncheckedConditions.every((condition) => condition.outcome === 'unknown')).toBe(
      true,
    );

    // The verdict this exact fixture yields — a hand-written literal pinned
    // by running this script against this fixture (no `origin` remote, no
    // `gh`-reachable deploy workflow): both gaps are advisory, not required,
    // so the two `unknown`s above produce CAUTION, never GO or STOP, per
    // `lib/posture.mjs`'s `preflightVerdict`.
    expect(pre.verdict).toBe('CAUTION');

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
    // Its own reason, not merely a non-zero exit — an exit code alone cannot
    // tell this refusal apart from an unknown-id or a missing-run-dir one.
    expect(ownerRecordAttempt.stderr).toContain('needs a delegated run authority');
    await expect(readFile(decisionsFilePath('RP-2'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 120_000);

  it('scenario 3: true non-delegable stops fail closed under delegated authority', async () => {
    const nonDelegable: Array<[string, string]> = [
      ['RP-10', 'publication'],
      ['RP-11', 'kill-switch'],
      ['RP-12', 'failing-mechanical-gate'],
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
      // Its own reason, not merely a non-zero exit — an exit code alone
      // cannot tell this boundary refusal apart from an unknown-id or a
      // missing-run-dir refusal.
      expect(attempt.stderr, decision).toContain('stays with the owner regardless of delegation');
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

  it('scenario 3b: the real mechanical gate still blocks a delegated run, and a work-blocked stop never resolves to decide-and-continue', async () => {
    // (c) `blocking-verdict` is `work-blocked`, not `decision-needed` — its
    // resolution never depends on the decision id or the run's authority
    // (`queue/stop-class.mjs`'s `resolutionOf`). Asserted by VALUE, not merely
    // "not decide-and-continue".
    const blockingVerdict = await runJson(
      [delegatedDecisionPath(), 'resolve', '--stop', 'blocking-verdict', '--json'],
      { RIG_RUN_DIR: runDirA },
    );
    expect(blockingVerdict.resolution).toBe('escalate-item');

    // (b) The INSTALLED gate-stop-dod.mjs, run for real, under a declared
    // delegated run: `failing-mechanical-gate` being non-delegable (above) is
    // a fact about `record`, not proof the gate itself still fires. A failing
    // check requires a dirty tree to be reached at all.
    await writeFile(dodChecksPath(), JSON.stringify(['node -e "process.exit(1)"']));
    const payload = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false });
    const blocked = await runWithStdin([gateStopDodPath()], payload, {
      CLAUDE_PROJECT_DIR: repo,
      RIG_RUN_DIR: runDirA,
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('process.exit(1)');
    expect(blocked.stderr).toMatch(/diagnosis/i);

    // The compliant form: the same hook, the same declared authority, a
    // passing check.
    await writeFile(dodChecksPath(), JSON.stringify(['node -e "process.exit(0)"']));
    const passed = await runWithStdin([gateStopDodPath()], payload, {
      CLAUDE_PROJECT_DIR: repo,
      RIG_RUN_DIR: runDirA,
    });
    expect(passed.code).toBe(0);

    // Cleanup before scenario 6 commits `.rig/decisions/RP-1.jsonl` — this
    // file must not be part of that commit.
    await rm(dodChecksPath());
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
    // guard-bash's OWN Never-tier refusal, independent of the kill switch —
    // `git push --force origin master` names a branch `PROTECTED_BRANCH`
    // matches, the same rule `test/template/guard-bash.test.ts` pins for
    // this exact branch name › "still sees a quoted branch name — quoting an
    // argument does not hide it" (`git push --force origin 'master'`) and,
    // unquoted, every case the file's `it.each(...)('denies %s', …)` list
    // covers — exercised below with the brake ABSENT, to show the refusal
    // is guard-bash's own rule and not merely the brake reading as set.
    const forcePushPayload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin master' },
      cwd: repo,
    });

    const withStdin = (
      executable: string,
      args: string[],
      options: Parameters<typeof execFile>[2],
      stdinPayload: string = payload,
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
        child.stdin.write(stdinPayload);
        child.stdin.end();
      });

    const runClaudeGuard = (stdinPayload: string = payload): Promise<{ code: number }> =>
      withStdin(
        process.execPath,
        [guardPath],
        { env: { ...baseEnv(), CLAUDE_PROJECT_DIR: repo, RIG_RUN_DIR: runDirA } },
        stdinPayload,
      );

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
    const runCodexGuard = async (stdinPayload: string = payload): Promise<{ code: number }> => {
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
          stdinPayload,
        );
      }
      delete guardEnv.CLAUDE_PROJECT_DIR;
      return withStdin(
        '/bin/sh',
        ['-c', entry.command],
        { cwd: repo, env: guardEnv },
        stdinPayload,
      );
    };

    // Brake absent: an ordinary command is allowed on both surfaces...
    expect((await runClaudeGuard()).code).toBe(0);
    expect((await runCodexGuard()).code).toBe(0);
    // ...and a Never-tier command is refused on both surfaces anyway — this
    // is guard-bash's own force-push rule holding with no brake in play at
    // all, not the kill-switch assertion below wearing a different payload.
    expect((await runClaudeGuard(forcePushPayload)).code).toBe(2);
    expect((await runCodexGuard(forcePushPayload)).code).toBe(2);

    // Hand-plant the brake under the FAKE home only — never via a helper that
    // mirrors into the real OS home, and never the real home itself.
    const brakeName = `${await projectName()}-loop-STOP`;
    const brakePath = path.join(home, '.claude', brakeName);
    expect(brakePath.startsWith(home)).toBe(true);
    expect(brakePath.startsWith(path.join(userInfo().homedir, '.claude'))).toBe(false);
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
    expect(flagPath.startsWith(path.join(userInfo().homedir, '.claude'))).toBe(false);
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
      [...FIXTURE_COMMIT_CONFIG, 'commit', '-m', 'record the RP-1 delegated decision'],
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

  it("scenario 7: nothing in this journey left a stray write under the fake HOME, and the top-level names of the real ~/.claude carry neither this fixture's project name nor its checkout id", async () => {
    // Every planted path across scenarios 4 and 5 was already asserted, at
    // the point it was built, to start with the fake `home`. This is the
    // complementary check on that same fake home: once every scenario above
    // has cleaned up what it planted, its own `.claude` directory holds
    // exactly the files it holds after cleanup — a script that wrote
    // something this file never asked for, and never cleaned up, would show
    // up here as a leftover.
    // An absent `.claude` directory (`null`) and an empty, still-present one
    // (`[]`) both mean "no files" — the directory itself surviving a cleanup
    // that only ever `rm`'d the files it planted is not a stray write.
    const after = (await snapshotHomeClaudeListing(home)) ?? [];
    expect(after).toEqual(fakeHomeClaudeListingBefore ?? []);

    // The complementary check on the REAL home: `stop-flag.mjs`'s own
    // `homesOf` always adds `os.userInfo().homedir` regardless of `HOME`, so
    // a regression writing there would never show up in the fake-home
    // snapshot above. This reads only the real `~/.claude` directory's
    // top-level ENTRY NAMES — never a file's content, never a write — and
    // checks that none of them mentions this fixture's own project name or
    // checkout id. Both are unique to this run, because the fixture
    // directory itself is an `mkdtemp` name, so this cannot flicker on
    // unrelated Claude Code session activity that uses other names.
    let realHomeClaudeEntries: string[];
    try {
      realHomeClaudeEntries = await readdir(path.join(userInfo().homedir, '.claude'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      realHomeClaudeEntries = [];
    }

    const project = await projectName();
    const expectedProjectSlug = path
      .basename(repo)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    // `project` is a unique marker only when it actually derives from this
    // fixture's own unique `mkdtemp` basename (`init.ts`'s `projectNameFor`).
    // A silent fallback to the checkout id alone on mismatch would narrow
    // what this check searches for without saying so — so a mismatch FAILS
    // this test outright instead: `projectNameFor`'s derivation drifting
    // out from under this test is itself a finding, not a reason to search
    // for less.
    expect(project).toBe(expectedProjectSlug);
    const uniqueMarkers = [project, checkoutIdFor(repo)];

    expect(containsAnyMarker(realHomeClaudeEntries, uniqueMarkers)).toBe(false);
  });
});
