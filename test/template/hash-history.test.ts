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

// The recognition step reverses substitution, and it can only reverse tokens
// that survive the round trip. This pins the limit the reversal documents:
// `__PROJECT_SCOPE__` and `@app/` substitute to the same text as
// `__PROJECT_NAME__`, so a layer using them could never be recognised again.
//
// It walks the tree itself rather than asking git: the file that introduces the
// violation is, by definition, the one being written right now — and `git grep`
// does not see an untracked file. It also cannot pass by failing, which is how
// a grep-based guard goes quietly green forever.
describe('the agent-os layer stays reversible', () => {
  const IRREVERSIBLE = ['__PROJECT_SCOPE__', '@app/'];

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
      if (IRREVERSIBLE.some((token) => content.includes(token))) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('would catch a violation — the matcher itself, not just its result', () => {
    const sample = 'import { thing } from "@app/core";';
    expect(IRREVERSIBLE.some((token) => sample.includes(token))).toBe(true);
  });
});
