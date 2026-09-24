import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITHUB_PAT } from './secrets-fixtures.js';

// RP-224 — "[RIG 1.1][CONTINUITY] Publish bounded continuation notes for
// unfinished workflow stops".
//
// A second controller/machine has to be able to resume or revalidate a
// claimed item from durable, shared evidence alone — a tracker note, the PR,
// the branch, the claim — without depending on the first controller's local
// run journal or Memory. `continuation.mjs` is the one place that composes
// that note and (optionally) posts it, on exactly four workflow-level stops:
// escalation, an owner/external blocker, an intentional pause/handoff, and
// session termination while a claimed item remains unfinished. It is
// deliberately NOT called on every technical Claude Stop, subagent stop, or
// review round.
//
// This file is written against `.claude/scripts/continuation.mjs`, which does
// not exist yet — every test below is expected to fail because the module
// cannot be imported/spawned. It assumes these exports:
//
//   composeNote({ ticket, stop, branch, pr, headSha, gateRounds, verdict,
//                 diagnosis, remaining }) -> string
//   readRunEvidence(runDir) -> { gate, verdict, headSha, blockers }
//     (all null / blockers: [] when there is no run dir or it is unreadable)
//
// and a CLI:
//   node .claude/scripts/continuation.mjs --ticket <id> --stop <kind>
//        [--pr <n>] [--diagnosis <text>] [--remaining <text>] [--post]
//
// The independent oracle (`invariants.md`): every expected string below is
// typed out by hand in the test, never computed by calling the module's own
// scrubbing/redaction/cap logic — and the credential fixture is assembled at
// runtime (`secrets-fixtures.ts`) so this file itself carries no committable
// secret shape.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const queueScriptPath = (name: string) => path.join(queueDir, name);
const load = (name: string) => import(pathToFileURL(scriptPath(name)).href);
const loadQueue = (name: string) => import(pathToFileURL(queueScriptPath(name)).href);
const skillPath = (...parts: string[]) =>
  path.join(universalDir, '.claude', 'skills', ...parts, 'SKILL.md');

const { withoutGitLocation } = (await import(pathToFileURL(scriptPath('git-env.mjs')).href)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
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

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

const hermeticEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('RIG_RUN_DIR' in extra)) delete env.RIG_RUN_DIR;
  return env;
};

const runCli = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath('continuation.mjs'), ...args],
      { cwd, env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
          stdout,
          stderr,
        });
      },
    );
  });

// --- composeNote -------------------------------------------------------

describe('composeNote — the shared shape', () => {
  it('starts with the fixed marker line, then key: value lines in the fixed order', async () => {
    const { composeNote } = await load('continuation.mjs');
    const note = composeNote({
      ticket: 'RP-224',
      stop: 'pause',
      branch: 'feat/rp-224-continuation-notes',
      pr: 315,
      headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
      gateRounds: 2,
      verdict: {
        gate: 'pr-ship',
        verdict: 'HOLD',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: ['workflow.md#pr-flow'],
      },
      diagnosis: 'short diagnosis',
      remaining: 'short remaining',
    });
    expect(note).toBe(
      [
        'rig-continuation v1',
        'ticket: RP-224',
        'stop: pause',
        'branch: feat/rp-224-continuation-notes',
        'pr: 315',
        'head: e0e93a8123456789abcdef0123456789abcdef01',
        'gate-rounds: 2',
        'latest-verdict: pr-ship HOLD @ e0e93a8 — blockers: workflow.md#pr-flow',
        'diagnosis: short diagnosis',
        'remaining: short remaining',
      ].join('\n'),
    );
  });

  it('prints unknown for every absent value — never omitted, never guessed', async () => {
    const { composeNote } = await load('continuation.mjs');
    const note = composeNote({ ticket: 'RP-224', stop: 'terminated' });
    expect(note).toBe(
      [
        'rig-continuation v1',
        'ticket: RP-224',
        'stop: terminated',
        'branch: unknown',
        'pr: unknown',
        'head: unknown',
        'gate-rounds: unknown',
        'latest-verdict: unknown',
        'diagnosis: unknown',
        'remaining: unknown',
      ].join('\n'),
    );
  });

  it('does not throw when ticket is absent — it prints unknown, never guesses', async () => {
    const { composeNote } = await load('continuation.mjs');
    const note = composeNote({ stop: 'pause' });
    expect(note.split('\n')[1]).toBe('ticket: unknown');
  });

  it('accepts each of the four stop kinds', async () => {
    const { composeNote } = await load('continuation.mjs');
    for (const stop of ['escalation', 'blocker', 'pause', 'terminated']) {
      expect(() => composeNote({ ticket: 'RP-1', stop }), stop).not.toThrow();
      expect(composeNote({ ticket: 'RP-1', stop })).toContain(`stop: ${stop}`);
    }
  });

  it('refuses an unknown stop kind', async () => {
    const { composeNote } = await load('continuation.mjs');
    expect(() => composeNote({ ticket: 'RP-1', stop: 'confused' })).toThrow(/stop/i);
  });

  it('refuses an absent stop kind', async () => {
    const { composeNote } = await load('continuation.mjs');
    expect(() => composeNote({ ticket: 'RP-1' })).toThrow(/stop/i);
  });

  it('renders latest-verdict as "<gate> <verdict> @ <short sha>", short sha only', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        gate: 'pr-ship',
        verdict: 'SHIP',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: [],
      },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe('latest-verdict: pr-ship SHIP @ e0e93a8');
  });

  it('renders latest-verdict with an unknown short sha when the verdict named no head', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: { gate: 'pr-ship', verdict: 'SHIP', headSha: null, blockers: [] },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe('latest-verdict: pr-ship SHIP @ unknown');
  });

  it('caps diagnosis and remaining at 500 characters, with an explicit [truncated] marker', async () => {
    const { composeNote } = await load('continuation.mjs');
    const long = 'a'.repeat(600);
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: long,
      remaining: long,
    });
    // The rule (module header: "diagnosis and remaining are each capped at
    // 500 characters"): FIELD_CAP is the field's total length INCLUDING the
    // marker, not the number of original characters kept before it — so a
    // truncated field is 489 kept characters + the 11-character
    // '[truncated]' marker, 500 in total, never 500 kept characters plus the
    // marker on top.
    const expectedField = `${'a'.repeat(489)}[truncated]`;
    expect(expectedField).toHaveLength(500);
    expect(note).toContain(`diagnosis: ${expectedField}`);
    expect(note).toContain(`remaining: ${expectedField}`);
  });

  it('scrubs an absolute path of every shape the design names, once each', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const diagnosis = [
      'posix home: /home/serhiibaksheiev/rig-224/file.js',
      'posix users: /Users/serhii/project/file.ts',
      'posix tmp: /tmp/scratch/out.log',
      'windows: C:\\Users\\SerhiiBaksheiev\\Documents\\create-agent-rig\\file.ts',
      'wsl unc: \\\\wsl$\\Ubuntu\\home\\serhiibaksheiev\\rig-224\\file.ts',
    ].join(' | ');
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/\/home\/serhiibaksheiev/);
    expect(line).not.toMatch(/\/Users\/serhii/);
    expect(line).not.toMatch(/\/tmp\/scratch/);
    expect(line).not.toMatch(/C:\\Users/);
    expect(line).not.toMatch(/wsl\$/i);
    expect((line.match(/\[path\]/g) ?? []).length).toBe(5);
  });

  it('redacts a credential-shaped value rather than printing it', async () => {
    const { composeNote } = await load('continuation.mjs');
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: `token leaked: ${GITHUB_PAT}`,
    });
    expect(note).toContain('[redacted]');
    expect(note).not.toContain(GITHUB_PAT);
  });

  it('caps the whole note, even when no single field is over its own cap', async () => {
    const { composeNote } = await load('continuation.mjs');
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', branch: 'x'.repeat(5000) });
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note.endsWith('\n[truncated]')).toBe(true);
  });
});

// --- readRunEvidence -----------------------------------------------------

describe('readRunEvidence', () => {
  it('returns the latest verdict decision — gate, verdict, headSha, and blocker rule names', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const { recordDecision } = await load('run-journal.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-'));

    recordDecision({
      runDir,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [{ rule: 'workflow.md#tests', note: 'missing a test' }],
      now: new Date(2026, 0, 1).toISOString(),
    });
    recordDecision({
      runDir,
      gate: 'pr-ship',
      verdict: 'HOLD',
      blockers: [{ rule: 'autonomy.md#never', note: 'force push' }],
      headSha: '1234567890abcdef1234567890abcdef12345678',
      now: new Date(2026, 0, 2).toISOString(),
    });

    expect(readRunEvidence(runDir)).toEqual({
      gate: 'pr-ship',
      verdict: 'HOLD',
      headSha: '1234567890abcdef1234567890abcdef12345678',
      blockers: ['autonomy.md#never'],
    });
  });

  it('returns nulls (never a throw) when the run directory does not exist', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const missing = path.join(tmpdir(), 'continuation-run-does-not-exist', String(Date.now()));
    expect(readRunEvidence(missing)).toEqual({
      gate: null,
      verdict: null,
      headSha: null,
      blockers: [],
    });
  });

  it('returns nulls when the run directory carries no gate verdict at all', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-empty-'));
    expect(readRunEvidence(runDir)).toEqual({
      gate: null,
      verdict: null,
      headSha: null,
      blockers: [],
    });
  });
});

// --- CLI -------------------------------------------------------------------

describe('continuation.mjs CLI', () => {
  const BRANCH = 'feat/rp-1-continuation-cli';

  const freshRepo = async (): Promise<{ repoDir: string; headSha: string }> => {
    const repoDir = await mkdtemp(path.join(tmpdir(), 'continuation-repo-'));
    await git(['init', '-q'], repoDir);
    await git(['checkout', '-q', '-b', BRANCH], repoDir);
    await writeFile(path.join(repoDir, 'a.txt'), 'x\n');
    await git(['add', '-A'], repoDir);
    await git(['commit', '-q', '-m', 'init'], repoDir);
    const headSha = await git(['rev-parse', 'HEAD'], repoDir);
    return { repoDir, headSha };
  };

  it('prints ticket, stop, branch and head gathered from the checkout, with zero gate rounds recorded', async () => {
    const { repoDir, headSha } = await freshRepo();
    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'pause'], hermeticEnv());
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('ticket: RP-1');
    expect(result.stdout).toContain('stop: pause');
    expect(result.stdout).toContain(`branch: ${BRANCH}`);
    expect(result.stdout).toContain(`head: ${headSha}`);
    expect(result.stdout).toContain('gate-rounds: 0');
  });

  it('reports the gate rounds already counted for this branch in this checkout', async () => {
    const { repoDir } = await freshRepo();
    await mkdir(path.join(repoDir, '.claude'), { recursive: true });
    const { recordGateRound } = await loadQueue('gate-rounds.mjs');
    recordGateRound({ branch: BRANCH, projectRoot: repoDir });
    recordGateRound({ branch: BRANCH, projectRoot: repoDir });

    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'blocker'], hermeticEnv());
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('gate-rounds: 2');
  });

  it('includes the latest verdict from RIG_RUN_DIR when one is declared', async () => {
    const { repoDir, headSha } = await freshRepo();
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-cli-'));
    const { recordDecision } = await load('run-journal.mjs');
    recordDecision({
      runDir,
      gate: 'pr-ship',
      verdict: 'HOLD',
      blockers: [{ rule: 'workflow.md#pr-flow', note: 'x' }],
      headSha,
      now: new Date().toISOString(),
    });

    const result = await runCli(
      repoDir,
      ['--ticket', 'RP-1', '--stop', 'escalation'],
      hermeticEnv({ RIG_RUN_DIR: runDir }),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain(
      `latest-verdict: pr-ship HOLD @ ${headSha.slice(0, 7)} — blockers: workflow.md#pr-flow`,
    );
  });

  it('scrubs the --diagnosis argument through the same rules composeNote pins', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(
      repoDir,
      ['--ticket', 'RP-1', '--stop', 'pause', '--diagnosis', 'fails at /tmp/scratch/out.log'],
      hermeticEnv(),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('diagnosis: fails at [path]');
    expect(result.stdout).not.toContain('/tmp/scratch');
  });

  it('refuses an unknown --stop value', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'confused'], hermeticEnv());
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/stop/i);
  });

  it('refuses a missing --ticket', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(repoDir, ['--stop', 'pause'], hermeticEnv());
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/ticket/i);
  });

  it('without --post, never touches the network — no adapter call is made', async () => {
    const { repoDir } = await freshRepo();
    await mkdir(path.join(repoDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'jira' }),
    );
    const env = hermeticEnv();
    delete env.JIRA_BASE_URL;
    delete env.JIRA_EMAIL;
    delete env.JIRA_API_TOKEN;

    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'pause'], env);
    // If the CLI had attempted to post through the jira adapter with no
    // --post, `comment()` would fail immediately because the jira adapter's
    // own `request()` refuses with no JIRA_BASE_URL/EMAIL/TOKEN — that
    // refusal message is the independent proof that no attempt was made.
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toMatch(/JIRA_BASE_URL/);
    expect(result.out).not.toMatch(/JIRA_API_TOKEN/);
  });

  it('--post on the plan-md adapter refuses to post, and still prints the note', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(
      repoDir,
      ['--ticket', 'RP-1', '--stop', 'pause', '--post'],
      hermeticEnv(),
    );
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('rig-continuation v1');
    expect(result.out).toMatch(/journal/i);
  });
});

// --- wired into the workflow layer -----------------------------------------

describe('continuation.mjs is wired into the workflow layer', () => {
  it('layers.json lists the script under the workflow array', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(universalDir, 'layers.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(manifest['workflow']).toContain('.claude/scripts/continuation.mjs');
  });

  it('the loop skill names continuation.mjs and each of the four stop kinds', async () => {
    const content = await readFile(skillPath('loop'), 'utf8');
    expect(content).toMatch(/continuation\.mjs/);
    for (const kind of ['escalation', 'blocker', 'pause', 'terminated']) {
      expect(
        content,
        `loop/SKILL.md does not mention the stop kind "${kind}" near continuation.mjs`,
      ).toMatch(new RegExp(`\\b${kind}\\b`, 'i'));
    }
  });

  it('the loop skill says continuation.mjs is not run on ordinary Stop/subagent/review rounds', async () => {
    const content = await readFile(skillPath('loop'), 'utf8');
    const idx = content.indexOf('continuation.mjs');
    expect(idx, 'continuation.mjs not named in loop/SKILL.md').toBeGreaterThan(-1);
    const nearby = content.slice(Math.max(0, idx - 800), idx + 2000);
    expect(nearby).toMatch(/not\b[^.]{0,160}\b(stop|round)\b/is);
    expect(nearby).toMatch(/subagent/i);
    expect(nearby).toMatch(/review/i);
  });
});
