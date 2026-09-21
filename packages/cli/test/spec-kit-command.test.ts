import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runIntegrationsCommand,
  type IntegrationsCliOptions,
} from '../src/commands/integrations.js';
import { type SpecKitOptions, type SpecKitResult } from '../src/integrations/spec-kit.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const SPEC_KIT = 'spec-kit';
const VERSION = '1.0.8';
const DECLARATION_REL = '.rig/integrations.json';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-spec-kit-command-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const declarationPath = () => path.join(repo, ...DECLARATION_REL.split('/'));
const upstreamMarker = () => path.join(repo, '.specify', 'upstream-created');

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeDeclaration(integrations: unknown[]): Promise<void> {
  await mkdir(path.dirname(declarationPath()), { recursive: true });
  await writeFile(
    declarationPath(),
    `${JSON.stringify({ schemaVersion: 1, integrations }, null, 2)}\n`,
  );
}

function intent(harnesses: string[]): Record<string, unknown> {
  return { id: SPEC_KIT, version: VERSION, selected: true, harnesses };
}

function successfulLifecycle(options: SpecKitOptions): SpecKitResult {
  return {
    ok: true,
    plan: ['official pinned Spec Kit lifecycle'],
    observed: {
      status: 'ok',
      installedIntegrations: options.harnesses.map((harness) =>
        harness === 'claude-code' ? 'claude' : 'codex',
      ),
      findings: [],
    },
  };
}

type CommandOptions = IntegrationsCliOptions & {
  runSpecKit: (options: SpecKitOptions) => Promise<SpecKitResult>;
};

function command(options: CommandOptions) {
  return runIntegrationsCommand(options);
}

describe('Spec Kit through setup add, apply, and remove', () => {
  it('persists one pinned selected intent only after the official lifecycle succeeds, without claiming upstream files', async () => {
    const calls: SpecKitOptions[] = [];
    const result = await command({
      verb: 'add',
      args: [SPEC_KIT, '--harness', 'claude-code', '--harness', 'codex', '--yes', '--json'],
      cwd: repo,
      isTTY: false,
      runSpecKit: async (options) => {
        calls.push(options);
        await mkdir(path.dirname(upstreamMarker()), { recursive: true });
        await writeFile(upstreamMarker(), 'owned by upstream');
        return successfulLifecycle(options);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({
        repoDir: repo,
        operation: 'add',
        harnesses: ['claude-code', 'codex'],
        consent: true,
      }),
    ]);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      integrations: [intent(['claude-code', 'codex'])],
    });
    expect(await readFile(upstreamMarker(), 'utf8')).toBe('owned by upstream');
    expect(await readdir(path.dirname(declarationPath()))).toEqual(['integrations.json']);
    expect(await exists(path.join(repo, '.claude', '.rig-manifest.json'))).toBe(false);
  });

  it('refuses JSON add without --yes before starting a lifecycle or writing intent', async () => {
    let lifecycleCalls = 0;
    const result = await command({
      verb: 'add',
      args: [SPEC_KIT, '--harness', 'claude-code', '--json'],
      cwd: repo,
      isTTY: true,
      runSpecKit: async (options) => {
        lifecycleCalls += 1;
        return successfulLifecycle(options);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'refused' });
    expect(lifecycleCalls).toBe(0);
    expect(await exists(declarationPath())).toBe(false);
    expect(await exists(upstreamMarker())).toBe(false);
  });

  it('leaves intent absent and reports the lifecycle reason when upstream is incomplete', async () => {
    const result = await command({
      verb: 'add',
      args: [SPEC_KIT, '--harness', 'claude-code', '--yes', '--json'],
      cwd: repo,
      isTTY: false,
      runSpecKit: async () => ({
        ok: false,
        reason: 'upstream-harness-status-incomplete',
        plan: ['official pinned Spec Kit lifecycle'],
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'refused',
      reason: 'upstream-harness-status-incomplete',
    });
    expect(await exists(declarationPath())).toBe(false);
  });

  it('reports the bounded upstream status and recovery reason after partial setup without recording intent', async () => {
    const result = await command({
      verb: 'add',
      args: [SPEC_KIT, '--harness', 'claude-code', '--harness', 'codex', '--yes', '--json'],
      cwd: repo,
      isTTY: false,
      runSpecKit: async () => ({
        ok: false,
        reason: 'upstream-incomplete-use-adopt-and-status',
        plan: ['official pinned Spec Kit lifecycle'],
        observed: {
          status: 'warning',
          installedIntegrations: ['claude'],
          findings: [{ code: 'codex-install-missing', severity: 'warning' }],
        },
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'refused',
      reason: 'upstream-incomplete-use-adopt-and-status',
      observed: {
        status: 'warning',
        installedIntegrations: ['claude'],
        findings: [{ code: 'codex-install-missing', severity: 'warning' }],
      },
    });
    expect(await exists(declarationPath())).toBe(false);
  });

  it('refuses a declaration changed after confirmation before starting the lifecycle', async () => {
    let lifecycleCalls = 0;
    let consentWasRequested = false;
    const replacement = `${JSON.stringify({ schemaVersion: 1, integrations: [] }, null, 2)}\n`;
    const result = await command({
      verb: 'add',
      args: [SPEC_KIT, '--harness', 'claude-code'],
      cwd: repo,
      isTTY: true,
      confirm: async () => {
        consentWasRequested = true;
        await mkdir(path.dirname(declarationPath()), { recursive: true });
        await writeFile(declarationPath(), replacement);
        return true;
      },
      runSpecKit: async (options) => {
        lifecycleCalls += 1;
        return successfulLifecycle(options);
      },
    });

    expect(consentWasRequested).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('changed-since-plan');
    expect(lifecycleCalls).toBe(0);
    expect(await readFile(declarationPath(), 'utf8')).toBe(replacement);
  });

  it('forwards explicit adoption only after --yes to the official lifecycle', async () => {
    const calls: SpecKitOptions[] = [];
    const result = await command({
      verb: 'add',
      args: [SPEC_KIT, '--harness', 'claude-code', '--adopt', '--yes', '--json'],
      cwd: repo,
      isTTY: false,
      runSpecKit: async (options) => {
        calls.push(options);
        return successfulLifecycle(options);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([expect.objectContaining({ adopt: true, consent: true })]);
  });

  it('uses the official lifecycle for apply and retains intent, then removes intent only after successful remove', async () => {
    await writeDeclaration([intent(['claude-code', 'codex'])]);
    await mkdir(path.join(repo, '.specify'), { recursive: true });
    const calls: SpecKitOptions[] = [];
    const apply = await command({
      verb: 'apply',
      args: [SPEC_KIT, '--yes', '--json'],
      cwd: repo,
      isTTY: false,
      runSpecKit: async (options) => {
        calls.push(options);
        return successfulLifecycle(options);
      },
    });

    expect(apply.exitCode).toBe(0);
    expect(calls).toEqual([expect.objectContaining({ operation: 'apply', managed: true })]);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8')).integrations).toEqual([
      intent(['claude-code', 'codex']),
    ]);

    const remove = await command({
      verb: 'remove',
      args: [SPEC_KIT, '--yes', '--json'],
      cwd: repo,
      isTTY: false,
      runSpecKit: async (options) => {
        calls.push(options);
        return successfulLifecycle(options);
      },
    });

    expect(remove.exitCode).toBe(0);
    expect(calls.at(-1)).toMatchObject({ operation: 'remove', managed: true });
    expect(JSON.parse(await readFile(declarationPath(), 'utf8')).integrations).toEqual([]);
  });

  it('preserves selected intent when an official remove lifecycle fails', async () => {
    await writeDeclaration([intent(['claude-code'])]);
    await mkdir(path.join(repo, '.specify'), { recursive: true });
    const before = await readFile(declarationPath(), 'utf8');

    const result = await command({
      verb: 'remove',
      args: [SPEC_KIT, '--yes', '--json'],
      cwd: repo,
      isTTY: false,
      runSpecKit: async () => ({
        ok: false,
        reason: 'upstream-incomplete-use-adopt-and-status',
        plan: ['official pinned Spec Kit lifecycle'],
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'refused',
      reason: 'upstream-incomplete-use-adopt-and-status',
    });
    expect(await readFile(declarationPath(), 'utf8')).toBe(before);
  });
});
