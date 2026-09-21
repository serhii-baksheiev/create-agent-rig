import path from 'node:path';
import { readBounded } from './verify.js';
import { runProviderProcess } from './spawn.js';
import {
  handshake,
  parseSubsystemsManifest,
  subsystemsManifestPath,
  type Runner,
} from '../lib/subsystems.js';

const MAX_MACHINE_MANIFEST_BYTES = 64 * 1024;

export type MemoryInspection = {
  status: 'pass' | 'warn' | 'fail';
  reason:
    | 'not-configured'
    | 'machine-config-root-unavailable'
    | 'manifest-invalid'
    | 'handshake-failed'
    | 'foreign-contract'
    | 'executable-missing'
    | 'doctor-ok'
    | 'doctor-warn'
    | 'doctor-failed'
    | 'doctor-invalid'
    | 'doctor-timeout'
    | 'doctor-cleanup-unconfirmed';
  runtime: 'unverified' | 'verified';
  contract: 'unverified' | 'compatible' | 'foreign';
};

export type InspectMemoryOptions = {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  runner?: typeof runProviderProcess;
};

const result = (
  status: MemoryInspection['status'],
  reason: MemoryInspection['reason'],
  runtime: MemoryInspection['runtime'],
  contract: MemoryInspection['contract'],
): MemoryInspection => ({ status, reason, runtime, contract });

function manifestLocation(env: NodeJS.ProcessEnv): { root: string; rel: string } | null {
  try {
    const file = subsystemsManifestPath(env, process.platform);
    const root = process.platform === 'win32' ? env.APPDATA : env.HOME;
    if (root === undefined || root === '') return null;
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
    return { root, rel };
  } catch {
    return null;
  }
}

function bridge(runner: typeof runProviderProcess, repoDir: string): Runner {
  return async (file, args, { timeoutMs }) => {
    const process = await runner({ executable: file, args, repoDir, timeoutMs });
    if (process.status === 'ok' || (process.status === 'failed' && process.exitCode !== null))
      return { code: process.exitCode ?? 1, stdout: process.stdout, stderr: process.stderr };
    if (process.status === 'failed')
      return {
        code: 1,
        stdout: '',
        stderr: '',
        spawnError: Object.assign(new Error('provider unavailable'), { code: 'ENOENT' }),
      };
    return { code: 1, stdout: '', stderr: '' };
  };
}

type DoctorStatus = 'ok' | 'warn' | 'fail';

/**
 * The Memory boundary owns its doctor output. Rig accepts only the published
 * v1 summary shape and never forwards its detail or fix text into Rig output.
 */
function parseDoctorSummary(stdout: string): DoctorStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (report.schemaVersion !== 1 || !isDoctorStatus(report.status) || !Array.isArray(report.checks))
    return null;
  let expected: DoctorStatus = 'ok';
  for (const check of report.checks) {
    if (typeof check !== 'object' || check === null || Array.isArray(check)) return null;
    const record = check as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      record.id === '' ||
      !isDoctorStatus(record.status) ||
      typeof record.detail !== 'string' ||
      typeof record.fix !== 'string'
    )
      return null;
    if (record.status === 'fail') expected = 'fail';
    else if (record.status === 'warn' && expected === 'ok') expected = 'warn';
  }
  return report.status === expected ? report.status : null;
}

function isDoctorStatus(value: unknown): value is DoctorStatus {
  return value === 'ok' || value === 'warn' || value === 'fail';
}

/** Inspect only the registered machine-local Memory boundary; never provider data. */
export async function inspectMemory(options: InspectMemoryOptions): Promise<MemoryInspection> {
  const location = manifestLocation(options.env);
  if (location === null)
    return result('warn', 'machine-config-root-unavailable', 'unverified', 'unverified');
  const source = await readBounded(location.root, location.rel, MAX_MACHINE_MANIFEST_BYTES);
  if (source.status === 'absent')
    return result('pass', 'not-configured', 'unverified', 'unverified');
  if (source.status !== 'ok') return result('fail', 'manifest-invalid', 'unverified', 'unverified');
  let manifest;
  try {
    manifest = parseSubsystemsManifest(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes),
    );
  } catch {
    manifest = null;
  }
  if (manifest === null) return result('fail', 'manifest-invalid', 'unverified', 'unverified');

  const runner = options.runner ?? runProviderProcess;
  const checked = await handshake(manifest.entries.memory, bridge(runner, options.repoDir));
  if (checked.status === 'foreign-major')
    return result('fail', 'foreign-contract', 'unverified', 'foreign');
  if (checked.status === 'unsupported')
    return result('warn', 'executable-missing', 'unverified', 'unverified');
  if (checked.status !== 'ok')
    return result('fail', 'handshake-failed', 'unverified', 'unverified');

  const doctor = await runner({
    executable: manifest.entries.memory.invocation[0],
    args: [manifest.entries.memory.invocation[1], 'doctor', '--json'],
    repoDir: options.repoDir,
  });
  if (doctor.status === 'ok') {
    const summary = parseDoctorSummary(doctor.stdout);
    if (summary === null) return result('fail', 'doctor-invalid', 'unverified', 'compatible');
    if (summary === 'ok') return result('pass', 'doctor-ok', 'verified', 'compatible');
    if (summary === 'warn') return result('warn', 'doctor-warn', 'verified', 'compatible');
    return result('fail', 'doctor-failed', 'verified', 'compatible');
  }
  if (doctor.status === 'timeout')
    return result('fail', 'doctor-timeout', 'unverified', 'compatible');
  if (doctor.status === 'cleanup-unconfirmed')
    return result('fail', 'doctor-cleanup-unconfirmed', 'unverified', 'compatible');
  if (doctor.status === 'failed' && doctor.exitCode === null)
    return result('warn', 'executable-missing', 'unverified', 'compatible');
  return result('fail', 'doctor-failed', 'verified', 'compatible');
}
