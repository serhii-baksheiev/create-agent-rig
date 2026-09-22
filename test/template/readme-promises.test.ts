// RP-184 (PR1): README.md is the user-facing promise surface, and every
// promise it makes needs to correspond to a row of `## README promises` in
// `docs/command-contract.md` — the clause it belongs to, and evidence that
// resolves. This is the check for that correspondence.
//
// A "promise unit" is deliberately narrow — the bold-lead bullets of the top
// section and of "## Safe by default", the rows of the ownership table, the
// Limitations bullets, the Platform rows, and the Requirements bullets — the
// sentences a reader would actually cite back at Rig if one turned out false.
// Prose in between is not read.
//
// Matching is by a stable KEY, not the whole bullet verbatim: a bold-lead
// bullet's key is its bold lead ("One configuration, both harnesses."), a
// table row's key is its leading cell ("Linux"), and a plain bullet's key is
// its own text with wrapped lines folded onto one and whitespace collapsed.
// Table cells that had to carry a bullet's full multi-line prose verbatim
// would make the "## README promises" table unreadable; the key is what a
// reader can actually check the two documents against.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { candidatesFor, pointers, trackedTestFiles } from '../helpers/test-pointers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const README_PATH = path.join(repoRoot, 'README.md');
const CONTRACT_PATH = path.join(repoRoot, 'docs', 'command-contract.md');
const CHANGELOG_PATH = path.join(repoRoot, 'CHANGELOG.md');

const loadContract = () => readFile(CONTRACT_PATH, 'utf8');

// --- a tiny pipe-table reader, local to this file: the tables in README.md
// and in docs/command-contract.md are two different shapes, and only the
// pointer resolver was asked to move into test/helpers/ (RP-184). ---

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

interface PipeTable {
  headers: string[];
  rows: { cells: string[]; line: number }[];
}

function pipeTables(markdown: string): PipeTable[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: PipeTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.startsWith('|') || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!.trim())) continue;
    const headers = splitRow(lines[i]!).map((h) => h.toLowerCase());
    const rows: PipeTable['rows'] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.startsWith('|'); j++) {
      rows.push({ cells: splitRow(lines[j]!), line: j + 1 });
    }
    out.push({ headers, rows });
    i = j;
  }
  return out;
}

// --- README.md: promise-unit extraction ---

const sectionSlice = (md: string, heading: string): string => {
  const idx = md.indexOf(`\n${heading}\n`);
  expect(idx, `README.md must have a "${heading}" section`).toBeGreaterThan(-1);
  const from = idx + 1;
  const end = md.indexOf('\n## ', from + heading.length);
  return md.slice(from, end === -1 ? md.length : end);
};

const topSection = (md: string): string => {
  const end = md.indexOf('\n## ');
  expect(end, 'README.md has no "## " section at all').toBeGreaterThan(-1);
  return md.slice(0, end);
};

/** One raw bullet's text per `- ` item; a wrapped continuation line is folded in. */
const bulletsIn = (sectionText: string): string[] => {
  const lines = sectionText.split('\n');
  const bullets: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      if (current !== null) bullets.push(current);
      current = line.replace(/^-\s+/, '');
    } else if (current !== null && line.trim() !== '' && !line.trim().startsWith('|')) {
      current += ` ${line.trim()}`;
    } else if (current !== null) {
      bullets.push(current);
      current = null;
    }
  }
  if (current !== null) bullets.push(current);
  return bullets.map((b) => b.replace(/\s+/g, ' ').trim());
};

/** A bold-lead bullet's key is its bold lead; a plain bullet's key is itself. */
const promiseKeysOfBullets = (sectionText: string): string[] =>
  bulletsIn(sectionText).map((bullet) => {
    const lead = /^\*\*([^*]+)\*\*/.exec(bullet);
    return lead ? lead[1]!.trim() : bullet;
  });

const firstCellOf = (table: PipeTable): string[] =>
  table.rows.map((row) => (row.cells[0] ?? '').replace(/[`*]/g, '').trim());

/** Every promise unit README.md makes, by its stable key. */
function readmePromiseKeys(md: string): string[] {
  const ownership = pipeTables(sectionSlice(md, '## How ownership works'))[0];
  const platform = pipeTables(sectionSlice(md, '## Platform support'))[0];
  expect(ownership, 'no pipe table found under "## How ownership works"').toBeTruthy();
  expect(platform, 'no pipe table found under "## Platform support"').toBeTruthy();
  return [
    ...promiseKeysOfBullets(topSection(md)),
    ...promiseKeysOfBullets(sectionSlice(md, '## Safe by default')),
    ...firstCellOf(ownership!),
    ...promiseKeysOfBullets(sectionSlice(md, '## Limitations and non-goals')),
    ...firstCellOf(platform!),
    ...promiseKeysOfBullets(sectionSlice(md, '## Requirements')),
  ];
}

// --- docs/command-contract.md: the "## README promises" table, and its headings ---

function headingsOf(content: string): Set<string> {
  return new Set(
    [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/[`*]/g, '').trim()),
  );
}

interface PromiseRow {
  promise: string;
  clause: string;
  evidence: string;
  line: number;
}

function readmePromisesTable(contractMd: string): PromiseRow[] {
  const found = pipeTables(contractMd).find(
    (t) =>
      t.headers.includes('promise') &&
      t.headers.includes('clause') &&
      t.headers.includes('evidence'),
  );
  if (!found) return [];
  const at = (name: string) => found.headers.indexOf(name);
  return found.rows.map((row) => ({
    promise: (row.cells[at('promise')] ?? '').replace(/[`*]/g, '').trim(),
    clause: (row.cells[at('clause')] ?? '').replace(/[`*]/g, '').trim(),
    evidence: row.cells[at('evidence')] ?? '',
    line: row.line,
  }));
}

// --- the two-direction correspondence, as a pure function so a mutation can drive it ---

function promiseCorrespondence(readmeKeys: readonly string[], contractPromises: readonly string[]) {
  const readmeSet = new Set(readmeKeys);
  const contractSet = new Set(contractPromises);
  return {
    missingFromContract: readmeKeys.filter((key) => !contractSet.has(key)),
    extraInContract: contractPromises.filter((promise) => !readmeSet.has(promise)),
  };
}

// --- evidence resolution: a test pointer (the shared helper), a named release
// step, or the one named release script ---

function releaseSteps(changelog: string): Set<number> {
  const start = changelog.indexOf('## Releasing');
  expect(start, 'CHANGELOG.md must have a "## Releasing" section').toBeGreaterThan(-1);
  const section = changelog.slice(start);
  return new Set([...section.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1])));
}

async function evidenceProblem(
  cell: string,
  ctx: { tracked: string[]; steps: Set<number> },
): Promise<string | null> {
  const ptrs = pointers(cell);
  if (ptrs.length > 0) {
    for (const pointer of ptrs) {
      const candidates = candidatesFor(pointer.file, ctx.tracked);
      if (candidates.length === 0) return `no tracked test file ${pointer.file}`;
      if (candidates.length > 1) return `${pointer.file} is ambiguous — cite the path`;
      if (pointer.names.length === 0) return `${pointer.file} is cited without a › "test name"`;
      const source = await readFile(path.join(repoRoot, candidates[0]!), 'utf8');
      for (const name of pointer.names) {
        if (!source.includes(name)) return `${pointer.file} › "${name}" is not in that file`;
      }
    }
    return null;
  }
  const stepMatch = /CHANGELOG\.md\s+"Releasing"\s+step\s+(\d+)/.exec(cell);
  if (stepMatch) {
    return ctx.steps.has(Number(stepMatch[1]))
      ? null
      : `CHANGELOG.md "Releasing" names no step ${stepMatch[1]}`;
  }
  const scriptMatch = /`(scripts\/release-acceptance\.mjs)`/.exec(cell);
  if (scriptMatch) {
    try {
      await readFile(path.join(repoRoot, scriptMatch[1]!), 'utf8');
      return null;
    } catch {
      return `${scriptMatch[1]} does not exist`;
    }
  }
  return 'no recognised evidence form (a test pointer, a CHANGELOG.md "Releasing" step, or scripts/release-acceptance.mjs)';
}

describe('README.md promise units correspond to a table in docs/command-contract.md (RP-184)', () => {
  it('extracts a realistic number of promise units, from every one of the six groups', async () => {
    const readme = await readFile(README_PATH, 'utf8');
    const keys = readmePromiseKeys(readme);
    expect(
      keys.length,
      `too few promise units were extracted from README.md for this to have measured anything: ${JSON.stringify(keys)}`,
    ).toBeGreaterThanOrEqual(20);
    expect(keys, 'the top-section bold-lead bullets are not being extracted').toContain(
      'One configuration, both harnesses.',
    );
    expect(keys, 'the Safe-by-default bold-lead bullets are not being extracted').toContain(
      'Ownership, not guesswork.',
    );
    expect(keys, 'the ownership table rows are not being extracted').toContain(
      'exactly as Rig installed it',
    );
    expect(keys, 'the Platform support rows are not being extracted').toContain('Linux');
    expect(keys, 'the Requirements bullets are not being extracted').toContain('Git.');
  });

  it(
    'lists every README promise unit as a row of "## README promises", each naming an ' +
      'existing heading as its clause and carrying evidence that resolves',
    async () => {
      const [readme, contract, changelog] = await Promise.all([
        readFile(README_PATH, 'utf8'),
        loadContract(),
        readFile(CHANGELOG_PATH, 'utf8'),
      ]);
      const readmeKeys = readmePromiseKeys(readme);
      const rows = readmePromisesTable(contract);
      const headings = headingsOf(contract);
      const tracked = trackedTestFiles(repoRoot);
      const steps = releaseSteps(changelog);

      const { missingFromContract } = promiseCorrespondence(
        readmeKeys,
        rows.map((row) => row.promise),
      );
      expect(
        missingFromContract,
        'README.md promise units with no row in "## README promises"',
      ).toEqual([]);

      const problems: string[] = [];
      for (const row of rows) {
        if (!headings.has(row.clause)) {
          problems.push(
            `line ${row.line}: clause "${row.clause}" names no "##" heading of this contract`,
          );
        }
        const problem = await evidenceProblem(row.evidence, { tracked, steps });
        if (problem !== null)
          problems.push(`line ${row.line}: evidence does not resolve — ${problem}`);
      }
      expect(problems).toEqual([]);
    },
  );

  it('reports a stray contract row and a README promise the contract table never lists (mutation)', () => {
    const offenders = promiseCorrespondence(
      ['One configuration, both harnesses.', 'A clean exit.'],
      ['One configuration, both harnesses.', 'A stray promise nobody wrote in README.md'],
    );
    expect(offenders).toEqual({
      missingFromContract: ['A clean exit.'],
      extraInContract: ['A stray promise nobody wrote in README.md'],
    });
  });

  it('stops extracting a promise unit once its bold lead is removed from README.md (mutation)', async () => {
    const readme = await readFile(README_PATH, 'utf8');
    const fixture = '**A clean exit.** ';
    expect(
      readme,
      'the fixture text this mutation removes must exist verbatim in README.md today',
    ).toContain(fixture);
    const mutated = readme.replace(fixture, '');
    expect(mutated).not.toBe(readme);
    expect(readmePromiseKeys(readme)).toContain('A clean exit.');
    expect(readmePromiseKeys(mutated)).not.toContain('A clean exit.');
  });
});
