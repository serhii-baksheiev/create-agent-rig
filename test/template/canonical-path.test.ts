import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { skipUnless, symlinksAvailable } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * RP-247 round 3 — code-reviewer HOLD on PR #350, head `e091f9e`. Nothing in
 * this suite pinned BOUNDED WORK in `canonicalPath` itself: every existing
 * test reaches it only through the full `guard-rulebook.mjs` subprocess,
 * where a SLOW walk still ends in the same observable outcome (eventually
 * refused) as a FAST one — so a mutation that moves the component-bound
 * check from BEFORE the walk to AFTER it left the whole suite green. On
 * Windows that mutant ran a genuinely unbounded 64,000-component Write until
 * a 120s kill. `.claude/rules/invariants.md`'s "a guard that fails open must
 * do provably bounded work" is about the WORK, not only the eventual
 * answer — a guard that blocks correctly, but only after doing unbounded
 * work first, has not met that bar either, and a killed hook is still an
 * ALLOW.
 *
 * `canonicalPath` is not imported from `guard-rulebook.mjs`: that file calls `process.exit(main())` at module top level, so
 * importing it in-process would kill the test worker the same way
 * `edit-input.mjs` and `hook-input.mjs` were split out to avoid exactly
 * that. It lives in a side-effect-free module,
 * `templates/agent-os/universal/.claude/hooks/lib/canonical-path.mjs`,
 * exporting `canonicalPath(filePath, { realpath } = {})` with `realpath`
 * defaulting to `realpathSync.native` — injectable here so the tests below
 * can pin the WALK's own bound directly (call counts), not merely its final
 * answer, and can do so without a real filesystem for the over-bound case.
 *
 * Non-vacuity — the mutation this suite exists to catch: moving the
 * `exceedsPathComponentBound(resolved)` check from before the walk's `for`
 * loop to after it returns (the reviewer's exact round-2 finding). Since
 * this module does not exist in the repository on either side of that
 * mutation yet, both variants were built and run from a `/tmp` copy, not
 * this clone (`/tmp/rp247-canonical-check/lib/canonical-path-{correct,
 * mutant}.mjs`, deleted after use), against test (a)'s own logic:
 *
 *   correct (bound checked first): result=null, realpath calls=0
 *   mutant  (bound checked after): result=null, realpath calls=1
 *
 * — the mutant still returns the right ANSWER (both are `null`), which is
 * exactly why a test on the eventual answer alone (the shape every existing
 * `guard-rulebook.test.ts` pin takes) cannot catch this: only the call count
 * — test (a)'s `expect(calls.count).toBe(0)` — goes red under the mutant and
 * green under the correct ordering. Escalated with an ENOENT-until-root
 * stub standing in for a real, mostly-nonexistent 64,000-component path (the
 * shape that actually produced the Windows kill): the correct ordering still
 * makes 0 calls; the mutant makes 64,003 and takes 685ms even against an
 * in-memory stub with no real filesystem latency at all — the 120s figure on
 * Windows is the same shape of walk against `realpathSync.native`, whose
 * per-call cost the earlier RP-247 rounds already measured in the hundreds
 * of milliseconds at this scale.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const modulePath = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'hooks',
  'lib',
  'canonical-path.mjs',
);

type CanonicalPath = (
  filePath: string,
  options?: { realpath?: (candidate: string) => string },
) => string | null;

const load = () =>
  import(pathToFileURL(modulePath).href) as Promise<{ canonicalPath: CanonicalPath }>;

/** A realpath stub that throws ENOENT for everything except `existing`. */
const enoentExceptFor = (existing: string, calls: { count: number }) => (candidate: string) => {
  calls.count += 1;
  if (candidate === existing) return candidate;
  const error = new Error(
    `ENOENT: no such file or directory, lstat '${candidate}'`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
};

describe('canonicalPath: bounded work over the component count, pinned in-process (RP-247 round 3)', () => {
  it('a path of 64,000 components returns null and never calls the injected realpath', async () => {
    const { canonicalPath } = await load();
    const calls = { count: 0 };
    const realpath = (candidate: string) => {
      calls.count += 1;
      return candidate;
    };
    const components = Array.from({ length: 64_000 }, (_, index) => `d${index}`);
    const filePath = path.posix.join('/root', ...components, 'evil.md');

    const result = canonicalPath(filePath, { realpath });

    expect(result).toBeNull();
    // The whole point of the bound check: nothing past it should ever reach
    // the walk, let alone spend one call per component on it.
    expect(calls.count).toBe(0);
  });

  describe('under the bound, against a real directory', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await realpath(await mkdtemp(path.join(tmpdir(), 'canonical-path-')));
    });
    afterEach(async () => {
      await removeFixture(dir);
    });

    it('an ordinary in-bound path resolves normally, with the default realpath', async () => {
      const { canonicalPath } = await load();
      // `dir` is already canonical (realpath'd above); `x.md` itself need
      // not exist — canonicalPath's job is resolving the nearest EXISTING
      // ancestor and reattaching the missing tail, not requiring the file.
      const target = path.join(dir, 'x.md');

      expect(canonicalPath(target)).toBe(target);
    });

    it('a 100-component nonexistent tail under a real directory calls realpath at most once per component', async () => {
      const { canonicalPath } = await load();
      const calls = { count: 0 };
      const tail = Array.from({ length: 100 }, (_, index) => `t${index}`);
      const target = path.join(dir, ...tail, 'evil.md');

      const result = canonicalPath(target, { realpath: enoentExceptFor(dir, calls) });

      expect(result).toBe(target);
      // 100 tail components + the file name = 101 components below `dir`,
      // each one failing exactly once as the walk climbs, plus the single
      // call that succeeds on `dir` itself — 102, one more than a walk that
      // skipped the leaf would need, because the walk must first try
      // `realpath` on the FULL resolved path, leaf included: a `file_path`
      // whose own leaf is a symlink (`src/link.md` -> somewhere else) only
      // resolves correctly if that leaf-inclusive probe runs, and skipping
      // it to save this one call is what let a symlinked leaf escape
      // resolution entirely (RP-247 round 3, see the symlink-leaf pin
      // below and in guard-rulebook.test.ts). Still linear in the
      // component count, never the quadratic blow-up a
      // `tail.unshift`/spread-per-level implementation would produce.
      expect(calls.count).toBeLessThanOrEqual(102);
    });

    // RP-247 round 3 — the reason (c) above allows n+2, not n+1: skipping the
    // leaf-inclusive probe to save that one call is what let a symlinked LEAF
    // escape resolution entirely. `link.md` itself is the thing that does not
    // exist as a plain file — it exists as a symlink — so a walk that starts
    // one level up, at `dirname`, and never tries `realpath` on the full
    // resolved path first, returns the lexical `link.md` path unchanged
    // instead of the real file it points at.
    it('a leaf that is itself a symlink resolves to the real target, not its own lexical name', async (ctx) => {
      skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
      const { canonicalPath } = await load();
      const target = path.join(dir, 'real.md');
      await writeFile(target, 'x');
      const link = path.join(dir, 'link.md');
      await symlink(target, link);

      expect(canonicalPath(link)).toBe(target);
    });
  });
});

/**
 * RP-246 part 1 — `realpathSync.native` keeps an admin-share UNC spelling of
 * the repository root (`\\host\X$\rest`) rather than folding it to the
 * local-drive spelling of the same directory, so `guard-rulebook.mjs`'s
 * `comparisonRoots` (seeded from `canonicalRoot`/`selectedRoot`) ends up
 * holding only UNC spellings while a payload path spelled with the local
 * drive relativises under neither one. `adminShareDriveSpelling` is the pure
 * text mapping the guard seeds an extra comparison root from — no filesystem
 * call, so it is pinned directly here rather than only through the win32-only
 * subprocess pins in guard-rulebook.test.ts.
 */
describe('adminShareDriveSpelling: the pure admin-share-UNC-to-local-drive mapping (RP-246)', () => {
  const load = () =>
    import(pathToFileURL(modulePath).href) as Promise<{
      adminShareDriveSpelling: (root: string) => string | undefined;
    }>;

  it('maps an admin-share UNC root to the local-drive spelling of the same directory', async () => {
    const { adminShareDriveSpelling } = await load();
    expect(adminShareDriveSpelling('\\\\HOST\\C$\\Users\\a\\b')).toBe('C:\\Users\\a\\b');
  });

  it('uppercases a lowercase drive letter', async () => {
    const { adminShareDriveSpelling } = await load();
    expect(adminShareDriveSpelling('\\\\host\\c$\\x')).toBe('C:\\x');
  });

  it('maps a bare admin-share root with no remainder to the drive root', async () => {
    const { adminShareDriveSpelling } = await load();
    expect(adminShareDriveSpelling('\\\\HOST\\C$')).toBe('C:\\');
  });

  it('returns undefined for a plain UNC share that is not an admin share', async () => {
    const { adminShareDriveSpelling } = await load();
    expect(adminShareDriveSpelling('\\\\host\\share\\x')).toBeUndefined();
  });

  it('returns undefined for an already-local-drive spelling', async () => {
    const { adminShareDriveSpelling } = await load();
    expect(adminShareDriveSpelling('C:\\Users\\a\\b')).toBeUndefined();
  });

  it('returns undefined for a POSIX path', async () => {
    const { adminShareDriveSpelling } = await load();
    expect(adminShareDriveSpelling('/home/a/b')).toBeUndefined();
  });
});
