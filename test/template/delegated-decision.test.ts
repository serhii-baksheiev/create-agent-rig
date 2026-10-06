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
// `.claude/scripts/delegated-decision.mjs` does not exist yet — every test
// below is expected to fail because the module cannot be imported or
// spawned, exactly as `continuation.test.ts`'s header states for its own
// subject. The CLI this file assumes:
//
//   node delegated-decision.mjs record --ticket <id> --decision <kind>
//        --summary <text> [--evidence <text>] [--post]
//   node delegated-decision.mjs list --ticket <id> [--json]
//
// and the pure helpers:
//
//   decisionsPathFor(projectRoot, ticket) -> string   (throws on an unsafe ticket)
//   parseDecisions(text) -> { ok: true, records } | { ok: false, line, reason }
//
// Redaction mirrors `continuation.mjs`'s conventions (its own header is the
// canonical statement of the whole-field-credential / path-shape / newline
// rules) — this file never re-derives that logic, it only asserts the
// observable result through the CLI, and the credential fixture is assembled
// at runtime (`secrets-fixtures.ts`) so this file itself carries no
// committable secret shape.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
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
  post?: boolean;
};

const recordArgs = ({ ticket, decision, summary, evidence, post }: RecordArgs): string[] => {
  const args = ['record'];
  if (ticket !== undefined) args.push('--ticket', ticket);
  if (decision !== undefined) args.push('--decision', decision);
  if (summary !== undefined) args.push('--summary', summary);
  if (evidence !== undefined) args.push('--evidence', evidence);
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
      readRun: (input: { runDir: string }) => { decisions: unknown[] };
    };
    // A run directory that never recorded anything (mkdtemp made the
    // directory; nothing has written into it) reads back as no decisions at
    // all — `readRun` only requires the directory to exist.
    const { decisions } = readRun({ runDir });
    expect(decisions).toEqual([]);
  });
});

// --- record: success ---------------------------------------------------

describe('delegated-decision.mjs record — durable evidence on success', () => {
  it('appends exactly one line with exactly the named keys, in order, and exits 0 naming ticket/decision/file', async () => {
    const { dir, branch, head, env } = await delegatedFixture();
    const result = await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'round 4 is justified' }),
      dir,
      env,
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('RP-1');
    expect(result.stdout).toContain('extra-gate-round');
    expect(result.stdout).toContain(decisionsFile(dir, 'RP-1'));

    const lines = await readDecisionLines(dir, 'RP-1');
    expect(lines).toHaveLength(1);
    const record = lines[0] as Record<string, unknown>;
    expect(Object.keys(record)).toEqual([
      'schemaVersion',
      'ticket',
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

  it('also journals exactly one run-journal decision — gate: delegated-decision, verdict: the kind, why: the summary', async () => {
    const { dir, runDir, env } = await delegatedFixture();
    await runCli(
      recordArgs({ ticket: 'RP-1', decision: 'extra-gate-round', summary: 'round 4 is justified' }),
      dir,
      env,
    );

    const { readRun } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      readRun: (input: { runDir: string }) => { decisions: Array<Record<string, unknown>> };
    };
    const { decisions } = readRun({ runDir });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      gate: 'delegated-decision',
      verdict: 'extra-gate-round',
      why: 'round 4 is justified',
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
