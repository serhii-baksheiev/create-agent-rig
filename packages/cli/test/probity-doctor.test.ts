// RP-416: doctor states for the opt-in Probity integration. Probity denies
// every tool action without a config, so unlike the MCP providers, a missing
// config is a `fail`, not a `warn` — and because its gate hook is wired
// per-harness (`.claude/hooks/probity-gate.mjs` for Claude Code,
// `.codex/hooks.json` for Codex, both from a separate slice), doctor's
// wiring check reads each harness's own hook file rather than the generic
// MCP-ownership wiring `verifyIntegrations` already covers.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

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

/** The launcher file the gate actually spawns, under an installed package.json. */
async function writeProbityLauncherBin(packageDir: string): Promise<void> {
  const bin = path.join(packageDir, 'dist', 'bin.js');
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(bin, '// fixture launcher, never spawned by doctor\n');
}

// Upstream's own documented shape (Probity 1.10.1 docs/configuration.md):
// `defineConfig({ rules: [{ files, rules: [enforceTdd()] }] })`. The
// previous fixture text — `defineConfig({ hooks: [enforceTdd({ files })] })`
// — was never upstream's shape; doctor never parses this file (only checks
// that it EXISTS, via `findProbityConfig`), so the mismatch never affected
// any assertion below, but the fixture should still say what Probity itself
// accepts rather than something it does not.
const PROBITY_CONFIG_TEXT =
  "import { defineConfig, enforceTdd } from '@nizos/probity';\n" +
  "export default defineConfig({ rules: [{ files: ['src/**'], rules: [enforceTdd()] }] });\n";

async function writeProbityConfig(): Promise<void> {
  await writeFile(path.join(repo, 'probity.config.mjs'), PROBITY_CONFIG_TEXT);
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

  // RP-416 round 2, point 3: `inspectProbity` never compares the on-disk
  // config's bytes against the declaration's own `configHash` at all — it
  // only checks that a recognised config FILENAME exists
  // (`findProbityConfig`). So a hand-edited, Rig-generated config (the
  // bytes no longer match the hash Rig recorded when it wrote the file)
  // reports exactly the same `ok`/`wired` as a pristine one, even though the
  // file has silently drifted from what Rig last generated.
  it('warns config-drift when the on-disk probity.config.mjs no longer matches the Rig-recorded configHash (hand-edited)', async () => {
    const original = Buffer.from(PROBITY_CONFIG_TEXT);
    const configHash = createHash('sha256').update(original).digest('hex');
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true, configHash },
    ]);
    await writeFile(
      path.join(repo, 'probity.config.mjs'),
      Buffer.concat([original, Buffer.from('// hand-edited after Rig generated it\n')]),
    );
    await writeProbityPackageJson(VERSION);
    await writeProbityLauncherBin(path.join(repo, 'node_modules', '@nizos', 'probity'));
    await writeWiring('claude-code', true);

    const { body: report } = await body();

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'probity:claude-code',
        status: 'warn',
        reason: 'config-drift',
      }),
    );
  });

  // RP-416 round 2, point 5: the gate hook spawns `dist/bin.js` directly, but
  // `readInstalledProbityVersion` only ever reads `package.json` — a
  // package.json present at the pinned version with no `dist/bin.js` at all
  // still reports `ok`/`wired` today, even though the gate has nothing to
  // spawn.
  it('warns launcher-missing when package.json is present at the pinned version but dist/bin.js is absent', async () => {
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    await writeProbityConfig();
    await writeWiring('claude-code', true);
    await writeProbityPackageJson(VERSION);
    // Deliberately no dist/bin.js.

    const { body: report } = await body();

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'probity:claude-code',
        status: 'warn',
        reason: 'launcher-missing',
      }),
    );
  });

  // RP-416 round 2, point 4: `readInstalledProbityVersion` reads
  // `node_modules/@nizos/probity/package.json` through
  // `resolveReadableInside`, which refuses (never follows) ANY symlink
  // anywhere along the path — including the pnpm layout's own
  // `node_modules/@nizos/probity` symlink into `.pnpm/<name>@<version>/...`.
  // That refusal is exactly right when the link escapes the repository, but
  // wrong for the ordinary pnpm case: the symlink's target still resolves
  // INSIDE the repo, so the version it names is just as trustworthy as a
  // plain install. Today both cases report the same `launcher-missing`.
  it('reports wired through a pnpm-style symlink that resolves inside the repository, but keeps launcher-missing when the link points outside it', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await writeDeclaration([
      { id: PROBITY, version: VERSION, harnesses: ['claude-code'], selected: true },
    ]);
    await writeProbityConfig();
    await writeWiring('claude-code', true);

    const linkPath = path.join(repo, 'node_modules', '@nizos', 'probity');
    await mkdir(path.dirname(linkPath), { recursive: true });

    const insideTarget = path.join(
      repo,
      'node_modules',
      '.pnpm',
      '@nizos+probity@1.10.1',
      'node_modules',
      '@nizos',
      'probity',
    );
    await mkdir(insideTarget, { recursive: true });
    await writeFile(
      path.join(insideTarget, 'package.json'),
      JSON.stringify({ name: '@nizos/probity', version: VERSION }),
    );
    await writeProbityLauncherBin(insideTarget);
    await symlink(insideTarget, linkPath, 'dir');

    const { body: insideReport } = await body();
    expect(insideReport.checks).toContainEqual(
      expect.objectContaining({ id: 'probity:claude-code', status: 'ok', reason: 'wired' }),
    );

    await rm(linkPath, { recursive: true, force: true });
    const outsideTarget = await mkdtemp(path.join(tmpdir(), 'caf-probity-doctor-outside-'));
    try {
      await writeFile(
        path.join(outsideTarget, 'package.json'),
        JSON.stringify({ name: '@nizos/probity', version: VERSION }),
      );
      await writeProbityLauncherBin(outsideTarget);
      await symlink(outsideTarget, linkPath, 'dir');

      const { body: outsideReport } = await body();
      expect(outsideReport.checks).toContainEqual(
        expect.objectContaining({
          id: 'probity:claude-code',
          status: 'warn',
          reason: 'launcher-missing',
        }),
      );
    } finally {
      await removeFixture(outsideTarget);
    }
  });
});
