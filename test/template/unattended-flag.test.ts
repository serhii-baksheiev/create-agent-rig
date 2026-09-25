import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { fifosAvailable, modeBitsDeny, needsGit, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * AR-51 — the unattended signal is a FILE, not an env variable.
 *
 * Measured: a shell `export` never reaches a PreToolUse hook — hooks get the
 * harness's environment only. So the mode a `loop` run declares has to live
 * where the kill switch lives: `~/.claude/__PROJECT_NAME__-loop-UNATTENDED`,
 * under both homes `stop-flag.mjs` checks. The token stays literal in the
 * template; every test below points `HOME` at a temp dir.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptPath = path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs');
const FLAG_NAME = '__PROJECT_NAME__-loop-UNATTENDED';

const load = () =>
  import(pathToFileURL(scriptPath).href) as Promise<{
    unattendedFlags: (env?: NodeJS.ProcessEnv) => string[];
    readUnattended: (env?: NodeJS.ProcessEnv) => {
      on: boolean;
      item?: string;
      runDir?: string;
      allow?: string[];
      unreadable?: boolean;
      why?: string;
    };
    writeUnattended: (
      flag: { item: string; runDir: string; allow: string[] },
      env?: NodeJS.ProcessEnv,
    ) => string[];
    clearUnattended: (env?: NodeJS.ProcessEnv) => string[];
  }>;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface BoundedResult extends CliResult {
  timedOut: boolean;
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

const readInChild = (home: string, timeout = 750): Promise<BoundedResult> =>
  new Promise((resolve) => {
    const program = [
      `const { readUnattended } = await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`,
      'process.stdout.write(JSON.stringify(readUnattended(process.env)));',
    ].join('\n');
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {
        env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: '' },
        timeout,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
          timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
        });
      },
    );
  });

// 🔴 Precondition, not a cleanup: a flag in EITHER home arms the mode, and the
// real home is one of them. Scoped writer cases temporarily mirror there and
// remove their exact candidate paths in `finally`; a pattern-based global
// cleanup would race with another test process using the same literal template.
// A pre-existing legacy record would make every "flag absent" case meaningless.
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
// `homedir()` honours $HOME, and the module reads the flag through it — so the
// test process's own HOME is redirected for the duration of each case.
const originalHome = process.env.HOME;
const flagPath = () => path.join(home, '.claude', FLAG_NAME);
const arm = async (content: string) => {
  await mkdir(path.dirname(flagPath()), { recursive: true });
  await writeFile(flagPath(), content);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ar51-flag-'));
  process.env.HOME = home;
});
afterEach(async () => {
  process.env.HOME = originalHome;
  await removeFixture(home);
});

/**
 * RP-263 finding, restated by code-reviewer round 2 advisory: every SCOPED
 * write (`writeUnattended`/`on` with a `CLAUDE_PROJECT_DIR`/`--root`) mirrors
 * into the REAL password-database home too — `writeUnattended`'s own doc
 * comment: "Scoped records are mirrored into both trusted homes, with the
 * password-database home first" — and that home is
 * not the per-test temp `home` the outer `afterEach` above removes. Most
 * scoped-write tests in this file already remove their exact candidate paths
 * in their own `finally`; this is the net the ones caught leaking (~100
 * `*-loop-UNATTENDED` files already sitting in the WSL `~/.claude` before this
 * PR) did not have.
 *
 * First cut was a whole-directory snapshot diff (before/after each test).
 * REJECTED after functional review (PR #328): sibling test FILES run in
 * parallel vitest workers sharing this same OS user's HOME, and arm/clear
 * their own scoped flags — which also mirror into the real home — inside
 * this test's own before/after window. A diff of the WHOLE directory listing
 * cannot tell "a sibling file's own, correctly-cleaned-up flag caught
 * mid-flight" apart from "this test's own leak"; code-reviewer reproduced
 * 5/8 failures of exactly that shape, both on this shared WSL box and inside
 * one CI run.
 *
 * So the check below is narrowed to the ONE flag a given canonical checkout
 * could itself have caused to exist — its own scoped name — and is called
 * explicitly, per test, after that test's own cleanup, rather than as a
 * blanket `afterEach`. The name is derived independently of production:
 * never by calling `unattendedFlags`/`checkoutId` (`invariants.md`, "the
 * independent-oracle invariant" — a check built from the same computation it
 * verifies cannot catch that computation under- or over-matching), but by
 * hand-copying the scheme `unattended-flag.mjs`'s own header states:
 * `<basename>-<sha256(realpath).slice(0,16)>-loop-UNATTENDED`. The two homes
 * a scoped write can reach are the two this file already establishes without
 * calling `homesOf` either: the test's own `HOME` (`home` below) and every
 * `realHomes` entry.
 */
const scopedFlagName = (canonicalRoot: string): string => {
  const hash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  return FLAG_NAME.replace('-loop-UNATTENDED', `-${hash}-loop-UNATTENDED`);
};

/**
 * `canonicalRoot` must be `realpathSync.native(root)`, captured BEFORE the
 * checkout directory is removed — nothing resolves once it is gone, and the
 * string itself is all this needs from then on. Call this AFTER a test's own
 * cleanup, to prove that cleanup (or the refusal that made a write
 * unnecessary) left nothing behind at the one location this specific
 * checkout's own write could reach. Only ENOENT reads as "gone"; any other
 * read error (permissions, …) is rethrown rather than swallowed as absent.
 */
const assertNoScopedFlagLeaked = async (
  canonicalRoot: string,
  homesToCheck: readonly string[],
): Promise<void> => {
  const name = scopedFlagName(canonicalRoot);
  for (const candidateHome of homesToCheck) {
    const candidate = path.join(candidateHome, '.claude', name);
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(
      `this test left a scoped unattended flag behind (RP-263, checked independently ` +
        `of production's own unattendedFlags): ${candidate}`,
    );
  }
};

describe('unattendedFlags: the same two-home rule as the kill switch', () => {
  it('names a -loop-UNATTENDED file under .claude in the env-derived home', async () => {
    const { unattendedFlags } = await load();
    const flags = unattendedFlags({ ...process.env, HOME: home });
    expect(flags).toContain(flagPath());
    for (const flag of flags) expect(flag.endsWith(`-loop-${'UNATTENDED'}`)).toBe(true);
  });

  it('also names the password-database home, so $HOME alone cannot hide the flag', async () => {
    const { unattendedFlags } = await load();
    const flags = unattendedFlags({ ...process.env, HOME: home });
    expect(flags).toContain(path.join(userInfo().homedir, '.claude', FLAG_NAME));
  });

  /**
   * RP-54 — the flag is scoped by a hash of CLAUDE_PROJECT_DIR, so two
   * spellings of ONE checkout must hash to one name or the guard looks for a
   * file nobody wrote and fails open.
   *
   * The spelling the loop arms with is `os.tmpdir()`-derived in tests and
   * harness-derived in a run; the spelling the generated Codex Windows hook
   * passes is `git rev-parse --show-toplevel`. On Windows those differ: a home
   * under an 8.3 short name (`SERHII~1`, and `RUNNER~1` on the GitHub runner)
   * survives `realpathSync`, which normalises separators but not short names —
   * only `realpathSync.native` expands them.
   *
   * Where a platform offers one spelling only, the two arms are equal and this
   * asserts nothing; it is sharp exactly where the defect is reachable.
   */
  it('scopes the flag by the checkout, so two spellings of one directory arm one file', async () => {
    const { unattendedFlags } = await load();
    const checkout = await mkdtemp(path.join(tmpdir(), 'ar51-spelling-'));
    try {
      const spellings = [checkout, realpathSync.native(checkout)];
      const names = spellings.map((dir) =>
        path.basename(unattendedFlags({ ...process.env, HOME: home, CLAUDE_PROJECT_DIR: dir })[0]!),
      );
      expect(names[1], `spellings: ${spellings.join(' vs ')}`).toBe(names[0]);
    } finally {
      await removeFixture(checkout);
    }
  });
});

describe('readUnattended: what the flag file says, or that it cannot be read', () => {
  const env = () => ({ ...process.env, HOME: home });

  it('fails closed when mirrored checkout-scoped candidates disagree', async (context) => {
    const checkout = path.join(home, 'mirrored-checkout');
    await mkdir(checkout, { recursive: true });
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    const { unattendedFlags, readUnattended } = await load();
    const candidates = [...new Set(unattendedFlags(scopedEnv))];
    if (candidates.length < 2) {
      context.skip();
      return;
    }

    try {
      await Promise.all(
        candidates.map((candidate) => mkdir(path.dirname(candidate), { recursive: true })),
      );
      await writeFile(
        candidates[0]!,
        JSON.stringify({ item: 'AR-FIRST', runDir: '/runs/first', allow: ['src/first/'] }),
      );
      await writeFile(
        candidates[1]!,
        JSON.stringify({ item: 'AR-SECOND', runDir: '/runs/second', allow: ['src/second/'] }),
      );

      expect(readUnattended(scopedEnv)).toMatchObject({ on: true, unreadable: true });
    } finally {
      await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
    }
  });

  it('is off when no candidate exists', async () => {
    const { readUnattended } = await load();
    expect(readUnattended(env())).toEqual({ on: false });
  });

  it('is on-but-unreadable when access to an existing flag fails at the stat boundary', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const configDir = path.dirname(flagPath());
    await arm(JSON.stringify({ item: 'AR-EACCES', runDir: '/runs/eacces', allow: [] }));

    try {
      await chmod(configDir, 0o000);
      const { readUnattended } = await load();
      expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
    } finally {
      await chmod(configDir, 0o700);
      await rm(flagPath(), { force: true });
    }
  });

  it('returns promptly and fails closed when a candidate is a FIFO', async (ctx) => {
    skipUnless(ctx, fifosAvailable().ok, fifosAvailable().reason);
    await mkdir(path.dirname(flagPath()), { recursive: true });
    execFileSync('mkfifo', [flagPath()]);

    try {
      const result = await readInChild(home);
      expect(result.timedOut, 'readUnattended blocked on a FIFO until the child was killed').toBe(
        false,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ on: true, unreadable: true });
    } finally {
      await rm(flagPath(), { force: true });
    }
  });

  it('reads item, runDir and allow from a well-formed flag', async () => {
    await arm(
      JSON.stringify({ item: 'AR-51', runDir: '/runs/1', allow: ['.claude/scripts/queue/'] }),
    );
    const { readUnattended } = await load();
    expect(readUnattended(env())).toEqual({
      on: true,
      item: 'AR-51',
      runDir: '/runs/1',
      allow: ['.claude/scripts/queue/'],
    });
  });

  it('an allow entry that widens the rulebook — a prefix of a rulebook prefix such as `.` — makes the flag unreadable', async () => {
    await arm(JSON.stringify({ item: 'AR-51', runDir: '/runs/1', allow: ['.'] }));
    const { readUnattended } = await load();
    const mode = readUnattended(env());
    expect(mode).toMatchObject({ on: true, unreadable: true });
    expect(mode.why).toMatch(/allow/);
    expect(mode.why).toMatch(/rulebook/);
  });

  it('writeUnattended refuses an allow entry that widens the rulebook, keeps one outside it, and the CLI exits 1 on the wide one', async (ctx) => {
    // RP-258 round 2: `on`/`verify` now confirm `--root` is a real git
    // checkout toplevel before doing anything else, so this fixture needs to
    // be one too, or the CLI call below refuses for THAT reason instead of
    // the widening reason this test actually pins.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const { writeUnattended, readUnattended, clearUnattended } = await load();
    expect(() =>
      writeUnattended({ item: 'AR-51', runDir: '/runs/1', allow: ['.claude/'] }, env()),
    ).toThrow(/rulebook/);
    expect(() =>
      writeUnattended({ item: 'AR-51', runDir: '/runs/1', allow: ['.claude/scripts/'] }, env()),
    ).toThrow(/rulebook/);
    // outside the rulebook is harmless — items name such paths all the time
    writeUnattended(
      { item: 'AR-51', runDir: '/runs/1', allow: ['src/', '.claude/scripts/queue/'] },
      env(),
    );
    expect(readUnattended(env())).toMatchObject({
      on: true,
      allow: ['src/', '.claude/scripts/queue/'],
    });
    clearUnattended(env());
    expect(readUnattended(env())).toEqual({ on: false });
    // RP-258: `--root` is mandatory now, so a widening-refusal case still has
    // to supply one to reach the widening check at all.
    const wideningCheckout = path.join(home, 'widening-cli-checkout');
    await mkdir(wideningCheckout, { recursive: true });
    execFileSync('git', ['init', '-q', wideningCheckout], { env: withoutGitLocation() });
    const result = await runCli(
      ['on', '--root', wideningCheckout, '--item', 'AR-51', '--allow', '.'],
      home,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/rulebook/);
    expect(readUnattended(env())).toEqual({ on: false });
  });

  /**
   * RP-61 — `.rig/revalidation.json` is the detection contract
   * `checkDetectionContract` (`preflight.mjs`) and `revalidateClaim`
   * (`claim-records.mjs`) both read: rewriting it silently changes what a
   * claim's scope fingerprint watches. It must join `RULEBOOK_PREFIXES` by
   * its EXACT file, never the whole `.rig/` directory — `.rig/claims/<id>.json`
   * is the baseline a SELECT creates for itself, and every queue merge writes
   * one, so the claims directory has to stay writable and un-widened.
   */
  it('RULEBOOK_PREFIXES protects the revalidation contract by its exact file, and leaves .rig/claims/ unlisted', async () => {
    const { RULEBOOK_PREFIXES, isWidening } = (await load()) as unknown as {
      RULEBOOK_PREFIXES: readonly string[];
      isWidening: (entry: unknown) => boolean;
    };
    expect(RULEBOOK_PREFIXES).toContain('.rig/revalidation.json');
    expect(RULEBOOK_PREFIXES).not.toContain('.rig/');
    expect(RULEBOOK_PREFIXES).not.toContain('.rig/claims/');
    // '.rig/' is a proper prefix of the now-protected '.rig/revalidation.json'
    // and would admit the whole directory, claims included — widening.
    expect(isWidening('.rig/')).toBe(true);
    // '.rig/claims/' protects nothing on its own and stays a legal allow root.
    expect(isWidening('.rig/claims/')).toBe(false);
  });

  /**
   * RP-215 — `isRulebookPath` compared with a case-sensitive `startsWith`.
   * `guard-rulebook`'s realpath rescue only re-cases a spelling through the
   * nearest EXISTING ancestor, so a checkout where `.codex/` or `.agents/`
   * has never been created yet — or any checkout on a case-sensitive
   * filesystem — hands a miscased spelling straight to this comparison. On a
   * case-insensitive filesystem (NTFS, default APFS) `.Codex/config.toml` and
   * `.codex/config.toml` are the SAME file on disk, so a guard that judges
   * the two spellings differently is judging nothing at all.
   *
   * Independent oracle: every case-variant spelling below is a literal
   * string written in this test, not RULEBOOK_PREFIXES mapped through
   * `toUpperCase`/`toLowerCase` — a test that derived its expectation from
   * the same case-folding the fix would add could not detect an
   * under-folding in that fix (`invariants.md`, "the independent-oracle
   * invariant").
   */
  describe('isRulebookPath: case-insensitive, so a miscased spelling is judged the same as the canonical one (RP-215)', () => {
    it.each([
      ['.Codex/config.toml', '.codex/'],
      ['.AGENTS/x.md', '.agents/'],
      ['Claude.md', 'CLAUDE.md'],
      ['agents.MD', 'AGENTS.md'],
      ['.CLAUDE/rules/x.md', '.claude/rules/'],
      ['.claude/HOOKS/x.mjs', '.claude/hooks/'],
      ['.Rig/Revalidation.json', '.rig/revalidation.json'],
      ['.claude/Queue.board', '.claude/queue.board'],
    ])('is true for %s — a case variant of the %s entry', async (rel) => {
      const { isRulebookPath } = (await load()) as unknown as {
        isRulebookPath: (rel: string) => boolean;
      };
      expect(isRulebookPath(rel)).toBe(true);
    });

    it.each([
      'src/a.txt',
      // NOT `CLAUDE.md.bak` on its own: `CLAUDE.md` is an exact entry compared
      // with `startsWith`, so `'CLAUDE.md.bak'.startsWith('CLAUDE.md')` is
      // already `true` on master today — asserting `false` there would fight
      // current, unrelated semantics rather than this fix. This path stays
      // false for a different reason: the leading `docs/` segment means the
      // WHOLE relative path never starts with the prefix, case-folded or not.
      'docs/claude.md.bak',
      // Guards against a looser fix that treats the prefix as a substring
      // anywhere in the path rather than a true prefix of the whole string.
      'srcx/.codex',
      'x/.codex/config.toml',
    ])('is false for the ordinary path %s', async (rel) => {
      const { isRulebookPath } = (await load()) as unknown as {
        isRulebookPath: (rel: string) => boolean;
      };
      expect(isRulebookPath(rel)).toBe(false);
    });
  });

  /**
   * RP-243 — `canonicalRulebookPath`/`isRulebookPath` compare the literal
   * spelling of a path component. Win32 strips a TRAILING dot or space from
   * each path component when it actually creates the file — `cmd /c "echo x
   * > .codex.\config.toml"` lands as `.codex\config.toml` on disk — so a
   * payload spelled `.codex./config.toml` is, on Windows, the exact same file
   * as the guarded `.codex/config.toml`, while this comparison sees two
   * different strings and lets the rulebook edit through.
   *
   * Independent oracle: every spelling below is written out literally in this
   * test, not derived by appending a dot/space to `RULEBOOK_PREFIXES` through
   * a helper the fix would also supply (`invariants.md`, "the independent-oracle
   * invariant").
   */
  describe('isRulebookPath: a trailing dot or space on a path component is judged the same as the component with it stripped (RP-243)', () => {
    it.each([
      // trailing dot/space on the segment that names the guarded directory itself
      ['.codex./config.toml', '.codex/'],
      ['.codex /config.toml', '.codex/'],
      ['.claude./hooks/x.mjs', '.claude/hooks/'],
      // trailing dot/space on a segment INSIDE the guarded directory
      ['.claude/hooks./x.mjs', '.claude/hooks/'],
      ['.claude/hooks /x.mjs', '.claude/hooks/'],
      // trailing dot/space on a single-segment file entry
      ['CLAUDE.md.', 'CLAUDE.md'],
      ['AGENTS.md ', 'AGENTS.md'],
      // combining case-folding (RP-215) with a trailing dot AND a trailing
      // space on two different components of the same path (RP-243)
      ['.Codex. /config.toml', '.codex/'],
    ])('is true for %s — a trailing-dot/space variant of the %s entry', async (rel) => {
      const { isRulebookPath } = (await load()) as unknown as {
        isRulebookPath: (rel: string) => boolean;
      };
      expect(isRulebookPath(rel)).toBe(true);
    });

    it.each([
      // ordinary paths outside the rulebook stay outside it, trailing
      // dot/space and all — this fix narrows nothing it must not narrow.
      'src/a.txt.',
      'src /a.txt',
      'docs/notes. /x.md',
    ])(
      'is false for the ordinary path %s, unaffected by the trailing-dot/space fix',
      async (rel) => {
        const { isRulebookPath } = (await load()) as unknown as {
          isRulebookPath: (rel: string) => boolean;
        };
        expect(isRulebookPath(rel)).toBe(false);
      },
    );
  });

  /**
   * code-reviewer round 2 (8c27054), BLOCKER — `stripTrailingDotsAndSpaces`
   * strips a trailing run of `.`/` ` with `/[. ]+$/`, anchored at the end
   * but not at the start. Without a start anchor the engine retries the
   * match at every offset inside a long run of matching characters before
   * backtracking off it one character at a time, which is quadratic in the
   * length of that run — independent of whether the component sits anywhere
   * near a matched rulebook prefix. `invariants.md`, "a fail-open guard must
   * do provably bounded work": this is ordinary `PreToolUse` traffic, not an
   * adversary, and normal traffic must never make the guard block for
   * minutes.
   *
   * Independent oracle: the expected answer — `false`, no segment of this
   * path names a `RULEBOOK_PREFIXES` entry — is asserted directly, not
   * derived from the function's own normalisation.
   */
  describe('isRulebookPath: bounded work on a component with a huge run of dots/spaces (RP-243 round 2)', () => {
    it('returns promptly and gives the correct answer for a ~1MB pathological component', async () => {
      // ~1MB, fed over stdin rather than embedded in the child's argv: a
      // command-line argument this size overflows the OS argument-list limit
      // (`spawn E2BIG`) well before Node even starts, which is a harness
      // limit unrelated to the guard under test.
      const pathological = `.claude/${'.'.repeat(500_000)}a${' .'.repeat(250_000)}/x.mjs`;
      const bound = 3000;
      const program = [
        `const { isRulebookPath } = await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`,
        "let data = '';",
        "process.stdin.setEncoding('utf8');",
        'for await (const chunk of process.stdin) data += chunk;',
        'process.stdout.write(String(isRulebookPath(data)));',
      ].join('\n');
      const start = Date.now();
      const result: BoundedResult = await new Promise((resolve, reject) => {
        const child = execFile(
          process.execPath,
          ['--input-type=module', '--eval', program],
          { timeout: bound },
          (error, stdout, stderr) => {
            resolve({
              code: error ? ((error as { code?: number }).code ?? 1) : 0,
              stdout,
              stderr,
              timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
            });
          },
        );
        if (!child.stdin) return reject(new Error('no stdin'));
        child.stdin.write(pathological);
        child.stdin.end();
      });
      expect(
        result.timedOut,
        'isRulebookPath blocked for the full timeout on a component with a long dot/space run',
      ).toBe(false);
      expect(
        Date.now() - start,
        'isRulebookPath took too long on a pathological component',
      ).toBeLessThan(bound);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe('false');
    });
  });

  /**
   * code-reviewer round 2 (8c27054), advisory B — normalisation must apply
   * only to the components the matched rulebook prefix itself spans; a
   * component beyond the matched prefix keeps its literal spelling, because
   * on POSIX (where no filesystem strips a trailing dot at create time) it
   * names a genuinely different directory. `.claude/hooks./a./b.mjs` has two
   * trailing-dotted components: `hooks.`, which IS the prefix-naming
   * segment and folds to the canonical `hooks`, and `a.`, which sits inside
   * the already-matched prefix and must be left exactly as spelled.
   */
  it('canonicalRulebookPath folds only the matched-prefix component and keeps a literal trailing dot beyond it', async () => {
    const { canonicalRulebookPath } = (await load()) as unknown as {
      canonicalRulebookPath: (rel: string) => string | undefined;
    };
    expect(canonicalRulebookPath('.claude/hooks./a./b.mjs')).toBe('.claude/hooks/a./b.mjs');
  });

  /**
   * code-reviewer round 3 (9435b93), BLOCKER — `canonicalRulebookPath` now
   * requires `components.length === segmentCount` for a FILE-type entry
   * (`CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.claude/queue.json`,
   * `.claude/queue.board`, `.claude/.rig-manifest.json`,
   * `.claude/doctor-exemptions.json`, `.rig/revalidation.json`), so a path
   * that CONTINUES past such an entry with a `/` and more components no
   * longer matches at all — `.claude/queue.board/x` reads as an ordinary,
   * unguarded path. Master (0d5be9c) matched a file entry with a
   * whole-string, case-insensitive `startsWith`, so any path beginning with
   * the guarded file's name — trailing separator or not — was, and must
   * stay, a rulebook path; RP-215 folding and RP-243 trailing-dot/space
   * stripping on the spanned components are additions on top of that
   * behaviour, never a narrowing of it.
   *
   * Independent oracle: every literal below is typed by hand, not derived
   * from `RULEBOOK_PREFIXES` or from re-running this module's own
   * `canonicalRulebookPath`/`isRulebookPath` — checked instead against
   * master's one-line `folded.startsWith(foldedPrefix)`, read directly from
   * `git show 0d5be9c:templates/agent-os/universal/.claude/scripts/unattended-flag.mjs`,
   * on each of these same inputs (`invariants.md`, "the independent-oracle
   * invariant").
   */
  describe('isRulebookPath: a path continuing past a matched FILE entry is still a rulebook path (round 3 regression)', () => {
    it.each([
      '.claude/queue.board/x',
      '.rig/revalidation.json/x',
      '.claude/settings.json/x',
      'CLAUDE.md/x',
      'AGENTS.md/sub/y.md',
      '.claude/.rig-manifest.json/z',
      '.claude/doctor-exemptions.json/z',
      '.claude/queue.json/z',
      // folded (RP-215) + trailing-dot/space (RP-243) twins on the same
      // ground — master matches these too, because its whole-string
      // startsWith never inspected the boundary at all.
      '.Rig/Revalidation.json./x',
      'CLAUDE.md /x',
    ])('is true for %s — continuing past a file entry does not leave the rulebook', async (rel) => {
      const { isRulebookPath } = (await load()) as unknown as {
        isRulebookPath: (rel: string) => boolean;
      };
      expect(isRulebookPath(rel)).toBe(true);
    });

    it('canonicalRulebookPath of .claude/queue.board/x starts with the canonical .claude/queue.board', async () => {
      const { canonicalRulebookPath } = (await load()) as unknown as {
        canonicalRulebookPath: (rel: string) => string | undefined;
      };
      const canonical = canonicalRulebookPath('.claude/queue.board/x');
      expect(canonical).toBeDefined();
      expect(canonical!.startsWith('.claude/queue.board')).toBe(true);
    });
  });

  /**
   * RP-215 — the fix has to land at the single shared comparison point
   * without changing `isWidening`'s answers. Pinned literally, entry by
   * entry, as measured on master (8876147) before this fix — not derived by
   * mapping RULEBOOK_PREFIXES through a predicate, which would just be this
   * fix's own logic checking itself.
   */
  it("isWidening's answers are unchanged for every current RULEBOOK_PREFIXES entry, and for src/ (RP-215 must not touch this)", async () => {
    const { RULEBOOK_PREFIXES, isWidening } = (await load()) as unknown as {
      RULEBOOK_PREFIXES: readonly string[];
      isWidening: (entry: unknown) => boolean;
    };
    const pinnedTodayOnMaster: ReadonlyArray<[string, boolean]> = [
      ['.agents/', true],
      ['.claude/.rig-manifest.json', false],
      ['.claude/doctor-exemptions.json', false],
      ['.claude/agents/', false],
      // RP-256 slice 1: the nested Rig shim a CLAUDE.md-coexistence install
      // writes at `.claude/CLAUDE.md` — a file entry, same shape as root
      // `CLAUDE.md` below, so an allow-listed exact match does not widen
      // anything either.
      ['.claude/CLAUDE.md', false],
      ['.claude/hooks/', false],
      ['.claude/settings.json', false],
      ['.claude/queue.json', false],
      ['.claude/queue.board', false],
      ['.claude/scripts/', true],
      ['.claude/rules/', false],
      ['.claude/skills/', false],
      ['.codex/', true],
      ['AGENTS.md', false],
      ['CLAUDE.md', false],
      ['.rig/revalidation.json', false],
    ];
    // Exhaustiveness: this pin is only meaningful while it still covers every
    // entry the module declares today — a future entry added here with no
    // matching row below must fail loudly rather than pass unchecked.
    expect(
      [...RULEBOOK_PREFIXES].sort(),
      'RULEBOOK_PREFIXES has an entry this pin does not cover',
    ).toEqual(pinnedTodayOnMaster.map(([prefix]) => prefix).sort());
    for (const [prefix, expected] of pinnedTodayOnMaster) {
      expect(isWidening(prefix), prefix).toBe(expected);
    }
    expect(isWidening('src/')).toBe(false);
  });

  /**
   * RP-215 round 2 — `isWidening` compares an `--allow` entry against
   * `RULEBOOK_PREFIXES` (and its own three hard-coded protected roots) with
   * plain, case-sensitive string equality and `startsWith`. `canonicalRulebookPath`
   * was made case-insensitive for the PATH side of this fix; the ALLOW-LIST
   * side never was, so a miscased entry that means exactly the same directory
   * on a case-insensitive filesystem (NTFS, default APFS) — `.Claude/`,
   * `.CODEX/`, `.AGENTS/`, `.claude/Scripts/`, `.CLAUDE/` — is judged as
   * ordinary, harmless, outside-the-rulebook text and is ACCEPTED where its
   * canonical spelling is refused. That is the opposite of narrowing: the
   * writer would arm a flag whose allow-list widens the rulebook exactly as
   * much as `.claude/`, `.claude/scripts/`, `.codex/` or `.agents/` do, while
   * believing it has refused every widening form.
   *
   * Independent oracle: every literal below is typed as its own string, not
   * derived by mapping the canonical entries through `toUpperCase`/
   * `toLowerCase` — a test built from the same case-folding the fix would add
   * could not detect an under-folding in that fix (`invariants.md`, "the
   * independent-oracle invariant").
   */
  describe('isWidening: a miscased allow entry must be refused exactly like its canonical spelling (RP-215 round 2)', () => {
    it.each([
      // exact protected roots, miscased
      '.Claude/',
      '.CODEX/',
      '.AGENTS/',
      '.CLAUDE/',
      // a proper prefix of a rulebook entry, miscased
      '.claude/Scripts/',
    ])('is true for the miscased entry %s, same as its canonical spelling', async (entry) => {
      const { isWidening } = (await load()) as unknown as {
        isWidening: (entry: unknown) => boolean;
      };
      expect(isWidening(entry)).toBe(true);
    });

    it.each([
      // outside the rulebook entirely — case is irrelevant, and stays so
      'src/',
      'SRC/',
      // narrower than a rulebook prefix, not a widening of it — confirmed
      // non-widening in its canonical spelling by the pin above, and its
      // miscased twin must land on the SAME answer
      '.claude/skills/loop/',
      '.claude/Skills/loop/',
    ])(
      'is false for %s — narrower than, or outside, the rulebook, case included',
      async (entry) => {
        const { isWidening } = (await load()) as unknown as {
          isWidening: (entry: unknown) => boolean;
        };
        expect(isWidening(entry)).toBe(false);
      },
    );

    it('the CLI refuses `on --allow .Claude/` exactly as it refuses `on --allow .claude/`, and writes no flag', async (ctx) => {
      // RP-258: `--root` is mandatory now — supply one so this stays a test
      // of the widening refusal, not of the (separately tested) root refusal.
      // RP-258 round 2: and it must be a real git checkout toplevel, or the
      // root check refuses first, for the wrong reason.
      skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
      const miscasedCheckout = path.join(home, 'miscased-cli-checkout');
      await mkdir(miscasedCheckout, { recursive: true });
      execFileSync('git', ['init', '-q', miscasedCheckout], { env: withoutGitLocation() });
      const miscased = await runCli(
        ['on', '--root', miscasedCheckout, '--item', 'RP-215', '--allow', '.Claude/'],
        home,
      );
      expect(miscased.code).toBe(1);
      expect(miscased.stderr).toMatch(/rulebook/);
      expect(existsSync(flagPath())).toBe(false);

      const canonical = await runCli(
        ['on', '--root', miscasedCheckout, '--item', 'RP-215', '--allow', '.claude/'],
        home,
      );
      expect(canonical.code).toBe(1);
      expect(canonical.stderr).toMatch(/rulebook/);
      expect(existsSync(flagPath())).toBe(false);
    });
  });

  it('writeUnattended refuses .rig/ as a widening allow entry but accepts .rig/claims/, which a SELECT must keep writable', async () => {
    const { writeUnattended, readUnattended, clearUnattended } = await load();
    expect(() =>
      writeUnattended({ item: 'RP-61', runDir: '/runs/1', allow: ['.rig/'] }, env()),
    ).toThrow(/rulebook/);
    writeUnattended({ item: 'RP-61', runDir: '/runs/1', allow: ['.rig/claims/'] }, env());
    expect(readUnattended(env())).toMatchObject({ on: true, allow: ['.rig/claims/'] });
    clearUnattended(env());
    expect(readUnattended(env())).toEqual({ on: false });
  });

  it('trims whitespace around allow entries', async () => {
    await arm(
      JSON.stringify({
        item: 'AR-51',
        runDir: '/r',
        allow: ['  .claude/rules/ ', '\tCLAUDE.md\n'],
      }),
    );
    const { readUnattended } = await load();
    expect(readUnattended(env()).allow).toEqual(['.claude/rules/', 'CLAUDE.md']);
  });

  it('is on-but-unreadable when the file is not JSON', async () => {
    await arm('{ not json');
    const { readUnattended } = await load();
    const result = readUnattended(env());
    expect(result.on).toBe(true);
    expect(result.unreadable).toBe(true);
    expect(typeof result.why).toBe('string');
    expect(result.why!.length).toBeGreaterThan(0);
  });

  it('is unreadable when the JSON is not an object', async () => {
    await arm('["AR-51"]');
    const { readUnattended } = await load();
    expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
  });

  it('is unreadable when allow is not an array of strings', async () => {
    const { readUnattended } = await load();
    for (const allow of ['.claude/', [1, 2], [{ p: '.claude/' }], null]) {
      await arm(JSON.stringify({ item: 'AR-51', runDir: '/r', allow }));
      expect(readUnattended(env()), JSON.stringify(allow)).toMatchObject({
        on: true,
        unreadable: true,
      });
    }
  });

  it('is unreadable when allow carries more than 64 entries (bounded work)', async () => {
    const allow = Array.from({ length: 65 }, (_, i) => `.claude/p${i}/`);
    await arm(JSON.stringify({ item: 'AR-51', runDir: '/r', allow }));
    const { readUnattended } = await load();
    expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
  });

  it('is unreadable when the file is larger than 64 KiB (it reads at most that much)', async () => {
    const padding = ' '.repeat(70 * 1024);
    await arm(`{"item":"AR-51","runDir":"/r","allow":[]${padding}}`);
    const { readUnattended } = await load();
    expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
  });

  it('never accepts a legacy machine-wide allow-list as scoped authorization', async () => {
    await arm(JSON.stringify({ item: 'OLD-A', runDir: '/runs/old-a', allow: ['.claude/'] }));
    const checkout = path.join(home, 'scoped-checkout');
    await mkdir(checkout, { recursive: true });
    const { readUnattended } = await load();
    const mode = readUnattended({
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: checkout,
    });
    expect(mode).toMatchObject({ on: true, unreadable: true });
    expect(mode.why).toMatch(/legacy|migrat/i);
    expect(mode.allow).toBeUndefined();
  });
});

describe('writeUnattended / clearUnattended: the file the run arms and disarms', () => {
  const env = () => ({ ...process.env, HOME: home });

  it('keeps concurrent worktrees separate and clears only the current checkout record', async () => {
    const { writeUnattended, clearUnattended, readUnattended, unattendedFlags } = await load();
    const checkoutA = path.join(home, 'checkout-a');
    const checkoutB = path.join(home, 'checkout-b');
    await mkdir(checkoutA, { recursive: true });
    await mkdir(checkoutB, { recursive: true });
    // Captured now, while the directories still exist — used only after
    // cleanup, to verify it independently of the production candidates below.
    const canonicalA = realpathSync.native(checkoutA);
    const canonicalB = realpathSync.native(checkoutB);
    const envA = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutA };
    const envB = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutB };

    try {
      writeUnattended({ item: 'AR-A', runDir: '/runs/a', allow: [] }, envA);
      writeUnattended({ item: 'AR-B', runDir: '/runs/b', allow: [] }, envB);

      expect(readUnattended(envA)).toMatchObject({ on: true, item: 'AR-A', runDir: '/runs/a' });
      expect(readUnattended(envB)).toMatchObject({ on: true, item: 'AR-B', runDir: '/runs/b' });

      clearUnattended(envA);
      expect(readUnattended(envA)).toEqual({ on: false });
      expect(readUnattended(envB)).toMatchObject({ on: true, item: 'AR-B', runDir: '/runs/b' });
    } finally {
      const candidates = [...new Set([...unattendedFlags(envA), ...unattendedFlags(envB)])];
      await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
    }
    await assertNoScopedFlagLeaked(canonicalA, [home, ...realHomes]);
    await assertNoScopedFlagLeaked(canonicalB, [home, ...realHomes]);
  });

  it('writes the first candidate, creating <home>/.claude/, and returns the path', async () => {
    const { writeUnattended, readUnattended } = await load();
    const touched = writeUnattended({ item: 'AR-51', runDir: '/r', allow: ['CLAUDE.md'] }, env());
    expect(touched).toEqual([flagPath()]);
    expect(JSON.parse(await readFile(flagPath(), 'utf8'))).toEqual({
      item: 'AR-51',
      runDir: '/r',
      allow: ['CLAUDE.md'],
    });
    expect(readUnattended(env()).on).toBe(true);
  });

  it('clears every candidate that exists and returns the paths removed', async () => {
    const { writeUnattended, clearUnattended, readUnattended } = await load();
    writeUnattended({ item: 'AR-51', runDir: '/r', allow: [] }, env());
    expect(clearUnattended(env())).toEqual([flagPath()]);
    expect(existsSync(flagPath())).toBe(false);
    expect(readUnattended(env())).toEqual({ on: false });
    // idempotent: nothing left to remove
    expect(clearUnattended(env())).toEqual([]);
  });

  it('throws instead of reporting success when access prevents removing an existing flag', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const configDir = path.dirname(flagPath());
    await arm(JSON.stringify({ item: 'AR-EACCES', runDir: '/runs/eacces', allow: [] }));

    try {
      await chmod(configDir, 0o000);
      try {
        const { clearUnattended } = await load();
        expect(() => clearUnattended(env())).toThrow(/failed|remove|EACCES/i);
      } finally {
        await chmod(configDir, 0o700);
      }
      expect(existsSync(flagPath()), 'the inaccessible flag must survive the failed cleanup').toBe(
        true,
      );
    } finally {
      await chmod(configDir, 0o700).catch(() => {});
      await rm(flagPath(), { force: true });
    }
  });

  it('safely clears a legacy flag only when its run directory belongs to this checkout', async () => {
    const { clearUnattended, readUnattended } = await load();
    const checkout = path.join(home, 'legacy-owner');
    const runDir = path.join(checkout, '.claude', 'runs', 'old');
    await mkdir(runDir, { recursive: true });
    await arm(JSON.stringify({ item: 'OLD-A', runDir, allow: [] }));
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };

    expect(clearUnattended(scopedEnv)).toEqual([flagPath()]);
    expect(readUnattended(scopedEnv)).toEqual({ on: false });
  });
});

describe('the CLI the loop skill calls', () => {
  it('exits nonzero when off --root leaves a checkout-scoped candidate behind', async () => {
    const checkout = path.join(home, 'unremovable-checkout');
    await mkdir(checkout, { recursive: true });
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    const { unattendedFlags } = await load();
    const candidate = unattendedFlags(scopedEnv)[0]!;
    await mkdir(candidate, { recursive: true });

    try {
      const result = await runCli(['off', '--root', checkout], home);
      expect(existsSync(candidate)).toBe(true);
      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(/remove|remain|failed/i);
    } finally {
      await removeFixture(candidate);
    }
  });

  it('exits nonzero and leaves an unreadable owned legacy flag in place', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const checkout = path.join(home, 'legacy-owner-unreadable');
    const runDir = path.join(checkout, '.claude', 'runs', 'old');
    await mkdir(runDir, { recursive: true });
    await arm(JSON.stringify({ item: 'OLD-UNREADABLE', runDir, allow: [] }));
    await chmod(path.dirname(flagPath()), 0o700);

    try {
      await chmod(flagPath(), 0o000);
      const result = await runCli(['off', '--root', checkout], home);
      expect(existsSync(flagPath()), 'an unreadable legacy record must not be removed').toBe(true);
      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(/legacy|unreadable|cannot be read|inspect/i);
    } finally {
      await chmod(flagPath(), 0o600).catch(() => {});
      await rm(flagPath(), { force: true });
    }
  });

  it('removes only the explicitly selected legacy record and leaves another home untouched', async () => {
    const selectedHome = await mkdtemp(path.join(tmpdir(), 'ar51-selected-home-'));
    try {
      const selected = path.join(selectedHome, '.claude', FLAG_NAME);
      await mkdir(path.dirname(selected), { recursive: true });
      await writeFile(
        selected,
        JSON.stringify({ item: 'OLD-SELECTED', runDir: '/runs/a', allow: [] }),
      );
      await arm(JSON.stringify({ item: 'OLD-UNRELATED', runDir: '/runs/b', allow: [] }));

      const legacy = await runCli(['off', '--legacy', '--path', selected], home);
      expect(legacy.code, legacy.stderr).toBe(0);
      expect(existsSync(selected)).toBe(false);
      expect(existsSync(flagPath())).toBe(true);
    } finally {
      await removeFixture(selectedHome);
    }
  });

  it('scopes on/off to --root so concurrent checkout CLIs do not share a flag', async (ctx) => {
    // RP-258 round 2: both roots must be real git checkout toplevels, or the
    // new root check refuses before either `on` call reaches its own point.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const { readUnattended, unattendedFlags } = await load();
    const checkoutA = path.join(home, 'cli-checkout-a');
    const checkoutB = path.join(home, 'cli-checkout-b');
    await mkdir(checkoutA, { recursive: true });
    await mkdir(checkoutB, { recursive: true });
    execFileSync('git', ['init', '-q', checkoutA], { env: withoutGitLocation() });
    execFileSync('git', ['init', '-q', checkoutB], { env: withoutGitLocation() });
    const canonicalA = realpathSync.native(checkoutA);
    const canonicalB = realpathSync.native(checkoutB);

    const envA = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutA };
    const envB = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutB };
    try {
      expect((await runCli(['on', '--root', checkoutA, '--item', 'AR-A'], home)).code).toBe(0);
      expect((await runCli(['on', '--root', checkoutB, '--item', 'AR-B'], home)).code).toBe(0);
      expect(readUnattended(envA)).toMatchObject({ item: 'AR-A' });
      expect(readUnattended(envB)).toMatchObject({ item: 'AR-B' });

      expect((await runCli(['off', '--root', checkoutA], home)).code).toBe(0);
      expect(readUnattended(envA)).toEqual({ on: false });
      expect(readUnattended(envB)).toMatchObject({ item: 'AR-B' });
    } finally {
      const candidates = [...new Set([...unattendedFlags(envA), ...unattendedFlags(envB)])];
      await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
    }
    // checkoutA was `off`'d inside the test above; checkoutB only by `finally`.
    await assertNoScopedFlagLeaked(canonicalA, [home, ...realHomes]);
    await assertNoScopedFlagLeaked(canonicalB, [home, ...realHomes]);
  });

  it('`on --root … --item … --run-dir … --allow …` writes the scoped flag and prints its path', async (ctx) => {
    // RP-258: `--root` is mandatory now — the happy path supplies it and
    // reads back the checkout-scoped path, not the unscoped legacy one.
    // RP-258 round 2: and it must be a real git checkout toplevel.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    //
    // 🔴 Precondition, not a cleanup, same as "scopes on/off to --root" above:
    // a SCOPED write mirrors into the real password-database home too (the
    // same two-home rule the kill switch uses), so this removes its exact
    // candidate paths in `finally` rather than leaving them for a
    // pattern-based sweep that would race another test process.
    const { unattendedFlags } = await load();
    const checkout = path.join(home, 'on-happy-path-checkout');
    await mkdir(checkout, { recursive: true });
    // RP-258 round 2: a real git checkout toplevel, or the new root check
    // refuses before the happy path this test pins is ever reached.
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    try {
      const result = await runCli(
        [
          'on',
          '--root',
          checkout,
          '--item',
          'AR-51',
          '--run-dir',
          '/runs/1',
          '--allow',
          '.claude/scripts/queue/',
          '.claude/skills/loop/',
        ],
        home,
      );
      expect(result.code, result.stderr).toBe(0);
      // code-reviewer round 1 advisory (independent-oracle invariant,
      // `invariants.md`): the expected path used to come from production's
      // own `unattendedFlags`, so a bug in that function's scoping scheme
      // could never be caught by this assertion — the test and the code
      // would agree by construction. Instead this re-derives the scheme
      // `unattended-flag.mjs` documents on `scopedBasename`/`checkoutId`
      // (sha256 of the realpath, first 16 hex chars, spliced into the
      // basename) by hand, and the home-mirroring order from `homesOf`'s own
      // doc comment ("the env-derived home is first" — `stop-flag.mjs`) —
      // and `writeUnattended` mirrors with the password-database home
      // written FIRST, so the printed path is the LAST of these two homes,
      // exactly as before, just computed independently of `unattendedFlags`.
      const canonicalCheckout = realpathSync.native(checkout);
      const scopedId = createHash('sha256').update(canonicalCheckout).digest('hex').slice(0, 16);
      const scopedBasename = FLAG_NAME.replace('-loop-UNATTENDED', `-${scopedId}-loop-UNATTENDED`);
      let passwordHome: string | null = null;
      try {
        passwordHome = userInfo().homedir;
      } catch {
        // no password entry — only the env-derived home exists
      }
      const homes = [...new Set([home, passwordHome].filter((h): h is string => h !== null))];
      const writtenFirst = homes.length > 1 ? homes[1]! : homes[0]!;
      const printedPath = path.join(writtenFirst, '.claude', scopedBasename);
      expect(result.stdout).toContain(printedPath);
      expect(JSON.parse(await readFile(printedPath, 'utf8'))).toEqual({
        item: 'AR-51',
        runDir: '/runs/1',
        allow: ['.claude/scripts/queue/', '.claude/skills/loop/'],
      });
    } finally {
      await Promise.all(
        unattendedFlags(scopedEnv).map((candidate) => rm(candidate, { force: true })),
      );
    }
    await assertNoScopedFlagLeaked(realpathSync.native(checkout), [home, ...realHomes]);
  });

  it('`on` without --root exits 1, names the missing --root, and writes nothing (RP-258)', async () => {
    // Evidence (functional review 2026-09-24): `on --item X` without `--root`
    // wrote a flag — safe on its own, but `verify` then read it back as
    // armed while `guard-rulebook` (always scoped by the harness) treated
    // the very same file as unreadable legacy machine-wide state. Refusing
    // here, before anything is written, is what makes that contradiction
    // unreachable.
    const result = await runCli(['on', '--item', 'RP-258', '--run-dir', '/r'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--root/);
    expect(existsSync(flagPath())).toBe(false);
  });

  it('`off` removes the flag', async () => {
    await arm(JSON.stringify({ item: 'AR-51', runDir: '/r', allow: [] }));
    const result = await runCli(['off'], home);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(flagPath())).toBe(false);
  });

  it('`on` without --item exits 1 with a message and writes nothing', async () => {
    const result = await runCli(['on', '--run-dir', '/r'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--item/);
    expect(existsSync(flagPath())).toBe(false);
  });

  it('an unknown word exits 1', async () => {
    const result = await runCli(['sideways'], home);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

/**
 * RP-103 — a widening `--allow` makes `writeUnattended` throw BEFORE anything
 * lands on disk, and the `on` CLI branch turns that throw into `exit 1` on
 * stderr. That is correct for the write itself, but the caller is the `loop`
 * skill, which does not read the exit code (SKILL.md line ~151) — so the run
 * carries on with NO flag on disk, and `guard-rulebook` reads "no flag" as
 * "attended session" and does nothing for the whole run. The failure is loud
 * at arming and then completely silent for everything after it.
 *
 * `verify` is the read-back the loop calls right after `on`, so a run that
 * kept going past a failed arm gets caught immediately instead of relying on
 * a caller that already ignored one exit code to notice a second one.
 *
 * Shape decision: "the item asked about" travels as `--item <id>`, the exact
 * flag `on` already takes (line ~402 above) — not a new flag name, and not an
 * implicit "whatever `on` last wrote". The loop already has the item id in
 * hand at arm time (it is what it just passed to `on --item`), so asking it
 * to repeat that one flag is the smallest addition; inventing a second
 * vocabulary for "which item" would just be one more place the two calls
 * could drift apart. A flag on disk for a DIFFERENT item is exactly the
 * shape a stale record from a previous run leaves behind, and that must not
 * silently vouch for this one.
 */
describe('verify: RP-103 — the read-back the loop calls immediately after arming', () => {
  // ⚠ These two names are kept on ONE line each, deliberately. The `loop`
  // skill cites them, and `evidence-pointers.test.ts` resolves a citation by
  // looking for the quoted name in this file — a name assembled from
  // concatenated string literals is not found, so the citation reads as dead
  // even while the test passes. Measured: it reported exactly that.
  it('refuses when no flag is armed, naming the item and the unguarded rulebook', async (ctx) => {
    // RP-258: `--root` is mandatory now (for `verify` too) — supply a
    // checkout with no flag armed at all, so this stays a test of the
    // "nothing armed" refusal rather than the (separately tested) missing
    // `--root` refusal.
    // RP-258 round 2: and it must be a real git checkout toplevel, or the
    // root check refuses first, for the wrong reason.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = path.join(home, 'verify-none-armed-checkout');
    await mkdir(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const result = await runCli(['verify', '--root', checkout, '--item', 'AR-103'], home);
    expect(result.code).not.toBe(0);
    // Not just "a file is missing" — the reader needs the CONSEQUENCE, or
    // this refusal reads exactly like every other "no such file" message
    // and the operator has no reason to treat it differently.
    expect(result.stderr).toMatch(/AR-103/);
    expect(result.stderr).toMatch(/rulebook/i);
    expect(result.stderr).toMatch(
      /unguarded|no guard|not (?:being )?guarded|not (?:being )?enforced/i,
    );
  });

  it('refuses when the armed flag names a different item, naming both', async (ctx) => {
    // RP-258: armed through the CLI, scoped to a real `--root`, so this
    // exercises the "different item, correctly scoped" case rather than the
    // unscoped legacy fallback (covered separately below). A scoped `on`
    // mirrors into the real password-database home too, same as every other
    // scoped-write case in this file — removed in `finally`.
    // RP-258 round 2: and `--root` must be a real git checkout toplevel.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = path.join(home, 'verify-item-mismatch-checkout');
    await mkdir(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const canonicalCheckout = realpathSync.native(checkout);
    const { unattendedFlags } = await load();
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    try {
      const onResult = await runCli(
        ['on', '--root', checkout, '--item', 'AR-OTHER', '--run-dir', '/runs/other'],
        home,
      );
      expect(onResult.code, onResult.stderr).toBe(0);
      const result = await runCli(['verify', '--root', checkout, '--item', 'AR-103'], home);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/AR-103/);
      expect(result.stderr).toMatch(/AR-OTHER/);
    } finally {
      await Promise.all(
        unattendedFlags(scopedEnv).map((candidate) => rm(candidate, { force: true })),
      );
    }
    await assertNoScopedFlagLeaked(canonicalCheckout, [home, ...realHomes]);
  });

  it('`verify` without --root cannot report armed even when an unscoped flag on disk matches the item (RP-258 evidence)', async () => {
    // Evidence (functional review 2026-09-24): `verify --item X` without
    // `--root` read back an unscoped flag written by the equally-rootless
    // `on` and reported it armed — while `guard-rulebook`, always scoped by
    // the harness, would have refused the very same file as unreadable.
    await arm(JSON.stringify({ item: 'RP-258', runDir: '/runs/1', allow: [] }));
    const result = await runCli(['verify', '--item', 'RP-258'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--root/);
  });

  it('verify reports a mis-scoped (unscoped) flag as not armed, naming the root-scope problem, not "legacy machine-wide" (RP-258)', async () => {
    await arm(JSON.stringify({ item: 'RP-258', runDir: '/runs/1', allow: [] }));
    const checkout = path.join(home, 'verify-mis-scoped-checkout');
    await mkdir(checkout, { recursive: true });
    const result = await runCli(['verify', '--root', checkout, '--item', 'RP-258'], home);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toMatch(/legacy machine-wide/i);
    expect(result.stderr).toMatch(/root/i);
  });

  // The passing direction, so the check above cannot be satisfied by a
  // `verify` that simply always exits nonzero.
  it('exits 0 when a flag armed with a narrow allow-list matches the item asked about', async (ctx) => {
    // RP-258 round 2: `--root` must be a real git checkout toplevel.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = path.join(home, 'verify-success-checkout');
    await mkdir(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const canonicalCheckout = realpathSync.native(checkout);
    const { unattendedFlags } = await load();
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    try {
      const onResult = await runCli(
        [
          'on',
          '--root',
          checkout,
          '--item',
          'AR-103',
          '--run-dir',
          '/runs/1',
          '--allow',
          '.claude/skills/loop/',
        ],
        home,
      );
      expect(onResult.code, onResult.stderr).toBe(0);

      const result = await runCli(['verify', '--root', checkout, '--item', 'AR-103'], home);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await Promise.all(
        unattendedFlags(scopedEnv).map((candidate) => rm(candidate, { force: true })),
      );
    }
    await assertNoScopedFlagLeaked(canonicalCheckout, [home, ...realHomes]);
  });

  // Acceptance item 4: no guard behaviour changes. A widening `--allow`
  // still refuses at `on` and still writes NOTHING — this is the existing
  // case near line 264 above, restated here only to spell out that `verify`
  // must not be the thing that makes that refusal write a flag after all.
  it('does not change `on`: a widening --allow still exits 1 and still writes no flag', async (ctx) => {
    // RP-258: `--root` is mandatory now — supply one so this stays a test of
    // the widening refusal, not of the (separately tested) missing-root one.
    // RP-258 round 2: and it must be a real git checkout toplevel.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = path.join(home, 'on-widening-checkout');
    await mkdir(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const result = await runCli(
      ['on', '--root', checkout, '--item', 'AR-103', '--allow', '.'],
      home,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/rulebook/);
    expect(existsSync(flagPath())).toBe(false);
  });

  it('`verify` without --root exits 1 and names the missing --root, even with a scoped flag armed for cwd (RP-258)', async (ctx) => {
    // The mandatory-`--root` refusal must fire before any lookup, not only
    // when nothing is armed anywhere — otherwise a caller relying on cwd
    // fallback could still slip past it by accident.
    // RP-258 round 2: the checkout armed below must be a real git checkout
    // toplevel, or `on` itself refuses before this test's own case is set up.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    //
    // code-reviewer round 1 advisory: the name and this comment claim "armed
    // for cwd" / "fires before any lookup", but the child process this test
    // spawned carried no `CLAUDE_PROJECT_DIR` at all — so the unrooted
    // `verify` had nothing to find regardless of ordering, and a refusal
    // placed AFTER an empty lookup would have passed this test too. Setting
    // `CLAUDE_PROJECT_DIR` on the child to the exact scoped checkout that was
    // just armed is what makes the property real: the flag genuinely IS
    // discoverable from this env, and `verify` must still refuse for the
    // sole reason that `--root` itself is missing.
    const checkout = path.join(home, 'verify-missing-root-checkout');
    await mkdir(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
    const canonicalCheckout = realpathSync.native(checkout);
    const { unattendedFlags } = await load();
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    try {
      const onResult = await runCli(
        ['on', '--root', checkout, '--item', 'RP-258', '--run-dir', '/runs/1'],
        home,
      );
      expect(onResult.code, onResult.stderr).toBe(0);

      const result = await runCli(['verify', '--item', 'RP-258'], home, {
        CLAUDE_PROJECT_DIR: checkout,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--root/);
    } finally {
      await Promise.all(
        unattendedFlags(scopedEnv).map((candidate) => rm(candidate, { force: true })),
      );
    }
    await assertNoScopedFlagLeaked(canonicalCheckout, [home, ...realHomes]);
  });
});

/**
 * PR #325 (RP-258), round-1 gate findings on the head that made `--root`
 * mandatory. `hasRoot` only refuses a value that starts with `--`, so a
 * blank one — an empty string, or whitespace — passed straight through:
 * `canonicalCheckout` trims it to `''` and returns `null`, exactly the
 * unscoped state `--root` exists to make unreachable. code-reviewer's probe
 * reproduced it: `on --root "" --item X` exited 0 and wrote the unscoped
 * legacy record, and `verify --root "" --item X` read it back and printed
 * `armed` — while `guard-rulebook`, always scoped by the harness, refuses
 * that very file as an unscoped legacy record. Two callers of one flag,
 * disagreeing about whether it authorizes anything (code-reviewer BLOCKER).
 *
 * security-scanner's second, in-scope advisory is the same shape one layer
 * down: `canonicalPath` falls back to `resolve()` when `realpathSync.native`
 * cannot resolve a path, so a `--root` that does not exist, or one that
 * exists but is a subdirectory of a checkout rather than its git toplevel,
 * still arms/reads a flag — scoped to a directory `guard-rulebook` (which
 * always scopes itself by `git rev-parse --show-toplevel` of the REAL
 * checkout) can never see. `on`/`verify` need to refuse before doing
 * anything with such a root, the same way they already refuse a missing one.
 */
describe('on/verify: a blank, nonexistent, or non-checkout-root --root authorizes nothing (RP-258 round 2)', () => {
  it.each(['', '   ', '\t'])(
    '`on --root %j --item …` refuses a blank root and writes nothing',
    async (blank) => {
      const result = await runCli(['on', '--root', blank, '--item', 'RP-258'], home);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--root/);
      expect(existsSync(path.join(home, '.claude'))).toBe(false);
    },
  );

  it.each(['', '   '])(
    '`verify --root %j --item …` never reports armed, even when an unscoped legacy flag matches the item',
    async (blank) => {
      // Armed directly (bypassing `on`) so this test does not depend on the
      // "on refuses a blank root" case above to already hold — it pins the
      // read side of the same contract independently.
      await arm(JSON.stringify({ item: 'RP-258', runDir: '/runs/1', allow: [] }));
      const result = await runCli(['verify', '--root', blank, '--item', 'RP-258'], home);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toMatch(/armed/);
      expect(result.stderr).toMatch(/--root/);
    },
  );

  it('`on --root <nonexistent path> --item …` refuses, names the path problem, and writes nothing', async () => {
    const missing = path.join(home, 'does-not-exist-checkout');
    const result = await runCli(['on', '--root', missing, '--item', 'RP-258'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(missing);
    expect(result.stderr).toMatch(/does not exist|no such (file or )?directory/i);
    expect(existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('`verify --root <nonexistent path> --item …` refuses, naming the path problem rather than "no usable flag"', async () => {
    const missing = path.join(home, 'verify-does-not-exist-checkout');
    const result = await runCli(['verify', '--root', missing, '--item', 'RP-258'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(missing);
    expect(result.stderr).toMatch(/does not exist|no such (file or )?directory/i);
    // Distinguishes this from the generic "nothing is armed" refusal `verify`
    // already gives for an unrooted-but-otherwise-fine lookup — the message
    // here must be about the ROOT itself, checked before any flag lookup.
    expect(result.stderr).not.toMatch(/no usable unattended flag/i);
  });

  // A `--root` that EXISTS but is a subdirectory of a checkout, not the
  // checkout's own git toplevel, must be refused too: `guard-rulebook`
  // always scopes itself by the real checkout's toplevel, and would never
  // see a flag scoped to one of its subdirectories.
  it('`on --root <subdirectory of a git checkout> --item …` refuses, names the checkout-root problem, and writes nothing', async (ctx) => {
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = await mkdtemp(path.join(tmpdir(), 'rp258-subroot-on-'));
    // code-reviewer round 2 advisory: this test asserts the refusal writes
    // nothing, but had no cleanup of its own — if the refusal ever regressed
    // to an accept, the scoped write mirrors into the REAL password-database
    // home (same two-home rule as every other scoped write in this file) and
    // nothing here would remove it. Defensive, matching every other scoped
    // case's own `finally`.
    const { unattendedFlags } = await load();
    try {
      execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
      const subdir = path.join(checkout, 'nested', 'deeper');
      await mkdir(subdir, { recursive: true });
      const canonicalSubdir = realpathSync.native(subdir);
      const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: subdir };
      try {
        const result = await runCli(['on', '--root', subdir, '--item', 'RP-258'], home);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(subdir);
        expect(result.stderr).toMatch(/checkout root|toplevel/i);
        expect(existsSync(path.join(home, '.claude'))).toBe(false);
      } finally {
        await Promise.all(
          unattendedFlags(scopedEnv).map((candidate) => rm(candidate, { force: true })),
        );
      }
      // Independent check (not production's own `unattendedFlags`): if the
      // refusal above ever regressed to an accept, this is what would catch
      // it even if the `finally` cleanup above also silently regressed.
      await assertNoScopedFlagLeaked(canonicalSubdir, [home, ...realHomes]);
    } finally {
      await removeFixture(checkout);
    }
  });

  it('`verify --root <subdirectory of a git checkout> --item …` refuses, naming the checkout-root problem rather than "no usable flag"', async (ctx) => {
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const checkout = await mkdtemp(path.join(tmpdir(), 'rp258-subroot-verify-'));
    // code-reviewer round 2 advisory: `verify` itself never writes, but this
    // test also arms the OUTER checkout with `on` — cleaned via `off --root
    // checkout` below — and defensively covers a subdir-scoped candidate too,
    // for the same reason as the `on` subdirectory test above.
    const { unattendedFlags } = await load();
    try {
      execFileSync('git', ['init', '-q', checkout], { env: withoutGitLocation() });
      const subdir = path.join(checkout, 'nested', 'deeper');
      await mkdir(subdir, { recursive: true });
      const canonicalCheckout = realpathSync.native(checkout);
      const canonicalSubdir = realpathSync.native(subdir);
      const scopedSubdirEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: subdir };

      // Armed for the REAL checkout root first — so a `verify` that merely
      // fell through to "nothing found" for the subdirectory's own
      // (different) scope could not be mistaken for the specific refusal
      // this test pins.
      const onResult = await runCli(['on', '--root', checkout, '--item', 'RP-258'], home);
      expect(onResult.code, onResult.stderr).toBe(0);
      try {
        const result = await runCli(['verify', '--root', subdir, '--item', 'RP-258'], home);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(subdir);
        expect(result.stderr).toMatch(/checkout root|toplevel/i);
        expect(result.stderr).not.toMatch(/no usable unattended flag/i);
      } finally {
        await runCli(['off', '--root', checkout], home);
        await Promise.all(
          unattendedFlags(scopedSubdirEnv).map((candidate) => rm(candidate, { force: true })),
        );
      }
      // Independent check: the OUTER checkout's own armed flag was cleaned by
      // `off` above (verified independently too); the subdir never writes
      // under correct behaviour, `verify` never writes at all.
      await assertNoScopedFlagLeaked(canonicalCheckout, [home, ...realHomes]);
      await assertNoScopedFlagLeaked(canonicalSubdir, [home, ...realHomes]);
    } finally {
      await removeFixture(checkout);
    }
  });

  /**
   * code-reviewer round 2 (c79ff39), BLOCKER 1 — `requireRoot`'s own final
   * refusal, "git cannot confirm a checkout" (`toplevel === null`,
   * `unattended-flag.mjs:644`), had no test at all: a blank `--root` refuses
   * earlier (`requireRoot`'s `!hasRoot` branch), a nonexistent one refuses at the realpath step (its
   * own test asserts "does not exist", not this message), and a checkout
   * subdirectory (above) reaches the NEXT check instead (`toplevel !==
   * realRoot`, non-null). Flipping `if (toplevel === null)` to accept keeps
   * every existing case green while arming a flag scoped to a directory
   * `guard-rulebook` — always scoped by the real checkout toplevel — can
   * never see: the exact "wrong root" shape the round-1 security advisory
   * brought into scope.
   *
   * `GIT_CEILING_DIRECTORIES`, set to the candidate's own parent, is what
   * makes "git finds no repository here" true regardless of the host: an
   * ordinary existing-but-non-git directory already answers this way only
   * because nothing above `os.tmpdir()` happens to be a git checkout on the
   * machine running the suite — an accident of the environment, not a
   * property this test may rely on. The ceiling makes git's own upward search
   * stop at `home` on every host. `withoutGitLocation` (`git-env.mjs`) strips
   * only repository-LOCATION variables (`GIT_DIR`, `GIT_WORK_TREE`, …);
   * `GIT_CEILING_DIRECTORIES` bounds git's own directory search and is not on
   * that list, so it reaches the child unchanged.
   */
  describe('a --root git cannot confirm as any checkout at all (code-reviewer round 2 BLOCKER 1)', () => {
    it('`on --root <existing non-git directory>` refuses, names the confirmation failure, and writes nothing', async (ctx) => {
      skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
      const nonGitDir = path.join(home, 'not-a-git-checkout');
      await mkdir(nonGitDir, { recursive: true });
      const canonicalNonGitDir = realpathSync.native(nonGitDir);
      const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: nonGitDir };
      const { unattendedFlags } = await load();
      try {
        const result = await runCli(['on', '--root', nonGitDir, '--item', 'RP-258'], home, {
          GIT_CEILING_DIRECTORIES: home,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(nonGitDir);
        expect(result.stderr).toMatch(/could not be confirmed as a git checkout root/i);
        expect(existsSync(path.join(home, '.claude'))).toBe(false);
      } finally {
        await Promise.all(
          unattendedFlags(scopedEnv).map((candidate) => rm(candidate, { force: true })),
        );
      }
      await assertNoScopedFlagLeaked(canonicalNonGitDir, [home, ...realHomes]);
    });

    it('`verify --root <existing non-git directory>` refuses the same way, not as "no usable flag"', async (ctx) => {
      skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
      const nonGitDir = path.join(home, 'verify-not-a-git-checkout');
      await mkdir(nonGitDir, { recursive: true });
      const canonicalNonGitDir = realpathSync.native(nonGitDir);
      const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: nonGitDir };
      const { unattendedFlags } = await load();
      try {
        const result = await runCli(['verify', '--root', nonGitDir, '--item', 'RP-258'], home, {
          GIT_CEILING_DIRECTORIES: home,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(nonGitDir);
        expect(result.stderr).toMatch(/could not be confirmed as a git checkout root/i);
        expect(result.stderr).not.toMatch(/no usable unattended flag/i);
      } finally {
        await Promise.all(
          unattendedFlags(scopedEnv).map((candidate) => rm(candidate, { force: true })),
        );
      }
      await assertNoScopedFlagLeaked(canonicalNonGitDir, [home, ...realHomes]);
    });
  });
});

describe('the process layer declares the new files', () => {
  it('explains exact protected-prefix refusal separately from proper-prefix widening', async () => {
    const source = await readFile(scriptPath, 'utf8');
    const explanation =
      source.match(/\/\*\*\n \* Does this allow entry widen[\s\S]*?\*\//)?.[0] ?? '';
    expect(explanation).toMatch(/exact[\s-]+(?:protected[\s-]+)?prefix/i);
    expect(explanation).toMatch(/proper[\s-]+prefix/i);
    expect(explanation).toMatch(/(?:all|every)[\s\S]*\.claude\/scripts\//i);
    expect(explanation).not.toMatch(/\.claude\/scripts\/queue\/[\s\S]*exactly a rulebook prefix/i);
  });

  it('layers.json `process` lists unattended-flag.mjs and guard-rulebook.mjs', async () => {
    const layers = JSON.parse(await readFile(path.join(universal, 'layers.json'), 'utf8')) as {
      process: string[];
    };
    expect(layers.process).toContain('.claude/scripts/unattended-flag.mjs');
    expect(layers.process).toContain('.claude/hooks/guard-rulebook.mjs');
  });
});
