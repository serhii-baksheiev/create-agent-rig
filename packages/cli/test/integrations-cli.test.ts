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
import { execFile, execFileSync, spawn } from 'node:child_process';
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
import { fifosAvailable, skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

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
    // `toContain` + a shape check, not an exact-array pin (RP-22 round 3
    // advisory: an exact id-array assertion breaks on every later slice that
    // adds a real descriptor to REGISTRY, for a reason unrelated to this
    // test's own claim).
    expect(entries.map((e) => e.id)).toContain('memory-custom-executable');
    for (const entry of entries) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.displayName).toBe('string');
      expect(['methodology', 'design', 'board', 'memory']).toContain(entry.capability);
      expect([
        'external-installer',
        'native-plugin',
        'hosted-service',
        'external-executable',
      ]).toContain(entry.mode);
      expect(['supported', 'preview']).toContain(entry.stability);
    }
    const memory = entries.find((e) => e.id === 'memory-custom-executable')!;
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
    // Each preserved id carries its OWN rejection reason (RP-22 round 3
    // ruling) — both happen to be not-in-matrix here, against the real
    // REGISTRY, which holds exactly one descriptor at this slice.
    expect(outcome.preservedRejected).toEqual([
      { id: 'figma-mcp', reason: 'explicit-selection-required' },
      { id: 'spec-kit', reason: 'not-in-matrix' },
    ]);

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

  it('preserving a rejected entry is reported in --json as preservedRejected: [{id, reason}], and in prose with its reason', async () => {
    await writeDeclarationRaw(
      `${JSON.stringify({ schemaVersion: 1, integrations: [{ id: 'spec-kit' }] }, null, 2)}\n`,
    );
    const jsonResult = await runIntegrationsCommand({
      verb: 'add',
      args: ['memory-custom-executable', '--json'],
      cwd: repo,
    });
    const parsed = JSON.parse(jsonResult.stdout) as {
      preservedRejected: { id: string; reason: string }[];
    };
    expect(parsed.preservedRejected).toEqual([{ id: 'spec-kit', reason: 'not-in-matrix' }]);

    await writeDeclarationRaw(
      `${JSON.stringify({ schemaVersion: 1, integrations: [{ id: 'spec-kit' }] }, null, 2)}\n`,
    );
    const proseResult = await runIntegrationsCommand({
      verb: 'add',
      args: ['memory-custom-executable'],
      cwd: repo,
    });
    expect(proseResult.stdout).toMatch(/preserved 1 rejected entry: spec-kit \(not-in-matrix\)/);
  });

  it('preserved entries are stable across a second, otherwise-identical add', async () => {
    await writeDeclarationRaw(
      `${JSON.stringify({ schemaVersion: 1, integrations: [{ id: 'spec-kit' }] }, null, 2)}\n`,
    );
    const first = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(first.outcome).toBe('written');
    const firstBytes = await readFile(declarationPath(), 'utf8');
    const second = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(second.outcome).toBe('written');
    if (second.outcome === 'refused') throw new Error('narrowed above');
    expect(second.changed).toBe(false);
    expect(second.preservedRejected).toEqual([{ id: 'spec-kit', reason: 'not-in-matrix' }]);
    expect(await readFile(declarationPath(), 'utf8')).toBe(firstBytes);
  });
});

describe('setup add — preservation fidelity, and its documented limits (RP-22 round 3 advisory)', () => {
  it('a huge number literal in a preserved entry is lossy (JS number precision) — 1e400 round-trips to null, stated as a limit', async () => {
    // Written as raw JSON text, not a JS numeric literal (`1e400` in source
    // would itself be flagged by `no-loss-of-precision` — the overflow it
    // warns about at author time is exactly the behaviour this test pins at
    // parse time).
    await writeDeclarationRaw(
      '{\n  "schemaVersion": 1,\n  "integrations": [\n    { "id": "spec-kit", "weight": 1e400 }\n  ]\n}\n',
    );
    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome.outcome).toBe('written');
    const after = JSON.parse(await readFile(declarationPath(), 'utf8')) as {
      integrations: { id: string; weight?: unknown }[];
    };
    const specKit = after.integrations.find((e) => e.id === 'spec-kit')!;
    // JSON.stringify(Infinity) is "null" — value preservation, not byte
    // preservation, is lossy here BY CONSTRUCTION (JS numbers have no
    // Infinity representation in JSON), and this is exactly that case.
    expect(specKit.weight).toBeNull();
  });

  it("duplicate keys in a preserved entry collapse to the LAST value (JSON.parse's own behaviour) — stated as a limit", async () => {
    // A hand-built string, not JSON.stringify(...) — JSON.stringify can
    // never PRODUCE a duplicate key, so this is the one case where the
    // fixture cannot be built through the same JSON.stringify helper every
    // other test in this file uses.
    const before =
      '{\n  "schemaVersion": 1,\n  "integrations": [\n    { "id": "spec-kit", "required": true, "required": false }\n  ]\n}\n';
    await writeDeclarationRaw(before);
    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome.outcome).toBe('written');
    const after = JSON.parse(await readFile(declarationPath(), 'utf8')) as {
      integrations: { id: string; required?: boolean }[];
    };
    const specKit = after.integrations.find((e) => e.id === 'spec-kit')!;
    expect(specKit.required).toBe(false); // the LAST of the two duplicate keys wins
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
    const { payload, exitCode } = await verifyIntegrations({ repoDir: repo });
    expect(payload.orphaned).toEqual([]);
    expect(payload.orphanScan).toBe('unreadable');
    // No declaration at all, and an unreadable receipts dir does not itself
    // fail verify (RP-22 round 4 advisory: exit codes pinned explicitly).
    expect(exitCode).toBe(0);
  });

  it('verify: a directory sitting at one specific receipt path reports that harness receipt: "invalid", never thrown', async () => {
    await writeDeclaration([{ id: 'fixture-required' }]);
    await mkdir(receiptPath('fixture-required'), { recursive: true });
    const { payload, exitCode } = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: installedProbe,
    });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.receipt).toBe('invalid');
    // Not required, so the unreadable receipt does not fail the whole run.
    expect(exitCode).toBe(0);
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
    // Identity, not merely a count (RP-22 round 4 advisory: a count alone
    // cannot tell "the first 500, sorted" apart from "any 500"). Ids are
    // zero-padded and sorted lexicographically, so the FIRST candidate must
    // survive and the one at exactly the cap's own index must not.
    expect(payload.orphaned.length).toBe(MAX_ORPHAN_CANDIDATES);
    expect(payload.orphaned[0]).toBe('orphan-00000');
    expect(payload.orphaned).not.toContain(
      `orphan-${String(MAX_ORPHAN_CANDIDATES).padStart(5, '0')}`,
    );
  }, 30_000);

  it('an oversized declaration is refused at the boundary value, exactly 64 KiB vs 64 KiB + 1', async () => {
    // Not a 300 MB fixture (impractical in a unit test); this pins the
    // EXACT boundary the size check must still produce. The padding lives
    // on an ENTRY's own unknown key (rejected as "malformed", not fatal to
    // the whole file) rather than a root key, which `declaration.ts`'s
    // closed root-key set would refuse regardless of size — this test is
    // about the byte cap specifically.
    const atCap = `${JSON.stringify({
      schemaVersion: 1,
      integrations: [{ id: 'padded-entry', padding: 'x'.repeat(64 * 1024 - 150) }],
    })}\n`;
    expect(Buffer.byteLength(atCap)).toBeLessThanOrEqual(64 * 1024);
    await writeDeclarationRaw(atCap);
    const ok = await verifyIntegrations({ repoDir: repo });
    expect(ok.payload.declaration).toBe('ok');

    const overCap = `${JSON.stringify({
      schemaVersion: 1,
      integrations: [{ id: 'padded-entry', padding: 'x'.repeat(64 * 1024) }],
    })}\n`;
    expect(Buffer.byteLength(overCap)).toBeGreaterThan(64 * 1024);
    await writeDeclarationRaw(overCap);
    const invalid = await verifyIntegrations({ repoDir: repo });
    expect(invalid.payload.declaration).toBe('invalid');
    expect(invalid.exitCode).toBe(1);
  });
});

describe('an unreadable individual orphan candidate is never silently "complete" (RP-22 round 4, advisory)', () => {
  it('a symlinked receipt among orphan candidates is excluded from orphaned, and orphanScan reports it', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-orphan-outside-'));
    try {
      await mkdir(path.dirname(receiptPath('symlinked-orphan')), { recursive: true });
      const outsideReceipt = path.join(outside, 'r.json');
      await writeFile(outsideReceipt, validReceiptText('symlinked-orphan', 'installed'));
      await symlink(outsideReceipt, receiptPath('symlinked-orphan'));
      const { payload } = await verifyIntegrations({ repoDir: repo });
      expect(payload.orphaned).not.toContain('symlinked-orphan');
      expect(payload.orphanScan).toBe('unreadable');
    } finally {
      await removeFixture(outside);
    }
  });

  it('a FIFO among orphan candidates is excluded from orphaned, and orphanScan reports it, without hanging', async (ctx) => {
    skipUnless(ctx, fifosAvailable().ok, fifosAvailable().reason);
    await mkdir(path.dirname(receiptPath('fifo-orphan')), { recursive: true });
    execFileSync('mkfifo', [receiptPath('fifo-orphan')]);
    const { payload } = await verifyIntegrations({ repoDir: repo });
    expect(payload.orphaned).not.toContain('fifo-orphan');
    expect(payload.orphanScan).toBe('unreadable');
  }, 10_000);

  it('a readable file that merely fails receipt validation is NOT "unreadable" — it is just not a receipt (RP-22 round 5)', async () => {
    await mkdir(path.dirname(receiptPath('not-a-receipt')), { recursive: true });
    // A plain file, readable end to end (resolveReadableInside says "ok",
    // stat and readFile both succeed) — it fails only `parseReceipt`'s own
    // schema check. That is a fact about its CONTENT, not about whether the
    // scan could examine it, so it must not be conflated with a symlink, a
    // FIFO, or an oversized file (all of which the scan genuinely could not
    // read at all).
    await writeFile(receiptPath('not-a-receipt'), 'not a valid receipt at all');
    const { payload } = await verifyIntegrations({ repoDir: repo });
    expect(payload.orphaned).not.toContain('not-a-receipt');
    expect(payload.orphanScan).toBe('complete');
  });
});

describe('renderVerifyProse prints the orphan-scan note in prose, not only in --json (RP-22 round 4, blocker 4)', () => {
  it('prints the truncated note, with the exact cap number, when the scan hit MAX_ORPHAN_CANDIDATES', async () => {
    await mkdir(path.join(repo, ...RECEIPTS_DIR_REL.split('/')), { recursive: true });
    const total = MAX_ORPHAN_CANDIDATES + 5;
    for (let i = 0; i < total; i += 1) {
      const id = `orphan-${String(i).padStart(5, '0')}`;
      await writeFile(receiptPath(id), validReceiptText(id, 'pending-user-action'));
    }
    const result = await runIntegrationsCommand({ verb: 'verify', args: [], cwd: repo });
    expect(result.stdout).toContain(
      `(orphan scan: truncated at ${MAX_ORPHAN_CANDIDATES} candidates — some receipts were not examined)\n`,
    );
  }, 30_000);

  it('prints the incomplete note when a plain FILE sits where the receipts directory belongs (RP-22 round 5)', async () => {
    await mkdir(path.dirname(path.join(repo, ...RECEIPTS_DIR_REL.split('/'))), { recursive: true });
    await writeFile(path.join(repo, ...RECEIPTS_DIR_REL.split('/')), 'not a directory');
    const result = await runIntegrationsCommand({ verb: 'verify', args: [], cwd: repo });
    expect(result.stdout).toContain(
      '(orphan scan: incomplete — the receipts directory or one of its entries could not be read)\n',
    );
  });

  it('prints the SAME incomplete note when the directory itself is readable but one candidate is a symlink (RP-22 round 5)', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-orphan-note-outside-'));
    try {
      // An empty but VALID declaration: renderVerifyProse's "no declaration
      // at all" branch returns before it ever reaches the orphaned-list
      // loop, so an absent declaration here would silently hide the
      // "real-orphan" assertion below rather than genuinely exercise it.
      await writeDeclaration([]);
      await mkdir(path.dirname(receiptPath('symlinked-orphan')), { recursive: true });
      // A genuine orphan alongside the symlinked one, so this note is proven
      // to coexist with real findings rather than only firing when the scan
      // has nothing else to report.
      await writeFile(receiptPath('real-orphan'), validReceiptText('real-orphan', 'installed'));
      const outsideReceipt = path.join(outside, 'r.json');
      await writeFile(outsideReceipt, validReceiptText('symlinked-orphan', 'installed'));
      await symlink(outsideReceipt, receiptPath('symlinked-orphan'));
      const result = await runIntegrationsCommand({ verb: 'verify', args: [], cwd: repo });
      expect(result.stdout).toContain('real-orphan: orphaned receipt, no declaration');
      expect(result.stdout).toContain(
        '(orphan scan: incomplete — the receipts directory or one of its entries could not be read)\n',
      );
    } finally {
      await removeFixture(outside);
    }
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
    const missResult = await runIntegrationsCommand({
      verb: 'verify',
      args: ['--only', 'does-not-exist'],
      cwd: repo,
    });
    expect(missResult.stdout).toBe('No integration named "does-not-exist" is declared here.\n');

    // Same repo, no --only at all: a DECLARED entry exists, so this is not
    // "nothing declared" either — it is its own third case. Cleared and
    // re-checked with a genuinely empty declaration for the actual
    // three-way comparison this test is named for.
    const withOnly = missResult.stdout;

    await removeFixture(repo);
    repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-cli-'));
    const absentResult = await runIntegrationsCommand({ verb: 'verify', args: [], cwd: repo });
    expect(absentResult.stdout).toBe('No .rig/integrations.json in this repository.\n');
    expect(absentResult.stdout).not.toBe(withOnly);
  });
});

describe('refusal branches (RP-22 round 2 advisory)', () => {
  it('unpinnable-version is refused with that exact reason, and writes nothing', async () => {
    const before = await readdir(repo);
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'fixture-unpinnable',
      registry: FAKE_UNPINNABLE_REGISTRY,
    });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'unpinnable-version' });
    expect(await readdir(repo)).toEqual(before);
  });

  it('an exclusive-group collateral conflict refuses the add, names the OTHER id, and leaves the declaration untouched', async () => {
    await writeDeclaration([{ id: 'fixture-method-a' }]);
    const before = await readFile(declarationPath(), 'utf8');
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'fixture-method-b',
      registry: FAKE_METHOD_REGISTRY,
    });
    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') throw new Error('narrowed above');
    expect(outcome.reason).toBe('exclusive-group-conflict');
    expect(outcome.message).toMatch(/fixture-method-a/);
    expect(await readFile(declarationPath(), 'utf8')).toBe(before);
  });

  it('re-validates the ACTUAL rewritten bytes, not just the narrower candidate: both exclusive-group members already declared, add M1 still refuses, bytes unchanged', async () => {
    // Both M1 and M2 are already declared — `readDeclarationFile` re-parses
    // this FRESH against the current registry and finds BOTH rejected
    // (exclusive-group-conflict), so NEITHER is in `previousEntries`.
    // `candidateText` (M1 alone, since M2 isn't "accepted") sees no
    // conflict and would accept M1 on its own — the gap this test closes:
    // `finalText` merges M1 back in ALONGSIDE the preserved-raw M2, and
    // re-parsing THAT (what is actually about to be written) finds the
    // same conflict again (RP-22 round 4 advisory).
    await writeDeclaration([{ id: 'fixture-method-a' }, { id: 'fixture-method-b' }]);
    const before = await readFile(declarationPath(), 'utf8');
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'fixture-method-a',
      registry: FAKE_METHOD_REGISTRY,
    });
    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') throw new Error('narrowed above');
    expect(outcome.reason).toBe('exclusive-group-conflict');
    expect(await readFile(declarationPath(), 'utf8')).toBe(before);
  });
});

describe('reject a control character in <id>/--version/--only at the argument boundary (RP-22 round 3, advisory)', () => {
  it('an id with a control character is refused with its own message, never reaching the generic declaration-invalid path', async () => {
    const esc = String.fromCharCode(27);
    const outcome = await addIntegration({ repoDir: repo, id: `bad${esc}id` });
    expect(outcome).toMatchObject({
      outcome: 'refused',
      reason: 'malformed',
      message: 'the id contains a control or format character',
    });
  });

  it('a --version with a control character is refused with its own message', async () => {
    const esc = String.fromCharCode(27);
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'memory-custom-executable',
      version: `1.0${esc}`,
    });
    expect(outcome).toMatchObject({
      outcome: 'refused',
      reason: 'malformed',
      message: 'the version pin contains a control or format character',
    });
  });

  it('setup verify --only with a control character is a usage error, distinct from "not found"', async () => {
    const esc = String.fromCharCode(27);
    const result = await runIntegrationsCommand({
      verb: 'verify',
      args: ['--only', `x${esc}y`],
      cwd: repo,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(esc);
    expect(result.stderr).toMatch(/control or format character/);
  });

  it("the reparsed.status === 'invalid' branch IS reachable — a long, control-char-free <id> alone exceeds the 64 KiB file cap", async () => {
    // What used to be marked `c8 ignore` as "unreachable" — closed for the
    // CONTROL-CHARACTER cause by the boundary checks above, but a `<id>`
    // this long has no length bound of its own and pushes the whole
    // candidate declaration over the cap by itself.
    const longId = 'a'.repeat(70 * 1024);
    const outcome = await addIntegration({ repoDir: repo, id: longId });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'declaration-unreadable' });
  });
});

/**
 * `count` compact (no-whitespace) rejected entries — none is a real
 * REGISTRY id, so every one is preserved verbatim by a later `add`.
 * Compact JSON stays small; this format's canonical two-space, one-line-
 * per-key re-indentation of the SAME entries is measurably larger (RP-22
 * round 3, blocker 1 — a round-2 regression: gate cycle 2 measured a real
 * 12,055-byte file becoming 66,153 bytes on rewrite). Measured directly for
 * this fixture shape (not guessed): 1600 entries compact to 38,436 bytes and
 * pretty-print to 67,249 bytes — comfortably on either side of the 65,536-byte
 * (64 KiB) cap.
 */
function manyRejectedEntriesCompact(count: number): string {
  const integrations = Array.from({ length: count }, (_, i) => ({
    id: `rejected-${String(i).padStart(5, '0')}`,
  }));
  return JSON.stringify({ schemaVersion: 1, integrations });
}

describe('setup add — the rewritten declaration is size-checked BEFORE it is written (RP-22 round 3, blocker 1)', () => {
  it('a rewrite that still fits is written, and verify can read it back', async () => {
    const before = manyRejectedEntriesCompact(10);
    expect(Buffer.byteLength(before)).toBeLessThan(64 * 1024);
    await writeDeclarationRaw(before);
    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome.outcome).toBe('written');
    const { payload } = await verifyIntegrations({ repoDir: repo });
    expect(payload.declaration).toBe('ok');
  });

  it('a rewrite that would exceed 64 KiB is refused with declaration-too-large, bytes unchanged (sha256), directory listing unchanged', async () => {
    // Compact and comfortably under the cap AS COMMITTED — declaration.ts's
    // own read-time check would happily accept this file. Pretty-printed
    // (this format's canonical write shape) it comfortably exceeds the cap:
    // the round-2 regression this blocker closes.
    const before = manyRejectedEntriesCompact(1600);
    expect(Buffer.byteLength(before)).toBeLessThan(64 * 1024);
    await writeDeclarationRaw(before);
    const beforeHash = createHash('sha256').update(before).digest('hex');
    const dirBefore = await readdir(path.dirname(declarationPath()));

    const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'declaration-too-large' });

    const afterBytes = await readFile(declarationPath());
    expect(createHash('sha256').update(afterBytes).digest('hex')).toBe(beforeHash);
    expect(await readdir(path.dirname(declarationPath()))).toEqual(dirBefore);
  });

  it('--dry-run against the same oversized-after-rewrite fixture refuses identically, not a falsely clean preview', async () => {
    const before = manyRejectedEntriesCompact(1600);
    await writeDeclarationRaw(before);
    const outcome = await addIntegration({
      repoDir: repo,
      id: 'memory-custom-executable',
      dryRun: true,
    });
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'declaration-too-large' });
    expect(await readFile(declarationPath(), 'utf8')).toBe(before);
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

describe('setup verify — the success path and receipt mapping (RP-22 round 3, blocker 5)', () => {
  it('a required entry reaches state "installed" on its one applicable harness, via a matching probe + receipt, and exits 0', async () => {
    await writeDeclaration([{ id: 'fixture-required', required: true }]);
    await mkdir(path.dirname(receiptPath('fixture-required')), { recursive: true });
    // A receipt whose recorded version matches what the probe below reports,
    // so classify() has a confirmed baseline.
    await writeFile(
      receiptPath('fixture-required'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'fixture-required',
        mode: 'hosted-service',
        source: {
          kind: 'https',
          locator: 'https://example.com/x',
          official: true,
          verifiedOn: '2026-01-01',
        },
        license: { kind: 'spdx', id: 'MIT' },
        declared: { required: true },
        rigVersion: '0.9.1',
        acts: {
          'claude-code': {
            route: 'guided-manual',
            automation: 'guided',
            performedAt: '2026-01-01T00:00:00Z',
            observedAfter: { state: 'installed', version: '1.0.0', evidence: ['fixture'] },
            notObserved: [],
          },
        },
      })}\n`,
    );
    const matchingProbe = async (): Promise<ObservedNow> => ({
      present: true,
      version: '1.0.0',
      digest: null,
    });
    const { payload, exitCode } = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: matchingProbe,
    });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']).toMatchObject({
      state: 'installed',
      receipt: 'present',
    });
    expect(exitCode).toBe(0);
  });

  it('receipt: "present" when a valid receipt exists for that harness', async () => {
    await writeDeclaration([{ id: 'fixture-required' }]);
    await mkdir(path.dirname(receiptPath('fixture-required')), { recursive: true });
    await writeFile(
      receiptPath('fixture-required'),
      validReceiptText('fixture-required', 'pending-user-action'),
    );
    const { payload } = await verifyIntegrations({ repoDir: repo, registry: FAKE_REGISTRY });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.receipt).toBe('present');
  });

  it('receipt: "absent" when no receipt file exists for that id', async () => {
    await writeDeclaration([{ id: 'fixture-required' }]);
    const { payload } = await verifyIntegrations({ repoDir: repo, registry: FAKE_REGISTRY });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.receipt).toBe('absent');
  });

  it('notObserved is taken from the receipt\'s own act, not the ["everything"] default, when a receipt exists', async () => {
    await writeDeclaration([{ id: 'fixture-required' }]);
    await mkdir(path.dirname(receiptPath('fixture-required')), { recursive: true });
    await writeFile(
      receiptPath('fixture-required'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'fixture-required',
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
            observedAfter: { state: 'pending-user-action', evidence: [] },
            notObserved: ['authorization', 'connectivity'],
          },
        },
      })}\n`,
    );
    const { payload } = await verifyIntegrations({ repoDir: repo, registry: FAKE_REGISTRY });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.notObserved).toEqual(['authorization', 'connectivity']);
  });

  it('a receipt-recorded version against a probe reporting version: null reads "unverified" — derived from state.ts\'s own classify() rules', async () => {
    // Derivation, not execution: state.ts's classify() computes
    // `hasKnownVersionBaseline = declared.version !== undefined ||
    // (receipt !== undefined && receipt.version !== null)` — true here,
    // since the receipt recorded "1.0.0" — then
    // `versionUnconfirmed = observed.version === null && hasKnownVersionBaseline`
    // — true, since the probe reports version: null — and returns
    // 'unverified' on that branch BEFORE any drift comparison runs. This is
    // read from that module's own documented rule, not obtained by running
    // this code and copying its answer.
    await writeDeclaration([{ id: 'fixture-required' }]);
    await mkdir(path.dirname(receiptPath('fixture-required')), { recursive: true });
    await writeFile(
      receiptPath('fixture-required'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'fixture-required',
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
            observedAfter: { state: 'installed', version: '1.0.0', evidence: [] },
            notObserved: [],
          },
        },
      })}\n`,
    );
    const probeWithNullVersion = async (): Promise<ObservedNow> => ({
      present: true,
      version: null,
      digest: null,
    });
    const { payload } = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: probeWithNullVersion,
    });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.state).toBe('unverified');
  });

  it('a receipt-recorded version against a DIFFERENT, non-null probe version reads "drifted" — derived from state.ts\'s own classify() rules', async () => {
    // Derivation, not execution: `hasKnownVersionBaseline` is true (the
    // receipt recorded "1.0.0"); `versionUnconfirmed` is false this time
    // (the probe's version is NOT null); `declaredVersionDiffers` is false
    // (no `--version` was declared); `receiptDiffers` is true —
    // `receipt.version !== null && observed.version !== null &&
    // receipt.version !== observed.version` — "1.0.0" !== "2.0.0" — so
    // `classify` returns 'drifted' on that branch.
    await writeDeclaration([{ id: 'fixture-required' }]);
    await mkdir(path.dirname(receiptPath('fixture-required')), { recursive: true });
    await writeFile(
      receiptPath('fixture-required'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'fixture-required',
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
            observedAfter: { state: 'installed', version: '1.0.0', evidence: [] },
            notObserved: [],
          },
        },
      })}\n`,
    );
    const probeWithDifferentVersion = async (): Promise<ObservedNow> => ({
      present: true,
      version: '2.0.0',
      digest: null,
    });
    const { payload } = await verifyIntegrations({
      repoDir: repo,
      registry: FAKE_REGISTRY,
      probe: probeWithDifferentVersion,
    });
    const entry = payload.integrations.find((e) => e.id === 'fixture-required');
    expect(entry?.harnesses['claude-code']?.state).toBe('drifted');
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

describe('setup CLI diagnostics (RP-22 S5)', () => {
  it('the shipped executable names apply and remove alongside every other supported setup verb for an unknown bare verb', async () => {
    try {
      await exec(
        process.execPath,
        [path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'setup', 'verifyy'],
        {
          cwd: repo,
        },
      );
      throw new Error('unknown setup verb unexpectedly succeeded');
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      expect(result.code).toBe(1);
      expect(result.stdout ?? '').toBe('');
      expect(result.stderr ?? '').toMatch(/list, add, verify, apply, remove/);
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

  it('a typo near the three verbs (setup verifyy) is a usage error naming list/add/verify, not the legacy message', async () => {
    const run = await runCli(repo, ['setup', 'verifyy']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/list, add, verify/);
    // Distinct from the LEGACY usage error specifically (`setup needs
    // --memory-root <checkout>`) — mentioning `--memory-root` as a pointer
    // to the legacy path alongside the three verbs is fine; repeating the
    // legacy message VERBATIM would not be.
    expect(run.stderr).not.toContain('setup needs --memory-root');
  });

  it('a required id through the REAL registry, with the default probe, exits 1 (spawned CLI, no adapter exists yet)', async () => {
    // This is the honest-by-default claim S4 makes: marking ANYTHING
    // required, against the real REGISTRY, with no route adapter landed,
    // can never read "installed" — verified end to end through the ACTUAL
    // BUILT BINARY (RP-22 round 4, blocker 3 — this used to call
    // `runIntegrationsCommand` in-process, which is not what the name or
    // the doc claimed).
    const addRun = await runCli(repo, [
      'setup',
      'add',
      'memory-custom-executable',
      '--required',
      '--json',
    ]);
    expect(addRun.code, addRun.stderr).toBe(0);
    expect(assertOneJsonObject(addRun.stdout).outcome).toBe('written');

    const verifyRun = await runCli(repo, ['setup', 'verify', '--json']);
    expect(verifyRun.code).toBe(1);
    const parsed = assertOneJsonObject(verifyRun.stdout) as {
      integrations: { harnesses: Record<string, { state: string }> }[];
    };
    expect(parsed.integrations[0]!.harnesses['claude-code']!.state).toBe('unverified');
    expect(parsed.integrations[0]!.harnesses['codex']!.state).toBe('unverified');
  });

  it('an id with a control character is refused with reason malformed, ONE JSON object, exit 1', async () => {
    const esc = String.fromCharCode(27);
    const run = await runCli(repo, ['setup', 'add', `bad${esc}id`, '--json']);
    expect(run.code).toBe(1);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toBe('malformed');
    expect(run.stdout).not.toContain(esc);
  });

  it('a --version with a control character is refused with reason malformed, ONE JSON object, exit 1', async () => {
    const esc = String.fromCharCode(27);
    const run = await runCli(repo, [
      'setup',
      'add',
      'memory-custom-executable',
      '--version',
      `1.0${esc}`,
      '--json',
    ]);
    expect(run.code).toBe(1);
    const parsed = assertOneJsonObject(run.stdout);
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toBe('malformed');
    expect(run.stdout).not.toContain(esc);
  });

  it('verify --only with a control character is a USAGE error (empty stdout), not a one-object refusal', async () => {
    const esc = String.fromCharCode(27);
    const run = await runCli(repo, ['setup', 'verify', '--only', `x${esc}y`, '--json']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toContain(esc);
  });

  it('an unknown flag carrying a raw escape is stripped before reaching stderr — prose invocation', async () => {
    const esc = String.fromCharCode(27);
    const run = await runCli(repo, ['setup', 'list', `--${esc}[31mbogus`]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toContain(esc);
  });

  it('an unknown flag carrying a raw escape is stripped before reaching stderr — --json invocation', async () => {
    const esc = String.fromCharCode(27);
    const run = await runCli(repo, ['setup', 'add', `--${esc}[31mbogus`, '--json']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(''); // a usage error, not a --json refusal (blocker 2)
    expect(run.stderr).not.toContain(esc);
  });

  it('the write-refused --json payload names no host-derived or absolute path in its error field (RP-22 round 5, narrowed from round 4 blocker 5)', async (ctx) => {
    // This is one specific payload — the fixed `write-refused` message — not
    // a claim about every payload this surface can produce: a caller-typed
    // <id> that happens to look like a path (e.g. "/etc/passwd") IS echoed
    // back elsewhere in the payload, sanitised and length-truncated, because
    // it is the caller's own input read back at them, not a path this
    // surface derived (docs/command-contract.md, "## setup integrations
    // (RP-22)").
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-integrations-path-scan-'));
    try {
      await symlink(outside, path.join(repo, '.rig'));
      const run = await runCli(repo, ['setup', 'add', 'memory-custom-executable', '--json']);
      expect(run.code).toBe(1);
      const parsed = assertOneJsonObject(run.stdout) as { reason: string; error?: string };
      expect(parsed.reason).toBe('write-refused');
      expect(parsed.error).toBeDefined();
      expect(parsed.error).not.toMatch(/[/\\]/);
    } finally {
      await removeFixture(outside);
    }
  });

  describe('EPIPE on a closed stdout exits quietly, without corrupting the real exit code (RP-22 round 4, blocker 1)', () => {
    // Nested inside "CLI wiring" so it shares that describe's `cliBin` (the
    // actually-built binary this whole block spawns).
    async function spawnWithEarlyStdoutClose(
      args: string[],
      cwd: string,
    ): Promise<{ code: number | null; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cliBin, ...args], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Destroyed SYNCHRONOUSLY, before any listener is attached and
        // before the child has written a single byte — round 5: the
        // previous recipe (destroy after the first `data` chunk) let the
        // child finish writing on Linux often enough that the handler never
        // fired (measured: 0/200 at a 73.9 KB payload), so the test passed
        // against both the fixed handler and the round-3 bug it exists to
        // catch. Destroying before the pipe ever carries a byte fires the
        // handler on every run, at any payload size — this is what makes
        // the recipe deterministic rather than a timing race.
        child.stdout.destroy();
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
      });
    }

    it('a required-integration failure (exit 1) is not corrupted into exit 0 by a closed stdout', async (ctx) => {
      // Windows pipe/EPIPE semantics are not verified here — see
      // docs/command-contract.md.
      skipUnless(
        ctx,
        process.platform !== 'win32',
        'EPIPE semantics on Windows pipes are unverified here',
      );
      await writeDeclaration([
        { id: 'memory-custom-executable', required: true },
        ...Array.from({ length: 1500 }, (_, i) => ({
          id: `rejected-${String(i).padStart(5, '0')}`,
        })),
      ]);
      const { code, stderr } = await spawnWithEarlyStdoutClose(['setup', 'verify', '--json'], repo);
      expect(code).toBe(1);
      expect(stderr).not.toContain('EPIPE');
      expect(stderr).not.toContain('    at ');
    }, 15_000);

    it('a successful verify (exit 0) also survives a closed stdout', async (ctx) => {
      skipUnless(
        ctx,
        process.platform !== 'win32',
        'EPIPE semantics on Windows pipes are unverified here',
      );
      await writeDeclaration(
        Array.from({ length: 1500 }, (_, i) => ({ id: `rejected-${String(i).padStart(5, '0')}` })),
      );
      const { code, stderr } = await spawnWithEarlyStdoutClose(['setup', 'verify', '--json'], repo);
      expect(code).toBe(0);
      expect(stderr).not.toContain('EPIPE');
      expect(stderr).not.toContain('    at ');
    }, 15_000);
  });
});
