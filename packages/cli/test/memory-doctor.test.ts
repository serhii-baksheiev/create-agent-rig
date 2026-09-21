import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectMemory } from '../src/integrations/memory-doctor.js';
import type { ProviderProcessOptions, ProviderProcessResult } from '../src/integrations/spawn.js';
import {
  MEMORY_CONTRACT_MAJOR,
  SUBSYSTEMS_SCHEMA_VERSION,
  subsystemsManifestPath,
  writeSubsystemsManifest,
} from '../src/lib/subsystems.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

let repo: string;
let home: string;
const host = process.platform;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-memory-doctor-repo-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-memory-doctor-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

const envFor = (): NodeJS.ProcessEnv => ({ HOME: home, APPDATA: home });
const privateMemoryRoot = () => path.join(home, 'private-memory-provider-data');
const memoryScript = () => path.join(privateMemoryRoot(), 'shared-memory', 'memory.mjs');

const processResult = (
  status: ProviderProcessResult['status'],
  exitCode: number | null,
  stdout = '',
  stderr = '',
): ProviderProcessResult => ({ status, exitCode, stdout, stderr });

function scriptedRunner(results: ProviderProcessResult[]) {
  const calls: ProviderProcessOptions[] = [];
  const pending = [...results];
  const runner: typeof import('../src/integrations/spawn.js').runProviderProcess = async (
    request,
  ) => {
    calls.push({ ...request, args: [...request.args] });
    const result = pending.shift();
    if (result === undefined) throw new Error('memory doctor runner was called unexpectedly');
    return result;
  };
  return { runner, calls };
}

const compatibleHandshake = (): ProviderProcessResult =>
  processResult(
    'ok',
    0,
    `${JSON.stringify({
      schemaVersion: 1,
      name: 'memory',
      version: '0.1.0',
      contractVersion: '1.0',
    })}\n`,
  );

function doctorPayload(status: 'ok' | 'warn' | 'fail', checkStatus = status): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    status,
    checks: [
      {
        id: 'memory-boundary',
        status: checkStatus,
        detail: 'private-doctor-detail-sentinel',
        fix: 'private-doctor-fix-sentinel',
      },
    ],
  })}\n`;
}

const foreignHandshake = (): ProviderProcessResult =>
  processResult(
    'ok',
    0,
    `${JSON.stringify({
      schemaVersion: 1,
      name: 'memory',
      version: '2.0.0',
      contractVersion: '2.0',
    })}\n`,
  );

async function writeMachineManifest(): Promise<void> {
  await writeSubsystemsManifest(subsystemsManifestPath(envFor(), host), {
    schemaVersion: SUBSYSTEMS_SCHEMA_VERSION,
    entries: {
      memory: {
        memoryRoot: privateMemoryRoot(),
        invocation: [process.execPath, memoryScript()],
        contractMajor: MEMORY_CONTRACT_MAJOR,
        memoryRef: null,
        installedVersion: '0.1.0',
      },
    },
  });
}

describe('Memory doctor integration inspection', () => {
  it('passes an absent optional machine subsystem without running a provider command', async () => {
    const { runner, calls } = scriptedRunner([]);

    const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

    expect(result).toMatchObject({
      status: 'pass',
      reason: 'not-configured',
      runtime: 'unverified',
      contract: 'unverified',
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['oversized', 'x'.repeat(1024 * 1024)],
    ['malformed', '{"entries": private-machine-manifest-sentinel'],
  ])(
    'fails a %s machine manifest without echoing its private bytes or running Memory',
    async (_case, text) => {
      const file = subsystemsManifestPath(envFor(), host);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      const { runner, calls } = scriptedRunner([]);

      const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

      expect(result).toMatchObject({
        status: 'fail',
        runtime: 'unverified',
        contract: 'unverified',
      });
      expect(JSON.stringify(result)).not.toContain('private-machine-manifest-sentinel');
      expect(calls).toEqual([]);
    },
  );

  it('fails a foreign contract before running Memory doctor', async () => {
    await writeMachineManifest();
    const { runner, calls } = scriptedRunner([foreignHandshake()]);

    const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

    expect(result).toMatchObject({
      status: 'fail',
      reason: 'foreign-contract',
      runtime: 'unverified',
      contract: 'foreign',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: process.execPath,
      args: [memoryScript(), '--version', '--json'],
      repoDir: repo,
    });
  });

  it.each([
    ['pass', processResult('ok', 0, doctorPayload('ok'), 'private-doctor-stderr')],
    ['fail', processResult('failed', 23, 'private-doctor-stdout', 'private-doctor-stderr')],
  ] as const)(
    'classifies a compatible Memory doctor %s result by process outcome without forwarding provider text',
    async (expectedStatus, doctorResult) => {
      await writeMachineManifest();
      const { runner, calls } = scriptedRunner([compatibleHandshake(), doctorResult]);

      const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

      expect(result).toMatchObject({
        status: expectedStatus,
        runtime: 'verified',
        contract: 'compatible',
      });
      expect(JSON.stringify(result)).not.toContain('private-doctor-stdout');
      expect(JSON.stringify(result)).not.toContain('private-doctor-stderr');
      expect(JSON.stringify(result)).not.toContain('private-doctor-detail-sentinel');
      expect(JSON.stringify(result)).not.toContain('private-doctor-fix-sentinel');
      expect(JSON.stringify(result)).not.toContain(privateMemoryRoot());
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        executable: process.execPath,
        args: [memoryScript(), 'doctor', '--json'],
        repoDir: repo,
      });
    },
  );

  it.each([
    ['malformed JSON', 'private-doctor-stdout', 'doctor-invalid'],
    [
      'schema-invalid JSON',
      JSON.stringify({ schemaVersion: 1, status: 'ok', checks: [{ id: 'only-id' }] }),
      'doctor-invalid',
    ],
    ['inconsistent aggregate status', doctorPayload('ok', 'warn'), 'doctor-invalid'],
  ] as const)(
    'fails an exit-zero %s result without forwarding private provider text',
    async (_case, stdout, reason) => {
      await writeMachineManifest();
      const { runner } = scriptedRunner([
        compatibleHandshake(),
        processResult('ok', 0, stdout, 'private-doctor-stderr'),
      ]);

      const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

      expect(result).toMatchObject({
        status: 'fail',
        reason,
        runtime: 'unverified',
        contract: 'compatible',
      });
      expect(JSON.stringify(result)).not.toContain('private-doctor-stdout');
      expect(JSON.stringify(result)).not.toContain('private-doctor-stderr');
    },
  );

  it('warns for an authoritative warning result without forwarding child details', async () => {
    await writeMachineManifest();
    const { runner } = scriptedRunner([
      compatibleHandshake(),
      processResult('ok', 0, doctorPayload('warn'), 'private-doctor-stderr'),
    ]);

    const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

    expect(result).toMatchObject({
      status: 'warn',
      reason: 'doctor-warn',
      runtime: 'verified',
      contract: 'compatible',
    });
    expect(JSON.stringify(result)).not.toContain('private-doctor-detail-sentinel');
    expect(JSON.stringify(result)).not.toContain('private-doctor-fix-sentinel');
  });

  it.each([
    ['timeout', processResult('timeout', null), 'doctor-timeout'],
    [
      'unconfirmed cleanup',
      processResult('cleanup-unconfirmed', null),
      'doctor-cleanup-unconfirmed',
    ],
  ] as const)('fails a compatible Memory doctor after %s', async (_case, doctorResult, reason) => {
    await writeMachineManifest();
    const { runner } = scriptedRunner([compatibleHandshake(), doctorResult]);

    const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

    expect(result).toMatchObject({
      status: 'fail',
      reason,
      runtime: 'unverified',
      contract: 'compatible',
    });
  });

  it('warns when the recorded executable is absent and leaves runtime unverified', async () => {
    await writeMachineManifest();
    const { runner } = scriptedRunner([compatibleHandshake(), processResult('failed', null)]);

    const result = await inspectMemory({ repoDir: repo, env: envFor(), runner });

    expect(result).toMatchObject({
      status: 'warn',
      reason: 'executable-missing',
      runtime: 'unverified',
      contract: 'compatible',
    });
  });
});
