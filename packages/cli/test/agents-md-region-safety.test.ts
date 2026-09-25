import { access, chmod, link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject, projectNameFor } from '../src/commands/init.js';
import { applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import { applyUninstall, planUninstall } from '../src/commands/uninstall.js';
import { agentOsUniversalDir } from '../src/templates.js';
import { hardLinksAvailable, modeBitsExist, skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { composeRegion, sha256 } from '../../../test/helpers/agents-md-region.js';

/**
 * RP-256 slice 2 — findings that needed the real command pipeline rather
 * than a single call:
 *
 * - round 2 item 4 (code-reviewer B4 checked-and-sound half): a UTF-8 BOM
 *   plus CRLF file is valid UTF-8 (the BOM is three legitimate UTF-8 bytes
 *   for U+FEFF), so the strict UTF-8 decode `init`, `upgrade` and
 *   `uninstall` all use (`decodeStrictUtf8`) never rejects it — this is the
 *   end-to-end regression guard for that case (also closing round-1
 *   advisory A2's "no test drives the real init→upgrade→uninstall region
 *   round trip" gap).
 * - round 2 item 5 (security-scanner A1): the region write goes through
 *   `atomicWriteInRepo` (`packages/cli/src/lib/atomic-write.ts`, modelled on
 *   `commands/integrations.ts`'s own `atomicWrite`, lines 173-192) — a temp
 *   file in the same directory plus `rename` over the target. `rename`
 *   replaces the directory ENTRY at the destination with a new inode, which
 *   is why it never touches whatever a hard link's OTHER name still points
 *   at. These tests probe that the outside target of a hard link is
 *   byte-for-byte unchanged after `init`, `upgrade` and `uninstall`.
 * - round 3 item 3: `atomicWriteInRepo` passes the caller's mode straight to
 *   `open(temporary, 'wx', mode)`, which the process umask still filters —
 *   so the mode-preservation claim the docs make does not hold under an
 *   ordinary umask. These tests probe that directly.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-agents-region-safety-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');
const agentsMdPath = (): string => path.join(repo, 'AGENTS.md');

async function renderBody(projectName: string): Promise<string> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'AGENTS.md'), 'utf8');
  return raw.replaceAll('__PROJECT_NAME__', projectName);
}

describe('a UTF-8 BOM plus CRLF AGENTS.md round-trips exactly through init, upgrade and uninstall (round 2, item 4)', () => {
  it('round-trips the BOM and CRLF bytes exactly, with no corruption at any step', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const prefixText = '# host rules\r\nCRLF throughout, no trailing newline';
    const originalBytes = Buffer.concat([bom, Buffer.from(prefixText, 'utf8')]);
    await writeFile(agentsMdPath(), originalBytes);

    await initProject(repo, {});

    const body = await renderBody(projectNameFor(repo));
    const decodedPrefix = originalBytes.toString('utf8');
    const afterInit = await readFile(agentsMdPath());
    expect(afterInit.toString('utf8')).toBe(composeRegion(decodedPrefix, body));

    // No payload change since the region was just installed by this same
    // release — the upgrade is a no-op, and this is exactly the path that
    // must not disturb the BOM/CRLF bytes either.
    const plan = await planUpgrade(repo);
    await applyUpgrade(repo, plan);
    const afterUpgrade = await readFile(agentsMdPath());
    expect(afterUpgrade.equals(afterInit)).toBe(true);

    const uplan = await planUninstall(repo);
    await applyUninstall(repo, uplan);
    const afterUninstall = await readFile(agentsMdPath());
    expect(afterUninstall.equals(originalBytes)).toBe(true);
  });
});

describe('atomic write — a hard-linked AGENTS.md is never written through to its outside target (round 2, security A1)', () => {
  const USER_PREFIX = '# shared content, hard-linked\nkeep me\n';
  const OLD_BODY = '# OLD RULEBOOK BODY — a fake stand-in for a previous release\n';

  it('init does not write through the hard link', async (context) => {
    skipUnless(context, hardLinksAvailable().ok, hardLinksAvailable().reason);

    const outsideDir = await mkdtemp(path.join(tmpdir(), 'caf-hardlink-outside-'));
    try {
      const outsideTarget = path.join(outsideDir, 'shared.md');
      await writeFile(outsideTarget, USER_PREFIX);
      await link(outsideTarget, agentsMdPath());

      await initProject(repo, {});

      const outsideAfter = await readFile(outsideTarget, 'utf8');
      expect(outsideAfter).toBe(USER_PREFIX);
    } finally {
      await removeFixture(outsideDir);
    }
  });

  /**
   * A real `init` install first, so the manifest's `regions` entry vouches
   * for a body upgrade can genuinely refresh — then AGENTS.md is REPLACED
   * with a hard link to an outside file holding the EXACT SAME bytes (the
   * region hash still matches, so `planUpgrade` decides `update`, and the
   * write this test cares about actually happens instead of being skipped
   * as a conflict).
   */
  async function installThenHardLinkToOutside(outsideDir: string): Promise<string> {
    await initProject(repo, {});
    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    delete raw.files['AGENTS.md'];
    raw.regions = { 'AGENTS.md': sha256(OLD_BODY) };
    await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);

    const outsideTarget = path.join(outsideDir, 'shared-agents.md');
    await writeFile(outsideTarget, composeRegion(USER_PREFIX, OLD_BODY));
    await rm(agentsMdPath(), { force: true });
    await link(outsideTarget, agentsMdPath());
    return outsideTarget;
  }

  it('upgrade does not write through the hard link', async (context) => {
    skipUnless(context, hardLinksAvailable().ok, hardLinksAvailable().reason);

    const outsideDir = await mkdtemp(path.join(tmpdir(), 'caf-hardlink-outside-'));
    try {
      const outsideTarget = await installThenHardLinkToOutside(outsideDir);
      const outsideBefore = await readFile(outsideTarget);

      const plan = await planUpgrade(repo);
      await applyUpgrade(repo, plan);

      const outsideAfter = await readFile(outsideTarget);
      expect(outsideAfter.equals(outsideBefore)).toBe(true);
    } finally {
      await removeFixture(outsideDir);
    }
  });

  it('uninstall does not write through the hard link', async (context) => {
    skipUnless(context, hardLinksAvailable().ok, hardLinksAvailable().reason);

    const outsideDir = await mkdtemp(path.join(tmpdir(), 'caf-hardlink-outside-'));
    try {
      const outsideTarget = await installThenHardLinkToOutside(outsideDir);
      const outsideBefore = await readFile(outsideTarget);

      const plan = await planUninstall(repo);
      await applyUninstall(repo, plan);

      const outsideAfter = await readFile(outsideTarget);
      expect(outsideAfter.equals(outsideBefore)).toBe(true);
    } finally {
      await removeFixture(outsideDir);
    }
  });
});

/**
 * RP-256 slice 2, round 3, blocker 1 — a region-tracked AGENTS.md the user
 * deleted, then `init` re-run: `init.ts`'s marker-check block only runs
 * `if (await exists(dest))`, so a DELETED path skips it entirely and falls
 * into the ordinary write loop, which writes the whole rendered rulebook
 * (there is no `existingAgentsBytes` to splice into). `recordInstall`'s
 * `regionTrackedPaths` set still carries the STALE `previous.regions` entry
 * forward, though, and — because that set is checked before a written path
 * is recorded — the fresh whole-file write is never recorded in `files`
 * either. The manifest ends up with `regions` pointing at a body that no
 * longer exists anywhere, and no bucket at all for the bytes actually on
 * disk.
 *
 * Pinned behaviour (the coordinator's ruling): this is exactly a clean-repo
 * AGENTS.md install — `files` gets the whole-file hash, `regions` loses the
 * stale entry, and the path is never recorded in both at once.
 */
describe('initProject — a region-tracked AGENTS.md deleted by the user, then re-init (round 3, blocker 1)', () => {
  const USER_PREFIX = '# mine\n';

  async function deletedRegionThenReinit(): Promise<void> {
    await writeFile(agentsMdPath(), USER_PREFIX);
    await initProject(repo, {});
    await rm(agentsMdPath());
    await initProject(repo, {});
  }

  it('is treated like a clean repo: the whole rulebook is written, recorded under files, and the stale regions entry is removed — never both', async () => {
    await deletedRegionThenReinit();

    const body = await renderBody(projectNameFor(repo));
    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(body);

    const raw = JSON.parse(await readFile(manifestPath(), 'utf8')) as {
      files?: Record<string, string>;
      regions?: Record<string, string>;
    };
    expect(raw.files?.['AGENTS.md']).toBe(sha256(body));
    expect(raw.regions?.['AGENTS.md']).toBeUndefined();
    expect(raw.files?.['AGENTS.md'] !== undefined && raw.regions?.['AGENTS.md'] !== undefined).toBe(
      false,
    );
  });

  it('upgrade on the same state does not report a conflict', async () => {
    await deletedRegionThenReinit();

    const plan = await planUpgrade(repo);
    const action = plan.actions.find((a) => a.rel === 'AGENTS.md');
    expect(action?.verdict).not.toBe('conflict');
  });

  it('uninstall removes AGENTS.md as a rig file, never says it "stays as yours", removes the manifest, and reports outcome uninstalled', async () => {
    await deletedRegionThenReinit();

    const plan = await planUninstall(repo);
    const action = plan.actions.find((a) => a.rel === 'AGENTS.md');
    expect(action?.verdict).toBe('remove');
    expect(action?.reason ?? '').not.toMatch(/stays as yours/);

    const result = await applyUninstall(repo, plan);

    await expect(access(agentsMdPath())).rejects.toThrow();
    await expect(access(manifestPath())).rejects.toThrow();
    expect(result.outcome).toBe('uninstalled');
  });
});

/**
 * RP-256 slice 2, round 3, blocker 3 — `atomicWriteInRepo` passes the
 * caller's requested mode straight to `open(temporary, 'wx', mode)`. Node's
 * `open` mirrors POSIX `open(2)`: the requested mode is ANDed with
 * `~umask`, so under an ordinary `umask 022` a `664` source file becomes
 * `644` — the group-write bit silently dropped — contradicting the
 * documented claim that "an atomic rewrite never silently changes a user's
 * own file's permissions" (`atomic-write.ts:28-33`, `docs/command-
 * contract.md:993`, `CHANGELOG.md:60`).
 *
 * The umask is set with `process.umask(0o022)` and restored in `finally` —
 * never relying on whatever the host's own umask happens to be, and never
 * leaking a changed umask into any other test in the process.
 */
describe('mode preserved exactly through init, upgrade and uninstall (round 3, blocker 3)', () => {
  const USER_PREFIX_MODE_TEST = '# mine\nkeep me\n';
  const OLD_BODY = '# OLD RULEBOOK BODY — a fake stand-in for a previous release\n';

  async function currentMode(): Promise<number> {
    return (await stat(agentsMdPath())).mode & 0o777;
  }

  /** Forces the region's `update` verdict, so `upgrade` actually writes. */
  async function makeUpgradeableStale(userPrefix: string): Promise<void> {
    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    raw.regions = { 'AGENTS.md': sha256(OLD_BODY) };
    await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
    await writeFile(agentsMdPath(), composeRegion(userPrefix, OLD_BODY));
  }

  for (const mode of [0o664, 0o600]) {
    it(`preserves mode ${mode.toString(8)} exactly under umask 0o022, through init, upgrade and uninstall`, async (context) => {
      skipUnless(context, modeBitsExist().ok, modeBitsExist().reason);

      const originalUmask = process.umask(0o022);
      try {
        await writeFile(agentsMdPath(), USER_PREFIX_MODE_TEST);
        await chmod(agentsMdPath(), mode);

        await initProject(repo, {});
        expect(await currentMode()).toBe(mode);

        await makeUpgradeableStale(USER_PREFIX_MODE_TEST);
        await chmod(agentsMdPath(), mode); // re-assert the starting mode for this phase
        const plan = await planUpgrade(repo);
        const action = plan.actions.find((a) => a.rel === 'AGENTS.md');
        expect(action?.verdict, 'fixture: expected an update to actually exercise the write').toBe(
          'update',
        );
        await applyUpgrade(repo, plan);
        expect(await currentMode()).toBe(mode);

        await chmod(agentsMdPath(), mode); // re-assert once more before the strip
        const uplan = await planUninstall(repo);
        await applyUninstall(repo, uplan);
        expect(await currentMode()).toBe(mode);
      } finally {
        process.umask(originalUmask);
      }
    });
  }
});
