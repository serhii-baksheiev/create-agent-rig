import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProviderProcess, type ProviderProcessResult } from '../src/integrations/spawn.js';
import { captureWindowsProcessEvidence } from './helpers/windows-process-evidence.js';
import { onlyOnWindows, skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const WINDOWS_CONSUMER_CHILD_TIMEOUT_MS = process.platform === 'win32' ? 45_000 : 8_000;
const WINDOWS_CONSUMER_CASE_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 15_000;
const DEFAULT_PROBE_DELAY_MS = 8_000;

let repo: string;

async function executableOnPath(name: string): Promise<string> {
  const extensions = ['.exe', '.cmd', '.bat', ''];
  const entries = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter);
  for (const entry of entries) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      try {
        await realpath(candidate);
        return candidate;
      } catch {
        // Continue to the next PATH entry.
      }
    }
  }
  throw new Error(`Could not find ${name} on PATH for the fixture`);
}

function rootQuery(git: string, timeoutMs: number): Promise<ProviderProcessResult> {
  return runProviderProcess({
    executable: git,
    args: ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
    repoDir: repo,
    timeoutMs,
  });
}

function boundedProbeNumber(expression: string): number {
  const compact = expression.replaceAll('_', '').replaceAll(' ', '');
  if (/^[1-9]\d*$/.test(compact)) return Number(compact);
  const product = compact.match(/^([1-9]\d*)\*([1-9]\d*)$/);
  if (!product) throw new Error('default probe bound is not a safe numeric expression');
  return Number(product[1]) * Number(product[2]);
}

async function currentDefaultProbeInputs(): Promise<{
  command: string;
  powershell: string;
  timeoutMs: number;
  maxBuffer: number;
}> {
  const source = await readFile(
    path.resolve(process.cwd(), 'packages/cli/test/helpers/windows-process-evidence.ts'),
    'utf8',
  );
  const start = source.indexOf('function defaultProbe(');
  const end = source.indexOf('\n}\n\n/**', start);
  if (start < 0 || end < 0) throw new Error('could not isolate defaultProbe');
  const body = source.slice(start, end);
  const command = body.match(/const command\s*=\s*\n\s*(['"])(.*)\1;/)?.[2];
  const timeout = body.match(/\btimeout:\s*([^,\r\n]+),/)?.[1];
  const maxBuffer = body.match(/\bmaxBuffer:\s*([^,\r\n]+),/)?.[1];
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!command || !timeout || !maxBuffer || !systemRoot || !path.isAbsolute(systemRoot))
    throw new Error('current defaultProbe inputs are unavailable');
  return {
    command,
    powershell: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    timeoutMs: boundedProbeNumber(timeout),
    maxBuffer: boundedProbeNumber(maxBuffer),
  };
}

type SpawnCall = {
  executable: string;
  args: readonly string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean };
  pid: number | undefined;
  createdAtMs: number;
};

type ExecFileCall = {
  executable: string;
  args: readonly string[];
  options:
    | {
        env?: NodeJS.ProcessEnv;
        windowsHide?: boolean;
        timeout?: number;
        maxBuffer?: number;
      }
    | undefined;
};

async function withObservedProductionSpawn<T>(
  operation: (
    outerSpawn: typeof import('node:child_process').spawn,
    calls: readonly SpawnCall[],
  ) => Promise<T>,
): Promise<{
  result: T;
  calls: SpawnCall[];
}> {
  const childProcess = require('node:child_process') as typeof import('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls: SpawnCall[] = [];
  childProcess.spawn = ((
    executable: string,
    args: readonly string[],
    options: SpawnCall['options'],
  ) => {
    const child = originalSpawn(executable, args, options);
    calls.push({ executable, args, options, pid: child.pid, createdAtMs: Date.now() });
    return child;
  }) as typeof originalSpawn;
  syncBuiltinESMExports();
  try {
    return { result: await operation(childProcess.spawn, calls), calls };
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
}

async function withObservedExecFile<T>(operation: () => Promise<T>): Promise<{
  result: T;
  calls: ExecFileCall[];
}> {
  const childProcess = require('node:child_process') as typeof import('node:child_process');
  const originalExecFile = childProcess.execFile;
  const calls: ExecFileCall[] = [];
  childProcess.execFile = ((...args: Parameters<typeof originalExecFile>) => {
    const [executable, fileArgs, options] = args;
    calls.push({
      executable: String(executable),
      args: Array.isArray(fileArgs) ? [...fileArgs] : [],
      options:
        options && typeof options === 'object' ? (options as ExecFileCall['options']) : undefined,
    });
    return originalExecFile(...args);
  }) as typeof originalExecFile;
  syncBuiltinESMExports();
  try {
    return { result: await operation(), calls };
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
}

async function withMockedWindowsJobBindings<T>(
  operation: (
    spawn: typeof import('node:child_process').spawn,
    spawnCalls: readonly SpawnCall[],
    execFileCalls: readonly ExecFileCall[],
  ) => Promise<T>,
): Promise<T> {
  const childProcess = require('node:child_process') as typeof import('node:child_process');
  const originalSpawn = childProcess.spawn;
  const originalExecFile = childProcess.execFile;
  const spawnCalls: SpawnCall[] = [];
  const execFileCalls: ExecFileCall[] = [];
  childProcess.spawn = ((
    executable: string,
    args: readonly string[],
    options: SpawnCall['options'],
  ) => {
    spawnCalls.push({ executable, args, options, pid: 4_242, createdAtMs: Date.now() });
    return { pid: 4_242 } as ReturnType<typeof originalSpawn>;
  }) as typeof originalSpawn;
  childProcess.execFile = ((...args: Parameters<typeof originalExecFile>) => {
    const [executable, fileArgs, options] = args;
    execFileCalls.push({
      executable: String(executable),
      args: Array.isArray(fileArgs) ? [...fileArgs] : [],
      options:
        options && typeof options === 'object' ? (options as ExecFileCall['options']) : undefined,
    });
    return { kill: () => true } as ReturnType<typeof originalExecFile>;
  }) as typeof originalExecFile;
  syncBuiltinESMExports();
  try {
    return await operation(childProcess.spawn, spawnCalls, execFileCalls);
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
}

async function stopObservedSupervisors(calls: readonly SpawnCall[]): Promise<void> {
  for (const call of calls) {
    if (!call.pid) continue;
    try {
      process.kill(call.pid);
    } catch {
      // The observed supervisor may have exited before test cleanup starts.
    }
  }
  await delay(100);
}

describe('Windows default CIM probe delay', () => {
  it('does not start default CIM before its delay for a mocked completed root query', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    vi.useFakeTimers();
    try {
      const captured = await withMockedWindowsJobBindings(
        async (spawn, spawnCalls, execFileCalls) => {
          let releaseOperation: (() => void) | undefined;
          const payload = Buffer.from(
            JSON.stringify({
              executable: 'C:\\fixture\\git.exe',
              args: ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
            }),
            'utf8',
          ).toString('base64');
          const pending = captureWindowsProcessEvidence(
            () =>
              new Promise<ProviderProcessResult>((resolve) => {
                spawn(
                  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                  ['-NoProfile', '-NonInteractive', '-Command'],
                  {
                    env: { RIG_WINDOWS_JOB_PAYLOAD: payload },
                    shell: false,
                    windowsHide: true,
                  },
                );
                releaseOperation = () =>
                  resolve({ status: 'ok', stdout: '', stderr: '', exitCode: 0 });
              }),
          );

          try {
            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();
            expect(spawnCalls).toHaveLength(1);
            expect(execFileCalls).toEqual([]);
          } finally {
            releaseOperation?.();
          }
          return pending;
        },
      );

      expect(captured).toMatchObject({ result: { status: 'ok' }, evidence: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Windows supervised process evidence', { timeout: 15_000 }, () => {
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'rig-windows-process-evidence-'));
    await exec(await executableOnPath('git'), ['init', '--quiet'], {
      cwd: repo,
      shell: false,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  });

  afterEach(async () => {
    await removeFixture(repo);
  });

  it(
    'leaves a successful non-root provider run silent and unchanged',
    { timeout: WINDOWS_CONSUMER_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const git = await executableOnPath('git');

      const observed = await captureWindowsProcessEvidence(() =>
        runProviderProcess({
          executable: git,
          args: ['--version'],
          repoDir: repo,
          timeoutMs: WINDOWS_CONSUMER_CHILD_TIMEOUT_MS,
        }),
      );

      expect(observed.result).toMatchObject({ status: 'ok', exitCode: 0 });
      expect(observed.evidence).toBeUndefined();
    },
  );

  it(
    'bounds diagnostics while preserving a successful root query',
    { timeout: WINDOWS_CONSUMER_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const git = await executableOnPath('git');
      const expectedRoot = await realpath(repo);

      const startedAtMs = performance.now();
      const observed = await withObservedExecFile(() =>
        captureWindowsProcessEvidence(() => rootQuery(git, WINDOWS_CONSUMER_CHILD_TIMEOUT_MS)),
      );
      const elapsedMs = performance.now() - startedAtMs;

      expect(observed.result.result).toMatchObject({ status: 'ok', stderr: '', exitCode: 0 });
      expect(path.resolve(observed.result.result.stdout.trim())).toBe(expectedRoot);
      expect(observed.result.evidence).toBeUndefined();
      expect(observed.calls.length).toBeLessThanOrEqual(1);
      if (elapsedMs < DEFAULT_PROBE_DELAY_MS) {
        expect(observed.calls).toEqual([]);
      } else if (observed.calls.length === 1) {
        const expectedProbe = await currentDefaultProbeInputs();
        const [call] = observed.calls;
        expect(call).toMatchObject({
          executable: expectedProbe.powershell,
          args: ['-NoProfile', '-NonInteractive', '-Command', expectedProbe.command],
          options: {
            windowsHide: true,
            timeout: 3_000,
            maxBuffer: 4 * 1024,
          },
        });
        expect(path.isAbsolute(call!.executable)).toBe(true);
        expect(expectedProbe.timeoutMs).toBe(3_000);
        expect(expectedProbe.maxBuffer).toBe(4 * 1024);
      }
    },
  );

  it('observes the already-imported production spawn binding for the actual Git root query', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const expectedCwd = await realpath(repo);

    const observed = await withObservedProductionSpawn(() => rootQuery(git, 50));

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.status);
    expect(observed.calls).toHaveLength(1);
    const [call] = observed.calls;
    expect(call?.pid).toEqual(expect.any(Number));
    expect(path.basename(call!.executable).toLowerCase()).toMatch(/^(powershell|pwsh)\.exe$/);
    expect(call?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(call?.options).toMatchObject({
      cwd: expectedCwd,
      shell: false,
      windowsHide: true,
    });
    const payload = JSON.parse(
      Buffer.from(call?.options.env?.RIG_WINDOWS_JOB_PAYLOAD ?? '', 'base64').toString('utf8'),
    ) as { executable: string; cwd: string; args: string[] };
    expect(payload).toEqual({
      executable: git,
      cwd: expectedCwd,
      args: ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
    });
  });

  it('captures bounded in-memory evidence for the actual supervised Git timeout', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');

    const observed = await withObservedProductionSpawn(() =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50)),
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(observed.calls).toHaveLength(1);
    const supervisorPid = observed.calls[0]?.pid;
    expect(supervisorPid).toEqual(expect.any(Number));
    expect(observed.result.evidence).toMatchObject({
      status: 'captured',
      supervisor: { pid: supervisorPid },
    });
    expect(observed.result.evidence?.snapshots.length).toBeGreaterThan(0);
    expect(observed.result.evidence?.snapshots.length).toBeLessThanOrEqual(3);
    for (const snapshot of observed.result.evidence?.snapshots ?? []) {
      expect(snapshot.processes.length).toBeLessThanOrEqual(32);
    }
    const retained = JSON.stringify(observed.result.evidence);
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(16 * 1024);
    expect(retained).not.toContain('RIG_WINDOWS_JOB_PAYLOAD');
    expect(retained).not.toContain('rev-parse');
  });

  it('keeps only bounded owned process metadata', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    let probes = 0;
    const observed = await withObservedProductionSpawn((_outerSpawn, calls) =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          probes += 1;
          const launchedAtMs = calls[0]?.createdAtMs;
          if (launchedAtMs === undefined)
            throw new Error('missing observed supervisor launch time');
          return [
            { pid: supervisor.pid, parentPid: null, createdAtMs: launchedAtMs, cpuTimeMs: 1 },
            {
              pid: supervisor.pid + 10_000,
              parentPid: supervisor.pid,
              executableName: 'C:\\Program Files\\Git\\cmd\\git.exe',
              createdAtMs: launchedAtMs + 1,
              cpuTimeMs: 2,
              commandLine: 'must-not-be-retained',
            },
            ...Array.from({ length: 40 }, (_, index) => ({
              pid: supervisor.pid + 20_000 + index,
              parentPid: 999_999,
              executableName: 'C:\\foreign-process.exe',
              commandLine: 'foreign-command-line',
            })),
          ];
        },
      }),
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(probes).toBe(1);
    const evidence = observed.result.evidence;
    expect(evidence).toMatchObject({ status: 'captured' });
    expect(evidence?.snapshots.length).toBeLessThanOrEqual(3);
    const processes = evidence?.snapshots.flatMap((snapshot) => snapshot.processes) ?? [];
    expect(processes.length).toBeLessThanOrEqual(32);
    expect(processes.map((process) => process.pid)).toEqual(
      expect.arrayContaining([observed.calls[0]?.pid, (observed.calls[0]?.pid ?? 0) + 10_000]),
    );
    expect(processes.some((process) => process.parentPid === 999_999)).toBe(false);
    expect(processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: (observed.calls[0]?.pid ?? 0) + 10_000,
          executableName: 'git.exe',
        }),
      ]),
    );
    const retained = JSON.stringify(evidence);
    expect(retained).not.toContain('commandLine');
    expect(retained).not.toContain('must-not-be-retained');
    expect(retained).not.toContain('foreign-command-line');
    expect(retained).not.toContain('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(retained).not.toContain('foreign-process.exe');
  });

  it('retains owned metadata from a single raw CIM process object', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const observed = await withObservedProductionSpawn((_outerSpawn, calls) =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          const createdAtMs = calls[0]?.createdAtMs;
          if (createdAtMs === undefined) throw new Error('missing observed supervisor launch time');
          return {
            ProcessId: supervisor.pid,
            ParentProcessId: 0,
            Name: supervisor.executable,
            createdAtMs,
            KernelModeTime: 20_000,
            UserModeTime: 30_000,
          };
        },
      }),
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    const supervisorPid = observed.calls[0]?.pid;
    expect(supervisorPid).toEqual(expect.any(Number));
    expect(observed.result.evidence?.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'cim',
          status: 'captured',
          processes: [
            {
              pid: supervisorPid,
              parentPid: 0,
              executableName: path.basename(observed.result.evidence?.supervisor.executable ?? ''),
              createdAtMs: observed.calls[0]?.createdAtMs,
              cpuTimeMs: 5,
            },
          ],
        }),
      ]),
    );
  });

  it('does not retain a direct child when CIM omits the observed supervisor root', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const observed = await withObservedProductionSpawn((_outerSpawn, calls) =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          const createdAtMs = calls[0]?.createdAtMs;
          if (createdAtMs === undefined) throw new Error('missing observed supervisor launch time');
          return [
            {
              ProcessId: supervisor.pid + 10_000,
              ParentProcessId: supervisor.pid,
              Name: 'foreign-child.exe',
              createdAtMs,
            },
          ];
        },
      }),
    );

    const childPid = (observed.calls[0]?.pid ?? 0) + 10_000;
    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(observed.result.evidence).toMatchObject({ status: 'unknown' });
    const retained =
      observed.result.evidence?.snapshots.flatMap((snapshot) => snapshot.processes) ?? [];
    expect(retained.map((process) => process.pid)).not.toContain(childPid);
  });

  it('treats an observed supervisor with an unparseable creation time as unknown', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const observed = await withObservedProductionSpawn((_outerSpawn, calls) =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          const childCreatedAtMs = calls[0]?.createdAtMs;
          if (childCreatedAtMs === undefined)
            throw new Error('missing observed supervisor launch time');
          return [
            {
              ProcessId: supervisor.pid,
              ParentProcessId: 0,
              Name: supervisor.executable,
              createdAtMs: 'not-a-timestamp',
            },
            {
              ProcessId: supervisor.pid + 10_000,
              ParentProcessId: supervisor.pid,
              Name: 'git.exe',
              createdAtMs: childCreatedAtMs,
            },
          ];
        },
      }),
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(observed.result.evidence).toMatchObject({ status: 'unknown' });
    const retained =
      observed.result.evidence?.snapshots.flatMap((snapshot) => snapshot.processes) ?? [];
    expect(retained.map((process) => process.pid)).not.toContain(
      (observed.calls[0]?.pid ?? 0) + 10_000,
    );
  });

  it('treats a supervisor created before its observed launch as unknown', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const observed = await withObservedProductionSpawn((_outerSpawn, calls) =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          const launchedAtMs = calls[0]?.createdAtMs;
          if (launchedAtMs === undefined)
            throw new Error('missing observed supervisor launch time');
          return [
            {
              ProcessId: supervisor.pid,
              ParentProcessId: 0,
              Name: supervisor.executable,
              createdAtMs: launchedAtMs - 10_000,
            },
            {
              ProcessId: supervisor.pid + 10_000,
              ParentProcessId: supervisor.pid,
              Name: 'git.exe',
              createdAtMs: launchedAtMs,
            },
          ];
        },
      }),
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(observed.result.evidence).toMatchObject({ status: 'unknown' });
    const retained =
      observed.result.evidence?.snapshots.flatMap((snapshot) => snapshot.processes) ?? [];
    expect(retained.map((process) => process.pid)).not.toContain(
      (observed.calls[0]?.pid ?? 0) + 10_000,
    );
  });

  it('treats a supervisor created after its observed launch as unknown', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const observed = await withObservedProductionSpawn((_outerSpawn, calls) =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          const launchedAtMs = calls[0]?.createdAtMs;
          if (launchedAtMs === undefined)
            throw new Error('missing observed supervisor launch time');
          return [
            {
              ProcessId: supervisor.pid,
              ParentProcessId: 0,
              Name: supervisor.executable,
              createdAtMs: launchedAtMs + 10_000,
            },
            {
              ProcessId: supervisor.pid + 10_000,
              ParentProcessId: supervisor.pid,
              Name: 'git.exe',
              createdAtMs: launchedAtMs + 10_000,
            },
          ];
        },
      }),
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(observed.result.evidence).toMatchObject({ status: 'unknown' });
    const retained =
      observed.result.evidence?.snapshots.flatMap((snapshot) => snapshot.processes) ?? [];
    expect(retained.map((process) => process.pid)).not.toContain(
      (observed.calls[0]?.pid ?? 0) + 10_000,
    );
  });

  it('does not retain a child that predates its validated supervisor', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const observed = await withObservedProductionSpawn((_outerSpawn, calls) =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          const launchedAtMs = calls[0]?.createdAtMs;
          if (launchedAtMs === undefined)
            throw new Error('missing observed supervisor launch time');
          return [
            {
              ProcessId: supervisor.pid,
              ParentProcessId: 0,
              Name: supervisor.executable,
              createdAtMs: launchedAtMs,
            },
            {
              ProcessId: supervisor.pid + 10_000,
              ParentProcessId: supervisor.pid,
              Name: 'git.exe',
              createdAtMs: launchedAtMs - 10_000,
            },
          ];
        },
      }),
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(observed.result.evidence).toMatchObject({ status: 'unknown' });
    const retained =
      observed.result.evidence?.snapshots.flatMap((snapshot) => snapshot.processes) ?? [];
    expect(retained.map((process) => process.pid)).not.toContain(
      (observed.calls[0]?.pid ?? 0) + 10_000,
    );
  });

  it('returns unknown evidence when the snapshot probe times out', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    let probes = 0;
    const observed = await captureWindowsProcessEvidence(() => rootQuery(git, 50), {
      probe: async () => {
        probes += 1;
        const error = new Error('simulated CIM timeout') as NodeJS.ErrnoException;
        error.code = 'ETIMEDOUT';
        throw error;
      },
    });

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.status);
    expect(probes).toBe(1);
    expect(observed.evidence).toMatchObject({ status: 'unknown' });
  });

  it('treats an empty CIM process result as unknown evidence', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');

    const observed = await captureWindowsProcessEvidence(() => rootQuery(git, 50), {
      probe: async () => [],
    });

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.status);
    expect(observed.evidence).toMatchObject({ status: 'unknown' });
    expect(observed.evidence?.snapshots).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'cim', status: 'unknown' })]),
    );
    expect(
      observed.evidence?.snapshots.some(
        (snapshot) => snapshot.source === 'cim' && snapshot.status === 'captured',
      ),
    ).toBe(false);
  });

  it('preserves the supervised root-query result when an injected probe throws synchronously', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    let probes = 0;
    const observed = await withObservedProductionSpawn(() =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: () => {
          probes += 1;
          throw new Error('synchronous test probe failure');
        },
      }),
    );
    try {
      expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
      expect(probes).toBe(1);
      expect(observed.result.evidence).toMatchObject({ status: 'unknown' });
    } finally {
      await stopObservedSupervisors(observed.calls);
    }
  });

  it('does not wait for an unresponsive injected probe before restoring the global spawn binding', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const baselineSpawn = childProcess.spawn;
    let probes = 0;
    let aborted = false;
    const outcome = await withObservedProductionSpawn(async () =>
      Promise.race([
        captureWindowsProcessEvidence(() => rootQuery(git, 50), {
          probe: (_supervisor, signal) => {
            probes += 1;
            signal.addEventListener('abort', () => {
              aborted = true;
            });
            return new Promise<never>(() => {});
          },
        }).then((captured) => ({ kind: 'result' as const, captured })),
        delay(2_000).then(() => ({ kind: 'hung' as const })),
      ]),
    );

    // The outer test wrapper restores its own binding after the bounded race,
    // even while a defective capture remains pending.
    expect(childProcess.spawn).toBe(baselineSpawn);
    expect(outcome.result.kind).toBe('result');
    if (outcome.result.kind === 'result') {
      expect(['timeout', 'cleanup-unconfirmed']).toContain(outcome.result.captured.result.status);
      expect(outcome.result.captured.evidence).toMatchObject({ status: 'unknown' });
      expect(outcome.result.captured.evidence?.snapshots).toEqual(
        expect.arrayContaining([expect.objectContaining({ source: 'cim', status: 'unknown' })]),
      );
    }
    expect(probes).toBe(1);
    expect(aborted).toBe(true);
  });

  it('preserves an operation error without emitting evidence', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const failure = new Error('original provider failure');

    await expect(
      captureWindowsProcessEvidence(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('cancels its one active probe and restores the prior spawn binding after timeout', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    let probes = 0;
    let active = 0;
    let peakActive = 0;
    let cancelled = false;
    const observed = await withObservedProductionSpawn(async (outerSpawn) => {
      const captured = await captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (_supervisor, signal) =>
          new Promise((resolve) => {
            probes += 1;
            active += 1;
            peakActive = Math.max(peakActive, active);
            signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                active -= 1;
                resolve([]);
              },
              { once: true },
            );
          }),
      });
      const childProcess = require('node:child_process') as typeof import('node:child_process');
      expect(childProcess.spawn).toBe(outerSpawn);
      return captured;
    });

    expect(['timeout', 'cleanup-unconfirmed']).toContain(observed.result.result.status);
    expect(probes).toBe(1);
    expect(peakActive).toBe(1);
    expect(cancelled).toBe(true);
    expect(observed.result.evidence?.snapshots).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'launch', status: 'captured' })]),
    );
    expect(
      observed.result.evidence?.snapshots.some(
        (snapshot) => snapshot.source === 'cim' && snapshot.status === 'captured',
      ),
    ).toBe(false);
  });
});

describe(
  'Windows default CIM probe ErrorAction semantics',
  { timeout: WINDOWS_CONSUMER_CASE_TIMEOUT_MS },
  () => {
    // Real PowerShell error semantics with a controlled cmdlet stub; this does
    // not measure CIM availability or explain the hosted timeout.
    const controlledCimFunction = [
      'function Get-CimInstance {',
      '  [CmdletBinding()]',
      '  param([string]$ClassName)',
      "  Write-Error -ErrorId 'RP518.ControlledCimFailure' -Message 'RP518 controlled CIM failure'",
      '}',
    ].join('\n');

    beforeEach((ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    });

    it.each([
      ['turns a controlled cmdlet error into a terminating failure', false],
      ['would falsely succeed without ErrorAction Stop', true],
    ])('%s', async (_name, removeStop) => {
      const { command, powershell, timeoutMs, maxBuffer } = await currentDefaultProbeInputs();
      const commandForCase = removeStop ? command.replace(' -ErrorAction Stop', '') : command;
      if (removeStop && commandForCase === command)
        throw new Error('could not remove ErrorAction Stop from the default CIM command');
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!systemRoot) throw new Error('SystemRoot is unavailable');
      expect(timeoutMs).toBe(3_000);
      expect(maxBuffer).toBe(4 * 1024);
      const controlledCommand = `${controlledCimFunction}\n${commandForCase}`;
      const execution = exec(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', controlledCommand],
        {
          env: { SystemRoot: systemRoot, RIG_WINDOWS_EVIDENCE_PID: String(process.pid) },
          windowsHide: true,
          timeout: WINDOWS_CONSUMER_CHILD_TIMEOUT_MS,
          maxBuffer,
        },
      );

      if (!removeStop) {
        await expect(execution).rejects.toMatchObject({
          code: 1,
          killed: false,
          signal: null,
          stderr: expect.stringContaining('RP518.ControlledCimFailure'),
        });
      } else {
        await expect(execution).resolves.toMatchObject({
          stdout: '',
          stderr: expect.stringContaining('RP518.ControlledCimFailure'),
        });
      }
    });
  },
);
