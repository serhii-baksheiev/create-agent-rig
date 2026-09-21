import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const FIGMA = { type: 'http', url: 'https://mcp.figma.com/mcp' };
let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-text-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const mcpPath = (): string => path.join(repo, '.mcp.json');
const declarationPath = (): string => path.join(repo, '.rig', 'integrations.json');
const add = () =>
  runIntegrationsCommand({
    verb: 'add',
    args: ['figma-mcp', '--harness', 'claude-code', '--yes', '--json'],
    cwd: repo,
    isTTY: true,
  });
const remove = () =>
  runIntegrationsCommand({
    verb: 'remove',
    args: ['figma-mcp', '--yes', '--json'],
    cwd: repo,
    isTTY: true,
  });

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('MCP text ownership', () => {
  it('keeps foreign JSON text intact while adding and removing the owned entry', async () => {
    const rootMember = '  "foreign\\u0052oot" : { "note" : "braces {,} stay", "n" : 1e+02 }';
    const serverMember = '    "human\\u004bey" : { "note" : "nested {,} \\u2603", "n" : 1e+02 }';
    const raw = `{\r\n${rootMember},\r\n  "mcp\\u0053ervers" : {\r\n${serverMember}\r\n  },\r\n  "after" : [ "comma, brace }" ]\r\n}\r\n`;
    await writeFile(mcpPath(), raw);

    const added = await add();
    const afterAdd = await readFile(mcpPath(), 'utf8');
    expect(added.exitCode).toBe(0);
    expect(JSON.parse(afterAdd).mcpServers.figma).toEqual(FIGMA);
    expect(afterAdd).toContain(rootMember);
    expect(afterAdd).toContain(serverMember);
    expect(afterAdd).toContain('"after" : [ "comma, brace }" ]');
    expect(afterAdd).toContain('\r\n');

    const removed = await remove();
    const afterRemove = await readFile(mcpPath(), 'utf8');
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(afterRemove).mcpServers).not.toHaveProperty('figma');
    expect(afterRemove).toContain(rootMember);
    expect(afterRemove).toContain(serverMember);
    expect(afterRemove).toContain('"after" : [ "comma, brace }" ]');
    expect(afterRemove).toContain('\r\n');
  });

  it('refuses an ambiguous duplicate MCP servers member without changing its bytes', async () => {
    const raw =
      '{\n  "mcpServers": { "human": { "type": "http", "url": "https://one.test/{,}" } },\n  "mcpServers": { "other": { "type": "http", "url": "https://two.test/{,}" } }\n}\n';
    await writeFile(mcpPath(), raw);

    const result = await add();

    expect(result.exitCode).toBe(1);
    expect(await readFile(mcpPath(), 'utf8')).toBe(raw);
    expect(await exists(declarationPath())).toBe(false);
  });

  it('refuses an ambiguous duplicate owned server key without changing its bytes', async () => {
    const raw =
      '{\n  "mcpServers": {\n    "figma": { "type": "http", "url": "https://first.test/mcp" },\n    "figma": { "type": "http", "url": "https://second.test/mcp" }\n  }\n}\n';
    await writeFile(mcpPath(), raw);

    const result = await add();

    expect(result.exitCode).toBe(1);
    expect(await readFile(mcpPath(), 'utf8')).toBe(raw);
    expect(await exists(declarationPath())).toBe(false);
  });

  it.each([
    ['first', ['figma', 'human\\u0041', 'human\\u0042']],
    ['middle', ['human\\u0041', 'figma', 'human\\u0042']],
    ['last', ['human\\u0041', 'human\\u0042', 'figma']],
  ] as const)(
    'removes an owned %s member without rewriting foreign MCP text',
    async (_position, order) => {
      expect((await add()).exitCode).toBe(0);
      const members = {
        figma: '"figma" : { "type" : "http", "url" : "https://mcp.figma.com/mcp" }',
        'human\\u0041': '"human\\u0041" : { "text" : "first {,}", "n" : 1e+02 }',
        'human\\u0042': '"human\\u0042" : { "text" : "last {,}", "n" : 1e+02 }',
      };
      const foreignRoot = '  "foreign\\u0052oot" : { "kept" : "braces {,}" }';
      const raw = `{\r\n${foreignRoot},\r\n  "mcpServers" : {\r\n    ${order
        .map((name) => members[name])
        .join(',\r\n    ')}\r\n  }\r\n}\r\n`;
      await writeFile(mcpPath(), raw);

      const result = await remove();
      const after = await readFile(mcpPath(), 'utf8');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(after).mcpServers).not.toHaveProperty('figma');
      expect(after).toContain(members['human\\u0041']);
      expect(after).toContain(members['human\\u0042']);
      expect(after).toContain(foreignRoot);
      expect(after).toContain('\r\n');
    },
  );
});
