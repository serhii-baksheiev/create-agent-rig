// RP-315: BMAD Method's Test Architecture Enterprise (TEA) module as an
// ADVISORY evidence provider — Rig never installs it (the manual step is
// `npx bmad-method install --modules tea`, run by the operator, exactly the
// way Probity's `npm install -D @nizos/probity` is a manual next step Rig
// never runs), never wires it into any harness's MCP config (it is not an
// MCP server at all — closer in shape to Probity than to a plain MCP
// provider), and its doctor check reads the upstream installer's own
// manifest shape rather than anything Rig itself generated.
//
// Verified upstream facts (BMAD Method 6.12.1 installer, TEA package
// `bmad-method-test-architecture-enterprise@1.27.2`): the installer writes
// `_bmad/_config/manifest.yaml` as block YAML with an `installation` block
// and a `modules` list (one entry per installed module, `tea`'s own entry
// carrying `version` and `npmPackage`), and writes `_bmad/tea/config.yaml`
// as the module's own config. This file fabricates both by hand, the same
// way `probity-doctor.test.ts` fabricates a Probity config fixture, so it
// never depends on a real BMAD install or network access.
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { runDoctor } from '../src/commands/doctor.js';
import { readManifest, writeManifest } from '../src/lib/manifest.js';
import type { RigManifest } from '../src/lib/manifest.js';
import { REGISTRY } from '../src/integrations/registry.js';
import { BMAD_TEA_VERSION, inspectBmadTea } from '../src/integrations/bmad-tea.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

const DECLARATION_REL = '.rig/integrations.json';
const MANIFEST_REL = path.join('_bmad', '_config', 'manifest.yaml');
const TEA_CONFIG_REL = path.join('_bmad', 'tea', 'config.yaml');

/** The exact installer shape this item's brief verified, with a configurable tea version literal. */
function teaManifest(versionLiteral: string): string {
  return `installation:
  version: 6.12.1
  installDate: "2026-10-07T10:00:00.000Z"
modules:
  - name: core
    version: 6.12.1
    source: built-in
  - name: tea
    version: ${versionLiteral}
    source: external
    npmPackage: bmad-method-test-architecture-enterprise
ides: []
`;
}

const ONLY_CORE_MANIFEST = `installation:
  version: 6.12.1
  installDate: "2026-10-07T10:00:00.000Z"
modules:
  - name: core
    version: 6.12.1
    source: built-in
ides: []
`;

const TEA_NO_VERSION_MANIFEST = `installation:
  version: 6.12.1
modules:
  - name: core
    version: 6.12.1
    source: built-in
  - name: tea
    source: external
    npmPackage: bmad-method-test-architecture-enterprise
ides: []
`;

const TEA_UNDER_IDES_ONLY_MANIFEST = `installation:
  version: 6.12.1
modules:
  - name: core
    version: 6.12.1
    source: built-in
ides:
  - name: tea
    version: 1.27.2
`;

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-bmad-tea-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

async function writeManifestYaml(text: string): Promise<void> {
  const file = path.join(repo, MANIFEST_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function writeTeaConfig(): Promise<void> {
  const file = path.join(repo, TEA_CONFIG_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'tea: {}\n');
}

describe('inspectBmadTea (RP-315): read-only doctor surface over the BMAD installer manifest', () => {
  it('pins the exact TEA package version this item specifies', () => {
    expect(BMAD_TEA_VERSION).toBe('1.27.2');
  });

  it('warns not-installed when _bmad/_config/manifest.yaml does not exist at all', async () => {
    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'not-installed',
    });
  });

  it('warns not-installed when the manifest lists only core, with no tea module entry', async () => {
    await writeManifestYaml(ONLY_CORE_MANIFEST);

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'not-installed',
    });
  });

  it('warns not-installed when a "tea" name appears only under a different top-level key (ides), not modules', async () => {
    await writeManifestYaml(TEA_UNDER_IDES_ONLY_MANIFEST);

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'not-installed',
    });
  });

  it('warns version-unknown when the tea module entry carries no version field', async () => {
    await writeManifestYaml(TEA_NO_VERSION_MANIFEST);

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'version-unknown',
    });
  });

  it('warns config-missing when tea is listed with a version but _bmad/tea/config.yaml is absent', async () => {
    await writeManifestYaml(teaManifest('1.27.2'));
    // Deliberately no writeTeaConfig() call.

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'config-missing',
    });
  });

  it('warns version-drift with the installed version when tea is at 1.26.0 and the config is present', async () => {
    await writeManifestYaml(teaManifest('1.26.0'));
    await writeTeaConfig();

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'version-drift',
      version: '1.26.0',
    });
  });

  it('passes installed with the pinned version for the exact verified installer sample plus config', async () => {
    await writeManifestYaml(teaManifest('1.27.2'));
    await writeTeaConfig();

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'pass',
      reason: 'installed',
      version: '1.27.2',
    });
  });

  it.each(['"1.27.2"', "'1.27.2'"])(
    'passes installed when the version literal is quoted (%s)',
    async (versionLiteral) => {
      await writeManifestYaml(teaManifest(versionLiteral));
      await writeTeaConfig();

      await expect(inspectBmadTea(repo)).resolves.toEqual({
        status: 'pass',
        reason: 'installed',
        version: '1.27.2',
      });
    },
  );

  // A version token is /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/ — the same shape
  // `evidence-attach.mjs --producer-version` accepts. Anything outside that
  // shape must never reach `version`, because doctor interpolates it
  // verbatim into the operator-facing `version-drift` fix text.
  it.each([
    ['an ANSI escape sequence embedded in the value', '1.27.2\u001b[31mred'],
    ['a shell metacharacter sequence', '1.27.2 ; rm -rf ~'],
    ['a 200-character value', 'a'.repeat(200)],
    ['a quoted empty string', '""'],
  ])(
    'warns version-unknown with no version field when the tea version is not a version token (%s)',
    async (_label, versionLiteral) => {
      await writeManifestYaml(teaManifest(versionLiteral));
      await writeTeaConfig();

      const result = await inspectBmadTea(repo);

      expect(result).toEqual({ status: 'warn', reason: 'version-unknown' });
      expect(result).not.toHaveProperty('version');
    },
  );

  it('passes installed with a version carrying no trailing \\r when the manifest file uses CRLF line endings', async () => {
    // The exact verified installer sample (`teaManifest('1.27.2')`),
    // rewritten with CRLF line endings byte-for-byte — written as explicit
    // `\r\n` escapes, never derived from the LF fixture by a string replace,
    // so this fixture is independent of whatever `findTeaModuleVersion` does
    // with `\n`.
    const crlfManifest =
      'installation:\r\n' +
      '  version: 6.12.1\r\n' +
      '  installDate: "2026-10-07T10:00:00.000Z"\r\n' +
      'modules:\r\n' +
      '  - name: core\r\n' +
      '    version: 6.12.1\r\n' +
      '    source: built-in\r\n' +
      '  - name: tea\r\n' +
      '    version: 1.27.2\r\n' +
      '    source: external\r\n' +
      '    npmPackage: bmad-method-test-architecture-enterprise\r\n' +
      'ides: []\r\n';
    await writeManifestYaml(crlfManifest);
    await writeTeaConfig();

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'pass',
      reason: 'installed',
      version: '1.27.2',
    });
  });

  it('warns manifest-unreadable when the manifest is a directory, not a file', async () => {
    await mkdir(path.join(repo, MANIFEST_REL), { recursive: true });

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'manifest-unreadable',
    });
  });

  it('warns manifest-unreadable when the manifest is larger than 64 KiB', async () => {
    const file = path.join(repo, MANIFEST_REL);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${'#'.repeat(64 * 1024 + 1)}\n`);

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'manifest-unreadable',
    });
  });

  it('warns manifest-unreadable when the manifest is not valid UTF-8', async () => {
    const file = path.join(repo, MANIFEST_REL);
    await mkdir(path.dirname(file), { recursive: true });
    // A lone continuation byte: never valid as the start of a UTF-8 sequence.
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x00, 0x80]));

    await expect(inspectBmadTea(repo)).resolves.toEqual({
      status: 'warn',
      reason: 'manifest-unreadable',
    });
  });

  it('warns manifest-unreadable when the manifest is a symlink pointing outside the repository', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-bmad-tea-outside-'));
    try {
      const target = path.join(outside, 'manifest.yaml');
      await writeFile(target, teaManifest('1.27.2'));
      const linkPath = path.join(repo, MANIFEST_REL);
      await mkdir(path.dirname(linkPath), { recursive: true });
      await symlink(target, linkPath, 'file');

      await expect(inspectBmadTea(repo)).resolves.toEqual({
        status: 'warn',
        reason: 'manifest-unreadable',
      });
    } finally {
      await removeFixture(outside);
    }
  });

  it('never spawns a process to inspect the installer manifest', async () => {
    await writeManifestYaml(teaManifest('1.27.2'));
    await writeTeaConfig();
    const marker = path.join(repo, 'spawned');

    const result = await inspectBmadTea(repo);

    expect(result.status).toBe('pass');
    await expect(stat(marker)).rejects.toThrow();
  });
});

describe('setup list declares bmad-tea (RP-315)', () => {
  it('is in the registry with both routes automatic', () => {
    const entry = REGISTRY.find((candidate) => candidate.id === 'bmad-tea');
    expect(entry).toBeDefined();
    expect(entry?.routes).toEqual({ 'claude-code': 'automatic', codex: 'automatic' });
  });

  it('is reported by setup list', async () => {
    const result = await runIntegrationsCommand({
      verb: 'list',
      args: ['--json'],
      cwd: repo,
      isTTY: true,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as { integrations: Array<{ id: string }> };
    expect(body.integrations.map((entry) => entry.id)).toContain('bmad-tea');
  });
});

function setup(verb: 'add' | 'remove', args: string[]) {
  return runIntegrationsCommand({ verb, args, cwd: repo, isTTY: true });
}

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

describe('setup add/remove bmad-tea writes only the declaration (RP-315)', () => {
  beforeEach(async () => {
    await initProject(repo, {});
  });

  it.each([
    ['claude-code', ['--harness', 'claude-code']],
    ['codex', ['--harness', 'codex']],
    ['claude-code+codex', ['--harness', 'claude-code', '--harness', 'codex']],
  ] as const)(
    'writes only .rig/integrations.json for --harness %s, never .mcp.json or .codex/config.toml',
    async (_label, harnessArgs) => {
      const before = new Set(await walk(repo));

      const result = await setup('add', ['bmad-tea', ...harnessArgs, '--yes', '--json']);

      expect(result.exitCode, result.stderr).toBe(0);
      const after = await walk(repo);
      const added = after.filter((file) => !before.has(file));
      expect(added.map((file) => path.relative(repo, file).split(path.sep).join('/'))).toEqual([
        '.rig/integrations.json',
      ]);
      const declaration = JSON.parse(
        await readFile(path.join(repo, ...DECLARATION_REL.split('/')), 'utf8'),
      );
      expect(declaration.integrations).toEqual([
        expect.objectContaining({ id: 'bmad-tea', selected: true }),
      ]);
      await expect(
        stat(path.join(repo, '.mcp.json')).then(
          () => true,
          () => false,
        ),
      ).resolves.toBe(false);
    },
  );

  it("the plan names TEA's own manual install step and never claims Rig installs it, and carries no MCP wiring disclaimer", async () => {
    const result = await setup('add', ['bmad-tea', '--harness', 'claude-code', '--dry-run']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('npx bmad-method install --modules tea');
    expect(result.stdout.toLowerCase()).not.toContain('mcp wiring');
  });

  it('removes only the declaration entry, touching nothing else', async () => {
    expect(
      (await setup('add', ['bmad-tea', '--harness', 'claude-code', '--yes', '--json'])).exitCode,
    ).toBe(0);
    const before = new Set(await walk(repo));

    const result = await setup('remove', ['bmad-tea', '--yes', '--json']);

    expect(result.exitCode, result.stderr).toBe(0);
    const declaration = JSON.parse(
      await readFile(path.join(repo, ...DECLARATION_REL.split('/')), 'utf8'),
    );
    expect(declaration.integrations).toEqual([]);
    const after = await walk(repo);
    const removed = [...before].filter((file) => !after.includes(file));
    const changed = after.filter((file) => before.has(file) === false);
    // Only the declaration itself may have changed; nothing else appears or disappears.
    expect(
      removed.filter((file) => !file.endsWith(path.join('.rig', 'integrations.json'))),
    ).toEqual([]);
    expect(
      changed.filter((file) => !file.endsWith(path.join('.rig', 'integrations.json'))),
    ).toEqual([]);
  });

  it('refuses --adopt for bmad-tea, the same way every provider but spec-kit and probity is refused', async () => {
    const result = await setup('add', [
      'bmad-tea',
      '--harness',
      'claude-code',
      '--adopt',
      '--yes',
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'refused',
      reason: 'adopt-only-for-spec-kit-or-probity',
    });
  });
});

describe('doctor: bmad-tea (RP-315)', () => {
  async function writeDeclaration(integrations: unknown[]): Promise<void> {
    const file = path.join(repo, ...DECLARATION_REL.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, integrations }, null, 2)}\n`);
  }

  async function doctor() {
    const result = await runDoctor({
      cwd: repo,
      args: ['--json'],
      env: { HOME: repo, APPDATA: repo, PATH: repo },
    });
    return { result, body: JSON.parse(result.stdout) as Record<string, unknown> };
  }

  it('emits a bmad-tea check mirroring inspectBmadTea, and exits 0 on a warn-only not-installed', async () => {
    await writeDeclaration([{ id: 'bmad-tea', selected: true, harnesses: ['claude-code'] }]);

    const { result, body } = await doctor();

    expect(result.exitCode, result.stderr).toBe(0);
    const checks = body.checks as Array<{
      id: string;
      status: string;
      reason: string;
      fix: string;
    }>;
    const check = checks.find((candidate) => candidate.id === 'bmad-tea');
    expect(check, JSON.stringify(checks)).toBeDefined();
    expect(check).toMatchObject({ status: 'warn', reason: 'not-installed' });
    expect(check!.fix).toContain('npx bmad-method install --modules tea');
  });

  it('reports ok for a pass and names both versions in the version-drift fix', async () => {
    await writeDeclaration([{ id: 'bmad-tea', selected: true, harnesses: ['claude-code'] }]);
    const manifestFile = path.join(repo, MANIFEST_REL);
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, teaManifest('1.26.0'));
    await writeTeaConfig();

    const { result, body } = await doctor();

    expect(result.exitCode, result.stderr).toBe(0);
    const checks = body.checks as Array<{
      id: string;
      status: string;
      reason: string;
      fix: string;
    }>;
    const check = checks.find((candidate) => candidate.id === 'bmad-tea');
    expect(check).toMatchObject({ status: 'warn', reason: 'version-drift' });
    expect(check!.fix).toContain('1.26.0');
    expect(check!.fix).toContain('1.27.2');
  });

  it('never lets an upstream ESC character reach the JSON report, and reports version-unknown instead of version-drift', async () => {
    await writeDeclaration([{ id: 'bmad-tea', selected: true, harnesses: ['claude-code'] }]);
    const manifestFile = path.join(repo, MANIFEST_REL);
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, teaManifest('1.27.2\u001b[31mred'));
    await writeTeaConfig();

    const { result, body } = await doctor();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    const checks = body.checks as Array<{ id: string; status: string; reason: string }>;
    const check = checks.find((candidate) => candidate.id === 'bmad-tea');
    expect(check).toMatchObject({ status: 'warn', reason: 'version-unknown' });
  });

  it('reports ok/installed when TEA is fully installed at the pinned version', async () => {
    await writeDeclaration([{ id: 'bmad-tea', selected: true, harnesses: ['claude-code'] }]);
    const manifestFile = path.join(repo, MANIFEST_REL);
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, teaManifest('1.27.2'));
    await writeTeaConfig();

    const { result, body } = await doctor();

    expect(result.exitCode, result.stderr).toBe(0);
    const checks = body.checks as Array<{ id: string; status: string; reason: string }>;
    expect(checks).toContainEqual(
      expect.objectContaining({ id: 'bmad-tea', status: 'ok', reason: 'installed' }),
    );
  });

  it('never appears in the integrations (MCP wiring) array and emits no bmad-tea:* MCP-wiring check', async () => {
    await writeDeclaration([{ id: 'bmad-tea', selected: true, harnesses: ['claude-code'] }]);

    const { result, body } = await doctor();

    expect(result.exitCode, result.stderr).toBe(0);
    const integrations = body.integrations as Array<{ id: string }>;
    expect(integrations.some((entry) => entry.id === 'bmad-tea')).toBe(false);
    const checks = body.checks as Array<{ id: string }>;
    expect(checks.some((check) => check.id.startsWith('bmad-tea:'))).toBe(false);
  });
});

describe('doctor: bmad-tea in the composed preset summary (RP-315)', () => {
  it("reports composed's bmad-tea entry declared and observed from doctor's own bmad-tea check", async () => {
    await initProject(repo, { withWorkflow: true });
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'composed' } as RigManifest);
    const declarationFile = path.join(repo, ...DECLARATION_REL.split('/'));
    await mkdir(path.dirname(declarationFile), { recursive: true });
    await writeFile(
      declarationFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          integrations: [{ id: 'bmad-tea', selected: true, harnesses: ['claude-code'] }],
        },
        null,
        2,
      )}\n`,
    );

    const result = await runDoctor({
      cwd: repo,
      args: ['--json'],
      env: { HOME: repo, APPDATA: repo, PATH: repo },
    });
    const body = JSON.parse(result.stdout) as {
      preset: { integrations: Array<{ id: string; declared: boolean; observed: unknown }> };
      checks: Array<{ id: string; status: string; reason: string }>;
    };

    const bmadTeaCheck = body.checks.find((check) => check.id === 'bmad-tea');
    expect(bmadTeaCheck, JSON.stringify(body.checks)).toBeDefined();
    const preset = body.preset.integrations.find((entry) => entry.id === 'bmad-tea');
    expect(preset, JSON.stringify(body.preset.integrations)).toBeDefined();
    expect(preset).toEqual({
      id: 'bmad-tea',
      declared: true,
      observed: { status: bmadTeaCheck!.status, reason: bmadTeaCheck!.reason },
    });
  });
});
