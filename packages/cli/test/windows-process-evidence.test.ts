import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProviderProcess, type ProviderProcessResult } from '../src/integrations/spawn.js';
import { captureWindowsProcessEvidence } from './helpers/windows-process-evidence.js';
import { onlyOnWindows, skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);

let repo: string;

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

type SpawnCall = {
  executable: string;
  args: readonly string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean };
  pid: number | undefined;
};

type ExecFileCall = {
  executable: string;
  args: readonly string[];
};

async function withObservedProductionSpawn<T>(
  operation: (outerSpawn: typeof import('node:child_process').spawn) => Promise<T>,
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
    calls.push({ executable, args, options, pid: child.pid });
    return child;
  }) as typeof originalSpawn;
  syncBuiltinESMExports();
  try {
    return { result: await operation(childProcess.spawn), calls };
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
    const [executable, fileArgs] = args;
    calls.push({
      executable: String(executable),
      args: Array.isArray(fileArgs) ? [...fileArgs] : [],
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

describe('Windows supervised process evidence', { timeout: 15_000 }, () => {
  it('leaves a successful non-root provider run silent and unchanged', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');

    const observed = await captureWindowsProcessEvidence(() =>
      runProviderProcess({
        executable: git,
        args: ['--version'],
        repoDir: repo,
        timeoutMs: 6_000,
      }),
    );

    expect(observed.result).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(observed.evidence).toBeUndefined();
  });

  it('does not launch a diagnostic CIM process for a normally completed root query', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const git = await executableOnPath('git');
    const expectedRoot = await realpath(repo);

    const observed = await withObservedExecFile(() =>
      captureWindowsProcessEvidence(() => rootQuery(git, 6_000)),
    );

    expect(observed.result.result).toMatchObject({ status: 'ok', stderr: '', exitCode: 0 });
    expect(path.resolve(observed.result.result.stdout.trim())).toBe(expectedRoot);
    expect(observed.calls).toEqual([]);
    expect(observed.result.evidence).toBeUndefined();
  });

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
    const observed = await withObservedProductionSpawn(() =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => {
          probes += 1;
          return [
            { pid: supervisor.pid, parentPid: null, createdAtMs: 1, cpuTimeMs: 1 },
            {
              pid: supervisor.pid + 10_000,
              parentPid: supervisor.pid,
              executableName: 'C:\\Program Files\\Git\\cmd\\git.exe',
              createdAtMs: 2,
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
    const createdAt = '2026-10-15T00:00:00.000Z';
    const observed = await withObservedProductionSpawn(() =>
      captureWindowsProcessEvidence(() => rootQuery(git, 50), {
        probe: async (supervisor) => ({
          ProcessId: supervisor.pid,
          ParentProcessId: 0,
          Name: supervisor.executable,
          CreationDate: createdAt,
          KernelModeTime: 20_000,
          UserModeTime: 30_000,
        }),
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
              createdAtMs: Date.parse(createdAt),
              cpuTimeMs: 5,
            },
          ],
        }),
      ]),
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
