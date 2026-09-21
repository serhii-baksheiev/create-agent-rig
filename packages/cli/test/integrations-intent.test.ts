// RP-22 final intent shape: this suite is deliberately expressed solely via
// the public setup command and declaration parser.  It does not depend on the
// old receipt/state implementation, which is being removed by this slice.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { parseDeclaration } from '../src/integrations/declaration.js';
import { REGISTRY } from '../src/integrations/registry.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const FIGMA_SERVER = { type: 'http', url: 'https://mcp.figma.com/mcp' };
const FIGMA_ENTRY_HASH = createHash('sha256').update(JSON.stringify(FIGMA_SERVER)).digest('hex');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-intent-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const declarationPath = (): string => path.join(repo, '.rig', 'integrations.json');
const mcpPath = (): string => path.join(repo, '.mcp.json');
// This is the old RECEIPTS_DIR_REL value. The final assertion below is broader:
// an add may leave no .rig artifact other than integrations.json at all.
const receiptDirectory = (): string => path.join(repo, '.rig', 'receipts');

async function writeDeclaration(value: unknown): Promise<void> {
  await mkdir(path.dirname(declarationPath()), { recursive: true });
  await writeFile(declarationPath(), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMcp(value: unknown): Promise<void> {
  await writeFile(mcpPath(), `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function rigEntries(): Promise<string[]> {
  if (!(await exists(path.join(repo, '.rig')))) return [];
  return (await readdir(path.join(repo, '.rig'))).sort();
}

function selection(targets: unknown = undefined): Record<string, unknown> {
  return {
    id: 'figma-mcp',
    selected: true,
    harnesses: ['claude-code'],
    ...(targets === undefined ? {} : { targets }),
  };
}

function setup(
  verb: 'add' | 'apply' | 'remove',
  args: string[],
  confirm?: (plan: string) => Promise<boolean>,
) {
  return runIntegrationsCommand({ verb, args, cwd: repo, isTTY: true, confirm });
}

describe('integration intent declaration v1 (RP-22)', () => {
  it('accepts a Claude target entry hash, preserves the selected harness shape, and refuses arbitrary target commands or invalid hashes', () => {
    const accepted = parseDeclaration(
      JSON.stringify({
        schemaVersion: 1,
        integrations: [selection({ 'claude-code': { entryHash: FIGMA_ENTRY_HASH } })],
      }),
      REGISTRY,
    );

    expect(accepted).toEqual({
      status: 'ok',
      entries: [selection({ 'claude-code': { entryHash: FIGMA_ENTRY_HASH } })],
      rejected: [],
    });

    const targetCommand = parseDeclaration(
      JSON.stringify({
        schemaVersion: 1,
        integrations: [
          selection({ 'claude-code': { entryHash: FIGMA_ENTRY_HASH, command: 'curl' } }),
        ],
      }),
      REGISTRY,
    );
    expect(targetCommand).toMatchObject({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'figma-mcp', reason: 'arbitrary-command-refused' }],
    });

    const invalidHash = parseDeclaration(
      JSON.stringify({
        schemaVersion: 1,
        integrations: [selection({ 'claude-code': { entryHash: 'not-a-sha256' } })],
      }),
      REGISTRY,
    );
    expect(invalidHash).toMatchObject({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'figma-mcp' }],
    });
  });

  it('add writes the Claude MCP entry and its v1 intent atomically, without a receipt', async () => {
    const result = await setup('add', ['figma-mcp', '--harness', 'claude-code', '--yes', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(mcpPath(), 'utf8'))).toEqual({
      mcpServers: { figma: FIGMA_SERVER },
    });
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      integrations: [selection({ 'claude-code': { entryHash: FIGMA_ENTRY_HASH } })],
    });
    expect(await exists(receiptDirectory())).toBe(false);
    expect(await rigEntries()).toEqual(['integrations.json']);
  });

  it('apply accepts an optional positional provider and retains its owned target hash', async () => {
    await writeDeclaration({ schemaVersion: 1, integrations: [selection()] });

    const result = await setup('apply', ['figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      integrations: [selection({ 'claude-code': { entryHash: FIGMA_ENTRY_HASH } })],
    });
    expect(JSON.parse(await readFile(mcpPath(), 'utf8'))).toEqual({
      mcpServers: { figma: FIGMA_SERVER },
    });
  });

  it('preserves an identical foreign MCP entry and never claims it as Rig-owned intent', async () => {
    const foreign = {
      mcpServers: { figma: FIGMA_SERVER, human: { type: 'http', url: 'https://example.test/mcp' } },
    };
    await writeMcp(foreign);

    const result = await setup('add', ['figma-mcp', '--harness', 'claude-code', '--yes', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(await readFile(mcpPath(), 'utf8'))).toEqual(foreign);
    expect(await exists(declarationPath())).toBe(false);
    expect(await exists(receiptDirectory())).toBe(false);
    expect(await rigEntries()).toEqual([]);
  });

  it('remove deletes only an owned, unmodified entry and keeps all foreign entries', async () => {
    await setup('add', ['figma-mcp', '--harness', 'claude-code', '--yes', '--json']);
    const withForeign = {
      mcpServers: {
        figma: FIGMA_SERVER,
        human: { type: 'http', url: 'https://example.test/mcp' },
      },
    };
    await writeMcp(withForeign);

    const result = await setup('remove', ['figma-mcp', '--yes', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(mcpPath(), 'utf8'))).toEqual({
      mcpServers: { human: { type: 'http', url: 'https://example.test/mcp' } },
    });
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      integrations: [],
    });
    expect(await exists(receiptDirectory())).toBe(false);
    expect(await rigEntries()).toEqual(['integrations.json']);
  });

  it('refuses JSON mutations without --yes and leaves every file absent', async () => {
    const result = await setup('add', ['figma-mcp', '--harness', 'claude-code', '--json']);

    expect(result.exitCode).toBe(1);
    expect(await exists(declarationPath())).toBe(false);
    expect(await exists(mcpPath())).toBe(false);
    expect(await exists(receiptDirectory())).toBe(false);
    expect(await rigEntries()).toEqual([]);
  });

  it.each([
    ['declaration', async () => writeDeclaration({ schemaVersion: 1, integrations: [] })],
    [
      'MCP configuration',
      async () =>
        writeMcp({ mcpServers: { human: { type: 'http', url: 'https://example.test/mcp' } } }),
    ],
  ])(
    'refuses a stale plan when consent changes the %s, leaving no other writes',
    async (_name, change) => {
      let consentWasRequested = false;
      const result = await setup('add', ['figma-mcp', '--harness', 'claude-code'], async () => {
        consentWasRequested = true;
        await change();
        return true;
      });

      expect(consentWasRequested).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(await exists(receiptDirectory())).toBe(false);
      if (_name === 'declaration') {
        expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
          schemaVersion: 1,
          integrations: [],
        });
        expect(await exists(mcpPath())).toBe(false);
        expect(await rigEntries()).toEqual(['integrations.json']);
      } else {
        expect(await exists(declarationPath())).toBe(false);
        expect(JSON.parse(await readFile(mcpPath(), 'utf8'))).toEqual({
          mcpServers: { human: { type: 'http', url: 'https://example.test/mcp' } },
        });
        expect(await rigEntries()).toEqual([]);
      }
    },
  );
});
