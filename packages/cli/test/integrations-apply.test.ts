// RP-22 S5 — public `setup apply | remove` lifecycle for hosted MCP
// providers.  These assertions use a real, temporary project directory as
// the oracle: `.mcp.json` is the official, project-scoped Claude shape and
// must be changed only as this command says.  They intentionally do not
// spawn a real provider CLI or reach a hosted provider.
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { RECEIPTS_DIR_REL } from '../src/integrations/receipt.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

type McpServer = { type: 'http'; url: string };
type McpConfig = { mcpServers: Record<string, McpServer> };

const providers = [
  { id: 'figma-mcp', name: 'figma', url: 'https://mcp.figma.com/mcp' },
  { id: 'atlassian-mcp', name: 'atlassian', url: 'https://mcp.atlassian.com/v2/mcp' },
] as const;

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-apply-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const declarationPath = (): string => path.join(repo, '.rig', 'integrations.json');
const mcpConfigPath = (): string => path.join(repo, '.mcp.json');
const receiptPath = (id: string): string =>
  path.join(repo, ...RECEIPTS_DIR_REL.split('/'), `${id}.json`);

async function declare(...ids: string[]): Promise<void> {
  await mkdir(path.dirname(declarationPath()), { recursive: true });
  await writeFile(
    declarationPath(),
    `${JSON.stringify(
      { schemaVersion: 1, integrations: ids.map((id) => ({ id, selected: true })) },
      null,
      2,
    )}\n`,
  );
}

async function writeConfig(config: McpConfig): Promise<void> {
  await writeFile(mcpConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

async function readConfig(): Promise<McpConfig> {
  return JSON.parse(await readFile(mcpConfigPath(), 'utf8')) as McpConfig;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function expectJsonRefusal(result: { stdout: string; stderr: string }, reason: RegExp): void {
  expect(result.stderr).toBe('');
  expect(result.stdout.endsWith('\n')).toBe(true);
  expect(result.stdout.indexOf('\n')).toBe(result.stdout.length - 1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    outcome: 'refused',
    reason: expect.stringMatching(reason),
  });
}

/** Extra options are S5's injectable terminal seam; the existing S4 command
 * ignores them, so this remains a real Red test before the S5 API lands. */
function run(verb: 'apply' | 'remove' | 'verify', args: string[], isTTY = true) {
  const options = { verb, args, cwd: repo, isTTY };
  return runIntegrationsCommand(options);
}

describe('setup apply (RP-22 S5)', () => {
  it('requires an explicit hosted-provider selection before it treats a legacy declaration as actionable', async () => {
    await mkdir(path.dirname(declarationPath()), { recursive: true });
    await writeFile(
      declarationPath(),
      `${JSON.stringify({ schemaVersion: 1, integrations: [{ id: 'figma-mcp' }] }, null, 2)}\n`,
    );

    const result = await run('apply', ['--only', 'figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      integrations: [
        { id: 'figma-mcp', state: 'pending-user-action', reason: 'explicit-selection-required' },
      ],
    });
    expect(await fileExists(mcpConfigPath())).toBe(false);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it('records selected: true when setup add explicitly opts a hosted provider in', async () => {
    const result = await runIntegrationsCommand({
      verb: 'add',
      args: ['figma-mcp', '--json'],
      cwd: repo,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toMatchObject({
      integrations: [{ id: 'figma-mcp', selected: true }],
    });
  });

  it('activates a legacy hosted declaration without dropping its required flag or claude-only harness selection', async () => {
    await mkdir(path.dirname(declarationPath()), { recursive: true });
    await writeFile(
      declarationPath(),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          integrations: [{ id: 'figma-mcp', required: true, harnesses: ['claude-code'] }],
        },
        null,
        2,
      )}\n`,
    );

    const result = await runIntegrationsCommand({
      verb: 'add',
      args: ['figma-mcp', '--json'],
      cwd: repo,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toMatchObject({
      integrations: [
        { id: 'figma-mcp', selected: true, required: true, harnesses: ['claude-code'] },
      ],
    });
  });

  it.each(providers)(
    'adds $id as the official project-scoped $name HTTP endpoint and records only configuration observation',
    async ({ id, name, url }) => {
      await declare(id);

      const result = await run('apply', ['--only', id, '--yes', '--json']);

      expect(result.exitCode).toBe(0);
      expect(JSON.stringify(JSON.parse(result.stdout))).not.toMatch(
        /(?:token|header|env|authorizationSuccess)/i,
      );
      expect(await readConfig()).toEqual({ mcpServers: { [name]: { type: 'http', url } } });

      const receipt = JSON.parse(await readFile(receiptPath(id), 'utf8')) as {
        acts: Record<
          string,
          { observedAfter: { state: string; evidence: string[] }; notObserved: string[] }
        >;
      };
      expect(receipt.acts['claude-code']).toMatchObject({
        route: 'mcp-config',
        automation: 'automatic',
        observedAfter: { state: 'installed', evidence: ['mcp-json-entry'] },
        notObserved: ['authorization', 'connectivity', 'project-approval'],
      });
      // A saved action is never evidence that a user authorized the hosted
      // service.  Codex has no approved automatic route in S5 either.
      expect(receipt.acts.codex).toMatchObject({
        route: 'guided-manual',
        automation: 'guided',
        observedAfter: { state: 'pending-user-action' },
      });
      expect(JSON.stringify(receipt)).not.toMatch(/(?:token|header|authorizationSuccess)/i);
    },
  );

  it('returns one JSON refusal and makes no mutation when a non-interactive JSON apply omits --yes', async () => {
    await declare('figma-mcp');

    const result = await run('apply', ['--only', 'figma-mcp', '--json'], false);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.indexOf('\n')).toBe(result.stdout.length - 1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'setup',
      verb: 'apply',
      outcome: 'refused',
      reason: expect.stringMatching(/--yes|interactive/i),
    });
    expect(await fileExists(mcpConfigPath())).toBe(false);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it('asks for confirmation with the selected hosted-provider plan before a TTY prose apply writes files', async () => {
    await declare('figma-mcp');
    const plans: string[] = [];
    let configExistedWhenAsked: boolean | undefined;
    let receiptExistedWhenAsked: boolean | undefined;

    const result = await runIntegrationsCommand({
      verb: 'apply',
      args: ['--only', 'figma-mcp'],
      cwd: repo,
      isTTY: true,
      confirm: async (plan) => {
        plans.push(plan);
        configExistedWhenAsked = await fileExists(mcpConfigPath());
        receiptExistedWhenAsked = await fileExists(receiptPath('figma-mcp'));
        return true;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatch(/figma-mcp/i);
    expect(plans[0]).toMatch(/project.*mcp|mcp.*project/i);
    expect(configExistedWhenAsked).toBe(false);
    expect(receiptExistedWhenAsked).toBe(false);
    expect(await readConfig()).toEqual({
      mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
    });
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(true);
  });

  it('leaves the project untouched when a TTY prose confirmation is declined', async () => {
    await declare('figma-mcp');
    const plans: string[] = [];

    const result = await runIntegrationsCommand({
      verb: 'apply',
      args: ['--only', 'figma-mcp'],
      cwd: repo,
      isTTY: true,
      confirm: async (plan) => {
        plans.push(plan);
        return false;
      },
    });

    expect(result.exitCode).toBe(1);
    expect(plans).toHaveLength(1);
    expect(await fileExists(mcpConfigPath())).toBe(false);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it('refuses a TTY JSON apply without --yes as one JSON object and never calls confirmation', async () => {
    await declare('figma-mcp');
    let confirmCalls = 0;

    const result = await runIntegrationsCommand({
      verb: 'apply',
      args: ['--only', 'figma-mcp', '--json'],
      cwd: repo,
      isTTY: true,
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
    });

    expect(result.exitCode).toBe(1);
    expect(confirmCalls).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.indexOf('\n')).toBe(result.stdout.length - 1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'setup',
      verb: 'apply',
      outcome: 'refused',
      reason: expect.stringMatching(/--yes|interactive/i),
    });
    expect(await fileExists(mcpConfigPath())).toBe(false);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it('dry-run reports the planned apply without creating a config or receipt or rewriting existing user config', async () => {
    await declare('figma-mcp');
    const before = `${JSON.stringify({ mcpServers: { user: { type: 'http', url: 'https://example.test/user' } } }, null, 2)}\n`;
    await writeFile(mcpConfigPath(), before);

    const result = await run('apply', ['--only', 'figma-mcp', '--dry-run', '--yes', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ verb: 'apply', dryRun: true });
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(before);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it.each([
    { declared: ['figma-mcp'], only: 'atlassian-mcp', label: 'an undeclared hosted provider' },
    {
      declared: ['memory-custom-executable'],
      only: 'memory-custom-executable',
      label: 'a declared provider without an MCP route',
    },
  ])(
    'refuses --only for $label rather than reporting an empty success',
    async ({ declared, only }) => {
      await declare(...declared);

      const result = await run('apply', ['--only', only, '--yes', '--json']);

      expect(result.exitCode).toBe(1);
      expectJsonRefusal(result, /only|declared|actionable|unsupported/i);
      expect(await fileExists(mcpConfigPath())).toBe(false);
      expect(await fileExists(receiptPath(only))).toBe(false);
    },
  );

  it('leaves a pre-existing identical provider entry unowned and does not create a receipt', async () => {
    await declare('figma-mcp');
    const original: McpConfig = {
      mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
    };
    await writeConfig(original);
    const before = await readFile(mcpConfigPath(), 'utf8');

    const result = await run('apply', ['--only', 'figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ changed: false });
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(before);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it('refuses a foreign entry at Rig’s provider name and leaves it byte-for-byte intact', async () => {
    await declare('figma-mcp');
    const before =
      '{\n  "mcpServers": {\n    "figma": { "type": "http", "url": "https://example.test/foreign" }\n  }\n}\n';
    await writeFile(mcpConfigPath(), before);

    const result = await run('apply', ['--only', 'figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(1);
    expectJsonRefusal(result, /conflict|foreign/i);
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(before);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it('turns an unscoped throwing probe into unverified output rather than an exception or stack trace', async () => {
    await declare('figma-mcp');

    const result = await runIntegrationsCommand({
      verb: 'verify',
      args: ['--json'],
      cwd: repo,
      probe: async () => {
        throw new Error('probe failure is not CLI output');
      },
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      integrations: { id: string; harnesses: Record<string, { state: string }> }[];
    };
    const figma = payload.integrations.find((entry) => entry.id === 'figma-mcp');
    expect(figma?.harnesses['claude-code']?.state).toBe('unverified');
    expect(result.stderr).toBe('');
  });
});

describe('setup remove (RP-22 S5)', () => {
  it('removes only the Rig-created provider entry and receipt, preserving other project MCP configuration', async () => {
    await declare('figma-mcp');
    await expect(run('apply', ['--only', 'figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    const configured = await readConfig();
    configured.mcpServers.team = { type: 'http', url: 'https://example.test/team' };
    await writeConfig(configured);

    const result = await run('remove', ['figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(0);
    expect(await readConfig()).toEqual({
      mcpServers: { team: { type: 'http', url: 'https://example.test/team' } },
    });
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(true);
    const receipt = JSON.parse(await readFile(receiptPath('figma-mcp'), 'utf8')) as {
      removedAt?: string;
    };
    expect(receipt.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('re-reads the MCP config after TTY confirmation so an unrelated entry added during the prompt survives', async () => {
    await declare('figma-mcp');
    await expect(run('apply', ['--only', 'figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });

    const result = await runIntegrationsCommand({
      verb: 'remove',
      args: ['figma-mcp'],
      cwd: repo,
      isTTY: true,
      confirm: async () => {
        const current = await readConfig();
        current.mcpServers.late = { type: 'http', url: 'https://example.test/late' };
        await writeConfig(current);
        return true;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(await readConfig()).toEqual({
      mcpServers: { late: { type: 'http', url: 'https://example.test/late' } },
    });
    const receipt = JSON.parse(await readFile(receiptPath('figma-mcp'), 'utf8')) as {
      removedAt?: string;
    };
    expect(receipt.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('prints a would-remove plan on prose dry-run while leaving config and receipt bytes unchanged', async () => {
    await declare('figma-mcp');
    await expect(run('apply', ['--only', 'figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    const configBefore = await readFile(mcpConfigPath(), 'utf8');
    const receiptBefore = await readFile(receiptPath('figma-mcp'), 'utf8');

    const result = await run('remove', ['figma-mcp', '--dry-run', '--yes']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/would remove|planned/i);
    expect(result.stdout).not.toMatch(/^removed\b/i);
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(configBefore);
    expect(await readFile(receiptPath('figma-mcp'), 'utf8')).toBe(receiptBefore);
  });

  it('refuses to remove an identical but unreceipted user entry, so an apply noop never becomes ownership', async () => {
    await declare('figma-mcp');
    const userConfig: McpConfig = {
      mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
    };
    await writeConfig(userConfig);
    const before = await readFile(mcpConfigPath(), 'utf8');

    const result = await run('remove', ['figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(1);
    expectJsonRefusal(result, /receipt|owned/i);
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(before);
  });

  it('refuses removal after the provider entry was modified outside Rig, preserving both the changed config and active receipt', async () => {
    await declare('figma-mcp');
    await expect(run('apply', ['--only', 'figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    const modified: McpConfig = {
      mcpServers: { figma: { type: 'http', url: 'https://example.test/operator-edited' } },
    };
    await writeConfig(modified);
    const before = await readFile(mcpConfigPath(), 'utf8');
    const receiptBefore = await readFile(receiptPath('figma-mcp'), 'utf8');

    const result = await run('remove', ['figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(1);
    expectJsonRefusal(result, /conflict|modified/i);
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(before);
    expect(await readFile(receiptPath('figma-mcp'), 'utf8')).toBe(receiptBefore);
  });

  it('does not let an earlier removal receipt authorize deletion of a later identical user entry', async () => {
    await declare('figma-mcp');
    await expect(run('apply', ['--only', 'figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(run('remove', ['figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    const userOwned: McpConfig = {
      mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
    };
    await writeConfig(userOwned);
    const before = await readFile(mcpConfigPath(), 'utf8');

    const repeated = await run('remove', ['figma-mcp', '--yes', '--json']);

    expect(repeated.exitCode).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ changed: false });
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(before);
  });

  it('keeps a removal receipt stable on a repeated remove and clears removedAt when a later apply recreates Rig’s action', async () => {
    await declare('figma-mcp');
    await expect(run('apply', ['--only', 'figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(run('remove', ['figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    const removedBytes = await readFile(receiptPath('figma-mcp'), 'utf8');

    const repeated = await run('remove', ['figma-mcp', '--yes', '--json']);

    expect(repeated.exitCode).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ changed: false });
    expect(await readFile(receiptPath('figma-mcp'), 'utf8')).toBe(removedBytes);

    await expect(run('apply', ['--only', 'figma-mcp', '--yes', '--json'])).resolves.toMatchObject({
      exitCode: 0,
    });
    const reapplied = JSON.parse(await readFile(receiptPath('figma-mcp'), 'utf8')) as {
      removedAt?: string;
    };
    expect(reapplied.removedAt).toBeUndefined();
    expect(await readConfig()).toEqual({
      mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
    });
  });
});

describe('setup apply — unsafe owned-file shapes (RP-22 S5)', () => {
  it('refuses a directory at .mcp.json without creating a receipt', async () => {
    await declare('figma-mcp');
    await mkdir(mcpConfigPath());

    const result = await run('apply', ['--only', 'figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(1);
    expectJsonRefusal(result, /refus|directory|file|unreadable/i);
    expect(await fileExists(receiptPath('figma-mcp'))).toBe(false);
  });

  it('refuses a regular file at the receipts directory before creating an unreceipted MCP entry', async () => {
    await declare('figma-mcp');
    await writeFile(path.join(repo, '.rig', 'receipts'), 'not a directory\n');

    const result = await run('apply', ['--only', 'figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(1);
    expectJsonRefusal(result, /receipt|write|unsafe|refus/i);
    expect(await fileExists(mcpConfigPath())).toBe(false);
  });

  for (const shape of [
    'a symlinked MCP config leaf',
    'a symlinked receipts parent',
    'a symlinked receipt leaf',
  ] as const) {
    it(`refuses ${shape} before it can write an unreceipted MCP entry`, async (ctx) => {
      skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
      await declare('figma-mcp');
      const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-apply-outside-'));
      try {
        if (shape === 'a symlinked MCP config leaf') {
          const outsideConfig = path.join(outside, 'mcp.json');
          await writeFile(outsideConfig, '{"mcpServers":{}}\n');
          await symlink(outsideConfig, mcpConfigPath());
        } else if (shape === 'a symlinked receipts parent') {
          const outsideReceipts = path.join(outside, 'receipts');
          await mkdir(outsideReceipts);
          await symlink(outsideReceipts, path.dirname(receiptPath('figma-mcp')), 'dir');
        } else {
          await mkdir(path.dirname(receiptPath('figma-mcp')), { recursive: true });
          const outsideReceipt = path.join(outside, 'receipt.json');
          await writeFile(outsideReceipt, '{}\n');
          await symlink(outsideReceipt, receiptPath('figma-mcp'));
        }

        const result = await run('apply', ['--only', 'figma-mcp', '--yes', '--json']);

        expect(result.exitCode).toBe(1);
        expectJsonRefusal(result, /refus|unsafe|symlink|unreadable|write/i);
        if (shape !== 'a symlinked MCP config leaf')
          expect(await fileExists(mcpConfigPath())).toBe(false);
      } finally {
        await removeFixture(outside);
      }
    });
  }
});
