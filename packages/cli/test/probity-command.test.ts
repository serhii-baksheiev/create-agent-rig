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
import { initProject } from '../src/commands/init.js';
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

  // RP-416 round 2, point 1: probity is neither an MCP server nor rendered
  // into .codex/config.toml, so a Codex MCP provider added afterward must
  // not be refused on probity's account. `renderCodexConfig` is called with
  // the FULL entries list (not just the newly-selected ones), and today it
  // filters only `entry.id !== 'spec-kit'` — a probity entry with a codex
  // harness still matches that filter and reaches `codexSection('probity')`,
  // which falls through to `serverFor` and throws `not-in-matrix`.
  it('lets a Codex MCP provider be added afterward: renderCodexConfig must not treat a probity entry as an MCP server', async () => {
    await initProject(repo, {});

    const addedProbity = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'codex', '--yes', '--json'],
      isTTY: false,
    });
    expect(addedProbity.exitCode, addedProbity.stderr).toBe(0);

    const addedFigma = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: ['figma-mcp', '--harness', 'codex', '--yes', '--json'],
      isTTY: false,
    });

    expect(addedFigma.exitCode, addedFigma.stderr).toBe(0);
    const codexConfig = await readFile(path.join(repo, '.codex', 'config.toml'), 'utf8');
    expect(codexConfig).toMatch(/\[mcp_servers\.figma\]/);
    expect(codexConfig).not.toMatch(/\[mcp_servers\.probity\]/);
  });

  // RP-416 round 2, point 2(a): re-adding probity for a second harness, once
  // Rig has already generated the config and recorded its hash, must extend
  // `harnesses` rather than refuse — the config on disk is Rig's own
  // (hash-matching), so there is nothing for `--adopt` to adopt. Today the
  // `existingRel !== undefined && !values.adopt` refusal fires regardless of
  // whether the hash matches, so this is refused with `probity-config-exists`.
  it('setup add probity --harness codex --yes after a Rig-generated, hash-matching claude-code config extends harnesses and leaves the config byte-identical', async () => {
    const first = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--yes', '--json'],
      isTTY: false,
    });
    expect(first.exitCode, first.stderr).toBe(0);
    const beforeBytes = await readFile(mjsConfigPath());
    const beforeDeclaration = JSON.parse(await readFile(declarationPath(), 'utf8'));
    const configHash = (beforeDeclaration.integrations[0] as { configHash: string }).configHash;

    const second = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'codex', '--yes', '--json'],
      isTTY: false,
    });

    expect(second.exitCode, second.stderr).toBe(0);
    const declaration = JSON.parse(await readFile(declarationPath(), 'utf8'));
    expect(declaration.integrations).toEqual([
      {
        id: PROBITY,
        version: VERSION,
        harnesses: ['claude-code', 'codex'],
        selected: true,
        configHash,
      },
    ]);
    expect(await readFile(mjsConfigPath())).toEqual(beforeBytes);
  });
});

// RP-416 round 2, point 2(b)/(c): `setup apply`, with or without an explicit
// `probity` id, must also be idempotent over an already-added, hash-matching
// Rig-owned config — it is not a provider-selection command and carries no
// `--adopt` flag at all, so today it hits the exact same unconditional
// `probity-config-exists` refusal as a plain re-`add` without `--adopt`.
describe('setup apply probity (idempotent over a Rig-owned, hash-matching config)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'caf-probity-apply-'));
  });

  afterEach(async () => {
    await removeFixture(repo);
  });

  it.each([
    ['no id', [] as string[]],
    ['an explicit probity id', [PROBITY]],
  ])(
    'setup apply %s --yes succeeds as a no-op once probity has already been added',
    async (_label, extraPositionals) => {
      const added = await runIntegrationsCommand({
        cwd: repo,
        verb: 'add',
        args: [PROBITY, '--harness', 'claude-code', '--yes', '--json'],
        isTTY: false,
      });
      expect(added.exitCode, added.stderr).toBe(0);
      const beforeBytes = await readFile(path.join(repo, 'probity.config.mjs'));
      const beforeDeclaration = await readFile(
        path.join(repo, ...DECLARATION_REL.split('/')),
        'utf8',
      );

      const result = await runIntegrationsCommand({
        cwd: repo,
        verb: 'apply',
        args: [...extraPositionals, '--yes', '--json'],
        isTTY: false,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(await readFile(path.join(repo, 'probity.config.mjs'))).toEqual(beforeBytes);
      expect(await readFile(path.join(repo, ...DECLARATION_REL.split('/')), 'utf8')).toBe(
        beforeDeclaration,
      );
    },
  );
});

describe('setup add/apply probity over a config the declaration already records as not Rig-owned', () => {
  const add = (args: string[]) =>
    runIntegrationsCommand({ cwd: repo, verb: 'add', args, isTTY: false });
  const apply = () =>
    runIntegrationsCommand({ cwd: repo, verb: 'apply', args: ['--yes', '--json'], isTTY: false });
  const declarationText = () => readFile(declarationPath(), 'utf8');

  it('setup apply after add --adopt succeeds and changes nothing', async () => {
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    await writeFile(tsConfigPath, 'export default {}\n');
    const adopted = await add([PROBITY, '--harness', 'claude-code', '--adopt', '--yes', '--json']);
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    const before = await declarationText();

    const result = await apply();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(await declarationText()).toBe(before);
    expect(await readFile(tsConfigPath, 'utf8')).toBe('export default {}\n');
  });

  it("setup apply after Rig's generated config was hand-edited succeeds without rewriting it", async () => {
    const added = await add([PROBITY, '--harness', 'claude-code', '--yes', '--json']);
    expect(added.exitCode, added.stderr).toBe(0);
    const edited = `${await readFile(mjsConfigPath(), 'utf8')}// mine\n`;
    await writeFile(mjsConfigPath(), edited);
    const before = await declarationText();

    const result = await apply();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(mjsConfigPath(), 'utf8')).toBe(edited);
    expect(await declarationText()).toBe(before);
  });

  it('a repeated add for another harness after add --adopt needs no second --adopt and leaves the config alone', async () => {
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    await writeFile(tsConfigPath, 'export default {}\n');
    const adopted = await add([PROBITY, '--harness', 'claude-code', '--adopt', '--yes', '--json']);
    expect(adopted.exitCode, adopted.stderr).toBe(0);

    const result = await add([PROBITY, '--harness', 'codex', '--yes', '--json']);

    expect(result.exitCode, result.stderr).toBe(0);
    const declaration = JSON.parse(await declarationText());
    expect(declaration.integrations).toEqual([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code', 'codex'], selected: true },
    ]);
    expect(await readFile(tsConfigPath, 'utf8')).toBe('export default {}\n');
  });

  it("add --adopt over Rig's hand-edited config takes ownership: the entry loses its configHash", async () => {
    const added = await add([PROBITY, '--harness', 'claude-code', '--yes', '--json']);
    expect(added.exitCode, added.stderr).toBe(0);
    const edited = `${await readFile(mjsConfigPath(), 'utf8')}// mine\n`;
    await writeFile(mjsConfigPath(), edited);

    const result = await add([PROBITY, '--harness', 'claude-code', '--adopt', '--yes', '--json']);

    expect(result.exitCode, result.stderr).toBe(0);
    const declaration = JSON.parse(await declarationText());
    expect(declaration.integrations).toEqual([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    expect(await readFile(mjsConfigPath(), 'utf8')).toBe(edited);
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

  // RP-416 round 2, point 8: an adopted config is kept untouched on remove
  // (asserted above), but today's `probityConfigKept` field is only ever set
  // in the hand-edited-hash-mismatch branch
  // (`existingRel !== undefined && probity.configHash !== undefined &&
  // !matches`) — an adopted entry has no `configHash` at all, so that
  // condition is false and the field is omitted even though the file was
  // just as deliberately kept. The caller reading the JSON result has no way
  // to learn WHICH file was preserved.
  it('names the kept config in the JSON result for an adopted config too, not only for a hand-edited hash mismatch', async () => {
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    const handWritten = Buffer.from('export default {}\n');
    await writeFile(tsConfigPath, handWritten);

    const added = await runIntegrationsCommand({
      cwd: repo,
      verb: 'add',
      args: [PROBITY, '--harness', 'claude-code', '--adopt', '--yes', '--json'],
      isTTY: false,
    });
    expect(added.exitCode, added.stderr).toBe(0);

    const result = await runIntegrationsCommand({
      cwd: repo,
      verb: 'remove',
      args: [PROBITY, '--yes', '--json'],
      isTTY: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.outcome).toBe('removed');
    expect(body.probityConfigKept).toBe('probity.config.ts');
    expect(await readFile(tsConfigPath)).toEqual(handWritten);
  });

  // RP-416 round 2, point 6(a): `findProbityConfig` returns the FIRST
  // filename it finds, in `CONFIG_CANDIDATES` discovery order
  // (`probity.config.ts` before `.mjs`) — so when both a hand-written `.ts`
  // and Rig's own generated `.mjs` exist side by side, remove judges the
  // `.ts` file against the recorded hash (a mismatch, since the hash was
  // computed over the `.mjs` bytes), decides to KEEP it, and never even
  // looks at the `.mjs` file at all. The `.mjs` Rig actually generated is
  // left on disk, undeleted.
  it('removes only the Rig-generated probity.config.mjs when a hand-written probity.config.ts also exists alongside it, leaving the .ts byte-identical', async () => {
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    const handWritten = Buffer.from("export default { hooks: ['hand-written'] };\n");
    await writeFile(tsConfigPath, handWritten);

    const mjsBytes = Buffer.from(
      "import { defineConfig, enforceTdd } from '@nizos/probity';\n" +
        "export default defineConfig({ rules: [{ files: ['src/**'], rules: [enforceTdd()] }] });\n",
    );
    await writeFile(mjsConfigPath(), mjsBytes);
    const configHash = createHash('sha256').update(mjsBytes).digest('hex');
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
    expect(await exists(mjsConfigPath())).toBe(false);
    expect(await readFile(tsConfigPath)).toEqual(handWritten);
  });

  // RP-416 round 2, point 6(b): the inverse danger of the same bug. Remove
  // must only ever judge Rig's OWN filename (`probity.config.mjs`) against
  // the recorded hash — never any recognised-but-not-Rig's filename a hash
  // happens to match. Today, with no `.mjs` present, `findProbityConfig`
  // resolves to the `.ts` file purely because it is the only candidate that
  // exists, the hash comparison passes by construction, and the hand-written
  // file is deleted as if Rig had generated it.
  it('never deletes a hand-written probity.config.ts merely because its hash happens to equal the recorded configHash (no .mjs present)', async () => {
    const tsConfigPath = path.join(repo, 'probity.config.ts');
    const handWritten = Buffer.from('export default { rules: [] };\n');
    await writeFile(tsConfigPath, handWritten);
    const configHash = createHash('sha256').update(handWritten).digest('hex');
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
    expect(await exists(tsConfigPath)).toBe(true);
    expect(await readFile(tsConfigPath)).toEqual(handWritten);
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
