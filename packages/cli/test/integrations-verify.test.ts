import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyIntegrations } from '../src/integrations/verify.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const FIGMA = { type: 'http', url: 'https://mcp.figma.com/mcp' };
const FIGMA_HASH = createHash('sha256').update(JSON.stringify(FIGMA)).digest('hex');
const BASIC_MEMORY = { command: 'uvx', args: ['basic-memory', 'mcp'] };
const BASIC_MEMORY_HASH = createHash('sha256').update(JSON.stringify(BASIC_MEMORY)).digest('hex');
const CODEX_BASE =
  '[agents]\ndefault_subagent_model = "gpt-5.6-terra"\n\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\n';

let repo: string;
let launchers: string;
let originalPATH: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-verify-'));
  launchers = await mkdtemp(path.join(tmpdir(), 'caf-integrations-verify-launchers-'));
  originalPATH = process.env.PATH;
  originalPath = process.env.Path;
});

afterEach(async () => {
  if (originalPATH === undefined) delete process.env.PATH;
  else process.env.PATH = originalPATH;
  if (originalPath === undefined) delete process.env.Path;
  else process.env.Path = originalPath;
  await removeFixture(repo);
  await removeFixture(launchers);
});

const declarationPath = () => path.join(repo, '.rig', 'integrations.json');
const claudePath = () => path.join(repo, '.mcp.json');
const codexPath = () => path.join(repo, '.codex', 'config.toml');
const uvxName = () => (process.platform === 'win32' ? 'uvx.exe' : 'uvx');

async function writeDeclaration(value: unknown): Promise<void> {
  await mkdir(path.dirname(declarationPath()), { recursive: true });
  await writeFile(declarationPath(), `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function selected(
  id: string,
  harnesses: string[],
  targets: Record<string, unknown> | undefined = undefined,
): Record<string, unknown> {
  return { id, selected: true, harnesses, ...(targets === undefined ? {} : { targets }) };
}

async function writeBasicMemoryForClaude(): Promise<void> {
  await writeDeclaration({
    schemaVersion: 1,
    integrations: [
      selected('basic-memory', ['claude-code'], {
        'claude-code': { entryHash: BASIC_MEMORY_HASH },
      }),
    ],
  });
  await writeFile(
    claudePath(),
    `${JSON.stringify({ mcpServers: { 'basic-memory': BASIC_MEMORY } }, null, 2)}\n`,
  );
}

async function writeBasicMemoryForCodex(): Promise<void> {
  const config =
    '[agents]\ndefault_subagent_model = "gpt-5.6-terra"\n\n' +
    '[mcp_servers.basic-memory]\ncommand = "uvx"\nargs = ["basic-memory", "mcp"]\n';
  await mkdir(path.dirname(codexPath()), { recursive: true });
  await writeFile(codexPath(), config);
  await writeDeclaration({
    schemaVersion: 1,
    targets: { codex: { fileHash: createHash('sha256').update(config).digest('hex') } },
    integrations: [selected('basic-memory', ['codex'])],
  });
}

function usePath(entry: string): void {
  process.env.PATH = entry;
  if (process.platform === 'win32') process.env.Path = entry;
}

describe('integration doctor verification (RP-21)', () => {
  it('reports a hash-proven Figma Claude entry as wiring healthy without claiming runtime, connectivity, or trust', async () => {
    await writeDeclaration({
      schemaVersion: 1,
      integrations: [
        selected('figma-mcp', ['claude-code'], { 'claude-code': { entryHash: FIGMA_HASH } }),
      ],
    });
    await writeFile(claudePath(), `${JSON.stringify({ mcpServers: { figma: FIGMA } }, null, 2)}\n`);
    const declarationBefore = await readFile(declarationPath(), 'utf8');
    const mcpBefore = await readFile(claudePath(), 'utf8');

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result.integrations).toEqual([
      {
        id: 'figma-mcp',
        harnesses: {
          'claude-code': {
            wiring: 'healthy',
            launcher: 'not-applicable',
            runtime: 'unverified',
            connectivity: 'not-observed',
            trust: 'not-observed',
          },
        },
      },
    ]);
    expect(await readFile(declarationPath(), 'utf8')).toBe(declarationBefore);
    expect(await readFile(claudePath(), 'utf8')).toBe(mcpBefore);
  });

  it.each([
    ['missing', undefined, 'missing'],
    ['changed by a user', { type: 'http', url: 'https://example.test/figma' }, 'drift'],
  ] as const)(
    'reports a %s Claude entry as wiring %s and preserves the observed file',
    async (_case, server, expectedWiring) => {
      await writeDeclaration({
        schemaVersion: 1,
        integrations: [
          selected('figma-mcp', ['claude-code'], { 'claude-code': { entryHash: FIGMA_HASH } }),
        ],
      });
      const observed = { mcpServers: server === undefined ? {} : { figma: server } };
      await writeFile(claudePath(), `${JSON.stringify(observed, null, 2)}\n`);
      const before = await readFile(claudePath(), 'utf8');

      const result = await verifyIntegrations({ repoDir: repo });

      expect(result.integrations[0]?.harnesses['claude-code']).toMatchObject({
        wiring: expectedWiring,
        runtime: 'unverified',
        connectivity: 'not-observed',
        trust: 'not-observed',
      });
      expect(await readFile(claudePath(), 'utf8')).toBe(before);
    },
  );

  it('calls the injected uvx locator only to report Basic Memory launcher wiring, never a verified runtime or connection', async () => {
    await writeDeclaration({
      schemaVersion: 1,
      integrations: [
        selected('basic-memory', ['claude-code'], {
          'claude-code': { entryHash: BASIC_MEMORY_HASH },
        }),
      ],
    });
    await writeFile(
      claudePath(),
      `${JSON.stringify({ mcpServers: { 'basic-memory': BASIC_MEMORY } }, null, 2)}\n`,
    );
    const calls: string[] = [];

    const result = await verifyIntegrations({
      repoDir: repo,
      locateLauncher: async (name: 'uvx') => {
        calls.push(name);
        return '/fixtures/uvx';
      },
    });

    expect(calls).toEqual(['uvx']);
    expect(result.integrations).toEqual([
      {
        id: 'basic-memory',
        harnesses: {
          'claude-code': {
            wiring: 'healthy',
            launcher: 'observed',
            runtime: 'unverified',
            connectivity: 'not-observed',
            trust: 'not-observed',
          },
        },
      },
    ]);
  });

  it('observes an executable reached through an absolute POSIX PATH symlink', async (ctx) => {
    skipUnless(ctx, process.platform !== 'win32', 'POSIX launcher permissions are required');
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await writeBasicMemoryForClaude();
    const target = path.join(launchers, 'trusted-uvx');
    await writeFile(target, 'fixture launcher');
    await chmod(target, 0o755);
    await symlink(target, path.join(launchers, 'uvx'), 'file');
    usePath(launchers);

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result.integrations[0]?.harnesses['claude-code']?.launcher).toBe('observed');
  });

  it('does not observe a non-executable POSIX uvx file on PATH', async (ctx) => {
    skipUnless(ctx, process.platform !== 'win32', 'POSIX launcher permissions are required');
    await writeBasicMemoryForClaude();
    await writeFile(path.join(launchers, 'uvx'), 'not executable');
    await chmod(path.join(launchers, 'uvx'), 0o644);
    usePath(launchers);

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result.integrations[0]?.harnesses['claude-code']?.launcher).toBe('missing');
  });

  it('ignores a relative PATH directory even when it contains an executable uvx', async () => {
    await writeBasicMemoryForClaude();
    const launcher = path.join(launchers, uvxName());
    await writeFile(launcher, 'fixture launcher');
    if (process.platform !== 'win32') await chmod(launcher, 0o755);
    const relative = path.relative(process.cwd(), launchers);
    expect(path.isAbsolute(relative)).toBe(false);
    usePath(relative);

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result.integrations[0]?.harnesses['claude-code']?.launcher).toBe('missing');
  });

  it.each([
    ['observed', '/fixtures/uvx'],
    ['missing', null],
  ] as const)(
    'reports Basic Memory Codex launcher %s through the same uvx observation',
    async (expected, located) => {
      await writeBasicMemoryForCodex();
      const calls: string[] = [];

      const result = await verifyIntegrations({
        repoDir: repo,
        locateLauncher: async (name: 'uvx') => {
          calls.push(name);
          return located;
        },
      });

      expect(calls).toEqual(['uvx']);
      expect(result.integrations[0]?.harnesses.codex?.launcher).toBe(expected);
    },
  );

  it('reports an identical Basic Memory stdio entry without a recorded hash as unowned and preserves it', async () => {
    await writeDeclaration({
      schemaVersion: 1,
      integrations: [selected('basic-memory', ['claude-code'])],
    });
    await writeFile(
      claudePath(),
      `${JSON.stringify({ mcpServers: { 'basic-memory': BASIC_MEMORY } }, null, 2)}\n`,
    );
    const before = await readFile(claudePath(), 'utf8');

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result.integrations[0]?.harnesses['claude-code']).toEqual({
      wiring: 'unowned',
      launcher: 'not-applicable',
      runtime: 'unverified',
      connectivity: 'not-observed',
      trust: 'not-observed',
    });
    expect(await readFile(claudePath(), 'utf8')).toBe(before);
  });

  it('uses the rolling Codex target file hash for wiring and never parses, edits, or connects to TOML', async () => {
    await mkdir(path.dirname(codexPath()), { recursive: true });
    await writeFile(codexPath(), CODEX_BASE);
    const hash = createHash('sha256').update(CODEX_BASE).digest('hex');
    await writeDeclaration({
      schemaVersion: 1,
      targets: { codex: { fileHash: hash } },
      integrations: [selected('figma-mcp', ['codex'])],
    });
    const before = await readFile(codexPath(), 'utf8');

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result.integrations[0]?.harnesses.codex).toEqual({
      wiring: 'healthy',
      launcher: 'not-applicable',
      runtime: 'unverified',
      connectivity: 'not-observed',
      trust: 'not-observed',
    });
    expect(await readFile(codexPath(), 'utf8')).toBe(before);
  });

  it('reports a manually changed Codex file as drift without writing a replacement config', async () => {
    await mkdir(path.dirname(codexPath()), { recursive: true });
    await writeFile(codexPath(), `${CODEX_BASE}# human edit\n`);
    const expectedHash = createHash('sha256').update(CODEX_BASE).digest('hex');
    await writeDeclaration({
      schemaVersion: 1,
      targets: { codex: { fileHash: expectedHash } },
      integrations: [selected('figma-mcp', ['codex'])],
    });
    const before = await readFile(codexPath(), 'utf8');

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result.integrations[0]?.harnesses.codex).toMatchObject({
      wiring: 'drift',
      connectivity: 'not-observed',
      trust: 'not-observed',
    });
    expect(await readFile(codexPath(), 'utf8')).toBe(before);
    expect(await exists(codexPath())).toBe(true);
  });

  it('reports an invalid declaration as an explicit doctor issue instead of silently treating it as no integrations', async () => {
    await mkdir(path.dirname(declarationPath()), { recursive: true });
    await writeFile(declarationPath(), '{ this is not JSON');

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result).toMatchObject({
      integrations: [],
      issues: [{ scope: 'declaration', status: 'invalid' }],
    });
  });

  it('reports a rejected provider without echoing its untrusted declaration id', async () => {
    const privateId = 'private-customer-integration-token';
    await writeDeclaration({
      schemaVersion: 1,
      integrations: [selected(privateId, ['claude-code'])],
    });
    const declarationBefore = await readFile(declarationPath(), 'utf8');

    const result = await verifyIntegrations({ repoDir: repo });

    expect(result).toMatchObject({
      integrations: [],
      issues: [{ scope: 'integration', status: 'rejected', reason: 'not-in-matrix' }],
    });
    expect(JSON.stringify(result)).not.toContain(privateId);
    expect(await readFile(declarationPath(), 'utf8')).toBe(declarationBefore);
  });
});
