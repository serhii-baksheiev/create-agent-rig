import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { MANIFEST_REL, readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

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
});

describe('applyUninstall — the happy path', () => {
  it('removes every remove-verdict path and the manifest last, on a clean rig', async () => {
    await installRig();
    const plan = await planUninstall(repo);
    const result = await applyUninstall(repo, plan);

    expect(result.manifestRemoved).toBe(true);
    expect(result.error).toBeUndefined();
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
});
