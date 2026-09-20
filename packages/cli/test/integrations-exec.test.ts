import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, symlink as symlinkP, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_ENV_VARS,
  MAX_STDERR_TAIL_CHARS,
  TOOL_NAME_PATTERN,
  boundedRun,
  classifyCandidates,
  identityContainment,
  isInside,
  isValidToolName,
  resolveTool,
  splitPathVar,
  stepUpOnePathSegment,
  type StatIdentity,
} from '../src/integrations/exec.js';
import { stripComments } from '../../../test/template/lib/source-scan.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { onlyOnWindows, skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'rig-exec-test-'));
});

afterEach(async () => {
  await removeFixture(workDir);
});

/** Bounded poll — never a fixed `delay(N)` — until `check()` returns true or `timeoutMs` elapses. */
async function pollUntil(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(stepMs);
  }
  return check();
}

describe('resolveTool — never from inside the repository', () => {
  // A synthetic "repository" per test, never the real checkout — planting a
  // hostile `claude`/`claude.exe` in the actual repo root this suite runs
  // from was itself the risk being tested for, and a failed test used to be
  // able to leave stray files behind in a real, shared checkout (gate cycle
  // 1 advisory).
  let fakeRepo: string;

  beforeEach(async () => {
    fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-fakerepo-'));
  });

  afterEach(async () => {
    await removeFixture(fakeRepo);
  });

  it('never resolves a tool from inside the repository, even when PATH names it', async () => {
    // Plant a fake "claude"/"claude.exe" AT THE FAKE REPO ROOT, and put the
    // repo root on PATH ahead of a legitimate, outside-the-repo directory
    // that also carries the tool.
    const repoPlanted = path.join(fakeRepo, 'claude');
    const repoPlantedExe = path.join(fakeRepo, 'claude.exe');
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-outside-'));
    const outsideFile = path.join(outside, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      await writeFile(repoPlanted, '#!/bin/sh\necho hostile\n');
      await writeFile(repoPlantedExe, 'hostile');
      await writeFile(outsideFile, 'legitimate');

      const env = { PATH: [fakeRepo, outside].join(path.delimiter) };
      const result = resolveTool('claude', { env, platform: process.platform, repoDir: fakeRepo });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        // The independent oracle: the resolved path must not sit under the
        // repo's own realpath, computed here rather than trusted from the
        // module under test. `.native` (not the plain JS realpath) is what
        // makes this oracle agree with the module on win32: the plain JS
        // implementation does not expand an 8.3 short-name path component
        // (a real windows-smoke TEMP directory is spelled short, e.g.
        // `RUNNER~1`), so a plain `realpathSync` oracle disagreed with this
        // module's own (correctly long-form) answer.
        const { realpathSync } = await import('node:fs');
        const repoReal = realpathSync.native(fakeRepo);
        expect(result.absFile.startsWith(repoReal + path.sep)).toBe(false);
        expect(result.absFile).toBe(realpathSync.native(outsideFile));
      }
    } finally {
      await removeFixture(outside);
    }
  });

  it('covers a symlinked PATH entry that points into the repository — both sides are realpath-resolved', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const { realpath: realpathP } = await import('node:fs/promises');
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-symlink-'));
    const linkDir = path.join(outside, 'link-into-repo');
    const repoPlanted = path.join(fakeRepo, 'claude');
    try {
      await writeFile(repoPlanted, '#!/bin/sh\necho hostile\n');
      await symlinkP(fakeRepo, linkDir, 'dir');

      const env = { PATH: linkDir };
      const result = resolveTool('claude', {
        env,
        platform: process.platform,
        repoDir: fakeRepo,
      });

      expect(result.status).toBe('tool-not-found');
      const repoReal = await realpathP(fakeRepo);
      if ((result as { status: string; absFile?: string }).status === 'ok') {
        expect((result as { absFile: string }).absFile.startsWith(repoReal + path.sep)).toBe(false);
      }
    } finally {
      await removeFixture(outside);
    }
  });

  // Discriminates the DIRECTORY-level repo-exclusion from the CANDIDATE-file
  // one below: here the PATH entry itself IS the repo root (no symlink
  // needed), but the "tool" inside it is a symlink pointing OUTSIDE the
  // repo. The candidate-level check alone would not refuse this (its
  // realpath is genuinely outside the repo) — only the directory-level check
  // does, because the DIRECTORY a caller would have to search is inside the
  // repository's own working tree, regardless of where a file in it points.
  it('refuses a PATH entry that IS the repo root, even when the tool inside it is a symlink pointing outside', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-outside-target-'));
    const outsideFile = path.join(outside, 'real-claude');
    const repoPlantedSymlink = path.join(fakeRepo, 'claude');
    try {
      await writeFile(outsideFile, 'legitimate');
      await symlinkP(outsideFile, repoPlantedSymlink, 'file');

      const env = { PATH: fakeRepo };
      const result = resolveTool('claude', {
        env,
        platform: process.platform,
        repoDir: fakeRepo,
      });

      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(outside);
    }
  });

  // The mirror case: discriminates the CANDIDATE-file check from the
  // directory one. The PATH entry is a genuine directory OUTSIDE the repo —
  // the directory-level check has nothing to refuse — but the file it
  // contains is a symlink pointing INTO the repo.
  it('refuses a PATH entry outside the repo whose matching file is a symlink pointing into the repo', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-outside-dir-'));
    const outsideSymlink = path.join(outside, 'claude');
    const repoPlantedTarget = path.join(fakeRepo, 'claude-target');
    try {
      await writeFile(repoPlantedTarget, 'hostile');
      await symlinkP(repoPlantedTarget, outsideSymlink, 'file');

      const env = { PATH: outside };
      const result = resolveTool('claude', {
        env,
        platform: process.platform,
        repoDir: fakeRepo,
      });

      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(outside);
    }
  });
});

describe('resolveTool — containment is checked against the HOST platform, never the declared one', () => {
  it("refuses a repo-planted tool even when options.platform names a platform OTHER than the host actually running this process (gate cycle 2, blocker 1: the previous fix compared realpaths using options.platform, which fails open when it disagrees with the host; gate cycle 3, blocker 3: the previous version of THIS test planted a file named only for the HOST platform, so classifyCandidates answered 'absent' regardless of the declared platform and the fixture never reached the containment logic at all — both claude and claude.exe are planted now, for every host) — this scenario only DISCRIMINATES on win32: the host's own realpath is backslash-separated there, and POSIX's path.relative() cannot find a shared prefix between two such strings at all (the code-reviewer lens observed the mutant escape directly on win32 with PATH:'/Users/…/repo/bin'), so declaring any non-win32 platform made an in-repo PATH entry look 'outside'; on a forward-slash-native host (this one, unless it happens to be win32), path.win32's own relative() still understands '/', so the SAME declared-platform mismatch does not reproduce the escape — the assertion below is still exercised, and still must hold, on every host", async (ctx) => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-platformmismatch-repo-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-platformmismatch-outside-'));
    const originalCwd = process.cwd();
    try {
      const bin = path.join(fakeRepo, 'bin');
      await mkdir(bin, { recursive: true });
      // Plant BOTH spellings, regardless of host or declared platform — a
      // fixture named only for the host used to make classifyCandidates
      // answer 'absent' whenever the DECLARED platform differed, which is
      // exactly why the previous version of this test could never reach the
      // containment logic on either host (gate cycle 3, blocker 3).
      await writeFile(path.join(bin, 'claude'), 'hostile');
      await writeFile(path.join(bin, 'claude.exe'), 'hostile');
      const nonHostPlatform: NodeJS.Platform = process.platform === 'win32' ? 'linux' : 'win32';

      // On win32, a plain drive-letter PATH entry (`C:\...\bin`) would be
      // rejected outright by the DECLARED (non-win32) platform's own
      // isAbsolute check before ever reaching the containment logic this
      // test targets — exactly the shape the original report used a
      // leading-slash entry to route around. Reconstruct that shape here.
      // `process.chdir` to the temp directory's OWN drive root (in
      // try/finally, the same pattern the empty-PATH-entry test above
      // already uses) makes a leading-slash entry resolve against THAT
      // drive rather than the checkout's — the previous version resolved
      // it against `process.cwd()`'s drive instead, which is why gate
      // cycle 3 found this test skipped on the hosted Windows runner
      // (checkout on `D:`, TEMP on `C:`).
      let pathEntry = bin;
      let outsidePathEntry = outside;
      if (process.platform === 'win32') {
        process.chdir(path.parse(bin).root);
        const toPosixLeadingSlash = (p: string) =>
          `/${p
            .replace(/^[A-Za-z]:\\/, '')
            .split(path.sep)
            .join('/')}`;
        pathEntry = toPosixLeadingSlash(bin);
        outsidePathEntry = toPosixLeadingSlash(outside);
        const { realpathSync } = await import('node:fs');
        let reachesBin = false;
        try {
          reachesBin = realpathSync.native(pathEntry) === realpathSync.native(bin);
        } catch {
          reachesBin = false;
        }
        if (!reachesBin) {
          ctx.skip(
            "process.chdir to the temp directory's own drive root did not make a leading-slash PATH entry reach it — the win32-only discriminating shape for this test is unreachable here",
          );
          return;
        }
      }

      // `stat: () => null` forces identityContainment to answer 'unknown'
      // (limit 11), deferring entirely to the STRING check this test exists
      // to pin — otherwise the identity half (which shares no `dev`/`ino`
      // fixture with this scenario, since these are REAL directories with
      // real, non-conflicting inodes) never actually decides either way, but
      // a mutant that disables the string check outright could still be
      // masked BY COINCIDENCE if a future identity fixture were added here
      // (gate cycle 4, blocker 2: replayed against the `options.platform`
      // mutant at exec.ts's two isInsideEitherWay call sites, this test was
      // measured GREEN — i.e. failing to catch it — without this).
      const result = resolveTool('claude', {
        env: { PATH: pathEntry },
        platform: nonHostPlatform,
        repoDir: fakeRepo,
        stat: () => null,
      });
      expect(result.status).toBe('tool-not-found');

      // The positive control: the SAME PATH-entry shape, SAME declared
      // (non-host) platform, SAME `stat: () => null`, but a directory
      // genuinely OUTSIDE the repository — this must resolve `ok`, proving
      // the fixture shape itself is capable of a positive result and that
      // the negative result above is not an artifact of some unrelated
      // defect (like the extension-mismatch bug gate cycle 3 found in the
      // previous version).
      await writeFile(path.join(outside, 'claude'), 'legitimate');
      await writeFile(path.join(outside, 'claude.exe'), 'legitimate');
      const control = resolveTool('claude', {
        env: { PATH: outsidePathEntry },
        platform: nonHostPlatform,
        repoDir: fakeRepo,
        stat: () => null,
      });
      expect(control.status).toBe('ok');
    } finally {
      process.chdir(originalCwd);
      await removeFixture(fakeRepo);
      await removeFixture(outside);
    }
  });
});

describe('identityContainment — the IDENTITY half of containment (gate cycle 3, blocker 2)', () => {
  const idA: StatIdentity = { dev: 1n, ino: 42n };
  const idB: StatIdentity = { dev: 1n, ino: 99n };
  const idUnavailable: StatIdentity = { dev: 0n, ino: 0n };

  it('reports "inside" when the candidate itself shares device+inode identity with root, even though the two STRINGS are completely unrelated — exactly the UNC-vs-drive-letter case realpath cannot canonicalise', () => {
    const stat = (target: string) =>
      target === '\\\\localhost\\C$\\repo' || target === 'C:\\repo' ? idA : null;
    expect(identityContainment('\\\\localhost\\C$\\repo', 'C:\\repo', stat)).toBe('inside');
  });

  it('walks UPWARD from the candidate: a file three levels under a UNC-spelled root still matches by identity at the root level', () => {
    const stat = (target: string): StatIdentity | null => {
      if (target === '\\\\localhost\\C$\\repo\\a\\b\\file.exe') return idB;
      if (target === '\\\\localhost\\C$\\repo\\a\\b') return idB;
      if (target === '\\\\localhost\\C$\\repo\\a') return idB;
      if (target === '\\\\localhost\\C$\\repo') return idA; // matches root's identity
      if (target === 'C:\\repo') return idA;
      return null;
    };
    expect(identityContainment('\\\\localhost\\C$\\repo\\a\\b\\file.exe', 'C:\\repo', stat)).toBe(
      'inside',
    );
  });

  it('reports "outside" for a genuinely disjoint directory tree, regardless of string similarity', () => {
    // Deliberately NOT nested under root's own path string — a candidate
    // whose path literally passes through root's own string would trivially
    // "match" root's identity on any real filesystem, since it IS root;
    // that proves nothing about the identity check specifically.
    const stat = (target: string) =>
      target === '/other/bin' || target === '/other' ? idB : target === '/repo' ? idA : null;
    expect(identityContainment('/other/bin', '/repo', stat)).toBe('outside');
  });

  it('reports "unknown" — deferring to the string check — when root\'s own identity is unavailable (ino: 0n)', () => {
    const stat = (target: string) => (target === '/repo' ? idUnavailable : idB);
    expect(identityContainment('/repo/bin', '/repo', stat)).toBe('unknown');
  });

  it('reports "unknown" when the candidate\'s own identity is unavailable (stat returns null)', () => {
    const stat = (target: string) => (target === '/repo' ? idA : null);
    expect(identityContainment('/repo/bin', '/repo', stat)).toBe('unknown');
  });

  it('never loops: the walk is bounded by the candidate\'s own path-segment count — proportionally, not just "a small number" (gate cycle 4 advisory: a shallow 6-segment candidate against a `< 20` ceiling passes whether or not the bound logic is even present; a 50-segment candidate makes an actually-unbounded walk time this test out rather than merely fail an assertion, and the assertion itself now scales with depth)', () => {
    const depth = 50;
    const candidate = `/${Array.from({ length: depth }, (_, i) => `seg${i}`).join('/')}`;
    let calls = 0;
    const stat = (target: string): StatIdentity | null => {
      calls += 1;
      if (target === '/repo') return idA;
      return { dev: 2n, ino: BigInt(calls) }; // never matches idA, never repeats
    };
    expect(identityContainment(candidate, '/repo', stat)).toBe('outside');
    // root + candidate + at most `depth` further ancestor steps, bounded by
    // the candidate's OWN path-segment count — never unbounded.
    expect(calls).toBeLessThanOrEqual(depth + 2);
    // And genuinely walked most of the way up, not short-circuited early —
    // proving the bound is what stopped it, not an accidental early match.
    expect(calls).toBeGreaterThan(depth / 2);
  });
});

describe('stepUpOnePathSegment — never yields a non-rooted path (gate cycle 4, blocker 1: the identity walk used to ascend a win32 path to a bare drive designator ("C:", no trailing separator) and stat it — Windows resolves that as the PROCESS\'s own current directory on that drive, not the volume root)', () => {
  it('steps a win32 path up to the true drive root (drive letter, colon, ONE trailing backslash), never a bare drive designator with no trailing backslash', () => {
    expect(stepUpOnePathSegment('C:\\Users\\x')).toBe('C:\\Users');
    expect(stepUpOnePathSegment('C:\\Users')).toBe('C:\\');
    expect(stepUpOnePathSegment('C:\\')).toBe('C:\\'); // already at the floor: stays put
  });

  it('steps a UNC path up to the share root, never past it to the bare server or a bare "\\\\\\\\"', () => {
    expect(stepUpOnePathSegment('\\\\server\\share\\x\\y')).toBe('\\\\server\\share\\x');
    expect(stepUpOnePathSegment('\\\\server\\share\\x')).toBe('\\\\server\\share');
    expect(stepUpOnePathSegment('\\\\server\\share')).toBe('\\\\server\\share'); // floor
  });

  it('steps a POSIX path up to "/" and stops there', () => {
    expect(stepUpOnePathSegment('/a/b')).toBe('/a');
    expect(stepUpOnePathSegment('/a')).toBe('/');
    expect(stepUpOnePathSegment('/')).toBe('/'); // floor
  });

  it('the identity walk never stats a bare drive designator or a bare UNC prefix, even walking a deep win32 path all the way to its root (host-independent: records every path an injected stat is asked about)', () => {
    const statted: string[] = [];
    let counter = 0n;
    const stat = (target: string): StatIdentity => {
      statted.push(target);
      counter += 1n;
      return { dev: 1n, ino: counter }; // unique every call: nothing ever matches, so the walk runs to its floor
    };
    identityContainment('C:\\Users\\x\\y\\z', 'C:\\Other', stat);
    expect(statted.length).toBeGreaterThan(1); // the walk genuinely ran
    for (const p of statted) {
      expect(p).not.toBe('C:'); // never the bare, process-relative drive designator
      expect(p).not.toMatch(/^\\\\[^\\]+$/); // never a bare "\\server", missing its share
      expect(p).not.toBe('\\');
    }
    expect(statted).toContain('C:\\'); // the walk DID reach the true root
  });
});

describe('resolveTool/boundedRun — a repository whose realpath equals process.cwd() does not make every path on the same drive "inside" it (gate cycle 4, blocker 1\'s own integration pin)', () => {
  it("resolveTool and boundedRun both still resolve a genuinely outside tool/cwd ok when the process's own cwd IS the repository, on the same drive as TEMP — this is exactly the configuration gate cycle 4 measured to make identityContainment answer 'inside' for every absolute path on that drive before the fix", async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    // Both created under os.tmpdir() so they share a drive with each other
    // AND with boundedRun's own default per-run cwd (also under
    // os.tmpdir()) — the hosted runner has the checkout on one drive and
    // TEMP on another, so this must all live under TEMP to discriminate.
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-drivebug-repo-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-drivebug-outside-'));
    const originalCwd = process.cwd();
    try {
      await writeFile(path.join(outside, 'claude.exe'), 'legit');
      process.chdir(fakeRepo);

      const resolved = resolveTool('claude', {
        env: { PATH: outside },
        platform: 'win32',
        repoDir: fakeRepo,
      });
      expect(resolved.status).toBe('ok');

      const defaultCwdResult = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        repoDir: fakeRepo,
      });
      expect(defaultCwdResult.status).toBe('ok');

      const explicitOutsideResult = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        repoDir: fakeRepo,
        cwd: outside,
      });
      expect(explicitOutsideResult.status).toBe('ok');
    } finally {
      process.chdir(originalCwd);
      await removeFixture(fakeRepo);
      await removeFixture(outside);
    }
  });
});

describe("resolveTool — UNC vs drive-letter is the SAME repository, on a real win32 filesystem (gate cycle 3, blocker 2; renamed in gate cycle 4, blocker 5: this describe used to claim boundedRun coverage too, but only ever called resolveTool — see the describe below for boundedRun's own identity coverage)", () => {
  it("a UNC admin-share spelling and its drive-letter equivalent are treated as the SAME repository, in both orientations — the identity check catches what realpath's string form cannot", async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-unc-repo-'));
    try {
      const driveLetter = fakeRepo.slice(0, 1);
      const toUnc = (p: string) => `\\\\localhost\\${driveLetter}$${p.slice(2)}`;
      const uncRepo = toUnc(fakeRepo);
      if (!existsSync(uncRepo)) {
        ctx.skip('the admin-share (UNC) spelling of this drive is not reachable on this runner');
        return;
      }

      const bin = path.join(fakeRepo, 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'claude.exe'), 'hostile');

      // Orientation 1: repoDir given as UNC, PATH entry given as drive-letter.
      const result1 = resolveTool('claude', {
        env: { PATH: bin },
        platform: 'win32',
        repoDir: uncRepo,
      });
      expect(result1.status).toBe('tool-not-found');

      // Orientation 2: repoDir given as drive-letter, PATH entry given as UNC.
      const result2 = resolveTool('claude', {
        env: { PATH: toUnc(bin) },
        platform: 'win32',
        repoDir: fakeRepo,
      });
      expect(result2.status).toBe('tool-not-found');
    } finally {
      await removeFixture(fakeRepo);
    }
  });
});

describe("resolveTool/boundedRun — identity containment via an injected stat, host-independent (gate cycle 4, blocker 5: boundedRun's own identity containment had no test on any host, and nothing above passed stat to either entry point)", () => {
  it('resolveTool refuses via the injected stat identity alone, even though the two directories are genuinely UNRELATED by string', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-resolve-repo-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-resolve-outside-'));
    try {
      const toolFile = process.platform === 'win32' ? 'claude.exe' : 'claude';
      await writeFile(path.join(outside, toolFile), 'legit');
      // Every stat call answers with the SAME literal dev/ino — an
      // unrelated-by-string pair of directories that nonetheless "share
      // identity" as far as this injected fixture is concerned.
      const sharedIdentity: StatIdentity = { dev: 1n, ino: 1n };
      const stat = (): StatIdentity => sharedIdentity;
      const result = resolveTool('claude', {
        env: { PATH: outside },
        platform: process.platform,
        repoDir: fakeRepo,
        stat,
      });
      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(fakeRepo);
      await removeFixture(outside);
    }
  });

  it('resolveTool resolves ok when the injected stat reports genuinely DIFFERING identities (positive control for the test above)', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-resolve-ok-repo-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-resolve-ok-outside-'));
    try {
      const toolFile = process.platform === 'win32' ? 'claude.exe' : 'claude';
      await writeFile(path.join(outside, toolFile), 'legit');
      let counter = 0n;
      // A fresh, never-repeating identity on every call — never matches.
      const stat = (): StatIdentity => {
        counter += 1n;
        return { dev: 1n, ino: counter };
      };
      const result = resolveTool('claude', {
        env: { PATH: outside },
        platform: process.platform,
        repoDir: fakeRepo,
        stat,
      });
      expect(result.status).toBe('ok');
    } finally {
      await removeFixture(fakeRepo);
      await removeFixture(outside);
    }
  });

  it('boundedRun refuses a cwd via the injected stat identity alone, with the fixed cwd-refusal message, even though the two directories are genuinely UNRELATED by string', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-run-repo-'));
    const outsideCwd = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-run-outside-'));
    try {
      const sharedIdentity: StatIdentity = { dev: 1n, ino: 1n };
      const stat = (): StatIdentity => sharedIdentity;
      const result = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        repoDir: fakeRepo,
        cwd: outsideCwd,
        stat,
      });
      expect(result.status).toBe('spawn-error');
      if (result.status === 'spawn-error') {
        expect(result.message).toBe('boundedRun refuses a cwd inside the repository');
      }
    } finally {
      await removeFixture(fakeRepo);
      await removeFixture(outsideCwd);
    }
  });

  it('boundedRun accepts a cwd when the injected stat reports genuinely DIFFERING identities (positive control for the test above)', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-run-ok-repo-'));
    const outsideCwd = await mkdtemp(path.join(tmpdir(), 'rig-exec-identity-run-ok-outside-'));
    try {
      let counter = 0n;
      const stat = (): StatIdentity => {
        counter += 1n;
        return { dev: 1n, ino: counter };
      };
      const result = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        repoDir: fakeRepo,
        cwd: outsideCwd,
        stat,
      });
      expect(result.status).toBe('ok');
    } finally {
      await removeFixture(fakeRepo);
      await removeFixture(outsideCwd);
    }
  });
});

describe('resolveTool — the injected realpath canonicaliser is what containment actually consults', () => {
  it('resolveTool consults the injected realpath function for BOTH the directory and the candidate file (a host-independent pin for gate cycle 2, blocker 2 — proving the same call sites the 8.3 fix depends on are genuinely reachable and load-bearing on ANY host, including one without a short name to construct)', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-inject-repo-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-inject-outside-'));
    try {
      const toolFileName = process.platform === 'win32' ? 'claude.exe' : 'claude';
      await writeFile(path.join(outside, toolFileName), 'legit');

      const { realpathSync } = await import('node:fs');
      const realOutside = realpathSync.native(outside);
      const realFakeRepo = realpathSync.native(fakeRepo);
      const expectedCandidate = path.join(realOutside, toolFileName);
      const standIn = path.join(realFakeRepo, 'stand-in');

      const calls: string[] = [];
      const stubRealpath = (target: string): string | null => {
        calls.push(target);
        if (target === expectedCandidate) return standIn; // pretend the CANDIDATE FILE resolves inside the repo
        try {
          return realpathSync.native(target);
        } catch {
          return null;
        }
      };

      const env = { PATH: outside };
      const result = resolveTool('claude', {
        env,
        platform: process.platform,
        repoDir: fakeRepo,
        realpath: stubRealpath,
      });

      // If the candidate-level check used its own internal realpath
      // instead of the injected one, `candidateReal` would be the REAL
      // (genuinely outside) path and this would resolve `ok` — the
      // injected stub is what makes it `tool-not-found` instead.
      expect(result.status).toBe('tool-not-found');
      // All three sites `resolveTool` needs a realpath for actually
      // called the INJECTED function: repoDir itself, the PATH entry's
      // directory, and the matched candidate file.
      expect(calls).toContain(fakeRepo);
      expect(calls).toContain(outside);
      expect(calls).toContain(expectedCandidate);
    } finally {
      await removeFixture(fakeRepo);
      await removeFixture(outside);
    }
  });

  it('LIMIT 8, now demonstrated via the injected realpath: a canonicaliser that resolves repoDir to an UNRELATED-LOOKING string — exactly what a short-name-blind realpath can do for two different spellings of the same directory — lets an in-repo tool resolve ok', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-limit8-repo-'));
    try {
      const bin = path.join(fakeRepo, 'bin');
      await mkdir(bin, { recursive: true });
      const toolFile = process.platform === 'win32' ? 'claude.exe' : 'claude';
      await writeFile(path.join(bin, toolFile), 'hostile');

      const { realpathSync } = await import('node:fs');
      // Resolves the PATH entry's directory normally (matching what is
      // really on disk), but answers a totally unrelated string for
      // repoDir itself — simulating a canonicaliser that failed to
      // recognise a short-name/case respelling as the SAME directory a
      // subdirectory of it genuinely lives under.
      const blindRealpath = (target: string): string | null => {
        if (target === fakeRepo) return 'SHORT~1-UNRELATED-FORM';
        try {
          return realpathSync.native(target);
        } catch {
          return null;
        }
      };

      const result = resolveTool('claude', {
        env: { PATH: bin },
        platform: process.platform,
        repoDir: fakeRepo,
        realpath: blindRealpath,
      });
      // The identity check (blocker 2) does NOT save this case either: the
      // stub never claimed dev/ino identity for 'SHORT~1-UNRELATED-FORM',
      // so `stat('SHORT~1-UNRELATED-FORM')` fails and identityContainment
      // reports 'unknown', deferring entirely to the (defeated) string
      // check — exactly limit 11's own stated scope.
      expect(result.status).toBe('ok');
    } finally {
      await removeFixture(fakeRepo);
    }
  });
});

describe('resolveTool — win32 8.3 short-name canonicalisation', () => {
  it('refuses a PATH entry reachable only through its 8.3 short-name spelling — this test runs only on win32; it FAILS (never silently skips) when the volume is independently known to generate short names but this one could not be obtained, and only context.skips when the volume genuinely has 8dot3name generation disabled', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    // `spawnSync`, not `execFileSync`: only `spawnSync`'s options type
    // admits `windowsVerbatimArguments` (it is declared on
    // `CommonSpawnOptions`, which `execFileSync`'s options do not extend),
    // and it is required here — without it, Node's own argv-quoting for
    // `cmd.exe` escapes the inner double quotes around `${longDir}`, and
    // cmd.exe then parses a MANGLED path — one that still happens to
    // contain `~1` and so evaded every guard below in the previous version
    // of this test (gate cycle 2, blocker 2), while resolving to nothing
    // real.
    const { spawnSync } = await import('node:child_process');
    const longDirName = `rig-exec-8dot3-${'x'.repeat(40)}`;
    const parent = await mkdtemp(path.join(tmpdir(), 'rig-exec-8dot3-parent-'));
    const longDir = path.join(parent, longDirName);
    try {
      await mkdir(longDir, { recursive: true });
      await writeFile(path.join(longDir, 'claude.exe'), 'hostile');

      let shortForm = '';
      const cmdResult = spawnSync(
        'cmd.exe',
        ['/d', '/s', '/c', `for %A in ("${longDir}") do @echo %~sA`],
        { windowsVerbatimArguments: true, encoding: 'utf8' },
      );
      if (cmdResult.error === undefined && cmdResult.status === 0) {
        shortForm = cmdResult.stdout.trim();
      }
      // A non-zero status / spawn error falls through to the loud-vs-quiet
      // decision below with an empty shortForm — a lookup failure is one
      // of the ways this can go wrong, not a separate case.

      const { realpathSync } = await import('node:fs');
      // Independent evidence that THIS volume genuinely generates 8.3
      // names, from a source other than the very lookup being tested: its
      // own TEMP root. Measured true on windows-smoke (gate cycle 1: an
      // `…\RUNNER~1\…` TEMP spelling).
      const volumeGeneratesShortNames = /~\d/.test(tmpdir()) || /~\d/.test(parent);

      const shortFormLooksValid =
        shortForm.length > 0 &&
        shortForm !== longDir &&
        /~\d/.test(shortForm) &&
        existsSync(shortForm);
      let nativeMatchesLong = false;
      if (shortFormLooksValid) {
        try {
          nativeMatchesLong = realpathSync.native(shortForm) === realpathSync.native(longDir);
        } catch {
          nativeMatchesLong = false;
        }
      }

      if (!shortFormLooksValid || !nativeMatchesLong) {
        if (volumeGeneratesShortNames) {
          // This volume demonstrably generates short names — a broken
          // short form for OUR OWN longDir is this test's construction
          // failing, not the feature being absent. Fail loudly.
          expect(
            shortFormLooksValid,
            `expected a genuine 8.3 short form for ${longDir}; got ${JSON.stringify(shortForm)}`,
          ).toBe(true);
          expect(
            nativeMatchesLong,
            'realpathSync.native(shortForm) did not resolve back to the long form',
          ).toBe(true);
        }
        ctx.skip(
          'this volume does not generate 8.3 short names (8dot3name creation disabled), and neither os.tmpdir() nor this parent directory is short-spelled either',
        );
        return;
      }

      // `stat: () => null` forces identityContainment to answer 'unknown'
      // (limit 11), so this test pins the STRING check alone — the real
      // short-name/long-name pair here share genuine, coinciding `dev`/`ino`
      // on disk (they are the SAME directory), so without this the identity
      // half decides the case regardless of whether the string-side fix (the
      // whole point of this test) is even present (gate cycle 4, blocker 2:
      // replayed against a mutant reverting to plain `realpathSync`, this
      // test was measured GREEN — i.e. failing to catch it — without this).
      const env = { PATH: shortForm };
      const result = resolveTool('claude', {
        env,
        platform: 'win32',
        repoDir: longDir,
        stat: () => null,
      });
      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(parent);
    }
  });
});

describe('resolveTool — PATH entry hygiene', () => {
  it('skips a relative PATH entry, even when it genuinely resolves to a directory OUTSIDE the repo carrying the tool', async (context) => {
    // Two things must both be true for this test to distinguish "skipped
    // because relative" from a coincidence: the directory must genuinely
    // exist (so a non-existent relative path isn't what skips it) AND it
    // must be OUTSIDE the repository (so the SEPARATE repo-exclusion check
    // isn't what skips it instead — process.cwd() during this suite is
    // already inside the repo, so a relative entry built from a plain
    // sub-directory name would land inside it and be caught by the wrong
    // check). tmpdir() is outside the repo; path.relative() to it from
    // process.cwd() is what makes the PATH entry itself relative.
    const absDir = await mkdtemp(path.join(tmpdir(), 'rig-exec-relative-target-'));
    try {
      await writeFile(
        path.join(absDir, process.platform === 'win32' ? 'claude.exe' : 'claude'),
        'x',
      );
      const relEntry = path.relative(process.cwd(), absDir);
      // On win32, process.cwd() and os.tmpdir() can sit on different drive
      // letters (measured on the windows-smoke runner: the checkout is on
      // one drive, TEMP on another) — path.win32.relative() cannot express
      // that as a relative path and returns the absolute target instead.
      // The fixture cannot be built as genuinely relative on such a host —
      // a real environmental impossibility unrelated to the guard under
      // test, so this reports a genuine, named SKIP rather than a bare
      // early return (gate cycle 1, blocker 5; in-repo pattern:
      // packages/cli/test/init.test.ts:443).
      if (path.isAbsolute(relEntry)) {
        context.skip('process.cwd() and os.tmpdir() are on different drives on this host');
        return;
      }
      const env = { PATH: relEntry };
      const result = resolveTool('claude', { env, platform: process.platform, repoDir: repoRoot });
      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(absDir);
    }
  });

  it('skips an empty PATH entry (which means cwd), never treating it as a match — even when a tool genuinely sits in process.cwd() (gate cycle 2 advisory: the previous fixture planted the tool nowhere, so it could not have discriminated a wrongly-cwd-searching implementation from a correct one)', async () => {
    const fakeCwd = await mkdtemp(path.join(tmpdir(), 'rig-exec-emptypath-cwd-'));
    const unrelated = await mkdtemp(path.join(tmpdir(), 'rig-exec-emptypath-unrelated-'));
    const unrelatedRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-emptypath-repo-'));
    const originalCwd = process.cwd();
    try {
      await writeFile(
        path.join(fakeCwd, process.platform === 'win32' ? 'claude.exe' : 'claude'),
        'x',
      );
      process.chdir(fakeCwd);
      const env = { PATH: ['', unrelated].join(path.delimiter) };
      const result = resolveTool('claude', {
        env,
        platform: process.platform,
        repoDir: unrelatedRepo,
      });
      expect(result.status).toBe('tool-not-found');
    } finally {
      process.chdir(originalCwd);
      await removeFixture(fakeCwd);
      await removeFixture(unrelated);
      await removeFixture(unrelatedRepo);
    }
  });
});

describe('splitPathVar — PATH-string delimiter follows the DECLARED platform, not the host', () => {
  it('splits on ";" for win32, regardless of the host actually running this suite', () => {
    expect(splitPathVar('C:\\one;C:\\two', 'win32')).toEqual(['C:\\one', 'C:\\two']);
  });

  it('splits on ":" for a POSIX platform', () => {
    expect(splitPathVar('/one:/two', 'linux')).toEqual(['/one', '/two']);
  });

  it('returns no entries for an empty string', () => {
    expect(splitPathVar('', 'win32')).toEqual([]);
  });
});

describe('isInside — platform-parameterised case-folding', () => {
  it('is case-sensitive on a POSIX platform (a case-variant path is NOT treated as inside)', () => {
    expect(isInside('/A/Foo/tool', '/a/foo', 'linux')).toBe(false);
  });

  it('case-folds on win32 (a case-variant spelling of the same path IS treated as inside)', () => {
    expect(isInside('/A/Foo/tool', '/a/foo', 'win32')).toBe(true);
  });

  it('case-folds on darwin (a case-variant spelling of the same path IS treated as inside)', () => {
    expect(isInside('/A/Foo/tool', '/a/foo', 'darwin')).toBe(true);
  });

  it(
    'treats an EMPTY path.relative result as "inside" — a trailing-slash respelling of the root ' +
      "itself, not a mismatch (gate cycle 1, blocker 3: the previous `rel !== ''` condition " +
      'returned false for exactly this case)',
    () => {
      expect(isInside('/tmp/rig-repo/', '/tmp/rig-repo', 'linux')).toBe(true);
    },
  );

  it('a genuinely unrelated path is outside, on every platform', () => {
    expect(isInside('/somewhere/else', '/tmp/rig-repo', 'linux')).toBe(false);
    expect(isInside('/somewhere/else', '/tmp/rig-repo', 'win32')).toBe(false);
  });
});

describe('classifyCandidates — pure, platform-parameterised', () => {
  it('on win32, a .exe candidate is spawnable', () => {
    expect(classifyCandidates(['claude.exe', 'readme.txt'], 'claude', 'win32')).toBe('spawnable');
  });

  it('on win32, a .cmd-only candidate is reported not-spawnable, never resolved as if it were absent', () => {
    expect(classifyCandidates(['claude.cmd'], 'claude', 'win32')).toBe('not-spawnable');
  });

  it.each(['.bat', '.com', '.ps1'])(
    'on win32, a %s-only candidate is also reported not-spawnable (the same PATHEXT-shaped set as .cmd)',
    (ext) => {
      expect(classifyCandidates([`claude${ext}`], 'claude', 'win32')).toBe('not-spawnable');
    },
  );

  it('on win32, an unrelated extension sharing the base name is absent, NOT not-spawnable (gate cycle 1 advisory: over-matching any <name>.<ext>)', () => {
    expect(classifyCandidates(['claude.txt'], 'claude', 'win32')).toBe('absent');
  });

  it('on win32, no matching file at all is absent', () => {
    expect(classifyCandidates(['other.exe'], 'claude', 'win32')).toBe('absent');
  });

  it('on a POSIX platform, an exact-name file is spawnable regardless of extension rules', () => {
    expect(classifyCandidates(['claude'], 'claude', 'linux')).toBe('spawnable');
  });

  it('on a POSIX platform, a same-named .cmd file is not a match (POSIX has no extension convention here)', () => {
    expect(classifyCandidates(['claude.cmd'], 'claude', 'linux')).toBe('absent');
  });

  it('on a POSIX platform, a case-variant file is NOT a match — POSIX filenames are case-sensitive (gate cycle 1 advisory: this used to case-fold and report spawnable with no exact-case file present)', () => {
    expect(classifyCandidates(['Claude'], 'claude', 'linux')).toBe('absent');
  });
});

describe('resolveTool — win32 extension policy end to end', () => {
  it('on win32, a .cmd-only tool on PATH resolves as tool-not-spawnable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-cmd-'));
    try {
      await writeFile(path.join(dir, 'claude.cmd'), '@echo off\r\necho hi\r\n');
      const env = { PATH: dir };
      const result = resolveTool('claude', { env, platform: 'win32', repoDir: repoRoot });
      expect(result.status).toBe('tool-not-spawnable');
    } finally {
      await removeFixture(dir);
    }
  });

  it('on win32, an unrelated file sharing the base name does not shadow a real match later on PATH', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-unrelated-'));
    try {
      await writeFile(path.join(dir, 'claude.txt'), 'not a tool');
      const env = { PATH: dir };
      const result = resolveTool('claude', { env, platform: 'win32', repoDir: repoRoot });
      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(dir);
    }
  });

  it('resolves a tool when env spells the PATH variable "Path" — win32\'s own convention, read case-insensitively (gate cycle 2, blocker 6)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-pathcase-'));
    try {
      await writeFile(path.join(dir, 'claude.exe'), 'legit');
      const env = { Path: dir };
      const result = resolveTool('claude', { env, platform: 'win32', repoDir: repoRoot });
      expect(result.status).toBe('ok');
    } finally {
      await removeFixture(dir);
    }
  });

  it('does NOT read "Path" case-insensitively on a POSIX platform — POSIX env var names are genuinely case-sensitive, so "Path" there is a different, unrelated variable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-pathcase-posix-'));
    try {
      await writeFile(path.join(dir, 'claude'), 'legit');
      const env = { Path: dir }; // NOT "PATH"
      const result = resolveTool('claude', { env, platform: 'linux', repoDir: repoRoot });
      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(dir);
    }
  });
});

describe('resolveTool — tool name grammar', () => {
  it('refuses a tool name carrying a path separator', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-sep-'));
    try {
      const env = { PATH: dir };
      const result = resolveTool('../etc/passwd', {
        env,
        platform: process.platform,
        repoDir: repoRoot,
      });
      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(dir);
    }
  });

  it('TOOL_NAME_PATTERN admits ordinary tool names and refuses separators', () => {
    expect(TOOL_NAME_PATTERN.test('claude')).toBe(true);
    expect(TOOL_NAME_PATTERN.test('claude-code')).toBe(true);
    expect(isValidToolName('claude')).toBe(true);
    expect(isValidToolName('../x')).toBe(false);
    expect(isValidToolName('a/b')).toBe(false);
    expect(isValidToolName('a\\b')).toBe(false);
    expect(isValidToolName('')).toBe(false);
  });
});

describe('resolveTool — declared limits 1 and 2, demonstrated', () => {
  it('LIMIT (TOCTOU, whole-name pointer for limit 1): a file replaced after resolveTool answers but before boundedRun opens it is what actually runs — no atomic resolve-and-exec primitive exists here', async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'this demonstration needs a directly-executable shebang script; win32 has no equivalent without a shell, which boundedRun refuses to use',
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-toctou-'));
    try {
      const toolPath = path.join(dir, 'claude');
      await writeFile(toolPath, '#!/bin/sh\necho first\n');
      await chmod(toolPath, 0o755);

      const env = { PATH: dir };
      const resolved = resolveTool('claude', {
        env,
        platform: process.platform,
        repoDir: repoRoot,
      });
      expect(resolved.status).toBe('ok');
      if (resolved.status !== 'ok') return;

      // Replace the file's content in place — same path, different bytes
      // — between resolveTool's answer and boundedRun's own open.
      await writeFile(toolPath, '#!/bin/sh\necho second\n');
      await chmod(toolPath, 0o755);

      const result = await boundedRun(resolved.absFile, [], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        repoDir: repoRoot,
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.stdout.trim()).toBe('second');
    } finally {
      await removeFixture(dir);
    }
  });

  it('LIMIT (whole-name pointer for limit 2): a PATH entry outside the repository that is world-writable resolves ok — this module checks only "inside the repository", never "writable by someone else"', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-writable-'));
    try {
      const toolName = process.platform === 'win32' ? 'claude.exe' : 'claude';
      await writeFile(path.join(dir, toolName), 'legit');
      if (process.platform !== 'win32') await chmod(dir, 0o777); // genuinely world-writable
      const env = { PATH: dir };
      const result = resolveTool('claude', { env, platform: process.platform, repoDir: repoRoot });
      expect(result.status).toBe('ok');
    } finally {
      await removeFixture(dir);
    }
  });

  it('LIMIT (whole-name pointer for limit 9): boundedRun applies no containment check to absFile itself, only to cwd — an absolute file path genuinely INSIDE repoDir runs anyway when handed directly to boundedRun (bypassing resolveTool, which is what actually provides that guarantee)', async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'this demonstration needs a directly-executable shebang script; win32 has no equivalent without a shell, which boundedRun refuses to use',
    );
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-nocontainment-repo-'));
    try {
      const toolPath = path.join(fakeRepo, 'inside-tool');
      await writeFile(toolPath, '#!/bin/sh\necho ran-from-inside-the-repo\n');
      await chmod(toolPath, 0o755);

      const result = await boundedRun(toolPath, [], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        repoDir: fakeRepo,
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.stdout.trim()).toBe('ran-from-inside-the-repo');
    } finally {
      await removeFixture(fakeRepo);
    }
  });

  it("LIMIT (whole-name pointer for limit 14): a hardlink OUTSIDE the repository to a file planted INSIDE it resolves ok — this module's containment checks are path-based, never content/inode-based, and a hardlink's own path genuinely is outside", async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'hardlink creation semantics vary too much on win32 for this pin; the property is demonstrated on POSIX',
    );
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-hardlink-repo-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-hardlink-outside-'));
    try {
      const { link: linkP } = await import('node:fs/promises');
      const insideTarget = path.join(fakeRepo, 'claude');
      const outsideHardlink = path.join(outside, 'claude');
      await writeFile(insideTarget, '#!/bin/sh\necho hardlinked\n');
      await chmod(insideTarget, 0o755);
      try {
        await linkP(insideTarget, outsideHardlink);
      } catch (error) {
        ctx.skip(
          `hardlink creation failed on this filesystem (${(error as Error).message}) — cannot construct this scenario here`,
        );
        return;
      }

      const env = { PATH: outside };
      const result = resolveTool('claude', { env, platform: process.platform, repoDir: fakeRepo });
      expect(result.status).toBe('ok');
    } finally {
      await removeFixture(fakeRepo);
      await removeFixture(outside);
    }
  });
});

describe('boundedRun — refuses a non-absolute file, never shells out', () => {
  it('refuses a relative absFile with spawn-error, without ever spawning anything', async () => {
    const result = await boundedRun('relative/file', [], {
      timeoutMs: 1000,
      maxBuffer: 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('spawn-error');
  });

  it('refuses a relative absFile that genuinely WOULD run if spawned — proving the guard runs before any spawn attempt', async () => {
    // A relative path that does not exist would fail with ENOENT either way,
    // telling nothing apart. Built as GENUINELY relative via boundedRun's own
    // `cwd` option (rather than `path.relative(process.cwd(), …)`, which can
    // fail across drive letters on win32) — an explicit `.` + separator +
    // basename of a real, runnable file, resolved against its own directory
    // as cwd — so a passing test proves the absolute-path guard fires BEFORE
    // execFile ever runs, not that the OS happened to fail to find it (gate
    // cycle 1, blocker 5: the previous fixture used a bare
    // `if (path.isAbsolute(...)) return;`; gate cycle 2 advisory: the
    // leading `.${path.sep}` removes any ambiguity about whether this is
    // "relative" in the first place).
    const relFile = `.${path.sep}${path.basename(process.execPath)}`;
    const dir = path.dirname(process.execPath);
    const result = await boundedRun(relFile, ['--version'], {
      timeoutMs: 5000,
      maxBuffer: 1024,
      cwd: dir,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('spawn-error');
  });
});

describe('boundedRun — refuses an invalid deadline or output cap before any spawn attempt', () => {
  it.each([
    ['timeoutMs of 0', { timeoutMs: 0, maxBuffer: 1024 }],
    ['a negative timeoutMs', { timeoutMs: -1, maxBuffer: 1024 }],
    ['a NaN timeoutMs', { timeoutMs: NaN, maxBuffer: 1024 }],
    ['an infinite timeoutMs', { timeoutMs: Infinity, maxBuffer: 1024 }],
    [
      "a timeoutMs beyond Node's own setTimeout ceiling (2^31 - 1)",
      { timeoutMs: 2_147_483_648, maxBuffer: 1024 },
    ],
    ['maxBuffer of 0', { timeoutMs: 5000, maxBuffer: 0 }],
    ['a negative maxBuffer', { timeoutMs: 5000, maxBuffer: -1 }],
    ['a NaN maxBuffer', { timeoutMs: 5000, maxBuffer: NaN }],
    ['an infinite maxBuffer', { timeoutMs: 5000, maxBuffer: Infinity }],
    [
      'a maxBuffer beyond the 1 GiB sanity ceiling',
      { timeoutMs: 5000, maxBuffer: 1024 * 1024 * 1024 + 1 },
    ],
  ])(
    'refuses %s with a fixed spawn-error message and code, before any spawn attempt',
    async (_label, bounds) => {
      const result = await boundedRun(process.execPath, ['--version'], {
        ...bounds,
        repoDir: repoRoot,
      });
      expect(result.status).toBe('spawn-error');
      if (result.status !== 'spawn-error') return;
      expect(result.code).toBe('ERR_INVALID_ARG_VALUE');
      expect(result.message).toBe(
        'boundedRun requires a positive, finite, bounded timeoutMs and maxBuffer',
      );
    },
  );

  it("accepts a maxBuffer exactly at the 1 GiB sanity ceiling and a timeoutMs exactly at Node's own setTimeout ceiling — the boundary itself is valid, only what is STRICTLY beyond it is refused", async () => {
    const result = await boundedRun(process.execPath, ['--version'], {
      timeoutMs: 2_147_483_647,
      maxBuffer: 1024 * 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
  });
});

describe('boundedRun — synchronous spawn failures never reject the promise', () => {
  it('a NUL byte embedded in an argv element resolves spawn-error rather than rejecting (gate cycle 1, blocker 1)', async () => {
    const result = await boundedRun(process.execPath, ['a\0b'], {
      timeoutMs: 2000,
      maxBuffer: 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('spawn-error');
  });

  it('on win32, spawning a .cmd file directly (shell:false) resolves spawn-error rather than throwing — measured on Node 24.18.0 win32 to throw EINVAL synchronously', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const dir = await mkdtemp(path.join(tmpdir(), 'rig-exec-cmd-spawn-'));
    try {
      const cmdFile = path.join(dir, 'tool.cmd');
      await writeFile(cmdFile, '@echo off\r\necho hi\r\n');
      const result = await boundedRun(cmdFile, [], {
        timeoutMs: 2000,
        maxBuffer: 1024,
        repoDir: repoRoot,
      });
      expect(result.status).toBe('spawn-error');
    } finally {
      await removeFixture(dir);
    }
  });

  it('a spawn-error never forwards the raw Node error message (which embeds an absolute path)', async () => {
    const missing = path.join(workDir, 'definitely-does-not-exist-binary');
    const result = await boundedRun(missing, [], {
      timeoutMs: 2000,
      maxBuffer: 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('spawn-error');
    if (result.status !== 'spawn-error') return;
    expect(result.message).not.toContain(missing);
    expect(result.message).not.toContain(workDir);
  });

  it("a missing executable's spawn-error carries the ENOENT code (gate cycle 2 advisory: .code was never asserted anywhere)", async () => {
    const missing = path.join(workDir, 'definitely-does-not-exist-binary');
    const result = await boundedRun(missing, [], {
      timeoutMs: 2000,
      maxBuffer: 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('spawn-error');
    if (result.status !== 'spawn-error') return;
    expect(result.code).toBe('ENOENT');
  });
});

describe('boundedRun — cwd validation and default', () => {
  it("defaults the child's cwd to a directory outside the repository, never the inherited process.cwd() (which, during this suite, IS inside the repository)", async () => {
    const script = 'process.stdout.write(process.cwd());';
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // `.native`, not the plain JS realpath, for the SAME reason as the
    // repo-containment oracle above: the plain implementation does not
    // expand an 8.3 short-name path component, and this module's own
    // per-run cwd is built and passed through `.native` internally — a
    // windows-smoke TEMP root spelled short (`RUNNER~1`) made a plain-realpath
    // oracle disagree with the module's own (correctly long-form) answer
    // (gate cycle 3: this is the same class of bug as gate cycle 2's fix to
    // "never resolves a tool from inside the repository…", just not carried
    // over to this test when the per-run cwd was introduced).
    const { realpathSync } = await import('node:fs');
    expect(result.stdout).not.toBe(realpathSync.native(process.cwd()));
    expect(result.stdout.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  });

  it('the default cwd is a FRESH, per-run directory — not os.tmpdir() itself — and no longer exists once the run ends (gate cycle 2 advisory: os.tmpdir() is shared and world-writable)', async () => {
    const script = 'process.stdout.write(process.cwd());';
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const { realpathSync } = await import('node:fs');
    expect(result.stdout).not.toBe(realpathSync.native(tmpdir()));
    expect(existsSync(result.stdout)).toBe(false);
  });

  it('refuses a cwd that IS the repository root, resolving spawn-error before any spawn attempt', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-cwdrepo-'));
    try {
      const result = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        cwd: fakeRepo,
        repoDir: fakeRepo,
      });
      expect(result.status).toBe('spawn-error');
    } finally {
      await removeFixture(fakeRepo);
    }
  });

  it('refuses a cwd that is a SUBDIRECTORY of the repository, not only the repository root itself', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-cwdrepo-sub-'));
    const sub = path.join(fakeRepo, 'nested', 'dir');
    try {
      await mkdir(sub, { recursive: true });
      const result = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        cwd: sub,
        repoDir: fakeRepo,
      });
      expect(result.status).toBe('spawn-error');
    } finally {
      await removeFixture(fakeRepo);
    }
  });

  it('a cwd that is a symlink pointing INTO the repository is refused — this module realpaths the cwd (through any symlink) before the containment check, so a symlink chain is not a gap here (gate cycle 2, blocker 7: an earlier version of this limit claimed the opposite, that a symlink chain was not walked — that was never true of the realpath-based check already here, and the claim is corrected rather than repeated)', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-cwdsymlink-repo-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-cwdsymlink-outside-'));
    const cwdLink = path.join(outside, 'cwd-link');
    try {
      await symlinkP(fakeRepo, cwdLink, 'dir');
      const result = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        cwd: cwdLink,
        repoDir: fakeRepo,
      });
      expect(result.status).toBe('spawn-error');
    } finally {
      await removeFixture(outside);
      await removeFixture(fakeRepo);
    }
  });

  it('accepts a cwd genuinely outside the repository', async () => {
    const fakeRepo = await mkdtemp(path.join(tmpdir(), 'rig-exec-cwdrepo-outside-'));
    const outsideCwd = await mkdtemp(path.join(tmpdir(), 'rig-exec-cwd-outside-'));
    try {
      const result = await boundedRun(process.execPath, ['--version'], {
        timeoutMs: 5000,
        maxBuffer: 1024,
        cwd: outsideCwd,
        repoDir: fakeRepo,
      });
      expect(result.status).toBe('ok');
    } finally {
      await removeFixture(fakeRepo);
      await removeFixture(outsideCwd);
    }
  });
});

describe('boundedRun — is TOTAL end to end, even when owning and cleaning up its own per-run cwd (gate cycle 3, blocker 1)', () => {
  it('a non-existent tempRoot resolves spawn-error rather than rejecting — on every platform (mkdtemp used to sit outside any try/catch)', async () => {
    const bogusRoot = path.join(
      tmpdir(),
      `rig-exec-bogus-root-does-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const result = await boundedRun(process.execPath, ['--version'], {
      timeoutMs: 5000,
      maxBuffer: 1024,
      repoDir: repoRoot,
      tempRoot: bogusRoot,
    });
    expect(result.status).toBe('spawn-error');
  });

  it('the default per-run cwd is created with mode 0700, verified from INSIDE the child process (POSIX)', async (ctx) => {
    skipUnless(ctx, process.platform !== 'win32', 'POSIX mode bits only');
    const script =
      'process.stdout.write(String(require("fs").statSync(process.cwd()).mode & 0o777));';
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(Number(result.stdout)).toBe(0o700);
  });

  it('the per-run cwd is removed even when the run times out', async () => {
    const script = 'process.stdout.write(process.cwd()); setTimeout(() => {}, 60000);';
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 2000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('timeout');
    if (result.status === 'timeout') {
      // The script's own precondition: stdout must genuinely carry the cwd
      // path this test then checks was removed — an empty string would make
      // `existsSync('')` a vacuous pass rather than proof of anything
      // (gate cycle 4 advisory).
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(existsSync(result.stdout)).toBe(false);
      expect(result.cwdCleanup).toBeUndefined();
    }
  });

  it("on win32, a detached grandchild left holding the per-run cwd as ITS OWN cwd makes cleanup fail, and boundedRun still RESOLVES ok with cwdCleanup: 'left-behind' — never a rejection, never a path in the result", async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const script = `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 120000);'], {
        detached: true,
        stdio: 'ignore',
      });
      gc.unref();
      process.stdout.write(gc.pid + '\\n' + process.cwd());
      process.exit(0);
    `;
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Both the parse/definedness assertions AND the substantive ones now
    // live inside the SAME try, with the grandchild kill and directory
    // cleanup in a finally that covers ALL of them (gate cycle 4 advisory:
    // a failed FIRST expect used to sit outside the try/finally entirely,
    // so failing it would skip cleanup of the still-live grandchild process
    // this test itself spawned).
    const [pidText, dir] = result.stdout.split('\n');
    try {
      expect(pidText).toBeDefined();
      expect(dir).toBeDefined();
      if (pidText === undefined || dir === undefined) return;
      expect(result.cwdCleanup).toBe('left-behind');
      expect(existsSync(dir)).toBe(true);
      // Per FIELD the module owns, in both the raw and JSON-escaped
      // spellings (gate cycle 4, blocker 4: `JSON.stringify(result).not
      // .toContain(dir)` cannot fail on win32 — JSON.stringify doubles each
      // backslash, so a leak landing in a field via `JSON.stringify` would
      // carry the ESCAPED form, which the raw-`dir` needle never matches).
      // `stdout`/`stderr` are excluded: those are the CHILD's own output,
      // not a field this module itself writes a path into.
      const forbiddenRaw = dir;
      const forbiddenEscaped = dir.replace(/\\/g, '\\\\');
      for (const [key, value] of Object.entries(result)) {
        if (key === 'stdout' || key === 'stderr') continue;
        if (typeof value !== 'string') continue;
        expect(value, `field "${key}" leaked the cwd path (raw)`).not.toContain(forbiddenRaw);
        expect(value, `field "${key}" leaked the cwd path (JSON-escaped)`).not.toContain(
          forbiddenEscaped,
        );
      }
    } finally {
      if (pidText !== undefined) {
        try {
          process.kill(Number(pidText));
        } catch {
          // best effort — this is test cleanup, not the module under test
        }
      }
      if (dir !== undefined) {
        await removeFixture(dir);
      }
    }
  });

  it('on POSIX, the same "detached grandchild inherits the per-run cwd as its own cwd" scenario still results in successful removal — POSIX does not lock a directory a live process merely has as cwd, unlike win32 (contrasts with the win32-only test above)', async (ctx) => {
    skipUnless(ctx, process.platform !== 'win32', 'this contrasts with the win32-only test above');
    const script = `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 5000);'], {
        detached: true,
        stdio: 'ignore',
      });
      gc.unref();
      process.stdout.write(gc.pid + '\\n' + process.cwd());
      process.exit(0);
    `;
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [pidText, dir] = result.stdout.split('\n');
    expect(pidText).toBeDefined();
    expect(dir).toBeDefined();
    if (pidText === undefined || dir === undefined) return;
    try {
      expect(result.cwdCleanup).toBeUndefined();
      expect(existsSync(dir)).toBe(false);
    } finally {
      try {
        process.kill(Number(pidText));
      } catch {
        // already gone, or never really needed killing on this platform
      }
    }
  });
});

describe('boundedRun — environment allow-list', () => {
  it('passes only allow-listed environment to the child', async () => {
    // Independent oracle: this literal list is NOT imported from the module
    // under test as the assertion set, so a mutation widening the exported
    // ALLOWED_ENV_VARS would still be caught here.
    const EXPECTED_ALLOWED = new Set([
      'PATH',
      'HOME',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'TEMP',
      'TMP',
      'SystemRoot',
      'ComSpec',
      'LANG',
      'LC_ALL',
    ]);
    // Platform-independent: a plain equality between two literal-defined
    // sets, unaffected by anything the OS injects — this does not belong
    // behind the win32 guard below (gate cycle 2 advisory).
    expect(new Set(ALLOWED_ENV_VARS)).toEqual(EXPECTED_ALLOWED);

    const candidateEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '/home/whoever',
      SECRET_TOKEN: 'sekret-value',
      NODE_OPTIONS: '--some-flag',
      RANDOM_VAR: 'leak-me-not',
    };

    const script = 'process.stdout.write(JSON.stringify(process.env));';
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      env: candidateEnv,
      repoDir: repoRoot,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    // Platform-independent, and the actual security property: whatever this
    // module filters OUT must never reach the child, regardless of platform.
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'SECRET_TOKEN')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'RANDOM_VAR')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'NODE_OPTIONS')).toBe(false);
    // The positive, exact-membership check only holds on a platform where
    // nothing outside this module's own filtering can add a key — measured
    // false on win32 (see the dedicated win32 test below: the OS forces in
    // more than this module ever put in the filtered block it built and
    // passed). The allow-list is a floor for what this module deliberately
    // forwards, never a ceiling the OS enforces beneath it — see this
    // module's own header limits. Keeping the strict check on every OTHER
    // platform is what still lets a mutation widening the filter (e.g.
    // letting NODE_OPTIONS through) get caught here rather than only by the
    // three explicit negative assertions above.
    if (process.platform !== 'win32') {
      for (const key of Object.keys(childEnv)) {
        expect(EXPECTED_ALLOWED.has(key), `unexpected env key reached the child: ${key}`).toBe(
          true,
        );
      }
    }
  });

  it("boundedRun called with no env option at all hands the child NOTHING — default-deny, never an accidental inherit (gate cycle 2 advisory; gate cycle 3, blocker 4: the only assertion here used to sit inside an `if (platform !== win32)` guard, so this test reported PASS on win32 with nothing checked at all; gate cycle 4, blocker 3: that fix's sentinel, a NON-allow-listed key, could never fail for the regression it names — filterAllowedEnv strips a non-allow-listed key regardless of whether the default source is `{}` or `process.env`, so the sentinel proved nothing on ANY platform. LC_ALL is allow-listed (see ALLOWED_ENV_VARS): measured to discriminate — undefined in the child at this head, and it WOULD leak through if the default ever regressed to `options.env ?? process.env`, since filterAllowedEnv would then forward it like any other allow-listed key)", async () => {
    // A sentinel set on THIS process's own env, under an ALLOW-LISTED key —
    // boundedRun with no `env` option never reads `process.env` at all today
    // (it defaults to `{}`), so this sentinel proves nothing UNLESS a future
    // change regresses that default to `options.env ?? process.env`. Because
    // LC_ALL is itself allow-listed, that regression WOULD leak it through
    // filterAllowedEnv — a non-allow-listed sentinel would be stripped either
    // way and could never discriminate the two.
    const sentinelKey = 'LC_ALL';
    const previous = process.env[sentinelKey];
    process.env[sentinelKey] = 'must-not-leak-into-the-child';
    try {
      const script = 'process.stdout.write(JSON.stringify(process.env));';
      const result = await boundedRun(process.execPath, ['-e', script], {
        timeoutMs: 5000,
        maxBuffer: 1024 * 1024,
        repoDir: repoRoot,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      expect(Object.prototype.hasOwnProperty.call(childEnv, sentinelKey)).toBe(false);
      if (process.platform !== 'win32') {
        expect(Object.keys(childEnv)).toEqual([]);
      }
    } finally {
      if (previous === undefined) delete process.env[sentinelKey];
      else process.env[sentinelKey] = previous;
    }
  });

  it('on win32, HOMEDRIVE/HOMEPATH reach the child even though this module never allow-listed them for THIS call — but the OS adds strictly more than those two (measured on windows-smoke: LOGONSERVER also arrives), so this asserts presence/absence, never a closed set (gate cycle 1, blocker 8: the prior wording claimed this was "observed" on CI with nothing in-tree asserting it; gate cycle 2 fallout: an earlier version of this very test wrongly asserted the child env was EXACTLY ALLOWED_ENV_VARS plus those two keys, and LOGONSERVER promptly falsified it)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const candidateEnv: NodeJS.ProcessEnv = { ...process.env, SECRET_TOKEN: 'sekret-value' };
    const script = 'process.stdout.write(JSON.stringify(process.env));';
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      env: candidateEnv,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'HOMEDRIVE')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'HOMEPATH')).toBe(true);
    // The actual security property, unaffected by whatever else the OS
    // injects: nothing this module was HANDED and did not allow-list ever
    // reaches the child.
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'SECRET_TOKEN')).toBe(false);
  });

  it('on win32, the child sees EXACTLY the PATH value the caller supplied under "Path" (gate cycle 2, blocker 6; gate cycle 3 advisory: this used to assert only length > 0, which a mutation truncating or corrupting the forwarded value would not catch)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const sourcePath = process.env.PATH ?? process.env.Path ?? '';
    expect(sourcePath.length).toBeGreaterThan(0); // the fixture's own precondition
    const candidateEnv: NodeJS.ProcessEnv = { Path: sourcePath };
    const script = 'process.stdout.write(process.env.PATH || "");';
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      env: candidateEnv,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.stdout).toBe(sourcePath);
  });
});

describe('boundedRun — deadline', () => {
  it('kills a child that outlives its deadline and classifies it as timeout', async () => {
    const script = 'setTimeout(() => {}, 60000);'; // outlives the deadline
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 2000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('timeout');
  });

  it('a child exiting on its own inside the deadline is not classified as timeout', async () => {
    const result = await boundedRun(process.execPath, ['-e', 'process.exit(0);'], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
  });

  it('a nonzero exit inside the deadline is classified as nonzero-exit, not timeout', async () => {
    const result = await boundedRun(process.execPath, ['-e', 'process.exit(3);'], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('nonzero-exit');
    if (result.status === 'nonzero-exit') expect(result.code).toBe(3);
  });

  it('a missing executable is classified as spawn-error, not timeout or nonzero-exit', async () => {
    const missing = path.join(workDir, 'definitely-does-not-exist-binary');
    const result = await boundedRun(missing, [], {
      timeoutMs: 2000,
      maxBuffer: 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('spawn-error');
  });

  // Stated limit, measured rather than assumed: SIGKILL on the direct child
  // does not reach a DETACHED grandchild process on Linux. This is not a bug
  // in boundedRun to fix here — it is the documented edge of "kills a child",
  // proven so the header comment's claim is backed by a test rather than
  // prose alone. The grandchild writes its marker only AFTER the parent's
  // own deadline has already fired — a MULTI-SECOND deadline this round
  // (gate cycle 2, blocker 4: a 200ms deadline was too tight for hosted
  // Windows timing precision, which logged 314ms elapsed against a 300ms
  // deadline elsewhere in this same suite).
  it("LIMIT (measured on this platform): a detached grandchild survives the timeout kill because it writes its marker only AFTER the parent's own deadline has already fired (skipped on win32: a separate, weaker claim holds there — see this module's header comment)", async (ctx) => {
    skipUnless(ctx, process.platform !== 'win32', 'POSIX signal semantics only');
    const marker = path.join(workDir, 'grandchild-survived.txt');
    const deadlineMs = 2000;
    const grandchildDelayMs = deadlineMs + 1500; // strictly, and generously, after the deadline
    // Built via JSON.stringify at each nesting level, never by hand-nesting
    // quote characters — a marker path embedded the naive way (a raw ${...}
    // inside an already-quoted inner string) is exactly how the first draft
    // of this test broke: an unescaped quote in the path terminated the
    // inner string early and the "grandchild" process failed with a syntax
    // error instead of running, which this test could not have told apart
    // from "grandchild never even got a chance to survive".
    const script = `
      const { spawn } = require('node:child_process');
      const marker = ${JSON.stringify(marker)};
      const delayMs = ${grandchildDelayMs};
      const inner = 'setTimeout(function(){' +
        'require(' + JSON.stringify('fs') + ').writeFileSync(' + JSON.stringify(marker) + ", 'alive');" +
        '}, ' + delayMs + ');';
      const gc = spawn(process.execPath, ['-e', inner], { detached: true, stdio: 'ignore' });
      gc.unref();
      setTimeout(function(){}, 60000);
    `;
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: deadlineMs,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('timeout');

    const seen = await pollUntil(() => existsSync(marker), grandchildDelayMs + 3000);
    expect(seen).toBe(true); // the measured, undesirable-but-real outcome
  });

  // A SECOND, weaker limit than the one above: a detached grandchild that
  // inherits the direct child's stdout FILE DESCRIPTOR (rather than merely
  // outliving it) keeps that pipe open after the direct child exits, which
  // delays — but, measured on Linux, does not truncate or corrupt — the
  // output the direct child already wrote. Measured directly (see the
  // elapsed-time assertion below): execFile's callback did not fire until
  // the grandchild's own, later timer completed, ~1.5s after the direct
  // child had already called `process.exit(0)`.
  it('LIMIT (measured on this platform): a detached grandchild inheriting the stdout file descriptor delays, but does not truncate, output the direct child already wrote before exiting (skipped on win32: not measured there)', async (ctx) => {
    skipUnless(ctx, process.platform !== 'win32', 'POSIX signal semantics only');
    const grandchildDelayMs = 1500;
    const script = `
      const { spawn } = require('node:child_process');
      process.stdout.write('from-parent');
      const gc = spawn(process.execPath, ['-e', 'setTimeout(function(){}, ${grandchildDelayMs});'], {
        detached: true,
        stdio: ['ignore', 1, 'ignore'],
      });
      gc.unref();
      process.exit(0);
    `;
    const start = Date.now();
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 10000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    const elapsed = Date.now() - start;
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.stdout).toBe('from-parent');
    // Generously below the grandchild's own delay, so ordinary scheduling
    // jitter cannot make this flaky — the point is "genuinely waited", not
    // "waited exactly as long as the grandchild".
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  });

  it("a child killed by an external signal (not by boundedRun's own deadline) is classified killed-by-signal, with its already-produced output kept (gate cycle 1, blocker 2)", async (ctx) => {
    skipUnless(ctx, process.platform !== 'win32', 'POSIX signal semantics only');
    const marker = path.join(workDir, 'pid.txt');
    const ready = path.join(workDir, 'ready.txt');
    // Writing the pid marker immediately after the stdout write is not
    // enough on its own: the two statements are adjacent and synchronous
    // in the CHILD, but that says nothing about when the bytes already
    // sitting in the OS pipe become externally observable as "definitely
    // delivered" — killing the child the instant this test's own poll
    // notices the pid marker raced the pipe's own delivery once, under
    // load, and lost the output (gate cycle 2 fallout: `result.stdout`
    // came back `''`). The child instead waits a further 150ms of its own
    // (a budget, not a proof — this is unavoidably a real-clock handshake
    // for a real OS pipe) after the stdout write before writing a SECOND,
    // separate marker; this test polls for THAT one, never a fixed sleep
    // in its own control flow.
    const script = `
      require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      process.stdout.write('before-signal');
      setTimeout(function(){
        require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
      }, 150);
      setTimeout(function(){}, 60000);
    `;
    const resultPromise = boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 10000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });

    // Poll for the READY marker (written 150ms after the stdout write),
    // never a fixed sleep in this test's own control flow.
    const isReady = await pollUntil(() => existsSync(ready), 5000);
    expect(isReady).toBe(true);
    const pidText = readFileSync(marker, 'utf8');
    expect(pidText).not.toBe('');

    process.kill(Number(pidText), 'SIGTERM');
    const result = await resultPromise;
    expect(result.status).toBe('killed-by-signal');
    if (result.status === 'killed-by-signal') {
      expect(result.signal).toBe('SIGTERM');
      expect(result.stdout).toBe('before-signal');
    }
  });
});

describe('boundedRun — output cap', () => {
  it('classifies output above the cap as output-exceeded and parses none of it', async () => {
    const script = "process.stdout.write('x'.repeat(200000));";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024, // far below the 200000 bytes written
      repoDir: repoRoot,
    });
    expect(result.status).toBe('output-exceeded');
    expect((result as { stdout?: string }).stdout).toBeUndefined();
  });

  it('output under the cap is returned in full', async () => {
    const script = "process.stdout.write('hello');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.stdout).toBe('hello');
  });
});

describe('boundedRun — output sanitization', () => {
  it('strips control characters from stdout and stderr', async () => {
    const script = "process.stdout.write('a\\u0007b\\u001bc'); process.stderr.write('d\\u0007e');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stdout).toBe('abc');
    expect(result.stderr).toBe('de');
  });

  it('preserves \\n and \\t, which are ordinary in captured process output', async () => {
    const script = "process.stdout.write('a\\nb\\tc');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stdout).toBe('a\nb\tc');
  });

  it("strips a Unicode bidi override character — the same class ../lib/safe-text.js's hasControlCharacter refuses in a committed JSON field (one shared predicate, gate cycle 1 advisory)", async () => {
    const script = "process.stdout.write('a\\u202Eb');"; // U+202E RIGHT-TO-LEFT OVERRIDE (Cf)
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stdout).toBe('ab');
  });

  it('strips the two Unicode line separators (U+2028, U+2029)', async () => {
    const script = "process.stdout.write('a\\u2028b\\u2029c');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stdout).toBe('abc');
  });

  it('strips DEL (0x7f), the full C1 control range (0x7f-0x9f) — now including its own two BOUNDARY points U+0085 (NEL) and U+009F (APC), not just an interior sample (U+009B) — and the low-range controls \\x05 and \\x1f (gate cycle 2, blocker 5: this range was implemented but never asserted; gate cycle 3 advisory: widened to include \\^E/\\^_; gate cycle 4 advisory: the title claimed "full range" while only sampling one interior C1 point — \\x05/\\x1f are LOW-range ASCII controls, 0x00-0x1F, not C1 at all — so this now also samples the C1 range\'s own two edges)', async () => {
    const script =
      "process.stdout.write('a\\u007fb\\u009bc\\u001bd\\u0005e\\u001ff\\u0085g\\u009fh');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stdout).toBe('abcdefgh');
  });

  it('never splits a surrogate pair when capping the stderr tail, even if the result ends up one code unit shorter than the cap (gate cycle 3 advisory)', async () => {
    const prefix = 'a'.repeat(10);
    const astral = '\u{1F600}'; // one astral code point = a surrogate pair (2 UTF-16 code units)
    const suffix = 'b'.repeat(MAX_STDERR_TAIL_CHARS - 1);
    const payload = prefix + astral + suffix; // the cap boundary lands exactly on the low surrogate
    const script = `process.stderr.write(${JSON.stringify(payload)});`;
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const firstCode = result.stderr.charCodeAt(0);
    expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
    expect(result.stderr).toBe(suffix);
  });

  it('LIMIT: argv elements are passed through completely unvalidated — a caller must not rely on this module to sanitize its own arguments (gate cycle 3 advisory)', async () => {
    // `node -e <script> <extra…>` puts the extra arguments starting at
    // `process.argv[1]` — there is no script FILE path to occupy that slot
    // the way an ordinary `node file.js arg` invocation would. The fixture
    // avoids a LEADING `--`, which node -e's own CLI parser tries to
    // interpret as a node option (measured: `node -e script --foo` fails
    // with "bad option", never even reaching the script) — an unrelated
    // Node quirk, not what this limit is about.
    const script = 'process.stdout.write(process.argv[1]);';
    const weird = '; rm -rf / # shell-metacharacter-shaped, never interpreted by a shell here';
    const result = await boundedRun(process.execPath, ['-e', script, weird], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.stdout).toBe(weird);
  });

  it('caps the stderr tail to MAX_STDERR_TAIL_CHARS, keeping the END of the stream and dropping the head (gate cycle 1, blocker 6: the previous fixture was 13 characters against a 4096 cap and never reached it)', async () => {
    const payload = `H${'a'.repeat(5000)}END`;
    const script = `process.stderr.write(${JSON.stringify(payload)});`;
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Independent oracle, not derived from the module's own constant: this
    // module documents its cap as 4096 (see MAX_STDERR_TAIL_CHARS's own
    // definition), so a mutation shrinking or enlarging that literal without
    // updating this hardcoded expectation is still caught.
    expect(MAX_STDERR_TAIL_CHARS).toBe(4096);
    expect(result.stderr).toHaveLength(4096);
    expect(result.stderr.endsWith('END')).toBe(true);
    expect(result.stderr.startsWith('H')).toBe(false);
  });

  it('stderr under the cap is returned in full, with the head intact', async () => {
    const script = "process.stderr.write('a'.repeat(10) + 'END');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stderr).toBe(`${'a'.repeat(10)}END`);
  });

  it('output-exceeded is reported even when the excess arrives on stderr, and captures none of it', async () => {
    const script = "process.stderr.write('e'.repeat(200000));";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('output-exceeded');
  });

  it('partial output produced before a timeout is still returned, sanitized the same way', async () => {
    const script = "process.stdout.write('partial-\\u0007out'); setTimeout(() => {}, 60000);";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 2000,
      maxBuffer: 1024 * 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('timeout');
    if (result.status === 'timeout') expect(result.stdout).toBe('partial-out');
  });
});

describe('declared limit: captured output is not redacted for secrets', () => {
  const walkForUnboundedStrings = (node: unknown, keyPath: string, offenders: string[]): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) =>
        walkForUnboundedStrings(item, `${keyPath}[${index}]`, offenders),
      );
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    const isBounded =
      typeof obj.pattern === 'string' || obj.const !== undefined || Array.isArray(obj.enum);
    if (obj.type === 'string' && !isBounded) {
      offenders.push(keyPath);
    }
    for (const [key, value] of Object.entries(obj)) {
      walkForUnboundedStrings(value, `${keyPath}.${key}`, offenders);
    }
  };

  it('the receipt schema has no property that could hold raw captured stdout/stderr text — every string property is pattern-, const-, or enum-bounded', async () => {
    const schemaPath = path.join(
      repoRoot,
      'contracts',
      'integrations',
      'v1',
      'receipt.schema.json',
    );
    const schema: unknown = JSON.parse(await readFile(schemaPath, 'utf8'));
    expect((schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    const offenders: string[] = [];
    walkForUnboundedStrings(schema, 'schema', offenders);
    expect(offenders, 'an unconstrained free-text string property').toEqual([]);
  });
});

describe('structural: integrations/ contains no shell option and no exec( call', () => {
  it('no file under src/integrations/ sets shell to anything but false, calls a bare exec( or execSync(, or does a recursive readdir (gate cycle 3 advisory: widened from a literal shell: true / bare exec( check)', async () => {
    const dir = path.join(repoRoot, 'packages', 'cli', 'src', 'integrations');
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    // A negative lookbehind for the dot excludes `something.exec(` (a
    // RegExp/String method call, e.g. `ISO_TIMESTAMP_PATTERN.exec(value)`,
    // legitimately used in receipt.ts/registry.ts) while still catching a
    // bare `exec(`/`execSync(` call — the shape `child_process.exec(...)`
    // would take — and `require('node:child_process').exec(`.
    const BARE_EXEC = /(?<!\.)\bexec(Sync)?\s*\(/;
    // Anything assigned to `shell:` OTHER than the literal `false` — not
    // just the literal `true` this used to check for alone.
    const SHELL_NOT_FALSE = /shell\s*:\s*(?!false\b)\S/;
    const RECURSIVE_READDIR = /readdir(Sync)?\s*\([^)]*recursive/s;
    for (const file of files) {
      const code = stripComments(await readFile(path.join(dir, file), 'utf8'));
      expect(code, file).not.toMatch(SHELL_NOT_FALSE);
      expect(code, file).not.toMatch(BARE_EXEC);
      expect(code, file).not.toMatch(RECURSIVE_READDIR);
    }
  });
});
