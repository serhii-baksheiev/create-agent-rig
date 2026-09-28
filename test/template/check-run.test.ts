import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITHUB_PAT, pemHeader } from './secrets-fixtures.js';
import { onlyOnWindows, skipUnless } from '../helpers/env.js';

// RP-290 — "[RIG 1.1][EVIDENCE] Persist required-check failure identity so a
// fresh diagnostician can answer it".
//
// RP-231's pilot ran a required `pnpm test`, it went red, and the durable
// evidence a second controller could read afterward kept neither the failing
// test's identity nor its assertion/exception — the continuation note even
// showed the identity mangled to "[path]> kept was removed" by
// `continuation.mjs`'s own path scrub. A fresh `failure-diagnostician` reading
// only what survived could answer nothing but INCONCLUSIVE.
//
// This file is written against a NEW script, `.claude/scripts/check-run.mjs`,
// which does not exist yet — every test below is expected to fail because the
// script cannot be spawned at all. Its assumed shape:
//
//   node .claude/scripts/check-run.mjs --name <check> [--timeout <seconds>]
//        -- <command> [args...]
//
//   - runs <command> [args...] with no shell interpolation of its own (argv
//     passed straight through to the child), passes its stdout/stderr through
//     to the caller's own stdout/stderr, and exits with the command's exit
//     code (a signal or a timeout exits non-zero).
//   - when RIG_RUN_DIR is declared, appends ONE run-journal event
//     (`.claude/scripts/run-journal.mjs`'s `recordEvent`) of kind
//     `check-result`, `data`: { schema: 1, name, command, outcome:
//     'pass'|'fail', exitCode, signal, timedOut, failedTests, tail (fail
//     only), log }.
//   - when RIG_RUN_DIR is undeclared, runs and exits the same way but writes
//     nothing durable, printing exactly one stderr line saying so.
//
// The independent oracle (`invariants.md`): every expected value below is
// either typed out by hand or computed from a hand-built fixture config, never
// by importing check-run.mjs's own extraction/redaction logic. Recovery tests
// read the run directory back through `run-journal.mjs`'s `readRun` — a
// module this suite does not modify — never through `check-run.mjs` itself,
// and never through the spawned child's own captured stdout, which is exactly
// the evidence RP-231 showed does not survive a fresh session.
//
// The credential fixture (`GITHUB_PAT`) is assembled at runtime by
// `secrets-fixtures.ts`, so this file itself carries no committable secret
// shape — same convention as `continuation.test.ts`.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);

const CHECK_RUN = scriptPath('check-run.mjs');

type RunResult = { code: number; stdout: string; stderr: string; out: string };

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const hermeticEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('RIG_RUN_DIR' in extra)) delete env.RIG_RUN_DIR;
  return env;
};

const runCheckRun = (
  args: string[],
  { cwd, env = hermeticEnv() }: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<RunResult> => run(process.execPath, [CHECK_RUN, ...args], cwd, env);

// --- fixture runners --------------------------------------------------------

/**
 * A generic fake "test runner" fixture: reads a JSON config from its own
 * argv[2] (never from a shell-interpolated string) and prints exactly what
 * the config says, then exits with the configured code. `lines` are printed
 * after `noise` filler lines — the shape a real runner uses (noise first,
 * summary last) and the shape the "keep the END of the output" bound below is
 * checked against.
 */
const RUNNER_SOURCE = `
const config = JSON.parse(process.argv[2] ?? '{}');
const noise = Number(config.noise ?? 0);
const pad = typeof config.noisePad === 'number' ? ' '.repeat(config.noisePad) : '';
for (let i = 0; i < noise; i += 1) {
  process.stdout.write(\`noise line \${i}\${pad}\\n\`);
}
for (const line of config.lines ?? []) {
  process.stdout.write(\`\${line}\\n\`);
}
for (const line of config.stderrLines ?? []) {
  process.stderr.write(\`\${line}\\n\`);
}
const sleepMs = Number(config.sleepMs ?? 0);
const exitCode = Number(config.exitCode ?? 0);
if (sleepMs > 0) {
  setTimeout(() => process.exit(exitCode), sleepMs);
} else {
  process.exit(exitCode);
}
`;

/** Prints its own argv back as JSON — the probe for "no shell interpolation". */
const ECHO_ARGS_SOURCE = `
process.stdout.write(JSON.stringify(process.argv.slice(2)));
process.stdout.write('\\n');
process.exit(0);
`;

/**
 * A fixture that produces exactly one line whose byte length the caller
 * controls, ending in a caller-supplied suffix — built INSIDE the child
 * rather than passed through argv, because a multi-megabyte argv value risks
 * an OS argument-length limit the test has no business tripping.
 */
const LONG_LINE_RUNNER_SOURCE = `
const config = JSON.parse(process.argv[2] ?? '{}');
const bytes = Number(config.longLineBytes ?? 0);
const suffix = config.longLineSuffix ?? '';
const prefixLen = Math.max(0, bytes - Buffer.byteLength(suffix, 'utf8'));
process.stdout.write('x'.repeat(prefixLen) + suffix + '\\n');
process.exit(Number(config.exitCode ?? 0));
`;

/**
 * A grandchild the timeout-kills-the-tree fixture spawns: writes its own pid
 * to `argv[2]` immediately, then sleeps well past any timeout the test uses.
 */
const GRANDCHILD_SOURCE = `
import { writeFileSync } from 'node:fs';
const pidFile = process.argv[2];
writeFileSync(pidFile, String(process.pid));
setTimeout(() => {}, 30000);
`;

/**
 * The direct child check-run spawns for the timeout-kills-the-tree fixture:
 * spawns the grandchild above (detached from check-run's own knowledge — it
 * never appears in check-run's own child handle) and then also sleeps, so
 * killing only the DIRECT child leaves the grandchild orphaned unless
 * check-run kills the whole tree.
 */
const PARENT_SOURCE = `
import { spawn } from 'node:child_process';
const grandchildPath = process.argv[2];
const pidFile = process.argv[3];
spawn(process.execPath, [grandchildPath, pidFile], { stdio: 'ignore' });
setTimeout(() => {}, 30000);
`;

const writeFixture = async (dir: string, name: string, source: string): Promise<string> => {
  const fixturePath = path.join(dir, name);
  await writeFile(fixturePath, source);
  return fixturePath;
};

const runnerCommand = (runnerPath: string, config: Record<string, unknown>): string[] => [
  process.execPath,
  runnerPath,
  JSON.stringify(config),
];

const freshRunDir = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'check-run-'));
const freshCwd = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'check-run-cwd-'));

const loadRunJournal = async () =>
  (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
    readRun: (input: { runDir: string }) => { decisions: unknown[]; events: CheckResultEvent[] };
    recordEvent: (input: Record<string, unknown>) => unknown;
  };

type CheckResultEvent = {
  seq: number;
  at: string;
  kind: string;
  data: {
    schema: number;
    name: string;
    command: string;
    outcome: 'pass' | 'fail';
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    failedTests: string[];
    tail?: string;
    log: string;
  };
};

/** The single `check-result` event a run directory carries, or undefined. */
const latestCheckResult = async (runDir: string): Promise<CheckResultEvent | undefined> => {
  const { readRun } = await loadRunJournal();
  const { events } = readRun({ runDir });
  const checkResults = events.filter(
    (event): event is CheckResultEvent => event.kind === 'check-result',
  );
  return checkResults.at(-1);
};

// --- spawning: no shell interpolation, passthrough, exit code --------------

describe('check-run.mjs spawns the given command with no shell of its own', () => {
  it('passes shell-metacharacter-shaped arguments to the child literally, never expanding them', async () => {
    const cwd = await freshCwd();
    const echoPath = await writeFixture(cwd, 'echo-args.mjs', ECHO_ARGS_SOURCE);
    const weird = ['$(echo pwned)', '*', 'two words', '`backtick`', '&& rm -rf /'];
    const result = await runCheckRun(
      ['--name', 'probe', '--', process.execPath, echoPath, ...weird],
      { cwd },
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain(JSON.stringify(weird));
  });

  it('exits with the child command exit code on success', async () => {
    const cwd = await freshCwd();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const result = await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { exitCode: 0 })],
      { cwd },
    );
    expect(result.code, result.out).toBe(0);
  });

  it('exits with the child command exit code on failure', async () => {
    const cwd = await freshCwd();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const result = await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { exitCode: 7 })],
      { cwd },
    );
    expect(result.code).toBe(7);
  });

  it("passes the child's stdout and stderr through to the caller's own stdout/stderr", async () => {
    const cwd = await freshCwd();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const result = await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: ['hello from stdout'],
          stderrLines: ['hello from stderr'],
          exitCode: 0,
        }),
      ],
      { cwd },
    );
    expect(result.stdout).toContain('hello from stdout');
    expect(result.stderr).toContain('hello from stderr');
  });
});

// --- RIG_RUN_DIR unset -------------------------------------------------------

describe('RIG_RUN_DIR unset', () => {
  it('runs the command and exits with its code, writing nothing durable', async () => {
    const cwd = await freshCwd();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const result = await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { exitCode: 3 })],
      { cwd, env: hermeticEnv() },
    );
    expect(result.code).toBe(3);
  });

  it('prints exactly one stderr line explaining nothing was recorded because no run directory is declared', async () => {
    const cwd = await freshCwd();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const result = await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { exitCode: 0 })],
      { cwd, env: hermeticEnv() },
    );
    const notices = result.stderr.split('\n').filter((line) => /not recorded/i.test(line));
    expect(notices, result.stderr).toHaveLength(1);
    expect(notices[0]).toMatch(/run directory/i);
  });
});

// --- recording a check-result event -----------------------------------------

describe('recording a check-result event when RIG_RUN_DIR is declared', () => {
  it('records a pass with no tail and no failedTests entries', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const result = await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { exitCode: 0 })],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    expect(result.code, result.out).toBe(0);

    const record = await latestCheckResult(runDir);
    expect(record, 'no check-result event was recorded').toBeDefined();
    expect(record!.data.schema).toBe(1);
    expect(record!.data.name).toBe('unit');
    expect(record!.data.outcome).toBe('pass');
    expect(record!.data.exitCode).toBe(0);
    expect(record!.data.signal).toBeNull();
    expect(record!.data.timedOut).toBe(false);
    expect(record!.data.failedTests).toEqual([]);
    expect(record!.data).not.toHaveProperty('tail');
  });

  it('records exactly one check-result event per invocation', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(['--name', 'unit', '--', ...runnerCommand(runnerPath, { exitCode: 0 })], {
      cwd,
      env: hermeticEnv({ RIG_RUN_DIR: runDir }),
    });
    const { readRun } = await loadRunJournal();
    const { events } = readRun({ runDir });
    expect(events.filter((event) => event.kind === 'check-result')).toHaveLength(1);
  });

  it('records the run-dir-relative log path, and the log file exists on disk', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { lines: ['hello'], exitCode: 0 })],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.log).not.toMatch(/^\//);
    expect(record!.data.log).toMatch(/^checks\/.*\.log$/);
    const logContent = await readFile(path.join(runDir, record!.data.log), 'utf8');
    expect(logContent).toContain('hello');
  });

  it('a fresh reader, with no access to the original stdout, recovers the check name, exit code, the failing test id and the assertion line from the run directory alone', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const result = await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [
            ' FAIL  test/e2e/uninstall.test.ts > uninstall > kept was removed',
            'AssertionError: expected 1 to be 0',
          ],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    expect(result.code).not.toBe(0);

    // Deliberately never reads result.stdout/result.stderr below — the
    // whole point is that this evidence survives without the original
    // process output, exactly the gap RP-231/RP-270 measured.
    const record = await latestCheckResult(runDir);
    expect(record!.data.name).toBe('unit');
    expect(record!.data.exitCode).toBe(1);
    expect(record!.data.outcome).toBe('fail');
    expect(record!.data.failedTests).toContain(
      'test/e2e/uninstall.test.ts > uninstall > kept was removed',
    );
    expect(record!.data.tail).toContain('AssertionError: expected 1 to be 0');
  });

  it('extracts a node/TAP "not ok N - <name>" failing test identity', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(
      [
        '--name',
        'tap',
        '--',
        ...runnerCommand(runnerPath, {
          lines: ['not ok 3 - test/foo.test.ts > suite > does the thing'],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.failedTests).toContain('test/foo.test.ts > suite > does the thing');
  });

  it('extracts a "×" bullet-list failing test identity', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: ['  × test/foo.test.ts > suite > another thing'],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.failedTests).toContain('test/foo.test.ts > suite > another thing');
  });

  it('strips ANSI escape codes from the identity and the tail', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const esc = '\u001b';
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [
            `${esc}[31m FAIL  test/e2e/x.test.ts > s > t${esc}[0m`,
            `${esc}[31mAssertionError: boom${esc}[0m`,
          ],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.failedTests).toContain('test/e2e/x.test.ts > s > t');
    expect(record!.data.tail).not.toContain(esc);
    expect(record!.data.tail).toContain('AssertionError: boom');
  });

  it('converts an absolute path to the repo root inside a test identity into a repo-relative one', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const absoluteFile = path.join(cwd, 'test', 'e2e', 'uninstall.test.ts');
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [` FAIL  ${absoluteFile} > uninstall > kept was removed`],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.failedTests).toContain(
      'test/e2e/uninstall.test.ts > uninstall > kept was removed',
    );
    expect(record!.data.failedTests.join(' ')).not.toContain(cwd);
  });

  it('never invents a failedTests entry when the output carries no recognizable failure-shaped line', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: ['Error: something exploded, no test identity here'],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.outcome).toBe('fail');
    expect(record!.data.failedTests).toEqual([]);
  });

  it('bounds failedTests to at most 50 entries, even when the output names more', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const lines = Array.from(
      { length: 80 },
      (_, i) => ` FAIL  test/many.test.ts > suite > case ${i}`,
    );
    await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { lines, exitCode: 1 })],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    // Non-vacuity: an empty array also satisfies "at most 50" — assert there
    // really are entries, or the bound below proves nothing.
    expect(record!.data.failedTests.length).toBeGreaterThan(0);
    expect(record!.data.failedTests.length).toBeLessThanOrEqual(50);
  });

  it('bounds each failedTests entry to at most 300 characters', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const longName = 'x'.repeat(500);
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [` FAIL  test/many.test.ts > suite > ${longName}`],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    // Non-vacuity: an empty array also satisfies "every entry <= 300 chars"
    // vacuously — assert there really is an entry, or the loop below proves
    // nothing.
    expect(record!.data.failedTests.length).toBeGreaterThan(0);
    for (const entry of record!.data.failedTests) {
      expect(entry.length).toBeLessThanOrEqual(300);
    }
  });

  it(
    'bounds the tail to at most 60 lines and 8192 bytes, and the log file to at most 5 MiB, keeping the END of the output',
    { timeout: 20_000 },
    async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
      // ~40 bytes/line * 200,000 lines ~= 8 MB of noise, comfortably over the
      // 5 MiB log cap — followed by the failing summary, so it sits at the
      // very END of the output.
      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          ...runnerCommand(runnerPath, {
            noise: 200_000,
            noisePad: 20,
            lines: [
              ' FAIL  test/e2e/uninstall.test.ts > uninstall > kept was removed',
              'AssertionError: expected 1 to be 0',
            ],
            exitCode: 1,
          }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );

      const record = await latestCheckResult(runDir);
      expect(record!.data.failedTests).toContain(
        'test/e2e/uninstall.test.ts > uninstall > kept was removed',
      );
      const tail = record!.data.tail ?? '';
      expect(tail.split('\n').length).toBeLessThanOrEqual(60);
      expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(8192);
      expect(tail).toContain('AssertionError: expected 1 to be 0');

      const logPath = path.join(runDir, record!.data.log);
      const logContent = await readFile(logPath, 'utf8');
      expect(Buffer.byteLength(logContent, 'utf8')).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(logContent).toContain('AssertionError: expected 1 to be 0');
      expect(logContent).toContain(
        'FAIL  test/e2e/uninstall.test.ts > uninstall > kept was removed',
      );
      // The END is kept, not the start: the very first noise line must not
      // have survived a 5 MiB cap over ~8 MB of input.
      expect(logContent).not.toContain('noise line 0 ');
    },
  );
});

// --- secret-shaped output never reaches durable evidence --------------------

describe('secret-shaped output is redacted before anything is written', () => {
  it('redacts a credential-shaped value out of the tail, while the assertion and identity survive', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [
            ' FAIL  test/e2e/uninstall.test.ts > uninstall > kept was removed',
            'AssertionError: expected 1 to be 0',
            `token leak: ${GITHUB_PAT}`,
          ],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.tail).not.toContain(GITHUB_PAT);
    expect(record!.data.tail).toContain('AssertionError: expected 1 to be 0');
    expect(record!.data.failedTests).toContain(
      'test/e2e/uninstall.test.ts > uninstall > kept was removed',
    );
  });

  it('redacts a credential-shaped value out of the recorded command field', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const echoPath = await writeFixture(cwd, 'echo-args.mjs', ECHO_ARGS_SOURCE);
    await runCheckRun(['--name', 'unit', '--', process.execPath, echoPath, GITHUB_PAT], {
      cwd,
      env: hermeticEnv({ RIG_RUN_DIR: runDir }),
    });
    const record = await latestCheckResult(runDir);
    expect(record!.data.command).not.toContain(GITHUB_PAT);
  });

  it('never leaves a credential-shaped value in the log file on disk', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [`secret: ${GITHUB_PAT}`, 'other output line'],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    const logContent = await readFile(path.join(runDir, record!.data.log), 'utf8');
    expect(logContent).not.toContain(GITHUB_PAT);
  });

  it('redacts a credential-shaped value embedded inside a failing test identity', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [` FAIL  test/e2e/x.test.ts > suite > ${GITHUB_PAT}`],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );
    const record = await latestCheckResult(runDir);
    expect(record!.data.failedTests.join(' ')).not.toContain(GITHUB_PAT);
  });
});

// --- timeout classification --------------------------------------------------

describe('--timeout classifies a hung command as a timed-out failure', () => {
  it(
    'kills a command sleeping 30s under a 1s timeout, classifies it fail/timedOut, and returns well under the deadline',
    { timeout: 20_000 },
    async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
      const start = Date.now();
      const result = await runCheckRun(
        [
          '--name',
          'unit',
          '--timeout',
          '1',
          '--',
          ...runnerCommand(runnerPath, { sleepMs: 30_000, exitCode: 0 }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const elapsedMs = Date.now() - start;

      expect(result.code).not.toBe(0);
      expect(elapsedMs).toBeLessThan(15_000);

      const record = await latestCheckResult(runDir);
      expect(record!.data.outcome).toBe('fail');
      expect(record!.data.timedOut).toBe(true);
    },
  );
});

// --- non-vacuity: the evidence exists only because check-run wrote it -------
//
// RP-290 review round 1 — the previous version of this block never ran
// check-run.mjs at all: it recorded an unrelated `branch-created` event by
// hand and asserted no `check-result` turned up, which is true of ANY run
// directory that never saw a check-run invocation, whether or not check-run
// itself still records evidence correctly. It could not go red if the
// recording call were deleted from check-run.mjs. The pair below fixes that:
// the SAME fixture, run the SAME way, once WITHOUT check-run (plain spawn)
// and once THROUGH check-run — so removing check-run's own recordEvent call
// makes the second test fail while the first stays green, which is what
// makes the first test's "no evidence" meaningful rather than tautological.

describe('non-vacuity — this evidence exists only because check-run wrote it', () => {
  const FIXTURE_LINES = [' FAIL  test/e2e/uninstall.test.ts > uninstall > kept was removed'];

  it('running the fixture directly (no check-run, RIG_RUN_DIR set) leaves the run journal with no check-result evidence', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);

    await new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [runnerPath, JSON.stringify({ lines: FIXTURE_LINES, exitCode: 1 })],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
        () => resolve(),
      );
    });

    const record = await latestCheckResult(runDir);
    expect(record).toBeUndefined();

    const { readRun } = await loadRunJournal();
    const { events } = readRun({ runDir });
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('kept was removed');
  });

  it('the SAME fixture run through check-run.mjs (RIG_RUN_DIR set) DOES carry check-result evidence — the paired case that makes the test above meaningful', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);

    await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { lines: FIXTURE_LINES, exitCode: 1 })],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );

    const record = await latestCheckResult(runDir);
    expect(record, 'no check-result event was recorded').toBeDefined();
    expect(record!.data.outcome).toBe('fail');
    expect(record!.data.failedTests).toContain(
      'test/e2e/uninstall.test.ts > uninstall > kept was removed',
    );
  });
});

// --- spawn errors: a command that cannot be started at all ------------------
//
// RP-290 review round 1 blocker 1 — a command that fails to even START (a
// missing executable) is currently indistinguishable, in the recorded
// evidence, from a command that ran and exited non-zero: both land as
// outcome 'fail'. A fresh diagnostician reading only the journal cannot tell
// "the test failed" from "the check command was misconfigured/missing" —
// which is a different fix in a different place.

describe('a command that cannot be started at all', () => {
  it('exits non-zero and prints a stderr line naming the spawn failure', async () => {
    const cwd = await freshCwd();
    const missing = `no-such-command-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await runCheckRun(['--name', 'probe', '--', missing], { cwd });

    expect(result.code).not.toBe(0);
    const spawnLines = result.stderr.split('\n').filter((line) => /spawn/i.test(line));
    expect(spawnLines, result.out).not.toHaveLength(0);
  });

  it("records outcome 'spawn-error' in the journal — never 'fail' — with no failedTests and no tail", async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const missing = `no-such-command-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await runCheckRun(['--name', 'unit', '--', missing], {
      cwd,
      env: hermeticEnv({ RIG_RUN_DIR: runDir }),
    });

    const record = await latestCheckResult(runDir);
    expect(record, 'no check-result event was recorded').toBeDefined();
    expect(record!.data.outcome).toBe('spawn-error');
    expect(record!.data.failedTests).toEqual([]);
    expect(record!.data).not.toHaveProperty('tail');
  });

  it('leaves no check-run capture temp file behind after a spawn-error run', async () => {
    const cwd = await freshCwd();
    const captureTmpDir = await mkdtemp(path.join(tmpdir(), 'check-run-capture-'));
    const missing = `no-such-command-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await runCheckRun(['--name', 'unit', '--', missing], {
      cwd,
      env: hermeticEnv({ TMPDIR: captureTmpDir, TEMP: captureTmpDir, TMP: captureTmpDir }),
    });

    const leftover = (await readdir(captureTmpDir)).filter((name) => name.startsWith('check-run-'));
    expect(leftover, leftover.join(', ')).toEqual([]);
  });
});

describe('temp capture files do not leak after an ordinary failing run', () => {
  it('leaves no check-run capture temp file behind after a normal failing run', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const captureTmpDir = await mkdtemp(path.join(tmpdir(), 'check-run-capture-'));
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);

    await runCheckRun(
      ['--name', 'unit', '--', ...runnerCommand(runnerPath, { lines: ['boom'], exitCode: 1 })],
      {
        cwd,
        env: hermeticEnv({
          RIG_RUN_DIR: runDir,
          TMPDIR: captureTmpDir,
          TEMP: captureTmpDir,
          TMP: captureTmpDir,
        }),
      },
    );

    const leftover = (await readdir(captureTmpDir)).filter((name) => name.startsWith('check-run-'));
    expect(leftover, leftover.join(', ')).toEqual([]);
  });
});

// --- Windows .cmd shims: no shell interpolation of an argument --------------
//
// RP-290 review round 1 — a `.cmd`/`.bat` command on Windows is spawned by
// Node through `cmd.exe` even without `shell: true`; an argument containing a
// shell metacharacter (`&`) has to survive as ONE literal argument rather
// than being read as a second command. This can only be measured on Windows
// itself — `onlyOnWindows()` is the named, reason-carrying skip
// `platform-skips.test.ts` requires in place of a bare platform check.

describe('Windows .cmd shims are run without shell interpolation of the argument', () => {
  it('passes an argument containing a space and & through a .cmd shim literally, and exits with its code', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const cmdPath = path.join(cwd, 'fake.cmd');
    await writeFile(cmdPath, '@echo off\r\necho %1\r\nexit /b 3\r\n');
    const weirdArg = 'a b&c';

    const result = await runCheckRun(['--name', 'cmdshim', '--', cmdPath, weirdArg], {
      cwd,
      env: hermeticEnv({ RIG_RUN_DIR: runDir }),
    });

    expect(result.code).toBe(3);
    expect(result.stdout).toContain(weirdArg);
    // Nothing after the `&` ran as a second command (e.g. `c` interpreted as
    // its own command line) — cmd.exe's own "not recognized" message is the
    // tell if the argument leaked out of its quoting.
    expect(result.stdout).not.toMatch(/is not recognized as an internal or external command/i);

    const record = await latestCheckResult(runDir);
    expect(record!.data.outcome).toBe('fail');
    expect(record!.data.exitCode).toBe(3);
  });
});

// --- a PEM private-key block spans multiple lines ----------------------------
//
// RP-290 review round 1 — `findSecretValues` (and the `private-key-block`
// pattern it carries) is applied PER LINE, and only the BEGIN line matches
// that pattern's shape. Today's per-line redaction therefore replaces only
// the BEGIN line with `[redacted]` and lets the base64 KEY BODY and the END
// line — the actual key material — straight through to both the tail and the
// log file on disk. check-run needs to track "inside an unterminated PEM
// block" across lines and redact the whole span, the same whole-unit rule
// `continuation.mjs` already applies to a single field (see that module's
// header, "Limits").

describe('a PEM private-key block spans multiple lines and must be redacted as a whole', () => {
  const PEM_BODY_LINES = [
    'MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAuABCDEFGHIJKLMN',
    'OPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN',
    'OPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLzz',
  ];
  const PEM_END = '-----END RSA PRIVATE KEY-----';

  it('redacts the body and END line of a terminated PEM block, while a line after END survives', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const afterLine = 'ordinary text after the key block';

    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [pemHeader(), ...PEM_BODY_LINES, PEM_END, afterLine],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );

    const record = await latestCheckResult(runDir);
    const logContent = await readFile(path.join(runDir, record!.data.log), 'utf8');
    const tail = record!.data.tail ?? '';

    for (const bodyLine of PEM_BODY_LINES) {
      expect(logContent, 'key body leaked into the log').not.toContain(bodyLine);
      expect(tail, 'key body leaked into the tail').not.toContain(bodyLine);
    }
    expect(logContent, 'END line leaked into the log').not.toContain(PEM_END);
    expect(tail, 'END line leaked into the tail').not.toContain(PEM_END);

    expect(logContent, 'text after END did not survive in the log').toContain(afterLine);
    expect(tail, 'text after END did not survive in the tail').toContain(afterLine);
  });

  it('redacts everything after an UNTERMINATED BEGIN block, to the end of the output', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);

    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [pemHeader(), ...PEM_BODY_LINES],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );

    const record = await latestCheckResult(runDir);
    const logContent = await readFile(path.join(runDir, record!.data.log), 'utf8');
    for (const bodyLine of PEM_BODY_LINES) {
      expect(logContent, 'key body leaked into the log with no END line at all').not.toContain(
        bodyLine,
      );
    }
  });
});

// --- a single line longer than the credential scan limit ---------------------
//
// RP-290 review round 1 — `findSecretValues` reads at most `DEFAULT_SCAN_LIMIT`
// (2 MiB) of the text it is given (`lib/secrets.mjs`'s own stated bound). A
// single output line longer than that, ending in a credential-shaped value
// past the 2 MiB mark, is invisible to the per-line secret scan today — the
// line passes through untouched, credential included. check-run needs its
// own length bound on a single line, independent of the credential scan,
// that replaces an over-long line with a marker rather than trusting the
// scan to have seen all of it.

describe('a single line longer than the credential scan limit', () => {
  it(
    'replaces an over-long line ending in a credential with a marker, never the credential, and finishes quickly',
    { timeout: 20_000 },
    async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(cwd, 'long-line-runner.mjs', LONG_LINE_RUNNER_SOURCE);
      const start = Date.now();

      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          process.execPath,
          runnerPath,
          JSON.stringify({
            longLineBytes: 3 * 1024 * 1024,
            longLineSuffix: GITHUB_PAT,
            exitCode: 1,
          }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(20_000);

      const record = await latestCheckResult(runDir);
      const logContent = await readFile(path.join(runDir, record!.data.log), 'utf8');
      const tail = record!.data.tail ?? '';

      expect(logContent, 'credential leaked into the log').not.toContain(GITHUB_PAT);
      expect(tail, 'credential leaked into the tail').not.toContain(GITHUB_PAT);
      expect(logContent).toMatch(/\[redacted: line over \d+ bytes\]/);
    },
  );
});

// --- a tail whose final line is itself very long -----------------------------
//
// RP-290 review round 1 — `buildTail` trims by shifting WHOLE lines off the
// front until the joined text fits `TAIL_MAX_BYTES`. When the last surviving
// line is itself longer than `TAIL_MAX_BYTES`, that shift-loop removes it
// too — the only line left — and the tail comes back EMPTY, discarding the
// one line a reader needed most (the assertion). The fix has to trim WITHIN
// a line that is itself over the cap, not just drop it.

describe('a tail whose final line is itself longer than the tail byte cap', () => {
  it('keeps the tail non-empty, within the byte cap, and ending with the tail of the long assertion line', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const longAssertion = `AssertionError: ${'x'.repeat(9000)}`;

    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [' FAIL  test/a.test.ts > s > t', longAssertion],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );

    const record = await latestCheckResult(runDir);
    const tail = record!.data.tail ?? '';

    expect(tail.length, 'the tail came back empty').toBeGreaterThan(0);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(8192);
    expect(tail.endsWith(longAssertion.slice(-100)), tail.slice(-120)).toBe(true);
  });
});

// --- --timeout kills the whole process tree, not only the direct child -----
//
// RP-290 review round 1 — `child.kill('SIGKILL')` on timeout kills only the
// DIRECT child check-run spawned. A check command that itself spawns a
// worker/child process (a test runner spawning workers is the ordinary
// shape) leaves that descendant running as an orphan once the direct child
// is gone — exactly the shape a hung worker process leaks across runs.

describe('--timeout kills the whole process tree, not only the direct child', () => {
  it(
    'a grandchild process spawned by the checked command is no longer alive after check-run returns',
    { timeout: 20_000 },
    async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const grandchildPath = await writeFixture(cwd, 'grandchild.mjs', GRANDCHILD_SOURCE);
      const parentPath = await writeFixture(cwd, 'parent.mjs', PARENT_SOURCE);
      const pidFile = path.join(cwd, 'grandchild.pid');

      const start = Date.now();
      await runCheckRun(
        [
          '--name',
          'unit',
          '--timeout',
          '1',
          '--',
          process.execPath,
          parentPath,
          grandchildPath,
          pidFile,
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(15_000);

      // The grandchild writes its own pid almost immediately; poll briefly
      // rather than assuming it has already landed on disk.
      let pidText = '';
      for (let i = 0; i < 30 && pidText === ''; i += 1) {
        try {
          pidText = (await readFile(pidFile, 'utf8')).trim();
        } catch {
          // not written yet
        }
        if (pidText === '') await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pidText, 'the grandchild never wrote its pid file').not.toBe('');
      const grandchildPid = Number(pidText);

      const isAlive = (): boolean => {
        try {
          process.kill(grandchildPid, 0);
          return true;
        } catch {
          return false;
        }
      };

      // Allow up to ~3s of polling after check-run has already returned.
      let alive = isAlive();
      for (let i = 0; i < 30 && alive; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        alive = isAlive();
      }
      expect(alive, `grandchild pid ${grandchildPid} is still alive`).toBe(false);
    },
  );
});

// --- wired into Core ---------------------------------------------------------

describe('check-run.mjs is wired into Core', () => {
  it('layers.json lists the script under the process (Core) array', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(universalDir, 'layers.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(manifest['process']).toContain('.claude/scripts/check-run.mjs');
  });
});

// Silence "unused import" if a future edit trims mkdir/writeFile usage above —
// both are used by writeFixture; mkdir is kept available for any fixture that
// later needs a nested directory.
void mkdir;
