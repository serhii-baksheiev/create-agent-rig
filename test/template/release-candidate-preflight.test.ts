import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs release script, imported for its pure parts
import * as releasePreflight from '../../scripts/release-preflight.mjs';
// @ts-expect-error — a plain .mjs rulebook script
import { withoutGitLocation } from '../../.claude/scripts/git-env.mjs';
import { removeFixture } from '../helpers/remove-fixture.js';

const { gitFindings, frozenCandidateGitFindings } = releasePreflight as {
  gitFindings: (state: { status: string; head: string; remote: string }) => string[];
  frozenCandidateGitFindings: (state: {
    status: string;
    head: string;
    sha: string;
    releaseRefName: string;
    releaseRefSha: string | null;
    isAncestorOfMaster: boolean;
  }) => string[];
};

// RP-353: this file feeds the pure frozen-candidate decision with facts this
// test reads from real refs itself (a remote-tracking ref, a real ancestor
// check). It does not exercise how the script reads them; that end-to-end
// path is release-preflight-frozen-e2e.test.ts. Everything below runs
// inside its own temporary bare origin and clone — never this repository's own
// refs, per this task's own worktree rule.
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

/** A bare `origin` plus one clone of it, both under a fresh temp directory. */
async function makeOriginAndClone(): Promise<{ work: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'rp353-frozen-'));
  cleanups.push(root);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  await mkdir(origin, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'master', origin], { env: withoutGitLocation() });
  execFileSync('git', ['clone', origin, work], { env: withoutGitLocation() });
  return { work };
}

const writePackage = (dir: string, version: string): Promise<void> =>
  writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'rp353-fixture', version }, null, 2)}\n`,
  );

describe('frozen release candidate preflight — real git, a throwaway origin and clone', () => {
  // 🔴 The scenario RP-353 exists for: 1.2.0 is frozen at `release/1.2.0-rc`
  // while `master` keeps moving — here, to 1.2.1. Ordinary preflight
  // (`gitFindings`) can only ever accept the CURRENT origin/master tip, so it
  // is read here too, to prove the two modes genuinely disagree about which
  // commit is publishable right now, rather than one silently subsuming the
  // other.
  it('frozen release candidate preflight accepts only the exact frozen RC while keeping normal publication at the current master tip', async () => {
    const { work } = await makeOriginAndClone();

    // Freeze 1.2.0.
    await writePackage(work, '1.2.0');
    await writeFile(path.join(work, 'CHANGELOG.md'), '## 1.2.0 (release candidate)\n\nnotes\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'freeze 1.2.0'], work);
    const candidateSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);
    git(['branch', 'release/1.2.0-rc'], work);
    git(['push', 'origin', 'release/1.2.0-rc'], work);

    // Master keeps moving: 1.2.1 lands on top of the frozen point.
    await writePackage(work, '1.2.1');
    await writeFile(path.join(work, 'CHANGELOG.md'), '## 1.2.1\n\nnotes\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'advance master to 1.2.1'], work);
    const masterSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', 'master'], work);

    // Read the remote-tracking refs fresh, the way the real preflight would.
    git(['fetch', 'origin'], work);
    git(['checkout', candidateSha], work); // back onto the frozen point, detached

    const releaseRefName = 'refs/remotes/origin/release/1.2.0-rc';
    const releaseRefSha = git(['rev-parse', releaseRefName], work);
    const remoteMasterSha = git(['rev-parse', 'refs/remotes/origin/master'], work);
    // Fixture preconditions, not the behaviour under test — if either of these
    // fails, the scenario was not built the way the comment above says it was.
    expect(remoteMasterSha, 'fixture precondition').toBe(masterSha);
    expect(releaseRefSha, 'fixture precondition').toBe(candidateSha);

    const isAncestorOfMaster = (): boolean => {
      try {
        git(['merge-base', '--is-ancestor', candidateSha, 'refs/remotes/origin/master'], work);
        return true;
      } catch {
        return false;
      }
    };
    expect(
      isAncestorOfMaster(),
      "fixture precondition — the candidate must sit in master's history",
    ).toBe(true);

    const status = git(['status', '--porcelain'], work);
    const head = git(['rev-parse', 'HEAD'], work);
    expect(head, 'fixture precondition — HEAD must be sitting on the frozen candidate').toBe(
      candidateSha,
    );

    // The exact frozen RC, checked out, clean, ref-matched and reachable from
    // master: frozen mode clears every check.
    expect(
      frozenCandidateGitFindings({
        status,
        head,
        sha: candidateSha,
        releaseRefName,
        releaseRefSha,
        isAncestorOfMaster: isAncestorOfMaster(),
      }),
    ).toEqual([]);

    // A DIFFERENT commit — master's own tip — asked about under the SAME ref
    // must fail on the ref-mismatch arm, naming both shas: the ref still names
    // the real candidate, so asking about a different sha is not the same
    // question with a different answer, it is a question this ref cannot
    // answer at all.
    const wrongCandidateFindings = frozenCandidateGitFindings({
      status,
      head: masterSha,
      sha: masterSha,
      releaseRefName,
      releaseRefSha,
      isAncestorOfMaster: true,
    });
    expect(wrongCandidateFindings.length).toBeGreaterThan(0);
    expect(wrongCandidateFindings.join('\n')).toContain(masterSha);
    expect(wrongCandidateFindings.join('\n')).toContain(candidateSha);

    // Normal publication is unaffected by the frozen ref's existence: it still
    // requires HEAD to be the CURRENT origin/master tip, exactly as before this
    // feature existed. Checked out on the frozen candidate, ordinary mode must
    // refuse it — that refusal is exactly why frozen mode has to exist.
    expect(gitFindings({ status, head, remote: remoteMasterSha })).not.toEqual([]);
    // And the real current tip still clears ordinary mode, untouched by any of
    // the frozen-candidate machinery above.
    expect(gitFindings({ status, head: masterSha, remote: remoteMasterSha })).toEqual([]);
  }, 30_000);
});
