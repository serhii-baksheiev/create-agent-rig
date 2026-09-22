// RP-203: `.claude/scripts/release-evidence.mjs` — the smallest
// evidence-to-proposal mechanism the release loop uses under the owner's
// delegation. Existing evidence (gate-blocker patterns, filed triage
// proposals) becomes a REPEATED_PAIN or a GATHER_MORE_EVIDENCE verdict; it
// never files anything itself and never invents a new evidence store.
//
// Read-only by design: this file proves that twice — once by re-reading the
// fixture tree after every run and asserting it is byte-identical, and once
// by scanning the script's own source for a write-call literal. Both are
// meant to fail together the day someone adds a write path without meaning
// to.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const evidenceScript = path.join(scriptsDir, 'release-evidence.mjs');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

interface JournalRecord {
  seq: number;
  at: string;
  kind?: string;
  gate?: string;
  verdict?: string;
  blockers?: Array<{ rule: string; note?: string | null }>;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
  recordDecision: (input: {
    runDir: string;
    gate: string;
    verdict: string;
    blockers?: Array<{ rule: string; note?: string | null }>;
    now: string;
  }) => JournalRecord;
  recordEvent: (input: {
    runDir: string;
    kind: string;
    data?: unknown;
    now: string;
  }) => JournalRecord;
  readRun: (input: { runDir: string }) => {
    decisions: JournalRecord[];
    events: JournalRecord[];
    ended: boolean;
  };
};

// Only imported once the module exists — every test below fails on this
// import until then, which is the expected Red-step reason.
let evidenceModule: {
  evidenceOf: (input: { runs: unknown[]; since: string }) => Evidence;
  REPEATED_MIN_RUNS: number;
} | null = null;
try {
  evidenceModule = (await import(pathToFileURL(evidenceScript).href)) as typeof evidenceModule;
} catch {
  evidenceModule = null;
}

interface Pointer {
  run: string;
  file: string;
  seq: number;
}

interface Group {
  key: string;
  source: 'gate-blocker' | 'proposal';
  gate: string | null;
  label: string;
  records: number;
  runs: number;
  repeated: boolean;
  firstAt: string;
  lastAt: string;
  pointers: Pointer[];
}

interface Evidence {
  schemaVersion: number;
  since: string;
  rule: { repeatedMinRuns: number; unit: string; grouping: string };
  runs: { read: number; skipped: Array<{ run: string; why: string }> };
  groups: Group[];
  verdict: 'REPEATED_PAIN' | 'GATHER_MORE_EVIDENCE';
  why: string;
  limits: string[];
}

const SINCE = '2026-08-20T00:00:00.000Z';
const BEFORE = '2026-08-01T00:00:00.000Z';
const AFTER = '2026-08-21T00:00:00.000Z';
const AFTER_2 = '2026-08-22T00:00:00.000Z';

const RULE = 'no secrets in code, config, or fixtures';

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

const node = (script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  run(process.execPath, [script, ...args], cwd, env);

const cli = (args: string[], cwd = repoRoot) =>
  node(evidenceScript, args, cwd, withoutGitLocation());

const cliJson = async (args: string[]): Promise<{ code: number; out: string; data: Evidence }> => {
  const result = await cli(args);
  expect(result.stdout, result.out).not.toBe('');
  return { code: result.code, out: result.out, data: JSON.parse(result.stdout) as Evidence };
};

/** A fresh empty run-directories root, under the OS temp dir (never removed
 * explicitly — see `test/template/revalidation-evidence.test.ts`, the sibling
 * this file follows, which does the same for the same fixtures). */
const runsRoot = () => mkdtemp(path.join(tmpdir(), 'release-evidence-runs-'));

const mkrun = async (runsDir: string, name: string): Promise<string> => {
  const dir = path.join(runsDir, name);
  await mkdir(dir, { recursive: true });
  return dir;
};

const blocker = (rule: string, note = 'x'): Array<{ rule: string; note: string }> => [
  { rule, note },
];

/** Every run directory under `runsDir`, read through the same `readRun` every
 * gate uses — the fixture-side half of "every pointer resolves through
 * readRun". This is deliberately independent of whatever internal reading
 * `release-evidence.mjs` does itself; it exists so `evidenceOf` can be
 * exercised directly, not only through the CLI. */
const readRuns = async (
  runsDir: string,
): Promise<
  Array<{ run: string; decisions?: JournalRecord[]; events?: JournalRecord[]; error?: string }>
> => {
  const names = (await readdir(runsDir)).sort();
  return names.map((name) => {
    try {
      const { decisions, events } = journal.readRun({ runDir: path.join(runsDir, name) });
      return { run: name, decisions, events };
    } catch (error) {
      return { run: name, error: String((error as Error)?.message ?? error) };
    }
  });
};

/** Snapshot of file contents below `dir`, keyed by relative path — used to
 * prove a read-only run really changed nothing. */
const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (sub: string) => {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.posix.join(sub, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else out[rel] = await readFile(path.join(dir, rel), 'utf8');
    }
  };
  await walk('.');
  return out;
};

describe('release-evidence.mjs is read-only', () => {
  it('leaves the run-directory tree byte-identical after evidenceOf and the CLI both run', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: AFTER,
    });

    const before = await snapshot(runsDir);
    expect(evidenceModule, 'release-evidence.mjs does not export evidenceOf yet').not.toBeNull();
    evidenceModule!.evidenceOf({ runs: await readRuns(runsDir), since: SINCE });
    const result = await cli(['--runs', runsDir, '--since', SINCE, '--json']);
    expect(result.code, result.out).toBe(0);
    const after = await snapshot(runsDir);
    expect(after).toEqual(before);
  });

  it('contains no write-call literal in its own source', async () => {
    const source = await readFile(evidenceScript, 'utf8');
    for (const literal of [
      'writeFileSync(',
      'appendFileSync(',
      'mkdirSync(',
      'rmSync(',
      'unlinkSync(',
      'writeFile(',
      'appendFile(',
      // `mkdir(` / `rm(` / `unlink(` deliberately excluded: too common a
      // substring (e.g. inside comments); the *Sync and promise-`writeFile`/
      // `appendFile` forms above are the ones a script like this would
      // plausibly reach for, and are unambiguous.
    ]) {
      expect(source, `${evidenceScript} calls ${literal}`).not.toContain(literal);
    }
  });
});

describe('release-evidence.mjs grouping: repeated pain vs. an anecdote', () => {
  it('two runs each carrying the same blocker rule make a repeated group', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    const runB = await mkrun(runsDir, 'run-b');
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker('  No Secrets   in Code, Config, or Fixtures  '),
      now: AFTER,
    });
    journal.recordDecision({
      runDir: runB,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker('no secrets in code, config, or fixtures'),
      now: AFTER_2,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const group = data.groups.find((g) => g.key === `gate-blocker|code-reviewer|${RULE}`);
    expect(group, JSON.stringify(data.groups)).toBeDefined();
    expect(group!.repeated).toBe(true);
    expect(group!.runs).toBe(2);
    expect(group!.records).toBe(2);
    expect(data.verdict).toBe('REPEATED_PAIN');
  });

  it('three records inside one run are a single anecdote, never a repeated group', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    for (let i = 0; i < 3; i += 1) {
      journal.recordDecision({
        runDir: runA,
        gate: 'code-reviewer',
        verdict: 'HOLD',
        blockers: blocker(RULE),
        now: AFTER,
      });
    }

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const group = data.groups.find((g) => g.key === `gate-blocker|code-reviewer|${RULE}`);
    expect(group, JSON.stringify(data.groups)).toBeDefined();
    expect(group!.records).toBe(3);
    expect(group!.runs).toBe(1);
    expect(group!.repeated).toBe(false);
    expect(data.verdict).toBe('GATHER_MORE_EVIDENCE');
  });

  it('a proposal fingerprint filed ok in two runs forms a repeated group', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    const runB = await mkrun(runsDir, 'run-b');
    journal.recordEvent({
      runDir: runA,
      kind: 'proposal',
      data: { ok: true, id: 'fingerprint-x' },
      now: AFTER,
    });
    journal.recordEvent({
      runDir: runB,
      kind: 'proposal',
      data: { ok: true, id: 'fingerprint-x' },
      now: AFTER_2,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const group = data.groups.find((g) => g.key === 'proposal|fingerprint-x');
    expect(group, JSON.stringify(data.groups)).toBeDefined();
    expect(group!.source).toBe('proposal');
    expect(group!.repeated).toBe(true);
    expect(group!.runs).toBe(2);
    expect(data.verdict).toBe('REPEATED_PAIN');
  });

  it('a proposal filed ok: false is not evidence, even filed twice', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    const runB = await mkrun(runsDir, 'run-b');
    journal.recordEvent({
      runDir: runA,
      kind: 'proposal',
      data: { ok: false, reason: 'adapter refused' },
      now: AFTER,
    });
    journal.recordEvent({
      runDir: runB,
      kind: 'proposal',
      data: { ok: false, reason: 'adapter refused' },
      now: AFTER_2,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.groups.filter((g) => g.source === 'proposal')).toEqual([]);
    expect(data.verdict).toBe('GATHER_MORE_EVIDENCE');
  });
});

describe('release-evidence.mjs verdict: GATHER_MORE_EVIDENCE is the honest default', () => {
  it('an anecdote-only run gives GATHER_MORE_EVIDENCE', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: AFTER,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.verdict).toBe('GATHER_MORE_EVIDENCE');
  });

  it('an empty runs directory gives GATHER_MORE_EVIDENCE, with zero runs read', async () => {
    const runsDir = await runsRoot();
    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.verdict).toBe('GATHER_MORE_EVIDENCE');
    expect(data.runs.read).toBe(0);
  });

  it('a run readRun refuses is counted under skipped, with why, and still gives GATHER_MORE_EVIDENCE', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    // seq 1 then 3 — the same gap shape `revalidation-evidence.test.ts` uses
    // to prove `readRun` refuses a broken sequence.
    await writeFile(
      path.join(runA, 'events.jsonl'),
      [
        JSON.stringify({ seq: 1, at: AFTER, kind: 'proposal', data: { ok: true, id: 'x' } }),
        JSON.stringify({ seq: 3, at: AFTER, kind: 'proposal', data: { ok: true, id: 'x' } }),
      ].join('\n') + '\n',
    );

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    expect(data.verdict).toBe('GATHER_MORE_EVIDENCE');
    expect(data.runs.read).toBe(0);
    expect(data.runs.skipped).toHaveLength(1);
    expect(data.runs.skipped[0]!.run).toBe('run-a');
    expect(data.runs.skipped[0]!.why).toMatch(/seq|sequence/i);
  });
});

describe('release-evidence.mjs pointers and --since', () => {
  it('every group pointer names a run, file and seq that readRun actually has', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    const runB = await mkrun(runsDir, 'run-b');
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: AFTER,
    });
    journal.recordDecision({
      runDir: runB,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: AFTER_2,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const group = data.groups.find((g) => g.key === `gate-blocker|code-reviewer|${RULE}`);
    expect(group, JSON.stringify(data.groups)).toBeDefined();
    expect(group!.pointers.length).toBeGreaterThan(0);
    for (const pointer of group!.pointers) {
      expect(pointer.file).toBe('decisions.jsonl');
      const { decisions } = journal.readRun({ runDir: path.join(runsDir, pointer.run) });
      const record = decisions.find((r) => r.seq === pointer.seq);
      expect(
        record,
        `no decisions.jsonl record with seq ${pointer.seq} in ${pointer.run}`,
      ).toBeDefined();
      expect(record!.gate).toBe('code-reviewer');
    }
  });

  it('--since excludes a record dated before it, so one run left after exclusion is only an anecdote', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    const runB = await mkrun(runsDir, 'run-b');
    // run-a's only record is BEFORE `since` — it must not count at all.
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: BEFORE,
    });
    journal.recordDecision({
      runDir: runB,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: AFTER,
    });

    const { data } = await cliJson(['--runs', runsDir, '--since', SINCE]);
    const group = data.groups.find((g) => g.key === `gate-blocker|code-reviewer|${RULE}`);
    expect(group, JSON.stringify(data.groups)).toBeDefined();
    expect(group!.runs).toBe(1);
    expect(group!.records).toBe(1);
    expect(group!.repeated).toBe(false);
    expect(data.verdict).toBe('GATHER_MORE_EVIDENCE');
  });
});

describe('release-evidence.mjs CLI: exit codes', () => {
  it('exits 0 on a REPEATED_PAIN verdict', async () => {
    const runsDir = await runsRoot();
    const runA = await mkrun(runsDir, 'run-a');
    const runB = await mkrun(runsDir, 'run-b');
    journal.recordDecision({
      runDir: runA,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: AFTER,
    });
    journal.recordDecision({
      runDir: runB,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: blocker(RULE),
      now: AFTER_2,
    });

    const result = await cli(['--runs', runsDir, '--since', SINCE, '--json']);
    expect(result.code, result.out).toBe(0);
  });

  it('exits 0 on a GATHER_MORE_EVIDENCE verdict', async () => {
    const runsDir = await runsRoot();
    const result = await cli(['--runs', runsDir, '--since', SINCE, '--json']);
    expect(result.code, result.out).toBe(0);
  });

  it('exits 1 on an unrecognised argument, without printing a JSON document', async () => {
    const runsDir = await runsRoot();
    const result = await cli(['--runs', runsDir, '--since', SINCE, '--bogus']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
  });

  it('exits 1 without --since', async () => {
    const runsDir = await runsRoot();
    const result = await cli(['--runs', runsDir, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('exits 1 when the --runs directory cannot be listed', async () => {
    const runsDir = await runsRoot();
    const missing = path.join(runsDir, 'does-not-exist');
    const result = await cli(['--runs', missing, '--since', SINCE, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
  });
});

describe('release-evidence.mjs imports no queue adapter', () => {
  it('imports nothing from queue/ except checkout.mjs', async () => {
    const source = await readFile(evidenceScript, 'utf8');
    const IMPORT = /from\s+['"](\.\.?\/[^'"]*queue\/[^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? '';
      if (!spec.endsWith('queue/checkout.mjs')) offenders.push(spec);
    }
    expect(offenders, `imports from queue/ beyond checkout.mjs: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });
});
