import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { composeRegion, sha256 } from '../../../test/helpers/agents-md-region.js';

/**
 * RP-289 — `system-error.test.ts` pins `wrapSystemError`'s own contract by
 * calling it directly; this file is the complementary end-to-end proof that
 * `initProject`'s and `applyUpgrade`'s real region-write call sites actually
 * route through it, rather than wrapping unconditionally. `atomicWriteInRepo`
 * (`lib/atomic-write.js`) is replaced with a stub that throws whatever the
 * test sets, so a genuine `TypeError` — a stand-in for a programming error
 * inside the write, never a Node system error — reaches `initProject`/
 * `applyUpgrade` through the SAME call sites the sibling `agents-md-region-
 * hardening.test.ts` file's AD1 and RP-289 `cause` cases already exercise
 * with a real EACCES, proving the discrimination is live at the call site
 * and not provable only inside the helper.
 *
 * The mock is scoped to this file alone — `vi.mock` replaces a module per
 * test file, not process-wide (precedent: `create-order.test.ts:9`) — so it
 * never leaks into the sibling hardening tests, which need the real
 * `atomicWriteInRepo` to exercise an actual EACCES.
 */

const write = vi.hoisted(() => ({ next: undefined as unknown }));

vi.mock('../src/lib/atomic-write.js', () => ({
  atomicWriteInRepo: async (): Promise<never> => {
    throw write.next;
  },
}));

const { InitError, initProject } = await import('../src/commands/init.js');
const { applyUpgrade, planUpgrade, UpgradeError } = await import('../src/commands/upgrade.js');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-system-error-call-sites-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');
const agentsMdPath = (): string => path.join(repo, 'AGENTS.md');

/**
 * Same fixture shape AD1 uses in `agents-md-region-hardening.test.ts`: a
 * clean install first — this never reaches the mocked `atomicWriteInRepo`,
 * since no AGENTS.md exists yet and this run's own AGENTS.md write is the
 * ordinary, unmocked `writeFile` path — then a genuinely foreign AGENTS.md
 * is dropped in, so the NEXT `initProject` call takes the region-append
 * branch, which does call `atomicWriteInRepo`.
 */
async function foreignAgentsMdReadyForRegionAppend(): Promise<void> {
  await initProject(repo, {});
  const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
  delete raw.files['AGENTS.md'];
  await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(agentsMdPath(), '# host notes\nkeep me\n');
}

/**
 * Same fixture shape `agents-md-region-upgrade.test.ts` and AD1's own
 * `installThenSimulateRegion` build: a region-tracked AGENTS.md whose body
 * differs from what this release renders, so `planUpgrade` reports `update`
 * and `applyUpgrade` actually calls `atomicWriteInRepo`.
 */
async function regionTrackedAgentsMdReadyForUpdate(): Promise<void> {
  const USER_PREFIX = '# Team notes\nKeep this section exactly as it is.\n';
  const OLD_BODY = '# OLD RULEBOOK BODY — a fake stand-in for a previous release\n';
  await initProject(repo, {});
  const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
  delete raw.files['AGENTS.md'];
  raw.regions = { 'AGENTS.md': sha256(OLD_BODY) };
  await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(agentsMdPath(), composeRegion(USER_PREFIX, OLD_BODY));
}

describe('initProject — what atomicWriteInRepo throws during the region write reaches the caller as wrapSystemError decides', () => {
  it('a TypeError from the write is the very same instance, never an InitError', async () => {
    await foreignAgentsMdReadyForRegionAppend();
    const boom = new TypeError('boom — a stand-in for a programming error inside the write');
    write.next = boom;

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(InitError);
  });

  it('a coded Error (EACCES) from the write is wrapped as InitError, carrying the original as cause', async () => {
    await foreignAgentsMdReadyForRegionAppend();
    const boom = Object.assign(new Error("EACCES: permission denied, open 'AGENTS.md'"), {
      code: 'EACCES',
    });
    write.next = boom;

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    expect((caught as Error & { cause?: unknown }).cause).toBe(boom);
  });
});

describe('applyUpgrade — what atomicWriteInRepo throws during the region write reaches the caller as wrapSystemError decides', () => {
  it('a TypeError from the write is the very same instance, never an UpgradeError', async () => {
    await regionTrackedAgentsMdReadyForUpdate();
    const plan = await planUpgrade(repo);
    const boom = new TypeError('boom — a stand-in for a programming error inside the write');
    write.next = boom;

    let caught: unknown;
    try {
      await applyUpgrade(repo, plan);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(UpgradeError);
  });

  it('a coded Error (EACCES) from the write is wrapped as UpgradeError, carrying the original as cause', async () => {
    await regionTrackedAgentsMdReadyForUpdate();
    const plan = await planUpgrade(repo);
    const boom = Object.assign(new Error("EACCES: permission denied, open 'AGENTS.md'"), {
      code: 'EACCES',
    });
    write.next = boom;

    let caught: unknown;
    try {
      await applyUpgrade(repo, plan);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UpgradeError);
    expect((caught as Error & { cause?: unknown }).cause).toBe(boom);
  });
});
