import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject, projectNameFor } from '../src/commands/init.js';
import { applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import { applyUninstall, planUninstall } from '../src/commands/uninstall.js';
import { agentOsUniversalDir } from '../src/templates.js';
import { hardLinksAvailable, skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { composeRegion, sha256 } from '../../../test/helpers/agents-md-region.js';

/**
 * RP-256 slice 2, round 2 — two findings that needed the real command
 * pipeline rather than a single call:
 *
 * - item 4 (code-reviewer B4 checked-and-sound half): a UTF-8 BOM plus CRLF
 *   file is valid UTF-8 (the BOM is three legitimate UTF-8 bytes for
 *   U+FEFF), so the lossy `toString('utf8')` round trip that corrupts
 *   Latin-1 and UTF-16LE input never touches it — this is the end-to-end
 *   regression guard for that case (also closing round-1 advisory A2's "no
 *   test drives the real init→upgrade→uninstall region round trip" gap).
 * - item 5 (security-scanner A1): the region write is `writeFile` straight
 *   onto the user's `AGENTS.md`, which follows a hard link exactly like any
 *   other write through a path does. `commands/integrations.ts`'s
 *   `atomicWrite` (lines 173-192) avoids this with a temp file in the same
 *   directory plus `rename` over the target — `rename` replaces the
 *   directory ENTRY at the destination with a new inode, which is why it
 *   never touches whatever the link's OTHER name still points at. These
 *   tests probe that the outside target of a hard link is byte-for-byte
 *   unchanged after `init`, `upgrade` and `uninstall`.
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
