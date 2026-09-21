import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetupWizard } from '../src/commands/setup-wizard.js';
import type {
  IntegrationsCliOptions,
  IntegrationsCliResult,
} from '../src/commands/integrations.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-setup-wizard-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const written: IntegrationsCliResult = { exitCode: 0, stdout: 'written\n', stderr: '' };

describe('runSetupWizard', () => {
  it('delegates a Figma both-harness selection to deterministic add without adding --yes', async () => {
    const calls: IntegrationsCliOptions[] = [];
    const plans: string[] = [];
    const result = await runSetupWizard({
      cwd: repo,
      isTTY: true,
      args: [],
      promptChoice: async (step) => (step === 'provider' ? 'figma-mcp' : 'both'),
      confirm: async (plan) => {
        plans.push(plan);
        return true;
      },
      runIntegration: async (options) => {
        calls.push(options);
        expect(await options.confirm?.('the deterministic integration plan')).toBe(true);
        return written;
      },
    });

    expect(result).toEqual(written);
    expect(plans).toEqual(['the deterministic integration plan']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      verb: 'add',
      args: ['figma-mcp', '--harness', 'claude-code', '--harness', 'codex'],
      cwd: repo,
      isTTY: true,
    });
    expect(calls[0]?.args).not.toContain('--yes');
  });

  it('routes a Spec Kit both-harness selection through deterministic add rather than a guide', async () => {
    const calls: IntegrationsCliOptions[] = [];
    const result = await runSetupWizard({
      cwd: repo,
      isTTY: true,
      args: [],
      promptChoice: async (step) => (step === 'provider' ? 'spec-kit' : 'both'),
      confirm: async () => true,
      runIntegration: async (options) => {
        calls.push(options);
        return written;
      },
    });

    expect(result).toEqual(written);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      verb: 'add',
      args: ['spec-kit', '--harness', 'claude-code', '--harness', 'codex'],
    });
    expect(calls[0]?.args).not.toContain('--yes');
  });

  it('ends cleanly without running an integration when a user cancels a choice', async () => {
    let integrationCalls = 0;
    const result = await runSetupWizard({
      cwd: repo,
      isTTY: true,
      args: [],
      promptChoice: async () => undefined,
      confirm: async () => true,
      runIntegration: async () => {
        integrationCalls += 1;
        return written;
      },
    });

    expect(result).toEqual({ exitCode: 0, stdout: 'setup: cancelled\n', stderr: '' });
    expect(integrationCalls).toBe(0);
  });

  it.each([
    ['JSON without --yes', true, ['--json']],
    ['a non-interactive terminal', false, []],
  ] as const)(
    'refuses %s before prompting or running an integration',
    async (_name, isTTY, args) => {
      let prompts = 0;
      let integrationCalls = 0;
      const options = {
        cwd: repo,
        isTTY,
        args: [...args],
        promptChoice: async () => {
          prompts += 1;
          return 'figma-mcp' as const;
        },
        confirm: async () => true,
        runIntegration: async () => {
          integrationCalls += 1;
          return written;
        },
      };

      const first = await runSetupWizard(options);
      const second = await runSetupWizard(options);

      expect(first.exitCode).toBe(1);
      expect(second).toEqual(first);
      expect(prompts).toBe(0);
      expect(integrationCalls).toBe(0);
      if (options.args.includes('--json'))
        expect(JSON.parse(first.stdout)).toMatchObject({ outcome: 'refused' });
    },
  );
});
