// Security and command-surface invariants retained from the receipt-era
// suite. These use only `setup add|apply|remove` at their public boundary.
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { fifosAvailable, skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

const FIGMA = { type: 'http', url: 'https://mcp.figma.com/mcp' };
let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-safety-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const declaration = () => path.join(repo, '.rig', 'integrations.json');
const mcp = () => path.join(repo, '.mcp.json');

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeDeclaration(value: unknown): Promise<string> {
  await mkdir(path.dirname(declaration()), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(declaration(), raw);
  return raw;
}

async function writeMcp(value: unknown): Promise<string> {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(mcp(), raw);
  return raw;
}

function command(
  verb: 'add' | 'apply' | 'remove',
  args: string[],
  confirm?: (plan: string) => Promise<boolean>,
) {
  return runIntegrationsCommand({ verb, args, cwd: repo, isTTY: true, confirm });
}

const addArgs = ['figma-mcp', '--harness', 'claude-code', '--yes', '--json'];
const removeArgs = ['figma-mcp', '--yes', '--json'];

describe('setup integration safety', () => {
  it('refuses a symlinked MCP configuration without reading or overwriting its target', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-outside-'));
    const target = path.join(outside, 'foreign-mcp.json');
    const foreign = await writeFile(
      target,
      `${JSON.stringify({ mcpServers: { human: FIGMA } })}\n`,
    ).then(() => readFile(target, 'utf8'));
    try {
      await symlink(target, mcp(), 'file');
      const result = await command('add', addArgs);

      expect(result.exitCode).toBe(1);
      expect(await readFile(target, 'utf8')).toBe(foreign);
      expect(await exists(declaration())).toBe(false);
    } finally {
      await removeFixture(outside);
    }
  });

  it('refuses a FIFO declaration promptly without opening it or mutating MCP wiring', async (ctx) => {
    skipUnless(ctx, fifosAvailable().ok, fifosAvailable().reason);
    await mkdir(path.dirname(declaration()), { recursive: true });
    execFileSync('mkfifo', [declaration()]);

    const result = await command('add', addArgs);

    expect(result.exitCode).toBe(1);
    expect(await exists(mcp())).toBe(false);
  });

  it('refuses an oversized declaration before rewriting either configuration file', async () => {
    await mkdir(path.dirname(declaration()), { recursive: true });
    const before = `${'x'.repeat(64 * 1024 + 1)}`;
    await writeFile(declaration(), before);

    const result = await command('add', addArgs);

    expect(result.exitCode).toBe(1);
    expect(await readFile(declaration(), 'utf8')).toBe(before);
    expect(await exists(mcp())).toBe(false);
  });

  it('refuses an oversized MCP configuration before rewriting intent or the foreign file', async () => {
    const before = await writeMcp({ mcpServers: {}, foreignPadding: 'x'.repeat(64 * 1024 + 1) });

    const result = await command('add', addArgs);

    expect(result.exitCode).toBe(1);
    expect(await readFile(mcp(), 'utf8')).toBe(before);
    expect(await exists(declaration())).toBe(false);
  });

  it('never lets a control character from invalid CLI input reach a diagnostic', async () => {
    const hostile = '--not-a-real-flag=\u001b[31mforged-success';
    const result = await command('add', [hostile]);

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('\u001b');
  });

  it('returns one JSON refusal and no stderr for JSON usage errors', async () => {
    const result = await command('add', ['--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'setup',
      verb: 'add',
      outcome: 'refused',
    });
  });

  it('preserves foreign MCP root members while adding Rig-owned wiring', async () => {
    await writeMcp({ mcpServers: {}, foreignRoot: { keep: true }, schemaHint: 'human-owned' });

    const result = await command('add', addArgs);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(mcp(), 'utf8'))).toEqual({
      mcpServers: { figma: FIGMA },
      foreignRoot: { keep: true },
      schemaHint: 'human-owned',
    });
  });

  it('refuses removal after the owned MCP entry is modified, preserving both byte preimages', async () => {
    expect((await command('add', addArgs)).exitCode).toBe(0);
    const declarationBefore = await readFile(declaration(), 'utf8');
    const mcpBefore = await writeMcp({
      mcpServers: { figma: { ...FIGMA, url: 'https://example.test/changed' } },
    });

    const result = await command('remove', removeArgs);

    expect(result.exitCode).toBe(1);
    expect(await readFile(declaration(), 'utf8')).toBe(declarationBefore);
    expect(await readFile(mcp(), 'utf8')).toBe(mcpBefore);
  });

  it('refuses a declaration with a rejected entry without erasing its bytes', async () => {
    const before = await writeDeclaration({
      schemaVersion: 1,
      integrations: [{ id: 'unknown-provider' }],
    });

    const result = await command('add', addArgs);

    expect(result.exitCode).toBe(1);
    expect(await readFile(declaration(), 'utf8')).toBe(before);
    expect(await exists(mcp())).toBe(false);
  });

  it('is byte-idempotent when the same owned provider is added twice', async () => {
    expect((await command('add', addArgs)).exitCode).toBe(0);
    const declarationBefore = await readFile(declaration(), 'utf8');
    const mcpBefore = await readFile(mcp(), 'utf8');

    const second = await command('add', addArgs);

    expect(second.exitCode).toBe(0);
    expect(await readFile(declaration(), 'utf8')).toBe(declarationBefore);
    expect(await readFile(mcp(), 'utf8')).toBe(mcpBefore);
  });

  it.each([
    ['add', 'declaration'],
    ['add', 'MCP configuration'],
    ['remove', 'declaration'],
    ['remove', 'MCP configuration'],
  ] as const)(
    'refuses stale %s plans when consent changes the %s preimage',
    async (verb, changed) => {
      if (verb === 'remove') expect((await command('add', addArgs)).exitCode).toBe(0);
      const otherBefore =
        changed === 'declaration'
          ? (await exists(mcp()))
            ? await readFile(mcp(), 'utf8')
            : undefined
          : (await exists(declaration()))
            ? await readFile(declaration(), 'utf8')
            : undefined;
      const changedRaw =
        changed === 'declaration'
          ? `${JSON.stringify({ schemaVersion: 1, integrations: [] }, null, 2)}\n`
          : `${JSON.stringify({ mcpServers: { human: { type: 'http', url: 'https://example.test/mcp' } } }, null, 2)}\n`;

      const result = await command(
        verb,
        verb === 'add' ? ['figma-mcp', '--harness', 'claude-code'] : ['figma-mcp'],
        async () => {
          if (changed === 'declaration') {
            await mkdir(path.dirname(declaration()), { recursive: true });
            await writeFile(declaration(), changedRaw);
          } else await writeFile(mcp(), changedRaw);
          return true;
        },
      );

      expect(result.exitCode).toBe(1);
      if (changed === 'declaration') {
        expect(await readFile(declaration(), 'utf8')).toBe(changedRaw);
        if (otherBefore === undefined) expect(await exists(mcp())).toBe(false);
        else expect(await readFile(mcp(), 'utf8')).toBe(otherBefore);
      } else {
        expect(await readFile(mcp(), 'utf8')).toBe(changedRaw);
        if (otherBefore === undefined) expect(await exists(declaration())).toBe(false);
        else expect(await readFile(declaration(), 'utf8')).toBe(otherBefore);
      }
    },
  );
});
