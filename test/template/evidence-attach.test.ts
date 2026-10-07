// RP-312 slice (b): `.claude/scripts/evidence-attach.mjs` (workflow layer) is
// the item-owned record a producer (a CI run, a scanner, a human reviewer)
// uses to attach ARTIFACT EVIDENCE to a queue item — durably, in
// `<project root>/.rig/evidence/<ticket>.jsonl`, the sibling of
// `.rig/decisions/<ticket>.jsonl` RP-340's `delegated-decision.mjs` built and
// RP-312 slice (a) extracted the filesystem-safety mechanism for
// (`.claude/scripts/lib/item-records.mjs`, see `item-records.test.ts`).
//
// Both the module and its decision record (`docs/decisions/artifact-evidence.md`)
// exist. This file also pins the RP-312 gate-round-2 follow-ups: `attach`
// refuses unless the run journal already records the ticket as SELECTed
// (`queue/index.mjs`'s own `selectedIn` predicate), `--ref` accepts only a
// remote reference, `--advisory-summary` is capped like `delegated-decision.mjs`'s
// `summary`, and a refusal message never carries a raw control character.
//
// The CLI this file assumes (Jira RP-312, design comment 23333):
//
//   node evidence-attach.mjs attach --ticket <id> --kind <token> \
//        --producer <token> --subject-kind <token> --subject-id <text> \
//        [--subject-version <text>] --authority-class <token> \
//        (--file <path> | --ref <text>) \
//        [--advisory-decision <pass|concerns|fail>] [--advisory-summary <text>] \
//        [--json]
//   node evidence-attach.mjs list --ticket <id> [--json]
//
// and the pure/exported helpers:
//
//   ADVISORY_DECISIONS                       -> readonly ['pass','concerns','fail']
//   parseEvidence(text, { ticket }?) -> { ok: true, records } | { ok: false, line, reason }
//
// Independent-oracle rule (`.claude/rules/invariants.md`): every expected
// value below — the descriptor shape, the sha256 digest, the head SHA, the
// repo-relative ref — is computed by this file's own code (its own `git`
// calls, its own `node:crypto` hash, its own `path.join`/`path.relative`),
// never by calling the module under test and trusting its own answer back.
//
// Every credential-shaped fixture is assembled at runtime
// (`secrets-fixtures.ts`), per that file's own header, so this suite itself
// never carries a committable secret shape.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { modeBitsDeny, skipUnless, symlinksAvailable } from '../helpers/env.js';
import { GITHUB_PAT } from './secrets-fixtures.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const evidenceAttachScript = scriptPath('evidence-attach.mjs');
const decisionRecordPath = path.join(universalDir, 'docs', 'decisions', 'artifact-evidence.md');

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
  run(process.execPath, [evidenceAttachScript, ...args], cwd, env);

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

/** A fresh git project with one commit: `dir` is the project root (and the git toplevel). */
const newProject = async (): Promise<{ dir: string; head: string }> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'evidence-attach-repo-')));
  await git(['init', '-q', '-b', 'master'], dir);
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await git(['add', 'README.md'], dir);
  await git(['commit', '-q', '-m', 'seed'], dir);
  const head = await git(['rev-parse', 'HEAD'], dir);
  return { dir, head };
};

/** A git toplevel with no commit at all — HEAD is unborn. */
const newUncommittedProject = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'evidence-attach-unborn-')));
  await git(['init', '-q', '-b', 'master'], dir);
  return dir;
};

/** A plain directory, never initialised as a git repository at all. */
const newNonGitDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'evidence-attach-nongit-'));

/** A fresh run directory, never shared between tests and never exported globally. */
const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'evidence-attach-run-'));

/** `RIG_RUN_DIR` is set ONLY for this one spawn — never on `process.env`. */
const envFor = (runDir: string | undefined): NodeJS.ProcessEnv => {
  const env = withoutGitLocation();
  if (runDir !== undefined) env.RIG_RUN_DIR = runDir;
  else delete env.RIG_RUN_DIR;
  return env;
};

const evidenceFile = (projectDir: string, ticket: string) =>
  path.join(projectDir, '.rig', 'evidence', `${ticket}.jsonl`);

const readEvidenceLines = async (projectDir: string, ticket: string): Promise<unknown[]> =>
  (await readFile(evidenceFile(projectDir, ticket), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const sha256Hex = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

type AttachOptions = {
  ticket?: string;
  kind?: string;
  producer?: string;
  subjectKind?: string;
  subjectId?: string;
  subjectVersion?: string;
  authorityClass?: string;
  file?: string;
  ref?: string;
  advisoryDecision?: string;
  advisorySummary?: string;
  json?: boolean;
};

const FLAG_OF: Record<keyof Omit<AttachOptions, 'json'>, string> = {
  ticket: '--ticket',
  kind: '--kind',
  producer: '--producer',
  subjectKind: '--subject-kind',
  subjectId: '--subject-id',
  subjectVersion: '--subject-version',
  authorityClass: '--authority-class',
  file: '--file',
  ref: '--ref',
  advisoryDecision: '--advisory-decision',
  advisorySummary: '--advisory-summary',
};

const attachArgs = (opts: AttachOptions): string[] => {
  const args = ['attach'];
  for (const key of Object.keys(FLAG_OF) as Array<keyof typeof FLAG_OF>) {
    const value = opts[key];
    if (value !== undefined) args.push(FLAG_OF[key], value);
  }
  if (opts.json) args.push('--json');
  return args;
};

/** A complete, valid `attach` invocation in `--ref` mode — the base every refusal test narrows from. */
const VALID_REF: AttachOptions = {
  ticket: 'RP-1',
  kind: 'test-report',
  producer: 'ci',
  subjectKind: 'commit',
  subjectId: 'abc123',
  authorityClass: 'automated',
  ref: 'https://ci.example.invalid/run/123',
};

const REQUIRED_FLAGS: Array<keyof AttachOptions> = [
  'ticket',
  'kind',
  'producer',
  'subjectKind',
  'subjectId',
  'authorityClass',
];

const omit = <T extends object>(obj: T, key: keyof T): Omit<T, typeof key> => {
  const copy = { ...obj };
  delete copy[key];
  return copy;
};

const expectNothingWritten = async (dir: string, ticket: string) => {
  await expect(readFile(evidenceFile(dir, ticket), 'utf8')).rejects.toThrow();
};

const expectDidNotCrash = (result: RunResult) => {
  expect(result.out, 'the CLI crashed on import rather than refusing').not.toMatch(
    /Cannot find module|MODULE_NOT_FOUND/,
  );
};

/**
 * The run-journal predicate `queue/index.mjs`'s `selectedIn` applies at SELECT
 * (~line 830): a `revalidation` EVENT whose `data.point === 'SELECT'`,
 * `String(data.ticket) === ticket`, `data.result` is a string and
 * `data.sourcePointer` is a string. `attach` is required to refuse a ticket
 * this has not been journalled for — RP-312 gate round 2, "mechanically
 * resolved item".
 */
const journalSelect = async (
  runDir: string,
  ticket: string,
  now: string = new Date().toISOString(),
): Promise<void> => {
  const { recordEvent } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
    recordEvent: (input: Record<string, unknown>) => unknown;
  };
  recordEvent({
    runDir,
    kind: 'revalidation',
    data: {
      point: 'SELECT',
      ticket,
      result: 'BASELINE_CREATED',
      sourcePointer: `.rig/claims/${ticket}.json`,
    },
    now,
  });
};

// --- A: flag parsing -------------------------------------------------------

describe('evidence-attach.mjs attach — flag parsing', () => {
  it('refuses an unknown flag', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli([...attachArgs(VALID_REF), '--mystery', 'x'], dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a repeated flag', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      [...attachArgs(VALID_REF), '--ticket', 'RP-2'],
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
  });

  it.each(REQUIRED_FLAGS)('refuses with %s missing, and writes nothing', async (flag) => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(omit(VALID_REF, flag)), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses when both --file and --ref are given', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    await writeFile(path.join(dir, 'report.json'), '{}\n');
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: 'report.json', ref: 'also-this' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses when neither --file nor --ref is given', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(omit(VALID_REF, 'ref')), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  const TOKEN_FLAGS: Array<keyof AttachOptions> = [
    'kind',
    'producer',
    'subjectKind',
    'authorityClass',
  ];
  const BAD_TOKENS = ['Bad Kind', '../x'];

  for (const flag of TOKEN_FLAGS) {
    it.each(BAD_TOKENS)(`refuses a bad token %j for ${flag}`, async (bad) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await journalSelect(runDir, 'RP-1');
      const result = await runCli(attachArgs({ ...VALID_REF, [flag]: bad }), dir, envFor(runDir));
      expect(result.code, result.out).toBe(1);
      expectDidNotCrash(result);
      await expectNothingWritten(dir, 'RP-1');
    });
  }

  const UNSAFE_TICKETS = ['../x', 'a/b', ''];
  it.each(UNSAFE_TICKETS)('refuses the unsafe ticket %j', async (ticket) => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, ticket);
    const result = await runCli(attachArgs({ ...VALID_REF, ticket }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
  });

  it('refuses the Windows reserved device name CON used as a ticket', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'CON');
    const result = await runCli(attachArgs({ ...VALID_REF, ticket: 'CON' }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
  });

  it('refuses a credential-shaped ticket, assembled at runtime', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, GITHUB_PAT);
    const result = await runCli(
      attachArgs({ ...VALID_REF, ticket: GITHUB_PAT }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
  });

  it('refuses an --advisory-decision outside pass|concerns|fail (uppercase SHIP)', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, advisoryDecision: 'SHIP' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses an --advisory-decision outside pass|concerns|fail ("ok")', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, advisoryDecision: 'ok' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  const VERDICT_WORD_AUTHORITY_CLASSES = ['ship', 'HOLD', 'Healthy'];
  it.each(VERDICT_WORD_AUTHORITY_CLASSES)(
    'refuses --authority-class %j — a Rig verdict word, naming the reason',
    async (authorityClass) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await journalSelect(runDir, 'RP-1');
      const result = await runCli(
        attachArgs({ ...VALID_REF, authorityClass }),
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).toBe(1);
      expectDidNotCrash(result);
      expect(result.out).toMatch(/verdict/i);
      await expectNothingWritten(dir, 'RP-1');
    },
  );
});

// --- A: RIG_RUN_DIR / git preconditions ------------------------------------

describe('evidence-attach.mjs attach — RIG_RUN_DIR and git preconditions', () => {
  it('refuses with no RIG_RUN_DIR declared, naming it', async () => {
    const { dir } = await newProject();
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(undefined));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    expect(result.out).toMatch(/RIG_RUN_DIR/);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses when RIG_RUN_DIR points at a missing directory', async () => {
    const { dir } = await newProject();
    const missing = path.join(await newRunDir(), 'does-not-exist');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(missing));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('a run directory with no state.json at all still succeeds — no authority requirement', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
  });

  it('refuses when cwd is not a git repository at all', async () => {
    const dir = await newNonGitDir();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
  });

  it('refuses when the git repository has no commit yet (unborn HEAD)', async () => {
    const dir = await newUncommittedProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
  });
});

// --- A: journal-first selection (mechanically resolved item) ----------------

describe('evidence-attach.mjs attach — requires the ticket to already be SELECTed in this run', () => {
  it('refuses when the run journal records no SELECT event at all, naming the reason', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    expect(result.out).toMatch(/select/i);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses when the only SELECT event recorded belongs to a different ticket', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-999');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    expect(result.out).toMatch(/select/i);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('succeeds once a SELECT event for this exact ticket is journalled', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
  });

  it('refuses a SELECT event missing `result` as a string — the predicate checks every field, not just `point`/`ticket`', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    const { recordEvent } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      recordEvent: (input: Record<string, unknown>) => unknown;
    };
    recordEvent({
      runDir,
      kind: 'revalidation',
      data: { point: 'SELECT', ticket: 'RP-1', sourcePointer: '.rig/claims/RP-1.json' },
      now: new Date().toISOString(),
    });
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    expect(result.out).toMatch(/select/i);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a SELECT event missing `sourcePointer` as a string', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    const { recordEvent } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      recordEvent: (input: Record<string, unknown>) => unknown;
    };
    recordEvent({
      runDir,
      kind: 'revalidation',
      data: { point: 'SELECT', ticket: 'RP-1', result: 'BASELINE_CREATED' },
      now: new Date().toISOString(),
    });
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    expect(result.out).toMatch(/select/i);
    await expectNothingWritten(dir, 'RP-1');
  });
});

// --- A: success, --ref mode -------------------------------------------------

describe('evidence-attach.mjs attach — success, --ref mode', () => {
  it('writes the journal event first, then the evidence line, deep-equal to each other', async () => {
    const { dir, head } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const before = Date.now();
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    const after = Date.now();
    expect(result.code, result.out).toBe(0);

    const lines = await readEvidenceLines(dir, 'RP-1');
    expect(lines).toHaveLength(1);
    const stored = lines[0] as Record<string, unknown>;
    const { producedAt, ...rest } = stored;

    expect(rest).toEqual({
      schemaVersion: 1,
      kind: 'test-report',
      subject: { kind: 'commit', id: 'abc123' },
      authorityClass: 'automated',
      producer: 'ci',
      ref: 'https://ci.example.invalid/run/123',
      sha256: null,
      item: 'RP-1',
      headSha: head,
    });
    expect(typeof producedAt).toBe('string');
    expect(new Date(producedAt as string).toISOString()).toBe(producedAt);
    const producedAtMs = new Date(producedAt as string).getTime();
    expect(producedAtMs).toBeGreaterThanOrEqual(before);
    expect(producedAtMs).toBeLessThanOrEqual(after);

    const { readRun } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      readRun: (input: { runDir: string }) => {
        decisions: unknown[];
        events: Array<{ kind: string; data: unknown }>;
      };
    };
    const { events } = readRun({ runDir });
    // The SELECT fixture event this test journalled is now `events[0]`; the
    // CLI's own `artifact-evidence` event is filtered for by kind rather than
    // assumed to be the first record in the run.
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('revalidation');
    const evidenceEvents = events.filter((event) => event.kind === 'artifact-evidence');
    expect(evidenceEvents).toHaveLength(1);
    expect(evidenceEvents[0]?.data).toEqual(stored);
  });

  it('--json prints exactly the descriptor on stdout', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs({ ...VALID_REF, json: true }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;
    const lines = await readEvidenceLines(dir, 'RP-1');
    expect(printed).toEqual(lines[0]);
  });

  it('omits subject.version entirely when --subject-version is not given', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      subject: Record<string, unknown>;
    }>;
    expect(Object.keys(record!.subject).sort()).toEqual(['id', 'kind']);
  });

  it('carries subject.version when --subject-version is given', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, subjectVersion: 'v2' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      subject: Record<string, unknown>;
    }>;
    expect(record!.subject).toEqual({ kind: 'commit', id: 'abc123', version: 'v2' });
  });

  it('omits advisory entirely when --advisory-decision is not given', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<Record<string, unknown>>;
    expect(Object.hasOwn(record!, 'advisory')).toBe(false);
  });

  it('carries advisory: { decision } with no summary key when --advisory-summary is not given', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, advisoryDecision: 'concerns' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      advisory: Record<string, unknown>;
    }>;
    expect(record!.advisory).toEqual({ decision: 'concerns' });
  });

  it('carries advisory: { decision, summary } when both are given', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, advisoryDecision: 'pass', advisorySummary: 'looks fine' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      advisory: Record<string, unknown>;
    }>;
    expect(record!.advisory).toEqual({ decision: 'pass', summary: 'looks fine' });
  });
});

// --- A: success, --file mode ------------------------------------------------

describe('evidence-attach.mjs attach — success, --file mode', () => {
  const writeReport = async (dir: string, relPath: string, content: string) => {
    const abs = path.join(dir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return abs;
  };

  it('a relative --file with a "./" prefix resolves to a repo-relative POSIX ref and a matching sha256', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const content = 'report-body-one\n';
    await writeReport(dir, path.join('reports', 'run.json'), content);
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: `.${path.sep}reports${path.sep}run.json` }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      ref: string;
      sha256: string;
    }>;
    expect(record!.ref).toBe('reports/run.json');
    expect(record!.sha256).toBe(sha256Hex(content));
  });

  it('an absolute --file path inside the repo resolves to the same repo-relative POSIX ref', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const content = 'report-body-two\n';
    const abs = await writeReport(dir, path.join('reports', 'run.json'), content);
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: abs }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      ref: string;
      sha256: string;
    }>;
    expect(record!.ref).toBe('reports/run.json');
    expect(record!.sha256).toBe(sha256Hex(content));
  });
});

// --- A: --file refusals ------------------------------------------------------

describe('evidence-attach.mjs attach — --file refusals', () => {
  it('refuses a --file outside the project given as an absolute path', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'evidence-attach-outside-'));
    const outsideFile = path.join(outsideDir, 'victim.json');
    await writeFile(outsideFile, '{}\n');
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: outsideFile }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --file outside the project given as a relative "../" path', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const outsideFile = path.join(path.dirname(dir), 'evidence-attach-sibling-outside.json');
    await writeFile(outsideFile, '{}\n');
    try {
      const result = await runCli(
        attachArgs({ ...omit(VALID_REF, 'ref'), file: '../evidence-attach-sibling-outside.json' }),
        dir,
        envFor(runDir),
      );
      expect(result.code, result.out).toBe(1);
      expectDidNotCrash(result);
      await expectNothingWritten(dir, 'RP-1');
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(outsideFile, { force: true }));
    }
  });

  it('refuses a --file that does not exist', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: 'nope.json' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --file that is a directory', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    await mkdir(path.join(dir, 'a-directory'));
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: 'a-directory' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --file that is a symlink inside the repo pointing outside it', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'evidence-attach-outside-'));
    const outsideFile = path.join(outsideDir, 'target.json');
    await writeFile(outsideFile, '{}\n');
    const linkPath = path.join(dir, 'link.json');
    await symlink(outsideFile, linkPath);
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: 'link.json' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --file naming a credential-shaped path (.env)', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    await writeFile(path.join(dir, '.env'), 'NOT_A_REAL_SECRET=placeholder\n');
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: '.env' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });
});

// --- A: --ref refusals -------------------------------------------------------

describe('evidence-attach.mjs attach — --ref refusals', () => {
  it('refuses a credential-shaped --ref, assembled at runtime', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = `https://ci.example.invalid/run/123?token=${GITHUB_PAT}`;
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --ref longer than 2048 characters', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = `https://ci.example.invalid/${'a'.repeat(2049)}`;
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('accepts a --ref at exactly 2048 characters', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = `https://ci.example.invalid/${'a'.repeat(2048 - 'https://ci.example.invalid/'.length)}`;
    expect(ref).toHaveLength(2048);
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
  });
});

// --- A: --ref is a remote reference only ------------------------------------

describe('evidence-attach.mjs attach — --ref is a remote reference only', () => {
  it('accepts an http:// scheme, not only https://', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'http://ci.example.invalid/run/123';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
  });

  it('accepts a non-http scheme with an authority (s3://bucket/key)', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 's3://bucket/key';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
  });

  it('refuses a --ref carrying URL userinfo with a password, assembled at runtime', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = `https://bot:${GITHUB_PAT}@ci.example.invalid/r`;
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --ref carrying URL userinfo with a username and no password', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'https://bot@ci.example.invalid/r';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a file:// reference', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'file:///tmp/x';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses an absolute path given as --ref — local files go through --file', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = '/tmp/report.json';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a Windows absolute path given as --ref', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'C:\\reports\\r.json';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a relative path given as --ref — local files go through --file and get hashed', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'reports/run.json';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a scheme with no // authority (mailto:)', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'mailto:x@example.invalid';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });
});

// --- A: --ref carrying whitespace or a control character is never accepted -

/**
 * `REMOTE_REF` (`^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]*)`) stops its authority
 * group at the FIRST whitespace character, because `\s` sits in the group's
 * own negated class. Placed inside a userinfo user part, that whitespace
 * therefore ends the captured authority BEFORE the `@` that follows it — so
 * today's userinfo check (`remote[2].includes('@')`) never sees the `@` at
 * all, and the ref is accepted. A URL parser reading the very same string
 * does not stop there: the WHATWG URL algorithm strips ASCII tab/newline
 * characters as a pre-processing step and otherwise still walks past a plain
 * space, NBSP or line separator to find the `@` — so a consumer downstream of
 * this CLI reads a userinfo (and its credential) this CLI itself missed.
 * `--ref` must therefore refuse ANY whitespace or control character, not only
 * ones a regex happens to stop on, which is also why the leading-space and
 * trailing-newline cases below are pinned even though each already refuses
 * for an unrelated reason (the leading space breaks the scheme match outright;
 * the trailing newline is simply outside what the regex ever required to
 * match to the end of the string).
 */
describe('evidence-attach.mjs attach — --ref carrying whitespace or a control character is never accepted', () => {
  const USERINFO_SEPARATORS: Array<[string, string]> = [
    ['a TAB', '\t'],
    ['an LF', '\n'],
    ['a CR', '\r'],
    ['a plain space', ' '],
    ['an NBSP (U+00A0)', ' '],
    ['a U+2028 line separator', ' '],
  ];

  it.each(USERINFO_SEPARATORS)(
    'refuses a --ref whose user part carries %s before the @',
    async (_label, separator) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await journalSelect(runDir, 'RP-1');
      const ref = `https://bot${separator}@ci.example.invalid/r`;
      const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
      expect(result.code, result.out).toBe(1);
      expectDidNotCrash(result);
      await expectNothingWritten(dir, 'RP-1');
    },
  );

  it('refuses a --ref with a leading space on an otherwise valid URL', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = ' https://ci.example.invalid/run/1';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --ref with a trailing newline on an otherwise valid URL', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'https://ci.example.invalid/run/1\n';
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });
});

// --- A: --ref backslash-smuggled userinfo past the WHATWG URL parser (RP-312 gate round 4) -

/**
 * `REMOTE_REF`'s authority group (`[^/?#\s]*`) does not exclude a backslash,
 * so for `scheme://\/bot:pw@host/r` it greedily consumes only the leading
 * backslash run and stops at the very next `/` — it never reaches the `@`,
 * so today's `remote[2].includes('@')` check finds nothing and the ref is
 * accepted. The WHATWG URL parser (`new URL(ref)`), which is what a consumer
 * of a STORED `ref` actually uses, reads the very same string differently: a
 * run of `/` and `\` right after a special scheme's `:` is all path/authority
 * separator to it, so it walks straight past the backslash(es) and lands on
 * `bot` as `username` and the built password as `password` — a credential
 * this CLI's own regex never saw.
 *
 * The password is built at runtime below (`buildPassword()`), deliberately
 * NOT one of `secrets-fixtures.ts`'s named shapes: a `GITHUB_PAT`-shaped value
 * anywhere in `--ref` is already refused by this CLI's separate,
 * pre-existing `findSecretValues` check (see "refuses a credential-shaped
 * --ref" above), which would make a test built on it pass for that unrelated
 * reason and hide whether the backslash-parsing fix under test does anything
 * at all.
 */
describe('evidence-attach.mjs attach — --ref backslash-smuggled userinfo past the WHATWG URL parser (RP-312 gate round 4)', () => {
  const BACKSLASH = String.fromCharCode(0x5c); // one literal backslash character

  /** A runtime-assembled password shaped like none of `secrets-fixtures.ts`'s credentials. */
  const buildPassword = (): string =>
    Array.from({ length: 24 }, (_, i) => String.fromCharCode(97 + ((i * 7 + 3) % 26))).join('');

  const SCHEMES = ['https', 'http', 'wss', 'ftp'];

  it.each(SCHEMES)(
    'refuses a %s ref whose userinfo sits after exactly one backslash then a slash',
    async (scheme) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await journalSelect(runDir, 'RP-1');
      const password = buildPassword();
      const ref = `${scheme}://${BACKSLASH}/bot:${password}@ci.example.invalid/r`;
      expect(ref.split(BACKSLASH)).toHaveLength(2); // exactly one backslash character
      const parsed = new URL(ref);
      expect(parsed.username).toBe('bot');
      expect(parsed.password).toBe(password);
      const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
      expect(result.code, result.out).toBe(1);
      expectDidNotCrash(result);
      await expectNothingWritten(dir, 'RP-1');
    },
  );

  it.each(SCHEMES)(
    'refuses a %s ref whose userinfo sits after exactly two backslashes then a slash',
    async (scheme) => {
      const { dir } = await newProject();
      const runDir = await newRunDir();
      await journalSelect(runDir, 'RP-1');
      const password = buildPassword();
      const ref = `${scheme}://${BACKSLASH}${BACKSLASH}/bot:${password}@ci.example.invalid/r`;
      expect(ref.split(BACKSLASH)).toHaveLength(3); // exactly two backslash characters
      const parsed = new URL(ref);
      expect(parsed.username).toBe('bot');
      expect(parsed.password).toBe(password);
      const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
      expect(result.code, result.out).toBe(1);
      expectDidNotCrash(result);
      await expectNothingWritten(dir, 'RP-1');
    },
  );

  it('refuses a backslash elsewhere in an otherwise valid ref', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = `https://ci.example.invalid/a${BACKSLASH}b`;
    expect(ref.split(BACKSLASH)).toHaveLength(2); // exactly one backslash character
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a ref the WHATWG URL parser itself cannot parse (a non-numeric port)', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ref = 'https://bot%40ci.example.invalid:notaport/r';
    // The independent oracle: this string is unparseable to the WHATWG algorithm
    // by construction, regardless of anything this CLI itself decides about it.
    expect(() => new URL(ref)).toThrow();
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });
});

// --- A: --ref ACCEPT set, checked against the independent oracle (RP-312 gate round 4) -----

/**
 * The fix under test (RP-312 gate round 4) decides `--ref` by asking
 * `new URL(ref)` rather than `REMOTE_REF`. Independent-oracle rule
 * (`.claude/rules/invariants.md`): every ref this CLI is expected to go on
 * ACCEPTING is checked here against that very parser, directly — not against
 * this CLI's own exit code — so a future narrowing of the production check
 * cannot silently agree with itself that an accepted ref carries no
 * credential.
 */
const ACCEPT_REFS: Array<[string, string]> = [
  ['https', 'https://ci.example.invalid/run/123'],
  ['http', 'http://ci.example.invalid/run/123'],
  ['s3', 's3://bucket/key'],
  ['an uppercase scheme', 'HTTPS://ci.example.invalid/run/123'],
  ['a port', 'https://ci.example.invalid:8443/run/123'],
  ["'@' in the path, not the authority", 'https://ci.example.invalid/a@b/r'],
];

describe('evidence-attach.mjs attach — --ref ACCEPT cases (uppercase scheme, a port, "@" in the path)', () => {
  it.each(ACCEPT_REFS)('accepts a ref with %s', async (_label, ref) => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs({ ...VALID_REF, ref }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);
  });
});

describe('evidence-attach.mjs attach — the --ref ACCEPT set carries no userinfo by the independent oracle (new URL)', () => {
  it.each(ACCEPT_REFS)(
    'new URL() finds no username or password in a ref with %s',
    (_label, ref) => {
      const parsed = new URL(ref);
      expect(parsed.username).toBe('');
      expect(parsed.password).toBe('');
    },
  );
});

// --- A: more refusals (RP-312 gate round 2) ----------------------------------

describe('evidence-attach.mjs attach — more refusals (RP-312 gate round 2)', () => {
  it('refuses a --file larger than 64 MiB', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const big = path.join(dir, 'big-report.json');
    await writeFile(big, '');
    await truncate(big, 64 * 1024 * 1024 + 1);
    const result = await runCli(
      attachArgs({ ...omit(VALID_REF, 'ref'), file: 'big-report.json' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses --advisory-summary given without --advisory-decision', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, advisorySummary: 'no decision given' }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  it('refuses a --kind carrying a C1 control character (U+009B) and an ESC (U+001B), echoing neither raw byte in the refusal', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const ESC = String.fromCharCode(0x1b);
    const C1 = String.fromCharCode(0x9b);
    const kind = `test-report${ESC}${C1}[2K`;
    const result = await runCli(attachArgs({ ...VALID_REF, kind }), dir, envFor(runDir));
    expect(result.code, result.out).toBe(1);
    expectDidNotCrash(result);
    expect(result.out).not.toContain(ESC);
    expect(result.out).not.toContain(C1);
    await expectNothingWritten(dir, 'RP-1');
  });
});

// --- A: advisory.summary is capped like delegated-decision.mjs's summary ---

describe("evidence-attach.mjs attach — advisory.summary is capped like delegated-decision.mjs's summary", () => {
  it('stores a 2000-character plain summary at no more than 500 characters, ending with the truncation marker', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const summary = 'a'.repeat(2000);
    const result = await runCli(
      attachArgs({ ...VALID_REF, advisoryDecision: 'pass', advisorySummary: summary }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      advisory: { summary: string };
    }>;
    expect(record!.advisory.summary.length).toBeLessThanOrEqual(500);
    // The exact marker `continuation.mjs`'s `composeCappedTextField` appends —
    // asserted literally rather than imported, so this test cannot be
    // satisfied merely by the module checking its own constant.
    expect(record!.advisory.summary.endsWith('[truncated]')).toBe(true);
  });
});

// --- A: credential-shaped free-text fields are redacted, not refused -------

describe('evidence-attach.mjs attach — subject-id/advisory-summary/subject-version redaction', () => {
  it('stores a credential-shaped --subject-id as exactly [redacted], never the raw value', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, subjectId: GITHUB_PAT }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      subject: { id: string };
    }>;
    expect(record!.subject.id).toBe('[redacted]');
    expect(JSON.stringify(record)).not.toContain(GITHUB_PAT);
  });

  it('stores a credential-shaped --subject-version as exactly [redacted]', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({ ...VALID_REF, subjectVersion: GITHUB_PAT }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      subject: { version: string };
    }>;
    expect(record!.subject.version).toBe('[redacted]');
    expect(JSON.stringify(record)).not.toContain(GITHUB_PAT);
  });

  it('stores a credential-shaped --advisory-summary as exactly [redacted]', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(
      attachArgs({
        ...VALID_REF,
        advisoryDecision: 'fail',
        advisorySummary: `leaked token ${GITHUB_PAT} rotated`,
      }),
      dir,
      envFor(runDir),
    );
    expect(result.code, result.out).toBe(0);
    const [record] = (await readEvidenceLines(dir, 'RP-1')) as Array<{
      advisory: { summary: string };
    }>;
    expect(record!.advisory.summary).toBe('[redacted]');
    expect(JSON.stringify(record)).not.toContain(GITHUB_PAT);
  });
});

// --- A: journal-first ordering ----------------------------------------------

describe('evidence-attach.mjs attach — journal-first ordering', () => {
  it('journals the event even when the evidence file write is refused (the path is a directory)', async () => {
    const { dir, head } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    await mkdir(evidenceFile(dir, 'RP-1'), { recursive: true });

    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).not.toBe(0);
    expectDidNotCrash(result);

    const { readRun } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      readRun: (input: { runDir: string }) => {
        decisions: unknown[];
        events: Array<{ kind: string; data: Record<string, unknown> }>;
      };
    };
    const { events } = readRun({ runDir });
    // As above: the SELECT fixture event is `events[0]`, so the CLI's own
    // event is found by kind rather than by position.
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('revalidation');
    const evidenceEvents = events.filter((event) => event.kind === 'artifact-evidence');
    expect(evidenceEvents).toHaveLength(1);
    const data = evidenceEvents[0]?.data ?? {};
    expect(data).toMatchObject({
      schemaVersion: 1,
      kind: 'test-report',
      subject: { kind: 'commit', id: 'abc123' },
      authorityClass: 'automated',
      producer: 'ci',
      ref: 'https://ci.example.invalid/run/123',
      sha256: null,
      item: 'RP-1',
      headSha: head,
    });
  });

  it('refuses when the run journal cannot be READ (events.jsonl is a directory), and writes nothing', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await mkdir(path.join(runDir, 'events.jsonl'));

    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).not.toBe(0);
    expectDidNotCrash(result);
    await expectNothingWritten(dir, 'RP-1');
  });

  // Unlike the READ case above (events.jsonl is a directory, so even the
  // SELECT-predicate read fails before anything else runs), this one exercises
  // the WRITE half of the journal-first guarantee: the SELECT read succeeds
  // first (the file is a plain, readable file), so the run gets all the way to
  // the point where it tries to append its own `artifact-evidence` event — and
  // only THAT append is refused.
  it('refuses when the run journal cannot be APPENDED to (events.jsonl is read-only), naming the journal, and writes no evidence file', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    await chmod(path.join(runDir, 'events.jsonl'), 0o444);
    try {
      const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
      expect(result.code, result.out).not.toBe(0);
      expectDidNotCrash(result);
      expect(result.out).toMatch(/journal/i);
      await expectNothingWritten(dir, 'RP-1');
    } finally {
      await chmod(path.join(runDir, 'events.jsonl'), 0o644);
    }
  });
});

// --- B: list -----------------------------------------------------------------

describe('evidence-attach.mjs list', () => {
  it('needs no RIG_RUN_DIR at all', async () => {
    const { dir } = await newProject();
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-404', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(0);
  });

  it('an absent file reports an empty array, exit 0', async () => {
    const { dir } = await newProject();
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-404', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('two attaches are listed back in file order, equal to what was attached', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    await runCli(attachArgs({ ...VALID_REF, kind: 'first-kind' }), dir, envFor(runDir));
    await runCli(attachArgs({ ...VALID_REF, kind: 'second-kind' }), dir, envFor(runDir));

    const stored = await readEvidenceLines(dir, 'RP-1');
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-1', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(stored);
  });

  const forgedEvidenceLine = (overrides: Record<string, unknown>) =>
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'test-report',
      subject: { kind: 'commit', id: 'abc123' },
      authorityClass: 'automated',
      producer: 'ci',
      ref: 'https://ci.example.invalid/run/123',
      sha256: null,
      item: 'RP-9',
      headSha: 'deadbeef',
      producedAt: new Date().toISOString(),
      ...overrides,
    })}\n`;

  const writeForgedEvidence = async (dir: string, ticket: string, line: string) => {
    await mkdir(path.join(dir, '.rig', 'evidence'), { recursive: true });
    await writeFile(evidenceFile(dir, ticket), line);
  };

  it('a line that is not valid JSON is unreadable — exit 2, names the line number', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', `${forgedEvidenceLine({})}not json at all\n`);
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toContain('2');
  });

  it('a line missing a required key is unreadable — exit 2, names the line number', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(
      dir,
      'RP-9',
      `${JSON.stringify({ item: 'RP-9', kind: 'test-report' })}\n`,
    );
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toContain('1');
  });

  it('a record whose item differs from the requested --ticket is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    // Filed under RP-1's own path — only the record's OWN `item` field says RP-9.
    await writeForgedEvidence(dir, 'RP-1', forgedEvidenceLine({}));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-1', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose advisory.decision is SHIP (not an advisory word) is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ advisory: { decision: 'SHIP' } }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose authorityClass is a Rig verdict word (hold) is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ authorityClass: 'hold' }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose schemaVersion is 2 (not the only version this file knows) is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ schemaVersion: 2 }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose sha256 is not hex ("nothex") is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ sha256: 'nothex' }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose headSha is not a commit id ("xyz") is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ headSha: 'xyz' }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose producedAt is not a timestamp ("not-a-date") is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ producedAt: 'not-a-date' }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose subject is a bare string (not { kind, id }) is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ subject: 'string' }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  it('a record whose subject.kind is not a lowercase token ("Bad Kind") is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(
      dir,
      'RP-9',
      forgedEvidenceLine({ subject: { kind: 'Bad Kind', id: 'x' } }),
    );
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });

  // `list`'s error paths (`evidence-attach: <path> line <n> is unreadable —
  // <reason>`) embed the forged field's own `JSON.stringify(...)` straight
  // into the message handed to `process.stderr.write` — unlike `attach`'s
  // `refuse()`, which runs every message through `printable()` first. A C1
  // control character (U+0080-U+009F) is NOT one JSON.stringify escapes (only
  // U+0000-U+001F are required to be), so it reaches the terminal raw; ESC
  // (U+001B) IS inside that escaped range, so it is already safe by
  // JSON.stringify's own doing — both are pinned here so neither regresses.
  it('a forged kind carrying a C1 control character (U+009B) does not leak the raw byte into stderr — exit 2', async () => {
    const { dir } = await newProject();
    const C1 = String.fromCharCode(0x9b);
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ kind: `test${C1}report` }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).not.toContain(C1);
  });

  it('a forged kind carrying an ESC (U+001B) does not leak the raw byte into stderr — exit 2', async () => {
    const { dir } = await newProject();
    const ESC = String.fromCharCode(0x1b);
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({ kind: `test${ESC}report` }));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).not.toContain(ESC);
  });

  it('a well-formed record is still listed back fine (control case for the four forgeries above)', async () => {
    const { dir } = await newProject();
    await writeForgedEvidence(dir, 'RP-9', forgedEvidenceLine({}));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
  });

  it('a file larger than 256 KiB is unreadable — exit 2', async () => {
    const { dir } = await newProject();
    const validLine = forgedEvidenceLine({});
    const repeats = Math.ceil((256 * 1024 + 1024) / validLine.length);
    await writeForgedEvidence(dir, 'RP-9', validLine.repeat(repeats));
    const result = await run(
      process.execPath,
      [evidenceAttachScript, 'list', '--ticket', 'RP-9', '--json'],
      dir,
      envFor(undefined),
    );
    expect(result.code, result.out).toBe(2);
  });
});

// --- C: advisory-only, as a unit property -----------------------------------

describe('evidence-attach.mjs — ADVISORY_DECISIONS and parseEvidence (pure helpers)', () => {
  it('ADVISORY_DECISIONS names exactly pass, concerns, fail, and is frozen', async () => {
    const { ADVISORY_DECISIONS } = (await import(pathToFileURL(evidenceAttachScript).href)) as {
      ADVISORY_DECISIONS: readonly string[];
    };
    expect(ADVISORY_DECISIONS).toEqual(['pass', 'concerns', 'fail']);
    expect(Object.isFrozen(ADVISORY_DECISIONS)).toBe(true);
  });

  type ParseEvidence = (
    text: string,
    options?: { ticket?: string },
  ) => { ok: true; records: unknown[] } | { ok: false; line: number; reason: string };

  it('parseEvidence on empty text is ok: true with no records', async () => {
    const { parseEvidence } = (await import(pathToFileURL(evidenceAttachScript).href)) as {
      parseEvidence: ParseEvidence;
    };
    const result = parseEvidence('');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toEqual([]);
  });

  it('parseEvidence reports ok: false with the 1-based line number for invalid JSON', async () => {
    const { parseEvidence } = (await import(pathToFileURL(evidenceAttachScript).href)) as {
      parseEvidence: ParseEvidence;
    };
    const result = parseEvidence('{"valid":true}\nnot json\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.line).toBe(2);
  });

  it('parseEvidence(text, { ticket }) rejects a record whose item differs from the ticket requested', async () => {
    const { parseEvidence } = (await import(pathToFileURL(evidenceAttachScript).href)) as {
      parseEvidence: ParseEvidence;
    };
    const line = `${JSON.stringify({
      schemaVersion: 1,
      kind: 'test-report',
      subject: { kind: 'commit', id: 'abc123' },
      authorityClass: 'automated',
      producer: 'ci',
      ref: 'x',
      sha256: null,
      item: 'RP-2',
      headSha: 'deadbeef',
      producedAt: new Date().toISOString(),
    })}\n`;
    const result = parseEvidence(line, { ticket: 'RP-1' });
    expect(result.ok).toBe(false);
  });
});

describe('evidence-attach.mjs — bypasses no mechanical gate', () => {
  it('source never imports lib/gate-coverage.mjs', async () => {
    const content = await readFile(evidenceAttachScript, 'utf8');
    expect(content).not.toMatch(/lib\/gate-coverage\.mjs/);
  });

  it("source never calls verdict.mjs's verdict writer (recordDecision)", async () => {
    const content = await readFile(evidenceAttachScript, 'utf8');
    expect(content).not.toMatch(/\brecordDecision\b/);
  });

  it('attach leaves <runDir>/decisions.jsonl absent — it writes a run EVENT, never a gate VERDICT', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    await journalSelect(runDir, 'RP-1');
    const result = await runCli(attachArgs(VALID_REF), dir, envFor(runDir));
    expect(result.code, result.out).toBe(0);

    const { readRun } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
      readRun: (input: { runDir: string }) => { decisions: unknown[]; events: unknown[] };
    };
    const { decisions } = readRun({ runDir });
    expect(decisions).toEqual([]);
  });
});

// --- D: the decision record --------------------------------------------------

describe('docs/decisions/artifact-evidence.md', () => {
  const read = () => readFile(decisionRecordPath, 'utf8');

  it('exists and has an H1', async () => {
    const content = await read();
    expect(content).toMatch(/^#\s+\S/m);
  });

  it('carries no host-specific absolute path', async () => {
    const content = await read();
    expect(content).not.toMatch(/[A-Z]:\\/);
    expect(content).not.toMatch(/\/Users\/[a-z]/i);
    expect(content).not.toMatch(/\/home\/[a-z]/i);
  });

  it('explains why evidence is normalized into the existing item-owned record + journal path, not a provider-specific store', async () => {
    const content = await read();
    expect(content).toMatch(/item-owned/i);
    expect(content).toMatch(/provider-specific/i);
  });

  it('states the descriptor schema, naming authorityClass, subject, sha256 and headSha', async () => {
    const content = await read();
    expect(content).toMatch(/authorityClass/);
    expect(content).toMatch(/subject/i);
    expect(content).toMatch(/sha-?256/i);
    expect(content).toMatch(/headSha/);
  });

  it('states the current-head staleness rule: an artifact bound to another head does not satisfy current-head coverage', async () => {
    const content = await read();
    expect(content).toMatch(/current.?head/i);
    expect(content).toMatch(/stale/i);
  });

  it('states the degradation rule: an unavailable provider or evidence source is not itself a failure', async () => {
    const content = await read();
    expect(content).toMatch(/unavailable/i);
    expect(content).toMatch(/not\b.{0,30}\bfailure/i);
  });

  it('states the advisory rule: an external pass/concerns/fail never becomes SHIP/HOLD', async () => {
    const content = await read();
    expect(content).toMatch(/advisory/i);
    expect(content).toMatch(/never/i);
    expect(content).toMatch(/SHIP/);
    expect(content).toMatch(/HOLD/);
  });

  it('states the identity boundary: a producer-specific exception needs a separate architecture decision', async () => {
    const content = await read();
    expect(content).toMatch(/producer-specific/i);
    expect(content).toMatch(/separate/i);
  });

  it('states the bounded local hash vs. remote reference distinction', async () => {
    const content = await read();
    expect(content).toMatch(/sha-?256/i);
    expect(content).toMatch(/remote reference|reference only|bounded/i);
  });

  it('states its non-goals: no new journal or database, and no artifact-to-deployment provenance chain', async () => {
    const content = await read();
    expect(content).toMatch(/non-goals/i);
    expect(content).toMatch(/provenance/i);
  });

  it('cites lib/gate-coverage.mjs as where the current-head staleness rule is now enforced', async () => {
    const content = await read();
    expect(content).toContain('lib/gate-coverage.mjs');
  });

  it("says the evidence file is committed with the item's branch", async () => {
    const content = await read();
    expect(content).toMatch(
      /(?:\.rig\/evidence\/[\s\S]{0,200}\bcommit(?:ted)?\b|\bcommit(?:ted)?\b[\s\S]{0,200}\.rig\/evidence\/)/i,
    );
  });

  it('documents the SELECT precondition: attach refuses an item this run has not SELECTed', async () => {
    const content = await read();
    expect(content).toMatch(/SELECT/);
    expect(content).toMatch(/selected/i);
  });

  it("is cited from evidence-attach.mjs's own source", async () => {
    const source = await readFile(evidenceAttachScript, 'utf8');
    expect(source).toContain('docs/decisions/artifact-evidence.md');
  });
});

describe("evidence-attach.mjs's own header documents the SELECT precondition", () => {
  it('the first 40 lines mention SELECT — a reader scanning only the header sees the precondition', async () => {
    const source = await readFile(evidenceAttachScript, 'utf8');
    const header = source.split('\n').slice(0, 40).join('\n');
    expect(header).toMatch(/select/i);
  });
});
