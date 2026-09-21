import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFileContents, initProject } from '../src/commands/init.js';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { sha256 } from '../src/lib/manifest.js';
import { subsystemsManifestPath } from '../src/lib/subsystems.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const BASIC_MEMORY = { command: 'uvx', args: ['basic-memory', 'mcp'] };
const BASIC_MEMORY_TOML =
  '[mcp_servers.basic-memory]\ncommand = "uvx"\nargs = ["basic-memory", "mcp"]';
const BASIC_MEMORY_HASH = createHash('sha256').update(JSON.stringify(BASIC_MEMORY)).digest('hex');
const CODEX_CONFIG = '.codex/config.toml';

type CommandOptionsWithEnv = Parameters<typeof runIntegrationsCommand>[0] & {
  env?: NodeJS.ProcessEnv;
};

let repo: string;
let home: string;
let baseCodexConfig: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-basic-memory-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-basic-memory-home-'));
  await initProject(repo, {});
  baseCodexConfig = (await initFileContents(repo)).get(CODEX_CONFIG)!;
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

const declarationPath = () => path.join(repo, '.rig', 'integrations.json');
const claudePath = () => path.join(repo, '.mcp.json');
const codexPath = () => path.join(repo, '.codex', 'config.toml');
const providerData = () => path.join(home, 'basic-memory', 'private-data.sqlite');
const fixtureEnv = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, APPDATA: home });

function setup(verb: 'add' | 'apply' | 'remove', args: string[], env = fixtureEnv()) {
  const options: CommandOptionsWithEnv = { verb, args, cwd: repo, isTTY: true, env };
  return runIntegrationsCommand(options);
}

describe('Basic Memory integration wiring (RP-22)', () => {
  it('writes literal uvx MCP wiring for Claude and Codex, while retaining one rolling Codex hash', async () => {
    const result = await setup('add', [
      'basic-memory',
      '--harness',
      'claude-code',
      '--harness',
      'codex',
      '--yes',
      '--json',
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(claudePath(), 'utf8'))).toEqual({
      mcpServers: { 'basic-memory': BASIC_MEMORY },
    });
    const codex = await readFile(codexPath(), 'utf8');
    expect(codex).toContain(BASIC_MEMORY_TOML);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      targets: { codex: { fileHash: sha256(codex) } },
      integrations: [
        {
          id: 'basic-memory',
          selected: true,
          harnesses: ['claude-code', 'codex'],
          targets: { 'claude-code': { entryHash: BASIC_MEMORY_HASH } },
        },
      ],
    });
  });

  it('removes only its owned wiring and intent, retaining provider data and the final Codex file hash', async () => {
    await mkdir(path.dirname(providerData()), { recursive: true });
    await writeFile(providerData(), 'private Basic Memory data');
    expect(
      (
        await setup('add', [
          'basic-memory',
          '--harness',
          'claude-code',
          '--harness',
          'codex',
          '--yes',
          '--json',
        ])
      ).exitCode,
    ).toBe(0);

    const result = await setup('remove', ['basic-memory', '--yes', '--json']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(claudePath(), 'utf8'))).toEqual({ mcpServers: {} });
    expect(await readFile(codexPath(), 'utf8')).toBe(baseCodexConfig);
    expect(JSON.parse(await readFile(declarationPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      targets: { codex: { fileHash: sha256(baseCodexConfig) } },
      integrations: [],
    });
    expect(await readFile(providerData(), 'utf8')).toBe('private Basic Memory data');
  });

  it('plans only wiring and explains the per-machine, unverified Basic Memory boundary', async () => {
    const result = await setup('add', ['basic-memory', '--harness', 'claude-code', '--dry-run']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('wiring-only preview');
    expect(result.stdout).toContain('local, per-machine storage');
    expect(result.stdout).toContain('does not automatically access Memory');
    expect(result.stdout).toContain('does not synchronize across machines');
    expect(result.stdout).toContain('uvx is a launcher, not a verified runtime');
  });

  it('allows Basic Memory beside an existing machine Memory subsystem and warns without reading its provider data', async () => {
    const env = fixtureEnv();
    const manifest = subsystemsManifestPath(env, process.platform);
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(
      manifest,
      `${JSON.stringify({
        schemaVersion: 1,
        entries: {
          memory: {
            memoryRoot: path.join(home, 'custom-memory'),
            invocation: [process.execPath, path.join(home, 'custom-memory', 'memory.mjs')],
            contractMajor: 1,
            memoryRef: null,
            installedVersion: '0.1.0',
          },
        },
      })}\n`,
    );
    await mkdir(path.dirname(providerData()), { recursive: true });
    await writeFile(providerData(), 'do not inspect this provider data');

    const result = await setup(
      'add',
      ['basic-memory', '--harness', 'claude-code', '--dry-run'],
      env,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('existing Memory subsystem');
    expect(result.stdout).toContain('coexist');
    expect(await readFile(providerData(), 'utf8')).toBe('do not inspect this provider data');
  });
});
