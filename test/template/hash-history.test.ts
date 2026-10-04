import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildHistory,
  installRelPath,
  releasedFromLedger,
  tagDisagreements,
  // @ts-expect-error — a plain .mjs release script, imported for its pure parts
} from '../../scripts/build-hash-history.mjs';
// @ts-expect-error — a plain .mjs rulebook script
import { withoutGitLocation } from '../../.claude/scripts/git-env.mjs';
// RP-353: the heading-parsing half of `changelogVersions()` is private and
// reads straight off disk, so it cannot be pinned directly with a synthetic
// fixture today. Taken off the namespace, not by name — a missing export fails
// only the tests that use it, the same reasoning
// `test/template/release-preflight.test.ts` states for its own namespace
// import.
// @ts-expect-error — a plain .mjs release script, imported for its pure parts
import * as hashHistory from '../../scripts/build-hash-history.mjs';

const { parseChangelogVersions, assertCandidateHeadingsAreCurrent } = hashHistory as {
  parseChangelogVersions: (markdown: string) => string[];
  // RP-353 review blocker D: a `## X.Y.Z (release candidate)` heading is only
  // ever correct for the version CURRENTLY being prepared (package.json's own
  // version) — for any OTHER version it means reconciliation back to
  // `## X.Y.Z` was forgotten after THAT version published, and the ledger
  // requirement at the NEXT release must not silently skip it the way
  // `parseChangelogVersions` does today (its anchored regex excludes every
  // candidate heading, whichever version it names, with no way to tell "still
  // pending" apart from "forgot to reconcile"). Pure, and throws rather than
  // returning findings — the same shape `releasedFromLedger` already uses in
  // this file for "the CHANGELOG and the ledger disagree about what has been
  // released", which this is a sibling check for.
  assertCandidateHeadingsAreCurrent: (markdown: string, currentVersion: string) => void;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface HashHistory {
  versions: string[];
  files: Record<string, { since: string; hashes: string[] }>;
}

const readHistory = async (): Promise<HashHistory> =>
  JSON.parse(await readFile(path.join(repoRoot, 'templates', 'hash-history.json'), 'utf8'));

/**
 * "version X was published from commit Y" — the value of
 * `npm view create-agent-rig@X gitHead`. A `null` is an explicit decision that
 * the published bytes are not recoverable from git (0.1.0's gitHead already
 * reads 0.2.0), so no row is built for it. An ABSENT entry is a mistake.
 */
type Ledger = Record<string, string | null>;

const readLedger = async (): Promise<Ledger> =>
  JSON.parse(await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'));

const readPkgVersion = async (): Promise<string> =>
  (JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string })
    .version;

const changelogVersions = async (): Promise<string[]> =>
  [
    ...(await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8')).matchAll(
      /^## (\d+\.\d+\.\d+)$/gm,
    ),
  ].map((match) => match[1]!);

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, env: withoutGitLocation(), encoding: 'utf8' });

const asNumbers = (version: string): number[] =>
  version.split('.').map((part) => Number.parseInt(part, 10));

function isBelow(a: string, b: string): boolean {
  const [x, y] = [asNumbers(a), asNumbers(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

describe('the released-hash table — what a manifest-less rig is measured against', () => {
  it('ships with the templates, keyed by install path, holding sha256 hashes', async () => {
    const history = await readHistory();
    expect(Object.keys(history.files).length).toBeGreaterThan(20);
    expect(history.files['.claude/rules/workflow.md']?.hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    for (const [rel, entry] of Object.entries(history.files)) {
      expect(rel, 'install-relative, never a template path').not.toMatch(/^templates\//);
      expect(entry.hashes.length, rel).toBeGreaterThan(0);
      expect(new Set(entry.hashes).size, `${rel}: duplicated hashes`).toBe(entry.hashes.length);
      // `since` is what lets a manifest-less rig keep a deletion — a path
      // claiming a version the table never built from decides nothing
      expect(history.versions, `${rel}: unknown "since"`).toContain(entry.since);
    }
  });

  // The table is generated from the release ledger. Forgetting to regenerate it
  // is invisible — an upgrade just quietly stops recognising the previous
  // release and calls every file a conflict — so the CHANGELOG is the witness.
  // A version the ledger records as `null` (unrecoverable) has no row.
  it('covers every released version below the one being prepared', async () => {
    const history = await readHistory();
    const ledger = await readLedger();
    const current = await readPkgVersion();
    const released = (await changelogVersions())
      .filter((v) => isBelow(v, current) && ledger[v] !== null)
      .sort((a, b) => (isBelow(a, b) ? -1 : 1));

    expect(history.versions, 'stale table — run: node scripts/build-hash-history.mjs').toEqual(
      released,
    );
  });

  it('carries the previous 0.6.0 release bytes into the 0.6.1 package', async () => {
    const history = await readHistory();
    expect(history.versions).toContain('0.6.0');
  });

  it('maps a template path to where the file installs, dropping the layer', () => {
    expect(installRelPath('templates/agent-os/universal/.claude/rules/workflow.md')).toBe(
      '.claude/rules/workflow.md',
    );
    expect(installRelPath('templates/agent-os/init/CLAUDE.md')).toBe('CLAUDE.md');
    expect(installRelPath('templates/agent-os/stack/aws-cdk/.claude/rules/aws-cdk.md')).toBe(
      '.claude/rules/aws-cdk.md',
    );
    // tooling metadata and non-agent-os paths are not payload
    expect(installRelPath('templates/agent-os/universal/layers.json')).toBeNull();
    expect(installRelPath('templates/skeleton/node-service/package.json')).toBeNull();
  });

  it('keeps one entry per distinct version of a file, and when it first shipped', () => {
    const history = buildHistory([
      { version: '0.3.0', files: { 'a.md': 'h1', 'b.md': 'h2' } },
      { version: '0.3.1', files: { 'a.md': 'h1', 'b.md': 'h3', 'c.md': 'h4' } },
    ]) as HashHistory;
    expect(history.versions).toEqual(['0.3.0', '0.3.1']);
    expect(history.files['a.md']).toEqual({ since: '0.3.0', hashes: ['h1'] });
    expect(history.files['b.md']).toEqual({ since: '0.3.0', hashes: ['h2', 'h3'] });
    // added later — an older rig is missing it because it never had it
    expect(history.files['c.md']).toEqual({ since: '0.3.1', hashes: ['h4'] });
  });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('the release ledger — which commit each version was published from', () => {
  it('lists every changelog version below the current one, oldest first, with its commit', () => {
    const ledger: Ledger = { '0.3.1': SHA_B, '0.3.0': SHA_A, '0.4.0': SHA_C };
    expect(releasedFromLedger(ledger, '0.5.0', ['0.4.0', '0.3.1', '0.3.0'])).toEqual([
      { version: '0.3.0', commit: SHA_A },
      { version: '0.3.1', commit: SHA_B },
      { version: '0.4.0', commit: SHA_C },
    ]);
  });

  it('ignores the version being prepared and anything above it, even when the ledger has it', () => {
    const ledger: Ledger = { '0.3.0': SHA_A, '0.4.0': SHA_B, '0.5.0': SHA_C };
    expect(releasedFromLedger(ledger, '0.4.0', ['0.5.0', '0.4.0', '0.3.0'])).toEqual([
      { version: '0.3.0', commit: SHA_A },
    ]);
  });

  it('excludes a version recorded as null — an explicit "unrecoverable", not a row', () => {
    const ledger: Ledger = { '0.1.0': null, '0.2.0': SHA_A };
    expect(releasedFromLedger(ledger, '0.3.0', ['0.2.0', '0.1.0'])).toEqual([
      { version: '0.2.0', commit: SHA_A },
    ]);
  });

  it('throws for a released version the ledger does not mention, naming the version and the npm command', () => {
    const ledger: Ledger = { '0.3.0': SHA_A };
    expect(() => releasedFromLedger(ledger, '0.5.0', ['0.4.0', '0.3.0'])).toThrow(/0\.4\.0/);
    expect(() => releasedFromLedger(ledger, '0.5.0', ['0.4.0', '0.3.0'])).toThrow(
      'npm view create-agent-rig@0.4.0 gitHead',
    );
  });

  it('tells an absent entry (throws) apart from a null one (excluded silently)', () => {
    const absent: Ledger = { '0.2.0': SHA_A };
    const explicit: Ledger = { '0.1.0': null, '0.2.0': SHA_A };
    const versions = ['0.2.0', '0.1.0'];
    expect(() => releasedFromLedger(absent, '0.3.0', versions)).toThrow(/0\.1\.0/);
    expect(() => releasedFromLedger(explicit, '0.3.0', versions)).not.toThrow();
  });

  it('throws when a value is neither null nor a 40-char lowercase hex sha, naming the version', () => {
    for (const bad of ['abc', SHA_A.toUpperCase(), 'v0.3.0', '', undefined, 42]) {
      const ledger = { '0.3.0': bad } as unknown as Ledger;
      expect(() => releasedFromLedger(ledger, '0.4.0', ['0.3.0']), String(bad)).toThrow(/0\.3\.0/);
    }
  });

  it('throws when a key is not X.Y.Z, naming the key', () => {
    const ledger: Ledger = { 'v0.3.0': SHA_A, '0.3.0': SHA_B };
    expect(() => releasedFromLedger(ledger, '0.4.0', ['0.3.0'])).toThrow(/v0\.3\.0/);
  });

  it('reports a tag whose sha disagrees with the ledger, and nothing for a matching or unledgered tag', () => {
    const ledger: Ledger = { '0.3.0': SHA_A, '0.4.0': SHA_B };
    expect(tagDisagreements(ledger, { 'v0.3.0': SHA_A, 'v0.4.0': SHA_C, 'v0.2.0': SHA_C })).toEqual(
      [{ version: '0.4.0', tag: SHA_C, ledger: SHA_B }],
    );
    expect(tagDisagreements(ledger, {})).toEqual([]);
  });

  it('builds the table from the ledger alone — tags are a warning source, never an input', () => {
    const perVersion = [{ version: '0.3.0', files: { 'a.md': 'h1' } }];
    // the signature is tag-free: one argument, and the output is a function of it only
    expect(buildHistory.length).toBe(1);
    expect(buildHistory(perVersion)).toEqual(buildHistory(perVersion));
  });
});

describe('the committed ledger against this repository', () => {
  it('points at a commit whose package.json carries that version', async () => {
    const ledger = await readLedger();
    const entries = Object.entries(ledger).filter(([, sha]) => sha !== null);
    expect(entries.length, 'a ledger with no resolvable entry pins nothing').toBeGreaterThan(0);
    for (const [version, sha] of entries) {
      expect(sha, version).toMatch(/^[0-9a-f]{40}$/);
      expect(() => git('cat-file', '-e', `${sha}^{commit}`), `${version}: ${sha}`).not.toThrow();
      const pkg = JSON.parse(git('show', `${sha}:package.json`)) as { version: string };
      expect(pkg.version, `${version} -> ${sha}`).toBe(version);
    }
  });

  it('has an entry (null or sha) for every CHANGELOG version below the current one', async () => {
    const ledger = await readLedger();
    const current = await readPkgVersion();
    const missing = (await changelogVersions()).filter(
      (v) => isBelow(v, current) && !(v in ledger),
    );
    expect(missing, 'add: npm view create-agent-rig@<version> gitHead').toEqual([]);
  });
});

// The universal payload supports only `__PROJECT_NAME__`. This pins the source
// tree as well as the renderer: an old app token must not silently ship as
// literal text merely because the substitution code no longer recognises it.
//
// It walks the tree itself rather than asking git: the file that introduces the
// violation is, by definition, the one being written right now — and `git grep`
// does not see an untracked file. It also cannot pass by failing, which is how
// a grep-based guard goes quietly green forever.
describe('the agent-os layer uses only the supported token', () => {
  const UNSUPPORTED = ['__PROJECT_SCOPE__', '__REGION__', '@app/'];

  const walk = async (dir: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(full)));
      else if (entry.isFile()) found.push(full);
    }
    return found;
  };

  it('uses no token an upgrade cannot turn back', async () => {
    const files = await walk(path.join(repoRoot, 'templates', 'agent-os'));
    // positive control: a walk that found nothing would pass silently
    expect(files.length, 'the agent-os layer is not empty').toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      if (UNSUPPORTED.some((token) => content.includes(token))) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('would catch a violation — the matcher itself, not just its result', () => {
    const sample = 'import { thing } from "@app/core";';
    expect(UNSUPPORTED.some((token) => sample.includes(token))).toBe(true);
  });
});

// RP-353: 1.2.0 frozen at `release/1.2.0-rc` while master prepares 1.2.1 must
// not force a ledger row for 1.2.0 before it has actually been published — the
// declared escape is the heading `## X.Y.Z (release candidate)`, which this
// table's own regex already excludes by being anchored (`^## (\d+\.\d+\.\d+)$`).
// This pins that on purpose, with the regex pulled out where a test can reach
// it, so a future "helpful" loosening of the anchor is caught here rather than
// surfacing as a demand for a ledger row on an unpublished candidate.
describe('the changelog heading that counts as "released" — exact only, a candidate heading is not released yet', () => {
  it('matches only an exact "## X.Y.Z" heading, skipping a release-candidate one between two real releases', () => {
    const changelog = [
      '## 1.2.1',
      '',
      'body',
      '',
      '## 1.2.0 (release candidate)',
      '',
      'body',
      '',
      '## 1.1.0',
      '',
      'body',
      '',
    ].join('\n');
    expect(parseChangelogVersions(changelog)).toEqual(['1.2.1', '1.1.0']);
  });

  // The direction that would cost a release: each of these carries the literal
  // substring "## 1.2.0", which is exactly what a looser match would accept.
  it('does not treat a looser candidate spelling as released either', () => {
    for (const heading of ['## 1.2.0-rc', '## 1.2.0 rc1', '## 1.2.0beta', '## 1.2.0.1']) {
      expect(parseChangelogVersions(`${heading}\n\nbody\n`), heading).toEqual([]);
    }
  });

  // The independent oracle: the committed CHANGELOG.md, read through this
  // file's OWN duplicated regex (`changelogVersions` above) rather than through
  // `parseChangelogVersions` checking its own work.
  it("agrees with the committed CHANGELOG.md read through this file's own duplicated regex", async () => {
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(parseChangelogVersions(changelog)).toEqual(await changelogVersions());
  });
});

// RP-353 review blocker D: `parseChangelogVersions` above correctly EXCLUDES
// every "(release candidate)" heading from "released" — that part is already
// right, and the describe block above pins it. What is missing is telling two
// very different reasons for a candidate heading apart:
//
//   - it names the version CURRENTLY being prepared (package.json's own
//     version) — correct, unpublished, still pending;
//   - it names ANY OTHER version — which can only mean that version was
//     published and nobody reconciled its heading back to `## X.Y.Z`
//     afterwards. Left alone, `parseChangelogVersions` simply drops that
//     version from the "released" list forever: `releasedFromLedger` never
//     sees it, never demands a ledger row for it, and the published version
//     is silently absent from `hash-history.json` — an upgrade on a
//     manifest-less rig then treats every file that version shipped as
//     unrecognised, exactly the failure class this whole table exists to
//     prevent (see this file's own header comment above).
//
// `assertCandidateHeadingsAreCurrent` is the check: it throws, naming the
// stale version, when the changelog carries a release-candidate heading for
// anything other than the version being prepared. It is silent for a
// candidate heading on the version being prepared itself, and silent when
// there is no candidate heading at all.
describe('the changelog heading history — a release-candidate heading left on an OLD version means reconciliation was forgotten', () => {
  it('says nothing when the only candidate heading names the version currently being prepared', () => {
    const changelog = [
      '## 1.2.0 (release candidate)',
      '',
      'body',
      '',
      '## 1.1.0',
      '',
      'body',
      '',
    ].join('\n');
    expect(() => assertCandidateHeadingsAreCurrent(changelog, '1.2.0')).not.toThrow();
  });

  it('says nothing when there is no candidate heading at all', () => {
    const changelog = ['## 1.2.0', '', 'body', '', '## 1.1.0', '', 'body', ''].join('\n');
    expect(() => assertCandidateHeadingsAreCurrent(changelog, '1.2.0')).not.toThrow();
  });

  // The defect this exists to catch: 1.1.0 was published (its CHANGELOG
  // heading should have become plain `## 1.1.0`), reconciliation was
  // forgotten, and 1.2.1 is now being prepared. Today's code gives this no
  // signal at all — `parseChangelogVersions` just quietly drops 1.1.0 from the
  // released list.
  it('throws, naming the stale version, for a candidate heading on a version other than the one being prepared', () => {
    const changelog = [
      '## 1.2.1',
      '',
      'body',
      '',
      '## 1.1.0 (release candidate)',
      '',
      'body',
      '',
    ].join('\n');
    expect(() => assertCandidateHeadingsAreCurrent(changelog, '1.2.1')).toThrow(/1\.1\.0/);
  });

  // The message has to tell the owner what to do, not just that something is
  // wrong — the same courtesy `releasedFromLedger`'s own thrown messages pay
  // (naming the exact npm command to run).
  it('names the fix: reconcile the stale heading to the plain form after publication', () => {
    const changelog = '## 1.1.0 (release candidate)\n\nbody\n';
    expect(() => assertCandidateHeadingsAreCurrent(changelog, '1.2.0')).toThrow(/## 1\.1\.0/);
    expect(() => assertCandidateHeadingsAreCurrent(changelog, '1.2.0')).toThrow(/reconcil/i);
  });

  // Independent of how many stale candidate headings exist, and independent of
  // whether the CURRENT version's own candidate heading is also present — the
  // one check must not let a legitimately-pending heading mask a forgotten one
  // sitting right next to it.
  it('throws for a stale heading even when the current version also carries its own pending candidate heading', () => {
    const changelog = [
      '## 1.3.0 (release candidate)',
      '',
      'body',
      '',
      '## 1.2.0 (release candidate)',
      '',
      'body',
      '',
    ].join('\n');
    expect(() => assertCandidateHeadingsAreCurrent(changelog, '1.3.0')).toThrow(/1\.2\.0/);
  });

  // Exactness, mirrored from the sibling suite above: a looser spelling that
  // merely carries the substring "(release candidate)" adjacent to a version
  // number must not be read as one by this check either — it is not a
  // candidate heading at all, so it is simply not this check's business,
  // exactly as it is not `parseChangelogVersions`'s.
  it('does not mistake a loosely-spelled heading for a candidate heading needing reconciliation', () => {
    const changelog = '## 1.1.0-rc\n\nbody\n';
    expect(() => assertCandidateHeadingsAreCurrent(changelog, '1.2.0')).not.toThrow();
  });
});
