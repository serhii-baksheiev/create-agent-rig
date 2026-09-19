import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { UninstallError, applyUninstall, planUninstall } from '../src/commands/uninstall.js';
import type { UninstallAction, UninstallPlan } from '../src/commands/uninstall.js';
import { hookFilesReferencedIn } from '../src/lib/init-settings.js';
import { MANIFEST_REL, readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { onlyOnWindows, skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

let repo: string;

const WORKFLOW = '.claude/rules/workflow.md';
const SETTINGS = '.claude/settings.json';
const CODEX_HOOKS = '.codex/hooks.json';

const abs = (rel: string): string => path.join(repo, ...rel.split('/'));
const read = (rel: string): Promise<string> => readFile(abs(rel), 'utf8');
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), content);
};
const exists = async (rel: string): Promise<boolean> => {
  try {
    await readFile(abs(rel));
    return true;
  } catch {
    return false;
  }
};

const actionFor = (plan: UninstallPlan, rel: string): UninstallAction | undefined =>
  plan.actions.find((a) => a.rel === rel);

/** The rig as `init` leaves it: files installed, manifest written. */
async function installRig(): Promise<void> {
  await initProject(repo, {});
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

describe('planUninstall — nothing to act on', () => {
  it('reports no manifest when there is no rig here at all', async () => {
    const plan = await planUninstall(repo);
    expect(plan.noManifest).toBe(true);
    expect(plan.actions).toEqual([]);
  });

  it('refuses rather than guesses when the manifest cannot be parsed', async () => {
    await write(MANIFEST_REL, 'not json at all {{{');
    await expect(planUninstall(repo)).rejects.toThrow(UninstallError);
    // nothing removed
    expect(await exists(MANIFEST_REL)).toBe(true);
  });
});

describe('planUninstall — per-file verdicts', () => {
  it('marks an untouched installed file for removal', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    expect(actionFor(plan, WORKFLOW)?.verdict).toBe('remove');
  });

  it('marks a file the rig installed and the user already deleted as absent', async () => {
    await installRig();
    await rm(abs(WORKFLOW));
    const plan = await planUninstall(repo);
    expect(actionFor(plan, WORKFLOW)?.verdict).toBe('absent');
  });

  it('preserves a file the user edited, and says why', async () => {
    await installRig();
    await write(WORKFLOW, `${await read(WORKFLOW)}\n<!-- mine -->\n`);
    const plan = await planUninstall(repo);
    const action = actionFor(plan, WORKFLOW);
    expect(action?.verdict).toBe('preserved');
    expect(action?.reason).toBe('modified');
  });

  it('preserves a file that only differs by line endings, with a distinct reason', async () => {
    await installRig();
    const original = await read(WORKFLOW);
    await write(WORKFLOW, original.replace(/\n/g, '\r\n'));
    const plan = await planUninstall(repo);
    const action = actionFor(plan, WORKFLOW);
    expect(action?.verdict).toBe('preserved');
    expect(action?.reason).toBe('line-endings-only');
  });

  it('never treats a CRLF conversion as pristine — it does not get removed', async () => {
    await installRig();
    const original = await read(WORKFLOW);
    await write(WORKFLOW, original.replace(/\n/g, '\r\n'));
    const plan = await planUninstall(repo);
    expect(actionFor(plan, WORKFLOW)?.verdict).not.toBe('remove');
  });

  it('preserves a path recorded under kept, as user-owned', async () => {
    await write(SETTINGS, '{"hooks":{}}'); // pre-existing, so init leaves it and kept-records it
    await installRig();
    const manifest = await readManifest(repo);
    expect(manifest?.kept?.[SETTINGS]).toBeTruthy();

    const plan = await planUninstall(repo);
    const action = actionFor(plan, SETTINGS);
    expect(action?.verdict).toBe('preserved');
    expect(action?.reason).toBe('user-owned (kept by init)');
  });

  it('refuses a manifest naming a path outside the repository', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    manifest.files['../evil'] = sha256('x');
    await writeManifest(repo, manifest);

    await expect(planUninstall(repo)).rejects.toThrow(UninstallError);
  });

  // Ownership hashes cover exact bytes (ADR-RP-003 / RP-177): the manifest
  // comparison reads the file as bytes and hashes those bytes, never a
  // UTF-8-decoded string. A file that is not valid UTF-8 at all is the sharpest
  // test of that — decoding it loses information a hash must not lose.
  it('matches a binary (non-UTF-8) file by its exact raw bytes, never a decoded string', async () => {
    await installRig();
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x0a, 0x0d, 0x00]);
    await writeFile(abs(WORKFLOW), binary);
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    manifest.files[WORKFLOW] = sha256(binary);
    await writeManifest(repo, manifest);

    const plan = await planUninstall(repo);
    expect(actionFor(plan, WORKFLOW)?.verdict).toBe('remove');

    await applyUninstall(repo, plan);
    await expect(readFile(abs(WORKFLOW))).rejects.toThrow();
  });

  it('never treats a binary file as a line-endings-only match against an unrelated hash', async () => {
    await installRig();
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x0a, 0x0d, 0x00]);
    await writeFile(abs(WORKFLOW), binary);
    // recorded hash is whatever the rig actually wrote (text) — nothing about
    // decoding the binary bytes as UTF-8 and normalising line endings should
    // ever reach that hash.
    const plan = await planUninstall(repo);
    const action = actionFor(plan, WORKFLOW);
    expect(action?.verdict).toBe('preserved');
    expect(action?.reason).toBe('modified');
  });

  it('refuses the whole run when a manifest path names something under .git, even with its true hash', async () => {
    await installRig();
    await mkdir(abs('.git/hooks'), { recursive: true });
    await write('.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    manifest.files['.git/hooks/pre-commit'] = sha256(await readFile(abs('.git/hooks/pre-commit')));
    await writeManifest(repo, manifest);

    await expect(planUninstall(repo)).rejects.toThrow(UninstallError);
    expect(await read('.git/hooks/pre-commit')).toBe('#!/bin/sh\nexit 0\n');
  });

  // "Under .git" is a segment-normalisation rule, not an exact-string one: the
  // filesystem (or git itself) treats each of these as naming the same `.git`
  // a plain lowercase segment would, and a manifest crafted around any of them
  // must be refused exactly as the plain spelling is.
  it.each([
    ['an uppercase segment', '.GIT/hooks/pre-commit'],
    ['a trailing dot Windows strips when resolving the path', '.git./hooks/pre-commit'],
    ['a trailing space Windows strips when resolving the path', '.git /hooks/pre-commit'],
    ['a Windows alternate-data-stream suffix', '.git::$DATA/hooks/pre-commit'],
    ['a nested .git several segments deep', '.claude/worktrees/x/.git/hooks/pre-commit'],
  ] as const)('refuses a manifest path under .git spelled as %s', async (_shape, hostileRel) => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    // The hash does not have to be real for this refusal — it never reaches
    // the point where a hash is checked — but a plausible one keeps the
    // fixture honest about what is actually being refused.
    manifest.files[hostileRel] = sha256('whatever the manifest claims this is');
    await writeManifest(repo, manifest);

    await expect(planUninstall(repo)).rejects.toThrow(UninstallError);
  });

  // A manifest this rig ever wrote never lists the same path in both `files`
  // and `kept` — `planUpgrade` explicitly excludes a `kept` path the moment
  // it becomes one the rig vouches for. A manifest that does is therefore
  // either corrupt or hand-edited, and it must not be allowed to resolve the
  // ambiguity in the reader's favour: the file it names is refused, not
  // silently removed, silently kept, or removed while ALSO being reported as
  // preserved on the same run.
  it('refuses a manifest that lists the same path under both files and kept', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    manifest.kept = { ...(manifest.kept ?? {}), [WORKFLOW]: manifest.files[WORKFLOW]! };
    await writeManifest(repo, manifest);

    await expect(planUninstall(repo)).rejects.toThrow(UninstallError);
    // nothing removed
    await expect(readFile(abs(WORKFLOW))).resolves.toBeTruthy();
  });

  it('preserves a path this release does not install, even with its true hash, and never removes it', async () => {
    await installRig();
    await write('src/app.ts', 'export const x = 1;\n');
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    manifest.files['src/app.ts'] = sha256(await readFile(abs('src/app.ts')));
    await writeManifest(repo, manifest);

    const plan = await planUninstall(repo);
    const action = actionFor(plan, 'src/app.ts');
    expect(action?.verdict).toBe('preserved');
    expect(action?.reason).toMatch(/not a path this release installs/i);

    await applyUninstall(repo, plan);
    expect(await read('src/app.ts')).toBe('export const x = 1;\n');
  });

  // The ownership boundary must be the EXACT set of paths this release
  // installs, not merely their top-level segment — a top-level check lets a
  // hostile manifest pair ANY path under an owned directory (`.rig/`,
  // `.claude/`, `docs/`, `journal/`) with its true on-disk hash and have it
  // removed, even though this release never installs that exact path. Each
  // target below is a real file this repository's own tooling depends on,
  // paired with its own true hash — a naive top-segment check would remove
  // every one of them.
  it.each([
    ['.rig/claims/RP-111.json', '{"id":"RP-111"}'],
    ['.rig/run-state.json', '{"deploy":"REGRESSION"}'],
    ['.claude/queue.state.json', '{"tier":"elevated"}'],
    ['.claude/doctor-exemptions.json', '{}'],
    ['docs/architecture.md', '# not shipped by this release\n'],
    ['journal/2026-09.md', '# journal entry\n'],
    ['.claude/user-secret.txt', 'sk-not-a-real-secret-but-treated-as-user-owned\n'],
  ] as const)(
    'preserves %s even with its true hash — ownership is the exact path, not the top-level directory',
    async (rel, content) => {
      await installRig();
      await write(rel, content);
      const manifest = await readManifest(repo);
      if (manifest === null) throw new Error('fixture: no manifest');
      manifest.files[rel] = sha256(await readFile(abs(rel)));
      await writeManifest(repo, manifest);

      const plan = await planUninstall(repo);
      const action = actionFor(plan, rel);
      expect(action?.verdict).toBe('preserved');
      expect(action?.reason).toMatch(/not a path this release installs/i);

      await applyUninstall(repo, plan);
      expect(await read(rel)).toBe(content);
    },
  );

  it('still removes the paths this release actually installs, exactly as before the ownership fix', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    expect(actionFor(plan, WORKFLOW)?.verdict).toBe('remove');
    expect(actionFor(plan, SETTINGS)?.verdict).toBe('remove');
  });

  // A Windows NTFS alternate-data-stream suffix (`::$DATA`) addresses the
  // same underlying file as the plain name, but is a DIFFERENT string — an
  // exact-path ownership check refuses it on that ground alone, without this
  // command needing to know anything about ADS semantics.
  it("preserves a manifest key spelled with a Windows alternate-data-stream suffix, even with the real file's true hash", async () => {
    await installRig();
    const adsRel = `${WORKFLOW}::$DATA`;
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    manifest.files[adsRel] = sha256(await readFile(abs(WORKFLOW)));
    await writeManifest(repo, manifest);

    const plan = await planUninstall(repo);
    const action = actionFor(plan, adsRel);
    expect(action?.verdict).toBe('preserved');
    expect(action?.reason).toMatch(/not a path this release installs/i);

    // the ADS-suffixed key is simply not one of the exact paths this release
    // owns, so applying the plan never tries to touch it — the run otherwise
    // proceeds normally, including the real WORKFLOW file's own (unrelated)
    // pristine removal
    const result = await applyUninstall(repo, plan);
    expect(result.error).toBeUndefined();
  });
});

describe('planUninstall — wiring files', () => {
  it('removes wiring the rig owns unmodified', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    expect(actionFor(plan, SETTINGS)?.verdict).toBe('remove');
    expect(actionFor(plan, CODEX_HOOKS)?.verdict).toBe('remove');
  });

  it('preserves modified wiring and names the hooks still referenced', async () => {
    await installRig();
    const original = await read(SETTINGS);
    const edited = original.replace('"hooks"', '"myOwnKey": true, "hooks"');
    await write(SETTINGS, edited);

    const plan = await planUninstall(repo);
    const action = actionFor(plan, SETTINGS);
    expect(action?.verdict).toBe('preserved');
    expect(action?.reason).toMatch(/wiring-modified/);
    expect(action?.reason).toMatch(/still referenced/);
  });

  // Deleting a hook file a preserved (edited) wiring file still calls would
  // leave that wiring pointing at nothing — the settings.json the user
  // deliberately kept, silently disarmed, including the secret guard if it
  // happened to be the hook in question.
  it('preserves a hook file still referenced by wiring this run preserved as modified, and names the wiring that holds it', async () => {
    await installRig();
    const original = await read(SETTINGS);
    const edited = original.replace('"hooks"', '"myOwnKey": true, "hooks"');
    await write(SETTINGS, edited);

    const referencedHooks = [...hookFilesReferencedIn(edited)];
    expect(referencedHooks.length).toBeGreaterThan(0);

    const plan = await planUninstall(repo);
    for (const hookRel of referencedHooks) {
      const hookAction = actionFor(plan, hookRel);
      expect(hookAction?.verdict, hookRel).toBe('preserved');
      expect(hookAction?.reason, hookRel).toContain(SETTINGS);
    }

    await applyUninstall(repo, plan);
    for (const hookRel of referencedHooks) {
      expect(await exists(hookRel), hookRel).toBe(true);
    }
  });
});

describe('applyUninstall — the happy path', () => {
  it('removes every remove-verdict path and the manifest last, on a clean rig', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    const result = await applyUninstall(repo, plan);

    expect(result.manifestRemoved).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe('uninstalled');
    for (const action of plan.actions) {
      if (action.verdict !== 'remove') continue;
      expect(result.removed).toContain(action.rel);
      await expect(readFile(abs(action.rel))).rejects.toThrow();
    }
    await expect(readFile(abs(MANIFEST_REL))).rejects.toThrow();
  });

  it('preserves a modified file byte-for-byte, and reports it', async () => {
    await installRig();
    const edited = `${await read(WORKFLOW)}\n<!-- mine -->\n`;
    await write(WORKFLOW, edited);

    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    expect(await read(WORKFLOW)).toBe(edited);
  });

  it('removes directories that became empty, but never removes .rig', async () => {
    await installRig();
    await mkdir(abs('.rig'), { recursive: true });
    await writeFile(abs('.rig/marker.local'), 'evidence');

    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    // the hooks directory should be gone (every file under it was removed)
    await expect(stat(abs('.claude/hooks'))).rejects.toMatchObject({ code: 'ENOENT' });
    // .rig itself is never removed, empty or not, and anything under it is untouched
    expect((await stat(abs('.rig'))).isDirectory()).toBe(true);
    expect(await read('.rig/marker.local')).toBe('evidence');
  });

  it('keeps the manifest when nothing was actually removed — a CRLF checkout leaves everything preserved', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    for (const rel of Object.keys(manifest.files)) {
      const original = await readFile(abs(rel), 'utf8');
      await writeFile(abs(rel), original.replace(/\n/g, '\r\n'));
    }

    const plan = await planUninstall(repo);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.every((a) => a.verdict === 'preserved')).toBe(true);

    const result = await applyUninstall(repo, plan);
    expect(result.removed).toEqual([]);
    expect(result.manifestRemoved).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe('partial');
    // the rig is still fully installed — the evidence naming what it owns
    // stays, or a later upgrade would be blind to every preserved file
    expect(await exists(MANIFEST_REL)).toBe(true);
    expect(await readManifest(repo)).not.toBeNull();
  });

  it('a dry run writes nothing', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    const before = await read(WORKFLOW);
    const result = await applyUninstall(repo, plan, { dryRun: true });

    expect(result.manifestRemoved).toBe(false);
    expect(result.removed).toEqual([]);
    expect(await read(WORKFLOW)).toBe(before);
    expect(await exists(MANIFEST_REL)).toBe(true);
  });

  it('is idempotent: a second uninstall after the first is a clean no-op', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    const second = await planUninstall(repo);
    expect(second.noManifest).toBe(true);
    const result = await applyUninstall(repo, second);
    expect(result.removed).toEqual([]);
    expect(result.manifestRemoved).toBe(false);
  });

  it('leaves no empty .claude directory once every managed file and the manifest are gone', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    // git ignores empty directories, so this has to be checked with fs, not
    // with `git status` — the manifest is the LAST file removed from
    // `.claude`, so its own removal is what can finally empty the directory.
    await expect(stat(abs('.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// Creating a symlink needs a privilege on Windows an ordinary CI account
// lacks, so the fixture itself would fail there for a reason that has nothing
// to do with the code under test. The skip carries that reason into the
// report and is counted in platform-skips.test.ts.
const onlyWhereSymlinksExist = (name: string, body: () => Promise<void>): void =>
  it(name, async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await body();
  });

describe('planUninstall / applyUninstall — a symlink never gets read or removed through', () => {
  onlyWhereSymlinksExist(
    'preserves a file whose ancestor directory is a symlink out of the repository, and never touches the external target',
    async () => {
      await installRig();
      const originalContent = await read(WORKFLOW);

      // An external tree with byte-identical content at the same shape — a
      // naive hash-of-followed-bytes would say "remove" here.
      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        await mkdir(path.join(outside, 'rules'), { recursive: true });
        await writeFile(path.join(outside, 'rules', 'workflow.md'), originalContent);

        // Replace the real `.claude/rules` directory with a symlink to it —
        // WORKFLOW's ancestor, not WORKFLOW itself. `.claude/rules` is flat
        // (a handful of `.md` files, no subdirectories), so each entry is
        // unlinked by name rather than reaching for a recursive removal —
        // fixture-cleanup-audit.test.ts holds every recursive-removal call
        // site in this suite to a written exception, and this one is not it.
        const rulesDir = abs('.claude/rules');
        for (const entry of await readdir(rulesDir)) {
          await rm(path.join(rulesDir, entry));
        }
        await rmdir(rulesDir);
        await symlink(path.join(outside, 'rules'), rulesDir, 'dir');

        const plan = await planUninstall(repo);
        const action = actionFor(plan, WORKFLOW);
        expect(action?.verdict).toBe('preserved');
        expect(action?.reason).toMatch(/symlink/i);

        await applyUninstall(repo, plan);

        expect(await readFile(path.join(outside, 'rules', 'workflow.md'), 'utf8')).toBe(
          originalContent,
        );
        expect((await lstat(abs('.claude/rules'))).isSymbolicLink()).toBe(true);
      } finally {
        await removeFixture(outside);
      }
    },
  );

  onlyWhereSymlinksExist(
    'preserves a managed path that is itself a symlink, and never touches the link or its target',
    async () => {
      await installRig();
      const originalContent = await read(WORKFLOW);

      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        const target = path.join(outside, 'external-workflow.md');
        await writeFile(target, originalContent);

        await rm(abs(WORKFLOW));
        await symlink(target, abs(WORKFLOW));

        const plan = await planUninstall(repo);
        const action = actionFor(plan, WORKFLOW);
        expect(action?.verdict).toBe('preserved');
        expect(action?.reason).toMatch(/symlink/i);

        await applyUninstall(repo, plan);

        expect((await lstat(abs(WORKFLOW))).isSymbolicLink()).toBe(true);
        expect(await readFile(target, 'utf8')).toBe(originalContent);
      } finally {
        await removeFixture(outside);
      }
    },
  );

  onlyWhereSymlinksExist(
    'refuses to remove a path that became a symlink between planning and applying, as a failed run',
    async () => {
      await installRig();
      const plan = await planUninstall(repo);
      expect(actionFor(plan, WORKFLOW)?.verdict).toBe('remove');

      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        const target = path.join(outside, 'external-workflow.md');
        await writeFile(target, 'attacker content');
        await rm(abs(WORKFLOW));
        await symlink(target, abs(WORKFLOW));

        // the stale plan still says "remove" — the guard has to be re-checked
        // at apply time, not trusted from the plan
        const result = await applyUninstall(repo, plan);
        expect(result.manifestRemoved).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.remaining).toContain(WORKFLOW);
        expect(result.completed).not.toContain(WORKFLOW);

        expect((await lstat(abs(WORKFLOW))).isSymbolicLink()).toBe(true);
        expect(await readFile(target, 'utf8')).toBe('attacker content');
      } finally {
        await removeFixture(outside);
      }
    },
  );

  onlyWhereSymlinksExist(
    'never reads or empties a directory reached only through a symlinked ANCESTOR while cleaning up empty parents',
    async () => {
      await installRig();

      // A file several directories deep, so the empty-parent walk has more
      // than one level to climb — and an ancestor ABOVE the file's own
      // directory that a symlink can stand in for. `applyUninstall` is
      // exercised directly, with a hand-built plan, rather than through
      // `planUninstall`: this fixture's path is not one of the exact paths
      // this release installs (the ownership boundary `planUninstall` checks,
      // pinned separately above), and that is not what this test is about —
      // `applyUninstall` itself trusts the plan it is handed and re-verifies
      // only the filesystem, exactly as a `remove` verdict from a real plan
      // would be treated.
      const deepRel = '.claude/scratch/deep/deeper/marker.txt';
      await write(deepRel, 'evidence\n');
      // `manifestHash: null` and no `recordedHash` on the action deliberately
      // opt this hand-built plan out of the manifest-digest and per-file
      // content checks — both are pinned by their own dedicated tests, and
      // this fixture's whole point is a path outside the real manifest.
      const plan: UninstallPlan = {
        noManifest: false,
        manifestHash: null,
        actions: [{ rel: deepRel, verdict: 'remove' }],
      };

      // An external tree that LOOKS like a legitimate empty tail of the same
      // shape — a naive "lstat the whole joined path" cleanup would resolve
      // straight through the symlinked ancestor and find it.
      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        await mkdir(path.join(outside, 'deep', 'deeper'), { recursive: true });

        // Simulates the window between the apply-time re-check and the
        // parent-directory cleanup that follows it: the file is genuinely
        // removed, then its ANCESTOR (not its own immediate directory) is
        // swapped for a symlink before cleanup walks up through it. Only the
        // ONE removal that matters performs the swap — this seam runs once
        // per removed path, and a second pass over an already-swapped
        // `scratchDir` would itself read and delete straight through the
        // symlink, destroying the very evidence this test checks afterwards.
        // fixture-cleanup-audit.test.ts holds every recursive-removal call
        // site in this suite to a written exception — the fixture tree here is
        // a fixed, fully-known shape (one file at a known depth), so it is
        // unwound by exact name like every other fixture in this file, never
        // with `{ recursive: true }`.
        let swapped = false;
        const swapAncestorThenRemove = async (target: string): Promise<void> => {
          await rm(target);
          if (swapped || !target.endsWith(path.join('deeper', 'marker.txt'))) return;
          swapped = true;
          const scratchDir = abs('.claude/scratch');
          await rmdir(path.join(scratchDir, 'deep', 'deeper'));
          await rmdir(path.join(scratchDir, 'deep'));
          await rmdir(scratchDir);
          await symlink(outside, scratchDir, 'dir');
        };

        await applyUninstall(repo, plan, { removeFile: swapAncestorThenRemove });

        // Left alone: the symlink itself, and everything reachable through it.
        expect((await lstat(abs('.claude/scratch'))).isSymbolicLink()).toBe(true);
        expect((await stat(path.join(outside, 'deep', 'deeper'))).isDirectory()).toBe(true);
      } finally {
        await removeFixture(outside);
      }
    },
  );

  onlyWhereSymlinksExist(
    'refuses to trust the manifest itself when its own ancestor is a symlink, rather than reading through it or reporting noManifest',
    async () => {
      await installRig();
      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        // A real, valid `.claude` (manifest included) re-homed behind a
        // symlink — a naive read would find a plausible-looking manifest
        // instead of noticing the ancestor cannot be trusted.
        await rename(abs('.claude'), path.join(outside, '.claude'));
        await symlink(path.join(outside, '.claude'), abs('.claude'), 'dir');

        await expect(planUninstall(repo)).rejects.toThrow(UninstallError);
      } finally {
        await removeFixture(outside);
      }
    },
  );

  onlyWhereSymlinksExist(
    'refuses to remove the manifest through an ancestor swapped for a symlink between planning and applying',
    async () => {
      // No files to remove at all — only the manifest itself remains to be
      // deleted, so the very next step after planning is the manifest's own
      // safety re-check and unlink, with nothing else in between to race.
      await installRig();
      const manifest = await readManifest(repo);
      if (manifest === null) throw new Error('fixture: no manifest');
      manifest.files = {};
      await writeManifest(repo, manifest);

      const plan = await planUninstall(repo);
      expect(plan.actions).toEqual([]);

      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        const attackerManifest = path.join(outside, '.claude', '.rig-manifest.json');
        await mkdir(path.dirname(attackerManifest), { recursive: true });
        await writeFile(attackerManifest, 'attacker content');

        await rename(abs('.claude'), path.join(outside, 'real-claude'));
        await symlink(path.join(outside, '.claude'), abs('.claude'), 'dir');

        const result = await applyUninstall(repo, plan);
        expect(result.manifestRemoved).toBe(false);
        expect(result.error).toBeTruthy();

        expect((await lstat(abs('.claude'))).isSymbolicLink()).toBe(true);
        expect(await readFile(attackerManifest, 'utf8')).toBe('attacker content');
      } finally {
        await removeFixture(outside);
      }
    },
  );
});

// Windows CI, not this development environment, is what actually measures
// this: a directory JUNCTION is the Windows reparse-point kind a symlink test
// above cannot cover, because `symlink(..., 'dir')` needs a privilege an
// ordinary CI account lacks while a junction does not — that asymmetry is
// exactly why junctions are worth their own case rather than being folded
// into `symlinksAvailable`. `regularFileStatus`'s own safety does not lean on
// any one classification of a junction: the intermediate-segment check is
// `info.isSymbolicLink() || !info.isDirectory()`, so it refuses whether a
// junction is reported as a symlink (the documented Node/libuv behaviour on
// Windows, and the same behaviour this repository's own ancestor-escape
// fixtures elsewhere already rely on — e.g.
// `test/template/content-blind-revalidation.test.ts`'s
// `process.platform === 'win32' ? 'junction' : 'dir'` pattern) or, failing
// that, simply because it is not a plain directory either way.
describe('planUninstall / applyUninstall — a Windows junction never gets read or removed through', () => {
  const onlyOnWindowsPlatform = (name: string, body: () => Promise<void>): void =>
    it(name, async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      await body();
    });

  onlyOnWindowsPlatform(
    'preserves a file whose ancestor directory is a junction out of the repository, and never touches the external target',
    async () => {
      await installRig();
      const originalContent = await read(WORKFLOW);

      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        await mkdir(path.join(outside, 'rules'), { recursive: true });
        await writeFile(path.join(outside, 'rules', 'workflow.md'), originalContent);

        const rulesDir = abs('.claude/rules');
        for (const entry of await readdir(rulesDir)) {
          await rm(path.join(rulesDir, entry));
        }
        await rmdir(rulesDir);
        // A junction, not a symlink — creatable on Windows without an
        // elevated privilege, which is the whole point of exercising this
        // reparse-point kind separately from the `dir`-symlink tests above.
        await symlink(path.join(outside, 'rules'), rulesDir, 'junction');

        const plan = await planUninstall(repo);
        const action = actionFor(plan, WORKFLOW);
        expect(action?.verdict).toBe('preserved');
        expect(action?.reason).toMatch(/symlink/i);

        await applyUninstall(repo, plan);

        expect(await readFile(path.join(outside, 'rules', 'workflow.md'), 'utf8')).toBe(
          originalContent,
        );
      } finally {
        await removeFixture(outside);
      }
    },
  );

  // A junction is a directory-only reparse point — it cannot stand in for the
  // managed FILE itself the way a symlink can (that form needs a `file`-type
  // link, which requires the same elevated privilege a `dir` symlink does on
  // Windows, so it gains nothing from being tested as a junction). The
  // ancestor case above is the one junctions actually widen coverage for.
  onlyOnWindowsPlatform(
    'refuses to remove a path whose ancestor became a junction between planning and applying, as a failed run',
    async () => {
      await installRig();
      const plan = await planUninstall(repo);
      expect(actionFor(plan, WORKFLOW)?.verdict).toBe('remove');

      const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-outside-'));
      try {
        await mkdir(path.join(outside, 'rules'), { recursive: true });
        await writeFile(path.join(outside, 'rules', 'workflow.md'), 'attacker content');

        const rulesDir = abs('.claude/rules');
        for (const entry of await readdir(rulesDir)) {
          await rm(path.join(rulesDir, entry));
        }
        await rmdir(rulesDir);
        await symlink(path.join(outside, 'rules'), rulesDir, 'junction');

        // the stale plan still says "remove" — the guard has to be
        // re-checked at apply time, not trusted from the plan
        const result = await applyUninstall(repo, plan);
        expect(result.manifestRemoved).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.remaining).toContain(WORKFLOW);
        expect(result.completed).not.toContain(WORKFLOW);

        expect(await readFile(path.join(outside, 'rules', 'workflow.md'), 'utf8')).toBe(
          'attacker content',
        );
      } finally {
        await removeFixture(outside);
      }
    },
  );
});

describe('applyUninstall — an interrupted run', () => {
  it('stops on the first failure, keeps the manifest, and reports completed/remaining', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    const toRemove = plan.actions.filter((a) => a.verdict === 'remove').map((a) => a.rel);
    expect(toRemove.length).toBeGreaterThan(1);
    const failingRel = toRemove[1]!;

    const flaky = async (target: string): Promise<void> => {
      if (target.endsWith(failingRel.split('/').join(path.sep))) {
        throw new Error('simulated failure');
      }
      await rm(target);
    };

    const result = await applyUninstall(repo, plan, { removeFile: flaky });
    expect(result.manifestRemoved).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.completed).toBeDefined();
    expect(result.remaining).toBeDefined();
    expect(result.remaining).toContain(failingRel);
    expect(result.completed).not.toContain(failingRel);
    // a re-run still owes the manifest too — nothing in this plan is
    // preserved, so a clean re-run really would go on to delete it once the
    // remaining files are gone
    expect(result.remaining).toContain(MANIFEST_REL);
    // the manifest is untouched
    expect(await exists(MANIFEST_REL)).toBe(true);

    // a re-run continues: the completed ones are now absent, the rest still owed
    const retry = await planUninstall(repo);
    for (const rel of result.completed ?? []) {
      expect(actionFor(retry, rel)?.verdict).toBe('absent');
    }
    expect(actionFor(retry, failingRel)?.verdict).toBe('remove');

    const retryResult = await applyUninstall(repo, retry);
    expect(retryResult.manifestRemoved).toBe(true);
  });

  it('does not list the manifest as remaining when something else in the plan is preserved — a re-run would not delete it anyway', async () => {
    await installRig();
    // one edited file, so the plan carries a `preserved` action alongside the
    // removable ones — the manifest is never going to be deleted this run
    // (or a clean re-run of it) regardless of the failure below
    await write(WORKFLOW, `${await read(WORKFLOW)}\n<!-- mine -->\n`);

    const plan = await planUninstall(repo);
    const toRemove = plan.actions.filter((a) => a.verdict === 'remove').map((a) => a.rel);
    expect(toRemove.length).toBeGreaterThan(0);
    const failingRel = toRemove[0]!;

    const flaky = async (target: string): Promise<void> => {
      if (target.endsWith(failingRel.split('/').join(path.sep))) {
        throw new Error('simulated failure');
      }
      await rm(target);
    };

    const result = await applyUninstall(repo, plan, { removeFile: flaky });
    expect(result.manifestRemoved).toBe(false);
    expect(result.remaining).toContain(failingRel);
    expect(result.remaining).not.toContain(MANIFEST_REL);
  });
});

// `UninstallAction` carries the plan's recorded hash for every `remove`
// verdict, and `applyUninstall` re-reads the actual bytes immediately before
// each unlink — not only the file's regularFileStatus, which a plain content
// edit (no symlink, still a regular file) never changes. Content drift in the
// window between the plan being shown and the user answering `yes` must be
// caught the same way a symlink appearing there already is, but the response
// is different on purpose: a symlink is suspicious enough to abort the whole
// run, while an edit is ordinary enough that the right answer is "skip this
// one file, keep going" — the same posture `preserved: modified` already
// takes for a file caught edited at PLAN time.
describe('applyUninstall — a file that changed after planning', () => {
  it('does not remove it, does not abort the run, and reports it apart from removed/preserved', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    expect(actionFor(plan, WORKFLOW)?.verdict).toBe('remove');

    // simulates an edit made in the window between the plan being printed
    // and the user typing `yes`
    await write(WORKFLOW, `${await read(WORKFLOW)}\n<!-- edited after planning -->\n`);

    const result = await applyUninstall(repo, plan);
    expect(result.error).toBeUndefined();
    expect(result.removed).not.toContain(WORKFLOW);
    expect(result.changedSincePlanning).toContain(WORKFLOW);
    expect(await exists(WORKFLOW)).toBe(true);
    expect(await read(WORKFLOW)).toContain('edited after planning');
  });

  it('keeps removing everything else the plan named, and keeps the manifest since something is now effectively preserved', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    const toRemove = plan.actions.filter((a) => a.verdict === 'remove').map((a) => a.rel);
    expect(toRemove.length).toBeGreaterThan(1);

    await write(WORKFLOW, `${await read(WORKFLOW)}\n<!-- edited after planning -->\n`);

    const result = await applyUninstall(repo, plan);
    expect(result.changedSincePlanning).toEqual([WORKFLOW]);
    expect(result.removed.length).toBe(toRemove.length - 1);
    expect(result.removed).not.toContain(WORKFLOW);
    // the rig still owns WORKFLOW's bytes — the manifest is the only record
    // naming that, so it stays, exactly as a plan-time `preserved` would keep it
    expect(result.manifestRemoved).toBe(false);
    expect(result.outcome).toBe('partial');
    await expect(readManifest(repo)).resolves.not.toBeNull();
  });

  it('never removes a wiring file whose bytes changed after planning either', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    expect(actionFor(plan, SETTINGS)?.verdict).toBe('remove');

    await write(SETTINGS, `${await read(SETTINGS)}\n`);

    const result = await applyUninstall(repo, plan);
    expect(result.changedSincePlanning).toContain(SETTINGS);
    expect(await exists(SETTINGS)).toBe(true);
  });
});

// The manifest's own bytes are the evidence the whole plan rests on — a
// digest taken at plan time is verified twice: once before ANY removal
// starts (a plan built from bytes that no longer exist authorises nothing),
// and again immediately before the manifest's own deletion (the window every
// per-file removal that came before it could have used).
describe('applyUninstall — the manifest itself changed after planning', () => {
  it('refuses the whole apply and removes nothing when the manifest changed before the first action', async () => {
    await installRig();
    const plan = await planUninstall(repo);

    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, {
      ...manifest,
      files: { ...manifest.files, 'CLAUDE.md': sha256('tampered') },
    });

    const result = await applyUninstall(repo, plan);
    expect(result.removed).toEqual([]);
    expect(result.manifestRemoved).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain(MANIFEST_REL);
    // nothing this run would have removed was touched
    expect(await exists(WORKFLOW)).toBe(true);
    expect(await exists(SETTINGS)).toBe(true);
  });

  it('does not delete the manifest, and reports an honest partial result, when the manifest changes during the run', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    const toRemove = plan.actions.filter((a) => a.verdict === 'remove').map((a) => a.rel);
    expect(toRemove.length).toBeGreaterThan(0);
    const lastRel = toRemove[toRemove.length - 1]!;

    const tamperManifestAfterLastFile = async (target: string): Promise<void> => {
      await rm(target);
      if (!target.endsWith(lastRel.split('/').join(path.sep))) return;
      // the very next step after this removal is the manifest's own
      // checkpoint and unlink — swap its content right in that window
      const manifest = await readManifest(repo);
      if (manifest === null) throw new Error('fixture: manifest missing mid-run');
      await writeManifest(repo, {
        ...manifest,
        files: { ...manifest.files, 'CLAUDE.md': sha256('tampered') },
      });
    };

    const result = await applyUninstall(repo, plan, { removeFile: tamperManifestAfterLastFile });
    expect(result.manifestRemoved).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain(MANIFEST_REL);
    // honest partial result: every file that really was removed is named,
    // and the manifest is what a re-run still owes
    expect(result.completed).toEqual(toRemove);
    expect(result.remaining).toEqual([MANIFEST_REL]);
    await expect(readManifest(repo)).resolves.not.toBeNull();
  });
});

describe('applyUninstall — --detach', () => {
  it('behaves exactly like an ordinary clean uninstall on a repo with nothing to preserve, outcome "detached"', async () => {
    await installRig();
    const plan = await planUninstall(repo);

    const result = await applyUninstall(repo, plan, { detach: true });
    expect(result.manifestRemoved).toBe(true);
    expect(result.outcome).toBe('detached');
    expect(result.removed.length).toBeGreaterThan(0);
    await expect(readManifest(repo)).resolves.toBeNull();
  });

  it('removes the manifest even though something is preserved, leaves every preserved path exactly alone, and never forces a conflicting file away', async () => {
    await installRig();
    const editedContent = `${await read(WORKFLOW)}\n<!-- mine -->\n`;
    await write(WORKFLOW, editedContent);

    const plan = await planUninstall(repo);
    expect(actionFor(plan, WORKFLOW)?.verdict).toBe('preserved');

    const result = await applyUninstall(repo, plan, { detach: true });
    expect(result.manifestRemoved).toBe(true);
    expect(result.outcome).toBe('detached');
    // the conflicting file was never forced away — detach never deletes what
    // ordinary uninstall would not
    expect(await read(WORKFLOW)).toBe(editedContent);
    await expect(readManifest(repo)).resolves.toBeNull();
  });

  it('never removes anything a normal run would not — the same per-file safety applies, detach only changes what happens to the manifest', async () => {
    await installRig();
    await write('src/app.ts', 'export const x = 1;\n');
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    manifest.files['src/app.ts'] = sha256(await readFile(abs('src/app.ts')));
    await writeManifest(repo, manifest);

    const plan = await planUninstall(repo);
    const result = await applyUninstall(repo, plan, { detach: true });
    expect(result.manifestRemoved).toBe(true);
    expect(await read('src/app.ts')).toBe('export const x = 1;\n');
  });

  it('a dry run is unaffected by --detach — it still removes nothing', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    const result = await applyUninstall(repo, plan, { detach: true, dryRun: true });
    expect(result.removed).toEqual([]);
    expect(result.manifestRemoved).toBe(false);
    await expect(readManifest(repo)).resolves.not.toBeNull();
  });
});
