import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  isValidToolName,
  resolveTool,
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

describe('resolveTool — never from inside the repository', () => {
  it('never resolves a tool from inside the repository, even when PATH names it', async () => {
    // Plant a fake "claude"/"claude.exe" AT THE REPO ROOT, and put the repo
    // root on PATH ahead of a legitimate, outside-the-repo directory that
    // also carries the tool.
    const repoPlanted = path.join(repoRoot, 'claude');
    const repoPlantedExe = path.join(repoRoot, 'claude.exe');
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-outside-'));
    const outsideFile = path.join(outside, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      await writeFile(repoPlanted, '#!/bin/sh\necho hostile\n');
      await writeFile(repoPlantedExe, 'hostile');
      await writeFile(outsideFile, 'legitimate');

      const env = { PATH: [repoRoot, outside].join(path.delimiter) };
      const result = resolveTool('claude', { env, platform: process.platform, repoDir: repoRoot });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        // The independent oracle: the resolved path must not sit under the
        // repo's own realpath, computed here rather than trusted from the
        // module under test.
        const { realpathSync } = await import('node:fs');
        const repoReal = realpathSync(repoRoot);
        expect(result.absFile.startsWith(repoReal + path.sep)).toBe(false);
        expect(result.absFile).toBe(realpathSync(outsideFile));
      }
    } finally {
      await rm(repoPlanted, { force: true });
      await rm(repoPlantedExe, { force: true });
      await removeFixture(outside);
    }
  });

  it.skipIf(IS_WIN32)(
    'covers a symlinked PATH entry that points into the repository — both sides are realpath-resolved (skipped on win32: symlinks need elevated rights on most CI runners)',
    async () => {
      const { symlink, realpath: realpathP } = await import('node:fs/promises');
      const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-symlink-'));
      const linkDir = path.join(outside, 'link-into-repo');
      const repoPlanted = path.join(repoRoot, 'claude');
      try {
        await writeFile(repoPlanted, '#!/bin/sh\necho hostile\n');
        await symlink(repoRoot, linkDir, 'dir');

        const env = { PATH: linkDir };
        const result = resolveTool('claude', {
          env,
          platform: process.platform,
          repoDir: repoRoot,
        });

        expect(result.status).toBe('tool-not-found');
        const repoReal = await realpathP(repoRoot);
        if ((result as { status: string; absFile?: string }).status === 'ok') {
          expect((result as { absFile: string }).absFile.startsWith(repoReal + path.sep)).toBe(
            false,
          );
        }
      } finally {
        await rm(repoPlanted, { force: true });
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
      const { symlink } = await import('node:fs/promises');
      const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-outside-target-'));
      const outsideFile = path.join(outside, 'real-claude');
      const repoPlantedSymlink = path.join(repoRoot, 'claude');
      try {
        await writeFile(outsideFile, 'legitimate');
        await symlink(outsideFile, repoPlantedSymlink, 'file');

        const env = { PATH: repoRoot };
        const result = resolveTool('claude', {
          env,
          platform: process.platform,
          repoDir: repoRoot,
        });

        expect(result.status).toBe('tool-not-found');
      } finally {
        await rm(repoPlantedSymlink, { force: true });
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
      const { symlink } = await import('node:fs/promises');
      const outside = await mkdtemp(path.join(tmpdir(), 'rig-exec-outside-dir-'));
      const outsideSymlink = path.join(outside, 'claude');
      const repoPlantedTarget = path.join(repoRoot, 'claude-target');
      try {
        await writeFile(repoPlantedTarget, 'hostile');
        await symlink(repoPlantedTarget, outsideSymlink, 'file');

        const env = { PATH: outside };
        const result = resolveTool('claude', {
          env,
          platform: process.platform,
          repoDir: repoRoot,
        });

        expect(result.status).toBe('tool-not-found');
      } finally {
        await rm(repoPlantedTarget, { force: true });
        await removeFixture(outside);
      }
    },
  );
});

describe('resolveTool — PATH entry hygiene', () => {
  it('skips a relative PATH entry, even when it genuinely resolves to a directory OUTSIDE the repo carrying the tool', async () => {
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
      expect(path.isAbsolute(relEntry)).toBe(false); // sanity: the fixture is actually relative
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

describe('classifyCandidates — pure, platform-parameterised', () => {
  it('on win32, a .exe candidate is spawnable', () => {
    expect(classifyCandidates(['claude.exe', 'readme.txt'], 'claude', 'win32')).toBe('spawnable');
  });

  it('on win32, a .cmd-only candidate is reported not-spawnable, never resolved as if it were absent', () => {
    expect(classifyCandidates(['claude.cmd'], 'claude', 'win32')).toBe('not-spawnable');
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
    const result = await boundedRun('relative/file', [], { timeoutMs: 1000, maxBuffer: 1024 });
    expect(result.status).toBe('spawn-error');
  });

  it('refuses a relative absFile that genuinely WOULD run if spawned — proving the guard runs before any spawn attempt', async () => {
    // A relative path that does not exist would fail with ENOENT either
    // way, telling nothing apart. Here the relative path is process.execPath
    // made relative to process.cwd() — a real, runnable file — so a passing
    // test proves the absolute-path guard fires BEFORE execFile ever runs,
    // not that the OS happened to fail to find it.
    const relNode = path.relative(process.cwd(), process.execPath);
    // Only meaningful when the relative form is actually relative (on some
    // CI layouts process.execPath and process.cwd() can be on different
    // drives on win32, making path.relative return an absolute path) —
    // skip rather than produce a false pass/fail unrelated to the guard.
    if (path.isAbsolute(relNode)) return;
    const result = await boundedRun(relNode, ['--version'], { timeoutMs: 5000, maxBuffer: 1024 });
    expect(result.status).toBe('spawn-error');
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
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'SECRET_TOKEN')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'RANDOM_VAR')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(childEnv, 'NODE_OPTIONS')).toBe(false);
    for (const key of Object.keys(childEnv)) {
      expect(EXPECTED_ALLOWED.has(key), `unexpected env key reached the child: ${key}`).toBe(true);
    }
    // Sanity: this module's OWN exported list matches what the test expects
    // — a second, independent equality check, not the only check above.
    expect(new Set(ALLOWED_ENV_VARS)).toEqual(EXPECTED_ALLOWED);
  });
});

describe('boundedRun — deadline', () => {
  it('kills a child that outlives its deadline and classifies it as timeout', async () => {
    const script = 'setTimeout(() => {}, 60000);'; // outlives the 200ms deadline
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 200,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status).toBe('timeout');
  });

  it('a child exiting on its own inside the deadline is not classified as timeout', async () => {
    const result = await boundedRun(process.execPath, ['-e', 'process.exit(0);'], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status).toBe('ok');
  });

  it('a nonzero exit inside the deadline is classified as nonzero-exit, not timeout', async () => {
    const result = await boundedRun(process.execPath, ['-e', 'process.exit(3);'], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status).toBe('nonzero-exit');
    if (result.status === 'nonzero-exit') expect(result.code).toBe(3);
  });

  it('a missing executable is classified as spawn-error, not timeout or nonzero-exit', async () => {
    const missing = path.join(workDir, 'definitely-does-not-exist-binary');
    const result = await boundedRun(missing, [], { timeoutMs: 2000, maxBuffer: 1024 });
    expect(result.status).toBe('spawn-error');
  });

  // Stated limit, measured rather than assumed: SIGKILL on the direct child
  // does not reach a DETACHED grandchild process on Linux. This is not a bug
  // in boundedRun to fix here — it is the documented edge of "kills a child",
  // proven so the header comment's claim is backed by a test rather than
  // prose alone.
  it.skipIf(IS_WIN32)(
    "LIMIT (measured on this platform): a detached grandchild can survive the timeout kill (skipped on win32: a separate, weaker claim holds there — see this module's header comment)",
    async () => {
      const marker = path.join(workDir, 'grandchild-survived.txt');
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
      const inner = 'require(' + JSON.stringify('fs') + ').writeFileSync(' + JSON.stringify(marker) + ", 'alive'); setTimeout(function(){}, 2000);";
      const gc = spawn(process.execPath, ['-e', inner], { detached: true, stdio: 'ignore' });
      gc.unref();
      setTimeout(function(){}, 60000);
    `;
      const result = await boundedRun(process.execPath, ['-e', script], {
        timeoutMs: 200,
        maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe('timeout');
      await delay(600);
      const { existsSync } = await import('node:fs');
      expect(existsSync(marker)).toBe(true); // the measured, undesirable-but-real outcome
    },
  );
});

describe('boundedRun — output cap', () => {
  it('classifies output above the cap as output-exceeded and parses none of it', async () => {
    const script = "process.stdout.write('x'.repeat(200000));";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024, // far below the 200000 bytes written
    });
    expect(result.status).toBe('output-exceeded');
    expect((result as { stdout?: string }).stdout).toBeUndefined();
  });

  it('output under the cap is returned in full', async () => {
    const script = "process.stdout.write('hello');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
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
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stdout).toBe('abc');
    expect(result.stderr).toBe('de');
  });

  it('caps the stderr tail to MAX_STDERR_TAIL_CHARS, keeping the END of the stream', async () => {
    const script = "process.stderr.write('a'.repeat(10) + 'END');";
    const result = await boundedRun(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_STDERR_TAIL_CHARS);
    // Independent oracle, not derived from the module's own constant: this
    // module documents its cap as 4096 (see MAX_STDERR_TAIL_CHARS's own
    // definition), so a mutation shrinking or enlarging that literal without
    // updating this hardcoded expectation is still caught.
    expect(MAX_STDERR_TAIL_CHARS).toBe(4096);
    expect(result.stderr.endsWith('END')).toBe(true);
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
