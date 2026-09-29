import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GITHUB_PAT, pemHeader } from './secrets-fixtures.js';
import { onlyOnWindows, skipUnless, symlinksAvailable } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * The opposite of `onlyOnWindows()`: behaviour that exists only off Windows.
 * A SIGINT delivered to ONE pid, and the process-group semantics that make
 * that meaningful, are POSIX signal delivery — there is no Windows analogue
 * (`CreateProcess` has nothing like `process.kill(pid, 'SIGINT')` targeting a
 * single process apart from its group), so this test is measured only where
 * the capability genuinely exists — same shape as `onlyOnWindows()`, kept
 * local to this file rather than added to `env.ts` because nothing else here
 * needs it yet.
 */
const onlyOnPosix = (): { ok: boolean; reason: string } => ({
  ok: process.platform !== 'win32',
  reason:
    'SIGINT delivered to a single pid (not its process group) is POSIX signal delivery; there is no Windows equivalent to measure',
});

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

// Test hygiene (RP-290 review round 2) — every mkdtemp fixture directory this
// file creates is tracked here and removed in the afterEach below, so a run
// of this file does not leak a `check-run-*`/`check-run-cwd-*`/
// `check-run-capture-*` directory into the OS temp dir per test. Reset after
// each test (not accumulated for the whole file) so cleanup happens promptly
// even in a file this size.
let createdTempDirs: string[] = [];
const trackedMkdtemp = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(prefix);
  createdTempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  const dirs = createdTempDirs;
  createdTempDirs = [];
  await Promise.all(dirs.map((dir) => removeFixture(dir)));
});

const freshRunDir = async (): Promise<string> => trackedMkdtemp(path.join(tmpdir(), 'check-run-'));
const freshCwd = async (): Promise<string> => trackedMkdtemp(path.join(tmpdir(), 'check-run-cwd-'));

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

  // RP-290 — the relativize helper strips only the LITERAL
  // `${process.cwd()}${path.sep}` prefix. windows-e2e and macos-e2e both
  // showed this is not enough: on macOS the child's cwd is a REALPATH while a
  // real runner can print the identity anchored to a SYMLINKED alias of that
  // same directory (or vice versa) — two on-disk names for one directory,
  // only one of which matches the literal prefix. The two cases below
  // reproduce that mismatch on Linux, where it is otherwise unmeasured:
  // `<tmp>/real` and a symlink `<tmp>/link -> real`, check-run itself spawned
  // with `cwd` set to the LINK path (Node's own `process.cwd()` inside a
  // spawned process resolves to the REALPATH regardless of which alias it was
  // started under — verified directly against this repo's own Node/WSL
  // before writing this pair), and a fixture runner that prints the failing
  // test's identity anchored to one alias or the other. Both must relativize
  // to the exact same repo-relative id — the alias the runner happened to
  // print must never leak into the recorded evidence.
  describe('a symlinked cwd — the recorded id must not depend on which alias the runner printed', () => {
    it('strips the prefix when the runner prints the identity anchored to the REALPATH', async (ctx) => {
      skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
      const parentDir = await freshCwd();
      const realDir = path.join(parentDir, 'real');
      const linkDir = path.join(parentDir, 'link');
      await mkdir(realDir, { recursive: true });
      await symlink(realDir, linkDir);
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(realDir, 'runner.mjs', RUNNER_SOURCE);
      const resolvedReal = await realpath(linkDir);
      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          ...runnerCommand(runnerPath, {
            lines: [
              ` FAIL  ${resolvedReal}/test/e2e/uninstall.test.ts > uninstall > kept was removed`,
            ],
            exitCode: 1,
          }),
        ],
        { cwd: linkDir, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const record = await latestCheckResult(runDir);
      expect(record!.data.failedTests).toContain(
        'test/e2e/uninstall.test.ts > uninstall > kept was removed',
      );
    });

    it('keeps an identity printed under an arbitrary symlink alias of cwd absolute — resolving it would take filesystem probes driven by runner output', async (ctx) => {
      skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
      const parentDir = await freshCwd();
      const realDir = path.join(parentDir, 'real');
      const linkDir = path.join(parentDir, 'link');
      await mkdir(realDir, { recursive: true });
      await symlink(realDir, linkDir);
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(realDir, 'runner.mjs', RUNNER_SOURCE);
      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          ...runnerCommand(runnerPath, {
            lines: [` FAIL  ${linkDir}/test/e2e/uninstall.test.ts > uninstall > kept was removed`],
            exitCode: 1,
          }),
        ],
        { cwd: linkDir, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const record = await latestCheckResult(runDir);
      // The filesystem ancestor walk that used to resolve an arbitrary
      // symlink alias of cwd (`resolveAliasedPath`) was removed: security-scanner's
      // round on 24dc895 found it drove fs probes off untrusted runner
      // output (a UNC-looking alias meant an SMB/NTLM connection attempt on
      // Windows, measured 21s per id) and did unbounded work even to
      // discover the file does not exist. The identity is now kept exactly
      // as printed instead of being resolved to a repo-relative path.
      expect(record!.data.failedTests).toContain(
        `${linkDir}/test/e2e/uninstall.test.ts > uninstall > kept was removed`,
      );
    });
  });

  // RP-290 — the same subtraction: `resolveAliasedPath`'s ancestor walk did
  // an `existsSync`/`realpathSync.native` per ancestor of an already-extracted
  // failing-test identity, driven entirely by whatever the checked command's
  // own (untrusted) output happened to print. Two costs that walk paid, now
  // gone with it: a UNC-looking absolute path (`//host/share/...`) means a
  // real SMB/NTLM connection attempt on Windows before `existsSync` even
  // returns — measured 21s per id — and a very deep path walks one ancestor
  // per path segment, unbounded by anything this process controls. Neither
  // fixture below can demonstrate the SMB cost directly off Windows (there is
  // no SMB stack to probe), so the assertions are honest about being a weak
  // guard on this platform and a real one only on win32.
  describe('does not touch the filesystem for a UNC-looking failing-test path in runner output', () => {
    it('does not touch the filesystem for a UNC-looking failing-test path in runner output', async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
      const uncPath = '//192.0.2.1/share/a/b.test.ts';
      const start = Date.now();
      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          ...runnerCommand(runnerPath, { lines: [` FAIL  ${uncPath} > t`], exitCode: 1 }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const elapsedMs = Date.now() - start;
      // On Linux `//192.0.2.1/...` collapses to an ordinary, nonexistent
      // local path — this timing assertion is a weak guard here. The win32
      // case (below) is the one where the same shape is a real UNC path and
      // existsSync/realpathSync over it means an SMB/NTLM connection
      // attempt — that's the real guard.
      expect(elapsedMs).toBeLessThan(5000);
      const record = await latestCheckResult(runDir);
      expect(record!.data.failedTests).toContain(`${uncPath} > t`);
    });

    it('does not touch the filesystem for a backslash-form UNC-looking failing-test path (win32)', async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
      const uncPath = '\\\\192.0.2.1\\share\\a\\b.test.ts';
      const start = Date.now();
      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          ...runnerCommand(runnerPath, { lines: [` FAIL  ${uncPath} > t`], exitCode: 1 }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(5000);
      const record = await latestCheckResult(runDir);
      // Backslash-to-forward-slash normalization of the path portion is a
      // SEPARATE, always-applied step (`normalizeFailedTestId`) that this
      // change does not touch — only the fs-probing alias walk is removed —
      // so "unchanged" here means unresolved, not un-normalized.
      expect(record!.data.failedTests).toContain(`${uncPath.split('\\').join('/')} > t`);
    });
  });

  /**
   * Builds ITS OWN deep, `/a/a/a/…`-shaped absolute path from `segments`,
   * then prints `lineCount` FAIL lines each carrying that same deep path
   * (varied only by a trailing case index) — built INSIDE the child, for the
   * same reason `LONG_LINE_RUNNER_SOURCE` is: `segments * lineCount` bytes of
   * deep-path text would risk an OS argv-length limit if assembled by the
   * caller and passed through argv instead (measured directly: passing the
   * assembled lines through argv here hits `E2BIG`).
   */
  const DEEP_PATH_RUNNER_SOURCE = `
const config = JSON.parse(process.argv[2] ?? '{}');
const segments = Number(config.segments ?? 0);
const lineCount = Number(config.lineCount ?? 0);
const deepPath = '/' + Array.from({ length: segments }, () => 'a').join('/') + '/b.test.ts';
for (let i = 0; i < lineCount; i += 1) {
  process.stdout.write(\` FAIL  \${deepPath} > suite > case \${i}\\n\`);
}
process.exit(Number(config.exitCode ?? 0));
`;

  describe('bounds the cost of a very deep failing-test path', () => {
    it(
      'finishes quickly and records at most 50 entries, each at most 300 characters, for 50 lines each carrying a ~20 KB deep path',
      { timeout: 20_000 },
      async () => {
        const cwd = await freshCwd();
        const runDir = await freshRunDir();
        const runnerPath = await writeFixture(cwd, 'deep-path-runner.mjs', DEEP_PATH_RUNNER_SOURCE);
        const start = Date.now();
        await runCheckRun(
          [
            '--name',
            'unit',
            '--',
            process.execPath,
            runnerPath,
            JSON.stringify({ segments: 10_000, lineCount: 50, exitCode: 1 }),
          ],
          { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
        );
        const elapsedMs = Date.now() - start;
        // Measured ~2.9s per 10k-segment line on Windows (the ancestor walk
        // `resolveAliasedPath` performed per already-extracted failing-test
        // identity) — 50 such lines alone exceeds this bound there. On
        // Linux the same walk is fast (measured well under 1s for this
        // whole 50-line run against 24dc895), so this timing assertion is a
        // weak guard on this platform; the bounds below (entry count, entry
        // length) hold regardless of platform and are the non-vacuous part
        // of this test here.
        expect(elapsedMs).toBeLessThan(10_000);

        const record = await latestCheckResult(runDir);
        expect(record!.data.failedTests.length).toBeGreaterThan(0);
        expect(record!.data.failedTests.length).toBeLessThanOrEqual(50);
        for (const entry of record!.data.failedTests) {
          expect(entry.length).toBeLessThanOrEqual(300);
        }
      },
    );
  });

  // RP-290 — a Windows runner prints a backslash-separated identity (the
  // literal-prefix strip above leaves the SEPARATORS untouched, only the
  // matched prefix is removed), and `test\e2e\uninstall.test.ts > s > t`
  // recorded verbatim is not the same identity as the forward-slash form
  // every other platform records — a fresh diagnostician correlating this
  // against the source tree, or against a duplicate failure reported from a
  // different OS, would see two different strings for one test. Both cases
  // below can be built and asserted on any platform (the runner's OWN output
  // is fully hand-crafted, never the real OS path separator), which is what
  // makes this reproducible off Windows too: a cwd-prefix immediately
  // followed by backslash-separated segments, and a cwd-prefix followed by a
  // forward slash and THEN backslash-separated segments (the shape a runner
  // that joins its own root with `/` but reports sub-paths with `\` would
  // produce).
  describe('a backslash-separated identity under cwd is normalized to forward slashes', () => {
    it('converts `<cwd>\\test\\e2e\\...` (backslash immediately after the stripped prefix) to forward slashes', async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          ...runnerCommand(runnerPath, {
            lines: [` FAIL  ${cwd}\\test\\e2e\\uninstall.test.ts > s > t`],
            exitCode: 1,
          }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const record = await latestCheckResult(runDir);
      expect(record!.data.failedTests).toContain('test/e2e/uninstall.test.ts > s > t');
    });

    it('converts `<cwd>/test\\e2e\\...` (a forward slash then backslash-separated segments) to forward slashes', async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          ...runnerCommand(runnerPath, {
            lines: [` FAIL  ${cwd}/test\\e2e\\uninstall.test.ts > s > t`],
            exitCode: 1,
          }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );
      const record = await latestCheckResult(runDir);
      expect(record!.data.failedTests).toContain('test/e2e/uninstall.test.ts > s > t');
    });
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
    const captureTmpDir = await trackedMkdtemp(path.join(tmpdir(), 'check-run-capture-'));
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
    const captureTmpDir = await trackedMkdtemp(path.join(tmpdir(), 'check-run-capture-'));
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

// --- Windows .cmd shims: a `%*`-forwarding shim, for the two suites below --
//
// A single fixture shape backs both suites: `fwd.cmd` (a `.cmd` shim that
// forwards its own argv verbatim, via `%*`, to a Node script) plus `argv.js`
// (a Node script that writes `JSON.stringify(process.argv.slice(2))` to a
// FIXED path baked into its own source at fixture-creation time — never
// passed as one of the forwarded arguments, since the whole point of `%*` is
// that check-run's own argument is the only thing that reaches it). Building
// this once here, rather than duplicating fake.cmd's shape, is what lets the
// refusal suite below assert "argv.js never ran" simply by asserting the
// marker its OWN `marker.cmd` writes never appears, with nothing about the
// fixture itself in question.

/** A `.cmd` shim that forwards every argument it receives, verbatim, to `argvJsPath` via `%*`. */
const fwdCmdSource = (argvJsPath: string): string =>
  `@echo off\r\n"${process.execPath}" "${argvJsPath}" %*\r\n`;

/** Writes its own forwarded argv to `argvJsonPath` (baked in, never one of the forwarded args) and exits 3. */
const argvJsSource = (argvJsonPath: string): string => `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvJsonPath)}, JSON.stringify(process.argv.slice(2)));
process.exit(3);
`;

/** A `.cmd` that writes `pwned.txt` next to itself — the tell that an injected argument ran as a second command. */
const MARKER_CMD_SOURCE = '@echo off\r\necho pwned> "%~dp0pwned.txt"\r\n';

// vitest 5's `it.each` never passes a `TestContext` to the row callback
// (measured against this suite's own vitest — array-of-arrays and
// array-of-scalars rows alike leave the trailing param `undefined`), so the
// `ctx.skip(reason)` shape `skipUnless` needs is unavailable inside `.each`.
// Each case below is therefore its own named `it(...)`, matching the shape
// `skipUnless` is used in everywhere else in this file, rather than a
// parametrised table.

/** Runs one "refuses this argument" case; shared by every case in the describe block below. */
const expectCmdRefusal = async (
  ctx: Parameters<typeof skipUnless>[0],
  weirdArgFor: (marker: string) => string,
): Promise<void> => {
  skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

  const cwd = await freshCwd();
  const runDir = await freshRunDir();
  const argvJsonPath = path.join(cwd, 'argv.json');
  const argvJsPath = await writeFixture(cwd, 'argv.js', argvJsSource(argvJsonPath));
  const fwdPath = await writeFixture(cwd, 'fwd.cmd', fwdCmdSource(argvJsPath));
  const markerPath = await writeFixture(cwd, 'marker.cmd', MARKER_CMD_SOURCE);
  const pwnedPath = path.join(cwd, 'pwned.txt');
  const weirdArg = weirdArgFor(markerPath);

  const result = await runCheckRun(['--name', 'cmdshim-refuse', '--', fwdPath, weirdArg], {
    cwd,
    env: hermeticEnv({ RIG_RUN_DIR: runDir }),
  });

  expect(result.code, result.out).not.toBe(0);

  let pwnedExists = true;
  try {
    await readFile(pwnedPath);
  } catch {
    pwnedExists = false;
  }
  expect(pwnedExists, 'marker.cmd ran — the injected argument was not refused').toBe(false);

  let argvJsonExists = true;
  try {
    await readFile(argvJsonPath);
  } catch {
    argvJsonExists = false;
  }
  expect(
    argvJsonExists,
    'argv.js ran — check-run spawned cmd.exe instead of refusing the argument first',
  ).toBe(false);

  const cmdLines = result.stderr.split('\n').filter((line) => /cmd\.exe/i.test(line));
  expect(cmdLines, result.out).toHaveLength(1);

  const record = await latestCheckResult(runDir);
  expect(record, 'no check-result event was recorded').toBeDefined();
  expect(record!.data.outcome).toBe('spawn-error');
  expect(record!.data.failedTests).toEqual([]);
  expect(record!.data).not.toHaveProperty('tail');
};

describe('a cmd.exe-routed argument containing a double quote, CR or LF is refused before spawning (RP-290 round 2)', () => {
  // RP-290 review round 2 — round 1's `escapeCmdArgument` single-pass
  // caret-escape handles ordinary shell metacharacters, but an EMBEDDED
  // double quote (or a raw CR/LF, which cmd.exe treats as a command
  // separator no quoting survives) is exactly the shape a cmd.exe command
  // line cannot be made unconditionally safe against by escaping alone. The
  // design decision this suite pins: check-run refuses such an argument
  // BEFORE ever spawning cmd.exe, rather than trusting the escape to hold —
  // exits non-zero, prints exactly one stderr line naming cmd.exe, and
  // journals outcome 'spawn-error' (never 'fail') with no `tail`, the same
  // "nothing ran" shape the missing-command spawn-error case already uses.
  it('refuses `x"&<marker.cmd>` without ever running marker.cmd', async (ctx) => {
    await expectCmdRefusal(ctx, (marker) => `x"&${marker}`);
  });

  it('refuses `a"|<marker.cmd>` without ever running marker.cmd', async (ctx) => {
    await expectCmdRefusal(ctx, (marker) => `a"|${marker}`);
  });

  it('refuses `x"&<marker.cmd>&"y` without ever running marker.cmd', async (ctx) => {
    await expectCmdRefusal(ctx, (marker) => `x"&${marker}&"y`);
  });
});

/** Runs one "arrives literally" case; shared by every case in the describe block below. */
const expectLiteralPassthrough = async (
  ctx: Parameters<typeof skipUnless>[0],
  arg: string,
): Promise<void> => {
  skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

  const cwd = await freshCwd();
  const runDir = await freshRunDir();
  const argvJsonPath = path.join(cwd, 'argv.json');
  const argvJsPath = await writeFixture(cwd, 'argv.js', argvJsSource(argvJsonPath));
  const fwdPath = await writeFixture(cwd, 'fwd.cmd', fwdCmdSource(argvJsPath));

  const result = await runCheckRun(['--name', 'cmdshim-literal', '--', fwdPath, arg], {
    cwd,
    env: hermeticEnv({ RIG_RUN_DIR: runDir }),
  });

  expect(result.code, result.out).toBe(3);
  const argvJson = JSON.parse(await readFile(argvJsonPath, 'utf8')) as string[];
  expect(argvJson).toEqual([arg]);
};

describe('a cmd.exe-routed argument with no quote/CR/LF still arrives literally through the %* shim', () => {
  // The refusal above must not become a blanket refusal of every cmd.exe
  // metacharacter — ordinary shell-metacharacter-shaped arguments (the ones
  // round 1's escaping already targets) still have to reach the child
  // UNCHANGED, including an argument that is the empty string.
  it('passes `a b&c` through unchanged, and the exit code still passes through', async (ctx) => {
    await expectLiteralPassthrough(ctx, 'a b&c');
  });

  it('passes `%PATH%` through unchanged, and the exit code still passes through', async (ctx) => {
    await expectLiteralPassthrough(ctx, '%PATH%');
  });

  it('passes `!PATH!` through unchanged, and the exit code still passes through', async (ctx) => {
    await expectLiteralPassthrough(ctx, '!PATH!');
  });

  it('passes `^caret` through unchanged, and the exit code still passes through', async (ctx) => {
    await expectLiteralPassthrough(ctx, '^caret');
  });

  it('passes a trailing backslash through unchanged, and the exit code still passes through', async (ctx) => {
    await expectLiteralPassthrough(ctx, 'trail\\');
  });

  it('passes the empty string through unchanged, and the exit code still passes through', async (ctx) => {
    await expectLiteralPassthrough(ctx, '');
  });
});

// --- Windows .cmd shims: the batch file's own resolved PATH has a space -----
//
// code-reviewer, reproduced on win32 (RP-290) — `escapeCmdArgument` wraps the
// batch file's own PATH in quotes and then CARET-ESCAPES those quotes
// (`^"…^"`) rather than leaving them as real cmd.exe quote delimiters. A
// caret-escaped quote does not suppress cmd.exe's own whitespace
// word-splitting, so a resolved `.cmd`/`.bat` PATH containing a SPACE (e.g.
// `C:\Program Files\nodejs\npm.cmd`) is split into two command-line tokens at
// that space, and cmd.exe reports the first fragment "is not recognized as an
// internal or external command" — the checked command never runs, and the run
// is journalled `outcome: 'fail'` regardless. This is a defect distinct from
// the metacharacter escaping above: a bare space is not one of
// `CMD_META_CHARS`, so no amount of caret-escaping that set touches it. Two
// cases exercise the same defect through the two ways `resolveBatchFile`
// arrives at a spaced path: `command[0]` supplied already-absolute, and
// `command[0]` supplied bare and resolved through a PATH entry that itself
// contains a space.

describe('a cmd.exe-routed batch file whose own resolved PATH contains a space', () => {
  /**
   * Writes its own forwarded argv to `argvJsonPath` and exits 0 — unlike
   * `argvJsSource` above (which exits 3, the marker for "the wrapped program
   * ran"), a CLEAN exit is needed here so the journalled `outcome` is
   * `'pass'`: the assertion this pair of tests makes is that the run reaches
   * the wrapped program at all, and `'pass'` is the only outcome that cannot
   * also be produced by cmd.exe's own "not recognized" failure.
   */
  const argvJsExitZeroSource = (argvJsonPath: string): string => `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvJsonPath)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;

  const SPACE_ARGS = ['a b&c', '%PATH%'];

  it('runs the shim by its ABSOLUTE path when that path contains a space', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

    const parentDir = await freshCwd();
    const spacedDir = path.join(parentDir, 'check run space');
    await mkdir(spacedDir, { recursive: true });
    const runDir = await freshRunDir();
    const argvJsonPath = path.join(spacedDir, 'argv.json');
    const argvJsPath = await writeFixture(spacedDir, 'argv.js', argvJsExitZeroSource(argvJsonPath));
    const fwdPath = await writeFixture(spacedDir, 'fwd.cmd', fwdCmdSource(argvJsPath));

    const result = await runCheckRun(
      ['--name', 'cmdshim-space-abs', '--', fwdPath, ...SPACE_ARGS],
      { cwd: parentDir, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );

    expect(result.code, result.out).toBe(0);
    const argvJson = JSON.parse(await readFile(argvJsonPath, 'utf8')) as string[];
    expect(argvJson).toEqual(SPACE_ARGS);

    const record = await latestCheckResult(runDir);
    expect(record!.data.outcome).toBe('pass');
  });

  it('runs the shim by its BARE NAME, resolved through a PATH entry that contains a space', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

    const parentDir = await freshCwd();
    const spacedDir = path.join(parentDir, 'check run space');
    await mkdir(spacedDir, { recursive: true });
    const runDir = await freshRunDir();
    const argvJsonPath = path.join(spacedDir, 'argv.json');
    const argvJsPath = await writeFixture(spacedDir, 'argv.js', argvJsExitZeroSource(argvJsonPath));
    await writeFixture(spacedDir, 'fwd.cmd', fwdCmdSource(argvJsPath));

    const env = hermeticEnv({ RIG_RUN_DIR: runDir });
    const existingPath = env.PATH ?? env.Path ?? env.path ?? '';
    delete env.PATH;
    delete env.Path;
    delete env.path;
    env.PATH = `${spacedDir}${path.delimiter}${existingPath}`;

    const result = await runCheckRun(
      ['--name', 'cmdshim-space-bare', '--', 'fwd.cmd', ...SPACE_ARGS],
      { cwd: parentDir, env },
    );

    expect(result.code, result.out).toBe(0);
    const argvJson = JSON.parse(await readFile(argvJsonPath, 'utf8')) as string[];
    expect(argvJson).toEqual(SPACE_ARGS);

    const record = await latestCheckResult(runDir);
    expect(record!.data.outcome).toBe('pass');
  });
});

// --- Windows .cmd shims: a cmd token separator inside the batch path itself -
//
// RP-290 (security-scanner, win32, 11bcbbe) — on the cmd.exe route the BATCH
// FILE PATH TOKEN itself (not one of the checked command's own ARGUMENTS,
// which the suites above already cover) is split by cmd.exe at `,` `;` `=`
// and Unicode whitespace (e.g. U+00A0) exactly as ordinary
// argument-separating whitespace. A directory name containing one of these
// characters resolves to a truncated first token that a planted sibling
// `tools.cmd` can satisfy instead of the file actually named — and the run
// is journalled `pass` even though the named file never ran. Demonstrated:
// an absolute `<dir>\tools,v2\lint.cmd` ran a planted `<dir>\tools.cmd`, and
// a relative `echo;x\lint.cmd` ran cmd's own builtin echo.

/** Writes `marker.cmd`-shaped output ("target") to a FIXED, baked-in absolute path and exits 0. */
const LINT_CMD_SOURCE = (markerPath: string): string =>
  `@echo off\r\necho target> "${markerPath}"\r\nexit /b 0\r\n`;

/** The planted sibling `tools.cmd` a cmd.exe token split could run instead of the named file. */
const DECOY_CMD_SOURCE = (markerPath: string): string =>
  `@echo off\r\necho decoy> "${markerPath}"\r\nexit /b 0\r\n`;

// The fourth separator category is Unicode whitespace, not the ordinary
// ASCII space (0x20) — an ASCII space is already caret-escaped by
// `CMD_PATH_META_CHARS` (`escapeCmdBatchPath`'s own comment, "a cmd.exe-routed
// batch file whose own resolved PATH contains a space"), so a directory name
// built from a plain space does not reproduce this defect: verified directly
// against 11bcbbe (`tools v2` absolute: target ran, decoy did not, outcome
// 'pass' — already correct). U+00A0 (NO-BREAK SPACE) is not in that
// character class and reproduces the same decoy-execution defect the comma/
// semicolon/equals cases do — verified the same way (`tools<U+00A0>v2`
// absolute: the decoy ran, journalled 'pass').
const NBSP_DIR_NAME = `tools${String.fromCodePoint(0xa0)}v2`;

/**
 * Runs one "only the named lint.cmd ran" case for `dirName`, invoking it
 * either by its ABSOLUTE path or by a RELATIVE path with `cwd` set to the
 * shared parent — the two ways `resolveBatchFile`/the cmd.exe command line
 * arrives at the same directory token.
 */
const expectOnlyTargetRuns = async (
  ctx: Parameters<typeof skipUnless>[0],
  dirName: string,
  invoke: 'absolute' | 'relative',
): Promise<void> => {
  skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

  const tmp = await freshCwd();
  const runDir = await freshRunDir();
  const targetDir = path.join(tmp, dirName);
  await mkdir(targetDir, { recursive: true });
  const targetRanPath = path.join(tmp, 'target-ran');
  const decoyRanPath = path.join(tmp, 'decoy-ran');
  await writeFixture(targetDir, 'lint.cmd', LINT_CMD_SOURCE(targetRanPath));
  await writeFixture(tmp, 'tools.cmd', DECOY_CMD_SOURCE(decoyRanPath));

  const lintPath =
    invoke === 'absolute' ? path.join(targetDir, 'lint.cmd') : path.join(dirName, 'lint.cmd');

  const result = await runCheckRun(['--name', 'lint-token-sep', '--', lintPath], {
    cwd: tmp,
    env: hermeticEnv({ RIG_RUN_DIR: runDir }),
  });

  let targetRan = true;
  try {
    await readFile(targetRanPath);
  } catch {
    targetRan = false;
  }
  expect(targetRan, 'lint.cmd never ran — the named file was not the one invoked').toBe(true);

  let decoyRan = true;
  try {
    await readFile(decoyRanPath);
  } catch {
    decoyRan = false;
  }
  expect(
    decoyRan,
    'the decoy tools.cmd ran instead of the named lint.cmd — the path token was split at a separator',
  ).toBe(false);

  expect(result.code, result.out).toBe(0);

  const record = await latestCheckResult(runDir);
  expect(record!.data.outcome).toBe('pass');
};

describe('a cmd.exe-routed batch path containing a cmd token separator runs only the named file', () => {
  it('runs only lint.cmd, not decoy tools.cmd, by its ABSOLUTE path under "tools,v2"', async (ctx) => {
    await expectOnlyTargetRuns(ctx, 'tools,v2', 'absolute');
  });

  it('runs only lint.cmd, not decoy tools.cmd, by its RELATIVE path under "tools,v2"', async (ctx) => {
    await expectOnlyTargetRuns(ctx, 'tools,v2', 'relative');
  });

  it('runs only lint.cmd, not decoy tools.cmd, by its ABSOLUTE path under "tools;v2"', async (ctx) => {
    await expectOnlyTargetRuns(ctx, 'tools;v2', 'absolute');
  });

  it('runs only lint.cmd, not decoy tools.cmd, by its RELATIVE path under "tools;v2"', async (ctx) => {
    await expectOnlyTargetRuns(ctx, 'tools;v2', 'relative');
  });

  it('runs only lint.cmd, not decoy tools.cmd, by its ABSOLUTE path under "tools=v2"', async (ctx) => {
    await expectOnlyTargetRuns(ctx, 'tools=v2', 'absolute');
  });

  it('runs only lint.cmd, not decoy tools.cmd, by its RELATIVE path under "tools=v2"', async (ctx) => {
    await expectOnlyTargetRuns(ctx, 'tools=v2', 'relative');
  });

  it('runs only lint.cmd, not decoy tools.cmd, by its ABSOLUTE path under a U+00A0 (NBSP) separator', async (ctx) => {
    await expectOnlyTargetRuns(ctx, NBSP_DIR_NAME, 'absolute');
  });

  it('runs only lint.cmd, not decoy tools.cmd, by its RELATIVE path under a U+00A0 (NBSP) separator', async (ctx) => {
    await expectOnlyTargetRuns(ctx, NBSP_DIR_NAME, 'relative');
  });
});

// --- Windows .cmd shims: an allowlist-refused character in the batch path ---
//
// security-scanner, reproduced on win32 at 585465a (RP-290) — U+180E
// (MONGOLIAN VOWEL SEPARATOR) is a cmd.exe/`iswspace` token separator but is
// NOT matched by JS `\s` (it lost its Unicode whitespace property in Unicode
// 6.3, and the credential/path scanning in this codebase is JS-regex-based),
// so a batch path under `tools<U+180E>v2` split at that character exactly the
// way the comma/semicolon/equals/NBSP cases above already do, and the planted
// sibling `tools.cmd` ran in its place while the run was still journalled
// `pass`. Chasing this one character with another entry in a deny-list is the
// same defect shape as every case above it, so the fix moves to an ALLOWLIST
// on the cmd.exe batch-path route instead: every character of the resolved
// path must be printable ASCII, a Unicode letter/mark/number (`\p{L}\p{M}\p{N}`),
// JS `\s`, or U+0085 (NEL) — anything else is refused BEFORE check-run ever
// spawns cmd.exe, with outcome `spawn-error` (never `pass` or `fail`), no
// `tail`, and neither the named file nor any decoy sibling ever runs. U+200B
// (ZERO WIDTH SPACE, also Cf and also outside JS `\s`) is included below
// specifically because it is not the character the defect was demonstrated
// with — an allowlist refuses it on the same general ground, where a patch
// aimed only at U+180E would not.
//
// Special characters are built with `String.fromCodePoint` in the test source
// itself (never as a literal invisible character), matching this file's own
// `NBSP_DIR_NAME` convention just above and avoiding an eslint
// `no-irregular-whitespace` violation.

const U180E_DIR_NAME = `tools${String.fromCodePoint(0x180e)}v2`;
const U200B_DIR_NAME = `tools${String.fromCodePoint(0x200b)}v2`;

/**
 * Runs one "refused before spawning" case for `dirName` on the cmd.exe
 * batch-path route: builds the same target/decoy fixture pair
 * `expectOnlyTargetRuns` uses, but asserts the ALLOWLIST refusal shape
 * instead — neither the named `lint.cmd` NOR the decoy `tools.cmd` ever
 * runs, check-run exits non-zero, prints exactly one stderr line naming
 * cmd.exe, and the run is journalled `spawn-error` (never `pass` or `fail`)
 * with no `tail` — the same "nothing ran" shape the missing-command and
 * cmd-argument-refusal spawn-error cases already use.
 */
const expectBatchPathRefused = async (
  ctx: Parameters<typeof skipUnless>[0],
  dirName: string,
  invoke: 'absolute' | 'relative',
): Promise<void> => {
  skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

  const tmp = await freshCwd();
  const runDir = await freshRunDir();
  const targetDir = path.join(tmp, dirName);
  await mkdir(targetDir, { recursive: true });
  const targetRanPath = path.join(tmp, 'target-ran');
  const decoyRanPath = path.join(tmp, 'decoy-ran');
  await writeFixture(targetDir, 'lint.cmd', LINT_CMD_SOURCE(targetRanPath));
  await writeFixture(tmp, 'tools.cmd', DECOY_CMD_SOURCE(decoyRanPath));

  const lintPath =
    invoke === 'absolute' ? path.join(targetDir, 'lint.cmd') : path.join(dirName, 'lint.cmd');

  const result = await runCheckRun(['--name', 'lint-path-refuse', '--', lintPath], {
    cwd: tmp,
    env: hermeticEnv({ RIG_RUN_DIR: runDir }),
  });

  expect(result.code, result.out).not.toBe(0);

  let targetRan = true;
  try {
    await readFile(targetRanPath);
  } catch {
    targetRan = false;
  }
  expect(targetRan, 'lint.cmd ran — the unsafe path was not refused before spawning').toBe(false);

  let decoyRan = true;
  try {
    await readFile(decoyRanPath);
  } catch {
    decoyRan = false;
  }
  expect(
    decoyRan,
    'the decoy tools.cmd ran — the unsafe path was not refused before spawning',
  ).toBe(false);

  const cmdLines = result.stderr.split('\n').filter((line) => /cmd\.exe/i.test(line));
  expect(cmdLines, result.out).toHaveLength(1);

  const record = await latestCheckResult(runDir);
  expect(record, 'no check-result event was recorded').toBeDefined();
  expect(record!.data.outcome).toBe('spawn-error');
  expect(record!.data.failedTests).toEqual([]);
  expect(record!.data).not.toHaveProperty('tail');
};

describe('a cmd.exe-routed batch path containing a character outside the allowlist is refused before spawning', () => {
  it('refuses the ABSOLUTE path under a U+180E (MONGOLIAN VOWEL SEPARATOR) character, without running lint.cmd or the decoy', async (ctx) => {
    await expectBatchPathRefused(ctx, U180E_DIR_NAME, 'absolute');
  });

  it('refuses the RELATIVE path under a U+180E (MONGOLIAN VOWEL SEPARATOR) character, without running lint.cmd or the decoy', async (ctx) => {
    await expectBatchPathRefused(ctx, U180E_DIR_NAME, 'relative');
  });

  it('refuses the ABSOLUTE path under a U+200B (ZERO WIDTH SPACE) character, without running lint.cmd or the decoy', async (ctx) => {
    await expectBatchPathRefused(ctx, U200B_DIR_NAME, 'absolute');
  });
});

describe('a cmd.exe-routed batch path containing ordinary non-English letters is not refused by the allowlist', () => {
  // The allowlist above must not become a blanket refusal of every non-ASCII
  // character — an accented Latin letter and Cyrillic letters are `\p{L}`
  // and must still reach the named file, exactly as the plain-ASCII cases in
  // "a cmd.exe-routed batch path containing a cmd token separator" do.
  it('runs only lint.cmd, not decoy tools.cmd, by its ABSOLUTE path under "tëst-дир"', async (ctx) => {
    await expectOnlyTargetRuns(ctx, 'tëst-дир', 'absolute');
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

// --- a PEM header sitting at the very end of an over-length line ------------
//
// RP-290 review round 2 — the PEM state machine reads the ALREADY-PROCESSED
// line: `LINE_MAX_BYTES` (64 KiB) truncates a still-pending line to
// `[redacted: line over 65536 bytes]` BEFORE the PEM header check ever runs
// over it, ahead of and independent from the PEM/credential logic per the
// module header's "Bounds". A header sitting at the very END of a line that
// was already over that cap therefore never gets seen — `inPemBlock` never
// arms — and the body/END lines that follow go through completely
// unprotected. Built INSIDE the child (never passed through argv) for the
// same reason `LONG_LINE_RUNNER_SOURCE` is — see that fixture's own comment.

/** One line of `prefixBytes` 'x' immediately followed by `header` (no newline between them), then each of `afterLines` as its own line. */
const PEM_AT_LINE_END_RUNNER_SOURCE = `
const config = JSON.parse(process.argv[2] ?? '{}');
const prefixBytes = Number(config.prefixBytes ?? 0);
process.stdout.write('x'.repeat(prefixBytes) + config.header + '\\n');
for (const line of config.afterLines ?? []) {
  process.stdout.write(\`\${line}\\n\`);
}
process.exit(Number(config.exitCode ?? 0));
`;

describe('a PEM header sitting at the very end of a line already over the 64 KiB line cap', () => {
  const BODY_LINES = [
    'MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAuABCDEFGHIJKLMN',
    'OPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN',
  ];
  const END_LINE = '-----END RSA PRIVATE KEY-----';

  it(
    'still redacts the body and END line that follow it, while a line after END survives',
    { timeout: 20_000 },
    async () => {
      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const runnerPath = await writeFixture(
        cwd,
        'pem-at-line-end-runner.mjs',
        PEM_AT_LINE_END_RUNNER_SOURCE,
      );

      await runCheckRun(
        [
          '--name',
          'unit',
          '--',
          process.execPath,
          runnerPath,
          JSON.stringify({
            prefixBytes: 70 * 1024,
            header: pemHeader(),
            afterLines: [...BODY_LINES, END_LINE, 'after-ok'],
            exitCode: 1,
          }),
        ],
        { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
      );

      const record = await latestCheckResult(runDir);
      const logContent = await readFile(path.join(runDir, record!.data.log), 'utf8');
      const tail = record!.data.tail ?? '';

      for (const bodyLine of BODY_LINES) {
        expect(logContent, 'key body leaked into the log').not.toContain(bodyLine);
        expect(tail, 'key body leaked into the tail').not.toContain(bodyLine);
      }
      expect(logContent, 'END line leaked into the log').not.toContain(END_LINE);
      expect(tail, 'END line leaked into the tail').not.toContain(END_LINE);

      expect(logContent, 'text after END did not survive in the log').toContain('after-ok');
      expect(tail, 'text after END did not survive in the tail').toContain('after-ok');
    },
  );
});

// --- a PEM block whose BEGIN and END sit on the SAME line --------------------
//
// RP-290 review round 2 — the per-line state machine only checks for the END
// marker INSIDE the `if (inPemBlock)` branch; a line whose BEGIN and END both
// match arrives with `inPemBlock` still false, so it takes the `else if
// (PRIVATE_KEY_HEADER_PATTERN...)` branch instead, which arms `inPemBlock`
// but never checks for END on that same line. The block never closes —
// every line from here to the end of the stream, including the failing
// test's own identity line, is swallowed as "still inside the key".

describe('a PEM block whose BEGIN and END markers sit on the SAME line', () => {
  it('redacts the one-line key, and does not swallow the FAIL identity on the line that follows it', async () => {
    const cwd = await freshCwd();
    const runDir = await freshRunDir();
    const runnerPath = await writeFixture(cwd, 'runner.mjs', RUNNER_SOURCE);
    const oneLineKey = JSON.stringify(`${pemHeader()}\nAAAA\n-----END RSA PRIVATE KEY-----`);

    await runCheckRun(
      [
        '--name',
        'unit',
        '--',
        ...runnerCommand(runnerPath, {
          lines: [oneLineKey, ' FAIL  test/z.test.ts > s > t'],
          exitCode: 1,
        }),
      ],
      { cwd, env: hermeticEnv({ RIG_RUN_DIR: runDir }) },
    );

    const record = await latestCheckResult(runDir);
    const logContent = await readFile(path.join(runDir, record!.data.log), 'utf8');

    expect(logContent, 'the one-line key leaked into the log').not.toContain(oneLineKey);
    expect(
      record!.data.failedTests,
      'the FAIL identity on the line after the one-line key was swallowed',
    ).toContain('test/z.test.ts > s > t');
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

// --- an interrupt sent to check-run itself, not its process group ----------
//
// RP-290 review round 2 — check-run installs no `SIGINT` handler today, so
// Node's own default action applies: the process is torn down immediately by
// the kernel, the `finally` block that removes the capture temp files never
// runs, and — because the checked command is spawned `detached: true` (its
// OWN process group, exactly so a `--timeout` kill can target the whole tree
// without also targeting check-run's own callers) — a SIGINT sent to check-run
// alone never reaches that child at all. An operator hitting Ctrl-C on a
// required check would leave the check still running to completion in the
// background and a temp file behind. Fixed shape: check-run installs its own
// `SIGINT` handler, kills the checked command's whole tree the same way
// `--timeout` already does, cleans up its capture files, and exits — well
// under the ~6s the fixture below would otherwise still be running for.

/**
 * Writes its own pid to `pidFile` immediately (the poll below needs it before
 * the interrupt is even sent), then after ~6s writes `markerFile` and exits
 * cleanly — the fixture never reaches that write if it is killed first.
 */
const SIGINT_FIXTURE_SOURCE = `
import { writeFileSync } from 'node:fs';
const pidFile = process.argv[2];
const markerFile = process.argv[3];
writeFileSync(pidFile, String(process.pid));
setTimeout(() => {
  writeFileSync(markerFile, 'done');
  process.exit(0);
}, 6000);
`;

describe('an interrupt (SIGINT) delivered to check-run itself, not its process group', () => {
  it(
    'kills the checked command and removes its own capture files, rather than dying immediately and leaking both',
    { timeout: 20_000 },
    async (ctx) => {
      skipUnless(ctx, onlyOnPosix().ok, onlyOnPosix().reason);

      const cwd = await freshCwd();
      const runDir = await freshRunDir();
      const captureTmpDir = await trackedMkdtemp(path.join(tmpdir(), 'check-run-capture-'));
      const fixturePath = await writeFixture(cwd, 'sigint-fixture.mjs', SIGINT_FIXTURE_SOURCE);
      const pidFile = path.join(cwd, 'checked-command.pid');
      const markerFile = path.join(cwd, 'marker.txt');

      const spawnStart = Date.now();
      const checkRunProcess = spawn(
        process.execPath,
        [CHECK_RUN, '--name', 'unit', '--', process.execPath, fixturePath, pidFile, markerFile],
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

      // The checked command writes its own pid almost immediately; poll
      // briefly rather than assuming it has already landed on disk.
      let pidText = '';
      for (let i = 0; i < 30 && pidText === ''; i += 1) {
        try {
          pidText = (await readFile(pidFile, 'utf8')).trim();
        } catch {
          // not written yet
        }
        if (pidText === '') await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pidText, 'the checked command never wrote its pid file').not.toBe('');
      const checkedCommandPid = Number(pidText);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      // check-run's OWN pid, never the negative/group form — the whole point
      // is that check-run itself must propagate the kill to its child's tree,
      // because the child sits in a DIFFERENT process group and a SIGINT
      // aimed only at check-run would never reach it on its own.
      process.kill(checkRunProcess.pid!, 'SIGINT');

      const killedAt = Date.now();
      await new Promise<void>((resolve) => checkRunProcess.on('close', () => resolve()));
      const exitElapsedMs = Date.now() - killedAt;
      expect(exitElapsedMs, 'check-run did not exit within ~3s of being interrupted').toBeLessThan(
        3000,
      );

      // Wait out the fixture's own ~6s delay (measuring from the ORIGINAL
      // spawn, not from the interrupt) before checking the marker never
      // appeared — a marker written after check-run already exited would
      // prove the checked command kept running unattended.
      const remainingMs = 7000 - (Date.now() - spawnStart);
      if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));

      let markerWritten = true;
      try {
        await readFile(markerFile, 'utf8');
      } catch {
        markerWritten = false;
      }
      expect(
        markerWritten,
        'the checked command finished and wrote its marker — it kept running after the interrupt',
      ).toBe(false);

      const isAlive = (): boolean => {
        try {
          process.kill(checkedCommandPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(isAlive(), `checked command pid ${checkedCommandPid} is still alive`).toBe(false);

      const leftover = (await readdir(captureTmpDir)).filter((name) =>
        name.startsWith('check-run-'),
      );
      expect(leftover, leftover.join(', ')).toEqual([]);
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
