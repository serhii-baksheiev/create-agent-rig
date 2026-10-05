// RP-416: `setup add|remove probity` — the CLI side of the opt-in Probity
// integration. Probity is neither an MCP server (no `.mcp.json`/Codex config
// entry) nor upstream-managed like Spec Kit: Rig generates a local
// `probity.config.mjs`, records its hash as `configHash` on the declaration
// entry (the same ownership shape every other provider's `targets.*.entryHash`
// already uses), and never runs `npm install` itself — that step stays
// manual, named in the plan.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const PROBITY = 'probity';
const VERSION = '1.10.1';
const DECLARATION_REL = '.rig/integrations.json';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-probity-command-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const declarationPath = () => path.join(repo, ...DECLARATION_REL.split('/'));
const mjsConfigPath = () => path.join(repo, 'probity.config.mjs');

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

/** True when `source` imports every name in `names` from `'@nizos/probity'`. */
function importsFromProbity(source: string, names: string[]): boolean {
  const imported = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@nizos\/probity['"]/g)) {
    for (const part of match[1]!.split(','))
      imported.add(
        part
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim(),
      );
  }
  return names.every((name) => imported.has(name));
}

describe('setup add probity', () => {
  it('dry-run plans the pinned-version declaration entry, the new config file, and a manual, unexecuted npm install step', async () => {
    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--dry-run', '--json'],
      isTTY: true,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ outcome: 'planned', dryRun: true, changed: false });
    expect(typeof body.plan).toBe('string');
    expect(body.plan).toContain(PROBITY);
    expect(body.plan).toContain(VERSION);
    expect(body.plan).toContain('probity.config.mjs');
    expect(body.plan).toContain(`npm install -D @nizos/probity@${VERSION}`);
    expect(await exists(declarationPath())).toBe(false);
    expect(await exists(mjsConfigPath())).toBe(false);
    expect(await exists(path.join(repo, 'node_modules', '@nizos', 'probity'))).toBe(false);
  });

  it('with --yes writes the declaration entry with a configHash of the generated config, and touches no other managed file', async () => {
    const packageJsonPath = path.join(repo, 'package.json');
    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const codexHooksPath = path.join(repo, '.codex', 'hooks.json');
    await writeFile(packageJsonPath, '{}\n');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{}\n');
    await mkdir(path.dirname(codexHooksPath), { recursive: true });
    await writeFile(codexHooksPath, '{}\n');
    const [beforePackageJson, beforeSettings, beforeCodexHooks] = await Promise.all([
      readFile(packageJsonPath),
      readFile(settingsPath),
      readFile(codexHooksPath),
    ]);

    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const configBytes = await readFile(mjsConfigPath());
    const expectedHash = createHash('sha256').update(configBytes).digest('hex');
    const declaration = JSON.parse(await readFile(declarationPath(), 'utf8'));
    expect(declaration.integrations).toEqual([
      {
        id: PROBITY,
        version: VERSION,
        harnesses: ['claude-code'],
        selected: true,
        configHash: expectedHash,
      },
    ]);
    const configText = configBytes.toString('utf8');
    expect(importsFromProbity(configText, ['defineConfig', 'enforceTdd'])).toBe(true);
    expect(configText).toMatch(/enforceTdd\(/);
    expect(configText).toMatch(/files\s*:\s*\[/);
    expect(await readFile(packageJsonPath)).toEqual(beforePackageJson);
    expect(await readFile(settingsPath)).toEqual(beforeSettings);
    expect(await readFile(codexHooksPath)).toEqual(beforeCodexHooks);
    expect(await exists(path.join(repo, 'node_modules', '@nizos', 'probity'))).toBe(false);
  });

  it('refuses without --yes in JSON/non-interactive mode and writes nothing', async () => {
    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--json'],
      isTTY: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'refused',
      reason: 'yes-required-for-json-or-noninteractive',
    });
    expect(await exists(declarationPath())).toBe(false);
    expect(await exists(mjsConfigPath())).toBe(false);
  });

  it('refuses with probity-config-exists when a config file already exists and --adopt is not given', async () => {
    const existing = 'export default {}\n';
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    await writeFile(tsConfigPath, existing);

    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'refused',
      reason: 'probity-config-exists',
    });
    expect(await readFile(tsConfigPath, 'utf8')).toBe(existing);
    expect(await exists(declarationPath())).toBe(false);
  });

  it('adopts an existing config with --adopt, writing a declaration entry without configHash and leaving the config byte-identical', async () => {
    const existing = 'export default {}\n';
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    await writeFile(tsConfigPath, existing);

    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--adopt', '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const declaration = JSON.parse(await readFile(declarationPath(), 'utf8'));
    expect(declaration.integrations).toEqual([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    expect(await readFile(tsConfigPath, 'utf8')).toBe(existing);
  });

  it('refuses a requested version other than the pinned 1.10.1, naming the version problem rather than the generic unknown-provider refusal, and writes nothing', async () => {
    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--version', '1.0.0', '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body.outcome).toBe('refused');
    // Once probity is a known provider, a bad --version must be refused for
    // its own reason, not fall back to the generic "unknown provider" one.
    expect(body.reason).not.toBe('not-in-matrix');
    expect(body.reason).toMatch(/version/);
    expect(await exists(declarationPath())).toBe(false);
    expect(await exists(mjsConfigPath())).toBe(false);
  });
});

describe('setup remove probity', () => {
  it('removes a well-formed installation: deletes the declaration entry and the generated config file', async () => {
    const configBytes = Buffer.from(
      "import { defineConfig, enforceTdd } from '@nizos/probity';\n" +
        "export default defineConfig({ hooks: [enforceTdd({ files: ['src/**'] })] });\n",
    );
    await writeFile(mjsConfigPath(), configBytes);
    const configHash = createHash('sha256').update(configBytes).digest('hex');
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true, configHash },
    ]);

    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'remove',
      args: [PROBITY, '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'removed', id: PROBITY });
    expect(JSON.parse(await readFile(declarationPath(), 'utf8')).integrations).toEqual([]);
    expect(await exists(mjsConfigPath())).toBe(false);
  });

  it('on a hash mismatch (hand-edited config) keeps the config byte-identical and names it in the result, removing only the declaration entry', async () => {
    const originalBytes = Buffer.from(
      "import { defineConfig, enforceTdd } from '@nizos/probity';\n" +
        "export default defineConfig({ hooks: [enforceTdd({ files: ['src/**'] })] });\n",
    );
    const recordedHash = createHash('sha256').update(originalBytes).digest('hex');
    const editedBytes = Buffer.concat([originalBytes, Buffer.from('// edited by hand\n')]);
    await writeFile(mjsConfigPath(), editedBytes);
    await writeDeclaration([
      {
        id: PROBITY,
        version: VERSION,
        harnesses: ['claude-code'],
        selected: true,
        configHash: recordedHash,
      },
    ]);

    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'remove',
      args: [PROBITY, '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.outcome).toBe('removed');
    expect(JSON.stringify(body)).toContain('probity.config.mjs');
    expect(JSON.parse(await readFile(declarationPath(), 'utf8')).integrations).toEqual([]);
    expect(await readFile(mjsConfigPath())).toEqual(editedBytes);
  });

  it('keeps an adopted config (no configHash on the declaration entry) untouched', async () => {
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    const bytes = Buffer.from('export default {}\n');
    await writeFile(tsConfigPath, bytes);
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);

    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'remove',
      args: [PROBITY, '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe('removed');
    expect(JSON.parse(await readFile(declarationPath(), 'utf8')).integrations).toEqual([]);
    expect(await readFile(tsConfigPath)).toEqual(bytes);
  });
});

describe('the generated probity.config.mjs', () => {
  // Independent oracle: upstream's documented config shape (Probity 1.10.1
  // docs/configuration.md) — `defineConfig({ rules: [{ files, rules: [enforceTdd()] }] })`.
  // The config is imported against a stand-in `@nizos/probity` whose
  // `enforceTdd` returns a marker, so the exported object is compared with
  // that shape rather than with the generator's own text.
  it('exports the upstream-documented shape: one { files, rules: [enforceTdd()] } block', async () => {
    const { PROBITY_CONFIG_CONTENTS } = await import('../src/integrations/probity.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'probity-config-shape-'));
    try {
      const pkg = path.join(dir, 'node_modules', '@nizos', 'probity');
      await mkdir(pkg, { recursive: true });
      await writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: '@nizos/probity', type: 'module', exports: './index.js' }),
      );
      await writeFile(
        path.join(pkg, 'index.js'),
        "export const defineConfig = (config) => config;\nexport const enforceTdd = (...args) => ({ marker: 'enforceTdd', args });\n",
      );
      const configFile = path.join(dir, 'probity.config.mjs');
      await writeFile(configFile, PROBITY_CONFIG_CONTENTS);

      const loaded = (await import(`${pathToFileURL(configFile).href}?t=${Date.now()}`)) as {
        default: unknown;
      };
      expect(loaded.default).toEqual({
        rules: [
          {
            files: expect.arrayContaining(['src/**']) as unknown,
            rules: [{ marker: 'enforceTdd', args: [] }],
          },
        ],
      });
    } finally {
      await removeFixture(dir);
    }
  });
});
