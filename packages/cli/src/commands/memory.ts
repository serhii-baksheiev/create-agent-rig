// `create-agent-rig memory <doctor|load> [args…]`: the Rig side of the
// RP-19 version handshake. The Rig is a CONSUMER of the Memory subsystem: it
// resolves the executable from the machine subsystem manifest `setup` wrote
// (RP-147), performs `--version --json` first, refuses a foreign contract
// major with exit 4 before doctor/load ever run, and otherwise hands the verb
// and its arguments to Memory verbatim and returns Memory's answer unchanged.
//
// What it never does, by construction: import Memory code, read Memory's
// storage tree, or reinterpret a doctor/load payload — the only Memory bytes
// it parses are the handshake's (`docs/command-contract.md`, "The version
// handshake"; "Storage-tree ownership"). Pinned in packages/cli/test/memory.test.ts.
//
// Exit codes on this surface follow the contract: 0 for UNSUPPORTED/absent
// (Memory is not registered here, or its executable is gone — the relocation
// case), 1 for INTEGRATION-FAILED (the executable answered, but not with a
// handshake the manifest promised — a broken VERSION is `manifest-stale`,
// never `absent`), 2 for an invalid invocation, 4 for a foreign contract
// major. In every one of those the stdout is exactly one JSON object with no
// file path in it; human hints go to stderr.
import { execFileRunner } from './setup.js';
import {
  MEMORY_CONTRACT_MAJOR,
  SubsystemsError,
  handshake,
  readSubsystemsManifest,
  subsystemsManifestPath,
} from '../lib/subsystems.js';
import type { Runner } from '../lib/subsystems.js';

const MEMORY_VERBS = ['doctor', 'load'] as const;
type MemoryVerb = (typeof MEMORY_VERBS)[number];
/** doctor/load do real work; the caller-supplied `--timeout-ms` is Memory's own bound. */
const VERB_TIMEOUT_MS = 60_000;

export type MemoryOptions = {
  verb: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: Runner;
};

export type MemoryResult =
  | { exitCode: 0 | 1 | 3; stdout: string; stderr: string }
  | { exitCode: 2; stdout: ''; stderr: string }
  | { exitCode: 4; stdout: string; stderr: string }
  | { exitCode: number; stdout: string; stderr: string };

const jsonLine = (payload: Record<string, unknown>): string => `${JSON.stringify(payload)}\n`;

const isVerb = (verb: string): verb is MemoryVerb =>
  (MEMORY_VERBS as readonly string[]).includes(verb);

export async function runMemory(options: MemoryOptions): Promise<MemoryResult> {
  if (!isVerb(options.verb)) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `memory needs a verb: create-agent-rig memory <${MEMORY_VERBS.join('|')}> [args…]\n`,
    };
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execFileRunner;

  let file: string;
  try {
    file = subsystemsManifestPath(env, platform);
  } catch (error) {
    if (error instanceof SubsystemsError)
      return {
        exitCode: 1,
        stdout: jsonLine({ schemaVersion: 1, result: 'integration-failed', reason: 'unreadable' }),
        stderr: `memory: ${error.message} (${error.code})\n`,
      };
    throw error;
  }
  let manifest;
  try {
    manifest = await readSubsystemsManifest(file);
  } catch (error) {
    if (error instanceof SubsystemsError)
      return {
        exitCode: 1,
        stdout: jsonLine({ schemaVersion: 1, result: 'integration-failed', reason: 'unreadable' }),
        stderr: `memory: the subsystem manifest is not readable (${error.code}); run setup --memory-root again\n`,
      };
    throw error;
  }
  if (manifest === null)
    return {
      exitCode: 0,
      stdout: jsonLine({ schemaVersion: 1, result: 'unsupported', reason: 'absent' }),
      stderr:
        'memory: Memory is not registered on this machine; run setup --memory-root <checkout>\n',
    };

  const entry = manifest.entries.memory;
  const result = await handshake(entry, run);
  if (result.status === 'foreign-major')
    return {
      exitCode: 4,
      stdout: jsonLine({
        schemaVersion: 1,
        result: 'foreign-major',
        contractVersion: result.contractVersion,
        requiredMajor: MEMORY_CONTRACT_MAJOR,
      }),
      stderr:
        `memory: the registered Memory implements contract ${result.contractVersion}, ` +
        `this rig requires major ${MEMORY_CONTRACT_MAJOR}; ${options.verb} was not run\n`,
    };
  if (result.status === 'unsupported')
    return {
      exitCode: 0,
      stdout: jsonLine({ schemaVersion: 1, result: 'unsupported', reason: 'absent' }),
      stderr:
        'memory: the registered Memory executable is no longer there; ' +
        'run setup --memory-root <checkout> again\n',
    };
  if (result.status === 'integration-failed')
    return {
      exitCode: 1,
      stdout: jsonLine({ schemaVersion: 1, result: 'integration-failed', reason: result.reason }),
      stderr: `memory: the handshake did not answer as the manifest promised (${result.reason}); ${options.verb} was not run\n`,
    };

  const [command, script] = entry.invocation;
  const answer = await run(command, [script, options.verb, ...options.args], {
    timeoutMs: VERB_TIMEOUT_MS,
  });
  if (answer.spawnError)
    return {
      exitCode: 1,
      stdout: jsonLine({
        schemaVersion: 1,
        result: 'integration-failed',
        reason: 'backend-failed',
      }),
      stderr: `memory: ${options.verb} could not be started (${answer.spawnError.code ?? 'spawn error'})\n`,
    };
  return { exitCode: answer.code, stdout: answer.stdout, stderr: answer.stderr };
}
