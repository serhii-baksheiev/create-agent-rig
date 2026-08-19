import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs release script, imported for its pure parts
import { buildHistory, installRelPath } from '../../scripts/build-hash-history.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface HashHistory {
  versions: string[];
  files: Record<string, { since: string; hashes: string[] }>;
}

const readHistory = async (): Promise<HashHistory> =>
  JSON.parse(await readFile(path.join(repoRoot, 'templates', 'hash-history.json'), 'utf8'));

/**
 * The first version this repository tagged. Everything before it shipped
 * without a tag, so no table can be built for it — and no rig from that era
 * carries files an upgrade could recognise anyway.
 */
const OLDEST_TAGGED = '0.3.0';

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

  // The table is generated from tags at release. Forgetting to regenerate it
  // is invisible — an upgrade just quietly stops recognising the previous
  // release and calls every file a conflict — so the CHANGELOG is the witness.
  it('covers every released version below the one being prepared', async () => {
    const history = await readHistory();
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const released = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)]
      .map((match) => match[1]!)
      .filter((v) => isBelow(v, pkg.version) && !isBelow(v, OLDEST_TAGGED))
      .sort((a, b) => (isBelow(a, b) ? -1 : 1));

    expect(history.versions, 'stale table — run: node scripts/build-hash-history.mjs').toEqual(
      released,
    );
  });

  /**
   * `presentInEveryRelease` takes `versions[0]` as the oldest release, and that
   * is the value deciding whether a manifest-less rig keeps a deletion. The
   * builder sorts before writing, so position and age agree — this is what keeps
   * them agreeing, because nothing else would notice a row inserted anywhere but
   * the end. The positional read itself is pinned in
   * `packages/cli/test/history.test.ts` › "reads the baseline by position, so an
   * out-of-order table moves it".
   */
  it('ships its versions oldest first, because the baseline is read by position', async () => {
    const history = await readHistory();
    const sorted = [...history.versions].sort((a, b) => (isBelow(a, b) ? -1 : 1));
    expect(history.versions, 'out of order — the baseline is versions[0]').toEqual(sorted);
    // and the comparison used above can actually tell the two apart, so a green
    // assertion is evidence rather than a tautology over a one-element array
    expect(history.versions.length).toBeGreaterThan(1);
    const scrambled = [...history.versions].reverse();
    expect(scrambled).not.toEqual(sorted);
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
