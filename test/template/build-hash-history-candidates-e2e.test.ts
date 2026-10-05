import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
// @ts-expect-error — a plain .mjs rulebook script
import { withoutGitLocation } from '../../.claude/scripts/git-env.mjs';

// RP-349: `scripts/build-hash-history.mjs`'s `main()` wires together the four
// PURE functions `test/template/hash-history.test.ts` already pins
// (`candidateLedgerDisagreements`, `candidateBaselineFindings`,
// `assertCandidateHeadingsAreCurrent`, `releasedFromLedger`) with real facts it
// gathers from git (`gatherCandidateFacts`) and a real file write. None of
// that pure-function coverage spawns the real script and lets ITS OWN git
// calls and exit code decide — so a bug in how `main()` resolves the frozen
// candidate ref, feeds the gathered facts into the findings, or reacts to a
// ledger disagreement is invisible to it. This file closes that gap: it spawns
// the real script as a child process, against a throwaway bare origin + clone
// it builds and tears down itself (never this repository's own refs — the
// worktree task's own rule).
//
// The fixture is deliberately minimal: `build-hash-history.mjs` imports only
// `node:` builtins, so the fixture carries the script itself plus the four
// files `main()` reads straight off disk (`package.json`,
// `templates/release-ledger.json`, `CHANGELOG.md`,
// `scripts/release-candidates.json`) — nothing from `templates/agent-os` is
// needed because every case below either writes no released version at all,
// or (case 6) stops before a release is ever resolved to a commit.
//
// Each case spawns the real script as a child process and reads its real exit
// code and output, so a bug in how `main()` wires the gathered git facts
// together — including the order it gathers them in relative to validating
// the record's own shape — is visible here even though it is invisible to
// the pure-function tests above.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GLOBAL_GIT_ARGS = [
  '-c',
  'user.email=rp349@example.invalid',
  '-c',
  'user.name=RP-349 fixture',
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
 * Realpath-resolved before anything is built under it, for the same reason
 * `test/template/release-preflight-frozen-e2e.test.ts` resolves its own: on
 * macOS `tmpdir()` answers through a symlink, and the copied script's own
 * entry-point guard compares `import.meta.url` (resolved through the symlink)
 * against `process.argv[1]` (not resolved) — a mismatch silently skips
 * `main()` entirely.
 */
async function makeOriginAndClone(defaultBranch: string): Promise<{ work: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rp349-chh-e2e-')));
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

/** The script carries no runtime import beyond `node:` builtins — copied verbatim. */
async function installScriptCopy(work: string): Promise<void> {
  await mkdir(path.join(work, 'scripts'), { recursive: true });
  await copyFile(
    path.join(repoRoot, 'scripts', 'build-hash-history.mjs'),
    path.join(work, 'scripts', 'build-hash-history.mjs'),
  );
}

/** The four files `main()` reads straight off disk. */
async function writeFixtureFiles(
  work: string,
  options: {
    version: string;
    changelog: string;
    ledger?: Record<string, string | null>;
    candidates?: Record<string, string>;
  },
): Promise<void> {
  await writeFile(
    path.join(work, 'package.json'),
    `${JSON.stringify({ name: 'rp349-fixture', version: options.version }, null, 2)}\n`,
  );
  await mkdir(path.join(work, 'templates'), { recursive: true });
  await writeFile(
    path.join(work, 'templates', 'release-ledger.json'),
    `${JSON.stringify(options.ledger ?? {}, null, 2)}\n`,
  );
  await writeFile(path.join(work, 'CHANGELOG.md'), options.changelog);
  await mkdir(path.join(work, 'scripts'), { recursive: true });
  await writeFile(
    path.join(work, 'scripts', 'release-candidates.json'),
    `${JSON.stringify(options.candidates ?? {}, null, 2)}\n`,
  );
}

/** Writes the fixture files, commits them, and returns the resulting commit sha. */
async function commitFixture(
  work: string,
  options: {
    version: string;
    changelog: string;
    ledger?: Record<string, string | null>;
    candidates?: Record<string, string>;
  },
  message: string,
): Promise<string> {
  await writeFixtureFiles(work, options);
  git(['add', '-A'], work);
  git(['commit', '-m', message], work);
  return git(['rev-parse', 'HEAD'], work);
}

async function runScript(work: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(work, 'scripts', 'build-hash-history.mjs')],
      { cwd: work, env: withoutGitLocation(process.env) },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        }),
    );
  });
}

const DUAL_HEADING_1_2_1 = [
  '## 1.2.1 (release candidate)',
  '',
  'body',
  '',
  '## 1.2.0 (release candidate)',
  '',
  'body',
  '',
].join('\n');

const RELEASE_REF = 'refs/remotes/origin/release/1.2.0-rc';

describe('build-hash-history main() — frozen release-candidate baseline wiring (real git, real child process, RP-349)', () => {
  // (1) The happy path: a recorded, verified, still-unpublished 1.2.0
  // baseline alongside the 1.2.1 candidate heading being prepared.
  it('exits 0 and does not list the frozen 1.2.0 baseline among released versions', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const candidateSha = await commitFixture(
      work,
      { version: '1.2.0', changelog: '## 1.2.0 (release candidate)\n\nbody\n' },
      'freeze 1.2.0',
    );
    git(['push', 'origin', 'master'], work);

    const masterSha = await commitFixture(
      work,
      { version: '1.2.1', changelog: DUAL_HEADING_1_2_1, candidates: { '1.2.0': candidateSha } },
      'advance to 1.2.1, record frozen 1.2.0 baseline',
    );
    git(['push', 'origin', 'master'], work);

    git(['branch', 'release/1.2.0-rc', candidateSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['fetch', 'origin'], work);
    git(['checkout', masterSha], work);

    const result = await runScript(work);
    expect(result.code, result.out).toBe(0);
    const history = JSON.parse(
      await readFile(path.join(work, 'templates', 'hash-history.json'), 'utf8'),
    ) as { versions: string[] };
    expect(history.versions).toEqual([]);
  }, 30_000);

  // (2) The exact remote-tracking ref never exists; a TAG literally named the
  // full ref string (so its real path is `refs/tags/<that string>`) must not
  // be mistaken for it — only the exact ref counts.
  it('reports the release ref missing, naming it, even when a TAG shadows its exact name', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const candidateSha = await commitFixture(
      work,
      { version: '1.2.0', changelog: '## 1.2.0 (release candidate)\n\nbody\n' },
      'freeze 1.2.0',
    );
    git(['push', 'origin', 'master'], work);

    const masterSha = await commitFixture(
      work,
      { version: '1.2.1', changelog: DUAL_HEADING_1_2_1, candidates: { '1.2.0': candidateSha } },
      'advance to 1.2.1, record frozen 1.2.0 baseline',
    );
    git(['push', 'origin', 'master'], work);

    git(['tag', RELEASE_REF, candidateSha], work);
    git(['push', 'origin', `refs/tags/${RELEASE_REF}`], work);
    git(['fetch', 'origin'], work);
    git(['checkout', masterSha], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain(RELEASE_REF);
    expect(result.out, result.out).toMatch(/could not be resolved/);
  }, 30_000);

  // (3) The real remote-tracking ref exists but resolves to a different
  // commit than the one recorded.
  it('reports a release ref that resolves to a different commit, naming both shas', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const candidateSha = await commitFixture(
      work,
      { version: '1.2.0', changelog: '## 1.2.0 (release candidate)\n\nbody\n' },
      'freeze 1.2.0',
    );
    git(['push', 'origin', 'master'], work);

    const masterSha = await commitFixture(
      work,
      { version: '1.2.1', changelog: DUAL_HEADING_1_2_1, candidates: { '1.2.0': candidateSha } },
      'advance to 1.2.1, record frozen 1.2.0 baseline',
    );
    git(['push', 'origin', 'master'], work);

    git(['branch', 'release/1.2.0-rc', masterSha], work); // wrong commit
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['fetch', 'origin'], work);
    git(['checkout', masterSha], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain(candidateSha);
    expect(result.out, result.out).toContain(masterSha);
  }, 30_000);

  // (4) The ref resolves to exactly the recorded sha, but that commit's own
  // package.json names a different version than the record claims.
  it('reports a recorded commit whose package.json names a different version', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const wrongVersionSha = await commitFixture(
      work,
      { version: '9.9.9', changelog: '## 9.9.9\n\nbody\n' },
      'freeze a commit whose package.json disagrees with the recorded version',
    );
    git(['push', 'origin', 'master'], work);

    const masterSha = await commitFixture(
      work,
      {
        version: '1.2.1',
        changelog: DUAL_HEADING_1_2_1,
        candidates: { '1.2.0': wrongVersionSha },
      },
      'advance to 1.2.1, record the mismatched baseline as 1.2.0',
    );
    git(['push', 'origin', 'master'], work);

    git(['branch', 'release/1.2.0-rc', wrongVersionSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);
    git(['fetch', 'origin'], work);
    git(['checkout', masterSha], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain('9.9.9');
    expect(result.out, result.out).toContain('1.2.0');
  }, 30_000);

  // (5) No record at all for 1.2.0 (`scripts/release-candidates.json` is
  // `{}`), yet the changelog still carries its release-candidate heading.
  it('reports an unrecorded stale candidate heading, naming scripts/release-candidates.json', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await commitFixture(
      work,
      { version: '1.2.1', changelog: DUAL_HEADING_1_2_1, candidates: {} },
      'prepare 1.2.1 with an unrecorded stale 1.2.0 candidate heading',
    );
    git(['push', 'origin', 'master'], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain('scripts/release-candidates.json');
  }, 30_000);

  // (6) The ledger already has a row for 1.2.0 (it has published) and it
  // disagrees with the recorded frozen-candidate sha. Rewrites nothing.
  it('reports a ledger row that disagrees with the recorded candidate sha, and rewrites nothing', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const ledgerSha = await commitFixture(
      work,
      { version: '1.2.0', changelog: '## 1.2.0\n\nbody\n' },
      'stand-in for the commit 1.2.0 actually published from',
    );
    git(['push', 'origin', 'master'], work);

    const candidateSha = await commitFixture(
      work,
      { version: '1.2.0', changelog: '## 1.2.0\n\nbody, from a different commit\n' },
      'a different commit, standing in for the frozen-candidate sha',
    );
    git(['push', 'origin', 'master'], work);

    const reconciledHeading = [
      '## 1.2.1 (release candidate)',
      '',
      'body',
      '',
      '## 1.2.0',
      '',
      'body',
      '',
    ].join('\n');
    await commitFixture(
      work,
      {
        version: '1.2.1',
        changelog: reconciledHeading,
        ledger: { '1.2.0': ledgerSha },
        candidates: { '1.2.0': candidateSha },
      },
      'ledger and recorded candidate disagree about 1.2.0',
    );
    git(['push', 'origin', 'master'], work);

    const historyPath = path.join(work, 'templates', 'hash-history.json');
    const ledgerPath = path.join(work, 'templates', 'release-ledger.json');
    const placeholderHistory = `${JSON.stringify({ versions: ['nonsense-marker'], files: {} }, null, 2)}\n`;
    await writeFile(historyPath, placeholderHistory);
    const ledgerBefore = await readFile(ledgerPath, 'utf8');

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain(ledgerSha);
    expect(result.out, result.out).toContain(candidateSha);

    const historyAfter = await readFile(historyPath, 'utf8');
    const ledgerAfter = await readFile(ledgerPath, 'utf8');
    expect(historyAfter).toBe(placeholderHistory);
    expect(ledgerAfter).toBe(ledgerBefore);
  }, 30_000);

  // (7) The ref resolves to the recorded sha and that commit's package.json
  // names the recorded version — exactly like case (1) — but the commit sits
  // on a branch that was never merged into master.
  it('reports a recorded baseline that is not an ancestor of HEAD, naming the sha', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const baseSha = await commitFixture(
      work,
      { version: '1.2.1', changelog: '' },
      'base commit, before the candidate branch and the real 1.2.1 diverge',
    );
    git(['push', 'origin', 'master'], work);

    git(['checkout', '-b', 'side', baseSha], work);
    const candidateSha = await commitFixture(
      work,
      { version: '1.2.0', changelog: '## 1.2.0 (release candidate)\n\nbody\n' },
      'freeze 1.2.0 on a side branch that master never merges',
    );
    git(['branch', 'release/1.2.0-rc', candidateSha], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);

    git(['checkout', 'master'], work);
    const masterSha = await commitFixture(
      work,
      { version: '1.2.1', changelog: DUAL_HEADING_1_2_1, candidates: { '1.2.0': candidateSha } },
      'advance master to 1.2.1 without ever merging the frozen 1.2.0 branch',
    );
    git(['push', 'origin', 'master'], work);

    git(['fetch', 'origin'], work);
    git(['checkout', masterSha], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain(candidateSha);
    expect(result.out, result.out).toContain('is not an ancestor of HEAD');
  }, 30_000);

  it('never lets an option-shaped candidate value reach git show as a live argument', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const injectedValue = `--output=${path.join(work, 'pwned')}`;
    await commitFixture(
      work,
      { version: '1.2.1', changelog: '', candidates: { '1.2.0': injectedValue } },
      'record an option-shaped value instead of a commit sha',
    );
    git(['push', 'origin', 'master'], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain(
      'scripts/release-candidates.json: 1.2.0 must be a 40-character lowercase commit sha',
    );
    const entries = await readdir(work);
    expect(
      entries.some((entry) => entry.includes('pwned')),
      entries.join(', '),
    ).toBe(false);
  }, 30_000);

  it('never crashes with an uncaught stack trace on a non-string candidate value', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    await commitFixture(
      work,
      {
        version: '1.2.1',
        changelog: '',
        candidates: { '1.2.0': 5 } as unknown as Record<string, string>,
      },
      'record a non-string value instead of a commit sha',
    );
    git(['push', 'origin', 'master'], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain(
      'scripts/release-candidates.json: 1.2.0 must be a 40-character lowercase commit sha',
    );
    expect(result.out, result.out).not.toMatch(/\n\s+at\s/);
    expect(result.out, result.out).not.toContain('Error:');
  }, 30_000);

  it('reports a well-formed but nonexistent candidate sha as a finding, not a crash', async () => {
    const { work } = await makeOriginAndClone('master');
    await installScriptCopy(work);
    const nonexistentSha = 'a'.repeat(40);
    await commitFixture(
      work,
      { version: '1.2.1', changelog: '', candidates: { '1.2.0': nonexistentSha } },
      'record a well-formed sha that names no object in the repository',
    );
    git(['push', 'origin', 'master'], work);

    const result = await runScript(work);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out, result.out).toContain(nonexistentSha);
    expect(result.out, result.out).not.toMatch(/\n\s+at\s/);
  }, 30_000);
});
