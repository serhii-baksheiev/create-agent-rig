/**
 * RP-421 — a loop item worked in a per-item worktree arms a checkout-scoped
 * unattended flag (`on --root <worktree> …`), but the `worktree-task` skill's
 * Finish cleanup removes the worktree without ever running `off --root
 * <worktree>` — the flag outlives the checkout that armed it, nothing
 * reports the leftover, and the flag JSON carries no `root` to map it back
 * to a checkout at all.
 *
 * This file pins the three code-level fixes the report names:
 *  1. the flag JSON gains a `root` field (the canonical checkout path);
 *  2. `off --root <path>` already clears a flag whose checkout directory no
 *     longer exists — pinned here as a regression test, per the report;
 *  3. a new, read-only `list` subcommand enumerates this project's
 *     checkout-scoped flags, marking each `active` or `orphaned` (its
 *     recorded root no longer exists) or noting it carries no recorded root
 *     at all (a pre-fix flag), and naming the exact remedy for an orphan.
 *
 * Fixture style follows `unattended-flag.test.ts`: every test redirects
 * `HOME` to a fresh `mkdtemp` directory, and any case that goes through the
 * CLI's scoped `on`/`off` (which mirrors into the real password-database
 * home, same as the kill switch) removes its own exact candidate paths and
 * then verifies independently that nothing was left behind. The `list`
 * tests write flag files directly into the test's own temp `HOME` rather
 * than through `writeUnattended`/`on`, so they never touch the real home at
 * all — no mirroring call is made.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { needsGit, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptPath = path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs');
const FLAG_NAME = '__PROJECT_NAME__-loop-UNATTENDED';

const load = () =>
  import(pathToFileURL(scriptPath).href) as Promise<{
    writeUnattended: (
      flag: { item: string; runDir?: string | null; allow?: string[] },
      env?: NodeJS.ProcessEnv,
    ) => string[];
    readUnattended: (env?: NodeJS.ProcessEnv) => {
      on: boolean;
      item?: string | null;
      runDir?: string | null;
      allow?: string[];
      unreadable?: boolean;
      why?: string;
    };
    unattendedFlags: (env?: NodeJS.ProcessEnv) => string[];
    clearUnattended: (env?: NodeJS.ProcessEnv) => string[];
  }>;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = (
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { env: { ...process.env, HOME: home, ...extraEnv } },
      (error, stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });

// Precondition, same reasoning as unattended-flag.test.ts: a pre-existing
// record in a REAL home would make every "nothing scoped is armed" assertion
// meaningless, and a scoped write below mirrors there too.
const realHomes = new Set([homedir()]);
try {
  realHomes.add(userInfo().homedir);
} catch {
  // no password entry
}
beforeAll(() => {
  for (const home of realHomes) {
    expect(
      existsSync(path.join(home, '.claude', FLAG_NAME)),
      `the REAL home ${home} carries an unattended flag — remove it before running these tests`,
    ).toBe(false);
  }
});

let home: string;
const originalHome = process.env.HOME;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'rp421-flag-'));
  process.env.HOME = home;
});
afterEach(async () => {
  process.env.HOME = originalHome;
  await removeFixture(home);
});

/**
 * Independent of production (`invariants.md`, "the independent-oracle
 * invariant"): the scheme is hand-copied from `unattended-flag.mjs`'s own
 * header comment, never derived by calling `unattendedFlags`/`checkoutId`.
 */
const scopedFlagName = (canonicalRoot: string): string => {
  const hash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  return FLAG_NAME.replace('-loop-UNATTENDED', `-${hash}-loop-UNATTENDED`);
};

const assertNoScopedFlagLeaked = async (
  canonicalRoot: string,
  homesToCheck: readonly string[],
): Promise<void> => {
  const name = scopedFlagName(canonicalRoot);
  for (const candidateHome of homesToCheck) {
    const candidate = path.join(candidateHome, '.claude', name);
    if (existsSync(candidate)) {
      throw new Error(`this test left a scoped unattended flag behind: ${candidate}`);
    }
  }
};

/** A checkout path that is already its own realpath — no symlink indirection
 * (`os.tmpdir()` can itself be a symlink, e.g. macOS `/var` → `/private/var`),
 * so canonicalising it before or after deletion yields the same string. */
const canonicalCheckoutDir = async (prefix: string): Promise<string> => {
  const base = realpathSync.native(tmpdir());
  return mkdtemp(path.join(base, prefix));
};

describe('the flag JSON records the checkout root it is scoped to (RP-421)', () => {
  it('writeUnattended writes a `root` field equal to the canonical checkout, and readUnattended keeps reporting armed', async () => {
    const checkout = path.join(home, 'root-field-checkout');
    await mkdir(checkout, { recursive: true });
    const canonical = realpathSync.native(checkout);
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    const { writeUnattended, readUnattended, clearUnattended } = await load();
    writeUnattended({ item: 'RP-421', runDir: '/runs/1', allow: [] }, scopedEnv);
    try {
      const candidatePath = scopedFlagName(canonical);
      const written = JSON.parse(
        await readFile(path.join(home, '.claude', candidatePath), 'utf8'),
      ) as { item: string; runDir: string; allow: string[]; root?: string };
      expect(written.root, 'the written flag JSON has no `root` field at all').toBe(canonical);
      expect(readUnattended(scopedEnv)).toMatchObject({
        on: true,
        item: 'RP-421',
        runDir: '/runs/1',
      });
    } finally {
      clearUnattended(scopedEnv);
    }
    await assertNoScopedFlagLeaked(canonical, [home, ...realHomes]);
  });

  it('the CLI `on --root <checkout> --item X` writes a `root` field matching the checkout', async (ctx) => {
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = path.join(home, 'cli-root-field-checkout');
    await mkdir(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const canonical = realpathSync.native(checkout);
    try {
      const result = await runCli(['on', '--root', checkout, '--item', 'RP-421'], home);
      expect(result.code, result.stderr).toBe(0);
      const written = JSON.parse(
        await readFile(path.join(home, '.claude', scopedFlagName(canonical)), 'utf8'),
      ) as { root?: string };
      expect(written.root).toBe(canonical);
    } finally {
      await runCli(['off', '--root', checkout], home);
    }
    await assertNoScopedFlagLeaked(canonical, [home, ...realHomes]);
  });
});

describe('off --root clears a flag whose checkout directory no longer exists (RP-421)', () => {
  // This is the exact remedy the defect report names for a leftover flag —
  // pinned here as a regression test; per the brief it may already pass.
  it('removes the flag file and exits 0 even though --root points at a now-deleted directory', async (ctx) => {
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = await canonicalCheckoutDir('rp421-deleted-root-');
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const canonical = checkout; // already canonical, see canonicalCheckoutDir
    const onResult = await runCli(['on', '--root', checkout, '--item', 'RP-421'], home);
    expect(onResult.code, onResult.stderr).toBe(0);
    expect(existsSync(path.join(home, '.claude', scopedFlagName(canonical)))).toBe(true);

    await removeFixture(checkout);
    expect(existsSync(checkout)).toBe(false);

    const offResult = await runCli(['off', '--root', checkout], home);
    expect(offResult.code, offResult.stderr).toBe(0);
    expect(existsSync(path.join(home, '.claude', scopedFlagName(canonical)))).toBe(false);
    await assertNoScopedFlagLeaked(canonical, [home, ...realHomes]);
  });
});

describe("unattended-flag.mjs list — read-only inventory of this project's checkout-scoped flags (RP-421)", () => {
  const claudeDir = () => path.join(home, '.claude');

  const writeScopedFlag = async (
    root: string | undefined,
    item: string,
    { basenameOverride }: { basenameOverride?: string } = {},
  ): Promise<string> => {
    await mkdir(claudeDir(), { recursive: true });
    const basename = basenameOverride ?? scopedFlagName(root ?? item);
    const target = path.join(claudeDir(), basename);
    const payload: Record<string, unknown> = { item, runDir: null, allow: [] };
    if (root !== undefined) payload.root = root;
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`);
    return target;
  };

  it('says no flags are armed when none exist, and exits 0', async () => {
    // `list` also reads the password-database home, where other test files
    // mirror `__PROJECT_NAME__` flags while they run. A copy rendered with a
    // name of its own, as a generated rig would be, sees none of theirs.
    const scripts = await mkdtemp(path.join(tmpdir(), 'rp421-render-'));
    try {
      const name = `rp421-${path.basename(scripts)}`;
      for (const file of ['unattended-flag.mjs', 'stop-flag.mjs', 'git-env.mjs']) {
        const text = await readFile(path.join(path.dirname(scriptPath), file), 'utf8');
        await writeFile(path.join(scripts, file), text.replaceAll('__PROJECT_NAME__', name));
      }
      const result = await new Promise<CliResult>((resolve) => {
        execFile(
          process.execPath,
          [path.join(scripts, 'unattended-flag.mjs'), 'list'],
          { env: { ...process.env, HOME: home } },
          (error, stdout, stderr) => {
            resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
          },
        );
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe('no unattended flags are armed\n');
    } finally {
      await removeFixture(scripts);
    }
  });

  it('lists an active flag naming the item and the recorded root', async () => {
    const root = path.join(home, 'active-checkout');
    await mkdir(root, { recursive: true });
    await writeScopedFlag(root, 'RP-ACTIVE');
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const idx = result.stdout.indexOf('RP-ACTIVE');
    expect(idx, result.stdout).toBeGreaterThan(-1);
    expect(result.stdout.slice(idx, idx + 300)).toMatch(/RP-ACTIVE[\s\S]{0,200}active/i);
    expect(result.stdout).toContain(root);
  });

  it('SECURITY: a flag whose filename id hashes a different path than its recorded `root` is reported as a mismatch, never `active`, and carries no `off --root` remedy', async () => {
    const inventoryRootA = path.join(home, 'inventory-order-a');
    const inventoryRootB = path.join(home, 'inventory-order-b');
    const [rootA, activeRoot] =
      scopedFlagName(inventoryRootA) < scopedFlagName(inventoryRootB)
        ? [inventoryRootA, inventoryRootB]
        : [inventoryRootB, inventoryRootA];
    const rootB = path.join(home, 'mismatch-root-b');
    await mkdir(rootB, { recursive: true }); // B exists on disk; A need not
    await mkdir(activeRoot, { recursive: true });
    const flagPath = await writeScopedFlag(rootB, 'RP-MISMATCH-A', {
      basenameOverride: scopedFlagName(rootA),
    });
    await writeScopedFlag(activeRoot, 'RP-VALID-ACTIVE');
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const idx = result.stdout.indexOf('RP-MISMATCH-A');
    expect(idx, result.stdout).toBeGreaterThan(-1);
    const activeIdx = result.stdout.indexOf('RP-VALID-ACTIVE');
    expect(activeIdx, result.stdout).toBeGreaterThan(idx);
    const record = result.stdout.slice(idx).split('\n')[0];
    expect(record).toMatch(/does not match|mismatch/i);
    expect(record).toContain(flagPath);
    expect(record).not.toContain('off --root');
    expect(record).not.toMatch(/\bactive\b/i);
    expect(record).not.toMatch(/\borphaned\b/i);
    const activeLine = result.stdout.slice(activeIdx).split('\n')[0];
    expect(activeLine).toMatch(/RP-VALID-ACTIVE: active/i);
    expect(activeLine).toContain(activeRoot);
  });

  it('SECURITY: a `root` carrying a control character appended to an otherwise-real directory is reported as a mismatch, never `orphaned`, even though the stripped-for-display root looks like an ordinary leftover', async () => {
    const cleanDir = path.join(home, 'mismatch-control-dir');
    await mkdir(cleanDir, { recursive: true });
    const poisonedRoot = `${cleanDir}\u0007`;
    const flagPath = await writeScopedFlag(poisonedRoot, 'RP-MISMATCH-B', {
      basenameOverride: scopedFlagName(cleanDir),
    });
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const idx = result.stdout.indexOf('RP-MISMATCH-B');
    expect(idx, result.stdout).toBeGreaterThan(-1);
    const record = result.stdout.slice(idx).split('\n')[0];
    expect(record).toMatch(/does not match|mismatch/i);
    expect(record).toContain(flagPath);
    expect(record).not.toContain('off --root');
    expect(record).not.toMatch(/\bactive\b/i);
    expect(record).not.toMatch(/\borphaned\b/i);
  });

  it('SECURITY: a relative `root` ("."), even when its hash happens to match the filename id, is reported as a mismatch because it is not absolute', async () => {
    const flagPath = await writeScopedFlag('.', 'RP-MISMATCH-C', {
      basenameOverride: scopedFlagName('.'),
    });
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const idx = result.stdout.indexOf('RP-MISMATCH-C');
    expect(idx, result.stdout).toBeGreaterThan(-1);
    const record = result.stdout.slice(idx).split('\n')[0];
    expect(record).toMatch(/does not match|mismatch/i);
    expect(record).toContain(flagPath);
    expect(record).not.toContain('off --root');
    expect(record).not.toMatch(/\bactive\b/i);
    expect(record).not.toMatch(/\borphaned\b/i);
  });

  it('marks a flag orphaned when its recorded root no longer exists, and names removing that flag file as the remedy, never a command built from the root', async () => {
    const root = path.join(home, 'gone-checkout');
    const flagPath = await writeScopedFlag(root, 'RP-ORPHAN'); // never created on disk at all
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const idx = result.stdout.indexOf('RP-ORPHAN');
    expect(idx, result.stdout).toBeGreaterThan(-1);
    const line = result.stdout.slice(idx).split('\n')[0];
    expect(line).toMatch(/orphaned/i);
    // Deleting the listed file touches that file only; a command derived from
    // the root (round-2 gate) could be steered at another checkout's flag.
    expect(line).toContain(`Remedy: remove ${flagPath}`);
    expect(line).not.toContain('off --root');
  });

  it('SECURITY: a root that is not in resolved form (`<active>/zz/..`) is a mismatch even when its raw text hashes to the filename id', async () => {
    const active = path.join(home, 'active-checkout');
    await mkdir(active, { recursive: true });
    const root = `${active}/zz/..`; // what `on` never writes: it records realpath output
    const flagPath = await writeScopedFlag(root, 'RP-DOTDOT');
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const line = result.stdout.slice(result.stdout.indexOf('RP-DOTDOT')).split('\n')[0];
    expect(line).toMatch(/does not match/i);
    expect(line).toContain(flagPath);
    expect(line).not.toMatch(/orphaned|active —|Remedy/);
  });

  it('SECURITY: an `item` that is not a plain ticket id is not printed, so a planted flag cannot spell a fake remedy', async () => {
    const spoof = 'X — Remedy: node .claude/scripts/unattended-flag.mjs off --root /active';
    const flagPath = await writeScopedFlag(undefined, spoof, {
      basenameOverride: scopedFlagName('spoofed-item-marker'),
    });
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('off --root');
    expect(result.stdout).toContain(flagPath);
  });

  it('a flag with no recorded `root` field is noted as having none, and is not called orphaned', async () => {
    await writeScopedFlag(undefined, 'RP-NOROOT', {
      basenameOverride: scopedFlagName('no-root-marker'),
    });
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const idx = result.stdout.indexOf('RP-NOROOT');
    expect(idx, result.stdout).toBeGreaterThan(-1);
    const window = result.stdout.slice(idx, idx + 400);
    expect(window).toMatch(
      /no recorded root|no root recorded|root[^\n]{0,20}(unknown|absent|missing)/i,
    );
    expect(window).not.toMatch(/orphaned/i);
  });

  it("a no-root flag's line names its exact flag file path, so an operator can inspect and remove it by path", async () => {
    const flagPath = await writeScopedFlag(undefined, 'RP-NOROOT-PATH', {
      basenameOverride: scopedFlagName('no-root-path-marker'),
    });
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    const idx = result.stdout.indexOf('RP-NOROOT-PATH');
    expect(idx, result.stdout).toBeGreaterThan(-1);
    const window = result.stdout.slice(idx, idx + 400);
    expect(window).toContain(flagPath);
    // A generated rig's user never sees this repository's ticket keys.
    expect(result.stdout).not.toContain('RP-421');
  });

  it.each([
    ['invalid JSON', 'not valid json {'],
    ['a JSON array', JSON.stringify(['a', 'b'])],
    ['a file larger than 64 KiB', Buffer.alloc(65537, 'a')],
  ])(
    'an unreadable flag (%s) is reported "cannot be read" by its basename, exits 0, and is left byte-identical',
    async (_label, content) => {
      await mkdir(claudeDir(), { recursive: true });
      const basename = scopedFlagName(`unreadable-${_label}`);
      const target = path.join(claudeDir(), basename);
      await writeFile(target, content);
      const before = await readFile(target);
      const result = await runCli(['list'], home);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('cannot be read');
      expect(result.stdout).toContain(basename);
      const after = await readFile(target);
      expect(Buffer.compare(before, after)).toBe(0);
    },
  );

  it('never deletes or modifies any flag file — every flag is byte-identical before and after', async () => {
    const activeRoot = path.join(home, 'untouched-active');
    await mkdir(activeRoot, { recursive: true });
    const activePath = await writeScopedFlag(activeRoot, 'RP-UNTOUCHED-ACTIVE');
    const orphanRoot = path.join(home, 'untouched-orphan');
    const orphanPath = await writeScopedFlag(orphanRoot, 'RP-UNTOUCHED-ORPHAN');

    const before = {
      active: await readFile(activePath),
      orphan: await readFile(orphanPath),
    };

    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);

    expect(existsSync(activePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(true);
    const after = {
      active: await readFile(activePath),
      orphan: await readFile(orphanPath),
    };
    expect(Buffer.compare(before.active, after.active)).toBe(0);
    expect(Buffer.compare(before.orphan, after.orphan)).toBe(0);
  });

  it("does not list a flag of a different project, or the unscoped legacy basename, as this project's scoped flags", async () => {
    await mkdir(claudeDir(), { recursive: true });
    await writeFile(
      path.join(claudeDir(), FLAG_NAME), // unscoped legacy basename, no project-scope hash
      JSON.stringify({ item: 'RP-LEGACY', runDir: '/runs/legacy', allow: [] }),
    );
    const otherHash = createHash('sha256').update('other-project-root').digest('hex').slice(0, 16);
    await writeFile(
      path.join(claudeDir(), `other-project-${otherHash}-loop-UNATTENDED`),
      JSON.stringify({ item: 'RP-OTHER-PROJECT', runDir: '/runs/other', allow: [] }),
    );
    const result = await runCli(['list'], home);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('RP-LEGACY');
    expect(result.stdout).not.toContain('RP-OTHER-PROJECT');
  });
});

describe("off --root A never removes checkout B's flag (RP-421 isolation)", () => {
  it('disarming A leaves B armed, and B still shows up as active through `list`', async (ctx) => {
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkoutA = path.join(home, 'isolation-checkout-a');
    const checkoutB = path.join(home, 'isolation-checkout-b');
    await mkdir(checkoutA, { recursive: true });
    await mkdir(checkoutB, { recursive: true });
    execFileSync('git', ['init', '-q', checkoutA], { env: withoutGitLocation() });
    execFileSync('git', ['init', '-q', checkoutB], { env: withoutGitLocation() });
    const canonicalA = realpathSync.native(checkoutA);
    const canonicalB = realpathSync.native(checkoutB);
    try {
      expect((await runCli(['on', '--root', checkoutA, '--item', 'RP-ISO-A'], home)).code).toBe(0);
      expect((await runCli(['on', '--root', checkoutB, '--item', 'RP-ISO-B'], home)).code).toBe(0);

      const offA = await runCli(['off', '--root', checkoutA], home);
      expect(offA.code, offA.stderr).toBe(0);

      expect(existsSync(path.join(home, '.claude', scopedFlagName(canonicalA)))).toBe(false);
      expect(existsSync(path.join(home, '.claude', scopedFlagName(canonicalB)))).toBe(true);

      const listResult = await runCli(['list'], home);
      expect(listResult.code, listResult.stderr).toBe(0);
      expect(listResult.stdout).not.toContain('RP-ISO-A');
      const idxB = listResult.stdout.indexOf('RP-ISO-B');
      expect(idxB, listResult.stdout).toBeGreaterThan(-1);
      expect(listResult.stdout.slice(idxB, idxB + 400)).toMatch(/active/i);
    } finally {
      await runCli(['off', '--root', checkoutB], home);
    }
    await assertNoScopedFlagLeaked(canonicalA, [home, ...realHomes]);
    await assertNoScopedFlagLeaked(canonicalB, [home, ...realHomes]);
  });
});
