// RP-314: `doctor --json` carries a top-level `preset` object —
// `{ name: string|null, integrations: [{ id, declared, observed }] }` — read
// purely from the manifest's `preset` key and `.rig/integrations.json`'s
// declared ids, regardless of how either got there (`init --preset sdd`, a
// hand-edit, or an upgrade carrying one forward). Jira RP-314 comment 23375
// (owner decision): `init`/`create` never install, declare or run a
// preset's integrations themselves — a preset's `integrations` list is what
// DOCTOR expects, which is exactly why `declared` can legitimately be
// `false` for a freshly `--preset sdd`-ed rig (see the "fresh sdd rig" case
// below) as well as `true` once a human runs `setup add spec-kit` by hand.
// This file fabricates both the manifest's `preset` key and the declaration
// by hand, the same way `probity-doctor.test.ts` fabricates a declaration,
// so it never depends on a real Spec Kit install or network access — and
// `env.PATH` points at an empty directory for the same reason
// `doctor.test.ts`'s own spec-kit case does: it guarantees no real `uvx` on
// the test machine's PATH, so `inspectSpecKit` degrades the same
// deterministic way on every machine this suite runs on, rather than
// racing a real upstream call that happens to be reachable on some of them.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { runDoctor } from '../src/commands/doctor.js';
import { readManifest, writeManifest } from '../src/lib/manifest.js';
import type { RigManifest } from '../src/lib/manifest.js';
import { SPEC_KIT_VERSION } from '../src/integrations/spec-kit.js';
import { PLAYWRIGHT_MCP_VERSION } from '../src/integrations/playwright.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const PLAYWRIGHT_SERVER = { command: 'npx', args: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`] };
const PLAYWRIGHT_ENTRY_HASH = createHash('sha256')
  .update(JSON.stringify(PLAYWRIGHT_SERVER))
  .digest('hex');

const DECLARATION_REL = '.rig/integrations.json';

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-preset-doctor-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-preset-doctor-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

async function doctor(): Promise<{
  result: Awaited<ReturnType<typeof runDoctor>>;
  body: Record<string, unknown>;
}> {
  const result = await runDoctor({
    cwd: repo,
    args: ['--json'],
    // An empty PATH: no real `uv`/`uvx` is ever found here, on any machine.
    env: { HOME: home, APPDATA: home, PATH: home },
  });
  return { result, body: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function writeDeclaration(integrations: unknown[]): Promise<void> {
  const file = path.join(repo, ...DECLARATION_REL.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, integrations }, null, 2)}\n`);
}

describe('doctor: the top-level preset summary (RP-314)', () => {
  it('reports name null and no integrations for a rig with no preset at all', async () => {
    await initProject(repo, {});

    const { result, body } = await doctor();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.preset).toEqual({ name: null, integrations: [] });
  });

  it('adding the `preset` manifest key changes neither `status`/`exitCode` nor `checks[]`, all else equal', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeDeclaration([
      { id: 'spec-kit', version: SPEC_KIT_VERSION, selected: true, harnesses: ['claude-code'] },
    ]);
    const without = await doctor();

    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'sdd' } as RigManifest);
    const withPreset = await doctor();

    expect(withPreset.result.exitCode).toBe(without.result.exitCode);
    expect(withPreset.body.status).toBe(without.body.status);
    expect(withPreset.body.checks).toEqual(without.body.checks);
  });

  it("reports the preset name and the declared spec-kit integration, with doctor's own spec-kit observation", async () => {
    await initProject(repo, { withWorkflow: true });
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'sdd' } as RigManifest);
    await writeDeclaration([
      { id: 'spec-kit', version: SPEC_KIT_VERSION, selected: true, harnesses: ['claude-code'] },
    ]);

    const { body } = await doctor();

    const checks = body.checks as Array<{ id: string; status: string; reason: string }>;
    const specKitCheck = checks.find((check) => check.id === 'spec-kit');
    expect(specKitCheck, JSON.stringify(checks)).toBeDefined();

    expect(body.preset).toEqual({
      name: 'sdd',
      integrations: [
        {
          id: 'spec-kit',
          declared: true,
          observed: { status: specKitCheck!.status, reason: specKitCheck!.reason },
        },
      ],
    });
  });

  // Jira RP-314 comment 23375 (owner decision): `init --preset sdd` never
  // installs, declares or runs Spec Kit — a preset's `integrations` list is
  // what DOCTOR expects, not something init/create act on. So the very first
  // doctor run after a fresh `init --preset sdd` finds no `.rig/
  // integrations.json` at all, and must report the named integration as not
  // (yet) declared — never silently drop it from the list, and never fail
  // doctor over it.
  it('reports declared: false for a fresh sdd rig that has not run setup add spec-kit yet, with the same status/exitCode as a plain --layer workflow rig', async () => {
    await initProject(repo, { withWorkflow: true });
    const plain = await doctor();

    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'sdd' } as RigManifest);
    // Deliberately no `writeDeclaration` call — a fresh `--preset sdd` rig
    // never writes `.rig/integrations.json`.
    const sdd = await doctor();

    expect(sdd.result.exitCode).toBe(plain.result.exitCode);
    expect(sdd.body.status).toBe(plain.body.status);
    expect(sdd.body.checks).toEqual(plain.body.checks);
    expect(sdd.body.preset).toEqual({
      name: 'sdd',
      integrations: [{ id: 'spec-kit', declared: false, observed: null }],
    });
  });

  // RP-313: `composed` names two integration ids — `spec-kit` and
  // `playwright-mcp`. `playwright-mcp`'s doctor check lives at
  // `playwright-mcp:claude-code` (an MCP provider's check id is always
  // `${id}:${harness}`, never the bare id spec-kit's own singular check
  // uses) — so the preset summary's `observed` for an MCP id has to be read
  // from that harness-qualified check, independently of the generic
  // `declared` lookup above.
  it("reports the preset name and the declared playwright-mcp integration, with doctor's own playwright-mcp:claude-code observation", async () => {
    await initProject(repo, { withWorkflow: true });
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'composed' } as RigManifest);
    await writeFile(
      path.join(repo, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { playwright: PLAYWRIGHT_SERVER } }, null, 2)}\n`,
    );
    await writeDeclaration([
      {
        id: 'playwright-mcp',
        selected: true,
        harnesses: ['claude-code'],
        targets: { 'claude-code': { entryHash: PLAYWRIGHT_ENTRY_HASH } },
      },
    ]);

    const { body } = await doctor();

    const checks = body.checks as Array<{ id: string; status: string; reason: string }>;
    const playwrightCheck = checks.find((check) => check.id === 'playwright-mcp:claude-code');
    expect(playwrightCheck, JSON.stringify(checks)).toBeDefined();

    expect(body.preset).toEqual({
      name: 'composed',
      integrations: [
        { id: 'spec-kit', declared: false, observed: null },
        {
          id: 'playwright-mcp',
          declared: true,
          observed: { status: playwrightCheck!.status, reason: playwrightCheck!.reason },
        },
        // RP-315: composed also names `bmad-tea`, undeclared and unobserved here.
        { id: 'bmad-tea', declared: false, observed: null },
      ],
    });
  });

  // Mirrors "reports declared: false for a fresh sdd rig..." above, for
  // `composed`'s two integration ids at once: with no declaration and no
  // doctor check for either id, `observed` is null for both.
  it('reports declared: false and observed: null for both composed integrations on a fresh composed rig with no declaration at all', async () => {
    await initProject(repo, { withWorkflow: true });
    const plain = await doctor();

    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'composed' } as RigManifest);
    const composed = await doctor();

    expect(composed.result.exitCode).toBe(plain.result.exitCode);
    expect(composed.body.status).toBe(plain.body.status);
    expect(composed.body.checks).toEqual(plain.body.checks);
    expect(composed.body.preset).toEqual({
      name: 'composed',
      integrations: [
        { id: 'spec-kit', declared: false, observed: null },
        { id: 'playwright-mcp', declared: false, observed: null },
        // RP-315: composed also names `bmad-tea`, undeclared and unobserved here.
        { id: 'bmad-tea', declared: false, observed: null },
      ],
    });
  });

  it('adds no new `checks[]` id for the preset summary itself', async () => {
    await initProject(repo, { withWorkflow: true });
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'sdd' } as RigManifest);
    await writeDeclaration([
      { id: 'spec-kit', version: SPEC_KIT_VERSION, selected: true, harnesses: ['claude-code'] },
    ]);

    const { body } = await doctor();

    const checks = body.checks as Array<{ id: string }>;
    expect(checks.some((check) => check.id === 'preset')).toBe(false);
  });

  // RP-313 gate round 2: `playwright-mcp` can be declared for BOTH harnesses
  // at once. `doctor` reports one check per harness
  // (`playwright-mcp:claude-code`, `playwright-mcp:codex`); the preset
  // summary's single `observed` entry for that id must take the WORSE of the
  // two. This environment (like every other case in this file) never
  // observes a real `npx` on `PATH`, so a HEALTHY-wiring entry with a
  // missing launcher and a DRIFTED entry both land on the same `warn`
  // status — the Claude entry is healthy in the sense that its own wiring
  // matches exactly what `setup add` wrote (`reason: launcher-missing`,
  // same status as everything else in this file's "missing launcher"
  // fixtures), while the Codex entry's wiring itself has drifted
  // (`reason: drift`) because its config was edited after setup. A
  // same-rank tie is exactly where "pick the worse one" is distinct from
  // "pick the first one found": the latter would silently surface the
  // benign missing-launcher reason while the real config drift sits
  // unreported behind it.
  it("reports the Codex entry's drift, not the Claude entry's merely-missing launcher, when both land on the same rank", async () => {
    await initProject(repo, { withWorkflow: true });
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, preset: 'composed' } as RigManifest);
    expect(
      (
        await runIntegrationsCommand({
          cwd: repo,
          verb: 'add',
          args: ['playwright-mcp', '--harness', 'claude-code', '--harness', 'codex', '--yes'],
        })
      ).exitCode,
    ).toBe(0);
    // Edit the Codex section after setup — the Claude entry is left exactly
    // as `add` wrote it, so only the Codex side drifts.
    const codexConfigPath = path.join(repo, '.codex', 'config.toml');
    await writeFile(codexConfigPath, `${await readFile(codexConfigPath, 'utf8')}# human edit\n`);

    const { body } = await doctor();

    const checks = body.checks as Array<{ id: string; status: string; reason: string }>;
    const claudeCheck = checks.find((check) => check.id === 'playwright-mcp:claude-code');
    const codexCheck = checks.find((check) => check.id === 'playwright-mcp:codex');
    expect(claudeCheck, JSON.stringify(checks)).toBeDefined();
    expect(codexCheck, JSON.stringify(checks)).toBeDefined();
    // Fixture sanity: both checks land on `warn`, one for a merely-missing
    // launcher and the other for an actual config drift — the exact tie
    // this test exists to break correctly.
    expect(claudeCheck!.status).toBe('warn');
    expect(claudeCheck!.reason).toBe('launcher-missing');
    expect(codexCheck!.status).toBe('warn');
    expect(codexCheck!.reason).toBe('drift');

    const preset = body.preset as { integrations: Array<{ id: string; observed: unknown }> };
    const playwright = preset.integrations.find((entry) => entry.id === 'playwright-mcp');
    expect(playwright, JSON.stringify(preset.integrations)).toBeDefined();
    expect(playwright!.observed).toEqual({
      status: codexCheck!.status,
      reason: codexCheck!.reason,
    });
    expect((playwright!.observed as { status: string; reason: string }).reason).toBe('drift');
  });
});
