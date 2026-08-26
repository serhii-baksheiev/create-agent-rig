import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-116 — a proposal records the commit it was measured against, and hygiene
 * reports the one whose cited paths moved since.
 *
 * Two proposals in a row (AR-47, AR-87) escalated PREMISE FALSE because the merge
 * that falsified each landed AFTER the proposal was filed, and selection hands out
 * the oldest proposal first. Nothing on the item said which commit the finding
 * described, so nothing could say it had been overtaken.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const queueDir = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'queue',
);
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);
// Sanitised: under a git hook the inherited GIT_DIR/GIT_INDEX_FILE would aim
// these spawns at the shared repository (AR-148).
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, '.claude/scripts/git-env.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };
const git = (args: string[], cwd = repoRoot) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: withoutGitLocation() }).trim();

/**
 * A throwaway repository with two commits, so nothing here depends on this
 * checkout's history — CI clones shallow, and `HEAD~3` does not exist there.
 */
const twoCommitRepo = async (): Promise<{
  dir: string;
  first: string;
  second: string;
  moved: string;
}> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'asof-repo-'));
  const g = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...withoutGitLocation(),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  g(['init', '-q']);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  await writeFile(path.join(dir, 'src', 'b.mjs'), 'export const b = 1;\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'first']);
  const first = g(['rev-parse', 'HEAD']);
  await writeFile(path.join(dir, 'src', 'a.mjs'), 'export const a = 2;\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'second']);
  const second = g(['rev-parse', 'HEAD']);
  return { dir, first, second, moved: 'src/a.mjs' };
};

const proposal = {
  finding: 'journal/2026-08.md — hygiene never looked at queue/core.mjs',
  part: 'queue',
  change: 'record asOf on a proposal',
  proof: 'hygiene names the overtaken proposal',
};

describe('the pure core decides whether a proposal may have been overtaken', () => {
  it('reads the asOf marker out of a body, and null out of a body without one', async () => {
    const { asOfOf } = await load('core.mjs');
    expect(asOfOf('fingerprint: a:b:c\nasOf: 0123abc\n')).toBe('0123abc');
    expect(asOfOf('- finding — x · asOf: 0123abcdef0123 · fingerprint: `a`')).toBe(
      '0123abcdef0123',
    );
    expect(asOfOf('fingerprint: a:b:c\n')).toBeNull();
    expect(asOfOf('')).toBeNull();
    expect(asOfOf(null)).toBeNull();
    // Not a commit: too short, or not hex.
    expect(asOfOf('asOf: abc')).toBeNull();
    expect(asOfOf('asOf: zzzzzzzz')).toBeNull();
  });

  it('extracts the repository paths a proposal cites, once each', async () => {
    const { citedPathsOf } = await load('core.mjs');
    expect(
      citedPathsOf(
        'journal/2026-08.md, bullet "x": queue/index.mjs hygiene never reads `queue/core.mjs` ' +
          '(see .claude/rules/workflow.md). queue/index.mjs again.',
      ),
    ).toEqual([
      'journal/2026-08.md',
      'queue/index.mjs',
      'queue/core.mjs',
      '.claude/rules/workflow.md',
    ]);
    expect(citedPathsOf('no paths here, only prose.')).toEqual([]);
    expect(citedPathsOf(null)).toEqual([]);
  });

  it('reports a proposal with no asOf as unanswerable, never as clean', async () => {
    const { overtakenOf } = await load('core.mjs');
    expect(
      overtakenOf({
        id: 'AR-1',
        asOf: null,
        citedPaths: ['a.mjs'],
        head: 'ffff',
        changedSince: [],
      }),
    ).toMatchObject({ kind: 'proposal-asof-missing', id: 'AR-1' });
  });

  it('stays silent for a proposal filed against HEAD, and for one whose cited paths are unchanged', async () => {
    const { overtakenOf } = await load('core.mjs');
    expect(
      overtakenOf({
        id: 'AR-1',
        asOf: 'abcdef0',
        citedPaths: ['a.mjs'],
        head: 'abcdef0123456789',
        changedSince: [],
      }),
    ).toBeNull();
    expect(
      overtakenOf({
        id: 'AR-1',
        asOf: '1111111',
        citedPaths: ['a.mjs'],
        head: '2222222',
        changedSince: ['b.mjs', 'c/d.md'],
      }),
    ).toBeNull();
  });

  it('names the proposal whose cited path changed since its asOf, and the path', async () => {
    const { overtakenOf } = await load('core.mjs');
    const finding = overtakenOf({
      id: 'AR-1',
      asOf: '1111111',
      citedPaths: ['a.mjs', 'x/y.md'],
      head: '2222222',
      changedSince: ['x/y.md', 'other.ts'],
    });
    expect(finding).toMatchObject({ kind: 'proposal-possibly-overtaken', id: 'AR-1' });
    expect(finding.why).toMatch(/x\/y\.md/);
    expect(finding.why).toMatch(/1111111/);
  });

  it('matches a cited path by suffix, the way findings cite them', async () => {
    const { overtakenOf } = await load('core.mjs');
    // A finding says `queue/core.mjs`; git says `.claude/scripts/queue/core.mjs`.
    const finding = overtakenOf({
      id: 'AR-1',
      asOf: '1111111',
      citedPaths: ['queue/core.mjs'],
      head: '2222222',
      changedSince: ['.claude/scripts/queue/core.mjs'],
    });
    expect(finding).toMatchObject({ kind: 'proposal-possibly-overtaken' });
    expect(finding.why).toMatch(/\.claude\/scripts\/queue\/core\.mjs/);
    // A suffix is a path boundary, never a substring: `core.mjs` ≠ `not-core.mjs`.
    expect(
      overtakenOf({
        id: 'AR-1',
        asOf: '1111111',
        citedPaths: ['core.mjs'],
        head: '2222222',
        changedSince: ['x/not-core.mjs'],
      }),
    ).toBeNull();
  });

  it('reports "could not answer" when git could not diff from the asOf, never clean', async () => {
    const { overtakenOf } = await load('core.mjs');
    expect(
      overtakenOf({
        id: 'AR-1',
        asOf: '1111111',
        citedPaths: ['a.mjs'],
        head: '2222222',
        changedSince: null,
      }),
    ).toMatchObject({ kind: 'proposal-asof-unanswerable', id: 'AR-1' });
  });

  it('a proposal citing no path cannot be overtaken by a path, and says so rather than staying silent', async () => {
    const { overtakenOf } = await load('core.mjs');
    expect(
      overtakenOf({
        id: 'AR-1',
        asOf: '1111111',
        citedPaths: [],
        head: '2222222',
        changedSince: ['a.mjs'],
      }),
    ).toMatchObject({ kind: 'proposal-cites-no-path', id: 'AR-1' });
  });
});

describe('the commit a finding was measured against', () => {
  it('is HEAD of the checkout, and null where there is no checkout', async () => {
    const { headShaOf } = await load('as-of.mjs');
    expect(headShaOf({ cwd: repoRoot })).toBe(git(['rev-parse', 'HEAD']));
    const empty = await mkdtemp(path.join(tmpdir(), 'asof-'));
    expect(headShaOf({ cwd: empty })).toBeNull();
  });

  it('lists what changed since a commit, and null when git cannot answer', async () => {
    const { changedSinceOf } = await load('as-of.mjs');
    const { dir, first, second, moved } = await twoCommitRepo();
    expect(changedSinceOf({ cwd: dir, asOf: first, head: second })).toEqual([moved]);
    expect(changedSinceOf({ cwd: dir, asOf: second, head: second })).toEqual([]);
    expect(
      changedSinceOf({ cwd: dir, asOf: '0000000000000000000000000000000000000000', head: second }),
    ).toBeNull();
    // Never a revision expression: the argument is a commit or nothing.
    expect(changedSinceOf({ cwd: dir, asOf: 'HEAD~1', head: second })).toBeNull();
  });
});

describe('every adapter writes asOf into the filed item and lists its proposals back', () => {
  it('is part of the adapter contract', async () => {
    const { ADAPTER_CONTRACT } = await load('core.mjs');
    expect(ADAPTER_CONTRACT).toContain('listProposals');
  });

  it.each(['plan-md.mjs', 'github-issues.mjs', 'jira.mjs'])(
    '%s carries the asOf line in the triage item, and none when asOf is null',
    async (file) => {
      const adapter = await load(file);
      const withAsOf = adapter.triageItemFor({ ...proposal, asOf: 'abc1234abc1234' });
      expect(withAsOf.body).toMatch(/asOf: abc1234abc1234/);
      const without = adapter.triageItemFor({ ...proposal, asOf: null });
      expect(without.body).not.toMatch(/asOf: /);
      // The fingerprint is the dedupe key and must not move with the commit.
      expect(withAsOf.fingerprint).toBe(without.fingerprint);
    },
  );

  it('plan-md stamps the bullet with the checkout HEAD by default and lists it back', async () => {
    const adapter = await load('plan-md.mjs');
    const dir = await mkdtemp(path.join(tmpdir(), 'asof-plan-'));
    const planPath = path.join(dir, 'PLAN.md');
    await writeFile(planPath, '# Plan\n\n## Operator queue\n\n## Agent queue\n');

    const filed = adapter.proposeTriage(proposal, { planPath });
    expect(filed.ok).toBe(true);
    const head = git(['rev-parse', 'HEAD']);
    expect(await readFile(planPath, 'utf8')).toMatch(new RegExp(`asOf: ${head}`));

    const listed = adapter.listProposals({ planPath });
    expect(listed).toHaveLength(1);
    expect(listed[0].body).toMatch(new RegExp(`asOf: ${head}`));
    expect(listed[0].body).toMatch(/queue\/core\.mjs/);

    // A pinned asOf wins over HEAD, and null files without one.
    const pinned = adapter.proposeTriage(
      { ...proposal, change: 'second', asOf: 'feedface0' },
      { planPath },
    );
    expect(pinned.ok).toBe(true);
    const bare = adapter.proposeTriage({ ...proposal, change: 'third', asOf: null }, { planPath });
    expect(bare.ok).toBe(true);
    const bodies = adapter.listProposals({ planPath }).map((p: { body: string }) => p.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toMatch(/asOf: feedface0/);
    expect(bodies[2]).not.toMatch(/asOf: /);
    // Dedupe still keys on the fingerprint, whatever the commit.
    const again = adapter.proposeTriage({ ...proposal, asOf: 'feedface1' }, { planPath });
    expect(again).toMatchObject({ ok: true, seen: 2 });
  });

  it('listProposals on plan-md reports nothing on a plan with no Operator queue', async () => {
    const adapter = await load('plan-md.mjs');
    const dir = await mkdtemp(path.join(tmpdir(), 'asof-plan-'));
    const planPath = path.join(dir, 'PLAN.md');
    await writeFile(planPath, '# Plan\n\n## Agent queue\n');
    expect(adapter.listProposals({ planPath })).toEqual([]);
  });
});

describe('queue hygiene reports the proposal git has overtaken', () => {
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(queueDir, 'index.mjs'), ...args], {}, (e, out, err) =>
        resolve({
          code: e && typeof e.code === 'number' ? e.code : 0,
          stdout: String(out),
          stderr: String(err),
        }),
      );
    });

  // The config sits at `<root>/.claude/queue.json`, which is how the CLI learns
  // both the plan's location and the checkout whose history it asks git about.
  const planWith = async (dir: string, bullets: string[]): Promise<string> => {
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'plan-md' }),
    );
    await writeFile(
      path.join(dir, 'PLAN.md'),
      ['# Plan', '', '## Operator queue', '', ...bullets, '', '## Agent queue', ''].join('\n'),
    );
    return path.join(dir, '.claude', 'queue.json');
  };

  const bullet = (title: string, finding: string, asOf: string | null) =>
    `- **proposal: ${title} [triage]** — finding: ${finding} · part: queue · proof: p · ` +
    `${asOf ? `asOf: ${asOf} · ` : ''}fingerprint: \`${title}:queue:x\` · seen ×1`;

  it('names the overtaken one, the unanswerable one, and stays silent on the current one', async () => {
    const { dir, first: older, second: head, moved } = await twoCommitRepo();

    const cfg = await planWith(dir, [
      bullet('overtaken', `${moved} does not do X`, older),
      bullet('current', `${moved} does not do X`, head),
      bullet('untouched', 'never/changed/path.mjs does not do X', older),
      bullet('missing', `${moved} does not do X`, null),
      bullet('unknown', `${moved} does not do X`, '0000000000000000000000000000000000000000'),
    ]);
    const result = await run(['hygiene', '--config', cfg]);
    expect(result.code, result.stderr).toBe(0);
    // plan-md names a bullet by its line: the five bullets sit on lines 4..8.
    expect(result.stdout).toMatch(/\[proposal-possibly-overtaken\] 4 — /);
    expect(result.stdout).toMatch(/\[proposal-asof-missing\] 7 — /);
    expect(result.stdout).toMatch(/\[proposal-asof-unanswerable\] 8 — /);
    expect(result.stdout).not.toMatch(/\] 5 — /);
    expect(result.stdout).not.toMatch(/\] 6 — /);

    const json = await run(['hygiene', '--config', cfg, '--json']);
    const kinds = JSON.parse(json.stdout).findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain('proposal-possibly-overtaken');
    expect(kinds).toContain('proposal-asof-missing');
    expect(kinds).toContain('proposal-asof-unanswerable');
  });

  it('counts the proposals it checked, so an empty report says what it looked at', async () => {
    const { dir, second: head } = await twoCommitRepo();
    const cfg = await planWith(dir, [bullet('current', 'src/b.mjs does X', head)]);
    const result = await run(['hygiene', '--config', cfg]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/0 item\(s\) and 1 proposal\(s\) checked/);
  });
});
