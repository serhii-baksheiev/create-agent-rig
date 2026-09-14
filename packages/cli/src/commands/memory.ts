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
// never `absent`), 3 for an unmet prerequisite (no configuration root: APPDATA
// or HOME unset), 4 for a foreign contract major. For 0, 1, 3 and 4 the stdout
// is exactly one JSON object with no file path in it; an invalid invocation
// (exit 2 — no verb, or one outside doctor/load) writes nothing to stdout and
// names the verbs on stderr; human hints always go to stderr.
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
/**
 * The outer deadline: the rig kills the Memory child after this many ms. It is
 * the consumer's bound, and it must never be the one that fires first — on
 * Windows a killed tree can outlive the kill by seconds, and a kill leaves no
 * JSON answer behind. So `load` always carries an INTERNAL deadline as well
 * (RP-183): Memory's own `--timeout-ms`, which it answers with a typed
 * `unverifiable`/`timeout` result. `doctor` accepts no such flag — its args are
 * never touched. Pinned in packages/cli/test/memory.test.ts, "RP-183".
 */
const VERB_TIMEOUT_MS = 60_000;
/** Memory's default internal deadline when the caller names none. */
const DEFAULT_MEMORY_TIMEOUT_MS = 45_000;
/** Headroom the outer deadline keeps above an explicit internal one. */
const OUTER_MARGIN_MS = 15_000;
const TIMEOUT_FLAG = '--timeout-ms';
/** Memory's own grammar for the value: a positive integer, milliseconds. */
const TIMEOUT_VALUE = /^[1-9][0-9]*$/;

/**
 * The verb's argument list and outer deadline. `load` with no `--timeout-ms`
 * gets the default appended; a caller-owned flag — any spelling — passes
 * through verbatim, and only a well-formed `--timeout-ms <value>` pair can
 * raise the outer deadline above it. Memory owns the refusal of a malformed
 * value, so the rig neither corrects nor drops one.
 */
const deadlinesFor = (
  verb: MemoryVerb,
  args: readonly string[],
): { args: string[]; timeoutMs: number } => {
  if (verb !== 'load') return { args: [...args], timeoutMs: VERB_TIMEOUT_MS };
  const at = args.findIndex((arg) => arg === TIMEOUT_FLAG || arg.startsWith(`${TIMEOUT_FLAG}=`));
  if (at === -1) {
    return {
      args: [...args, TIMEOUT_FLAG, String(DEFAULT_MEMORY_TIMEOUT_MS)],
      timeoutMs: VERB_TIMEOUT_MS,
    };
  }
  const value = args[at] === TIMEOUT_FLAG ? args[at + 1] : undefined;
  const internal = value !== undefined && TIMEOUT_VALUE.test(value) ? Number(value) : null;
  const timeoutMs =
    internal !== null && Number.isSafeInteger(internal)
      ? Math.max(VERB_TIMEOUT_MS, internal + OUTER_MARGIN_MS)
      : VERB_TIMEOUT_MS;
  return { args: [...args], timeoutMs };
};

export type MemoryOptions = {
  verb: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: Runner;
};

/**
 * One shape for every outcome: the rig's own status answers use 0, 1, 2, 3
 * and 4 as the header describes; a passthrough carries whatever exit code
 * Memory returned, so the field cannot be narrower than `number`.
 */
export type MemoryResult = { exitCode: number; stdout: string; stderr: string };

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
    if (error instanceof SubsystemsError && error.code === 'config-root-unavailable') {
      // Nothing was attempted: without a configuration root there is no place
      // the manifest could be. The contract's first exit-3 occasion — a
      // variable that is not set — with the variable named, never a path.
      const variable = platform === 'win32' ? 'APPDATA' : 'HOME';
      return {
        exitCode: 3,
        stdout: jsonLine({
          schemaVersion: 1,
          result: 'prerequisites-unmet',
          missing: [{ kind: 'environment', name: variable, detail: 'not set' }],
        }),
        stderr: `memory: ${variable} is not set, so there is no configuration root to read the subsystem manifest from\n`,
      };
    }
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
  const deadlines = deadlinesFor(options.verb, options.args);
  const answer = await run(command, [script, options.verb, ...deadlines.args], {
    timeoutMs: deadlines.timeoutMs,
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
