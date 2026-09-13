// The machine-scoped subsystem manifest (ADR-RP-002 R6, RP-147): installation
// metadata, not a service registry. One writer (`setup`; `upgrade` re-runs the
// same derivation), one scope (the user's configuration root), one entry per
// subsystem carrying the resolved executable invocation and the contract major
// it must answer. No search path, no fallback chain, no PATH scan: the
// executable is derived from the one root the owner declared, and every
// substantive call performs the `--version --json` handshake first.
//
// Handshake results carry no path — a status is machine JSON a consumer may
// print, and the manifest itself is the only place a location is written.
import { statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const SUBSYSTEMS_SCHEMA_VERSION = 1;
export const MEMORY_CONTRACT_MAJOR = 1;
const MEMORY_EXECUTABLE_REL = ['shared-memory', 'memory.mjs'] as const;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export type SubsystemsErrorCode =
  | 'config-root-unavailable'
  | 'memory-root-relative'
  | 'memory-executable-absent'
  | 'manifest-unreadable';

export class SubsystemsError extends Error {
  readonly code: SubsystemsErrorCode;
  constructor(code: SubsystemsErrorCode, message: string) {
    super(message);
    this.name = 'SubsystemsError';
    this.code = code;
  }
}

export type MemoryEntry = {
  memoryRoot: string;
  invocation: [string, string];
  contractMajor: typeof MEMORY_CONTRACT_MAJOR;
  memoryRef: string | null;
  installedVersion: string;
};

export type SubsystemsManifest = {
  schemaVersion: typeof SUBSYSTEMS_SCHEMA_VERSION;
  entries: { memory: MemoryEntry };
};

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
};
export type Runner = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<RunResult>;

export type HandshakeResult =
  | { status: 'ok'; version: string; contractVersion: string }
  | { status: 'unsupported'; reason: 'absent' }
  | { status: 'integration-failed'; reason: 'manifest-stale' | 'invalid-payload' | 'invalid' }
  | {
      status: 'foreign-major';
      contractVersion: string;
      requiredMajor: typeof MEMORY_CONTRACT_MAJOR;
    };

/**
 * Exactly one location per platform. An unset root is refused, not guessed:
 * a manifest written under a guessed home is a manifest nothing else reads.
 */
export function subsystemsManifestPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const root = env.APPDATA;
    if (!root) throw new SubsystemsError('config-root-unavailable', 'APPDATA is not set');
    return path.join(root, 'create-agent-rig', 'subsystems.json');
  }
  const home = env.HOME;
  if (!home) throw new SubsystemsError('config-root-unavailable', 'HOME is not set');
  return path.join(home, '.config', 'create-agent-rig', 'subsystems.json');
}

/** The path module of the DECLARED platform, so an entry's encoding is pinned by the platform argument, not by the host. */
const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

export function memoryExecutablePath(memoryRoot: string, platform: NodeJS.Platform): string {
  return pathFor(platform).join(memoryRoot, ...MEMORY_EXECUTABLE_REL);
}

/**
 * The pure half of the derivation: root → invocation, in the declared
 * platform's encoding. The root is the single declared input
 * (`setup --memory-root`), so it must be absolute under that platform — a
 * relative root would make the entry mean a different executable from every
 * working directory. No filesystem here, so both encodings are pinned by tests
 * on any host.
 */
export function memoryInvocation(
  input: { memoryRoot: string; nodeExecutable: string },
  platform: NodeJS.Platform,
): [string, string] {
  if (!pathFor(platform).isAbsolute(input.memoryRoot))
    throw new SubsystemsError('memory-root-relative', 'the Memory root must be an absolute path');
  return [input.nodeExecutable, memoryExecutablePath(input.memoryRoot, platform)];
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The whole derivation: the invocation above, plus the check that the
 * executable is already there on this host — the manifest records what
 * exists, it does not promise what an install will bring. So `platform` is
 * the host's here; the pure half is what a foreign platform's encoding is
 * tested through.
 */
export function deriveMemoryEntry(
  input: {
    memoryRoot: string;
    nodeExecutable: string;
    memoryRef: string | null;
    installedVersion: string;
  },
  platform: NodeJS.Platform,
): MemoryEntry {
  const invocation = memoryInvocation(input, platform);
  if (!isFile(invocation[1]))
    throw new SubsystemsError(
      'memory-executable-absent',
      `no ${MEMORY_EXECUTABLE_REL.join('/')} under the declared Memory root`,
    );
  return {
    memoryRoot: input.memoryRoot,
    invocation,
    contractMajor: MEMORY_CONTRACT_MAJOR,
    memoryRef: input.memoryRef,
    installedVersion: input.installedVersion,
  };
}

const majorOf = (contractVersion: string): number | null => {
  const match = /^(\d+)\.\d+$/.exec(contractVersion);
  return match ? Number(match[1]) : null;
};

/**
 * `--version --json` and its classification. The consumer compares the
 * contract major alone; a foreign major is the consumer's refusal (exit 4 in
 * `setup`), never something Memory emits. A failure payload is
 * INTEGRATION-FAILED, never absence: the executable answered.
 */
export async function handshake(
  entry: Pick<MemoryEntry, 'invocation'>,
  run: Runner,
  options: { timeoutMs?: number } = {},
): Promise<HandshakeResult> {
  const [file, script] = entry.invocation;
  // Absence is the runner's answer (ENOENT), not a pre-check: the executable
  // the manifest names is exactly what this call must exercise.
  const result = await run(file, [script, '--version', '--json'], {
    timeoutMs: options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  });
  if (result.spawnError) {
    if (result.spawnError.code === 'ENOENT') return { status: 'unsupported', reason: 'absent' };
    return { status: 'integration-failed', reason: 'invalid-payload' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { status: 'integration-failed', reason: 'invalid-payload' };
  }
  if (typeof payload !== 'object' || payload === null)
    return { status: 'integration-failed', reason: 'invalid-payload' };
  const record = payload as Record<string, unknown>;
  if (result.code !== 0 || record.result === 'integration-failed')
    return { status: 'integration-failed', reason: 'invalid' };
  const { name, version, contractVersion } = record;
  if (typeof version !== 'string' || typeof contractVersion !== 'string')
    return { status: 'integration-failed', reason: 'invalid-payload' };
  if (name !== 'memory') return { status: 'integration-failed', reason: 'manifest-stale' };
  const major = majorOf(contractVersion);
  if (major === null) return { status: 'integration-failed', reason: 'manifest-stale' };
  if (major !== MEMORY_CONTRACT_MAJOR)
    return { status: 'foreign-major', contractVersion, requiredMajor: MEMORY_CONTRACT_MAJOR };
  return { status: 'ok', version, contractVersion };
}

/** Stable bytes: fixed key order, two-space indent, trailing newline. */
export function serializeSubsystemsManifest(manifest: SubsystemsManifest): string {
  const memory = manifest.entries.memory;
  const ordered: SubsystemsManifest = {
    schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
    entries: {
      memory: {
        memoryRoot: memory.memoryRoot,
        invocation: [memory.invocation[0], memory.invocation[1]],
        contractMajor: MEMORY_CONTRACT_MAJOR,
        memoryRef: memory.memoryRef,
        installedVersion: memory.installedVersion,
      },
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const isString = (value: unknown): value is string => typeof value === 'string';

export function parseSubsystemsManifest(text: string): SubsystemsManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== SUBSYSTEMS_SCHEMA_VERSION) return null;
  const entries = root.entries;
  if (typeof entries !== 'object' || entries === null) return null;
  const memory = (entries as Record<string, unknown>).memory;
  if (typeof memory !== 'object' || memory === null) return null;
  const m = memory as Record<string, unknown>;
  const invocation = m.invocation;
  if (
    !isString(m.memoryRoot) ||
    !Array.isArray(invocation) ||
    invocation.length !== 2 ||
    !invocation.every(isString) ||
    m.contractMajor !== MEMORY_CONTRACT_MAJOR ||
    !(m.memoryRef === null || isString(m.memoryRef)) ||
    !isString(m.installedVersion)
  )
    return null;
  return {
    schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
    entries: {
      memory: {
        memoryRoot: m.memoryRoot,
        // `every(isString)` above proved both elements are strings, but
        // Array.prototype.every does not narrow a tuple's element type.
        invocation: [invocation[0] as string, invocation[1] as string],
        contractMajor: MEMORY_CONTRACT_MAJOR,
        // Checked above as `null` or a string; the `||` chain does not narrow `m.memoryRef`.
        memoryRef: m.memoryRef as string | null,
        installedVersion: m.installedVersion,
      },
    },
  };
}

/** `null` when absent — no evidence; a present file that does not parse is an error, not silence. */
export async function readSubsystemsManifest(file: string): Promise<SubsystemsManifest | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SubsystemsError('manifest-unreadable', `cannot read ${path.basename(file)}`);
  }
  const manifest = parseSubsystemsManifest(text);
  if (manifest === null)
    throw new SubsystemsError(
      'manifest-unreadable',
      `${path.basename(file)} is not a schemaVersion ${SUBSYSTEMS_SCHEMA_VERSION} subsystem manifest`,
    );
  return manifest;
}

/**
 * Atomic and idempotent: the bytes land in a sibling temp file and are renamed
 * over the target, so a reader never sees a torn manifest and a re-run of the
 * same derivation produces no diff of its own.
 */
export async function writeSubsystemsManifest(
  file: string,
  manifest: SubsystemsManifest,
): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  try {
    await writeFile(temp, serializeSubsystemsManifest(manifest));
    await rename(temp, file);
  } catch (error) {
    // See packages/cli/test/subsystems.test.ts › "removes its temp file and
    // rethrows when the rename is refused".
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * What `upgrade` re-runs: the same derivation from the recorded root, the same
 * handshake, and a rewrite only when the handshake is ok. A manifest that is
 * absent is left absent (`setup` is the one writer that creates it); one whose
 * executable no longer answers is left untouched and the result says why.
 */
export async function refreshSubsystems(options: {
  file: string;
  run: Runner;
  nodeExecutable: string;
  platform: NodeJS.Platform;
}): Promise<'absent' | 'refreshed' | Exclude<HandshakeResult, { status: 'ok' }>> {
  const manifest = await readSubsystemsManifest(options.file);
  if (manifest === null) return 'absent';
  const previous = manifest.entries.memory;
  let entry: MemoryEntry;
  try {
    entry = deriveMemoryEntry(
      {
        memoryRoot: previous.memoryRoot,
        nodeExecutable: options.nodeExecutable,
        memoryRef: previous.memoryRef,
        installedVersion: previous.installedVersion,
      },
      options.platform,
    );
  } catch (error) {
    if (error instanceof SubsystemsError && error.code === 'memory-executable-absent')
      return { status: 'unsupported', reason: 'absent' };
    throw error;
  }
  const result = await handshake(entry, options.run);
  if (result.status !== 'ok') return result;
  await writeSubsystemsManifest(options.file, {
    schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
    entries: { memory: { ...entry, installedVersion: result.version } },
  });
  return 'refreshed';
}
