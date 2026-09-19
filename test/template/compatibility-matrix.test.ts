import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-178. `docs/compatibility.md` is a table of claims — "this capability is
 * SUPPORTED on this harness" — and a claim is only as good as the check behind
 * it. This file is that check for the document as a whole:
 *
 * - every status cell uses one word from the one vocabulary the document
 *   defines, and the document defines exactly the words below — a new word in
 *   either place goes red here;
 * - every row whose status claims something measured (SUPPORTED, DEGRADED,
 *   UNSUPPORTED) carries at least one evidence pointer, and every pointer in
 *   the evidence column resolves: the test file exists in this repository and
 *   its source contains the quoted test name;
 * - a row that claims nothing measured (NOT-APPLICABLE, UNVERIFIED) says why,
 *   in its notes column.
 *
 * What counts as a pointer, stated exactly: a backticked `*.test.ts` or
 * `*.test.mjs` name — a bare file name, or a repository-relative path —
 * followed by one or more `› "test name"` segments. A path resolves to that
 * one tracked file; a bare name resolves to the tracked file with that
 * basename, and is REFUSED when two files share it (`upgrade.test.ts` exists
 * twice), because picking one silently is how a citation ends up checking a
 * file nobody meant. A quoted name is matched as a substring of the resolved
 * file's source. A table without an `evidence` column is not a claim table
 * and is not read.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = path.join(repoRoot, 'docs', 'compatibility.md');

const VOCABULARY = ['SUPPORTED', 'DEGRADED', 'UNSUPPORTED', 'NOT-APPLICABLE', 'UNVERIFIED'];
const MEASURED = new Set(['SUPPORTED', 'DEGRADED', 'UNSUPPORTED']);
const NON_STATUS_COLUMNS = new Set(['capability', 'evidence', 'notes']);

interface Row {
  line: number;
  cells: Record<string, string>;
}
interface Table {
  headers: string[];
  rows: Row[];
}

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

function tables(markdown: string): Table[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: Table[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.startsWith('|') || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!.trim())) continue;
    const headers = splitRow(lines[i]!).map((h) => h.toLowerCase());
    const rows: Row[] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.startsWith('|'); j++) {
      const cells = splitRow(lines[j]!);
      rows.push({
        line: j + 1,
        cells: Object.fromEntries(headers.map((h, k) => [h, cells[k] ?? ''])),
      });
    }
    out.push({ headers, rows });
    i = j;
  }
  return out;
}

const claimTables = (markdown: string): Table[] =>
  tables(markdown).filter((t) => t.headers.includes('evidence'));

const statusColumns = (table: Table): string[] =>
  table.headers.filter((h) => !NON_STATUS_COLUMNS.has(h));

interface Pointer {
  file: string;
  names: string[];
}

const POINTER = /`([\w./-]+\.test\.(?:ts|mjs))`((?:\s*(?:and\s*)?›\s*"[^"]+")*)/g;

function pointers(cell: string): Pointer[] {
  return [...cell.matchAll(POINTER)].map((m) => ({
    file: m[1]!,
    names: [...m[2]!.matchAll(/"([^"]+)"/g)].map((n) => n[1]!),
  }));
}

function trackedTestFiles(): string[] {
  return execFileSync('git', ['ls-files', 'test', 'packages/cli/test'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.test\.(ts|mjs)$/.test(f));
}

/**
 * Every tracked path a pointer could mean. A bare basename that two files
 * share resolves to BOTH, and the caller refuses it: picking one silently is
 * how a citation ends up pointing at a file nobody meant (`upgrade.test.ts`
 * exists under `packages/cli/test/` and under `test/e2e/`). A pointer that
 * carries a path — `test/e2e/upgrade.test.ts` — names one file and resolves.
 */
function candidatesFor(pointerFile: string, files: string[]): string[] {
  if (pointerFile.includes('/')) return files.filter((f) => f === pointerFile);
  return files.filter((f) => path.basename(f) === pointerFile);
}

describe('docs/compatibility.md: one status vocabulary, and every claim resolves to a test', () => {
  it('defines exactly the status vocabulary this check enforces', async () => {
    const doc = await readFile(DOC, 'utf8');
    const start = doc.indexOf('## Status vocabulary');
    expect(start, 'docs/compatibility.md has no "## Status vocabulary" section').toBeGreaterThan(
      -1,
    );
    const end = doc.indexOf('\n## ', start + 1);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const defined = [...section.matchAll(/^- \*\*([A-Z-]+)\*\*/gm)].map((m) => m[1]!);
    expect(defined).toEqual(VOCABULARY);
  });

  it('uses only vocabulary words in every status cell', async () => {
    const doc = await readFile(DOC, 'utf8');
    const found = claimTables(doc);
    expect(found.length, 'no claim tables (with an evidence column) found').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const table of found) {
      const columns = statusColumns(table);
      expect(
        columns.length,
        `a claim table with no status column: ${table.headers.join(', ')}`,
      ).toBeGreaterThan(0);
      for (const row of table.rows) {
        for (const column of columns) {
          if (!VOCABULARY.includes(row.cells[column]!)) {
            bad.push(`line ${row.line}, ${column}: ${JSON.stringify(row.cells[column])}`);
          }
        }
      }
    }
    expect(bad, 'status cells outside the vocabulary').toEqual([]);
  });

  it('backs every measured status with a pointer, and explains every unmeasured one', async () => {
    const doc = await readFile(DOC, 'utf8');
    const problems: string[] = [];
    for (const table of claimTables(doc)) {
      for (const row of table.rows) {
        const statuses = statusColumns(table).map((c) => row.cells[c]!);
        if (
          statuses.some((s) => MEASURED.has(s)) &&
          pointers(row.cells.evidence ?? '').length === 0
        ) {
          problems.push(`line ${row.line}: a measured status with no test pointer`);
        }
        if (statuses.some((s) => !MEASURED.has(s)) && (row.cells.notes ?? '').trim() === '') {
          problems.push(`line ${row.line}: an unmeasured status with no note saying why`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('resolves every evidence pointer to a tracked test file whose source contains the quoted name', async () => {
    const doc = await readFile(DOC, 'utf8');
    const tracked = trackedTestFiles();
    const dead: string[] = [];
    for (const table of claimTables(doc)) {
      for (const row of table.rows) {
        for (const pointer of pointers(row.cells.evidence ?? '')) {
          const candidates = candidatesFor(pointer.file, tracked);
          if (candidates.length === 0) {
            dead.push(`line ${row.line}: no tracked test file ${pointer.file}`);
            continue;
          }
          if (candidates.length > 1) {
            dead.push(
              `line ${row.line}: ${pointer.file} is ambiguous (${candidates.join(', ')}) — cite the path`,
            );
            continue;
          }
          const file = candidates[0]!;
          const source = await readFile(path.join(repoRoot, file), 'utf8');
          if (pointer.names.length === 0) {
            dead.push(`line ${row.line}: ${pointer.file} is cited without a › "test name"`);
          }
          for (const name of pointer.names) {
            if (!source.includes(name)) dead.push(`line ${row.line}: ${pointer.file} › "${name}"`);
          }
        }
      }
    }
    expect(dead, 'pointers that do not reach a test').toEqual([]);
  });

  it('reads a planted dead pointer and a planted status word as failures, so the checks above are not vacuous', () => {
    const planted = [
      '| capability | Claude Code | evidence | notes |',
      '| --- | --- | --- | --- |',
      '| x | PARTIAL | `no-such-file.test.ts` › "nothing" | |',
    ].join('\n');
    const [table] = claimTables(planted);
    expect(statusColumns(table!)).toEqual(['claude code']);
    expect(VOCABULARY.includes(table!.rows[0]!.cells['claude code']!)).toBe(false);
    const tracked = trackedTestFiles();
    expect(candidatesFor(pointers(table!.rows[0]!.cells.evidence!)[0]!.file, tracked)).toEqual([]);
  });

  it('refuses a basename two tracked files share, and resolves the same pointer given as a path', () => {
    const tracked = trackedTestFiles();
    const shared = [...new Set(tracked.map((f) => path.basename(f)))].filter(
      (name) => tracked.filter((f) => path.basename(f) === name).length > 1,
    );
    expect(
      shared.length,
      'no basename is shared by two tracked test files, so this check has nothing to prove',
    ).toBeGreaterThan(0);
    const name = shared[0]!;
    expect(candidatesFor(name, tracked).length).toBeGreaterThan(1);
    const withPath = tracked.find((f) => path.basename(f) === name)!;
    expect(candidatesFor(withPath, tracked)).toEqual([withPath]);
  });
});
