import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink as symlinkP, writeFile } from 'node:fs/promises';
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
  isInside,
  isValidToolName,
  resolveTool,
  splitPathVar,
} from '../src/integrations/exec.js';
import { stripComments } from '../../../test/template/lib/source-scan.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A single flag, computed once, rather than a literal `process.platform`
// comparison inside each `it.skipIf(...)` call below — the latter shape is
// exactly what `test/template/platform-skips.test.ts` refuses (a bare,
// reason-less platform branch that vitest would report as an ordinary PASS).
// `it.skipIf(IS_WIN32)('name (…)', fn)` instead reports a genuine SKIP, with
// the reason carried in the test's own name.
const IS_WIN32 = process.platform === 'win32';

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

  it.skipIf(IS_WIN32)(
    'covers a symlinked PATH entry that points into the repository — both sides are realpath-resolved (skipped on win32: symlinks need elevated rights on most CI runners)',
    async () => {
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
          expect((result as { absFile: string }).absFile.startsWith(repoReal + path.sep)).toBe(
            false,
          );
        }
      } finally {
        await removeFixture(outside);
      }
    },
  );

  // Discriminates the DIRECTORY-level repo-exclusion from the CANDIDATE-file
  // one below: here the PATH entry itself IS the repo root (no symlink
  // needed), but the "tool" inside it is a symlink pointing OUTSIDE the
  // repo. The candidate-level check alone would not refuse this (its
  // realpath is genuinely outside the repo) — only the directory-level check
  // does, because the DIRECTORY a caller would have to search is inside the
  // repository's own working tree, regardless of where a file in it points.
  it.skipIf(IS_WIN32)(
    'refuses a PATH entry that IS the repo root, even when the tool inside it is a symlink pointing outside (skipped on win32: symlinks need elevated rights on most CI runners)',
    async () => {
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
    },
  );

  // The mirror case: discriminates the CANDIDATE-file check from the
  // directory one. The PATH entry is a genuine directory OUTSIDE the repo —
  // the directory-level check has nothing to refuse — but the file it
  // contains is a symlink pointing INTO the repo.
  it.skipIf(IS_WIN32)(
    'refuses a PATH entry outside the repo whose matching file is a symlink pointing into the repo (skipped on win32: symlinks need elevated rights on most CI runners)',
    async () => {
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
    },
  );
});

describe('resolveTool — win32 8.3 short-name canonicalisation', () => {
  it.skipIf(!IS_WIN32)(
    'refuses a PATH entry reachable only through its 8.3 short-name spelling (this test runs only on win32; it further context.skips when the volume has 8dot3 short-name generation disabled)',
    async (context) => {
      const { execFileSync } = await import('node:child_process');
      const longDirName = `rig-exec-8dot3-${'x'.repeat(40)}`;
      const parent = await mkdtemp(path.join(tmpdir(), 'rig-exec-8dot3-parent-'));
      const longDir = path.join(parent, longDirName);
      try {
        await mkdir(longDir, { recursive: true });
        await writeFile(path.join(longDir, 'claude.exe'), 'hostile');

        let shortForm: string;
        try {
          shortForm = execFileSync('cmd.exe', ['/c', `for %A in ("${longDir}") do @echo %~sA`], {
            encoding: 'utf8',
          }).trim();
        } catch {
          context.skip('cmd.exe 8.3-name lookup failed on this host');
          return;
        }

        if (!shortForm || shortForm === longDir || !/~\d/.test(shortForm)) {
          context.skip(
            'this volume does not generate 8.3 short names (8dot3name creation disabled)',
          );
          return;
        }

        const env = { PATH: shortForm };
        const result = resolveTool('claude', { env, platform: 'win32', repoDir: longDir });
        expect(result.status).toBe('tool-not-found');
      } finally {
        await removeFixture(parent);
      }
    },
  );
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

  it('skips an empty PATH entry (which means cwd), never treating it as a match', async () => {
    const unrelated = await mkdtemp(path.join(tmpdir(), 'rig-exec-cwd-'));
    try {
      // No tool file placed anywhere; the point is that the "" entry does not
      // crash and is not treated as "search the current directory".
      const env = { PATH: ['', unrelated].join(path.delimiter) };
      const result = resolveTool('claude', { env, platform: process.platform, repoDir: repoRoot });
      expect(result.status).toBe('tool-not-found');
    } finally {
      await removeFixture(unrelated);
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
    // fail across drive letters on win32) — the basename of a real, runnable
    // file, resolved against its own directory as cwd — so a passing test
    // proves the absolute-path guard fires BEFORE execFile ever runs, not
    // that the OS happened to fail to find it (gate cycle 1, blocker 5: the
    // previous fixture used a bare `if (path.isAbsolute(...)) return;`).
    const relFile = path.basename(process.execPath);
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

describe('boundedRun — synchronous spawn failures never reject the promise', () => {
  it('a NUL byte embedded in an argv element resolves spawn-error rather than rejecting (gate cycle 1, blocker 1)', async () => {
    const result = await boundedRun(process.execPath, ['a\0b'], {
      timeoutMs: 2000,
      maxBuffer: 1024,
      repoDir: repoRoot,
    });
    expect(result.status).toBe('spawn-error');
  });

  it.skipIf(!IS_WIN32)(
    'on win32, spawning a .cmd file directly (shell:false) resolves spawn-error rather than throwing — measured on Node 24.18.0 win32 to throw EINVAL synchronously (this test runs only on win32)',
    async () => {
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
    },
  );

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
    const { realpathSync } = await import('node:fs');
    expect(result.stdout).not.toBe(realpathSync(process.cwd()));
    expect(result.stdout.startsWith(realpathSync(tmpdir()))).toBe(true);
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
    // false on win32 (see the dedicated win32 test below: HOMEDRIVE and
    // HOMEPATH are forced into the child by the OS regardless of the
    // filtered block this module built and passed). The allow-list is a
    // floor for what this module deliberately forwards, never a ceiling the
    // OS enforces beneath it — see this module's own header limits. Keeping
    // the strict check on every OTHER platform is what still lets a
    // mutation widening the filter (e.g. letting NODE_OPTIONS through) get
    // caught here rather than only by the three explicit negative
    // assertions above.
    if (process.platform !== 'win32') {
      for (const key of Object.keys(childEnv)) {
        expect(EXPECTED_ALLOWED.has(key), `unexpected env key reached the child: ${key}`).toBe(
          true,
        );
      }
      // Sanity: this module's OWN exported list matches what the test expects
      // — a second, independent equality check, not the only check above.
      expect(new Set(ALLOWED_ENV_VARS)).toEqual(EXPECTED_ALLOWED);
    }
  });

  it.skipIf(!IS_WIN32)(
    'on win32, HOMEDRIVE/HOMEPATH reach the child even though this module never allow-listed them for THIS call — but the OS adds strictly more than those two (measured on windows-smoke: LOGONSERVER also arrives), so this asserts presence/absence, never a closed set (this test runs only on win32 — gate cycle 1, blocker 8: the prior wording claimed this was "observed" on CI with nothing in-tree asserting it; gate cycle 2 fallout: an earlier version of this very test wrongly asserted the child env was EXACTLY ALLOWED_ENV_VARS plus those two keys, and LOGONSERVER promptly falsified it)',
    async () => {
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
    },
  );
});

describe('boundedRun — deadline', () => {
  it('kills a child that outlives its deadline and classifies it as timeout', async () => {
    const script = 'setTimeout(() => {}, 60000);'; // outlives the 200ms deadline
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 200,
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
  // own deadline has already fired (200ms deadline, a 600ms grandchild
  // delay) — the previous version wrote the marker at grandchild START,
  // before the kill, and used a fixed `delay(600)` instead of polling (gate
  // cycle 1, blocker 7).
  it.skipIf(IS_WIN32)(
    "LIMIT (measured on this platform): a detached grandchild survives the timeout kill because it writes its marker only AFTER the parent's own deadline has already fired (skipped on win32: a separate, weaker claim holds there — see this module's header comment)",
    async () => {
      const marker = path.join(workDir, 'grandchild-survived.txt');
      const deadlineMs = 200;
      const grandchildDelayMs = deadlineMs + 400; // strictly after the parent's own deadline
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

      const seen = await pollUntil(() => existsSync(marker), 5000);
      expect(seen).toBe(true); // the measured, undesirable-but-real outcome
    },
  );

  // A SECOND, weaker limit than the one above: a detached grandchild that
  // inherits the direct child's stdout FILE DESCRIPTOR (rather than merely
  // outliving it) keeps that pipe open after the direct child exits, which
  // delays — but, measured on Linux, does not truncate or corrupt — the
  // output the direct child already wrote. Measured directly (see the
  // elapsed-time assertion below): execFile's callback did not fire until
  // the grandchild's own, later timer completed, ~1.5s after the direct
  // child had already called `process.exit(0)`.
  it.skipIf(IS_WIN32)(
    'LIMIT (measured on this platform): a detached grandchild inheriting the stdout file descriptor delays, but does not truncate, output the direct child already wrote before exiting (skipped on win32: not measured there)',
    async () => {
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
    },
  );

  it.skipIf(IS_WIN32)(
    "a child killed by an external signal (not by boundedRun's own deadline) is classified killed-by-signal, with its already-produced output kept (skipped on win32: POSIX signal semantics only — gate cycle 1, blocker 2)",
    async () => {
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
    },
  );
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
      timeoutMs: 300,
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
  it('no file under src/integrations/ sets shell: true or calls a bare exec(', async () => {
    const dir = path.join(repoRoot, 'packages', 'cli', 'src', 'integrations');
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    // A negative lookbehind for the dot excludes `something.exec(` (a
    // RegExp/String method call, e.g. `ISO_TIMESTAMP_PATTERN.exec(value)`,
    // legitimately used in receipt.ts/registry.ts) while still catching a
    // bare `exec(` call — the shape `child_process.exec(...)` would take —
    // and `require('node:child_process').exec(`.
    const BARE_EXEC = /(?<!\.)\bexec\s*\(/;
    for (const file of files) {
      const code = stripComments(await readFile(path.join(dir, file), 'utf8'));
      expect(code, file).not.toMatch(/shell\s*:\s*true/);
      expect(code, file).not.toMatch(BARE_EXEC);
    }
  });
});
