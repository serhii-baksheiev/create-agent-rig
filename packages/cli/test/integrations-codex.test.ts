import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFileContents, initProject } from '../src/commands/init.js';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import { MANIFEST_REL, readManifest, serializeManifest, sha256 } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const CODEX_CONFIG_REL = '.codex/config.toml';
const INTEGRATIONS_REL = '.rig/integrations.json';
const FIGMA_SECTION = '[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"';
const ATLASSIAN_SECTION = '[mcp_servers.atlassian]\nurl = "https://mcp.atlassian.com/v2/mcp"';
const FIGMA_CLAUDE_ENTRY_HASH = createHash('sha256')
  .update(JSON.stringify({ type: 'http', url: 'https://mcp.figma.com/mcp' }))
  .digest('hex');

let repo: string;
let baseConfig: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-codex-'));
  await initProject(repo, {});
  baseConfig = (await initFileContents(repo)).get(CODEX_CONFIG_REL)!;
});

afterEach(async () => {
  await removeFixture(repo);
});

const configPath = () => path.join(repo, ...CODEX_CONFIG_REL.split('/'));
const statePath = () => path.join(repo, ...INTEGRATIONS_REL.split('/'));
const manifestPath = () => path.join(repo, ...MANIFEST_REL.split('/'));
const mcpPath = () => path.join(repo, '.mcp.json');

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function setup(
  verb: 'add' | 'apply' | 'remove',
  args: string[],
  confirm?: (plan: string) => Promise<boolean>,
) {
  return runIntegrationsCommand({ verb, args, cwd: repo, isTTY: true, confirm });
}

async function state(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath(), 'utf8')) as Record<string, unknown>;
}

function codexFileHash(value: Record<string, unknown>): string | undefined {
  return ((value.targets as Record<string, Record<string, string>> | undefined)?.codex ?? {})
    .fileHash;
}

async function addFigmaForBothHarnesses(): Promise<void> {
  const result = await setup('add', [
    'figma-mcp',
    '--harness',
    'claude-code',
    '--harness',
    'codex',
    '--yes',
    '--json',
  ]);
  expect(result.exitCode).toBe(0);
}

describe('setup integrations Codex adapter (RP-22)', () => {
  it('lists both release MCP providers as automatic Codex routes', async () => {
    const result = await runIntegrationsCommand({
      verb: 'list',
      args: ['--json'],
      cwd: repo,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      integrations: [
        { id: 'figma-mcp', routes: { 'claude-code': 'automatic', codex: 'automatic' } },
        { id: 'atlassian-mcp', routes: { 'claude-code': 'automatic', codex: 'automatic' } },
      ],
    });
  });

  it('renders both intended Codex providers from the init release baseline, rolls one root file hash, and does not rewrite the release manifest', async () => {
    const releaseManifestBefore = await readFile(manifestPath(), 'utf8');

    await addFigmaForBothHarnesses();
    expect(
      (await setup('add', ['atlassian-mcp', '--harness', 'codex', '--yes', '--json'])).exitCode,
    ).toBe(0);

    const config = await readFile(configPath(), 'utf8');
    expect(config).toContain('[agents]\ndefault_subagent_model = "gpt-5.6-terra"');
    expect(config).toContain(FIGMA_SECTION);
    expect(config).toContain(ATLASSIAN_SECTION);

    const declaration = await state();
    expect(codexFileHash(declaration)).toBe(sha256(config));
    expect(JSON.stringify(declaration).match(/"fileHash"/g)).toHaveLength(1);
    const figma = (declaration.integrations as Array<Record<string, unknown>>).find(
      (entry) => entry.id === 'figma-mcp',
    )!;
    expect(figma.harnesses).toEqual(['claude-code', 'codex']);
    expect(figma.targets).toEqual({ 'claude-code': { entryHash: FIGMA_CLAUDE_ENTRY_HASH } });
    const atlassian = (declaration.integrations as Array<Record<string, unknown>>).find(
      (entry) => entry.id === 'atlassian-mcp',
    )!;
    expect(atlassian.harnesses).toEqual(['codex']);
    expect(atlassian.targets).toBeUndefined();
    expect(await readFile(manifestPath(), 'utf8')).toBe(releaseManifestBefore);
  });

  it('refuses a foreign Codex config even when init recorded its matching hash as kept rather than shipped', async () => {
    const privateSentinel = 'private-token-must-not-appear-in-diagnostics';
    const foreign =
      '[agents]\ndefault_subagent_model = "human-choice"\n' + `# ${privateSentinel}\n`;
    await writeFile(configPath(), foreign);
    const manifest = await readManifest(repo);
    if (manifest === null)
      throw new Error('the init fixture must have a readable release manifest');
    expect(manifest.files[CODEX_CONFIG_REL]).toBe(sha256(baseConfig));
    const files = { ...manifest.files };
    delete files[CODEX_CONFIG_REL];
    await writeFile(
      manifestPath(),
      serializeManifest({
        ...manifest,
        files,
        kept: { ...(manifest.kept ?? {}), [CODEX_CONFIG_REL]: sha256(foreign) },
      }),
    );
    const configBefore = await readFile(configPath(), 'utf8');
    const manifestBefore = await readFile(manifestPath(), 'utf8');

    const result = await setup('add', ['figma-mcp', '--harness', 'codex', '--yes', '--json']);

    expect(result.exitCode).toBe(1);
    const diagnostic = `${JSON.parse(result.stdout).reason}${result.stderr}`;
    expect(diagnostic).toContain(FIGMA_SECTION);
    expect(diagnostic).not.toContain('human-choice');
    expect(diagnostic).not.toContain(privateSentinel);
    expect(await readFile(configPath(), 'utf8')).toBe(configBefore);
    expect(await readFile(manifestPath(), 'utf8')).toBe(manifestBefore);
    expect(await exists(statePath())).toBe(false);
  });

  it('refuses a manual TOML edit with the compiled managed Figma fragment and never echoes user config', async () => {
    await addFigmaForBothHarnesses();
    const foreignUrl = 'https://example.test/edited';
    const privateSentinel = 'private-token-must-not-appear-in-diagnostics';
    const edited =
      (await readFile(configPath(), 'utf8')).replace('https://mcp.figma.com/mcp', foreignUrl) +
      `# ${privateSentinel}\n`;
    await writeFile(configPath(), edited);
    const stateBefore = await readFile(statePath(), 'utf8');
    const manifestBefore = await readFile(manifestPath(), 'utf8');

    const result = await setup('remove', ['figma-mcp', '--yes']);

    expect(result.exitCode).toBe(1);
    const diagnostic = `${result.stdout}${result.stderr}`;
    expect(diagnostic).toContain(FIGMA_SECTION);
    expect(diagnostic).not.toContain(foreignUrl);
    expect(diagnostic).not.toContain(privateSentinel);
    expect(await readFile(configPath(), 'utf8')).toBe(edited);
    expect(await readFile(statePath(), 'utf8')).toBe(stateBefore);
    expect(await readFile(manifestPath(), 'utf8')).toBe(manifestBefore);
  });

  it('unions repeated Figma harness selections so final removal deletes both proven owned entries', async () => {
    expect(
      (await setup('add', ['figma-mcp', '--harness', 'claude-code', '--yes', '--json'])).exitCode,
    ).toBe(0);
    expect(
      (await setup('add', ['figma-mcp', '--harness', 'codex', '--yes', '--json'])).exitCode,
    ).toBe(0);
    const selected = (await state()).integrations as Array<Record<string, unknown>>;
    expect(selected).toEqual([
      expect.objectContaining({
        id: 'figma-mcp',
        harnesses: ['claude-code', 'codex'],
        targets: { 'claude-code': { entryHash: FIGMA_CLAUDE_ENTRY_HASH } },
      }),
    ]);

    expect((await setup('remove', ['figma-mcp', '--yes', '--json'])).exitCode).toBe(0);
    expect(await readFile(configPath(), 'utf8')).toBe(baseConfig);
    expect(JSON.parse(await readFile(mcpPath(), 'utf8'))).toEqual({ mcpServers: {} });
    expect((await state()).integrations).toEqual([]);
  });

  it('removes only hash-proven Codex wiring, retains the rolling hash after the last removal, and permits the next add', async () => {
    await addFigmaForBothHarnesses();
    expect(
      (await setup('add', ['atlassian-mcp', '--harness', 'codex', '--yes', '--json'])).exitCode,
    ).toBe(0);

    expect((await setup('remove', ['figma-mcp', '--yes', '--json'])).exitCode).toBe(0);
    const afterFigmaRemoval = await readFile(configPath(), 'utf8');
    expect(afterFigmaRemoval).not.toContain(FIGMA_SECTION);
    expect(afterFigmaRemoval).toContain(ATLASSIAN_SECTION);
    expect(codexFileHash(await state())).toBe(sha256(afterFigmaRemoval));

    expect((await setup('remove', ['atlassian-mcp', '--yes', '--json'])).exitCode).toBe(0);
    const afterLastRemoval = await readFile(configPath(), 'utf8');
    expect(afterLastRemoval).toBe(baseConfig);
    expect(codexFileHash(await state())).toBe(sha256(afterLastRemoval));

    expect(
      (await setup('add', ['figma-mcp', '--harness', 'codex', '--yes', '--json'])).exitCode,
    ).toBe(0);
    const afterReadd = await readFile(configPath(), 'utf8');
    expect(afterReadd).toContain(FIGMA_SECTION);
    expect(codexFileHash(await state())).toBe(sha256(afterReadd));
  });

  it('refuses an add after a previously owned Codex config is deleted, while explicit apply restores it after consent', async () => {
    await addFigmaForBothHarnesses();
    const releaseManifestBefore = await readFile(manifestPath(), 'utf8');
    const stateBeforeDeletion = await readFile(statePath(), 'utf8');
    await unlink(configPath());

    const add = await setup('add', ['atlassian-mcp', '--harness', 'codex', '--yes', '--json']);
    expect(add.exitCode).toBe(1);
    expect(await exists(configPath())).toBe(false);
    expect(await readFile(statePath(), 'utf8')).toBe(stateBeforeDeletion);

    const upgradePlan = await planUpgrade(repo, { history: { versions: [], files: {} } });
    expect(upgradePlan.actions.find((action) => action.rel === CODEX_CONFIG_REL)?.verdict).toBe(
      'deleted',
    );
    await applyUpgrade(repo, upgradePlan);
    expect(await exists(configPath())).toBe(false);
    expect(await readFile(statePath(), 'utf8')).toBe(stateBeforeDeletion);

    const apply = await setup('apply', ['--yes', '--json']);
    expect(apply.exitCode).toBe(0);
    const restored = await readFile(configPath(), 'utf8');
    expect(restored).toContain('[agents]\ndefault_subagent_model = "gpt-5.6-terra"');
    expect(restored).toContain(FIGMA_SECTION);
    expect(codexFileHash(await state())).toBe(sha256(restored));
    expect(await readFile(manifestPath(), 'utf8')).toBe(releaseManifestBefore);
  });

  it.each([
    [
      'Codex config',
      async () => writeFile(configPath(), `${baseConfig}\n# changed after the plan\n`),
      async () => readFile(configPath(), 'utf8'),
    ],
    [
      'integration declaration',
      async () => {
        await mkdir(path.dirname(statePath()), { recursive: true });
        await writeFile(statePath(), '{"schemaVersion":1,"integrations":[]}\n');
      },
      async () => readFile(statePath(), 'utf8'),
    ],
    [
      'release manifest',
      async () => writeFile(manifestPath(), '{"changed":"after-plan"}\n'),
      async () => readFile(manifestPath(), 'utf8'),
    ],
  ] as const)(
    'refuses a changed-after-plan %s without mutating another setup file',
    async (_label, change, readChanged) => {
      const configBefore = await readFile(configPath(), 'utf8');
      const manifestBefore = await readFile(manifestPath(), 'utf8');
      let changedBytes = '';
      let consentWasRequested = false;

      const result = await setup('add', ['figma-mcp', '--harness', 'codex'], async () => {
        consentWasRequested = true;
        await change();
        changedBytes = await readChanged();
        return true;
      });

      expect(consentWasRequested).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(await readChanged()).toBe(changedBytes);
      if (_label !== 'Codex config')
        expect(await readFile(configPath(), 'utf8')).toBe(configBefore);
      if (_label !== 'release manifest')
        expect(await readFile(manifestPath(), 'utf8')).toBe(manifestBefore);
      if (_label !== 'integration declaration') expect(await exists(statePath())).toBe(false);
    },
  );

  it('never mutates an initialized Codex config, release manifest, or declaration for JSON setup without --yes', async () => {
    const configBefore = await readFile(configPath(), 'utf8');
    const manifestBefore = await readFile(manifestPath(), 'utf8');

    const result = await setup('add', ['figma-mcp', '--harness', 'codex', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'refused',
      reason: 'yes-required-for-json-or-noninteractive',
    });
    expect(await readFile(configPath(), 'utf8')).toBe(configBefore);
    expect(await readFile(manifestPath(), 'utf8')).toBe(manifestBefore);
    expect(await exists(statePath())).toBe(false);
  });
});
