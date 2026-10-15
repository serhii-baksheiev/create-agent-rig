/** Test-side bounded evidence for an unresolved Windows job supervisor. */
export type WindowsProcessEvidence = {
  // `captured` may name only an observed spawn. It is not a liveness, process
  // tree, or Git-stage claim unless a later CIM snapshot says so.
  status: 'captured' | 'unknown';
  supervisor: {
    executable: string;
    pid: number;
  };
  snapshots: readonly {
    source: 'launch' | 'cim';
    status: 'captured' | 'unknown';
    processes: readonly {
      pid: number;
      parentPid: number | null;
      executableName?: string;
      createdAtMs?: number;
      cpuTimeMs?: number;
    }[];
  }[];
};

export type WindowsProcessEvidenceRun<T> = {
  result: T;
  evidence: WindowsProcessEvidence | undefined;
};

/** A test-only stand-in for the bounded CIM snapshot operation. */
export type WindowsProcessEvidenceProbe = (
  supervisor: { executable: string; pid: number },
  signal: AbortSignal,
) => Promise<unknown>;

export type WindowsProcessEvidenceOptions = {
  probe?: WindowsProcessEvidenceProbe;
};

type ProcessRecord = {
  pid?: unknown;
  ProcessId?: unknown;
  parentPid?: unknown;
  ParentProcessId?: unknown;
  executableName?: unknown;
  Name?: unknown;
  createdAtMs?: unknown;
  CreationDate?: unknown;
  cpuTimeMs?: unknown;
  KernelModeTime?: unknown;
  UserModeTime?: unknown;
};

const require = createRequire(import.meta.url);
const MAX_SNAPSHOTS = 3;
const MAX_PROCESSES = 32;
const MAX_RETAINED_BYTES = 16 * 1024;
const MAX_TREE_DEPTH = 2;
const DEFAULT_PROBE_DELAY_MS = 8_000;
const ROOT_QUERY_ARGS = ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'];

function numberValue(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function executableName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return path.basename(value).toLowerCase();
}

function isRootQuery(
  executable: unknown,
  args: unknown,
  options: unknown,
): options is { env?: NodeJS.ProcessEnv } {
  if (
    typeof executable !== 'string' ||
    !Array.isArray(args) ||
    !options ||
    typeof options !== 'object'
  )
    return false;
  const spawnOptions = options as {
    env?: NodeJS.ProcessEnv;
    shell?: unknown;
    windowsHide?: unknown;
  };
  if (spawnOptions.shell !== false || spawnOptions.windowsHide !== true) return false;
  if (!/^(powershell|pwsh)\.exe$/i.test(path.basename(executable))) return false;
  const payload = spawnOptions.env?.RIG_WINDOWS_JOB_PAYLOAD;
  if (typeof payload !== 'string') return false;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') return false;
    const request = decoded as { executable?: unknown; args?: unknown };
    return (
      typeof request.executable === 'string' &&
      path.basename(request.executable).toLowerCase() === 'git.exe' &&
      Array.isArray(request.args) &&
      request.args.length === ROOT_QUERY_ARGS.length &&
      request.args.every((part, index) => part === ROOT_QUERY_ARGS[index])
    );
  } catch {
    return false;
  }
}

function ownedProcesses(
  raw: unknown,
  rootPid: number,
  launchWindow: { startedAtMs: number; observedAtMs: number },
  remaining: number,
): WindowsProcessEvidence['snapshots'][number]['processes'] | undefined {
  if (remaining < 1) return [];
  const records = Array.isArray(raw) ? raw : [raw];
  const rows = records
    .filter((value): value is ProcessRecord => Boolean(value) && typeof value === 'object')
    .map((row) => ({
      row,
      pid: numberValue(row.pid ?? row.ProcessId),
      parentPid: numberValue(row.parentPid ?? row.ParentProcessId),
    }))
    .filter(
      (row): row is { row: ProcessRecord; pid: number; parentPid: number | undefined } =>
        row.pid !== undefined,
    );
  const root = rows.find((row) => row.pid === rootPid);
  const rootCreatedAtMs = timestampValue(root?.row.createdAtMs ?? root?.row.CreationDate);
  if (
    !root ||
    rootCreatedAtMs === undefined ||
    rootCreatedAtMs < launchWindow.startedAtMs ||
    rootCreatedAtMs > launchWindow.observedAtMs
  )
    return undefined;
  const selected = [root];
  let parents = [{ pid: root.pid, createdAtMs: rootCreatedAtMs }];
  for (let depth = 0; depth < MAX_TREE_DEPTH && parents.length; depth += 1) {
    const children = rows.filter((row) => parents.some((parent) => parent.pid === row.parentPid));
    const nextParents: { pid: number; createdAtMs: number }[] = [];
    for (const child of children) {
      const parent = parents.find((candidate) => candidate.pid === child.parentPid);
      const childCreatedAtMs = timestampValue(child.row.createdAtMs ?? child.row.CreationDate);
      if (!parent || childCreatedAtMs === undefined || childCreatedAtMs < parent.createdAtMs)
        return undefined;
      selected.push(child);
      nextParents.push({ pid: child.pid, createdAtMs: childCreatedAtMs });
    }
    parents = nextParents;
  }
  const result: WindowsProcessEvidence['snapshots'][number]['processes'][number][] = [];
  for (const row of selected) {
    if (result.length >= remaining) break;
    const item: WindowsProcessEvidence['snapshots'][number]['processes'][number] = {
      pid: row.pid,
      parentPid: row.parentPid ?? null,
    };
    const name = executableName(row.row.executableName ?? row.row.Name);
    const createdAtMs = timestampValue(row.row.createdAtMs ?? row.row.CreationDate);
    const directCpu = numberValue(row.row.cpuTimeMs);
    const kernel = numberValue(row.row.KernelModeTime);
    const user = numberValue(row.row.UserModeTime);
    const cpuTimeMs =
      directCpu ??
      (kernel === undefined || user === undefined
        ? undefined
        : Math.floor((kernel + user) / 10_000));
    if (name) item.executableName = name;
    if (createdAtMs !== undefined) item.createdAtMs = createdAtMs;
    if (cpuTimeMs !== undefined) item.cpuTimeMs = cpuTimeMs;
    result.push(item);
  }
  return result;
}

function defaultProbe(
  supervisor: { executable: string; pid: number },
  signal: AbortSignal,
): Promise<unknown> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) return Promise.resolve([]);
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const command =
    '$target=[int]$env:RIG_WINDOWS_EVIDENCE_PID;$all=@(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,@{Name="createdAtMs";Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}},KernelModeTime,UserModeTime);$owned=@($target);for($depth=0;$depth -lt 2;$depth++){$owned+=@($all|Where-Object{$owned -contains [int]$_.ParentProcessId}|ForEach-Object{[int]$_.ProcessId})};$all|Where-Object{$owned -contains [int]$_.ProcessId}|ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    let abort = () => {};
    const child = execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        env: { SystemRoot: systemRoot, RIG_WINDOWS_EVIDENCE_PID: String(supervisor.pid) },
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 4 * 1024,
      },
      (error, stdout) => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else {
          try {
            if (!stdout.trim()) throw new Error('empty bounded CIM process snapshot');
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('malformed bounded CIM process snapshot'));
          }
        }
      },
    );
    abort = () => child.kill();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Observes only the first production Windows-job Git root query made by this
 * operation. The production spawn call is forwarded untouched; evidence never
 * changes its result or error.
 */
export async function captureWindowsProcessEvidence<T>(
  operation: () => Promise<T>,
  options: WindowsProcessEvidenceOptions = {},
): Promise<WindowsProcessEvidenceRun<T>> {
  if (process.platform !== 'win32') return { result: await operation(), evidence: undefined };
  const childProcess = require('node:child_process') as typeof import('node:child_process');
  const originalSpawn = childProcess.spawn;
  const snapshots: WindowsProcessEvidence['snapshots'][number][] = [];
  let processCount = 0;
  let evidence: WindowsProcessEvidence | undefined;
  let probeController: AbortController | undefined;
  let probeTimer: NodeJS.Timeout | undefined;
  let probeFailed = false;
  let targetSeen = false;
  const addSnapshot = (snapshot: WindowsProcessEvidence['snapshots'][number]) => {
    if (snapshots.length >= MAX_SNAPSHOTS || processCount >= MAX_PROCESSES) return;
    const processes = snapshot.processes.slice(0, MAX_PROCESSES - processCount);
    const candidate = { ...snapshot, processes };
    if (Buffer.byteLength(JSON.stringify([...snapshots, candidate])) > MAX_RETAINED_BYTES) return;
    snapshots.push(candidate);
    processCount += processes.length;
  };
  childProcess.spawn = ((...spawnArgs: Parameters<typeof originalSpawn>) => {
    const launchStartedAtMs = Date.now();
    const child = originalSpawn(...spawnArgs);
    const launchObservedAtMs = Date.now();
    const [executable, args, spawnOptions] = spawnArgs;
    if (!targetSeen && isRootQuery(executable, args, spawnOptions)) {
      targetSeen = true;
      const pid = child.pid;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
        evidence = {
          status: 'unknown',
          supervisor: { executable: path.basename(executable), pid: 0 },
          snapshots: [],
        };
      } else {
        const supervisor = { executable: path.basename(executable), pid };
        evidence = { status: 'captured', supervisor, snapshots };
        addSnapshot({
          source: 'launch',
          status: 'captured',
          processes: [
            { pid, parentPid: null, executableName: path.basename(executable).toLowerCase() },
          ],
        });
        const controller = new AbortController();
        probeController = controller;
        const probe = options.probe ?? defaultProbe;
        const recordProbeFailure = () => {
          if (controller.signal.aborted) return;
          probeFailed = true;
          addSnapshot({ source: 'cim', status: 'unknown', processes: [] });
        };
        const startProbe = () => {
          if (controller.signal.aborted) return;
          try {
            void Promise.resolve(probe(supervisor, controller.signal))
              .then((raw) => {
                if (controller.signal.aborted) return;
                const processes = ownedProcesses(
                  raw,
                  pid,
                  { startedAtMs: launchStartedAtMs, observedAtMs: launchObservedAtMs },
                  MAX_PROCESSES - processCount,
                );
                if (!processes) {
                  recordProbeFailure();
                  return;
                }
                addSnapshot({
                  source: 'cim',
                  status: 'captured',
                  processes,
                });
              })
              .catch(recordProbeFailure);
          } catch {
            recordProbeFailure();
          }
        };
        if (options.probe) startProbe();
        else {
          probeTimer = setTimeout(startProbe, DEFAULT_PROBE_DELAY_MS);
          probeTimer.unref();
        }
      }
    }
    return child;
  }) as typeof originalSpawn;
  syncBuiltinESMExports();
  try {
    const result = await operation();
    const abnormal =
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      ((result as { status?: unknown }).status === 'timeout' ||
        (result as { status?: unknown }).status === 'output-limit' ||
        (result as { status?: unknown }).status === 'cleanup-unconfirmed');
    return {
      result,
      evidence:
        evidence && abnormal
          ? probeFailed
            ? { ...evidence, status: 'unknown' }
            : evidence
          : undefined,
    };
  } finally {
    if (probeTimer) clearTimeout(probeTimer);
    probeController?.abort();
    try {
      // A probe that ignores abort must not hold the original result or the
      // global builtin binding open.
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  }
}
import { execFile } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
