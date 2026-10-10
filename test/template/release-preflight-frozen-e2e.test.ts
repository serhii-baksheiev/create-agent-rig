import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stubCommand } from '../helpers/stub-command.js';
import { removeFixture } from '../helpers/remove-fixture.js';
// @ts-expect-error — a plain .mjs rulebook script
import { withoutGitLocation } from '../../.claude/scripts/git-env.mjs';

// RP-353, review blockers A, B and (the E2E half of) C.
//
// `test/template/release-preflight.test.ts` and
// `test/template/release-candidate-preflight.test.ts` both pin the PURE
// decision functions (`gitFindings`, `frozenCandidateGitFindings`) against
// hard-coded or test-computed booleans. Neither ever spawns the real
// `scripts/release-preflight.mjs` and lets ITS OWN git calls decide those
// booleans — so a bug in how `main()` resolves `--frozen-candidate`'s release
// ref, or in whether a git finding actually stops `npm pack`, is invisible to
// either suite. This file closes that gap: it spawns the real script as a
// child process, against a throwaway bare origin + clone it builds and tears
// down itself (never this repository's own refs — the worktree task's own
// rule), with a stand-in `npm` on PATH that proves whether it was ever asked
// to pack.
//
// The cases below pin two properties of frozen mode: (A) only the exact
// remote-tracking refs count, never a tag or branch that git's short-name
// lookup would land on when the real ref is missing; (B) a frozen git finding
// stops the run before `npm pack`.
//
// The fixture is deliberately minimal: a copy of the real script plus its one
// runtime dependency (`.claude/scripts/lib/secrets.mjs`, which itself imports
// nothing), and the four files `main()` reads from disk — nothing from this
// repository's own history or refs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GLOBAL_GIT_ARGS = [
  '-c',
  'user.email=rp353@example.invalid',
  '-c',
  'user.name=RP-353 fixture',
  '-c',
  'commit.gpgsign=false',
];

const git = (args: string[], cwd: string): string =>
  execFileSync('git', [...GLOBAL_GIT_ARGS, ...args], {
    cwd,
    env: withoutGitLocation(),
    encoding: 'utf8',
  }).trim();

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) await removeFixture(dir);
  }
});

/**
 * A bare `origin` plus one clone of it, both under a fresh temp directory.
 *
 * The directory is realpath-resolved before anything is built under it:
 * `tmpdir()` on macOS answers through `/var`, itself a symlink to
 * `/private/var`, and the copied script's own entry-point guard compares
 * `import.meta.url` (which Node resolves through the symlink) against
 * `process.argv[1]` (which it does not) — a mismatch that makes `main()`
 * silently never run, observed the same session this file was written, the
 * same way `stub-command.ts` already realpath-resolves its own bin directory
 * for exactly this reason.
 */
async function makeOriginAndClone(defaultBranch: string): Promise<{ work: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rp353-e2e-')));
  cleanups.push(root);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  await mkdir(origin, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', defaultBranch, origin], {
    env: withoutGitLocation(),
  });
  execFileSync('git', ['clone', origin, work], { env: withoutGitLocation() });
  return { work };
}

/** The one runtime import the script makes, plus the script itself, copied verbatim. */
async function installScriptCopy(work: string): Promise<void> {
  await mkdir(path.join(work, 'scripts'), { recursive: true });
  await mkdir(path.join(work, '.claude', 'scripts', 'lib'), { recursive: true });
  await copyFile(
    path.join(repoRoot, 'scripts', 'release-preflight.mjs'),
    path.join(work, 'scripts', 'release-preflight.mjs'),
  );
  await copyFile(
    path.join(repoRoot, '.claude', 'scripts', 'lib', 'secrets.mjs'),
    path.join(work, '.claude', 'scripts', 'lib', 'secrets.mjs'),
  );
}

/** The four files `main()` reads straight off disk, minimally filled in. */
async function writeManifests(
  work: string,
  version: string,
  changelogHeading: string,
): Promise<void> {
  await writeFile(
    path.join(work, 'package.json'),
    `${JSON.stringify({ name: 'rp353-fixture', version }, null, 2)}\n`,
  );
  await mkdir(path.join(work, 'packages', 'cli'), { recursive: true });
  await writeFile(
    path.join(work, 'packages', 'cli', 'package.json'),
    `${JSON.stringify(
      {
        name: '@rp353-fixture/cli',
        version,
        private: true,
        scripts: { prepublishOnly: 'node -e "process.exit(1)"' },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(path.join(work, 'templates'), { recursive: true });
  await writeFile(path.join(work, 'templates', 'release-ledger.json'), '{}\n');
  await writeFile(path.join(work, 'CHANGELOG.md'), `${changelogHeading}\n\nnotes\n`);
}

/** The npm stand-in: proves whether it was ever invoked, by leaving a marker file. */
async function installNpmMarkerStub(): Promise<{
  marker: string;
  markerDir: string;
  env: Record<string, string>;
  restore: () => void;
}> {
  const markerDir = await mkdtemp(path.join(tmpdir(), 'rp353-npm-marker-'));
  const marker = path.join(markerDir, 'npm-was-invoked');
  const stub = await stubCommand(
    'npm',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked'); return { stdout: '[{"filename":"x","files":[]}]' };`,
  );
  return { marker, markerDir, env: stub.env, restore: stub.restore };
}

async function runPreflight(
  work: string,
  args: string[],
  stubEnv: Record<string, string>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(work, 'scripts', 'release-preflight.mjs'), ...args],
      { cwd: work, env: { ...withoutGitLocation(process.env), ...stubEnv } },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        }),
    );
  });
}

const RELEASE_REF = 'refs/remotes/origin/release/1.2.0-rc';

/**
 * The common frozen-candidate shape: 1.2.0 frozen on `master`, then `master`
 * advances to 1.2.1 on top of it — so the candidate IS an ancestor of
 * `origin/master` by construction, unless the caller overrides that below.
 * Returns the sha the candidate was frozen at and `master`'s sha after it
 * advanced; the caller decides what (if anything) to name `release/1.2.0-rc`.
 */
async function freezeThenAdvanceMaster(): Promise<{
  work: string;
  candidateSha: string;
  masterSha: string;
}> {
  const { work } = await makeOriginAndClone('master');
  await installScriptCopy(work);
  await writeManifests(work, '1.2.0', '## 1.2.0 (release candidate)');
  git(['add', '-A'], work);
  git(['commit', '-m', 'freeze 1.2.0'], work);
  const candidateSha = git(['rev-parse', 'HEAD'], work);
  git(['push', 'origin', 'master'], work);

  await writeManifests(work, '1.2.1', '## 1.2.1');
  git(['add', '-A'], work);
  git(['commit', '-m', 'advance master to 1.2.1'], work);
  const masterSha = git(['rev-parse', 'HEAD'], work);
  git(['push', 'origin', 'master'], work);

  return { work, candidateSha, masterSha };
}

describe('release preflight (real git, real child process) — frozen-candidate mode resolves the release ref exactly', () => {
  // (1) The happy path: no git finding, and npm IS reached — the stub's own
  // fake pack listing then produces unrelated payload/tarball findings, so
  // this asserts only what this file is about: the git side, and the marker.
  it('clears the exact candidate on the real remote-tracking release ref, ancestor of origin/master, and still reaches npm', async () => {
    const { work, candidateSha } = await freezeThenAdvanceMaster();
    git(['branch', 'release/1.2.0-rc', candidateSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, ['--frozen-candidate', candidateSha], stub.env);
      expect(result.out, result.out).not.toMatch(/could not be resolved/);
      expect(result.out, result.out).not.toMatch(/is not an ancestor/);
      expect(result.out, result.out).not.toMatch(/no longer names this candidate/);
      expect(result.out, result.out).not.toMatch(/the working tree is not clean/);
      expect(result.out, result.out).not.toMatch(/HEAD is .* but the frozen candidate is/);
      expect(existsSync(stub.marker), 'npm should have been reached on the happy path').toBe(true);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (2) The plain missing-ref case: nothing at all is named
  // `release/1.2.0-rc`, real ref or otherwise.
  it('reports the release ref missing, naming it, and never reaches npm (B: a frozen git finding must stop before packing)', async () => {
    const { work, candidateSha } = await freezeThenAdvanceMaster();
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, ['--frozen-candidate', candidateSha], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain(RELEASE_REF);
      expect(result.out, result.out).toMatch(/could not be resolved/);
      expect(
        existsSync(stub.marker),
        `npm pack ran before the git findings stopped it:\n${result.out}`,
      ).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (3) A: a TAG literally named `refs/remotes/origin/release/1.2.0-rc`
  // (full path `refs/tags/refs/remotes/origin/release/1.2.0-rc`), pointing at
  // the candidate itself, with the real remote-tracking ref absent. Confirmed
  // against real git: `git rev-parse refs/remotes/origin/release/1.2.0-rc`
  // resolves this tag's sha even though the literal ref does not exist —
  // `git show-ref --verify --quiet` on the same string correctly fails. The
  // release ref must still read as missing.
  it('still reports the release ref missing when a TAG shadows its exact name (A: only the exact remote-tracking ref counts)', async () => {
    const { work, candidateSha } = await freezeThenAdvanceMaster();
    git(['tag', RELEASE_REF, candidateSha], work);
    git(['push', 'origin', `refs/tags/${RELEASE_REF}`], work);
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, ['--frozen-candidate', candidateSha], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain(RELEASE_REF);
      expect(result.out, result.out).toMatch(/could not be resolved/);
      expect(
        existsSync(stub.marker),
        `npm pack ran before the git findings stopped it:\n${result.out}`,
      ).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (4) A, the other DWIM fallback: a local BRANCH literally named
  // `refs/remotes/origin/release/1.2.0-rc` (full path
  // `refs/heads/refs/remotes/origin/release/1.2.0-rc`), same story.
  it('still reports the release ref missing when a BRANCH shadows its exact name (A: only the exact remote-tracking ref counts)', async () => {
    const { work, candidateSha } = await freezeThenAdvanceMaster();
    git(['branch', RELEASE_REF, candidateSha], work);
    git(['push', 'origin', `refs/heads/${RELEASE_REF}`], work);
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, ['--frozen-candidate', candidateSha], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain(RELEASE_REF);
      expect(result.out, result.out).toMatch(/could not be resolved/);
      expect(
        existsSync(stub.marker),
        `npm pack ran before the git findings stopped it:\n${result.out}`,
      ).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (5) The real remote-tracking ref exists but names a DIFFERENT commit —
  // no DWIM involved here, the finding is already the right one under
  // today's code; what must ALSO hold is B: npm must never be reached.
  it('reports a release ref that resolves to a different commit, and never reaches npm', async () => {
    const { work, candidateSha, masterSha } = await freezeThenAdvanceMaster();
    git(['branch', 'release/1.2.0-rc', masterSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, ['--frozen-candidate', candidateSha], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain(RELEASE_REF);
      expect(result.out, result.out).toContain(candidateSha);
      expect(result.out, result.out).toContain(masterSha);
      expect(
        existsSync(stub.marker),
        `npm pack ran before the git findings stopped it:\n${result.out}`,
      ).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (6) The candidate is frozen on a branch that never merges into `master`,
  // so it genuinely is not reachable from origin/master's history — no DWIM
  // involved, the ancestry finding is already correct today; B again demands
  // npm never runs.
  it('reports a candidate that is not reachable from origin/master, and never reaches npm', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await writeManifests(work, '0.0.0', '## 0.0.0');
    git(['add', '-A'], work);
    git(['commit', '-m', 'initial'], work);
    git(['push', 'origin', 'master'], work);

    git(['checkout', '-b', 'candidate-work'], work);
    await writeManifests(work, '1.2.0', '## 1.2.0 (release candidate)');
    git(['add', '-A'], work);
    git(['commit', '-m', 'freeze 1.2.0, off to the side'], work);
    const candidateSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'candidate-work'], work);
    git(['branch', 'release/1.2.0-rc', candidateSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);

    git(['checkout', 'master'], work);
    await writeManifests(work, '1.2.1', '## 1.2.1');
    git(['add', '-A'], work);
    git(['commit', '-m', 'advance master independently'], work);
    git(['push', 'origin', 'master'], work);

    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, ['--frozen-candidate', candidateSha], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toMatch(/not an ancestor/);
      expect(
        existsSync(stub.marker),
        `npm pack ran before the git findings stopped it:\n${result.out}`,
      ).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (7) A, the sharpest case: `origin` never has a branch named `master` at
  // all (so `refs/remotes/origin/master` genuinely cannot be resolved), and a
  // TAG literally named `refs/remotes/origin/master` points at the candidate
  // itself — trivially its own ancestor. Confirmed against real git: `git
  // merge-base --is-ancestor <sha> refs/remotes/origin/master` SUCCEEDS here,
  // silently treating the shadow tag as origin/master. The release ref is
  // real and correct, so this is the one case where, absent the fix, the run
  // can print a CLEAN report while the only reason it looks clean is that
  // `origin/master` was never actually resolved. The required finding names
  // the unresolvable `origin/master`, not an ancestry verdict about it.
  it('reports origin/master as unresolvable rather than silently trusting a TAG that shadows its name', async () => {
    const { work } = await makeOriginAndClone('trunk');
    await installScriptCopy(work);
    await writeManifests(work, '1.2.0', '## 1.2.0 (release candidate)');
    git(['add', '-A'], work);
    git(['commit', '-m', 'freeze 1.2.0'], work);
    const candidateSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'trunk'], work);
    git(['branch', 'release/1.2.0-rc', candidateSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['tag', 'refs/remotes/origin/master', candidateSha], work);
    git(['push', 'origin', 'refs/tags/refs/remotes/origin/master'], work);
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, ['--frozen-candidate', candidateSha], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain('origin/master');
      expect(result.out, result.out).toMatch(/could not be resolved/);
      // The direction that matters most: a shadow tag must never let the
      // ancestry question read as answered.
      expect(result.out, result.out).not.toMatch(/is not an ancestor/);
      expect(
        existsSync(stub.marker),
        `npm pack ran before the git findings stopped it:\n${result.out}`,
      ).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);
});

describe('release preflight (real git, real child process) — an immutable replacement candidate preserves its predecessor', () => {
  // RP-471: the original canonical release/<version>-rc is immutable evidence.
  // A corrected candidate uses a SHA-derived ref, proves the canonical ref
  // still names the predecessor, and proves that predecessor is in the new
  // candidate's history. A replacement must not merely retarget old evidence.
  it('accepts a replacement only through its SHA-derived ref while preserving the canonical original ref', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await writeManifests(work, '1.2.0', '## 1.2.0 (release candidate)');
    git(['add', '-A'], work);
    git(['commit', '-m', 'freeze original 1.2.0'], work);
    const originalSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);

    await writeFile(path.join(work, 'replacement-note'), 'bounded correction\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'prepare corrected replacement 1.2.0'], work);
    const replacementSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);
    git(['branch', 'release/1.2.0-rc', originalSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['branch', `release/1.2.0-rc-${replacementSha}`, replacementSha], work);
    git(['push', 'origin', `release/1.2.0-rc-${replacementSha}`], work);
    git(['fetch', 'origin'], work);
    git(['checkout', replacementSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(
        work,
        ['--frozen-candidate', replacementSha, '--supersedes', originalSha],
        stub.env,
      );
      expect(result.out, result.out).not.toMatch(
        /could not be resolved|no longer names|not an ancestor/,
      );
      expect(existsSync(stub.marker), result.out).toBe(true);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  it('rejects a replacement whose preserved canonical predecessor has another package version, before npm pack', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await writeManifests(work, '9.9.9', '## 9.9.9 (release candidate)');
    git(['add', '-A'], work);
    git(['commit', '-m', 'freeze a malformed original predecessor'], work);
    const originalSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);

    await writeManifests(work, '1.2.0', '## 1.2.0 (release candidate)');
    git(['add', '-A'], work);
    git(['commit', '-m', 'prepare corrected replacement 1.2.0'], work);
    const replacementSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);
    git(['branch', 'release/1.2.0-rc', originalSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['branch', `release/1.2.0-rc-${replacementSha}`, replacementSha], work);
    git(['push', 'origin', `release/1.2.0-rc-${replacementSha}`], work);
    git(['fetch', 'origin'], work);
    git(['checkout', replacementSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(
        work,
        ['--frozen-candidate', replacementSha, '--supersedes', originalSha],
        stub.env,
      );
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain('release/1.2.0-rc');
      expect(result.out, result.out).toContain('9.9.9');
      expect(result.out, result.out).toContain('1.2.0');
      expect(existsSync(stub.marker), result.out).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  it('rejects a replacement that does not descend from its preserved canonical predecessor, before npm pack', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await writeManifests(work, '1.2.0', '## 1.2.0 (release candidate)');
    git(['add', '-A'], work);
    git(['commit', '-m', 'prepare the shared 1.2.0 base'], work);
    const baseSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);

    git(['checkout', '-b', 'original-candidate', baseSha], work);
    await writeFile(path.join(work, 'original-note'), 'original candidate\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'freeze a canonical predecessor on a sibling branch'], work);
    const originalSha = git(['rev-parse', 'HEAD'], work);
    git(['branch', 'release/1.2.0-rc', originalSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);

    git(['checkout', 'master'], work);
    await writeFile(path.join(work, 'replacement-note'), 'unrelated candidate\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'prepare a sibling replacement candidate'], work);
    const replacementSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);
    git(['branch', `release/1.2.0-rc-${replacementSha}`, replacementSha], work);
    git(['push', 'origin', `release/1.2.0-rc-${replacementSha}`], work);
    git(['fetch', 'origin'], work);
    git(['checkout', replacementSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(
        work,
        ['--frozen-candidate', replacementSha, '--supersedes', originalSha],
        stub.env,
      );
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain(originalSha);
      expect(result.out, result.out).toMatch(/not an ancestor/i);
      expect(existsSync(stub.marker), result.out).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  it('rejects a replacement when the canonical original ref was moved, before npm pack', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await writeManifests(work, '1.2.0', '## 1.2.0 (release candidate)');
    git(['add', '-A'], work);
    git(['commit', '-m', 'freeze original 1.2.0'], work);
    const originalSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);

    await writeFile(path.join(work, 'replacement-note'), 'bounded correction\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'prepare corrected replacement 1.2.0'], work);
    const replacementSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);
    // This is the forbidden rewrite: it cannot substitute for an immutable
    // predecessor, even though a replacement ref also exists and is correct.
    git(['branch', 'release/1.2.0-rc', replacementSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['branch', `release/1.2.0-rc-${replacementSha}`, replacementSha], work);
    git(['push', 'origin', `release/1.2.0-rc-${replacementSha}`], work);
    git(['fetch', 'origin'], work);
    git(['checkout', replacementSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(
        work,
        ['--frozen-candidate', replacementSha, '--supersedes', originalSha],
        stub.env,
      );
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain('release/1.2.0-rc');
      expect(result.out, result.out).toContain(originalSha);
      expect(existsSync(stub.marker), result.out).toBe(false);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);
});

// Item E: ordinary mode (no --frozen-candidate at all) already runs the same
// `changelogHeadingFindings` check `main()` runs for frozen mode — pinned here
// end to end, against the real script, with HEAD sitting on the current
// `origin/master` tip exactly as ordinary mode requires.
describe('release preflight (real git, real child process) — ordinary mode also runs the changelog heading check', () => {
  async function freezeOrdinary(changelogHeading: string): Promise<{ work: string; sha: string }> {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await writeManifests(work, '1.2.0', changelogHeading);
    git(['add', '-A'], work);
    git(['commit', '-m', 'release 1.2.0'], work);
    const sha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);
    git(['fetch', 'origin'], work);
    return { work, sha };
  }

  it('reports a version the changelog documents under no heading at all', async () => {
    const { work } = await freezeOrdinary('## nothing to do with 1.2.0');
    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, [], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toContain('CHANGELOG.md documents no exact');
      expect(result.out, result.out).toContain('1.2.0');
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  it('clears the exact "## X.Y.Z (release candidate)" heading — ordinary mode accepts it just as frozen mode does', async () => {
    const { work } = await freezeOrdinary('## 1.2.0 (release candidate)');
    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, [], stub.env);
      expect(result.out, result.out).not.toContain('CHANGELOG.md documents no exact');
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);
});

// RP-410: a TAG or BRANCH literally named `origin/master`
// (refs/tags/origin/master, refs/heads/origin/master) outranks the
// remote-tracking ref in gitrevisions(7)'s short-name lookup, so only the
// exact `refs/remotes/origin/master` may answer "is HEAD origin/master's tip".
// Each case runs the real script end to end, because the ref is resolved in
// `main()`, upstream of `gitFindings`.
describe('release preflight (real git, real child process) — ordinary mode resolves origin/master exactly', () => {
  const REMOTE_REF = 'refs/remotes/origin/master';

  async function releaseOnMaster(
    version: string,
    changelogHeading: string,
  ): Promise<{ work: string; sha: string }> {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await writeManifests(work, version, changelogHeading);
    git(['add', '-A'], work);
    git(['commit', '-m', `release ${version}`], work);
    const sha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);
    git(['fetch', 'origin'], work);
    return { work, sha };
  }

  // (1) The real remote-tracking ref is deleted and a TAG named
  // `origin/master` points at HEAD: the shadow would match HEAD exactly.
  it('reports origin/master unresolvable rather than trusting a TAG that shadows its name, when the real remote-tracking ref is missing', async () => {
    const { work, sha } = await releaseOnMaster('1.2.0', '## 1.2.0');
    git(['update-ref', '-d', REMOTE_REF], work);
    git(['tag', 'origin/master', sha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, [], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toMatch(/origin\/master could not be resolved/);
      expect(result.out, result.out).not.toMatch(/HEAD is .* but origin\/master is/);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (2) The real remote-tracking ref names a DIFFERENT commit than HEAD,
  // while a TAG named `origin/master` points at HEAD itself.
  it('reports HEAD against the real remote-tracking ref, naming its sha, not a TAG that shadows its name', async () => {
    const { work, candidateSha, masterSha } = await freezeThenAdvanceMaster();
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work);
    git(['tag', 'origin/master', candidateSha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, [], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toMatch(/HEAD is .* but origin\/master is/);
      expect(result.out, result.out).toContain(candidateSha);
      expect(result.out, result.out).toContain(masterSha);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // (3) The other DWIM fallback: a local BRANCH literally named
  // `origin/master` (full path `refs/heads/origin/master`), with the real
  // remote-tracking ref deleted.
  it('reports origin/master unresolvable rather than trusting a BRANCH that shadows its name, when the real remote-tracking ref is missing', async () => {
    const { work, sha } = await releaseOnMaster('1.2.0', '## 1.2.0');
    git(['update-ref', '-d', REMOTE_REF], work);
    git(['branch', 'origin/master', sha], work);

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, [], stub.env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out, result.out).toMatch(/origin\/master could not be resolved/);
      expect(result.out, result.out).not.toMatch(/HEAD is .* but origin\/master is/);
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);

  // Control: the real remote-tracking ref equals HEAD, no shadow of any kind.
  it('clears the git check on the real remote-tracking ref equal to HEAD, with no shadow present', async () => {
    const { work } = await releaseOnMaster('1.2.0', '## 1.2.0');

    const stub = await installNpmMarkerStub();
    try {
      const result = await runPreflight(work, [], stub.env);
      expect(result.out, result.out).not.toMatch(/origin\/master could not be resolved/);
      expect(result.out, result.out).not.toMatch(/HEAD is .* but origin\/master is/);
      expect(existsSync(stub.marker), 'npm should have been reached on the clean control').toBe(
        true,
      );
    } finally {
      stub.restore();
      await removeFixture(stub.markerDir);
    }
  }, 30_000);
});
