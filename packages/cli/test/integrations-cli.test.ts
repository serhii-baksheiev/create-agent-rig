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
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addIntegration,
  listRegistry,
  runIntegrationsCommand,
  verifyIntegrations,
} from '../src/commands/integrations.js';
import { DECLARATION_REL } from '../src/integrations/declaration.js';
import { RECEIPTS_DIR_REL } from '../src/integrations/receipt.js';
import { REGISTRY, type ProviderDescriptor } from '../src/integrations/registry.js';
import type { ObservedNow } from '../src/integrations/state.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

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

const missingProbe = async (): Promise<ObservedNow> => ({ present: false, kind: 'missing' });

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-cli-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

async function writeDeclaration(entries: readonly Record<string, unknown>[]): Promise<void> {
  const rel = DECLARATION_REL.split('/');
  await mkdir(path.join(repo, ...rel.slice(0, -1)), { recursive: true });
  await writeFile(
    path.join(repo, ...rel),
    `${JSON.stringify({ schemaVersion: 1, integrations: entries }, null, 2)}\n`,
  );
}

describe('setup list (RP-22 S4)', () => {
  it('lists every REGISTRY descriptor with id, capability, mode, license, source, stability and per-harness routes', () => {
    const entries = listRegistry();
    expect(entries).toHaveLength(REGISTRY.length);
    const memory = entries.find((e) => e.id === 'memory-custom-executable');
    expect(memory).toBeDefined();
    expect(memory).toMatchObject({
      capability: 'memory',
      mode: 'external-executable',
      stability: 'supported',
    });
    expect(memory?.harnesses['claude-code']).toEqual({
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

  it('is idempotent: a second identical add leaves the bytes unchanged', async () => {
    const options = {
      repoDir: repo,
      id: 'memory-custom-executable',
      required: true,
      version: '1.2.3',
    };
    const first = await addIntegration(options);
    expect(first.outcome).toBe('written');
    const firstHash = createHash('sha256').update(
      await readFile(path.join(repo, ...DECLARATION_REL.split('/'))),
    );
    const second = await addIntegration(options);
    expect(second.outcome).toBe('written');
    const secondHash = createHash('sha256').update(
      await readFile(path.join(repo, ...DECLARATION_REL.split('/'))),
    );
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

  it('refuses to write through a pre-existing symlink at the declaration path', async () => {
    await mkdir(path.join(repo, '.rig'), { recursive: true });
    const target = await mkdtemp(path.join(tmpdir(), 'caf-integrations-outside-'));
    try {
      await symlink(target, path.join(repo, '.rig', 'integrations.json'));
      const outcome = await addIntegration({ repoDir: repo, id: 'memory-custom-executable' });
      expect(outcome.outcome).toBe('refused');
    } finally {
      await removeFixture(target);
    }
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
    });
  });

  it('exits 1 when the declaration itself does not parse', async () => {
    await mkdir(path.join(repo, '.rig'), { recursive: true });
    await writeFile(path.join(repo, ...DECLARATION_REL.split('/')), '{not json');
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
      path.join(repo, ...RECEIPTS_DIR_REL.split('/'), 'orphan-provider.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'orphan-provider',
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
            notObserved: ['everything'],
          },
        },
      })}\n`,
    );
    const { payload } = await verifyIntegrations({ repoDir: repo });
    expect(payload.orphaned).toEqual(['orphan-provider']);
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

describe('setup: CLI wiring, spawning the actually-built binary (RP-22 S4)', () => {
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

  it('setup list --json round-trips through the real binary', async () => {
    const run = await runCli(repo, ['setup', 'list', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const parsed = JSON.parse(run.stdout) as { integrations: unknown[] };
    expect(run.stdout).toBe(`${JSON.stringify(parsed)}\n`);
    expect(parsed.integrations.length).toBeGreaterThan(0);
  });

  it('setup with no arguments still answers the legacy usage error', async () => {
    const run = await runCli(repo, ['setup']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/memory-root/);
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

  it('setup verify --json answers with the absent declaration when this repo has none', async () => {
    const run = await runCli(repo, ['setup', 'verify', '--json']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        command: 'setup',
        verb: 'verify',
        declaration: 'absent',
        integrations: [],
        rejected: [],
        orphaned: [],
      })}\n`,
    );
  });
});
