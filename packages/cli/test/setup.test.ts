import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupSubsystems } from '../src/commands/setup.js';
import { subsystemsManifestPath } from '../src/lib/subsystems.js';

/**
 * The injected process runner, same shape `subsystems.test.ts` pins:
 * `(file, args, { timeoutMs }) => Promise<{ code, stdout, stderr, spawnError? }>`.
 * Hand-written fake, no mocking framework (node-ts.md).
 */
type RunCall = { file: string; args: string[]; timeoutMs?: number; fileExistedAtCallTime: boolean };
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

/** A fake `run` that also records, per call, whether `existingFile` exists yet. */
function okRun(version: string, existingFile: string): Runner & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = (async (file: string, args: string[], options?: { timeoutMs?: number }) => {
    calls.push({
      file,
      args,
      timeoutMs: options?.timeoutMs,
      fileExistedAtCallTime: existsSync(existingFile),
    });
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
    calls.push({ file, args, timeoutMs: options?.timeoutMs, fileExistedAtCallTime: false });
    return result;
  }) as Runner & { calls: RunCall[] };
  run.calls = calls;
  return run;
}

async function memoryRootWithExecutable(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'caf-setup-memory-root-'));
  await mkdir(path.join(root, 'shared-memory'), { recursive: true });
  await writeFile(path.join(root, 'shared-memory', 'memory.mjs'), '// fake memory entrypoint\n');
  return root;
}

let home: string;
let memoryRoot: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'caf-setup-home-'));
  memoryRoot = await memoryRootWithExecutable();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(memoryRoot, { recursive: true, force: true });
});

describe('create-agent-rig setup (RP-147)', () => {
  it('performs the handshake before writing and writes one Memory entry', async () => {
    const env = { HOME: home };
    const file = subsystemsManifestPath(env, 'linux');
    const run = okRun('0.1.0', file);

    const result = await setupSubsystems({
      memoryRoot,
      memoryRef: 'abc123',
      env,
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
      run,
    });

    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') throw new Error('narrowed above');
    expect(result.file).toBe(file);

    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written.schemaVersion).toBe(1);
    expect(written.entries.memory).toEqual({
      memoryRoot,
      invocation: ['/usr/bin/node', path.join(memoryRoot, 'shared-memory', 'memory.mjs')],
      contractMajor: 1,
      memoryRef: 'abc123',
      installedVersion: '0.1.0',
    });

    expect(run.calls).toHaveLength(1);
    // The handshake happened before the manifest was written.
    expect(run.calls[0]!.fileExistedAtCallTime).toBe(false);
  });

  it('refuses a foreign contract major with exit 4 and writes nothing', async () => {
    const env = { HOME: home };
    const file = subsystemsManifestPath(env, 'linux');
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

    const result = await setupSubsystems({
      memoryRoot,
      memoryRef: 'abc123',
      env,
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
      run,
    });

    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 4 });
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('maps an absent executable (ENOENT) to exit 1 and writes nothing', async () => {
    const env = { HOME: home };
    const file = subsystemsManifestPath(env, 'linux');
    const spawnError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const run = scriptedRun({
      code: -1,
      stdout: '',
      stderr: '',
      spawnError: spawnError as NodeJS.ErrnoException,
    });

    const result = await setupSubsystems({
      memoryRoot,
      memoryRef: 'abc123',
      env,
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
      run,
    });

    expect(result).toMatchObject({ outcome: 'refused', exitCode: 1 });
    if (result.outcome === 'refused') {
      expect(result.handshake.status).toBe('unsupported');
    }
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('maps an integration-failed handshake to exit 1 and writes nothing', async () => {
    const env = { HOME: home };
    const file = subsystemsManifestPath(env, 'linux');
    const run = scriptedRun({
      code: 1,
      stdout: `${JSON.stringify({ schemaVersion: 1, result: 'integration-failed', reason: 'invalid' })}\n`,
      stderr: '',
    });

    const result = await setupSubsystems({
      memoryRoot,
      memoryRef: 'abc123',
      env,
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
      run,
    });

    expect(result).toMatchObject({ outcome: 'refused', exitCode: 1 });
    if (result.outcome === 'refused') {
      expect(result.handshake.status).toBe('integration-failed');
    }
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('a dry run performs the handshake and writes nothing', async () => {
    const env = { HOME: home };
    const file = subsystemsManifestPath(env, 'linux');
    const run = okRun('0.1.0', file);

    const result = await setupSubsystems({
      memoryRoot,
      memoryRef: 'abc123',
      dryRun: true,
      env,
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
      run,
    });

    expect(result.outcome).toBe('dry-run');
    expect(run.calls).toHaveLength(1);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('is wired into the CLI with a usage line', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain(`process.argv[2] === 'setup'`);
    expect(source).toContain('setup --memory-root');
  });
});
