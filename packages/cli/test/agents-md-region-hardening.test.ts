import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InitError, initProject } from '../src/commands/init.js';
import type { InitOptions } from '../src/commands/init.js';
import { applyUpgrade, planUpgrade, UpgradeError } from '../src/commands/upgrade.js';
import { modeBitsDeny, skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { composeRegion, sha256 } from '../../../test/helpers/agents-md-region.js';

/**
 * RP-268 — hardening the AGENTS.md managed-region writes:
 *  - AD1: an EACCES from the region write's own temp-file open must surface
 *    as the command's typed error (InitError / UpgradeError), never a raw
 *    Node fs stack (`packages/cli/src/index.ts`'s top-level handler only
 *    formats typed errors — see its `.catch` block).
 *  - AD2: `init` composes the region write from bytes read at plan time and
 *    never re-reads before writing — unlike `upgrade`, which already
 *    re-verifies at apply time (`agents-md-region-upgrade.test.ts`, "AGENTS.md
 *    region re-verified at apply time").
 *  - A1: the kept-deletion loop in `recordInstall` iterates `ordinaryWritten`,
 *    which excludes every region-tracked path — so a region-appended
 *    AGENTS.md never clears a stale `kept['AGENTS.md']` entry a hand-edited
 *    manifest left behind.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-agents-region-hardening-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');
const agentsMdPath = (): string => path.join(repo, 'AGENTS.md');

/** Same fixture shape `agents-md-region-upgrade.test.ts` builds by hand. */
async function installThenSimulateRegion(userPrefix: string, body: string): Promise<void> {
  await initProject(repo, {});
  const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
  delete raw.files['AGENTS.md'];
  raw.regions = { 'AGENTS.md': sha256(body) };
  await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(agentsMdPath(), composeRegion(userPrefix, body));
}

describe("AD1 — an EACCES writing the AGENTS.md region is reported as the command's typed error, not a raw Node stack", () => {
  it('initProject: wraps a permission-denied temp-file create as InitError naming AGENTS.md', async (context) => {
    skipUnless(context, modeBitsDeny().ok, modeBitsDeny().reason);

    // A clean install first, so every OTHER file already exists on disk and
    // a second run performs no writes for them at all (the generic write
    // loop's `if (await exists(dest)) return { verdict: 'skipped' }` short-
    // circuits before ever calling `mkdir`/`writeFile`) — isolating the
    // temp-file create this test denies to the AGENTS.md region write alone.
    await initProject(repo, {});
    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    delete raw.files['AGENTS.md'];
    await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
    const foreignPrefix = '# host notes\nkeep me\n';
    await writeFile(agentsMdPath(), foreignPrefix);

    // Deny write in the repo root: `atomicWriteInRepo`'s temp file is
    // created directly inside it (AGENTS.md sits at the repo root), so its
    // `open(temporary, 'wx', mode)` call is the first write this second run
    // attempts, and the one this test denies.
    await chmod(repo, 0o500);
    try {
      let caught: unknown;
      try {
        await initProject(repo, {});
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InitError);
      expect((caught as Error).message).toMatch(/AGENTS\.md/);
    } finally {
      await chmod(repo, 0o700);
    }
  });

  it('applyUpgrade: wraps a permission-denied temp-file create as UpgradeError naming AGENTS.md', async (context) => {
    skipUnless(context, modeBitsDeny().ok, modeBitsDeny().reason);

    const USER_PREFIX = '# Team notes\nKeep this section exactly as it is.\n';
    const OLD_BODY = '# OLD RULEBOOK BODY — a fake stand-in for a previous release\n';
    await installThenSimulateRegion(USER_PREFIX, OLD_BODY);
    // Only AGENTS.md's region differs from what is on disk (every other
    // file is untouched since `initProject` installed it a moment ago), so
    // `applyUpgrade`'s write loop performs no other write this run either.
    const plan = await planUpgrade(repo);

    await chmod(repo, 0o500);
    try {
      let caught: unknown;
      try {
        await applyUpgrade(repo, plan);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UpgradeError);
      expect((caught as Error).message).toMatch(/AGENTS\.md/);
    } finally {
      await chmod(repo, 0o700);
    }
  });
});

/**
 * AD2 — `initProject` reads AGENTS.md once, at "plan time" (early in the
 * function, well before the write), and composes the region write from
 * those same bytes. Before RP-268 nothing re-read the file immediately
 * before the write the way `applyUpgrade` does (`upgrade.ts`'s own
 * re-verification, pinned in `agents-md-region-upgrade.test.ts`'s "AGENTS.md
 * region re-verified at apply time" describe block) — so an edit landing in
 * that window was silently overwritten.
 *
 * **The seam this test drives** (RP-268 added it for exactly this window):
 * an `InitOptions` field,
 *
 *   onAgentsRegionWritePending?: () => Promise<void> | void
 *
 * invoked once `initProject` has decided this run will append a region (the
 * "genuinely foreign, no markers" branch has been taken) and is about to
 * read the file a second time to re-verify nothing changed since the first,
 * plan-time read — immediately before that second read, so a test can land
 * an edit in exactly the window the re-verification exists to catch. Real
 * runs never pass it.
 */
describe('AD2 — initProject re-verifies AGENTS.md immediately before the region write', () => {
  it('refuses with InitError when the file is edited between the plan-time read and the write, and never overwrites the edit', async () => {
    const originalPrefix = '# Team notes\nKeep this section exactly as it is.\n';
    await writeFile(agentsMdPath(), originalPrefix);

    const editedPrefix = `${originalPrefix}EDITED BETWEEN THE PLAN-TIME READ AND THE WRITE\n`;
    const hookOptions: InitOptions & { onAgentsRegionWritePending?: () => Promise<void> } = {
      onAgentsRegionWritePending: async () => {
        await writeFile(agentsMdPath(), editedPrefix);
      },
    };

    let caught: unknown;
    try {
      await initProject(repo, hookOptions);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    // The refusal must not advise re-running `init`: with the rig files
    // already on disk and no manifest, a re-run records them as the user's
    // own (`kept`) — code-reviewer round 2, measured.
    expect((caught as Error).message).not.toMatch(/init again/);
    const onDisk = await readFile(agentsMdPath(), 'utf8');
    // The edit must survive — never silently overwritten by a write composed
    // from the stale, plan-time bytes.
    expect(onDisk).toBe(editedPrefix);
    // No manifest is written on a refusal — `recordInstall` runs strictly
    // after the region write in `initProject`, and a refusal must not vouch
    // for content it never actually wrote.
    await expect(access(manifestPath())).rejects.toThrow();
    // What the refusal leaves behind, pinned because the contract states it:
    // the rig files this run already installed before the region write stay
    // on disk — the same shape as the symlink and unwritable-root refusals.
    await expect(access(path.join(repo, 'CLAUDE.md'))).resolves.toBeUndefined();
  });
});

/**
 * A1 — `recordInstall`'s kept-deletion loop
 * (`for (const rel of ordinaryWritten) delete kept[rel];`) iterates
 * `ordinaryWritten`, which explicitly excludes every region-tracked path
 * (`regionTrackedPaths`). A region-appended AGENTS.md is therefore never
 * cleared from `kept` — reachable only when a hand-edited manifest already
 * carries a stale `kept['AGENTS.md']` entry alongside neither a `files` nor
 * a `regions` entry for it (the only shape a genuinely foreign AGENTS.md
 * take the region-append path from).
 */
describe('A1 — the kept-deletion loop clears a stale kept["AGENTS.md"] on a region append', () => {
  it('clears kept["AGENTS.md"] the first time this run appends a fresh region', async () => {
    // A valid manifest shape via an ordinary clean install, then hand-edited
    // into the one shape only a hand-edited manifest can reach: AGENTS.md
    // tracked under `kept`, not `files` or `regions` at all.
    await initProject(repo, {});
    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    delete raw.files['AGENTS.md'];
    raw.kept = { ...(raw.kept ?? {}), 'AGENTS.md': 'deadbeef'.repeat(8) };
    await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
    // A genuinely foreign file — no markers yet — so this run takes the
    // region-append path for the first time.
    const foreignPrefix = '# Host team notes\nkeep me\n';
    await writeFile(agentsMdPath(), foreignPrefix);

    await initProject(repo, {});

    const after = JSON.parse(await readFile(manifestPath(), 'utf8')) as {
      regions?: Record<string, string>;
      kept?: Record<string, string>;
    };
    expect(after.regions?.['AGENTS.md']).toBeDefined();
    expect(after.kept?.['AGENTS.md']).toBeUndefined();
  });
});
