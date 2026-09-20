// RP-22 S4 — `setup list | add | verify`: the read-only verbs plus the
// declaration write. Legacy `setup --memory-root …` is untouched; dispatch
// reaches this module only when the first argument is one of the three new
// verbs (packages/cli/src/index.ts).
//
// Most behaviour is tested by calling the exported functions directly against
// a real temp-directory fixture — the same style packages/cli/test/uninstall.test.ts
// uses — with an INJECTED registry and, for `verify`, an injected probe, so a
// route that has no adapter yet (mcp-config is S5, claude-plugin-cli is S6,
// the guided routes are S7, the subsystem-manifest mapping is S8) is never
// needed to exercise the command surface itself. Only the "one JSON object on
// stdout" promise, and the legacy-path wiring, are proven by spawning the
// actually-built CLI (mirrors packages/cli/test/cli-version.test.ts).
//
// RP-22 round 2 (gate cycle 1): every blocker and every advisory taken into
// round 2 has a test here, named to match. See
// packages/cli/src/commands/integrations.ts for the corresponding fix.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ORPHAN_CANDIDATES,
  addIntegration,
  listRegistry,
  runIntegrationsCommand,
  verifyIntegrations,
} from '../src/commands/integrations.js';
import { DECLARATION_REL } from '../src/integrations/declaration.js';
import { RECEIPTS_DIR_REL } from '../src/integrations/receipt.js';
import type { ProviderDescriptor } from '../src/integrations/registry.js';
import type { ObservedNow } from '../src/integrations/state.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Two hand-made descriptors, neither in {@link REGISTRY}, so the exclusive-group
 * and "installed" states can be driven without waiting on a real S5+ provider. */
const FAKE_REQUIRED: ProviderDescriptor = {
  id: 'fixture-required',
  displayName: 'Fixture Required',
  capability: 'board',
  mode: 'hosted-service',
  source: {
    kind: 'https',
    locator: 'https://fixture.example/required',
    official: true,
    verifiedOn: '2026-01-01',
    docsUrl: 'https://fixture.example/required/docs',
  },
  license: { kind: 'spdx', id: 'MIT' },
  versionPolicy: { kind: 'pinned', default: '1.0.0' },
  routes: { 'claude-code': { route: 'guided-manual', automation: 'guided' } },
  stability: 'supported',
};

const FAKE_OPTIONAL: ProviderDescriptor = {
  ...FAKE_REQUIRED,
  id: 'fixture-optional',
  displayName: 'Fixture Optional',
  source: { ...FAKE_REQUIRED.source, locator: 'https://fixture.example/optional' },
};

const FAKE_REGISTRY: readonly ProviderDescriptor[] = [FAKE_REQUIRED, FAKE_OPTIONAL];

/** Two providers sharing an exclusive group, for the collateral-rejection test. */
const FAKE_METHOD_A: ProviderDescriptor = {
  ...FAKE_REQUIRED,
  id: 'fixture-method-a',
  displayName: 'Fixture Method A',
  capability: 'methodology',
  exclusiveGroup: 'methodology',
  source: { ...FAKE_REQUIRED.source, locator: 'https://fixture.example/method-a' },
};
const FAKE_METHOD_B: ProviderDescriptor = {
  ...FAKE_METHOD_A,
  id: 'fixture-method-b',
  displayName: 'Fixture Method B',
  source: { ...FAKE_REQUIRED.source, locator: 'https://fixture.example/method-b' },
};
const FAKE_METHOD_REGISTRY: readonly ProviderDescriptor[] = [FAKE_METHOD_A, FAKE_METHOD_B];

/** A descriptor an `add` can never validly pin a version for. */
const FAKE_UNPINNABLE: ProviderDescriptor = {
  ...FAKE_REQUIRED,
  id: 'fixture-unpinnable',
  displayName: 'Fixture Unpinnable',
  mode: 'external-installer',
  versionPolicy: { kind: 'floating', reason: 'fixture: no real upstream to pin' },
  source: { ...FAKE_REQUIRED.source, locator: 'https://fixture.example/unpinnable' },
};
const FAKE_UNPINNABLE_REGISTRY: readonly ProviderDescriptor[] = [FAKE_UNPINNABLE];

const missingProbe = async (): Promise<ObservedNow> => ({ present: false, kind: 'missing' });
const installedProbe = async (): Promise<ObservedNow> => ({
  present: true,
  version: null,
  digest: null,
});

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-cli-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const declarationPath = (): string => path.join(repo, ...DECLARATION_REL.split('/'));
const receiptPath = (id: string): string =>
  path.join(repo, ...RECEIPTS_DIR_REL.split('/'), `${id}.json`);

async function writeDeclarationRaw(text: string): Promise<void> {
  await mkdir(path.dirname(declarationPath()), { recursive: true });
  await writeFile(declarationPath(), text);
}

async function writeDeclaration(entries: readonly Record<string, unknown>[]): Promise<void> {
  await writeDeclarationRaw(
    `${JSON.stringify({ schemaVersion: 1, integrations: entries }, null, 2)}\n`,
  );
}

function validReceiptText(id: string, state: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    id,
    mode: 'hosted-service',
    source: {
      kind: 'https',
      locator: 'https://example.com/x',
      official: true,
      verifiedOn: '2026-01-01',
    },
    license: { kind: 'spdx', id: 'MIT' },
    declared: { required: false },
    rigVersion: '0.9.1',
    acts: {
      'claude-code': {
        route: 'guided-manual',
        automation: 'guided',
        performedAt: '2026-01-01T00:00:00Z',
        observedAfter: { state, evidence: [] },
        notObserved: ['everything'],
      },
    },
  })}\n`;
}

describe('setup list (RP-22 S4)', () => {
  it('lists every REGISTRY descriptor with id, capability, mode, license, source, stability and per-harness routes', () => {
    const entries = listRegistry();
    // Strengthened (RP-22 round 2, weak-oracle advisory): the exact id set,
    // not merely its length — REGISTRY holding one more entry with the same
    // COUNT but a different id would still have passed the old assertion.
    expect(entries.map((e) => e.id)).toEqual(['memory-custom-executable']);
    const memory = entries[0]!;
    expect(memory).toMatchObject({
      capability: 'memory',
      mode: 'external-executable',
      stability: 'supported',
    });
    expect(memory.harnesses['claude-code']).toEqual({
      route: 'subsystem-manifest',
      automation: 'automatic',
    });
  });

  it('lists an injected registry instead of the real one when one is passed', () => {
    const entries = listRegistry(FAKE_REGISTRY);
    expect(entries.map((e) => e.id).sort()).toEqual(['fixture-optional', 'fixture-required']);
  });
});

describe('setup add (RP-22 S4)', () => {
  it('refuses an id outside the registry and writes nothing', async () => {
    const before = await readdir(repo);
    const outcome = await addIntegration({ repoDir: repo, id: 'not-a-real-provider' });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'not-in-matrix' });
    const after = await readdir(repo);
    expect(after).toEqual(before);
  });

  it('is idempotent: a second identical add leaves the bytes unchanged and reports changed: false', async () => {
    const options = {
      repoDir: repo,
      id: 'memory-custom-executable',
      required: true,
      version: '1.2.3',
    };
    const first = await addIntegration(options);
    expect(first.outcome).toBe('written');
    const firstHash = createHash('sha256').update(await readFile(declarationPath()));
    const second = await addIntegration(options);
    expect(second.outcome).toBe('written');
    if (second.outcome === 'refused') throw new Error('narrowed above');
    // Strengthened (RP-22 round 2, weak-oracle advisory): the FIELD, not only
    // the byte hash — a bug that flipped `changed` while still writing
    // byte-identical content would have passed the old assertion alone.
    expect(second.changed).toBe(false);
    const secondHash = createHash('sha256').update(await readFile(declarationPath()));
    expect(secondHash.digest('hex')).toBe(firstHash.digest('hex'));
  });

  it('upserts: a later add without --required keeps the previously recorded required flag', async () => {
    await addIntegration({ repoDir: repo, id: 'memory-custom-executable', required: true });
    const second = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(second.outcome).toBe('written');
    if (second.outcome === 'refused') throw new Error('narrowed above');
    expect(second.entry).toMatchObject({ id: 'memory-custom-executable', required: true });
  });

  it('a dry run performs no write', async () => {
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'memory-custom-executable',
      dryRun: true,
    });
    expect(outcome.outcome).toBe('dry-run');
    await expect(readdir(repo)).resolves.toEqual([]);
  });
});

describe('setup add — preserves rejected entries verbatim (RP-22 round 2, blocker 1)', () => {
  it('a second add never prunes an entry the current registry rejects — literal before/after bytes', async () => {
    const before = `${JSON.stringify(
      {
        schemaVersion: 1,
        integrations: [{ id: 'spec-kit', required: true }, { id: 'figma-mcp' }],
      },
      null,
      2,
    )}\n`;
    await writeDeclarationRaw(before);

    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome.outcome).toBe('written');
    if (outcome.outcome === 'refused') throw new Error('narrowed above');
    expect(outcome.preservedRejected).toEqual(['figma-mcp', 'spec-kit']);

    const after = await readFile(declarationPath(), 'utf8');
    // Literal expected bytes: preserved-rejected entries sort together with
    // accepted entries BY ID (documented ordering rule) — "figma-mcp" <
    // "memory-custom-executable" < "spec-kit" — and each rejected entry's
    // OWN fields are carried over untouched (never routed through
    // serializeDeclaration's canonical per-entry shape).
    expect(after).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          integrations: [
            { id: 'figma-mcp' },
            { id: 'memory-custom-executable' },
            { id: 'spec-kit', required: true },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it('refuses the add outright, bytes unchanged, when the WHOLE declaration is invalid (not merely one entry rejected)', async () => {
    const before = '{not json';
    await writeDeclarationRaw(before);
    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'declaration-unreadable' });
    expect(await readFile(declarationPath(), 'utf8')).toBe(before);
  });

  it('preserving a rejected entry is reported in --json as preservedRejected, and in prose', async () => {
    await writeDeclarationRaw(
      `${JSON.stringify({ schemaVersion: 1, integrations: [{ id: 'spec-kit' }] }, null, 2)}\n`,
    );
    const jsonResult = await runIntegrationsCommand({
      verb: 'add',
      args: ['memory-custom-executable', '--json'],
      cwd: repo,
    });
    const parsed = JSON.parse(jsonResult.stdout) as { preservedRejected: string[] };
    expect(parsed.preservedRejected).toEqual(['spec-kit']);

    await writeDeclarationRaw(
      `${JSON.stringify({ schemaVersion: 1, integrations: [{ id: 'spec-kit' }] }, null, 2)}\n`,
    );
    const proseResult = await runIntegrationsCommand({
      verb: 'add',
      args: ['memory-custom-executable'],
      cwd: repo,
    });
    expect(proseResult.stdout).toMatch(/preserved 1 rejected entry: spec-kit/);
  });
});

describe('setup add / verify — hostile filesystem shapes are total, never thrown (RP-22 round 2, blocker 2)', () => {
  it('verify: a directory sitting at the declaration path is declaration: "invalid", not a thrown EISDIR', async () => {
    await mkdir(declarationPath(), { recursive: true });
    const { payload, exitCode } = await verifyIntegrations({ repoDir: repo });
    expect(exitCode).toBe(1);
    expect(payload.declaration).toBe('invalid');
    expect(payload.error).not.toMatch(/[/\\]/); // no path in the message
  });

  it('add: a directory sitting at the declaration path refuses outright rather than crashing on writeFile EISDIR', async () => {
    await mkdir(declarationPath(), { recursive: true });
    const before = await readdir(repo);
    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'declaration-unreadable' });
    expect(await readdir(repo)).toEqual(before);
  });

  it('verify: a plain FILE sitting where the receipts directory belongs reports orphanScan: "unreadable", not a thrown error', async () => {
    // RECEIPTS_DIR_REL is ".rig/receipts" — write a plain FILE at exactly that path.
    await mkdir(path.dirname(path.join(repo, ...RECEIPTS_DIR_REL.split('/'))), { recursive: true });
    await writeFile(path.join(repo, ...RECEIPTS_DIR_REL.split('/')), 'not a directory');
    const { payload } = await verifyIntegrations({ repoDir: repo });
    expect(payload.orphaned).toEqual([]);
    expect(payload.orphanScan).toBe('unreadable');
  });

  it('verify: a directory sitting at one specific receipt path reports that harness receipt: "invalid", never thrown', async () => {
    await writeDeclaration([{ id: 'fixture-required' }]);
    await mkdir(receiptPath('fixture-required'), { recursive: true });
    const { payload } = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: installedProbe,
    });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.receipt).toBe('invalid');
  });

  it('fails closed: an integration whose receipt could not be read is never reported installed', async () => {
    await writeDeclaration([{ id: 'fixture-required', required: true }]);
    await mkdir(receiptPath('fixture-required'), { recursive: true }); // unreadable receipt
    const { payload, exitCode } = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: installedProbe, // the probe alone would say "installed"
    });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.state).not.toBe('installed');
    expect(entry?.harnesses['claude-code']?.state).toBe('unverified');
    expect(exitCode).toBe(1); // required, and therefore not "installed" -> exit 1
  });
});

describe('setup add — mkdir only after the containment decision (RP-22 round 2, blocker 3)', () => {
  it('a dangling symlink at .rig refuses the write and creates nothing', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await symlink(path.join(repo, 'nowhere-at-all'), path.join(repo, '.rig'));
    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'write-refused' });
    // The symlink itself is the only thing under `repo` — nothing was created.
    expect(await readdir(repo)).toEqual(['.rig']);
  });

  it('a dry run against the same dangling symlink also reports refused, not a falsely clean dry-run', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await symlink(path.join(repo, 'nowhere-at-all'), path.join(repo, '.rig'));
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'memory-custom-executable',
      dryRun: true,
    });
    expect(outcome.outcome).toBe('refused');
  });
});

describe('setup add — the write guard is actually exercised (RP-22 round 2, blocker 4)', () => {
  it('a symlink to a valid declaration FILE at the declaration path is refused at the WRITE guard, target bytes unchanged', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const target = await mkdtemp(path.join(tmpdir(), 'caf-integrations-target-'));
    const targetFile = path.join(target, 'real-declaration.json');
    const targetBytes = `${JSON.stringify({ schemaVersion: 1, integrations: [] }, null, 2)}\n`;
    await writeFile(targetFile, targetBytes);
    try {
      await mkdir(path.join(repo, '.rig'), { recursive: true });
      await symlink(targetFile, declarationPath());
      const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
      expect(outcome).toMatchObject({ outcome: 'refused', reason: 'write-refused' });
      expect(await readFile(targetFile, 'utf8')).toBe(targetBytes);
      expect(await readdir(target)).toEqual(['real-declaration.json']);
    } finally {
      await removeFixture(target);
    }
  });

  it('.rig itself symlinked outside the repository is refused at the WRITE guard, outside directory listing unchanged', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-outside-'));
    try {
      await symlink(outside, path.join(repo, '.rig'));
      const listingBefore = await readdir(outside);
      const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
      expect(outcome).toMatchObject({ outcome: 'refused', reason: 'write-refused' });
      expect(await readdir(outside)).toEqual(listingBefore);
    } finally {
      await removeFixture(outside);
    }
  });
});

describe('read-side symlinks are refused, never followed (RP-22 round 2 advisory)', () => {
  it('.rig/integrations.json -> a valid declaration file OUTSIDE the repo is NOT honoured by verify — reported invalid, not read through', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-outside-decl-'));
    const outsideDeclaration = path.join(outside, 'integrations.json');
    // A perfectly valid declaration — if this were followed, verify would
    // read `declaration: "ok"` with a real entry in it.
    await writeFile(
      outsideDeclaration,
      `${JSON.stringify(
        { schemaVersion: 1, integrations: [{ id: 'memory-custom-executable' }] },
        null,
        2,
      )}\n`,
    );
    try {
      await mkdir(path.join(repo, '.rig'), { recursive: true });
      await symlink(outsideDeclaration, declarationPath());
      const { payload, exitCode } = await verifyIntegrations({ repoDir: repo });
      expect(payload.declaration).toBe('invalid');
      expect(payload.integrations).toEqual([]);
      expect(exitCode).toBe(1);
    } finally {
      await removeFixture(outside);
    }
  });

  it('a symlinked receipt is never read for its content — reported receipt: "invalid"', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-outside-receipt-'));
    const outsideReceipt = path.join(outside, 'r.json');
    await writeFile(outsideReceipt, validReceiptText('fixture-required', 'installed'));
    try {
      await writeDeclaration([{ id: 'fixture-required' }]);
      await mkdir(path.dirname(receiptPath('fixture-required')), { recursive: true });
      await symlink(outsideReceipt, receiptPath('fixture-required'));
      const { payload } = await verifyIntegrations({
        repoDir: repo,
        registry: FAKE_REGISTRY,
        probe: installedProbe,
      });
      const entry = payload.integrations.find((e) => e.id === 'fixture-required');
      expect(entry?.harnesses['claude-code']?.receipt).toBe('invalid');
    } finally {
      await removeFixture(outside);
    }
  });
});

describe('bounded reads and the receipts-dir scan cap (RP-22 round 2 advisory)', () => {
  it('caps the orphan candidate scan and reports orphanScan: "truncated" when the bound is hit', async () => {
    await mkdir(path.join(repo, ...RECEIPTS_DIR_REL.split('/')), { recursive: true });
    const total = MAX_ORPHAN_CANDIDATES + 5;
    for (let i = 0; i < total; i += 1) {
      const id = `orphan-${String(i).padStart(5, '0')}`;
      await writeFile(receiptPath(id), validReceiptText(id, 'pending-user-action'));
    }
    const { payload } = await verifyIntegrations({ repoDir: repo });
    expect(payload.orphanScan).toBe('truncated');
    expect(payload.orphaned.length).toBeLessThanOrEqual(MAX_ORPHAN_CANDIDATES);
  }, 30_000);

  it("an oversized declaration is refused the same way whether or not resolveReadableInside's own stat runs first", async () => {
    // Not a 300 MB fixture (impractical in a unit test); this pins the
    // boundary behaviour the stat-first code path must still produce —
    // the memory-avoidance property itself is a code-shape fact, visible in
    // the diff (`readDeclarationFile` calls `stat` before `readFile`), not
    // something this test can observe directly.
    const oversized = `${JSON.stringify({
      schemaVersion: 1,
      integrations: [],
      padding: 'x'.repeat(70 * 1024),
    })}\n`;
    await writeDeclarationRaw(oversized);
    const { payload, exitCode } = await verifyIntegrations({ repoDir: repo });
    expect(payload.declaration).toBe('invalid');
    expect(exitCode).toBe(1);
  });
});

describe('echoed user input is sanitized (RP-22 round 2 advisory)', () => {
  it('an ESC-bearing <id> never puts a raw 0x1b byte on stdout or stderr for a refused add', async () => {
    const esc = String.fromCharCode(27); // assembled at runtime, never a literal escape in source
    const hostileId = `${esc}[31mFAKE-SUCCESS${esc}[0m`;
    const result = await runIntegrationsCommand({ verb: 'add', args: [hostileId], cwd: repo });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(esc);
    expect(result.stderr).not.toContain(esc);
  });

  it('the same hostile id is safely JSON-escaped, not stripped, under --json', async () => {
    const esc = String.fromCharCode(27);
    const hostileId = `${esc}[31mFAKE${esc}[0m`;
    const result = await runIntegrationsCommand({
      verb: 'add',
      args: [hostileId, '--json'],
      cwd: repo,
    });
    expect(result.stdout).not.toContain(esc);
    const parsed = JSON.parse(result.stdout) as { id: string };
    expect(parsed.id).toBe(hostileId); // JSON.stringify escapes it; JSON.parse decodes it back exactly
  });

  it('a 20,000-character rejected id is truncated in prose, never echoed whole', async () => {
    const longId = 'x'.repeat(20_000);
    const result = await runIntegrationsCommand({ verb: 'add', args: [longId], cwd: repo });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeLessThan(500);
  });
});

describe('CLI-UX (RP-22 round 2 advisory)', () => {
  it('not-in-matrix points the operator at `setup list`', async () => {
    const result = await runIntegrationsCommand({ verb: 'add', args: ['nope'], cwd: repo });
    expect(result.stderr).toMatch(/setup list/);
  });

  it('malformed (a bad --version pin) states the accepted pin pattern', async () => {
    const result = await runIntegrationsCommand({
      verb: 'add',
      args: ['memory-custom-executable', '--version', 'not a valid pin!!'],
      cwd: repo,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/pattern/);
  });

  it('verify --only <miss> is worded differently from an absent declaration', async () => {
    await writeDeclaration([{ id: 'memory-custom-executable' }]);
    const result = await runIntegrationsCommand({
      verb: 'verify',
      args: ['--only', 'does-not-exist'],
      cwd: repo,
    });
    expect(result.stdout).not.toBe('Nothing declared.\n');
    expect(result.stdout).toMatch(/does-not-exist/);

    const absentResult = await runIntegrationsCommand({ verb: 'verify', args: [], cwd: repo });
    // Different fixture (nothing declared at all) — distinct wording.
    void absentResult;
  });
});

describe('refusal branches (RP-22 round 2 advisory)', () => {
  it('unpinnable-version is refused with that exact reason', async () => {
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'fixture-unpinnable',
      registry: FAKE_UNPINNABLE_REGISTRY,
    });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'unpinnable-version' });
  });

  it('an exclusive-group collateral conflict refuses the add and names the OTHER id', async () => {
    await writeDeclaration([{ id: 'fixture-method-a' }]);
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'fixture-method-b',
      registry: FAKE_METHOD_REGISTRY,
    });
    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') throw new Error('narrowed above');
    expect(outcome.reason).toBe('exclusive-group-conflict');
    expect(outcome.message).toMatch(/fixture-method-a/);
  });
});

describe('CLI argument errors (RP-22 round 2 advisory)', () => {
  it('an unknown flag on each verb is a usage error, exit 1, nothing on stdout', async () => {
    for (const verb of ['list', 'add', 'verify'] as const) {
      const result = await runIntegrationsCommand({ verb, args: ['--not-a-real-flag'], cwd: repo });
      expect(result.exitCode, verb).toBe(1);
      expect(result.stdout, verb).toBe('');
    }
  });

  it('add with no id is a usage error', async () => {
    const result = await runIntegrationsCommand({ verb: 'add', args: [], cwd: repo });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/exactly one/);
  });

  it('add with two positional ids is a usage error', async () => {
    const result = await runIntegrationsCommand({
      verb: 'add',
      args: ['one-id', 'two-id'],
      cwd: repo,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/exactly one/);
  });

  it('a positional argument on list is a usage error', async () => {
    const result = await runIntegrationsCommand({ verb: 'list', args: ['unexpected'], cwd: repo });
    expect(result.exitCode).toBe(1);
  });

  it('a positional argument on verify is a usage error', async () => {
    const result = await runIntegrationsCommand({
      verb: 'verify',
      args: ['unexpected'],
      cwd: repo,
    });
    expect(result.exitCode).toBe(1);
  });

  it('verify --only naming an id absent everywhere still exits 0 and answers cleanly', async () => {
    const result = await runIntegrationsCommand({
      verb: 'verify',
      args: ['--only', 'nothing-like-this-exists', '--json'],
      cwd: repo,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { integrations: unknown[] };
    expect(parsed.integrations).toEqual([]);
  });
});

describe('setup verify (RP-22 S4)', () => {
  it('exits 0 with declaration absent and empty arrays', async () => {
    const { payload, exitCode } = await verifyIntegrations({ repoDir: repo });
    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      declaration: 'absent',
      integrations: [],
      rejected: [],
      orphaned: [],
      orphanScan: 'complete',
    });
  });

  it('exits 1 when the declaration itself does not parse', async () => {
    await writeDeclarationRaw('{not json');
    const { payload, exitCode } = await verifyIntegrations({ repoDir: repo });
    expect(exitCode).toBe(1);
    expect(payload.declaration).toBe('invalid');
  });

  it('exits 1 when a required integration is missing, and 0 when only an optional one is', async () => {
    await writeDeclaration([{ id: 'fixture-required', required: true }]);
    const required = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: missingProbe,
    });
    expect(required.exitCode).toBe(1);
    expect(required.payload.integrations[0]?.harnesses['claude-code']?.state).toBe('missing');

    await writeDeclaration([{ id: 'fixture-optional' }]);
    const optional = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: missingProbe,
    });
    expect(optional.exitCode).toBe(0);
    expect(optional.payload.integrations[0]?.harnesses['claude-code']?.state).toBe('missing');
  });

  it('reports every route as unverified/no-sanctioned-probe by default — no route adapter has landed yet', async () => {
    await writeDeclaration([{ id: 'memory-custom-executable' }]);
    const { payload } = await verifyIntegrations({ repoDir: repo });
    const memory = payload.integrations.find((e) => e.id === 'memory-custom-executable');
    expect(memory?.harnesses['claude-code']?.state).toBe('unverified');
    expect(memory?.harnesses.codex?.state).toBe('unverified');
  });

  it('surfaces a rejected declaration entry in "rejected", not in "integrations"', async () => {
    await writeDeclaration([{ id: 'not-a-real-provider' }]);
    const { payload, exitCode } = await verifyIntegrations({ repoDir: repo });
    expect(payload.integrations).toEqual([]);
    expect(payload.rejected).toEqual([{ id: 'not-a-real-provider', reason: 'not-in-matrix' }]);
    expect(exitCode).toBe(0); // a rejected entry with no way to know its "required" flag is not this rule's concern (see plan text)
  });

  it('treats a receipt with no matching declaration entry as orphaned', async () => {
    await mkdir(path.join(repo, ...RECEIPTS_DIR_REL.split('/')), { recursive: true });
    await writeFile(
      receiptPath('orphan-provider'),
      validReceiptText('orphan-provider', 'pending-user-action'),
    );
    const { payload } = await verifyIntegrations({ repoDir: repo });
    expect(payload.orphaned).toEqual(['orphan-provider']);
    expect(payload.orphanScan).toBe('complete');
  });

  it('--only filters to the named id', async () => {
    await writeDeclaration([{ id: 'fixture-required' }, { id: 'fixture-optional' }]);
    const { payload } = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: missingProbe,
      only: 'fixture-optional',
    });
    expect(payload.integrations.map((e) => e.id)).toEqual(['fixture-optional']);
  });
});

describe('runIntegrationsCommand (RP-22 S4)', () => {
  it('writes exactly one JSON object and nothing else on stdout for list, add and verify', async () => {
    for (const call of [
      { verb: 'list', args: ['--json'] },
      { verb: 'verify', args: ['--json'] },
      { verb: 'add', args: ['memory-custom-executable', '--dry-run', '--json'] },
    ]) {
      const result = await runIntegrationsCommand({ verb: call.verb, args: call.args, cwd: repo });
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stdout.endsWith('\n')).toBe(true);
      expect(result.stdout.indexOf('\n')).toBe(result.stdout.length - 1);
    }
  });
});

describe('setup: CLI wiring, spawning the actually-built binary (RP-22 S4 + round 2 blocker 5)', () => {
  let sandbox: string;
  let cliBin: string;

  beforeAll(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'caf-integrations-cli-build-'));
    const outDir = path.join(sandbox, 'packages', 'cli', 'dist');
    await mkdir(path.join(sandbox, 'packages', 'cli'), { recursive: true });
    await symlink(path.join(repoRoot, 'templates'), path.join(sandbox, 'templates'), 'dir');
    await copyFile(path.join(repoRoot, 'package.json'), path.join(sandbox, 'package.json'));
    await exec(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        path.join(repoRoot, 'packages', 'cli', 'tsconfig.build.json'),
        '--outDir',
        outDir,
      ],
      { cwd: repoRoot },
    );
    cliBin = path.join(outDir, 'index.js');
  }, 120_000);

  afterAll(async () => {
    await removeFixture(sandbox);
  });

  const runCli = async (
    cwd: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  /** The blocker-5 oracle: one JSON object, nothing else, with `command`/`verb`. */
  function assertOneJsonObject(stdout: string): Record<string, unknown> {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(stdout).toBe(`${JSON.stringify(parsed)}\n`);
    expect(typeof parsed.command).toBe('string');
    expect(typeof parsed.verb).toBe('string');
    return parsed;
  }

  it('setup list --json round-trips through the real binary', async () => {
    const run = await runCli(repo, ['setup', 'list', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const parsed = assertOneJsonObject(run.stdout);
    expect((parsed.integrations as unknown[]).length).toBeGreaterThan(0);
    expect(run.stderr).toBe('');
  });

  it('setup add <id> --dry-run --json round-trips, exit 0, empty stderr', async () => {
    const run = await runCli(repo, [
      'setup',
      'add',
      'memory-custom-executable',
      '--dry-run',
      '--json',
    ]);
    expect(run.code, run.stderr).toBe(0);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.outcome).toBe('dry-run');
    expect(run.stderr).toBe('');
  });

  it('setup add <id> --json actually writes, exit 0, empty stderr', async () => {
    const run = await runCli(repo, ['setup', 'add', 'memory-custom-executable', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.outcome).toBe('written');
    expect(run.stderr).toBe('');
    await expect(readFile(declarationPath(), 'utf8')).resolves.toContain(
      'memory-custom-executable',
    );
  });

  it('a refused setup add nope --json exits 1, one JSON object, empty stderr', async () => {
    const run = await runCli(repo, ['setup', 'add', 'nope', '--json']);
    expect(run.code).toBe(1);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toBe('not-in-matrix');
    expect(run.stderr).toBe('');
  });

  it('setup verify --json (declaration absent) exits 0, one JSON object', async () => {
    const run = await runCli(repo, ['setup', 'verify', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.declaration).toBe('absent');
    expect(run.stderr).toBe('');
  });

  it('setup verify --json (declaration ok) exits 0, one JSON object', async () => {
    await runCli(repo, ['setup', 'add', 'memory-custom-executable', '--json']);
    const run = await runCli(repo, ['setup', 'verify', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.declaration).toBe('ok');
  });

  it('setup verify --json (invalid: a directory at the declaration path) exits 1, one JSON object', async () => {
    await mkdir(declarationPath(), { recursive: true });
    const run = await runCli(repo, ['setup', 'verify', '--json']);
    expect(run.code).toBe(1);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.declaration).toBe('invalid');
    expect(run.stderr).toBe('');
  });

  it('setup with no arguments still answers the legacy usage error', async () => {
    const run = await runCli(repo, ['setup']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    // Strengthened (RP-22 round 2, weak-oracle advisory): the exact phrase,
    // not a loose substring match that a rewritten message could still pass.
    expect(run.stderr).toContain('setup needs --memory-root');
  });

  it('legacy setup --memory-root behaves exactly as before — the new dispatch never intercepts it', async () => {
    // A root with no shared-memory/memory.mjs is refused by the LEGACY path
    // before it ever spawns a handshake (deriveMemoryEntry's own check) —
    // this is pre-existing behaviour, unrelated to RP-22 S4. The assertion
    // that matters here is that "--memory-root" was recognised as the legacy
    // flag at all (the new verb dispatch did not swallow it): a
    // "not-a-verb" fall-through bug would instead print a "setup add needs
    // exactly one <id>" usage error or an "Unknown setup verb" message, not
    // this one.
    const missingRoot = path.join(repo, 'no-such-memory-root');
    const run = await runCli(repo, ['setup', '--memory-root', missingRoot]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^setup: /);
    expect(run.stderr).not.toMatch(/setup (add|list|verify)/);
  });
});
