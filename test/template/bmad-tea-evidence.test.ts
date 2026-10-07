// RP-315: the generalization proof. `evidence-attach.mjs` and
// `verdict.mjs coverage` were built for Playwright MCP's browser evidence
// (RP-313); this file exercises the exact same CLI path for a second,
// unrelated producer — BMAD TEA (Test Architecture & Evaluator, the test
// module of `bmad-method-test-architecture-enterprise@1.27.2`) — through a
// real git repository, never a synthetic fixture, so the mechanism is proven
// producer-neutral rather than merely Playwright-shaped.
//
// Two TEA artifacts stand in for the two upstream workflows: the trace
// workflow's `gate-decision.json` (schema version `0.1.0`, keys
// `schema_version, evaluated_at, repo, target, collection_status,
// gate_basis, gate_status, rationale, p0_status, p1_status, overall_status,
// critical_open, links`, `gate_status` one of PASS | CONCERNS | FAIL |
// WAIVED) and the nfr-assess workflow's `nfr-assessment-*.md`. Both are
// attached as ordinary `evidence-attach.mjs attach --producer bmad-tea`
// calls — nothing here is BMAD-specific in the script itself.
//
// Independent-oracle rule (`.claude/rules/invariants.md`): every expected
// value below — the head SHA, the sha256 digest of each fixture — is
// computed by this file's own code (`git rev-parse`, `node:crypto`), never
// by trusting the CLI's own answer back.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const evidenceAttachScript = scriptPath('evidence-attach.mjs');
const verdictScript = scriptPath('verdict.mjs');
const runJournalPath = scriptPath('run-journal.mjs');

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
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'bmad-tea-evidence-repo-')));
  await git(['init', '-q', '-b', 'master'], dir);
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await git(['add', 'README.md'], dir);
  await git(['commit', '-q', '-m', 'seed'], dir);
  const head = await git(['rev-parse', 'HEAD'], dir);
  return { dir, head };
};

/** One further commit in `dir`, returning the new HEAD — moves the head the evidence was bound to into the past. */
const furtherCommit = async (dir: string): Promise<string> => {
  await writeFile(path.join(dir, 'CHANGELOG.md'), 'a change\n');
  await git(['add', 'CHANGELOG.md'], dir);
  await git(['commit', '-q', '-m', 'a further change'], dir);
  return git(['rev-parse', 'HEAD'], dir);
};

const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'bmad-tea-evidence-run-'));

const journalSelect = async (runDir: string, ticket: string): Promise<void> => {
  const { recordEvent } = (await import(pathToFileURL(runJournalPath).href)) as {
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
    now: new Date().toISOString(),
  });
};

/** One reviewer fully routed, launched and answered SHIP for `headSha` — the "everything is covered" fixture. */
const recordShipFanOut = async (
  runDir: string,
  headSha: string,
  reviewer = 'code-reviewer',
): Promise<void> => {
  const { recordDecision } = (await import(pathToFileURL(runJournalPath).href)) as {
    recordDecision: (input: Record<string, unknown>) => unknown;
  };
  recordDecision({
    runDir,
    gate: 'review-routing:model',
    verdict: 'route',
    why: 'the expensive path is warranted',
    reviewers: [reviewer],
    now: '2026-10-07T09:00:00.000Z',
  });
  recordDecision({
    runDir,
    gate: 'reviewer-fan-out',
    verdict: 'launched',
    why: null,
    headSha,
    reviewers: [reviewer],
    now: '2026-10-07T09:01:00.000Z',
  });
  recordDecision({
    runDir,
    gate: reviewer,
    verdict: 'SHIP',
    why: null,
    blockers: [],
    headSha,
    now: '2026-10-07T09:02:00.000Z',
  });
};

const sha256Hex = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

type AttachOptions = {
  ticket: string;
  kind: string;
  producer: string;
  producerVersion?: string;
  subjectKind: string;
  subjectId: string;
  authorityClass: string;
  file?: string;
  ref?: string;
  advisoryDecision?: string;
};

const FLAG_OF: Record<string, string> = {
  ticket: '--ticket',
  kind: '--kind',
  producer: '--producer',
  producerVersion: '--producer-version',
  subjectKind: '--subject-kind',
  subjectId: '--subject-id',
  authorityClass: '--authority-class',
  file: '--file',
  ref: '--ref',
  advisoryDecision: '--advisory-decision',
};

const attachArgs = (opts: AttachOptions): string[] => {
  const args = ['attach'];
  for (const [key, flag] of Object.entries(FLAG_OF)) {
    const value = (opts as Record<string, string | undefined>)[key];
    if (value !== undefined) args.push(flag, value);
  }
  args.push('--json');
  return args;
};

const runAttach = (args: string[], cwd: string, runDir: string): Promise<RunResult> => {
  const env = withoutGitLocation();
  env.RIG_RUN_DIR = runDir;
  return run(process.execPath, [evidenceAttachScript, ...args], cwd, env);
};

const runList = (ticket: string, cwd: string): Promise<RunResult> => {
  const env = withoutGitLocation();
  delete env.RIG_RUN_DIR;
  return run(
    process.execPath,
    [evidenceAttachScript, 'list', '--ticket', ticket, '--json'],
    cwd,
    env,
  );
};

const runCoverage = (headSha: string, cwd: string, runDir: string): Promise<RunResult> => {
  const env = withoutGitLocation();
  env.RIG_RUN_DIR = runDir;
  return run(process.execPath, [verdictScript, 'coverage', headSha], cwd, env);
};

/** The TEA trace workflow's own `gate-decision.json` shape (schema version '0.1.0'). */
const gateDecisionFixture = (gateStatus: string): string =>
  `${JSON.stringify(
    {
      schema_version: '0.1.0',
      evaluated_at: '2026-10-07T09:00:00.000Z',
      repo: 'create-agent-rig',
      target: 'RP-1',
      collection_status: 'complete',
      gate_basis: 'trace',
      gate_status: gateStatus,
      rationale: 'fixture rationale',
      p0_status: 'pass',
      p1_status: 'pass',
      overall_status: gateStatus,
      critical_open: 0,
      links: [],
    },
    null,
    2,
  )}\n`;

const NFR_ASSESSMENT_FIXTURE = '# NFR Assessment — story 1.2\n\nFixture content.\n';

describe('BMAD TEA evidence — the same evidence-attach.mjs path Playwright uses, proven for a second producer (RP-315)', () => {
  it('attaches a tea-trace and a tea-nfr-assessment record, listed back with producer, producerVersion, matching sha256 and the given advisory decisions', async () => {
    const { dir, head } = await newProject();
    const runDir = await newRunDir();
    const ticket = 'RP-1';
    await journalSelect(runDir, ticket);

    const gateDecisionRel = path.join('test-artifacts', 'gate-decision.json');
    const gateDecisionBytes = gateDecisionFixture('PASS');
    await mkdir(path.join(dir, 'test-artifacts'), { recursive: true });
    await writeFile(path.join(dir, gateDecisionRel), gateDecisionBytes);

    const nfrRel = path.join('test-artifacts', 'nfr', 'nfr-assessment-1.2.md');
    await mkdir(path.join(dir, 'test-artifacts', 'nfr'), { recursive: true });
    await writeFile(path.join(dir, nfrRel), NFR_ASSESSMENT_FIXTURE);

    const traceResult = await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-trace',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'automated',
        file: gateDecisionRel,
        advisoryDecision: 'pass',
      }),
      dir,
      runDir,
    );
    expect(traceResult.code, traceResult.out).toBe(0);

    const nfrResult = await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-nfr-assessment',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'automated',
        file: nfrRel,
        advisoryDecision: 'concerns',
      }),
      dir,
      runDir,
    );
    expect(nfrResult.code, nfrResult.out).toBe(0);

    const listResult = await runList(ticket, dir);
    expect(listResult.code, listResult.out).toBe(0);
    const records = JSON.parse(listResult.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);

    const trace = records.find((r) => r.kind === 'tea-trace');
    const nfr = records.find((r) => r.kind === 'tea-nfr-assessment');
    expect(trace, listResult.stdout).toBeDefined();
    expect(nfr, listResult.stdout).toBeDefined();

    expect(trace!.producer).toBe('bmad-tea');
    expect(trace!.producerVersion).toBe('1.27.2');
    expect(trace!.headSha).toBe(head);
    expect(trace!.sha256).toBe(sha256Hex(gateDecisionBytes));
    expect((trace!.advisory as Record<string, unknown>).decision).toBe('pass');

    expect(nfr!.producer).toBe('bmad-tea');
    expect(nfr!.producerVersion).toBe('1.27.2');
    expect(nfr!.headSha).toBe(head);
    expect(nfr!.sha256).toBe(sha256Hex(NFR_ASSESSMENT_FIXTURE));
    expect((nfr!.advisory as Record<string, unknown>).decision).toBe('concerns');
  });

  it('coverage reports 2 current, 0 stale, and is NOT ok with no reviewer verdict recorded — a TEA pass never stands in for SHIP', async () => {
    const { dir, head } = await newProject();
    const runDir = await newRunDir();
    const ticket = 'RP-1';
    await journalSelect(runDir, ticket);

    const gateDecisionRel = path.join('test-artifacts', 'gate-decision.json');
    await mkdir(path.join(dir, 'test-artifacts'), { recursive: true });
    await writeFile(path.join(dir, gateDecisionRel), gateDecisionFixture('PASS'));
    await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-trace',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'automated',
        file: gateDecisionRel,
        advisoryDecision: 'pass',
      }),
      dir,
      runDir,
    );

    const nfrRel = path.join('test-artifacts', 'nfr', 'nfr-assessment-1.2.md');
    await mkdir(path.join(dir, 'test-artifacts', 'nfr'), { recursive: true });
    await writeFile(path.join(dir, nfrRel), NFR_ASSESSMENT_FIXTURE);
    await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-nfr-assessment',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'automated',
        file: nfrRel,
        advisoryDecision: 'concerns',
      }),
      dir,
      runDir,
    );

    const coverage = await runCoverage(head, dir, runDir);
    expect(coverage.code, coverage.out).not.toBe(0);
    expect(coverage.out).toMatch(/evidence: 2 current, 0 stale/);
  });

  it('coverage IS ok once the gate’s required reviewer verdicts are recorded SHIP for the head, even with a TEA artifact attached --advisory-decision fail — a TEA fail stays advisory', async () => {
    const { dir, head } = await newProject();
    const runDir = await newRunDir();
    const ticket = 'RP-1';
    await journalSelect(runDir, ticket);
    await recordShipFanOut(runDir, head);

    const gateDecisionRel = path.join('test-artifacts', 'gate-decision.json');
    await mkdir(path.join(dir, 'test-artifacts'), { recursive: true });
    await writeFile(path.join(dir, gateDecisionRel), gateDecisionFixture('FAIL'));
    const attachResult = await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-trace',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'automated',
        file: gateDecisionRel,
        advisoryDecision: 'fail',
      }),
      dir,
      runDir,
    );
    expect(attachResult.code, attachResult.out).toBe(0);

    const coverage = await runCoverage(head, dir, runDir);
    expect(coverage.code, coverage.out).toBe(0);
    expect(coverage.out).toMatch(/evidence: 1 current, 0 stale/);
  });

  it('after a further code commit, both TEA records read stale — identical to Playwright evidence', async () => {
    const { dir, head } = await newProject();
    const runDir = await newRunDir();
    const ticket = 'RP-1';
    await journalSelect(runDir, ticket);

    const gateDecisionRel = path.join('test-artifacts', 'gate-decision.json');
    await mkdir(path.join(dir, 'test-artifacts'), { recursive: true });
    await writeFile(path.join(dir, gateDecisionRel), gateDecisionFixture('PASS'));
    await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-trace',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'automated',
        file: gateDecisionRel,
        advisoryDecision: 'pass',
      }),
      dir,
      runDir,
    );

    const nfrRel = path.join('test-artifacts', 'nfr', 'nfr-assessment-1.2.md');
    await mkdir(path.join(dir, 'test-artifacts', 'nfr'), { recursive: true });
    await writeFile(path.join(dir, nfrRel), NFR_ASSESSMENT_FIXTURE);
    await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-nfr-assessment',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'automated',
        file: nfrRel,
        advisoryDecision: 'concerns',
      }),
      dir,
      runDir,
    );

    // Both records are bound to `head`; a further commit moves the head the
    // coverage question is about, without reattaching anything.
    const newHead = await furtherCommit(dir);
    expect(newHead).not.toBe(head);

    const coverage = await runCoverage(newHead, dir, runDir);
    expect(coverage.out).toMatch(/evidence: 0 current, 2 stale/);
  });

  it('refuses a TEA gate word (PASS) passed as --authority-class, naming it a Rig verdict word', async () => {
    const { dir } = await newProject();
    const runDir = await newRunDir();
    const ticket = 'RP-1';
    await journalSelect(runDir, ticket);

    const gateDecisionRel = path.join('test-artifacts', 'gate-decision.json');
    await mkdir(path.join(dir, 'test-artifacts'), { recursive: true });
    await writeFile(path.join(dir, gateDecisionRel), gateDecisionFixture('PASS'));

    const result = await runAttach(
      attachArgs({
        ticket,
        kind: 'tea-trace',
        producer: 'bmad-tea',
        producerVersion: '1.27.2',
        subjectKind: 'story',
        subjectId: '1.2',
        authorityClass: 'SHIP',
        file: gateDecisionRel,
      }),
      dir,
      runDir,
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/verdict/i);

    const listResult = await runList(ticket, dir);
    expect(JSON.parse(listResult.stdout)).toEqual([]);
  });
});
