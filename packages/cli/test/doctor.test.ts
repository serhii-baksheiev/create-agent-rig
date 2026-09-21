import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { initProject } from '../src/commands/init.js';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

type Check = {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  reason?: string;
};

type Report = {
  schemaVersion: 1;
  status: 'ok' | 'warn' | 'fail';
  checks: Check[];
};

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-doctor-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

async function doctor(args = ['--json']) {
  return runDoctor({
    cwd: repo,
    args,
    env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
  });
}

function report(stdout: string): Report {
  return JSON.parse(stdout) as Report;
}

const hasFailure = (result: Report): boolean =>
  result.checks.some((check) => check.status === 'fail');

describe('aggregated doctor (RP-21)', () => {
  it('distinguishes owned wiring, missing launcher and unobserved runtime for both Basic Memory targets', async () => {
    await initProject(repo, {});
    expect(
      (
        await runIntegrationsCommand({
          cwd: repo,
          verb: 'add',
          args: ['basic-memory', '--harness', 'claude-code', '--harness', 'codex', '--yes'],
        })
      ).exitCode,
    ).toBe(0);
    const result = await runDoctor({
      cwd: repo,
      args: ['--json'],
      env: { HOME: home, APPDATA: home, PATH: '' },
    });
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe('warn');
    for (const harness of ['claude-code', 'codex'])
      expect(body.integrations[0].harnesses[harness]).toEqual({
        wiring: 'wired',
        launcher: 'missing',
        runtime: 'unverified',
        connectivity: 'not-observed',
        trust: 'not-observed',
      });
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'rig-owned-files',
        status: 'ok',
        reason: 'pristine',
      }),
    );
  });

  it('fails unreadable owned MCP configuration without exposing its contents', async () => {
    await initProject(repo, {});
    expect(
      (await runIntegrationsCommand({ cwd: repo, verb: 'add', args: ['figma-mcp', '--yes'] }))
        .exitCode,
    ).toBe(0);
    await writeFile(path.join(repo, '.mcp.json'), 'private-invalid-config');
    const result = await doctor();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain('private-invalid-config');
    expect(JSON.parse(result.stdout).integrations[0].harnesses['claude-code']).toMatchObject({
      wiring: 'unreadable',
      reason: 'invalid-config',
    });
  });
  it('reports a clean initialized Rig in the versioned check schema with no failed checks', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body).toMatchObject({ schemaVersion: 1 });
    expect(['ok', 'warn']).toContain(body.status);
    expect(Array.isArray(body.checks)).toBe(true);
    for (const check of body.checks) {
      expect(['ok', 'warn', 'fail']).toContain(check.status);
      expect(check).toMatchObject({
        id: expect.any(String),
        detail: expect.any(String),
        fix: expect.any(String),
      });
    }
    expect(hasFailure(body)).toBe(false);
  });

  it('treats an absent optional integrations declaration as non-failing', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.status).not.toBe('fail');
    expect(hasFailure(body)).toBe(false);
  });

  it('keeps declared Spec Kit on its authoritative upstream-status lane, not an MCP ownership check', async () => {
    await initProject(repo, {});
    const declaration = path.join(repo, '.rig', 'integrations.json');
    await mkdir(path.dirname(declaration), { recursive: true });
    await writeFile(
      declaration,
      `${JSON.stringify({
        schemaVersion: 1,
        integrations: [
          {
            id: 'spec-kit',
            version: '1.0.8',
            selected: true,
            harnesses: ['claude-code', 'codex'],
          },
        ],
      })}\n`,
    );

    const result = await runDoctor({
      cwd: repo,
      args: ['--json'],
      env: { HOME: home, APPDATA: home, PATH: home },
    });
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'spec-kit',
        status: 'warn',
        reason: 'upstream-status-unavailable',
      }),
    );
  });

  it('fails an unreadable integrations declaration without echoing its private bytes', async () => {
    await initProject(repo, {});
    const privateSentinel = ['private', 'doctor', 'sentinel'].join('-');
    const declaration = path.join(repo, '.rig', 'integrations.json');
    await mkdir(path.dirname(declaration), { recursive: true });
    await writeFile(declaration, `{ "value": "${privateSentinel}"`);

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(body.status).toBe('fail');
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'integrations',
        status: 'fail',
        reason: 'invalid-declaration',
      }),
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(privateSentinel);
  });

  it('diagnoses an owned file whose bytes differ from the recorded installation', async () => {
    await initProject(repo, {});
    const owned = path.join(repo, 'AGENTS.md');
    await writeFile(owned, `${await readFile(owned, 'utf8')}\nmanual change\n`);

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(body.status).toBe('warn');
    expect(body.checks).toContainEqual(
      expect.objectContaining({ id: 'rig-owned-files', status: 'warn', reason: 'content-drift' }),
    );
  });

  it('distinguishes line-ending-only drift from pristine owned bytes', async () => {
    await initProject(repo, {});
    const owned = path.join(repo, 'AGENTS.md');
    const original = await readFile(owned, 'utf8');
    expect(original).toContain('\n');
    await writeFile(owned, original.replace(/\r?\n/g, '\r\n'));

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(body.status).toBe('warn');
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'rig-owned-files',
        status: 'warn',
        reason: 'line-ending-drift',
      }),
    );
    expect(body.checks).not.toContainEqual(
      expect.objectContaining({ id: 'rig-owned-files', status: 'ok', reason: 'pristine' }),
    );
  });

  it('rejects invalid doctor arguments with CLI usage exit 2', async () => {
    const result = await doctor(['--unexpected']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
  });
});
