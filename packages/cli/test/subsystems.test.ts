import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMORY_CONTRACT_MAJOR,
  SUBSYSTEMS_SCHEMA_VERSION,
  SubsystemsError,
  deriveMemoryEntry,
  handshake,
  parseSubsystemsManifest,
  readSubsystemsManifest,
  refreshSubsystems,
  subsystemsManifestPath,
  writeSubsystemsManifest,
} from '../src/lib/subsystems.js';
import type { HandshakeResult, MemoryEntry, SubsystemsManifest } from '../src/lib/subsystems.js';
// Namespace import so a still-missing `memoryInvocation` export fails inside
// the assertion (readable) rather than at module load (which would blank out
// every other test in this file).
import * as subsystemsModule from '../src/lib/subsystems.js';

/**
 * The injected process runner: `(file, args, { timeoutMs }) => Promise<{ code, stdout, stderr, spawnError? }>`.
 * Hand-written fake, no mocking framework (node-ts.md).
 */
type RunCall = { file: string; args: string[]; timeoutMs?: number };
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

function okRun(version = '0.1.0'): Runner & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = (async (file: string, args: string[], options?: { timeoutMs?: number }) => {
    calls.push({ file, args, timeoutMs: options?.timeoutMs });
    return {
      code: 0,
      stdout: `${JSON.stringify({
        schemaVersion: 1,
        name: 'memory',
        version,
        contractVersion: '1.0',
      })}\n`,
      stderr: '',
    };
  }) as Runner & { calls: RunCall[] };
  run.calls = calls;
  return run;
}

function scriptedRun(result: RunResult): Runner & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = (async (file: string, args: string[], options?: { timeoutMs?: number }) => {
    calls.push({ file, args, timeoutMs: options?.timeoutMs });
    return result;
  }) as Runner & { calls: RunCall[] };
  run.calls = calls;
  return run;
}

// The host this suite actually runs on. A real mkdtemp root is a host path
// (backslashes + a drive letter on win32, forward slashes on posix), so any
// test that hands one to deriveMemoryEntry/refreshSubsystems/setupSubsystems
// must judge its absoluteness against THIS platform, not a hardcoded one.
const HOST = process.platform;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'caf-subsystems-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A memoryRoot with the one executable `deriveMemoryEntry` requires. */
async function memoryRootWithExecutable(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'caf-memory-root-'));
  await mkdir(path.join(root, 'shared-memory'), { recursive: true });
  await writeFile(path.join(root, 'shared-memory', 'memory.mjs'), '// fake memory entrypoint\n');
  return root;
}

describe('the machine subsystem manifest (RP-147)', () => {
  describe('subsystemsManifestPath', () => {
    it('resolves exactly one manifest location per platform and refuses to guess when the root is unset', () => {
      expect(subsystemsManifestPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toBe(
        path.join('C:\\Users\\u\\AppData\\Roaming', 'create-agent-rig', 'subsystems.json'),
      );
      expect(subsystemsManifestPath({ HOME: '/home/u' }, 'linux')).toBe(
        path.join('/home/u', '.config', 'create-agent-rig', 'subsystems.json'),
      );

      expect(() => subsystemsManifestPath({}, 'win32')).toThrow(SubsystemsError);
      let winCodeError: unknown;
      try {
        subsystemsManifestPath({}, 'win32');
      } catch (error) {
        winCodeError = error;
      }
      expect(winCodeError).toBeInstanceOf(SubsystemsError);
      expect((winCodeError as SubsystemsError).code).toBe('config-root-unavailable');

      expect(() => subsystemsManifestPath({}, 'linux')).toThrow(SubsystemsError);

      // No fallback chain: HOME set but APPDATA absent still refuses on win32,
      // and APPDATA set but HOME absent still refuses on linux.
      expect(() => subsystemsManifestPath({ HOME: '/home/u' }, 'win32')).toThrow(SubsystemsError);
      expect(() =>
        subsystemsManifestPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'linux'),
      ).toThrow(SubsystemsError);
    });
  });

  describe('deriveMemoryEntry', () => {
    it('derives the Memory invocation from the one declared root and nothing else', async () => {
      const memoryRoot = await memoryRootWithExecutable();
      const entry = deriveMemoryEntry(
        {
          memoryRoot,
          nodeExecutable: '/usr/bin/node',
          memoryRef: 'abc123',
          installedVersion: '0.1.0',
        },
        HOST, // memoryRoot is a real mkdtemp path — judge it against the actual host.
      );

      expect(entry.invocation).toEqual([
        '/usr/bin/node',
        path.join(memoryRoot, 'shared-memory', 'memory.mjs'),
      ]);
      expect(entry.contractMajor).toBe(1);
      expect(path.isAbsolute(entry.memoryRoot)).toBe(true);
      expect(entry.memoryRoot).toBe(memoryRoot);
      expect(entry.memoryRef).toBe('abc123');
      expect(entry.installedVersion).toBe('0.1.0');
    });

    it('refuses a relative memoryRoot', () => {
      expect(() =>
        deriveMemoryEntry(
          {
            memoryRoot: 'rel/dir',
            nodeExecutable: '/usr/bin/node',
            memoryRef: null,
            installedVersion: '0.1.0',
          },
          'linux',
        ),
      ).toThrow(SubsystemsError);
      let relativeError: unknown;
      try {
        deriveMemoryEntry(
          {
            memoryRoot: 'rel/dir',
            nodeExecutable: '/usr/bin/node',
            memoryRef: null,
            installedVersion: '0.1.0',
          },
          'linux',
        );
      } catch (error) {
        relativeError = error;
      }
      expect((relativeError as SubsystemsError).code).toBe('memory-root-relative');
    });

    it('refuses a root without shared-memory/memory.mjs', async () => {
      const emptyRoot = await mkdtemp(path.join(tmpdir(), 'caf-memory-empty-'));
      let absentError: unknown;
      try {
        deriveMemoryEntry(
          {
            memoryRoot: emptyRoot,
            nodeExecutable: '/usr/bin/node',
            memoryRef: null,
            installedVersion: '0.1.0',
          },
          HOST, // emptyRoot is a real mkdtemp path — judge it against the actual host.
        );
      } catch (error) {
        absentError = error;
      }
      expect(absentError).toBeInstanceOf(SubsystemsError);
      expect((absentError as SubsystemsError).code).toBe('memory-executable-absent');
    });
  });

  describe('memoryInvocation pins the invocation encoding per platform', () => {
    it('derives a Windows invocation with backslashes and a drive root, on any host', () => {
      expect(subsystemsModule.memoryInvocation).toBeTypeOf('function');
      const invocation = subsystemsModule.memoryInvocation(
        {
          memoryRoot: 'C:\\Users\\u\\claude-config',
          nodeExecutable: 'C:\\nvm4w\\nodejs\\node.exe',
        },
        'win32',
      );
      expect(invocation).toEqual([
        'C:\\nvm4w\\nodejs\\node.exe',
        'C:\\Users\\u\\claude-config\\shared-memory\\memory.mjs',
      ]);
    });

    it('derives a POSIX invocation with forward slashes, on any host', () => {
      expect(subsystemsModule.memoryInvocation).toBeTypeOf('function');
      const invocation = subsystemsModule.memoryInvocation(
        { memoryRoot: '/home/u/claude-config', nodeExecutable: '/usr/bin/node' },
        'linux',
      );
      expect(invocation).toEqual([
        '/usr/bin/node',
        '/home/u/claude-config/shared-memory/memory.mjs',
      ]);
    });

    it('refuses a root that is not absolute under the declared platform', () => {
      expect(subsystemsModule.memoryInvocation).toBeTypeOf('function');

      expect(() =>
        subsystemsModule.memoryInvocation(
          { memoryRoot: 'rel\\dir', nodeExecutable: 'C:\\nvm4w\\nodejs\\node.exe' },
          'win32',
        ),
      ).toThrow(SubsystemsError);

      expect(() =>
        subsystemsModule.memoryInvocation(
          { memoryRoot: 'rel/dir', nodeExecutable: '/usr/bin/node' },
          'linux',
        ),
      ).toThrow(SubsystemsError);

      // A drive-letter path is not POSIX-absolute: it must be refused when the
      // declared platform is not win32, even though it looks "absolute" to a
      // human.
      expect(() =>
        subsystemsModule.memoryInvocation(
          { memoryRoot: 'C:\\x', nodeExecutable: '/usr/bin/node' },
          'linux',
        ),
      ).toThrow(SubsystemsError);

      let code: unknown;
      try {
        subsystemsModule.memoryInvocation(
          { memoryRoot: 'rel/dir', nodeExecutable: '/usr/bin/node' },
          'linux',
        );
      } catch (error) {
        code = (error as SubsystemsError).code;
      }
      expect(code).toBe('memory-root-relative');
    });
  });

  describe('handshake', () => {
    const entryFor = (invocation: [string, string]): Pick<MemoryEntry, 'invocation'> => ({
      invocation,
    });

    it('classifies an ok handshake and reports version + contractVersion', async () => {
      const run = okRun('0.1.0');
      const result = await handshake(
        entryFor(['/usr/bin/node', '/root/shared-memory/memory.mjs']),
        run,
      );
      expect(result).toEqual({ status: 'ok', version: '0.1.0', contractVersion: '1.0' });
    });

    it('classifies a foreign major contract version', async () => {
      const run = scriptedRun({
        code: 0,
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          name: 'memory',
          version: '2.0.0',
          contractVersion: '2.0',
        })}\n`,
        stderr: '',
      });
      const result = await handshake(
        entryFor(['/usr/bin/node', '/root/shared-memory/memory.mjs']),
        run,
      );
      expect(result).toEqual({ status: 'foreign-major', contractVersion: '2.0', requiredMajor: 1 });
    });

    it('classifies an explicit integration-failed payload as invalid', async () => {
      const run = scriptedRun({
        code: 1,
        stdout: `${JSON.stringify({ schemaVersion: 1, result: 'integration-failed', reason: 'invalid' })}\n`,
        stderr: '',
      });
      const result = await handshake(
        entryFor(['/usr/bin/node', '/root/shared-memory/memory.mjs']),
        run,
      );
      expect(result).toEqual({ status: 'integration-failed', reason: 'invalid' });
    });

    it('classifies non-JSON stdout as an invalid payload', async () => {
      const run = scriptedRun({ code: 0, stdout: 'not json', stderr: '' });
      const result = await handshake(
        entryFor(['/usr/bin/node', '/root/shared-memory/memory.mjs']),
        run,
      );
      expect(result).toEqual({ status: 'integration-failed', reason: 'invalid-payload' });
    });

    it('classifies a payload naming a different subsystem as manifest-stale', async () => {
      const run = scriptedRun({
        code: 0,
        stdout: `${JSON.stringify({ schemaVersion: 1, name: 'other', version: '1', contractVersion: '1.0' })}\n`,
        stderr: '',
      });
      const result = await handshake(
        entryFor(['/usr/bin/node', '/root/shared-memory/memory.mjs']),
        run,
      );
      expect(result).toEqual({ status: 'integration-failed', reason: 'manifest-stale' });
    });

    it('classifies an ENOENT spawn as unsupported/absent', async () => {
      const spawnError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      const run = scriptedRun({
        code: -1,
        stdout: '',
        stderr: '',
        spawnError: spawnError as NodeJS.ErrnoException,
      });
      const result = await handshake(
        entryFor(['/usr/bin/node', '/root/shared-memory/memory.mjs']),
        run,
      );
      expect(result).toEqual({ status: 'unsupported', reason: 'absent' });
    });

    it('invokes run with the invocation split into file and leading args', async () => {
      const run = okRun('0.1.0');
      const invocation: [string, string] = ['/usr/bin/node', '/root/shared-memory/memory.mjs'];
      await handshake(entryFor(invocation), run);

      expect(run.calls).toHaveLength(1);
      const call = run.calls[0]!;
      expect(call.file).toBe(invocation[0]);
      expect(call.args[0]).toBe(invocation[1]);
      expect(call.args.slice(1)).toEqual(['--version', '--json']);
    });

    it('never names a path in the classified result, for any handshake outcome', async () => {
      const memoryRoot = path.join('C', 'secret', 'memory-root');
      const invocation: [string, string] = [
        '/usr/bin/node',
        path.join(memoryRoot, 'shared-memory', 'memory.mjs'),
      ];
      const outcomes: Runner[] = [
        okRun('0.1.0'),
        scriptedRun({
          code: 0,
          stdout: `${JSON.stringify({ schemaVersion: 1, name: 'memory', version: '1', contractVersion: '2.0' })}\n`,
          stderr: '',
        }),
        scriptedRun({ code: 1, stdout: 'garbage', stderr: '' }),
        scriptedRun({
          code: 0,
          stdout: `${JSON.stringify({ schemaVersion: 1, name: 'other', version: '1', contractVersion: '1.0' })}\n`,
          stderr: '',
        }),
        scriptedRun({
          code: -1,
          stdout: '',
          stderr: '',
          spawnError: Object.assign(new Error('spawn ENOENT'), {
            code: 'ENOENT',
          }) as NodeJS.ErrnoException,
        }),
      ];

      for (const run of outcomes) {
        const result: HandshakeResult = await handshake(entryFor(invocation), run);
        const serialised = JSON.stringify(result);
        expect(serialised).not.toContain(memoryRoot);
        expect(serialised).not.toContain('memory.mjs');
      }
    });
  });

  describe('writeSubsystemsManifest / readSubsystemsManifest / parseSubsystemsManifest', () => {
    const manifestFor = (memoryRoot: string, invocation: [string, string]): SubsystemsManifest => ({
      schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
      entries: {
        memory: {
          memoryRoot,
          invocation,
          contractMajor: MEMORY_CONTRACT_MAJOR,
          memoryRef: 'abc123',
          installedVersion: '0.1.0',
        },
      },
    });

    it('writes the manifest atomically and idempotently', async () => {
      const file = path.join(tmp, 'nested', 'subsystems.json');
      const manifest = manifestFor(path.join(tmp, 'memory-root'), [
        '/usr/bin/node',
        path.join(tmp, 'memory-root', 'shared-memory', 'memory.mjs'),
      ]);

      await writeSubsystemsManifest(file, manifest);
      const first = await readFile(file, 'utf8');

      await writeSubsystemsManifest(file, manifest);
      const second = await readFile(file, 'utf8');

      expect(first).toBe(second);
      expect(first.endsWith('\n')).toBe(true);
      expect(JSON.parse(first)).toEqual(manifest);

      const entries = await readdir(path.dirname(file));
      expect(entries).toEqual(['subsystems.json']);
    });

    it('reads back what it wrote', async () => {
      const file = path.join(tmp, 'subsystems.json');
      const manifest = manifestFor(path.join(tmp, 'memory-root'), [
        '/usr/bin/node',
        path.join(tmp, 'memory-root', 'shared-memory', 'memory.mjs'),
      ]);
      await writeSubsystemsManifest(file, manifest);
      expect(await readSubsystemsManifest(file)).toEqual(manifest);
    });

    it('returns null for an absent manifest', async () => {
      const file = path.join(tmp, 'absent', 'subsystems.json');
      expect(await readSubsystemsManifest(file)).toBeNull();
    });

    it('refuses a manifest it cannot parse', async () => {
      const file = path.join(tmp, 'broken.json');
      await writeFile(file, '{');
      await expect(readSubsystemsManifest(file)).rejects.toBeInstanceOf(SubsystemsError);
      await expect(readSubsystemsManifest(file)).rejects.toMatchObject({
        code: 'manifest-unreadable',
      });
    });

    it('refuses a manifest with a foreign schema version instead of accepting it silently', async () => {
      const file = path.join(tmp, 'foreign-schema.json');
      await writeFile(
        file,
        `${JSON.stringify({
          schemaVersion: 2,
          entries: {
            memory: {
              memoryRoot: path.join(tmp, 'memory-root'),
              invocation: [
                '/usr/bin/node',
                path.join(tmp, 'memory-root', 'shared-memory', 'memory.mjs'),
              ],
              contractMajor: 1,
              memoryRef: null,
              installedVersion: '0.1.0',
            },
          },
        })}\n`,
      );
      await expect(readSubsystemsManifest(file)).rejects.toBeInstanceOf(SubsystemsError);
      await expect(readSubsystemsManifest(file)).rejects.toMatchObject({
        code: 'manifest-unreadable',
      });
    });

    it('parses valid text and returns null for text with no recognisable shape, without throwing', () => {
      const manifest = manifestFor(path.join(tmp, 'memory-root'), [
        '/usr/bin/node',
        path.join(tmp, 'memory-root', 'shared-memory', 'memory.mjs'),
      ]);
      expect(parseSubsystemsManifest(JSON.stringify(manifest))).toEqual(manifest);
      expect(parseSubsystemsManifest('{ not json')).toBeNull();
      expect(parseSubsystemsManifest(JSON.stringify({ schemaVersion: 1 }))).toBeNull();
    });
  });

  describe('refreshSubsystems', () => {
    it('refreshes an existing manifest from its recorded root', async () => {
      const memoryRoot = await memoryRootWithExecutable();
      const file = path.join(tmp, 'subsystems.json');
      const stale: SubsystemsManifest = {
        schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
        entries: {
          memory: {
            memoryRoot,
            invocation: ['/usr/bin/node', path.join(memoryRoot, 'shared-memory', 'memory.mjs')],
            contractMajor: MEMORY_CONTRACT_MAJOR,
            memoryRef: 'abc123',
            installedVersion: '0.0.9',
          },
        },
      };
      await writeSubsystemsManifest(file, stale);

      const run = okRun('0.1.0');
      const outcome = await refreshSubsystems({
        file,
        run,
        nodeExecutable: '/usr/bin/node',
        // memoryRoot (recorded in `stale`) is a real mkdtemp path.
        platform: HOST,
      });

      expect(outcome).toBe('refreshed');
      const updated = await readSubsystemsManifest(file);
      expect(updated?.entries.memory.installedVersion).toBe('0.1.0');
    });

    it('reports absent and writes nothing when there is no manifest to refresh', async () => {
      const file = path.join(tmp, 'no-such', 'subsystems.json');
      const run = okRun('0.1.0');
      const outcome = await refreshSubsystems({
        file,
        run,
        nodeExecutable: '/usr/bin/node',
        platform: 'linux',
      });

      expect(outcome).toBe('absent');
      expect(run.calls).toHaveLength(0);
      await expect(readFile(file, 'utf8')).rejects.toThrow();
    });

    it('leaves the manifest untouched on a foreign-major handshake', async () => {
      const memoryRoot = await memoryRootWithExecutable();
      const file = path.join(tmp, 'subsystems.json');
      const original: SubsystemsManifest = {
        schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
        entries: {
          memory: {
            memoryRoot,
            invocation: ['/usr/bin/node', path.join(memoryRoot, 'shared-memory', 'memory.mjs')],
            contractMajor: MEMORY_CONTRACT_MAJOR,
            memoryRef: 'abc123',
            installedVersion: '0.0.9',
          },
        },
      };
      await writeSubsystemsManifest(file, original);
      const beforeBytes = await readFile(file, 'utf8');

      const run = scriptedRun({
        code: 0,
        stdout: `${JSON.stringify({ schemaVersion: 1, name: 'memory', version: '2.0.0', contractVersion: '2.0' })}\n`,
        stderr: '',
      });
      const outcome = await refreshSubsystems({
        file,
        run,
        nodeExecutable: '/usr/bin/node',
        // memoryRoot (recorded in `original`) is a real mkdtemp path.
        platform: HOST,
      });

      expect(outcome).toEqual({
        status: 'foreign-major',
        contractVersion: '2.0',
        requiredMajor: 1,
      });
      const afterBytes = await readFile(file, 'utf8');
      expect(afterBytes).toBe(beforeBytes);
    });
  });
});
