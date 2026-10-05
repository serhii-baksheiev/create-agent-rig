// RP-416: doctor states for the opt-in Probity integration. Probity denies
// every tool action without a config, so unlike the MCP providers, a missing
// config is a `fail`, not a `warn` — and because its gate hook is wired
// per-harness (`.claude/hooks/probity-gate.mjs` for Claude Code,
// `.codex/hooks.json` for Codex, both from a separate slice), doctor's
// wiring check reads each harness's own hook file rather than the generic
// MCP-ownership wiring `verifyIntegrations` already covers.
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const PROBITY = 'probity';
const VERSION = '1.10.1';
const GATE_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/probity-gate.mjs"';
const OTHER_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secret-file.mjs"';

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-probity-doctor-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-probity-doctor-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

async function doctor() {
  return runDoctor({
    cwd: repo,
    args: ['--json'],
    env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
  });
}

async function body() {
  const result = await doctor();
  return { result, body: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function writeDeclaration(integrations: unknown[]): Promise<void> {
  const file = path.join(repo, '.rig', 'integrations.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, integrations }, null, 2)}\n`);
}

async function writeProbityPackageJson(version: string): Promise<void> {
  const file = path.join(repo, 'node_modules', '@nizos', 'probity', 'package.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ name: '@nizos/probity', version }));
}

async function writeProbityConfig(): Promise<void> {
  await writeFile(
    path.join(repo, 'probity.config.mjs'),
    "import { defineConfig, enforceTdd } from '@nizos/probity';\n" +
      "export default defineConfig({ hooks: [enforceTdd({ files: ['src/**'] })] });\n",
  );
}

/** A minimal hook-wiring fixture for one harness, with or without the gate command. */
async function writeWiring(harness: 'claude-code' | 'codex', includesGate: boolean): Promise<void> {
  const file =
    harness === 'claude-code'
      ? path.join(repo, '.claude', 'settings.json')
      : path.join(repo, '.codex', 'hooks.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [{ type: 'command', command: includesGate ? GATE_COMMAND : OTHER_COMMAND }],
          },
        ],
      },
    }),
  );
}

type CheckRecord = { id: string; status: string; reason?: string };

describe('doctor: probity (RP-416)', () => {
  it('reports not-configured and emits no probity:* check when probity is not declared', async () => {
    const { result, body: report } = await body();

    expect(result.exitCode, result.stderr).toBe(0);
    expect((report.checks as CheckRecord[]).some((check) => check.id.startsWith('probity:'))).toBe(
      false,
    );
    expect(report.probity).toEqual({ state: 'not-configured' });
  });

  it('warns launcher-missing for a declared harness when the probity package is not installed', async () => {
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    await writeProbityConfig();
    await writeWiring('claude-code', true);

    const { body: report } = await body();

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'probity:claude-code',
        status: 'warn',
        reason: 'launcher-missing',
      }),
    );
  });

  it('warns version-drift when the installed probity package version differs from the pinned 1.10.1', async () => {
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    await writeProbityConfig();
    await writeWiring('claude-code', true);
    await writeProbityPackageJson('1.9.0');

    const { body: report } = await body();

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'probity:claude-code',
        status: 'warn',
        reason: 'version-drift',
      }),
    );
  });

  it('fails config-missing when the launcher is installed at the pinned version but no probity config file exists', async () => {
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    await writeWiring('claude-code', true);
    await writeProbityPackageJson(VERSION);

    const { body: report } = await body();

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'probity:claude-code',
        status: 'fail',
        reason: 'config-missing',
      }),
    );
  });

  it.each(['claude-code', 'codex'] as const)(
    'warns wiring-missing for %s when its own hook file carries no PreToolUse command naming the probity gate',
    async (harness) => {
      await writeDeclaration([
        { id: PROBITY, version: VERSION, harnesses: [harness], selected: true },
      ]);
      await writeProbityConfig();
      await writeProbityPackageJson(VERSION);
      await writeWiring(harness, false);

      const { body: report } = await body();

      expect(report.checks).toContainEqual(
        expect.objectContaining({
          id: `probity:${harness}`,
          status: 'warn',
          reason: 'wiring-missing',
        }),
      );
    },
  );

  it('reports ok/wired plus the top-level configured summary, and never spawns the probity launcher', async () => {
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    await writeProbityConfig();
    await writeProbityPackageJson(VERSION);
    await writeWiring('claude-code', true);
    const marker = path.join(repo, 'launcher-ran');
    const binPath = path.join(repo, 'node_modules', '@nizos', 'probity', 'dist', 'bin.js');
    await mkdir(path.dirname(binPath), { recursive: true });
    await writeFile(
      binPath,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );

    const { result, body: report } = await body();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'probity:claude-code', status: 'ok', reason: 'wired' }),
    );
    expect(report.probity).toEqual({
      state: 'configured',
      version: VERSION,
      runtime: 'unverified',
      connectivity: 'not-observed',
      trust: 'not-observed',
    });
    await expect(access(marker)).rejects.toThrow();
  });
});
