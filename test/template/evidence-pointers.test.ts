// RP-66: a pointer to evidence a generated project never received.
//
// `.claude/rules/invariants.md` already carries the rule — a sentence about a
// mechanism is "either generated from the thing it describes, or a pointer to
// the test that proves it", and an inherited artifact "may cite the generator's
// upstream tests, which are absent locally, ONLY when the pointer says they are
// absent". Downstream AIC's governance reviewer found the rule being broken:
// `revalidation-report.mjs` cites `revalidation-evidence.test.ts › "…"` with no
// word to the reader that the file is not in their checkout.
//
// The rule had parts 1 and 3 of the invariant pattern and not part 2. This is
// part 2 — for the generated surface only, which is where the reader has no way
// to check the pointer for themselves.
//
// What counts as a pointer, stated exactly: a `*.test.ts` or `*.test.mjs` name
// followed by the `›` test-name marker on the same line or the next one. That
// is the citation form the rulebook prescribes, and it is what separates a
// citation from an illustration — `decision-router.mjs` naming `test/foo.test.ts`
// inside a worked example of a rename, or `doctor.mjs` explaining that
// `guard-x.mjs` pairs with `guard-x.test.mjs`, are not pointers and are not
// findings.
//
// Two ways to satisfy the rule, because eighteen of the pointers in this tree
// live in one file and repeating the same clause eighteen times is how a
// disclosure stops being read:
//   - inline, within two lines of the pointer;
//   - once per file, in a header disclosure that covers every pointer below it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const generatedSurface = path.join('templates', 'agent-os');

/** Tracked files under the generated surface, POSIX-spelled. */
const surfaceFiles = (): string[] =>
  execFileSync('git', ['ls-files', generatedSurface], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'));

/** The basenames a generated project actually receives. */
const shippedBasenames = (): Set<string> => new Set(surfaceFiles().map((p) => p.split('/').pop()!));

const TEST_NAME = /([A-Za-z0-9._-]+\.test\.(?:ts|mjs))/g;

/** What an INLINE marker beside one pointer looks like. */
const ABSENCE_MARKER = /absent in a generated rig|absent locally|in the generator\b/i;

/**
 * What a FILE-LEVEL disclosure looks like — the exact sentence nine scripts in
 * this tree already carry, introduced in 0.6.1. It is deliberately a fixed
 * phrase rather than "any mention of the generator": a file that names the
 * generator for some unrelated reason has told the reader nothing about its
 * pointers, and accepting that was the difference between this check finding
 * two offenders and finding none.
 */
const FILE_DISCLOSURE = 'All upstream test pointers in this script name the generator suite';

interface Pointer {
  file: string;
  line: number;
  target: string;
}

/**
 * The whole decision, over one file's text — pure, so the mutation test can
 * exercise it on content of its own rather than on the tree.
 */
const unmarkedIn = (file: string, text: string, shipped: ReadonlySet<string>): Pointer[] => {
  // CRLF is why this normalises rather than joining raw lines. A marker broken
  // across two lines reads as "absent in a generated\r rig" and matches
  // nothing, which cost one false finding here — `guard-rulebook.test.ts` in
  // the loop skill, marked all along, reported the moment an edit above it
  // shifted the line numbers.
  const lines = text.split(/\r?\n/);
  const window = (from: number, to: number) => lines.slice(from, to).join(' ').replace(/\s+/g, ' ');
  // The header is where a file-level disclosure lives: the leading comment
  // block, or the first 40 lines of a document, whichever the file has.
  const headerCovers = window(0, 40).includes(FILE_DISCLOSURE);
  const found: Pointer[] = [];
  lines.forEach((line, index) => {
    const isPointer = `${line} ${lines[index + 1] ?? ''}`.includes('›');
    if (!isPointer) return;
    for (const [, target] of line.matchAll(TEST_NAME)) {
      if (shipped.has(target!)) continue;
      const nearby = window(Math.max(0, index - 2), index + 3);
      if (ABSENCE_MARKER.test(nearby) || headerCovers) continue;
      found.push({ file, line: index + 1, target: target! });
    }
  });
  return found;
};

/**
 * Every pointer in the generated surface whose target the generated project
 * does not receive, and which carries no absence marker inline or in its file's
 * header.
 */
const unmarkedPointers = async (): Promise<Pointer[]> => {
  const shipped = shippedBasenames();
  const found: Pointer[] = [];
  for (const file of surfaceFiles()) {
    let text: string;
    try {
      text = await readFile(path.join(repoRoot, file), 'utf8');
    } catch {
      continue; // a path git tracks that this checkout cannot read is not this test's finding
    }
    found.push(...unmarkedIn(file, text, shipped));
  }
  return found;
};

describe('evidence pointers in the generated surface', () => {
  it('finds pointers at all, so an empty result is a measurement and not a parse failure', async () => {
    // The whole check is a negative assertion, and a negative assertion over a
    // parser that silently matches nothing is the shape that passes on nothing.
    // So the parser is exercised in the positive direction first.
    const shipped = shippedBasenames();
    let pointers = 0;
    for (const file of surfaceFiles()) {
      const text = await readFile(path.join(repoRoot, file), 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!`${line} ${lines[index + 1] ?? ''}`.includes('›')) return;
        for (const [, target] of line.matchAll(TEST_NAME)) if (!shipped.has(target!)) pointers += 1;
      });
    }
    expect(pointers, 'no evidence pointers were parsed, so nothing was checked').toBeGreaterThan(
      20,
    );
  });

  it('marks every pointer whose test a generated project never receives', async () => {
    const unmarked = await unmarkedPointers();
    expect(
      unmarked.map((p) => `${p.file}:${p.line} cites ${p.target} with no word that it is absent`),
    ).toEqual([]);
  });

  it('names the file, line and target of an unmarked pointer (mutation)', () => {
    // The check is a negative assertion over the tree, so its positive
    // behaviour is exercised here on content of its own: the same pointer shape
    // the rulebook prescribes, once with the marker and once without.
    const shipped = new Set(['queue-board.test.ts']);
    const marked = [
      '// the behaviour is pinned in the generator’s',
      '// `test/template/revalidation-evidence.test.ts` (absent in a generated rig) › "reads the runs"',
    ].join('\n');
    const unmarked = [
      '// the behaviour is pinned in',
      '// `test/template/revalidation-evidence.test.ts` › "reads the runs"',
    ].join('\n');
    expect(unmarkedIn('x.mjs', marked, shipped), 'a marked pointer was reported').toEqual([]);
    expect(unmarkedIn('x.mjs', unmarked, shipped), 'an unmarked pointer was not reported').toEqual([
      { file: 'x.mjs', line: 2, target: 'revalidation-evidence.test.ts' },
    ]);
    // And a pointer whose test the rig DOES receive needs no marker at all.
    const shippedPointer = '// see `queue-board.test.ts` › "refuses a board nobody declared"';
    expect(
      unmarkedIn('x.mjs', shippedPointer, shipped),
      'a pointer to a test the rig ships was reported',
    ).toEqual([]);
  });
});
