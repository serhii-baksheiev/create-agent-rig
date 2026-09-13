import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// This file matches the benchmark project's file glob (vitest.config.ts) even
// though each case is a short, bounded real-process test — it is verified
// with `--project benchmark`, never `--project template`.
const TEST_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const preloadHref = pathToFileURL(
  path.join(repoRoot, 'scripts', 'policy-benchmark-exit-trace.mjs'),
).href;

const runTraced = async (
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', preloadHref, scriptPath],
      { env, timeout: 10_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number | null; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
};

const readTraceLines = async (traceFile: string): Promise<string[]> =>
  existsSync(traceFile)
    ? (await readFile(traceFile, 'utf8')).split('\n').filter((line) => line.length > 0)
    : [];

const trailingMs = (line: string): number => Number(line.match(/(\d+)$/)?.[1]);

describe('policy benchmark exit trace preload', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-exit-trace-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it(
    "records preload, stderr-write, exit-event and reallyExit marks in order for a process.exit(2) path, without changing the process's exit code or stderr",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const script = path.join(root, 'refuse.mjs');
      await writeFile(script, "process.stderr.write('refused\\n');\nprocess.exit(2);\n");
      const traceFile = path.join(root, 'trace.log');

      const result = await runTraced(script, {
        ...process.env,
        POLICY_BENCHMARK_EXIT_TRACE: traceFile,
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toBe('refused\n');
      const lines = await readTraceLines(traceFile);
      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatch(/^preload \d+$/);
      expect(lines[1]).toMatch(/^stderr-write \d+$/);
      expect(lines[2]).toMatch(/^exit-event 2 \d+$/);
      expect(lines[3]).toMatch(/^reallyExit 2 handles=\d+ \d+$/);
      const ms = lines.map(trailingMs);
      expect(ms.every((value) => Number.isInteger(value))).toBe(true);
      for (let index = 1; index < ms.length; index += 1) {
        const previous = ms[index - 1] ?? 0;
        const current = ms[index] ?? 0;
        expect(current).toBeGreaterThanOrEqual(previous);
      }
    },
  );

  it(
    'records preload, stdout-write and exit-event marks — and no reallyExit mark — for a process that exits naturally',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const script = path.join(root, 'natural.mjs');
      await writeFile(script, "process.stdout.write('ok\\n');\n");
      const traceFile = path.join(root, 'trace.log');

      const result = await runTraced(script, {
        ...process.env,
        POLICY_BENCHMARK_EXIT_TRACE: traceFile,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('ok\n');
      const lines = await readTraceLines(traceFile);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^preload \d+$/);
      expect(lines[1]).toMatch(/^stdout-write \d+$/);
      expect(lines[2]).toMatch(/^exit-event 0 \d+$/);
      expect(lines.some((line) => line.startsWith('reallyExit'))).toBe(false);
    },
  );

  it(
    'writes no trace file when POLICY_BENCHMARK_EXIT_TRACE is absent from the environment',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const script = path.join(root, 'silent.mjs');
      await writeFile(script, "process.stdout.write('ok\\n');\n");
      const traceFile = path.join(root, 'trace.log');
      const envWithoutFlag = { ...process.env };
      delete envWithoutFlag.POLICY_BENCHMARK_EXIT_TRACE;

      const result = await runTraced(script, envWithoutFlag);

      expect(result.code).toBe(0);
      expect(existsSync(traceFile)).toBe(false);
    },
  );

  it(
    'writes no trace file when POLICY_BENCHMARK_EXIT_TRACE is an empty string',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const script = path.join(root, 'silent-empty.mjs');
      await writeFile(script, "process.stdout.write('ok\\n');\n");
      const traceFile = path.join(root, 'trace.log');

      const result = await runTraced(script, {
        ...process.env,
        POLICY_BENCHMARK_EXIT_TRACE: '',
      });

      expect(result.code).toBe(0);
      expect(existsSync(traceFile)).toBe(false);
    },
  );

  it(
    'never throws or changes the exit code or stderr when the trace path names an existing directory instead of a file',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const script = path.join(root, 'refuse-dir.mjs');
      await writeFile(script, "process.stderr.write('refused\\n');\nprocess.exit(2);\n");
      const traceDir = path.join(root, 'trace-is-a-directory');
      await mkdir(traceDir, { recursive: true });

      const result = await runTraced(script, {
        ...process.env,
        POLICY_BENCHMARK_EXIT_TRACE: traceDir,
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toBe('refused\n');
    },
  );
});
