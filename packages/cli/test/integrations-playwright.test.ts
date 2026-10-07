// RP-313: `playwright-mcp` (Playwright MCP) is a new release MCP provider —
// routed `automatic` for both harnesses — that wires the pinned, official
// `@playwright/mcp` launcher through `npx`. This mirrors the shape of
// `integrations-basic-memory.test.ts` (wiring-only setup add/remove, a
// launcher disclaimer in the plan text) and `integrations-intent.test.ts`
// (a foreign MCP entry already named `playwright` is refused, never
// adopted). `PLAYWRIGHT_MCP_VERSION` is the one pinned-version constant this
// file expects somewhere under `src/integrations/` (e.g.
// `src/integrations/playwright.ts`) — the written `.mcp.json` entry and the
// Codex TOML section are both read back from it rather than from a literal
// restated here, so a future version bump in production is pinned by this
// test rather than silently drifting from it.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFileContents, initProject } from '../src/commands/init.js';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { REGISTRY } from '../src/integrations/registry.js';
import { PLAYWRIGHT_MCP_VERSION } from '../src/integrations/playwright.js';
import { sha256 } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const PLAYWRIGHT_SERVER = { command: 'npx', args: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`] };
const PLAYWRIGHT_ENTRY_HASH = createHash('sha256')
  .update(JSON.stringify(PLAYWRIGHT_SERVER))
  .digest('hex');
const PLAYWRIGHT_TOML = `[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"]`;
const CODEX_CONFIG = '.codex/config.toml';

let repo: string;
let baseCodexConfig: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-playwright-mcp-'));
  await initProject(repo, {});
  baseCodexConfig = (await initFileContents(repo)).get(CODEX_CONFIG)!;
});

afterEach(async () => {
  await removeFixture(repo);
});

const declarationPath = () => path.join(repo, '.rig', 'integrations.json');
const claudePath = () => path.join(repo, '.mcp.json');
const codexPath = () => path.join(repo, '.codex', 'config.toml');

function setup(verb: 'add' | 'apply' | 'remove', args: string[]) {
  return runIntegrationsCommand({ verb, args, cwd: repo, isTTY: true });
}

describe('playwright-mcp is the pinned version 0.0.83 (RP-313 design)', () => {
  it('pins the exact npx package version this item specifies', () => {
    expect(PLAYWRIGHT_MCP_VERSION).toBe('0.0.83');
  });
});

describe('setup list declares playwright-mcp as "Playwright MCP" (RP-313)', () => {
  it('is in the registry with the expected display name and both routes automatic', () => {
    const entry = REGISTRY.find((candidate) => candidate.id === 'playwright-mcp');
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe('Playwright MCP');
    expect(entry?.routes).toEqual({ 'claude-code': 'automatic', codex: 'automatic' });
  });
});

describe('Playwright MCP integration wiring (RP-313)', () => {
  it('writes literal npx MCP wiring for Claude and Codex, with one rolling Codex hash', async () => {
    const result = await setup('add', [
      'playwright-mcp',
      '--harness',
      'claude-code',
      '--harness',
      'codex',
      '--yes',
      '--json',
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(claudePath(), 'utf8'))).toEqual({
      mcpServers: { playwright: PLAYWRIGHT_SERVER },
    });
    const codex = await readFile(codexPath(), 'utf8');
    expect(codex).toContain(PLAYWRIGHT_TOML);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      targets: { codex: { fileHash: sha256(codex) } },
      integrations: [
        {
          id: 'playwright-mcp',
          selected: true,
          harnesses: ['claude-code', 'codex'],
          targets: { 'claude-code': { entryHash: PLAYWRIGHT_ENTRY_HASH } },
        },
      ],
    });
  });

  it('removes only its owned wiring and intent, reverting Codex to the release-baseline hash', async () => {
    expect(
      (
        await setup('add', [
          'playwright-mcp',
          '--harness',
          'claude-code',
          '--harness',
          'codex',
          '--yes',
          '--json',
        ])
      ).exitCode,
    ).toBe(0);

    const result = await setup('remove', ['playwright-mcp', '--yes', '--json']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(claudePath(), 'utf8'))).toEqual({ mcpServers: {} });
    expect(await readFile(codexPath(), 'utf8')).toBe(baseCodexConfig);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      targets: { codex: { fileHash: sha256(baseCodexConfig) } },
      integrations: [],
    });
  });

  it('plans only wiring and names npx as the launcher, never a verified runtime', async () => {
    const result = await setup('add', ['playwright-mcp', '--harness', 'claude-code', '--dry-run']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('npx is a launcher, not a verified runtime');
  });

  // RP-313 gate round 2: `npx @playwright/mcp@<version>` fetches the package
  // from the npm registry at first harness launch — this CLI pins the
  // version but never vendors or verifies the package itself, so the plan's
  // own disclaimer must say where that launch actually reaches, the same
  // way it already names npx as "a launcher, not a verified runtime".
  it('names the npm registry as what npx actually fetches the package from at first launch', async () => {
    const result = await setup('add', ['playwright-mcp', '--harness', 'claude-code', '--dry-run']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm registry');
  });

  it('with --harness codex writes exactly the pinned command/args TOML section', async () => {
    const result = await setup('add', ['playwright-mcp', '--harness', 'codex', '--yes', '--json']);

    expect(result.exitCode, result.stderr).toBe(0);
    const codex = await readFile(codexPath(), 'utf8');
    expect(codex).toContain(PLAYWRIGHT_TOML);
  });

  it('refuses when a foreign "playwright" MCP entry already exists, writing nothing', async () => {
    const foreign = {
      mcpServers: { playwright: { command: 'node', args: ['some-other-playwright-server.js'] } },
    };
    await writeFile(claudePath(), `${JSON.stringify(foreign, null, 2)}\n`);

    const result = await setup('add', [
      'playwright-mcp',
      '--harness',
      'claude-code',
      '--yes',
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(await readFile(claudePath(), 'utf8'))).toEqual(foreign);
    await expect(readFile(declarationPath(), 'utf8')).rejects.toThrow();
  });
});

// RP-313 design: "no second scheduler/state machine" — adding Playwright MCP
// writes exactly the three files every other plain MCP provider writes, and
// creates no new file anywhere else in the installed tree (in particular,
// nothing new under `.claude/scripts`, `.claude/hooks`, or `.rig/` besides
// `integrations.json`).
describe('adding playwright-mcp creates no new scheduler/state machine (RP-313)', () => {
  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      }),
    );
    return files.flat();
  }

  async function snapshotTree(
    dir: string,
  ): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const files = await walk(dir);
    const out = new Map<string, { size: number; mtimeMs: number }>();
    for (const file of files) {
      const info = await stat(file);
      out.set(path.relative(dir, file).split(path.sep).join('/'), {
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
    return out;
  }

  it.each([
    ['claude-code', ['.mcp.json', '.rig/integrations.json']],
    ['codex', ['.codex/config.toml', '.rig/integrations.json']],
    ['claude-code+codex', ['.codex/config.toml', '.mcp.json', '.rig/integrations.json']],
  ] as const)(
    'changes exactly the expected files for --harness %s',
    async (label, expectedChanged) => {
      const before = await snapshotTree(repo);
      const harnessArgs =
        label === 'claude-code+codex'
          ? ['--harness', 'claude-code', '--harness', 'codex']
          : ['--harness', label];

      const result = await setup('add', ['playwright-mcp', ...harnessArgs, '--yes', '--json']);
      expect(result.exitCode, result.stderr).toBe(0);

      const after = await snapshotTree(repo);
      const changedOrAdded = [...after.keys()].filter((rel) => {
        const was = before.get(rel);
        const is = after.get(rel)!;
        return was === undefined || was.size !== is.size || was.mtimeMs !== is.mtimeMs;
      });
      const removed = [...before.keys()].filter((rel) => !after.has(rel));

      expect(removed).toEqual([]);
      expect(changedOrAdded.sort()).toEqual([...expectedChanged].sort());
    },
  );
});
