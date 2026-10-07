// RP-443 — external-provider version provenance. `lib/provider-provenance.mjs`
// (workflow layer) does not exist yet; this file pins what it must answer
// before it is written, not how it is implemented.
//
// Three pure, offline readers, each independent of the others:
//
//   playwrightPin(projectRoot)   -> string | null
//     The exact version pinned in `@playwright/mcp@<v>`, read from any
//     server's `args` in `.mcp.json`, or else from `.codex/config.toml`'s
//     `[mcp_servers.<name>]` block. `null` when no `.mcp.json`/config.toml
//     names Playwright MCP at all, or when it is named with no exact version
//     pinned (e.g. no `@<version>` suffix at all).
//
//   specKitVersion(projectRoot)  -> { version: string | null, source: 'installed' | 'declared' | 'unknown' }
//     `installed` from `.specify/init-options.json`'s `speckit_version`;
//     else `declared` from the `.rig/integrations.json` `spec-kit` entry's
//     `version`; else `{ version: null, source: 'unknown' }`.
//
//   probityProvenance(projectRoot) -> { selected: boolean, declared: string | null, installed: string | null }
//     `selected` true only when `.rig/integrations.json` has a SELECTED
//     `probity` entry; `declared` is that entry's `version` (regardless of
//     whether it is selected) or null; `installed` is
//     `node_modules/@nizos/probity/package.json`'s `version` or null — each
//     of the three answered independently, never inferred from one another.
//
// Every version is validated as one token,
// `/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/`, before it is returned; anything that
// does not match reads as unknown/null, the same way an absent file does.
//
// Bounded, fail-soft reads (`.claude/rules/invariants.md`, "state the limits —
// and test them"): a file over 256 KiB, a symlink, or invalid JSON reads as
// unknown/null and never throws to the caller — pinned once per source file
// below (`.mcp.json`, `.specify/init-options.json`,
// `node_modules/@nizos/probity/package.json`), since each is read through an
// independent code path.
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../helpers/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'lib', 'provider-provenance.mjs');

type Module = {
  playwrightPin: (projectRoot: string) => Promise<string | null> | string | null;
  specKitVersion: (
    projectRoot: string,
  ) =>
    | Promise<{ version: string | null; source: 'installed' | 'declared' | 'unknown' }>
    | { version: string | null; source: 'installed' | 'declared' | 'unknown' };
  probityProvenance: (
    projectRoot: string,
  ) =>
    | Promise<{ selected: boolean; declared: string | null; installed: string | null }>
    | { selected: boolean; declared: string | null; installed: string | null };
};

const loadModule = async (): Promise<Module> =>
  (await import(pathToFileURL(modulePath).href)) as Module;

const temporaryPaths = new Set<string>();
afterEach(async () => {
  await Promise.all([...temporaryPaths].map((p) => removeFixture(p)));
  temporaryPaths.clear();
});

const newProjectRoot = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'provider-provenance-'));
  temporaryPaths.add(dir);
  return dir;
};

const writeJson = async (filePath: string, content: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content));
};

/** Padding that keeps a JSON document syntactically valid but over 256 KiB. */
const oversizedPadding = () => 'a'.repeat(256 * 1024 + 1024);

// --- playwrightPin -----------------------------------------------------------

describe('provider-provenance.mjs — playwrightPin', () => {
  it('reads the exact version from @playwright/mcp@<v> in .mcp.json', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.mcp.json'), {
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.83'] } },
    });
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBe('0.0.83');
  });

  it('reads the pin from ANY server key in .mcp.json, not only one named "playwright"', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.mcp.json'), {
      mcpServers: { 'browser-tool': { command: 'npx', args: ['@playwright/mcp@0.0.83'] } },
    });
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBe('0.0.83');
  });

  it('falls back to .codex/config.toml when .mcp.json names no Playwright MCP server', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.mcp.json'), { mcpServers: {} });
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(
      path.join(root, '.codex', 'config.toml'),
      '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@0.0.83"]\n',
    );
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBe('0.0.83');
  });

  it('reads .codex/config.toml directly when there is no .mcp.json at all', async () => {
    const root = await newProjectRoot();
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(
      path.join(root, '.codex', 'config.toml'),
      '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@0.0.83"]\n',
    );
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBe('0.0.83');
  });

  it('returns null when neither file names Playwright MCP at all', async () => {
    const root = await newProjectRoot();
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBeNull();
  });

  it('returns null when Playwright MCP is named with no exact version pinned', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.mcp.json'), {
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } },
    });
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBeNull();
  });

  it('rule: an invalid JSON .mcp.json reads as absent, never throws — falls through to null with nothing else configured', async () => {
    const root = await newProjectRoot();
    await writeFile(path.join(root, '.mcp.json'), '{not valid json');
    const { playwrightPin } = await loadModule();
    await expect(playwrightPin(root)).resolves.toBeNull();
  });

  it('rule: an .mcp.json over 256 KiB reads as absent even though it is syntactically valid JSON', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.mcp.json'), {
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.83'] } },
      padding: oversizedPadding(),
    });
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBeNull();
  });

  it('rule: a symlinked .mcp.json reads as absent, never followed', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const root = await newProjectRoot();
    const outside = await mkdtemp(path.join(tmpdir(), 'provider-provenance-outside-'));
    temporaryPaths.add(outside);
    await writeJson(path.join(outside, 'target.json'), {
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.83'] } },
    });
    await symlink(path.join(outside, 'target.json'), path.join(root, '.mcp.json'));
    const { playwrightPin } = await loadModule();
    expect(await playwrightPin(root)).toBeNull();
  });
});

// --- specKitVersion ------------------------------------------------------------

describe('provider-provenance.mjs — specKitVersion', () => {
  it('reads speckit_version from .specify/init-options.json as source "installed"', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.specify', 'init-options.json'), { speckit_version: '1.0.8' });
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: '1.0.8', source: 'installed' });
  });

  it('falls back to the .rig/integrations.json spec-kit entry version as source "declared"', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.rig', 'integrations.json'), {
      schemaVersion: 1,
      integrations: [{ id: 'spec-kit', version: '1.0.8' }],
    });
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: '1.0.8', source: 'declared' });
  });

  it('prefers "installed" over "declared" when both are present', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.specify', 'init-options.json'), { speckit_version: '1.0.9' });
    await writeJson(path.join(root, '.rig', 'integrations.json'), {
      schemaVersion: 1,
      integrations: [{ id: 'spec-kit', version: '1.0.8' }],
    });
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: '1.0.9', source: 'installed' });
  });

  it('returns { version: null, source: "unknown" } when neither file names a version', async () => {
    const root = await newProjectRoot();
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: null, source: 'unknown' });
  });

  it('rule: a malformed installed version token falls through to the declared one rather than being returned verbatim', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.specify', 'init-options.json'), {
      speckit_version: '1.0 beta',
    });
    await writeJson(path.join(root, '.rig', 'integrations.json'), {
      schemaVersion: 1,
      integrations: [{ id: 'spec-kit', version: '1.0.8' }],
    });
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: '1.0.8', source: 'declared' });
  });

  it('rule: a malformed declared version token reads as unknown rather than returned verbatim', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.rig', 'integrations.json'), {
      schemaVersion: 1,
      integrations: [{ id: 'spec-kit', version: '1.0 beta' }],
    });
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: null, source: 'unknown' });
  });

  it('rule: invalid JSON in .specify/init-options.json reads as absent, falling through to declared', async () => {
    const root = await newProjectRoot();
    await mkdir(path.join(root, '.specify'), { recursive: true });
    await writeFile(path.join(root, '.specify', 'init-options.json'), '{not valid json');
    await writeJson(path.join(root, '.rig', 'integrations.json'), {
      schemaVersion: 1,
      integrations: [{ id: 'spec-kit', version: '1.0.8' }],
    });
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: '1.0.8', source: 'declared' });
  });

  it('rule: an init-options.json over 256 KiB reads as absent even though it is syntactically valid JSON', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.specify', 'init-options.json'), {
      speckit_version: '1.0.9',
      padding: oversizedPadding(),
    });
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: null, source: 'unknown' });
  });

  it('rule: a symlinked init-options.json reads as absent, never followed', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const root = await newProjectRoot();
    const outside = await mkdtemp(path.join(tmpdir(), 'provider-provenance-outside-'));
    temporaryPaths.add(outside);
    await writeJson(path.join(outside, 'target.json'), { speckit_version: '1.0.9' });
    await mkdir(path.join(root, '.specify'), { recursive: true });
    await symlink(
      path.join(outside, 'target.json'),
      path.join(root, '.specify', 'init-options.json'),
    );
    const { specKitVersion } = await loadModule();
    expect(await specKitVersion(root)).toEqual({ version: null, source: 'unknown' });
  });
});

// --- probityProvenance -----------------------------------------------------

describe('provider-provenance.mjs — probityProvenance', () => {
  const withProbityEntry = async (root: string, entry: Record<string, unknown>): Promise<void> => {
    await writeJson(path.join(root, '.rig', 'integrations.json'), {
      schemaVersion: 1,
      integrations: [{ id: 'probity', ...entry }],
    });
  };

  const withInstalledProbity = async (root: string, version: string): Promise<void> => {
    await writeJson(path.join(root, 'node_modules', '@nizos', 'probity', 'package.json'), {
      name: '@nizos/probity',
      version,
    });
  };

  it('reports selected: true, declared and installed together when every signal agrees', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10.1', selected: true });
    await withInstalledProbity(root, '1.10.1');
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: true,
      declared: '1.10.1',
      installed: '1.10.1',
    });
  });

  it('rule: selected is true ONLY when the entry is explicitly selected — present but not selected reads selected: false', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10.1' });
    const { probityProvenance } = await loadModule();
    expect((await probityProvenance(root)).selected).toBe(false);
  });

  it('rule: selected: false explicitly also reads selected: false', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10.1', selected: false });
    const { probityProvenance } = await loadModule();
    expect((await probityProvenance(root)).selected).toBe(false);
  });

  it('declared and installed are read independently — a declared version with nothing installed reports installed: null', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10.1', selected: true });
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: true,
      declared: '1.10.1',
      installed: null,
    });
  });

  it('declared and installed are read independently — something installed with no declaration at all reports declared: null, selected: false', async () => {
    const root = await newProjectRoot();
    await withInstalledProbity(root, '1.10.1');
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: false,
      declared: null,
      installed: '1.10.1',
    });
  });

  it('declared and installed never reconcile a mismatch — each is reported exactly as read, with no inference from the other', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10.1', selected: true });
    await withInstalledProbity(root, '1.9.0');
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: true,
      declared: '1.10.1',
      installed: '1.9.0',
    });
  });

  it('with no integrations.json and nothing installed at all: selected false, declared null, installed null', async () => {
    const root = await newProjectRoot();
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: false,
      declared: null,
      installed: null,
    });
  });

  it('rule: a malformed declared version token reads as null rather than returned verbatim', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10 beta', selected: true });
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: true,
      declared: null,
      installed: null,
    });
  });

  it('rule: a malformed installed version token reads as null rather than returned verbatim', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10.1', selected: true });
    await withInstalledProbity(root, '1.10 beta');
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: true,
      declared: '1.10.1',
      installed: null,
    });
  });

  it('rule: invalid JSON in node_modules/@nizos/probity/package.json reads as installed: null, never throws', async () => {
    const root = await newProjectRoot();
    await withProbityEntry(root, { version: '1.10.1', selected: true });
    await mkdir(path.join(root, 'node_modules', '@nizos', 'probity'), { recursive: true });
    await writeFile(
      path.join(root, 'node_modules', '@nizos', 'probity', 'package.json'),
      '{not valid json',
    );
    const { probityProvenance } = await loadModule();
    expect(await probityProvenance(root)).toEqual({
      selected: true,
      declared: '1.10.1',
      installed: null,
    });
  });

  it('rule: a package.json over 256 KiB reads as installed: null even though it is syntactically valid JSON', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, 'node_modules', '@nizos', 'probity', 'package.json'), {
      name: '@nizos/probity',
      version: '1.10.1',
      padding: oversizedPadding(),
    });
    const { probityProvenance } = await loadModule();
    expect((await probityProvenance(root)).installed).toBeNull();
  });

  it('rule: a symlinked package.json reads as installed: null, never followed', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const root = await newProjectRoot();
    const outside = await mkdtemp(path.join(tmpdir(), 'provider-provenance-outside-'));
    temporaryPaths.add(outside);
    await writeJson(path.join(outside, 'target.json'), {
      name: '@nizos/probity',
      version: '1.10.1',
    });
    await mkdir(path.join(root, 'node_modules', '@nizos', 'probity'), { recursive: true });
    await symlink(
      path.join(outside, 'target.json'),
      path.join(root, 'node_modules', '@nizos', 'probity', 'package.json'),
    );
    const { probityProvenance } = await loadModule();
    expect((await probityProvenance(root)).installed).toBeNull();
  });

  it('rule: a .rig/integrations.json over 256 KiB reads the whole file as absent (selected: false, declared: null)', async () => {
    const root = await newProjectRoot();
    await writeJson(path.join(root, '.rig', 'integrations.json'), {
      schemaVersion: 1,
      integrations: [{ id: 'probity', version: '1.10.1', selected: true }],
      padding: oversizedPadding(),
    });
    const { probityProvenance } = await loadModule();
    const result = await probityProvenance(root);
    expect(result.selected).toBe(false);
    expect(result.declared).toBeNull();
  });
});
