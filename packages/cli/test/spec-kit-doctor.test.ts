import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectSpecKit } from '../src/integrations/spec-kit.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import type { ProviderProcessOptions, ProviderProcessResult } from '../src/integrations/spawn.js';

let repo: string;
let machine: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rig-doctor-spec-'));
  machine = await mkdtemp(path.join(tmpdir(), 'rig-doctor-tools-'));
  const launcher = path.join(machine, process.platform === 'win32' ? 'uvx.exe' : 'uvx');
  await writeFile(launcher, 'fixture launcher, never executed');
  await chmod(launcher, 0o755);
});
afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(machine);
});
const answer = (status = 'ok'): ProviderProcessResult => ({
  status: 'ok',
  exitCode: 0,
  stderr: '',
  stdout: JSON.stringify({ status, installed_integrations: ['claude', 'codex'], findings: [] }),
});

it('diagnoses the intended harnesses using only pinned offline official status', async () => {
  const calls: ProviderProcessOptions[] = [];
  const result = await inspectSpecKit({
    repoDir: repo,
    harnesses: ['claude-code', 'codex'],
    env: { PATH: machine },
    runner: async (request) => {
      calls.push(request);
      return answer();
    },
  });
  expect(result).toMatchObject({
    status: 'pass',
    launcher: 'observed',
    runtime: 'verified',
    observed: { installedIntegrations: ['claude', 'codex'] },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    repoDir: repo,
    args: [
      '--offline',
      '--no-config',
      '--no-python-downloads',
      '--from',
      'git+https://github.com/github/spec-kit@v1.0.8',
      'specify',
      'integration',
      'status',
      '--json',
    ],
  });
});

it('reports a missing launcher as warning without starting an installation', async () => {
  let calls = 0;
  const result = await inspectSpecKit({
    repoDir: repo,
    harnesses: ['codex'],
    env: { PATH: '' },
    runner: async () => {
      calls++;
      return answer();
    },
  });
  expect(result).toMatchObject({ status: 'warn', launcher: 'missing', runtime: 'unverified' });
  expect(calls).toBe(0);
});

it('fails authoritative upstream errors and never copies arbitrary status text', async () => {
  const result = await inspectSpecKit({
    repoDir: repo,
    harnesses: ['codex'],
    env: { PATH: machine },
    runner: async () => ({
      ...answer('error'),
      status: 'failed',
      exitCode: 1,
      stderr: 'private-path-sentinel',
    }),
  });
  expect(result.status).toBe('fail');
  expect(JSON.stringify(result)).not.toContain('private-path-sentinel');
});

it('rejects unconfirmed process cleanup even when stdout looks healthy', async () => {
  const result = await inspectSpecKit({
    repoDir: repo,
    harnesses: ['codex'],
    env: { PATH: machine },
    runner: async () => ({ ...answer(), status: 'cleanup-unconfirmed' }),
  });
  expect(result).toMatchObject({ status: 'fail', reason: 'upstream-cleanup-unconfirmed' });
});
