// `create-agent-rig setup --memory-root <checkout>`: the sole writer of the
// machine subsystem manifest for 0.9.0 (ADR-RP-002 R6, RP-147). Order is the
// contract: derive the entry from the one declared root, perform the
// `--version --json` handshake, refuse a foreign contract major with exit 4
// before anything is written, then write the manifest atomically.
import { execFile } from 'node:child_process';
import {
  SUBSYSTEMS_SCHEMA_VERSION,
  SubsystemsError,
  deriveMemoryEntry,
  handshake,
  subsystemsManifestPath,
  writeSubsystemsManifest,
} from '../lib/subsystems.js';
import type { HandshakeResult, Runner } from '../lib/subsystems.js';

export type SetupOptions = {
  memoryRoot: string;
  memoryRef?: string | null;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  run?: Runner;
};

type OkHandshake = Extract<HandshakeResult, { status: 'ok' }>;
type ForeignMajor = Extract<HandshakeResult, { status: 'foreign-major' }>;
type FailedHandshake = Exclude<HandshakeResult, { status: 'ok' | 'foreign-major' }>;

export type SetupResult =
  | { outcome: 'written' | 'dry-run'; file: string; handshake: OkHandshake }
  | { outcome: 'refused'; exitCode: 4; handshake: ForeignMajor }
  | { outcome: 'refused'; exitCode: 1; handshake: FailedHandshake };

/** The default runner: one child, one JSON line, a bounded wait. */
export const execFileRunner: Runner = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT')
          resolve({ code: 1, stdout, stderr, spawnError: error as NodeJS.ErrnoException });
        else if (error && typeof (error as { code?: unknown }).code === 'number')
          resolve({ code: (error as { code: number }).code, stdout, stderr });
        else if (error)
          resolve({ code: 1, stdout, stderr, spawnError: error as NodeJS.ErrnoException });
        else resolve({ code: 0, stdout, stderr });
      },
    );
  });

export async function setupSubsystems(options: SetupOptions): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execFileRunner;
  const file = subsystemsManifestPath(env, platform);
  const entry = deriveMemoryEntry(
    {
      memoryRoot: options.memoryRoot,
      nodeExecutable: options.nodeExecutable ?? process.execPath,
      memoryRef: options.memoryRef ?? null,
      installedVersion: '',
    },
    platform,
  );
  const result = await handshake(entry, run);
  if (result.status === 'foreign-major')
    return { outcome: 'refused', exitCode: 4, handshake: result };
  if (result.status !== 'ok') return { outcome: 'refused', exitCode: 1, handshake: result };
  if (options.dryRun === true) return { outcome: 'dry-run', file, handshake: result };
  await writeSubsystemsManifest(file, {
    schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
    entries: { memory: { ...entry, installedVersion: result.version } },
  });
  return { outcome: 'written', file, handshake: result };
}

export { SubsystemsError };
