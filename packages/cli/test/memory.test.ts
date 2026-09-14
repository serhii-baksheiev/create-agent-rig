// `create-agent-rig memory <doctor|load> [args…]` (RP-19): the consumer path
// that forwards to Memory only after its own handshake agrees. Order is the
// contract, exactly as `setup.ts` pins it for the write path: verb validity,
// then the manifest gate, then the handshake, then — and only on an ok
// handshake — the verb itself. The caller's arguments pass through as written;
// the one addition is a default `--timeout-ms` on a `load` that names none
// (the RP-183 block below).
//
// The manifest is never read for its storage tree here: every fixture below
// names a `memoryRoot` no directory on disk backs, which is what proves this
// command never touches Memory's storage — it only ever spawns the recorded
// executable (`## Storage-tree ownership`, docs/command-contract.md).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMemory } from '../src/commands/memory.js';
import {
  MEMORY_CONTRACT_MAJOR,
  SUBSYSTEMS_SCHEMA_VERSION,
  subsystemsManifestPath,
  writeSubsystemsManifest,
} from '../src/lib/subsystems.js';
import type { SubsystemsManifest } from '../src/lib/subsystems.js';

/**
 * The injected process runner, same shape subsystems.ts pins:
 * `(file, args, { timeoutMs }) => Promise<{ code, stdout, stderr, spawnError? }>`.
 * Hand-written fake, no mocking framework (node-ts.md).
 */
type RunCall = { file: string; args: string[] };
type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
};
type Runner = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<RunResult>;

/** Answers each queued result in order; throws if called more times than scripted. */
function scriptedRuns(results: RunResult[]): Runner & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const queue = [...results];
  const run = (async (file: string, args: string[]) => {
    calls.push({ file, args });
    const result = queue.shift();
    if (!result) throw new Error('scriptedRuns: exhausted the scripted responses');
    return result;
  }) as Runner & { calls: RunCall[] };
  run.calls = calls;
  return run;
}

/** A runner that must never be invoked — see "Memory is not registered on this machine". */
function neverCalledRun(): Runner & { calls: RunCall[] } {
  return scriptedRuns([]);
}

const okHandshakeResult = (version = '0.1.0'): RunResult => ({
  code: 0,
  stdout: `${JSON.stringify({ schemaVersion: 1, name: 'memory', version, contractVersion: '1.0' })}\n`,
  stderr: '',
});

const foreignMajorResult = (): RunResult => ({
  code: 0,
  stdout: `${JSON.stringify({
    schemaVersion: 1,
    name: 'memory',
    version: '2.0.0',
    contractVersion: '2.0',
  })}\n`,
  stderr: '',
});

const enoentResult = (): RunResult => ({
  code: -1,
  stdout: '',
  stderr: '',
  spawnError: Object.assign(new Error('spawn ENOENT'), {
    code: 'ENOENT',
  }) as NodeJS.ErrnoException,
});

/** The pinned external contract's own shape for a broken VERSION file. */
const brokenVersionResult = (): RunResult => ({
  code: 1,
  stdout: `${JSON.stringify({ schemaVersion: 1, result: 'integration-failed', reason: 'invalid' })}\n`,
  stderr: '',
});

const nonJsonResult = (): RunResult => ({ code: 0, stdout: 'not json at all', stderr: '' });

const nameMismatchResult = (): RunResult => ({
  code: 0,
  stdout: `${JSON.stringify({
    schemaVersion: 1,
    name: 'other',
    version: '1',
    contractVersion: '1.0',
  })}\n`,
  stderr: '',
});

function manifestWith(
  invocation: [string, string],
  memoryRoot = '/opt/claude-config',
): SubsystemsManifest {
  return {
    schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
    entries: {
      memory: {
        memoryRoot,
        invocation,
        contractMajor: MEMORY_CONTRACT_MAJOR,
        memoryRef: null,
        installedVersion: '0.1.0',
      },
    },
  };
}

// The host this suite actually runs on — see setup.test.ts / subsystems.test.ts
// for the same convention: a real mkdtemp path is a host path, so any call that
// resolves it (subsystemsManifestPath here) must judge it against THIS host.
const HOST = process.platform;

const envFor = (dir: string): NodeJS.ProcessEnv => ({ HOME: dir, APPDATA: dir });

/**
 * The closed set of top-level keys a non-passthrough `runMemory` payload may
 * carry — shared by the "never names a path" property test below and the
 * exit-3/no-config-root cases, so the one check covers both without a second,
 * driftable copy of the list. `missing` is exit 3's own field (RP-19): the
 * variable name the manifest path could not resolve.
 */
const ALLOWED_PAYLOAD_KEYS = new Set([
  'schemaVersion',
  'result',
  'reason',
  'contractVersion',
  'requiredMajor',
  'missing',
]);

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'caf-memory-cmd-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('create-agent-rig memory <verb> (RP-19)', () => {
  describe('invocation validation — exit 2, nothing attempted', () => {
    it('refuses when no verb is given, and never touches the manifest or Memory', async () => {
      const run = neverCalledRun();

      const result = await runMemory({ verb: '', args: [], env: envFor(tmp), platform: HOST, run });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/doctor/);
      expect(result.stderr).toMatch(/load/);
      expect(run.calls).toHaveLength(0);
    });

    it('refuses a verb that is neither doctor nor load', async () => {
      const run = neverCalledRun();

      const result = await runMemory({
        verb: 'promote',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/doctor/);
      expect(result.stderr).toMatch(/load/);
      expect(run.calls).toHaveLength(0);
    });
  });

  describe('no config root — exit 3, nothing attempted (RP-19)', () => {
    it('answers prerequisites-unmet/APPDATA on win32 when APPDATA is not set, and never touches Memory', async () => {
      const run = neverCalledRun();

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: {},
        platform: 'win32',
        run,
      });

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'prerequisites-unmet', missing: [{ kind: 'environment', name: 'APPDATA', detail: 'not set' }] })}\n`,
      );
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(ALLOWED_PAYLOAD_KEYS.has(key), `unexpected key "${key}" in ${result.stdout}`).toBe(
          true,
        );
      }
      expect(result.stderr).toMatch(/APPDATA/);
      expect(run.calls).toHaveLength(0);
    });

    it('answers prerequisites-unmet/HOME on linux when HOME is not set, and never touches Memory', async () => {
      const run = neverCalledRun();

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: {},
        platform: 'linux',
        run,
      });

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'prerequisites-unmet', missing: [{ kind: 'environment', name: 'HOME', detail: 'not set' }] })}\n`,
      );
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(ALLOWED_PAYLOAD_KEYS.has(key), `unexpected key "${key}" in ${result.stdout}`).toBe(
          true,
        );
      }
      expect(result.stderr).toMatch(/HOME/);
      expect(run.calls).toHaveLength(0);
    });
  });

  describe('the manifest gate runs before any handshake', () => {
    it('reports unsupported/absent and never spawns Memory when this machine has no manifest', async () => {
      const run = neverCalledRun();

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'unsupported', reason: 'absent' })}\n`,
      );
      expect(run.calls).toHaveLength(0);
    });

    it('reports integration-failed/unreadable for a present, unparseable manifest, and never spawns Memory', async () => {
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '{"schemaVersion": 1, "entries": broken');
      const run = neverCalledRun();

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'integration-failed', reason: 'unreadable' })}\n`,
      );
      expect(run.calls).toHaveLength(0);
    });
  });

  describe('the handshake call, exactly', () => {
    it('calls run with the win32 invocation split into file and [script, --version, --json], backslashes unchanged', async () => {
      const invocation: [string, string] = [
        'C:\\Users\\x\\node.exe',
        'C:\\Users\\x\\claude-config\\shared-memory\\memory.mjs',
      ];
      const file = subsystemsManifestPath({ APPDATA: tmp }, 'win32');
      await writeSubsystemsManifest(file, manifestWith(invocation));
      const run = scriptedRuns([okHandshakeResult('0.1.0'), { code: 0, stdout: '{}', stderr: '' }]);

      await runMemory({
        verb: 'doctor',
        args: ['--json'],
        env: { APPDATA: tmp },
        platform: 'win32',
        run,
      });

      expect(run.calls[0]).toEqual({
        file: invocation[0],
        args: [invocation[1], '--version', '--json'],
      });
    });
  });

  describe('an ok handshake passes doctor/load through unchanged', () => {
    it('forwards the verb and a caller-owned argument list verbatim as the second call, and returns the answer byte-for-byte', async () => {
      const invocation: [string, string] = [
        '/usr/bin/node',
        '/opt/claude-config/shared-memory/memory.mjs',
      ];
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      // Deliberately not JSON and a non-zero code, to prove this is a
      // passthrough rather than a re-serialisation.
      const passthrough: RunResult = {
        code: 3,
        stdout: 'not json output at all',
        stderr: 'human-readable stderr from Memory',
      };
      const run = scriptedRuns([okHandshakeResult('0.1.0'), passthrough]);

      // The caller names its own `--timeout-ms`, so the one thing the rig adds
      // to a `load` (RP-183, below) is absent and the args stay verbatim.
      const result = await runMemory({
        verb: 'load',
        args: ['--json', '--budget', '4096', '--timeout-ms', '5000'],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(run.calls).toHaveLength(2);
      expect(run.calls[1]).toEqual({
        file: invocation[0],
        args: [invocation[1], 'load', '--json', '--budget', '4096', '--timeout-ms', '5000'],
      });
      expect(result).toEqual({
        exitCode: 3,
        stdout: 'not json output at all',
        stderr: 'human-readable stderr from Memory',
      });
    });
  });

  describe('RP-183: a consumer-owned internal timeout for `load`', () => {
    // The handshake call ignores `timeoutMs`, so these fixtures only need to
    // capture it on the second (verb) call to tell the outer deadline apart
    // from the injected `--timeout-ms` argument. Every run below is scripted;
    // nothing here invokes the real Memory.
    //
    // Per the Memory owner (RP-183, Jira): `--timeout-ms` is accepted by `load` only, as a
    // strict `--timeout-ms <value>` pair (never the `--timeout-ms=<value>`
    // spelling), the value must match `^[1-9][0-9]*$` (0 is refused, not just
    // negative or non-numeric), and at most one pair is accepted. Windows
    // process-tree termination may lag the internal deadline by up to
    // 10_000 ms, so the outer deadline must clear the internal one by at
    // least 15_000 ms.
    type CallWithOptions = { file: string; args: string[]; timeoutMs?: number };

    function scriptedRunsCapturingTimeout(
      results: RunResult[],
    ): Runner & { calls: CallWithOptions[] } {
      const calls: CallWithOptions[] = [];
      const queue = [...results];
      const run = (async (file: string, args: string[], options?: { timeoutMs?: number }) => {
        calls.push({ file, args, timeoutMs: options?.timeoutMs });
        const result = queue.shift();
        if (!result)
          throw new Error('scriptedRunsCapturingTimeout: exhausted the scripted responses');
        return result;
      }) as Runner & { calls: CallWithOptions[] };
      run.calls = calls;
      return run;
    }

    const invocation: [string, string] = [
      '/usr/bin/node',
      '/opt/claude-config/shared-memory/memory.mjs',
    ];

    async function runLoad(args: string[], run: Runner) {
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      return runMemory({ verb: 'load', args, env: envFor(tmp), platform: HOST, run });
    }

    it('injects the 45s default --timeout-ms for load when the caller supplied none, and keeps the outer runner deadline at 60s', async () => {
      const run = scriptedRunsCapturingTimeout([
        okHandshakeResult('0.1.0'),
        { code: 0, stdout: '{}', stderr: '' },
      ]);

      await runLoad(['--json', '--cwd', '.'], run);

      expect(run.calls).toHaveLength(2);
      expect(run.calls[1]?.args).toEqual([
        invocation[1],
        'load',
        '--json',
        '--cwd',
        '.',
        '--timeout-ms',
        '45000',
      ]);
      expect(run.calls[1]?.timeoutMs).toBe(60_000);
    });

    it('preserves an explicit "--timeout-ms 20000" unchanged, appending nothing, with the outer deadline still 60s', async () => {
      const run = scriptedRunsCapturingTimeout([
        okHandshakeResult('0.1.0'),
        { code: 0, stdout: '{}', stderr: '' },
      ]);

      await runLoad(['--json', '--cwd', '.', '--timeout-ms', '20000'], run);

      expect(run.calls[1]?.args).toEqual([
        invocation[1],
        'load',
        '--json',
        '--cwd',
        '.',
        '--timeout-ms',
        '20000',
      ]);
      expect(run.calls[1]?.timeoutMs).toBe(60_000);
    });

    it('raises the outer runner deadline so it stays ahead of an explicit --timeout-ms at or above 60s, by at least 15s', async () => {
      const run = scriptedRunsCapturingTimeout([
        okHandshakeResult('0.1.0'),
        { code: 0, stdout: '{}', stderr: '' },
      ]);

      await runLoad(['--json', '--cwd', '.', '--timeout-ms', '90000'], run);

      expect(run.calls[1]?.args).toEqual([
        invocation[1],
        'load',
        '--json',
        '--cwd',
        '.',
        '--timeout-ms',
        '90000',
      ]);
      expect(run.calls[1]?.timeoutMs ?? 0).toBeGreaterThanOrEqual(105_000);
    });

    it('caps the outer runner deadline at the largest delay a Node timer can hold, so an enormous --timeout-ms never turns the outer kill into a 1 ms kill', async () => {
      // Node clamps a setTimeout delay above 2^31-1 to ONE millisecond
      // (TimeoutOverflowWarning); an uncapped `N + 15_000` for a 25-day N
      // would make the outer kill fire before Memory even starts — the exact
      // inversion the internal deadline exists to prevent.
      const run = scriptedRunsCapturingTimeout([
        okHandshakeResult('0.1.0'),
        { code: 0, stdout: '{}', stderr: '' },
      ]);

      await runLoad(['--json', '--cwd', '.', '--timeout-ms', '3000000000'], run);

      expect(run.calls[1]?.args.slice(-2)).toEqual(['--timeout-ms', '3000000000']);
      expect(run.calls[1]?.timeoutMs).toBe(2_147_483_647);
    });

    it('caps the outer runner deadline the same way for a well-formed value beyond a safe integer, or beyond a double', async () => {
      for (const value of ['99999999999999999999', `1${'0'.repeat(400)}`]) {
        const run = scriptedRunsCapturingTimeout([
          okHandshakeResult('0.1.0'),
          { code: 0, stdout: '{}', stderr: '' },
        ]);

        await runLoad(['--json', '--cwd', '.', '--timeout-ms', value], run);

        expect(run.calls[1]?.args.slice(-2)).toEqual(['--timeout-ms', value]);
        expect(run.calls[1]?.timeoutMs).toBe(2_147_483_647);
      }
    });

    it('treats a --timeout-ms Rig cannot safely raise its own deadline for as caller-owned: non-representable values and the "=" spelling pass through verbatim, nothing is appended, and the outer deadline stays 60s', async () => {
      const cases: { label: string; extraArgs: string[] }[] = [
        { label: 'non-numeric value', extraArgs: ['--timeout-ms', 'abc'] },
        { label: 'negative value', extraArgs: ['--timeout-ms', '-5'] },
        { label: 'exponential-notation value', extraArgs: ['--timeout-ms', '1e3'] },
        { label: 'zero, explicitly refused by Memory', extraArgs: ['--timeout-ms', '0'] },
        {
          label: 'the "--timeout-ms=<value>" spelling, which Rig never parses a value out of',
          extraArgs: ['--timeout-ms=20000'],
        },
      ];
      for (const { label, extraArgs } of cases) {
        const run = scriptedRunsCapturingTimeout([
          okHandshakeResult('0.1.0'),
          { code: 0, stdout: '{}', stderr: '' },
        ]);

        await runLoad(['--json', '--cwd', '.', ...extraArgs], run);

        expect(run.calls[1]?.args, label).toEqual([
          invocation[1],
          'load',
          '--json',
          '--cwd',
          '.',
          ...extraArgs,
        ]);
        expect(run.calls[1]?.timeoutMs, label).toBe(60_000);
      }
    });

    it('never injects --timeout-ms for doctor, which Memory rejects with it present', async () => {
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      const run = scriptedRunsCapturingTimeout([
        okHandshakeResult('0.1.0'),
        { code: 0, stdout: '{}', stderr: '' },
      ]);

      await runMemory({ verb: 'doctor', args: ['--json'], env: envFor(tmp), platform: HOST, run });

      expect(run.calls[1]?.args).toEqual([invocation[1], 'doctor', '--json']);
      expect(run.calls[1]?.timeoutMs).toBe(60_000);
    });
  });

  describe('a foreign contract major refuses before doctor/load ever runs', () => {
    it('exits 4 with the foreign-major payload, and calls run exactly once', async () => {
      const invocation: [string, string] = [
        '/usr/bin/node',
        '/opt/claude-config/shared-memory/memory.mjs',
      ];
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      const run = scriptedRuns([foreignMajorResult()]);

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe(
        `${JSON.stringify({
          schemaVersion: 1,
          result: 'foreign-major',
          contractVersion: '2.0',
          requiredMajor: 1,
        })}\n`,
      );
      expect(run.calls).toHaveLength(1);
    });
  });

  describe('a relocated executable (spawn ENOENT)', () => {
    it('reports unsupported/absent, hints at setup --memory-root in stderr, and never names a path in stdout', async () => {
      const invocation: [string, string] = [
        '/usr/bin/node',
        '/opt/claude-config/shared-memory/memory.mjs',
      ];
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      const run = scriptedRuns([enoentResult()]);

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'unsupported', reason: 'absent' })}\n`,
      );
      expect(run.calls).toHaveLength(1);
      expect(result.stderr).toMatch(/setup --memory-root/);
      expect(result.stdout).not.toMatch(/opt|claude-config|memory\.mjs/);
    });
  });

  describe('a broken VERSION answers manifest-stale, never absent (RP-19)', () => {
    it('maps an exit-1 integration-failed handshake to manifest-stale', async () => {
      const invocation: [string, string] = [
        '/usr/bin/node',
        '/opt/claude-config/shared-memory/memory.mjs',
      ];
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      const run = scriptedRuns([brokenVersionResult()]);

      const result = await runMemory({
        verb: 'load',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'integration-failed', reason: 'manifest-stale' })}\n`,
      );
      expect(run.calls).toHaveLength(1);
    });
  });

  describe('a malformed handshake payload', () => {
    it('maps non-JSON handshake stdout to integration-failed/invalid-payload', async () => {
      const invocation: [string, string] = [
        '/usr/bin/node',
        '/opt/claude-config/shared-memory/memory.mjs',
      ];
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      const run = scriptedRuns([nonJsonResult()]);

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'integration-failed', reason: 'invalid-payload' })}\n`,
      );
      expect(run.calls).toHaveLength(1);
    });

    it('maps a handshake naming a different subsystem to integration-failed/manifest-stale', async () => {
      const invocation: [string, string] = [
        '/usr/bin/node',
        '/opt/claude-config/shared-memory/memory.mjs',
      ];
      const file = subsystemsManifestPath(envFor(tmp), HOST);
      await writeSubsystemsManifest(file, manifestWith(invocation));
      const run = scriptedRuns([nameMismatchResult()]);

      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'integration-failed', reason: 'manifest-stale' })}\n`,
      );
      expect(run.calls).toHaveLength(1);
    });
  });

  it('never names the memory root or executable path in a non-passthrough result, for any handshake outcome', async () => {
    const memoryRoot = path.join('C', 'secret', 'memory-root');
    const invocation: [string, string] = [
      '/usr/bin/node',
      path.join(memoryRoot, 'shared-memory', 'memory.mjs'),
    ];
    const file = subsystemsManifestPath(envFor(tmp), HOST);
    await writeSubsystemsManifest(file, manifestWith(invocation, memoryRoot));

    const outcomes: RunResult[] = [
      foreignMajorResult(),
      enoentResult(),
      brokenVersionResult(),
      nonJsonResult(),
      nameMismatchResult(),
    ];
    const allowedKeys = ALLOWED_PAYLOAD_KEYS;

    for (const outcome of outcomes) {
      const run = scriptedRuns([outcome]);
      const result = await runMemory({
        verb: 'doctor',
        args: [],
        env: envFor(tmp),
        platform: HOST,
        run,
      });
      expect(result.stdout).not.toContain(memoryRoot);
      expect(result.stdout).not.toContain('memory.mjs');
      // Exactly one JSON object plus a trailing newline, nothing else.
      expect(result.stdout).toMatch(/^\{.*\}\n$/);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(allowedKeys.has(key), `unexpected key "${key}" in ${result.stdout}`).toBe(true);
      }
    }
  });

  it('is wired into the CLI with a usage line', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain(`process.argv[2] === 'memory'`);
  });

  describe('RP-183: README documents a valid `memory load` invocation', () => {
    it('shows the required --cwd on every documented `memory load` example', async () => {
      const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');

      expect(readme).toContain('npx create-agent-rig@latest memory load --json --cwd .');

      const loadLines = readme.split('\n').filter((line) => line.includes('memory load'));
      expect(loadLines.length).toBeGreaterThan(0);
      for (const line of loadLines) {
        expect(line, `memory load example is missing --cwd: ${line}`).toContain('--cwd');
      }
    });
  });
});
