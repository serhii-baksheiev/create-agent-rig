import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { removeFixture } from '../helpers/remove-fixture.js';

// RP-523: compare only the two review decisions the operator names. The run
// journal is the evidence already captured at review time; this CLI only reads
// it and reports the difference between those two records.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const cliPath = path.join(scriptsDir, 'verdict.mjs');
const journalPath = path.join(scriptsDir, 'run-journal.mjs');
const fixtures = new Set<string>();

afterAll(async () => {
  await Promise.all([...fixtures].map(async (fixture) => await removeFixture(fixture)));
});

type RecordFields = Record<string, unknown>;

interface Journal {
  recordDecision(input: RecordFields): RecordFields | Promise<RecordFields>;
  readRun(input: {
    runDir: string;
  }): { decisions: RecordFields[] } | Promise<{ decisions: RecordFields[] }>;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  out: string;
}

const loadJournal = async (): Promise<Journal> =>
  (await import(pathToFileURL(journalPath).href)) as unknown as Journal;

const newRun = async (): Promise<{
  runDir: string;
  decide: (fields: RecordFields) => Promise<RecordFields>;
  readRun: () => Promise<{ decisions: RecordFields[] }>;
}> => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'review-findings-'));
  fixtures.add(runDir);
  const journal = await loadJournal();
  let count = 0;
  return {
    runDir,
    decide: async (fields) =>
      await journal.recordDecision({
        runDir,
        why: null,
        now: `2026-10-18T22:${String(count++).padStart(2, '0')}:00.000Z`,
        ...fields,
      }),
    readRun: async () => await journal.readRun({ runDir }),
  };
};

const runCli = (args: string[], runDir?: string): Promise<CliResult> =>
  new Promise((resolve) => {
    const env = { ...process.env };
    delete env.RIG_RUN_DIR;
    if (runDir !== undefined) env.RIG_RUN_DIR = runDir;
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: repoRoot, env, timeout: 10_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          out: String(stdout) + String(stderr),
        });
      },
    );
  });

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD_C = 'cccccccccccccccccccccccccccccccccccccccc';

const finding = (over: RecordFields = {}): RecordFields => ({
  file: 'packages/cli/src/review.ts',
  line: 17,
  rule: 'The review report must name the violated rule.',
  note: 'The report only says that the result is concerning.',
  ...over,
});

const snapshot = async (runDir: string): Promise<Map<string, string>> => {
  const names = await readdir(runDir);
  return new Map(
    await Promise.all(
      names.map(async (name) => [name, await readFile(path.join(runDir, name), 'utf8')] as const),
    ),
  );
};

const expectRefusal = async (
  args: string[],
  runDir: string | undefined,
  diagnosis: RegExp,
): Promise<void> => {
  const result = await runCli(args, runDir);
  expect(result.code, result.out).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(diagnosis);
};

describe('`findings` compares exactly two already-journaled review decisions', () => {
  it('classifies mixed stable-id and legacy findings from the requested records without writing the journal', async () => {
    const run = await newRun();
    const priorStable = finding({ id: 'finding-17', line: 17, note: 'The original note.' });
    const priorLegacy = finding({
      file: 'packages/cli/src/legacy.ts',
      line: 4,
      rule: 'Legacy findings match every tuple field.',
      note: 'The legacy note.',
    });
    const before = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [priorStable, priorLegacy],
      headSha: HEAD_A,
    });
    const currentStable = finding({
      id: 'finding-17',
      line: 29,
      note: 'The note and line changed, but this is the same finding.',
    });
    const currentNew = finding({
      id: 'finding-new',
      file: 'packages/cli/src/new.ts',
      line: 9,
      rule: 'New findings remain visible.',
      note: 'This finding exists only in the second review.',
    });
    const after = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [currentStable, currentNew],
      headSha: HEAD_B,
    });
    // A later record is deliberately unrelated. The requested sequence pair,
    // rather than the latest reviewer result in the run, is the comparison.
    await run.decide({
      gate: 'security-scanner',
      verdict: 'HOLD',
      blockers: [finding({ id: 'later-security' })],
      headSha: HEAD_C,
    });

    const records = (await run.readRun()).decisions;
    expect(records.map((record) => record.seq)).toEqual([before.seq, after.seq, 3]);
    const bytesBefore = await snapshot(run.runDir);
    const result = await runCli(['findings', String(before.seq), String(after.seq)], run.runDir);

    expect(result.code, result.out).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      before: { seq: before.seq, gate: 'code-reviewer', headSha: HEAD_A },
      after: { seq: after.seq, gate: 'code-reviewer', headSha: HEAD_B },
      resolved: [priorLegacy],
      unresolved: [currentStable],
      new: [currentNew],
    });
    expect(await snapshot(run.runDir)).toEqual(bytesBefore);
  });

  it('uses the full legacy tuple when neither finding has an id', async () => {
    const run = await newRun();
    const unchanged = finding({ file: 'a.ts', line: 2, rule: 'same rule', note: 'same note' });
    const beforeFinding = finding({ file: 'b.ts', line: 3, rule: 'same rule', note: 'old note' });
    const afterFinding = finding({ ...beforeFinding, note: 'new note' });
    const before = await run.decide({
      gate: 'prose-reviewer',
      verdict: 'HOLD',
      blockers: [unchanged, beforeFinding],
      headSha: HEAD_A,
    });
    const after = await run.decide({
      gate: 'prose-reviewer',
      verdict: 'HOLD',
      blockers: [unchanged, afterFinding],
      headSha: HEAD_B,
    });

    const result = await runCli(['findings', String(before.seq), String(after.seq)], run.runDir);
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      resolved: [beforeFinding],
      unresolved: [unchanged],
      new: [afterFinding],
    });
  });

  it('keeps a locationless legacy finding unresolved when its rule and note are unchanged', async () => {
    const run = await newRun();
    const original = {
      rule: 'The report must identify the violated requirement.',
      note: 'This valid finding has no location to cite.',
    };
    const current = { ...original };
    const before = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [original],
      headSha: HEAD_A,
    });
    const after = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [current],
      headSha: HEAD_B,
    });

    const result = await runCli(['findings', String(before.seq), String(after.seq)], run.runDir);
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      resolved: [],
      unresolved: [current],
      new: [],
    });
  });

  it('refuses missing, non-integer, or reversed requested sequences', async () => {
    const run = await newRun();
    await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [finding()],
      headSha: HEAD_A,
    });
    await run.decide({ gate: 'code-reviewer', verdict: 'SHIP', blockers: [], headSha: HEAD_B });

    await expectRefusal(['findings', '99', '1'], run.runDir, /before record.*99|record.*before/i);
    await expectRefusal(
      ['findings', '1.5', '2'],
      run.runDir,
      /positive integer.*sequence|sequence.*positive integer/i,
    );
    await expectRefusal(
      ['findings', '2', '1'],
      run.runDir,
      /after sequence.*greater|increasing sequence/i,
    );
  });

  it('refuses records from different reviewer roles', async () => {
    const run = await newRun();
    const before = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [finding()],
      headSha: HEAD_A,
    });
    const after = await run.decide({
      gate: 'security-scanner',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_B,
    });
    await expectRefusal(
      ['findings', String(before.seq), String(after.seq)],
      run.runDir,
      /same reviewer role|reviewer roles differ/i,
    );
  });

  it('refuses a decision that omitted its blocker array', async () => {
    const run = await newRun();
    const before = await run.decide({ gate: 'code-reviewer', verdict: 'HOLD', headSha: HEAD_A });
    const after = await run.decide({
      gate: 'code-reviewer',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_B,
    });
    await expectRefusal(
      ['findings', String(before.seq), String(after.seq)],
      run.runDir,
      /explicit blockers array|blockers array.*required/i,
    );
  });

  it('refuses a reviewer decision whose verdict is not SHIP or HOLD', async () => {
    const run = await newRun();
    const before = await run.decide({
      gate: 'code-reviewer',
      verdict: 'NOT_APPLICABLE',
      blockers: [],
      headSha: HEAD_A,
    });
    const after = await run.decide({
      gate: 'code-reviewer',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_B,
    });
    await expectRefusal(
      ['findings', String(before.seq), String(after.seq)],
      run.runDir,
      /only SHIP or HOLD|reviewer decision.*SHIP.*HOLD/i,
    );
  });

  it('refuses a decision without the head it reviewed', async () => {
    const run = await newRun();
    const before = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [finding()],
    });
    const after = await run.decide({
      gate: 'code-reviewer',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_B,
    });
    await expectRefusal(
      ['findings', String(before.seq), String(after.seq)],
      run.runDir,
      /explicit headSha|reviewed head/i,
    );
  });

  it('refuses duplicate stable finding identities rather than collapsing them', async () => {
    const run = await newRun();
    const before = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [finding({ id: 'duplicate' }), finding({ id: 'duplicate', line: 18 })],
      headSha: HEAD_A,
    });
    const after = await run.decide({
      gate: 'code-reviewer',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_B,
    });
    await expectRefusal(
      ['findings', String(before.seq), String(after.seq)],
      run.runDir,
      /duplicate finding identity|ambiguous finding identity/i,
    );
  });

  it('refuses inherited vocabulary property names as non-reviewer roles without a raw stack', async () => {
    for (const gate of ['constructor', '__proto__']) {
      const run = await newRun();
      const before = await run.decide({
        gate,
        verdict: 'HOLD',
        blockers: [finding()],
        headSha: HEAD_A,
      });
      const after = await run.decide({
        gate,
        verdict: 'SHIP',
        blockers: [],
        headSha: HEAD_B,
      });
      const result = await runCli(['findings', String(before.seq), String(after.seq)], run.runDir);
      expect(result.code, result.out).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/not a reviewer decision|reviewer.*vocabulary/i);
      expect(result.stderr).not.toMatch(/TypeError|at reviewedDecision|at isReviewerGate/i);
    }
  });

  it('writes the complete findings JSON before reporting success for a large resolved set', async () => {
    const run = await newRun();
    const blockers = Array.from({ length: 100 }, (_, index) =>
      finding({ id: `pipe-${index}`, rule: `rule ${index}`, note: 'x'.repeat(2048) }),
    );
    const before = await run.decide({
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers,
      headSha: HEAD_A,
    });
    const after = await run.decide({
      gate: 'code-reviewer',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_B,
    });

    const result = await runCli(['findings', String(before.seq), String(after.seq)], run.runDir);
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      resolved: blockers,
      unresolved: [],
      new: [],
    });
  });

  it('refuses an undeclared or unreadable run directory with no stdout verdict', async () => {
    await expectRefusal(
      ['findings', '1', '2'],
      undefined,
      /RIG_RUN_DIR.*declared|declared.*RIG_RUN_DIR/i,
    );
    await expectRefusal(
      ['findings', '1', '2'],
      path.join(tmpdir(), 'review-findings-does-not-exist'),
      /run journal.*could not be read|could not read.*run journal/i,
    );
  });
});
