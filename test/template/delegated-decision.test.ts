// RP-340: a delegated owner's decision must survive compaction, session
// replacement and cold-start resume without depending on conversational
// memory. `run-state-authority.test.ts` pins the per-run "is this run
// delegated" fact; this file pins the other half — the DURABLE evidence a
// resolved decision leaves behind, in `<project root>/.rig/decisions/
// <ticket>.jsonl`, consumable by a fresh controller that never saw the
// session that made the call.
//
// This is built on the RP-339 authority contract
// (`.claude/scripts/lib/authority.mjs`, see `authority.test.ts`): a decision
// may be recorded only when the run's own authority — `run-state.mjs`'s
// `decisionAuthority`, absent reads as `owner` — is exactly `delegated`, and
// only for an id `DELEGABLE_DECISIONS` names; the `NON_DELEGABLE_BOUNDARIES`
// ids (`publication`, `kill-switch`, …) are refused regardless, and an id
// neither list names is refused as unknown to the contract at all — mirroring
// `mayResolve`'s own three-way split, without ever calling it as the oracle
// for what this suite expects (`invariants.md`'s independent-oracle rule):
// every refusal and every stored shape below is asserted against the
// literal contract text, not against `authority.mjs`'s own answer.
//
// `.claude/scripts/delegated-decision.mjs` now exists (RP-340). This file
// also carries the RP-340 round-1 gate's security/code/advisory findings as
// failing tests against that existing implementation — each new or changed
// case below is expected to fail for a behavioural reason (a missing
// refusal, a missing flag, a wrong message), never because the module
// cannot be imported or spawned. The CLI this file assumes:
//
//   node delegated-decision.mjs record --ticket <id> --decision <kind>
//        --summary <text> [--evidence <text>] [--release <label>] [--post]
//   node delegated-decision.mjs list --ticket <id> [--json]
//
// and the pure helpers:
//
//   decisionsPathFor(projectRoot, ticket) -> string   (throws on an unsafe ticket)
//   parseDecisions(text, { ticket }?) -> { ok: true, records } | { ok: false, line, reason }
//
// Redaction mirrors `continuation.mjs`'s conventions (its own header is the
// canonical statement of the whole-field-credential / path-shape / newline
// rules) — this file never re-derives that logic, it only asserts the
// observable result through the CLI, and the credential fixture is assembled
// at runtime (`secrets-fixtures.ts`) so this file itself carries no
// committable secret shape.
import { execFile, execFileSync } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fifosAvailable, skipUnless, symlinksAvailable } from '../helpers/env.js';
import { stubCommand } from '../helpers/stub-command.js';
import { GITHUB_PAT } from './secrets-fixtures.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const delegatedDecisionScript = scriptPath('delegated-decision.mjs');

const { withoutGitLocation } = (await import(pathToFileURL(scriptPath('git-env.mjs')).href)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
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

const runCli = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  run(process.execPath, [delegatedDecisionScript, ...args], cwd, env);

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

/** A fresh git project: `dir` is the project root (and the git toplevel). */
const newProject = async (): Promise<{ dir: string; branch: string; head: string }> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'delegated-decision-repo-')));
  await git(['init', '-q', '-b', 'master'], dir);
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await git(['add', 'README.md'], dir);
  await git(['commit', '-q', '-m', 'seed'], dir);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const head = await git(['rev-parse', 'HEAD'], dir);
  return { dir, branch, head };
};

/** A fresh run directory, never shared between tests and never exported globally. */
const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'delegated-decision-run-'));

const writeRunState = (runDir: string, state: Record<string, unknown>) =>
  writeFile(path.join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

/** `RIG_RUN_DIR` is set ONLY for this one spawn — never on `process.env`. */
const envFor = (runDir: string | undefined): NodeJS.ProcessEnv => {
  const env = withoutGitLocation();
  if (runDir !== undefined) env.RIG_RUN_DIR = runDir;
  else delete env.RIG_RUN_DIR;
  return env;
};

const decisionsFile = (projectDir: string, ticket: string) =>
  path.join(projectDir, '.rig', 'decisions', `${ticket}.jsonl`);

const readDecisionLines = async (projectDir: string, ticket: string): Promise<unknown[]> =>
  (await readFile(decisionsFile(projectDir, ticket), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

type RecordArgs = {
  ticket?: string;
  decision?: string;
  summary?: string;
  evidence?: string;
  release?: string;
  post?: boolean;
};

const recordArgs = ({
  ticket,
  decision,
  summary,
  evidence,
  release,
  post,
}: RecordArgs): string[] => {
  const args = ['record'];
  if (ticket !== undefined) args.push('--ticket', ticket);
  if (decision !== undefined) args.push('--decision', decision);
  if (summary !== undefined) args.push('--summary', summary);
  if (evidence !== undefined) args.push('--evidence', evidence);
  if (release !== undefined) args.push('--release', release);
  if (post) args.push('--post');
  return args;
};

/** Set up a delegated run against a fresh project, ready to record. */
const delegatedFixture = async (): Promise<{
  dir: string;
  branch: string;
  head: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
}> => {
  const { dir, branch, head } = await newProject();
  const runDir = await newRunDir();
  await writeRunState(runDir, { decisionAuthority: 'delegated' });
  return { dir, branch, head, runDir, env: envFor(runDir) };
};

// --- record: refusals ------------------------------------------------------

describe('delegated-decision.mjs record — refusals write nothing and journal nothing', () => {
  it('refuses with no RIG_RUN_DIR declared', async () => {
    const { dir } = await newProject();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).toMatch(/RIG_RUN_DIR/);
  });

  it('refuses when the run authority is absent (reads as owner), naming owner', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).toMatch(/owner/i);
    await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
  });

  it('refuses when the run authority is explicitly owner, naming owner', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'owner' });
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).toMatch(/owner/i);
  });

  it('refuses when the recorded authority word is unrecognised, naming the word it found', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'nonsense' });
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).toMatch(/nonsense/);
  });

  const NON_DELEGABLE = ['publication', 'kill-switch', 'never-rule', 'credential-protection'];
  it.each(NON_DELEGABLE)(
    'refuses a non-delegable boundary id (%s) even under a delegated authority',
    async (decisionId) => {
      const { dir, env } = await delegatedFixture();
      const result = await runCli(
        recordArgs({ ticket: 'RP-1', decision: decisionId, summary: 'ok' }),
        dir,
        env,
      );
      expect(result.code, result.out).toBe(1);
      expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
        /Cannot find module|MODULE_NOT_FOUND/,
      );
      await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
    },
  );

  it('refuses a decision id the contract does not name at all, naming it', async () => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'publish-to-npm', summary: 'ok' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).toContain('publish-to-npm');
  });

  it('refuses with no --ticket at all', async () => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
  });

  const UNSAFE_TICKETS = ['../x', 'a/b', 'RP-1/../../etc', '', 'T'.repeat(65)];
  it.each(UNSAFE_TICKETS)('refuses an unsafe ticket id %j', async (ticket) => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket, decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
  });

  it('refuses with no --summary at all', async () => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
  });

  it('refuses with an empty --summary', async () => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: '' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
  });

  it('refuses a whitespace-only --summary before writing a decision or journal event', async () => {
    const { dir, runDir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: '   ' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();

    const { readRun } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      readRun: (input: { runDir: string }) => { decisions: unknown[]; events: unknown[] };
    };
    expect(readRun({ runDir })).toMatchObject({ decisions: [], events: [] });
  });

  it('a refused call journals nothing into the run directory either', async () => {
    const { dir, runDir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'publication', summary: 'ok' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );

    const { readRun } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      readRun: (input: { runDir: string }) => { decisions: unknown[]; events: unknown[] };
    };
    // A run directory that never recorded anything (mkdtemp made the
    // directory; nothing has written into it) reads back as no decisions at
    // all — `readRun` only requires the directory to exist.
    const { decisions, events } = readRun({ runDir });
    expect(decisions).toEqual([]);
    // RP-340 round 1: the durable trace moved from decisions.jsonl to
    // events.jsonl (see "journals exactly one EVENT" below) — a refused call
    // must journal nothing in EITHER file.
    expect(events).toEqual([]);
  });
});

// --- record: ticket hardening -------------------------------------------

describe('delegated-decision.mjs record — ticket hardening (RP-340 round 1)', () => {
  it('refuses a credential-shaped ticket id, assembled at runtime, and creates no file', async () => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: GITHUB_PAT, decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    await expect(readFile(decisionsFile(dir, GITHUB_PAT), 'utf8')).rejects.toThrow();
  });

  const WINDOWS_DEVICE_NAMES = ['CON', 'con', 'NUL', 'AUX', 'PRN', 'COM1', 'LPT9'];
  it.each(WINDOWS_DEVICE_NAMES)(
    'refuses the Windows reserved device name %j used as a ticket id',
    async (ticket) => {
      const { dir, env } = await delegatedFixture();
      const result = await runCli(
        recordArgs({ ticket, decision: 'extra-gate-round', summary: 'ok' }),
        dir,
        env,
      );
      expect(result.code, result.out).toBe(1);
      expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
        /Cannot find module|MODULE_NOT_FOUND/,
      );
      await expect(readFile(decisionsFile(dir, ticket), 'utf8')).rejects.toThrow();
    },
  );

  it('refuses --ticket given with no value at all, without the message saying "undefined"', async () => {
    const { dir, env } = await delegatedFixture();
    // `--ticket` is deliberately the LAST argument, with nothing after it —
    // the shape that makes `argv[i += 1]` read past the end of argv.
    const result = await runCli(
      ['record', '--decision', 'extra-gate-round', '--summary', 'ok', '--ticket'],
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).not.toMatch(/undefined/);
  });
});

// --- record: must not follow a symlink (RP-340 round 1, security) ------

describe('delegated-decision.mjs record — never follows a symlink out of the project, and writes nothing outside it', () => {
  // Round 2 (security-scanner): on Windows O_NOFOLLOW does not exist, so an
  // open-flag defence alone leaves the append following a link there. A hard
  // link needs no privilege on NTFS or POSIX, so this case runs on every
  // platform: the ticket file must be refused when it is a second name for
  // an inode outside the project.
  it('refuses when the ticket file is a hard link to a file outside the project, on every platform', async () => {
    const { dir, runDir } = await delegatedFixture();
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'delegated-decision-outside-'));
    const outsideFile = path.join(outsideDir, 'victim.txt');
    const original = 'untouched\n';
    await writeFile(outsideFile, original);
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    await link(outsideFile, decisionsFile(dir, 'RP-1'));

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(await readFile(outsideFile, 'utf8')).toBe(original);
  });

  it('refuses when .rig itself is a symlink to a directory outside the project', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const { dir, runDir } = await delegatedFixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'delegated-decision-outside-'));
    await symlink(
      outside,
      path.join(dir, '.rig'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/symlink|not a (regular )?director/i);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses when .rig/decisions is a symlink to a directory outside the project', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const { dir, runDir } = await delegatedFixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'delegated-decision-outside-'));
    await mkdir(path.join(dir, '.rig'), { recursive: true });
    await symlink(
      outside,
      path.join(dir, '.rig', 'decisions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/symlink|not a (regular )?director/i);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses when the ticket decisions file is a symlink to a file outside the project, leaving the outside file untouched', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const { dir, runDir } = await delegatedFixture();
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'delegated-decision-outside-'));
    const outsideFile = path.join(outsideDir, 'target.jsonl');
    const original = 'outside-original\n';
    await writeFile(outsideFile, original);
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    await symlink(outsideFile, decisionsFile(dir, 'RP-1'));

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/symlink|not a (regular )?director/i);
    expect(await readFile(outsideFile, 'utf8')).toBe(original);
  });
});

// --- record: success ---------------------------------------------------

describe('delegated-decision.mjs record — durable evidence on success', () => {
  it('appends exactly one line with exactly the named keys, in order (incl. release), and exits 0 naming ticket/decision/file', async () => {
    const { dir, branch, head, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'round 4 is justified',
        release: 'rel-1.5.0',
      }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('RP-1');
    expect(result.stdout).toContain('extra-gate-round');
    // The file is named relative to the project root (round 1: never the
    // absolute machine path) — see "prints the decisions file path relative
    // to the project root, never absolute".
    expect(result.stdout).toContain(path.join('.rig', 'decisions', 'RP-1.jsonl'));

    const lines = await readDecisionLines(dir, 'RP-1');
    expect(lines).toHaveLength(1);
    const record = lines[0] as Record<string, unknown>;
    expect(Object.keys(record)).toEqual([
      'schemaVersion',
      'ticket',
      'release',
      'decision',
      'authority',
      'summary',
      'evidence',
      'branch',
      'head',
      'at',
    ]);
    expect(record).toMatchObject({
      schemaVersion: 1,
      ticket: 'RP-1',
      release: 'rel-1.5.0',
      decision: 'extra-gate-round',
      authority: 'delegated',
      summary: 'round 4 is justified',
      evidence: null,
      branch,
      head,
    });
    expect(() => new Date(record.at as string).toISOString()).not.toThrow();
    expect(new Date(record.at as string).toISOString()).toBe(record.at);
  });

  it('stores release: null when --release is not given at all', async () => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'no release yet' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(0);
    const lines = await readDecisionLines(dir, 'RP-1');
    const record = lines[0] as Record<string, unknown>;
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(Object.keys(record)).toContain('release');
    expect(record.release).toBeNull();
  });

  const VALID_RELEASE_LABELS = ['rel-1.5.0', 'A', '0abc', 'x.y_z-9', 'T'.repeat(64)];
  it.each(VALID_RELEASE_LABELS)('accepts the well-formed --release label %j', async (release) => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok', release }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(0);
    const lines = await readDecisionLines(dir, 'RP-1');
    const record = lines[0] as Record<string, unknown>;
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(record.release).toBe(release);
  });

  const INVALID_RELEASE_LABELS = [
    '',
    'rel 1.5.0',
    '-leading-hyphen',
    '.leading-dot',
    '../x',
    'a/b',
    'T'.repeat(65),
    'café',
  ];
  it.each(INVALID_RELEASE_LABELS)(
    'refuses the unsafe --release label %j and writes nothing',
    async (release) => {
      const { dir, env } = await delegatedFixture();
      const result = await runCli(
        recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok', release }),
        dir,
        env,
      );
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
        /Cannot find module|MODULE_NOT_FOUND/,
      );
      await expect(readFile(decisionsFile(dir, 'RP-1'), 'utf8')).rejects.toThrow();
    },
  );

  it('a second record for the same ticket APPENDS a second line, never rewriting the first', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'first' }),
      dir,
      env,
    );
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'work-sequencing', summary: 'second' }),
      dir,
      env,
    );

    const lines = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ decision: 'extra-gate-round', summary: 'first' });
    expect(lines[1]).toMatchObject({ decision: 'work-sequencing', summary: 'second' });
  });

  it('records --evidence verbatim (through the same redaction pipeline) when given', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'short',
        evidence: 'journal/2026-10.md#RP-1',
      }),
      dir,
      env,
    );
    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(record.evidence).toBe('journal/2026-10.md#RP-1');
  });

  it('journals exactly one run-journal EVENT (kind: delegated-decision), and writes NOTHING to decisions.jsonl', async () => {
    const { dir, runDir, env } = await delegatedFixture();
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'round 4 is justified',
        release: 'rel-1.5.0',
      }),
      dir,
      env,
    );

    const { readRun } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      readRun: (input: { runDir: string }) => {
        decisions: Array<Record<string, unknown>>;
        events: Array<Record<string, unknown>>;
      };
    };
    const { decisions, events } = readRun({ runDir });
    // RP-340 round 1 (advisory): the run-journal record moves from
    // decisions.jsonl to events.jsonl so a continuation note's review-round
    // reading (which reads decisions.jsonl) is not disturbed.
    expect(decisions).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'delegated-decision',
      data: {
        ticket: 'RP-1',
        release: 'rel-1.5.0',
        decision: 'extra-gate-round',
        summary: 'round 4 is justified',
      },
    });
  });

  it('works with no .claude/queue.json present at all when --post is not given', async () => {
    const { dir, env } = await delegatedFixture();
    await expect(readFile(path.join(dir, '.claude', 'queue.json'), 'utf8')).rejects.toThrow();

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'no adapter needed' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(0);
  });

  it('prints the decisions file path relative to the project root, never absolute', async () => {
    const { dir, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain(path.join('.rig', 'decisions', 'RP-1.jsonl'));
    expect(result.stdout).not.toContain(dir);
  });

  // --- bounded and redacted, mirroring continuation.mjs's conventions -----

  it('redacts a credential-shaped summary as exactly [redacted], never printing the value', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: `rotated the leaked token ${GITHUB_PAT} before merging`,
      }),
      dir,
      env,
    );
    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(record.summary).toBe('[redacted]');
    expect(JSON.stringify(record)).not.toContain(GITHUB_PAT);
  });

  it('redacts a credential-shaped evidence value as exactly [redacted]', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'short',
        evidence: GITHUB_PAT,
      }),
      dir,
      env,
    );
    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(record.evidence).toBe('[redacted]');
  });

  it('scrubs an absolute POSIX path to [path]', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: '/Users/someone/secret/dir',
      }),
      dir,
      env,
    );
    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(record.summary).toBe('[path]');
  });

  it('scrubs an absolute Windows drive path to [path]', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'C:\\Users\\x\\y',
      }),
      dir,
      env,
    );
    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(record.summary).toBe('[path]');
  });

  it('collapses an embedded newline so the stored summary contains no \\n', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'line one\nline two',
      }),
      dir,
      env,
    );
    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    expect(record.summary as string).not.toContain('\n');
  });

  it('caps a 5000-character summary at 500 characters with an explicit [truncated] marker', async () => {
    const { dir, env } = await delegatedFixture();
    const long = 'a'.repeat(5000);
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: long }),
      dir,
      env,
    );

    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    const summary = record.summary as string;
    expect(summary).toContain('[truncated]');
    expect(summary.length).toBeLessThanOrEqual(500 + '[truncated]'.length);
  });

  it('caps a 5000-character evidence value the same way', async () => {
    const { dir, env } = await delegatedFixture();
    const long = 'b'.repeat(5000);
    await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'short',
        evidence: long,
      }),
      dir,
      env,
    );
    const records = (await readDecisionLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    const record = records[0];
    if (!record) throw new Error('expected exactly one recorded decision, found none');
    const evidence = record.evidence as string;
    expect(evidence).toContain('[truncated]');
    expect(evidence.length).toBeLessThanOrEqual(500 + '[truncated]'.length);
  });
});

// --- record --post (RP-340 round 1, code) --------------------------------
//
// `--post` is resolved exactly the way `continuation.mjs --post` resolves
// one — `queue/index.mjs`'s `loadConfig` + `resolveAdapter`, then that
// adapter's `comment()`. The three adapter outcomes below mirror
// `continuation.test.ts`'s own seams for the same three adapters:
//   - plan-md's `comment()` always answers `{ ok: false, why }` — the only
//     adapter in this codebase that can answer ok:false without a
//     production change (`continuation.test.ts` ›
//     "--post on the plan-md adapter refuses to post, and still prints the
//     note" uses the same adapter for the same reason);
//   - jira's `comment()` throws when the required env vars are absent
//     (`continuation.test.ts` › "without --post, never touches the network
//     — no adapter call is made" and the --ticket-validation test above it
//     use the exact same missing-env seam);
//   - github-issues' `comment()` is the only adapter that can SUCCEED
//     without a production change, so it is the seam proposed here (no
//     existing continuation.test.ts case captures a posted comment body) to
//     capture the body actually posted: a `gh` stub installed via the
//     shared `stubCommand` helper (`test/helpers/stub-command.ts`, already
//     used the same way in `spec-kit-import.test.ts` and
//     `queue-github-pagination.test.ts`) logs the `issue comment --body
//     <text>` invocation to a file this test reads back.
describe('delegated-decision.mjs record --post (RP-340 round 1)', () => {
  it('(a) under a plan-md queue config, the record is still written, the process exits 1, and stderr says recorded but NOT posted', async () => {
    const { dir, env } = await delegatedFixture();
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'plan-md' }),
    );
    await writeFile(path.join(dir, 'PLAN.md'), '## Agent queue\n\n');

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok', post: true }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/recorded/i);
    expect(result.out).toMatch(/not posted/i);

    const lines = await readDecisionLines(dir, 'RP-1');
    expect(lines).toHaveLength(1);
  });

  it("(b) surfaces the adapter's own reason when it answers ok:false (plan-md, the only such adapter available here)", async () => {
    const { dir, env } = await delegatedFixture();
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'plan-md' }),
    );
    await writeFile(path.join(dir, 'PLAN.md'), '## Agent queue\n\n');

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok', post: true }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('PLAN.md has no comment thread');
  });

  it('(c) under an adapter whose comment() throws (jira, missing credentials), the record is still written and the process says recorded but NOT posted', async () => {
    const { dir, env } = await delegatedFixture();
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'queue.json'), JSON.stringify({ adapter: 'jira' }));
    const postEnv = { ...env };
    delete postEnv.JIRA_BASE_URL;
    delete postEnv.JIRA_EMAIL;
    delete postEnv.JIRA_API_TOKEN;

    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'ok', post: true }),
      dir,
      postEnv,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/recorded/i);
    expect(result.out).toMatch(/not posted/i);

    const lines = await readDecisionLines(dir, 'RP-1');
    expect(lines).toHaveLength(1);
  });

  it('(d) the posted comment body starts with "rig-delegated-decision v1" and carries ticket/decision/authority/summary lines, redacted exactly as the stored record', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'delegated' });
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'github-issues' }),
    );

    const callsDir = await mkdtemp(path.join(tmpdir(), 'delegated-decision-gh-calls-'));
    const callsPath = path.join(callsDir, 'calls.log');
    const stub = await stubCommand(
      'gh',
      `const fs = require('node:fs');
       const callsPath = ${JSON.stringify(callsPath)};
       if (args[0] === 'issue' && args[1] === 'comment') {
         fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
         return { stdout: '' };
       }
       if (args[0] === 'issue' && args[1] === 'view') {
         return { stdout: JSON.stringify({ updatedAt: new Date().toISOString() }) + '\\n' };
       }
       return { stdout: '' };`,
    );
    try {
      // Built AFTER the stub is installed, so the PATH it captures (via
      // `withoutGitLocation()`'s default `process.env` spread) includes it.
      const env = envFor(runDir);
      const result = await runCli(
        recordArgs({
          ticket: 'RP-1',
          decision: 'extra-gate-round',
          // Round 2: a summary the redaction actually changes, so a body built
          // from the raw argument instead of the stored record goes red.
          summary: `rotated the leaked token ${GITHUB_PAT} before merging`,
          post: true,
        }),
        dir,
        env,
      );
      expect(result.code, result.out).toBe(0);

      const raw = await readFile(callsPath, 'utf8');
      expect(raw, 'the raw credential never reaches gh').not.toContain(GITHUB_PAT);
      const calls = raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[]);
      const commentCall = calls.find((call) => call[0] === 'issue' && call[1] === 'comment');
      if (!commentCall) throw new Error(`gh issue comment was never invoked: ${raw}`);
      const bodyIndex = commentCall.indexOf('--body');
      const body = bodyIndex === -1 ? undefined : commentCall[bodyIndex + 1];
      if (body === undefined) throw new Error(`no --body argument found: ${commentCall.join(' ')}`);

      const bodyLines = body.split('\n');
      expect(bodyLines[0]).toBe('rig-delegated-decision v1');
      expect(body).toMatch(/^ticket: RP-1$/m);
      expect(body).toMatch(/^decision: extra-gate-round$/m);
      expect(body).toMatch(/^authority: delegated$/m);
      expect(body).toMatch(/^summary: \[redacted\]$/m);
      const [stored] = await readDecisionLines(dir, 'RP-1');
      expect((stored as { summary: string }).summary).toBe('[redacted]');
    } finally {
      stub.restore();
    }
  });
});

// --- list --------------------------------------------------------------

describe('delegated-decision.mjs list — a fresh controller tells made from unresolved', () => {
  it('an unresolved ticket (no file at all) reports an empty array, exit 0', async () => {
    const { dir } = await newProject();
    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-404', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('a made decision is returned by --json, in file order', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'first' }),
      dir,
      env,
    );
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'work-sequencing', summary: 'second' }),
      dir,
      env,
    );

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-1', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(0);
    const records = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ decision: 'extra-gate-round', summary: 'first' });
    expect(records[1]).toMatchObject({ decision: 'work-sequencing', summary: 'second' });
  });

  it('a FRESH process with no RIG_RUN_DIR at all still reads the made decision — durable, not conversational', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'made it' }),
      dir,
      env,
    );

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-1', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(0);
    const records = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
  });

  it('a FRESH run directory (a different controller session) still reads the made decision', async () => {
    const { dir, env } = await delegatedFixture();
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'made it' }),
      dir,
      env,
    );

    const freshRunDir = await newRunDir();
    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-1', '--json'],
      dir,
      envFor(freshRunDir),
    );
    expect(result.code, result.out).toBe(0);
    const records = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
  });

  it('a line that is not valid JSON is unreadable — exit 2, names "unreadable" and the line number', async () => {
    const { dir } = await newProject();
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    await writeFile(
      decisionsFile(dir, 'RP-9'),
      `${JSON.stringify({
        schemaVersion: 1,
        ticket: 'RP-9',
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary: 'ok',
        evidence: null,
        branch: 'master',
        head: 'deadbeef',
        at: new Date().toISOString(),
      })}\nnot json at all\n`,
    );

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
    expect(result.out).toContain('2');
  });

  it('a line missing a required key is unreadable — exit 2, names the line number', async () => {
    const { dir } = await newProject();
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    await writeFile(
      decisionsFile(dir, 'RP-9'),
      `${JSON.stringify({ ticket: 'RP-9', decision: 'extra-gate-round' })}\n`,
    );

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
    expect(result.out).toContain('1');
  });

  it('a file larger than 256 KiB is unreadable — exit 2, never partially read', async () => {
    const { dir } = await newProject();
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    const validLine = `${JSON.stringify({
      schemaVersion: 1,
      ticket: 'RP-9',
      decision: 'extra-gate-round',
      authority: 'delegated',
      summary: 'ok',
      evidence: null,
      branch: 'master',
      head: 'deadbeef',
      at: new Date().toISOString(),
    })}\n`;
    const repeats = Math.ceil((256 * 1024 + 1024) / validLine.length);
    await writeFile(decisionsFile(dir, 'RP-9'), validLine.repeat(repeats));

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });
});

// --- list: never follows a symlink, never reads a non-regular file -------
// (RP-340 round 1, security) — mirrors `run-state.mjs`'s
// `readStateForSelection` lstat-before-open posture, applied to the one
// file this module reads for a fresh controller.

describe('delegated-decision.mjs list — never follows a symlink, and never reads a non-regular file', () => {
  it("a .rig directory junction to a different checkout is unreadable — exit 2, never that checkout's decision", async () => {
    const { dir } = await newProject();
    const outside = await mkdtemp(path.join(tmpdir(), 'delegated-decision-other-checkout-'));
    const outsideDecisions = path.join(outside, 'decisions');
    await mkdir(outsideDecisions);
    await writeFile(
      path.join(outsideDecisions, 'RP-9.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        ticket: 'RP-9',
        release: null,
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary: 'belongs below the other checkout rig directory',
        evidence: null,
        branch: 'master',
        head: 'deadbeef',
        at: new Date().toISOString(),
      })}\n`,
    );
    await symlink(
      outside,
      path.join(dir, '.rig'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
    expect(result.stdout).not.toContain('belongs below the other checkout rig directory');
  });

  it("a .rig/decisions directory junction to a different checkout is unreadable — exit 2, never that checkout's decision", async () => {
    const { dir } = await newProject();
    const outside = await mkdtemp(path.join(tmpdir(), 'delegated-decision-other-checkout-'));
    await writeFile(
      path.join(outside, 'RP-9.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        ticket: 'RP-9',
        release: null,
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary: 'belongs to the other checkout',
        evidence: null,
        branch: 'master',
        head: 'deadbeef',
        at: new Date().toISOString(),
      })}\n`,
    );
    await mkdir(path.join(dir, '.rig'), { recursive: true });
    await symlink(
      outside,
      path.join(dir, '.rig', 'decisions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
    expect(result.stdout).not.toContain('belongs to the other checkout');
  });

  it("a ticket file hard-linked from another checkout is unreadable — exit 2, never that checkout's decision", async () => {
    const { dir } = await newProject();
    const outside = await mkdtemp(path.join(tmpdir(), 'delegated-decision-other-checkout-'));
    const outsideFile = path.join(outside, 'RP-9.jsonl');
    await writeFile(
      outsideFile,
      `${JSON.stringify({
        schemaVersion: 1,
        ticket: 'RP-9',
        release: null,
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary: 'hard-linked from the other checkout',
        evidence: null,
        branch: 'master',
        head: 'deadbeef',
        at: new Date().toISOString(),
      })}\n`,
    );
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    await link(outsideFile, decisionsFile(dir, 'RP-9'));

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
    expect(result.stdout).not.toContain('hard-linked from the other checkout');
  });

  it("a symlink to a regular file elsewhere is unreadable — exit 2, never the target's own content", async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const { dir } = await newProject();
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'delegated-decision-outside-'));
    const outsideFile = path.join(outsideDir, 'target.jsonl');
    await writeFile(
      outsideFile,
      `${JSON.stringify({
        schemaVersion: 1,
        ticket: 'RP-9',
        release: null,
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary: 'ok',
        evidence: null,
        branch: 'master',
        head: 'deadbeef',
        at: new Date().toISOString(),
      })}\n`,
    );
    await symlink(outsideFile, decisionsFile(dir, 'RP-9'));

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });

  it('a directory in place of the decisions file is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await mkdir(decisionsFile(dir, 'RP-9'), { recursive: true });

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });

  it('a FIFO with no writer is unreadable — exit 2 within a bound, never hanging inside open()', async (ctx) => {
    const fifos = fifosAvailable();
    skipUnless(ctx, fifos.ok, fifos.reason);
    const BOUND_MS = 8_000;
    const { dir } = await newProject();
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    execFileSync('mkfifo', [decisionsFile(dir, 'RP-9')]);

    const startedAt = Date.now();
    const result = await new Promise<RunResult & { killed: boolean }>((resolve) => {
      execFile(
        process.execPath,
        [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
        { cwd: dir, env: withoutGitLocation(), timeout: BOUND_MS, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
            out: stdout + stderr,
            killed: Boolean((error as { signal?: string } | null)?.signal),
          });
        },
      );
    });
    const elapsedMs = Date.now() - startedAt;

    expect(
      result.killed,
      `the CLI had to be killed after ${elapsedMs}ms instead of refusing promptly: ${result.out.slice(0, 500)}`,
    ).toBe(false);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });
});

// --- list: refuses a forged record as unreadable (RP-340 round 1, security)

describe('delegated-decision.mjs list — refuses a forged record as unreadable', () => {
  const writeForgedLine = async (
    dir: string,
    ticket: string,
    overrides: Record<string, unknown>,
  ) => {
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    const record = {
      schemaVersion: 1,
      ticket,
      release: null,
      decision: 'extra-gate-round',
      authority: 'delegated',
      summary: 'ok',
      evidence: null,
      branch: 'master',
      head: 'deadbeef',
      at: new Date().toISOString(),
      ...overrides,
    };
    await writeFile(decisionsFile(dir, ticket), `${JSON.stringify(record)}\n`);
  };

  it('refuses a record whose authority is not exactly "delegated"', async () => {
    const { dir } = await newProject();
    await writeForgedLine(dir, 'RP-9', { authority: 'owner' });

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });

  it('refuses a record whose ticket differs from the requested --ticket', async () => {
    const { dir } = await newProject();
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    const record = {
      schemaVersion: 1,
      ticket: 'RP-2',
      release: null,
      decision: 'extra-gate-round',
      authority: 'delegated',
      summary: 'ok',
      evidence: null,
      branch: 'master',
      head: 'deadbeef',
      at: new Date().toISOString(),
    };
    // Filed under RP-1's own path — only the record's OWN ticket field says RP-2.
    await writeFile(decisionsFile(dir, 'RP-1'), `${JSON.stringify(record)}\n`);

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-1', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });

  it('refuses a record whose decision is a non-delegable boundary id (publication)', async () => {
    const { dir } = await newProject();
    await writeForgedLine(dir, 'RP-9', { decision: 'publication' });

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });

  it('refuses a record whose decision id the contract does not name at all', async () => {
    const { dir } = await newProject();
    await writeForgedLine(dir, 'RP-9', { decision: 'invent-a-decision-id' });

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unreadable/i);
  });

  it('still lists a well-formed delegated record of a delegable kind', async () => {
    const { dir } = await newProject();
    await writeForgedLine(dir, 'RP-9', { release: null });

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(0);
    const records = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
  });
});

// --- list: human output escapes control characters (RP-340 round 1, security)

describe('delegated-decision.mjs list — human (non-JSON) output escapes control characters', () => {
  it('never prints a raw ESC byte from a summary that carries one', async () => {
    const { dir } = await newProject();
    await mkdir(path.join(dir, '.rig', 'decisions'), { recursive: true });
    const summary = 'before\u001bafter';
    await writeFile(
      decisionsFile(dir, 'RP-9'),
      `${JSON.stringify({
        schemaVersion: 1,
        ticket: 'RP-9',
        release: null,
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary,
        evidence: null,
        branch: 'master',
        head: 'deadbeef',
        at: new Date().toISOString(),
      })}\n`,
    );

    const result = await run(
      process.execPath,
      [delegatedDecisionScript, 'list', '--ticket', 'RP-9'],
      dir,
      withoutGitLocation(),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
  });
});

// --- pure helpers --------------------------------------------------------

describe('delegated-decision.mjs — exported pure helpers', () => {
  it('decisionsPathFor builds <projectRoot>/.rig/decisions/<ticket>.jsonl', async () => {
    const { decisionsPathFor } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      decisionsPathFor: (projectRoot: string, ticket: string) => string;
    };
    expect(decisionsPathFor('/repo', 'RP-340')).toBe(
      path.join('/repo', '.rig', 'decisions', 'RP-340.jsonl'),
    );
  });

  const UNSAFE_TICKETS = ['../x', 'a/b', 'RP-1/../../etc', '', 'T'.repeat(65), '.', '..'];
  it.each(UNSAFE_TICKETS)('decisionsPathFor throws on the unsafe ticket %j', async (ticket) => {
    const { decisionsPathFor } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      decisionsPathFor: (projectRoot: string, ticket: string) => string;
    };
    expect(() => decisionsPathFor('/repo', ticket)).toThrow();
  });

  it('decisionsPathFor accepts a ticket at exactly the 64-character bound', async () => {
    const { decisionsPathFor } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      decisionsPathFor: (projectRoot: string, ticket: string) => string;
    };
    const ticket = `T${'0'.repeat(63)}`;
    expect(ticket).toHaveLength(64);
    expect(() => decisionsPathFor('/repo', ticket)).not.toThrow();
  });

  it('parseDecisions reads a well-formed multi-line file as ok: true, records in file order', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: (
        text: string,
      ) => { ok: true; records: unknown[] } | { ok: false; line: number; reason: string };
    };
    const line = (summary: string) =>
      JSON.stringify({
        schemaVersion: 1,
        ticket: 'RP-1',
        release: null,
        decision: 'extra-gate-round',
        authority: 'delegated',
        summary,
        evidence: null,
        branch: 'master',
        head: 'deadbeef',
        at: new Date().toISOString(),
      });
    const result = parseDecisions(`${line('a')}\n${line('b')}\n`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toHaveLength(2);
  });

  it('parseDecisions reports ok: false with the 1-based line number for invalid JSON', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: (
        text: string,
      ) => { ok: true; records: unknown[] } | { ok: false; line: number; reason: string };
    };
    const result = parseDecisions('{"valid":true}\nnot json\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.line).toBe(2);
  });

  it('parseDecisions reports ok: false for a line missing a required key', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: (
        text: string,
      ) => { ok: true; records: unknown[] } | { ok: false; line: number; reason: string };
    };
    const result = parseDecisions(`${JSON.stringify({ ticket: 'RP-1' })}\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.line).toBe(1);
  });

  it('parseDecisions on empty text is ok: true with no records', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: (text: string) => { ok: true; records: unknown[] } | { ok: false };
    };
    const result = parseDecisions('');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toEqual([]);
  });

  // --- parseDecisions(text, { ticket }) — RP-340 round 1, security --------

  type ParseDecisionsWithTicket = (
    text: string,
    options?: { ticket?: string },
  ) => { ok: true; records: unknown[] } | { ok: false; line: number; reason: string };

  const forgedLine = (overrides: Record<string, unknown>) =>
    `${JSON.stringify({
      schemaVersion: 1,
      ticket: 'RP-1',
      release: null,
      decision: 'extra-gate-round',
      authority: 'delegated',
      summary: 'ok',
      evidence: null,
      branch: 'master',
      head: 'deadbeef',
      at: new Date().toISOString(),
      ...overrides,
    })}\n`;

  it('parseDecisions(text) rejects unsafe ticket values even without a requested ticket', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    for (const value of [23, '', '../RP-1', 'CON', GITHUB_PAT]) {
      const result = parseDecisions(forgedLine({ ticket: value }));
      expect(result).toMatchObject({
        ok: false,
        line: 1,
        reason: expect.stringMatching(/ticket/i),
      });
    }
  });

  it('parseDecisions rejects a record that omits release, which the writer always persists', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const record = JSON.parse(forgedLine({})) as Record<string, unknown>;
    delete record.release;
    const result = parseDecisions(`${JSON.stringify(record)}\n`, { ticket: 'RP-1' });
    expect(result).toMatchObject({
      ok: false,
      line: 1,
      reason: expect.stringMatching(/release/i),
    });
  });

  it('parseDecisions rejects malformed release values', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    for (const value of [23, {}, [], '', '   ', '../1.5.0']) {
      const result = parseDecisions(forgedLine({ release: value }), { ticket: 'RP-1' });
      expect(result).toMatchObject({
        ok: false,
        line: 1,
        reason: expect.stringMatching(/release/i),
      });
    }
  });

  it('parseDecisions(text, { ticket }) rejects a record whose authority is not exactly "delegated"', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const result = parseDecisions(forgedLine({ authority: 'owner' }), { ticket: 'RP-1' });
    expect(result.ok).toBe(false);
  });

  it('parseDecisions(text, { ticket }) rejects a record whose ticket differs from the one requested', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const result = parseDecisions(forgedLine({ ticket: 'RP-2' }), { ticket: 'RP-1' });
    expect(result.ok).toBe(false);
  });

  it('parseDecisions(text, { ticket }) rejects a non-delegable boundary id', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const result = parseDecisions(forgedLine({ decision: 'publication' }), { ticket: 'RP-1' });
    expect(result.ok).toBe(false);
  });

  it('parseDecisions(text, { ticket }) rejects a decision id the contract does not name at all', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const result = parseDecisions(forgedLine({ decision: 'invent-a-decision-id' }), {
      ticket: 'RP-1',
    });
    expect(result.ok).toBe(false);
  });

  it('parseDecisions(text, { ticket }) still accepts a well-formed delegated record of a delegable kind', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const result = parseDecisions(forgedLine({}), { ticket: 'RP-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toHaveLength(1);
  });

  it('parseDecisions rejects an unsupported decision-record schema version', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const result = parseDecisions(forgedLine({ schemaVersion: 999 }), { ticket: 'RP-1' });
    expect(result).toMatchObject({ ok: false, line: 1, reason: expect.stringMatching(/schema/i) });
  });

  it('parseDecisions rejects malformed typed decision fields', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const malformedFields: Array<['summary' | 'evidence' | 'branch' | 'head' | 'at', unknown]> = [
      ['summary', null],
      ['summary', ''],
      ['summary', '   '],
      ['evidence', {}],
      ['evidence', 23],
      ['branch', 23],
      ['branch', null],
      ['branch', ''],
      ['head', null],
      ['head', 23],
      ['head', ''],
      ['at', 'not-a-date'],
      ['at', null],
      ['at', '2026-02-30T00:00:00.000Z'],
    ];
    for (const [field, value] of malformedFields) {
      const result = parseDecisions(forgedLine({ [field]: value }), { ticket: 'RP-1' });
      expect(result).toMatchObject({
        ok: false,
        line: 1,
        reason: expect.stringMatching(new RegExp(field, 'i')),
      });
    }
  });

  it('parseDecisions accepts a record produced by record, including null evidence and release', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const { dir, env } = await delegatedFixture();
    const recorded = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'writer shape' }),
      dir,
      env,
    );
    expect(recorded.code, recorded.out).toBe(0);

    const result = parseDecisions(await readFile(decisionsFile(dir, 'RP-1'), 'utf8'), {
      ticket: 'RP-1',
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({ evidence: null, release: null });
    }
  });

  it('parseDecisions accepts the exact release redaction the writer persists', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const { dir, env } = await delegatedFixture();
    const recorded = await runCli(
      recordArgs({
        ticket: 'RP-1',
        decision: 'extra-gate-round',
        summary: 'writer redacts a credential-shaped release',
        release: GITHUB_PAT,
      }),
      dir,
      env,
    );
    expect(recorded.code, recorded.out).toBe(0);
    const text = await readFile(decisionsFile(dir, 'RP-1'), 'utf8');
    expect(text).not.toContain(GITHUB_PAT);

    const result = parseDecisions(text, { ticket: 'RP-1' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.records[0]).toMatchObject({ release: '[redacted]' });
  });

  it('parseDecisions reports invalid JSON before it evaluates missing or malformed fields', async () => {
    const { parseDecisions } = (await import(pathToFileURL(delegatedDecisionScript).href)) as {
      parseDecisions: ParseDecisionsWithTicket;
    };
    const incompleteMalformedFirstLine = JSON.stringify({
      schemaVersion: 999,
      ticket: 'RP-1',
      decision: 'extra-gate-round',
      authority: 'delegated',
      branch: 23,
      head: null,
      at: 'not-a-date',
    });
    const result = parseDecisions(`${incompleteMalformedFirstLine}\nnot json\n`, {
      ticket: 'RP-1',
    });
    expect(result).toEqual({ ok: false, line: 2, reason: 'invalid JSON' });
  });
});

// --- recording bypasses nothing: the gates read their own inputs only ----

describe('delegated-decision.mjs — recording bypasses no mechanical gate', () => {
  const GATE_FILES: Array<[string, string]> = [
    ['.claude/scripts/revalidate.mjs', scriptPath('revalidate.mjs')],
    ['.claude/scripts/queue/core.mjs', path.join(queueDir, 'core.mjs')],
    ['.claude/scripts/verdict.mjs', scriptPath('verdict.mjs')],
  ];

  it.each(GATE_FILES)(
    '%s never references .rig/decisions or delegated-decision',
    async (_rel, file) => {
      const content = await readFile(file, 'utf8');
      expect(content).not.toMatch(/\.rig\/decisions/);
      expect(content).not.toMatch(/delegated-decision/);
    },
  );
});

// --- resolve (RP-342): a per-item stop -> one of the three resolutions ----
//
// `node delegated-decision.mjs resolve --stop <id> [--json]` turns a
// `queue/stop-class.mjs` ITEM_STOPS id and this run's declared authority into
// one of `RESOLUTIONS` (`decide-and-continue` | `escalate-item` | `stop-run`).
// It is read-only: unlike `record`, it never touches `.rig/decisions`, the
// run journal, or any other file, and it never refuses on an unrecognised or
// absent authority — only on a missing run directory, a missing --stop
// value, or a stop id the stop-class vocabulary does not name.
//
// The expected resolution per stop/authority pair below is hard-coded in
// this file rather than derived by importing or calling `resolutionOf`
// (`.claude/rules/invariants.md`'s independent-oracle rule): the oracle here
// is the written-down contract in `queue/stop-class.mjs`'s own module header
// and `docs/decisions/decision-authority.md` ("Stop classes"), not the
// production function the CLI itself calls.
describe('delegated-decision.mjs resolve — turns a per-item stop into one of three resolutions', () => {
  // Every ITEM_STOPS id, with its independently-declared expected resolution
  // UNDER DELEGATED AUTHORITY. RP-342 round 1 (controller decision, Jira
  // RP-342 comment 23320): `elevated-path-scope` is now the ONLY catalogued
  // stop that names a decision `DELEGABLE_DECISIONS` lists
  // (`elevated-change-acceptance`), so it is the only one a delegated run may
  // decide and continue past. `gate-round-cap` and `premise-false` now name
  // no delegable decision at all and always escalate, under every
  // authority including `delegated`; the three `work-blocked` stops, the
  // two decision-less `decision-needed`
  // stops (`surprise-scope`, `invariant-conflict`) and `external-blocker`
  // (now `work-blocked`, a per-item wall rather than a run-level one) all
  // always escalate the item — none of them stops the run.
  const UNDER_DELEGATED: Array<[string, string]> = [
    ['gate-round-cap', 'escalate-item'],
    ['premise-false', 'escalate-item'],
    ['elevated-path-scope', 'decide-and-continue'],
    ['three-strikes', 'escalate-item'],
    ['attempt-budget', 'escalate-item'],
    ['blocking-verdict', 'escalate-item'],
    ['surprise-scope', 'escalate-item'],
    ['invariant-conflict', 'escalate-item'],
    ['external-blocker', 'escalate-item'],
  ];

  it.each(UNDER_DELEGATED)(
    'under a delegated authority, %s resolves to %s',
    async (stop, expected) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await writeRunState(runDir, { decisionAuthority: 'delegated' });
      const result = await runCli(['resolve', '--stop', stop, '--json'], dir, envFor(runDir));
      expect(result.code, result.out).toBe(0);
      const parsed = JSON.parse(result.stdout) as { resolution: string };
      expect(parsed.resolution).toBe(expected);
    },
  );

  // RP-342 round 1: `elevated-path-scope` is now the only catalogued stop
  // that can ever decide-and-continue, and only under exactly `delegated`
  // (see UNDER_DELEGATED above). Every other catalogued stop — including
  // `external-blocker`, now `work-blocked` rather than a run-level wall —
  // never resolves to decide-and-continue under any authority, so checking
  // "not decide-and-continue under owner/malformed" for all of them,
  // `elevated-path-scope` included, is this table's job.
  const NEVER_DECIDES_OUTSIDE_DELEGATED = [
    'three-strikes',
    'attempt-budget',
    'blocking-verdict',
    'gate-round-cap',
    'premise-false',
    'elevated-path-scope',
    'surprise-scope',
    'invariant-conflict',
    'external-blocker',
  ];

  it.each(NEVER_DECIDES_OUTSIDE_DELEGATED)(
    'under an owner authority, %s never resolves to decide-and-continue',
    async (stop) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await writeRunState(runDir, { decisionAuthority: 'owner' });
      const result = await runCli(['resolve', '--stop', stop, '--json'], dir, envFor(runDir));
      expect(result.code, result.out).toBe(0);
      const parsed = JSON.parse(result.stdout) as { resolution: string };
      expect(parsed.resolution).not.toBe('decide-and-continue');
    },
  );

  it.each(NEVER_DECIDES_OUTSIDE_DELEGATED)(
    'under a malformed (unrecognised) authority, %s never resolves to decide-and-continue',
    async (stop) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await writeRunState(runDir, { decisionAuthority: 'nonsense' });
      const result = await runCli(['resolve', '--stop', stop, '--json'], dir, envFor(runDir));
      expect(result.code, result.out).toBe(0);
      const parsed = JSON.parse(result.stdout) as { resolution: string };
      expect(parsed.resolution).not.toBe('decide-and-continue');
    },
  );

  // RP-342 round 1: `external-blocker` moved from `hard-external-boundary`
  // to `work-blocked` — it escalates the ITEM under every authority, and
  // never stops the run at all, owner included. These two cases pin that
  // it is specifically NOT `stop-run` (the under-delegated case is pinned
  // by UNDER_DELEGATED above).
  it('external-blocker resolves to escalate-item under owner, never stop-run', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'owner' });
    const result = await runCli(
      ['resolve', '--stop', 'external-blocker', '--json'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { resolution: string };
    expect(parsed.resolution).toBe('escalate-item');
    expect(parsed.resolution).not.toBe('stop-run');
  });

  it('external-blocker resolves to escalate-item under a malformed authority too, never stop-run', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'nonsense' });
    const result = await runCli(
      ['resolve', '--stop', 'external-blocker', '--json'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { resolution: string };
    expect(parsed.resolution).toBe('escalate-item');
    expect(parsed.resolution).not.toBe('stop-run');
  });

  // --- the --json shape, and the pinned key order -------------------------

  it('--json prints exactly { stop, stopClass, decision, authority, resolution }, in that key order', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'delegated' });
    // RP-342 round 1: `elevated-path-scope` is the only catalogued stop that
    // still names a delegable decision, so it is the one that exercises a
    // non-null `decision` and a `decide-and-continue` resolution here.
    const result = await runCli(
      ['resolve', '--stop', 'elevated-path-scope', '--json'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toBe(
      '{"stop":"elevated-path-scope","stopClass":"decision-needed","decision":"elevated-change-acceptance",' +
        '"authority":"delegated","resolution":"decide-and-continue"}\n',
    );
  });

  it('--json prints decision: null for a stop that names no delegable decision at all', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'owner' });
    const result = await runCli(
      ['resolve', '--stop', 'three-strikes', '--json'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toBe(
      '{"stop":"three-strikes","stopClass":"work-blocked","decision":null,' +
        '"authority":"owner","resolution":"escalate-item"}\n',
    );
  });

  it('an absent authority (no state.json at all) reads as owner, exactly as record.mjs reads it', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir(); // no writeRunState call at all
    const result = await runCli(
      ['resolve', '--stop', 'three-strikes', '--json'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { authority: string };
    expect(parsed.authority).toBe('owner');
  });

  it('a malformed authority word is reported back as "unknown", never as owner or delegated', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'nonsense' });
    const result = await runCli(
      ['resolve', '--stop', 'three-strikes', '--json'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { authority: string };
    expect(parsed.authority).toBe('unknown');
  });

  // --- refusals -------------------------------------------------------------

  it('refuses with no RIG_RUN_DIR declared, naming it', async () => {
    const { dir } = await newProject();
    const result = await runCli(['resolve', '--stop', 'three-strikes'], dir, envFor(undefined));
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).toMatch(/RIG_RUN_DIR/);
  });

  it('refuses an unknown stop id, naming it', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'delegated' });
    const result = await runCli(['resolve', '--stop', 'made-up-stop'], dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
      /Cannot find module|MODULE_NOT_FOUND/,
    );
    expect(result.out).toMatch(/made-up-stop/);
  });

  it('refuses a --stop flag with nothing after it', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'delegated' });
    const result = await runCli(['resolve', '--stop'], dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/--stop/);
  });

  it('refuses when --stop is omitted altogether', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'delegated' });
    const result = await runCli(['resolve'], dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/--stop/);
  });

  // --- it is read-only -------------------------------------------------------

  it('writes nothing: no .rig/decisions file, and nothing new in the run directory', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await writeRunState(runDir, { decisionAuthority: 'delegated' });
    const before = (await readdir(runDir)).sort();
    const result = await runCli(
      ['resolve', '--stop', 'gate-round-cap', '--json'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    await expect(readFile(decisionsFile(dir, 'gate-round-cap'), 'utf8')).rejects.toThrow();
    const dotRig = path.join(dir, '.rig');
    await expect(readdir(dotRig)).rejects.toThrow();
    const after = (await readdir(runDir)).sort();
    expect(after).toEqual(before);
  });
});
