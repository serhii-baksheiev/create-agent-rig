// RP-66: an evidence pointer that no longer reaches its evidence.
//
// Two failure modes, and the item asked for both:
//
//   1. the target moved. A pointer names `test/template/x.test.ts` › "some
//      behaviour"; the file is renamed or the test is retitled, and the
//      sentence beside the pointer keeps claiming backing it no longer has.
//      `.claude/rules/invariants.md` says a pointer "cannot quietly drift,
//      because a renamed test makes it a dead reference" — true, but until now
//      only a reviewer noticed.
//   2. the target was never theirs to read. A generated project receives the
//      rulebook and not the generator's suite, so a pointer into `test/` is a
//      path that does not exist in their checkout. The same rules file allows
//      it "ONLY when the pointer says they are absent"; downstream AIC's
//      governance reviewer found that rule being broken.
//
// The rule had parts 1 and 3 of the invariant pattern and no part 2. This is
// part 2 for both halves.
//
// What counts as a pointer, stated exactly: a `*.test.ts` or `*.test.mjs` name
// followed by the `›` test-name marker on the same line or the next one. That
// is the citation form the rulebook prescribes, and it is what separates a
// citation from an illustration — `decision-router.mjs` naming
// `test/foo.test.ts` inside a worked example of a rename, or `doctor.mjs`
// explaining that `guard-x.mjs` pairs with `guard-x.test.mjs`, carry no `›`,
// are not citations, and are not findings.
//
// Limits, stated:
//   - a quoted test name is matched as a substring of the named file's source,
//     not against a parse of `it('…')`. The names here are declared four ways,
//     and a parser that understood three of them called the fourth renamed.
//     `%s` and `$guard` are wildcards, because a parameterised name is
//     genuinely partial; a short quoted fragment could therefore match by
//     accident, which is a missed rename and never a false red;
//   - the disclosure half accepts a file-level sentence as well as an inline
//     marker, because sixteen pointers in one file would otherwise carry
//     sixteen copies of one clause, which is how a disclosure stops being read;
//   - line endings are normalised before any window is built. A marker that
//     wraps across two lines is the ordinary case here, not the exception.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tracked = (dir: string): string[] =>
  execFileSync('git', ['ls-files', dir], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'));

/** Tracked files under the generated surface — what a rig receives. */
const surfaceFiles = (): string[] => tracked(path.join('templates', 'agent-os'));

/** The test files this repository actually has, by basename. */
const generatorTests = (): Map<string, string> => {
  const byName = new Map<string, string>();
  for (const file of tracked('test')) {
    if (/\.test\.(ts|mjs)$/.test(file)) byName.set(file.split('/').pop()!, file);
  }
  // Some pointers name a test that ships INTO the rig, beside the thing it
  // covers; those resolve against the surface itself.
  for (const file of surfaceFiles()) {
    if (/\.test\.(ts|mjs)$/.test(file)) byName.set(file.split('/').pop()!, file);
  }
  return byName;
};

/** The basenames a generated project receives, so a pointer into them needs no disclosure. */
const shippedBasenames = (): Set<string> => new Set(surfaceFiles().map((p) => p.split('/').pop()!));

const TEST_NAME = /([A-Za-z0-9._-]+\.test\.(?:ts|mjs))/g;

/**
 * The disclosure vocabulary, and it is deliberately narrow. `in the generator`
 * was in an earlier draft and is gone: it says where the test lives and nothing
 * about whether the reader has it, which is precisely what the rule requires a
 * pointer to say.
 */
const ABSENCE_MARKER =
  /absent in a generated rig|absent locally|absent in a\s+\S*\s*generated rig/i;

/**
 * The file-level form, the exact sentence nine scripts in this tree carry. A
 * fixed phrase rather than "any mention of the generator": a file that names
 * the generator for an unrelated reason has told the reader nothing about its
 * pointers.
 */
const FILE_DISCLOSURE = 'All upstream test pointers in this script name the generator suite';

interface Pointer {
  file: string;
  line: number;
  target: string;
  /** The quoted test names on the pointer's line and the two after it. */
  names: string[];
  disclosed: boolean;
}

/**
 * Join a span into one string the way a reader reads it: comment leaders
 * stripped, whitespace collapsed. Without the leader strip a test name that
 * wraps arrives as `"$guard blocks with a neutral, // actionable size-limit
 * refusal"` and matches nothing — the citation form in this tree wraps
 * constantly, so this is the ordinary case rather than an edge one.
 */
const normalise = (lines: readonly string[], from: number, to: number): string =>
  lines
    .slice(from, to)
    .map((line) => line.replace(/^\s*(?:\/\/+|\*|#)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');

/** Every citation in one file's text, with what backs it. Pure, so a test can drive it. */
const pointersIn = (file: string, text: string, shipped: ReadonlySet<string>): Pointer[] => {
  const lines = text.split(/\r?\n/);
  const headerCovers = normalise(lines, 0, 40).includes(FILE_DISCLOSURE);
  const found: Pointer[] = [];
  lines.forEach((line, index) => {
    if (!`${line} ${lines[index + 1] ?? ''}`.includes('›')) return;
    for (const [, target] of line.matchAll(TEST_NAME)) {
      const window = normalise(lines, Math.max(0, index - 2), index + 3);
      // A citation may list several names after one file; read the window so a
      // continuation line is not lost.
      const names = [...normalise(lines, index, index + 3).matchAll(/›\s*"([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      found.push({
        file,
        line: index + 1,
        target: target!,
        names,
        disclosed: shipped.has(target!) || headerCovers || ABSENCE_MARKER.test(window),
      });
    }
  });
  return found;
};

const allPointers = async (): Promise<Pointer[]> => {
  const shipped = shippedBasenames();
  const found: Pointer[] = [];
  for (const file of surfaceFiles()) {
    found.push(...pointersIn(file, await readFile(path.join(repoRoot, file), 'utf8'), shipped));
  }
  return found;
};

/**
 * Does the named file still declare this test name?
 *
 * Substring against the file's normalised source, not an `it('…')` parse. The
 * names in this suite are declared four different ways — a plain `it('…')`, an
 * `it.each([…])('… %s …')`, a shared const reused by a template, and one name
 * that contains its own double quotes — and a parser that understood three of
 * them reported the fourth as renamed. Matching the text the reader would grep
 * for is what the pointer is FOR.
 *
 * Limits: `%s` and `$guard` are wildcards, because a parameterised name is
 * genuinely partial; and a very short quoted fragment could match by accident.
 * That direction is a missed rename, never a false red, which is the safe way
 * round for a check nobody is watching.
 */
const declares = (source: string, name: string): boolean => {
  const haystack = source.replace(/\s+/g, ' ');
  const parts = name
    .split(/%s|\$guard/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
  return parts.every((part) => haystack.includes(part));
};

describe('evidence pointers in the generated surface', () => {
  it('parses citations at all, so an empty result is a measurement and not a silent parse failure', async () => {
    const pointers = await allPointers();
    // 107 on the head this was written against. The floor is close to it on
    // purpose: a guard set at 20 would let a regression cut detection by four
    // fifths and still pass.
    expect(
      pointers.length,
      'too few citations were parsed for this to have checked anything',
    ).toBeGreaterThan(90);
  });

  it('names a test file this repository still has', async () => {
    const tests = generatorTests();
    const dead = (await allPointers())
      .filter((p) => !tests.has(p.target))
      .map((p) => `${p.file}:${p.line} cites ${p.target}, which no longer exists`);
    expect(dead).toEqual([]);
  });

  it('quotes a test name that file still declares', async () => {
    const tests = generatorTests();
    const sources = new Map<string, string>();
    const dead: string[] = [];
    for (const pointer of await allPointers()) {
      const target = tests.get(pointer.target);
      if (target === undefined) continue; // the previous test owns that finding
      if (!sources.has(target)) {
        sources.set(target, await readFile(path.join(repoRoot, target), 'utf8'));
      }
      const source = sources.get(target)!;
      for (const name of pointer.names) {
        if (!declares(source, name)) {
          dead.push(
            `${pointer.file}:${pointer.line} quotes "${name}", which ${target} no longer declares`,
          );
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('says so when the test it names is one a generated project never receives', async () => {
    const undisclosed = (await allPointers())
      .filter((p) => !p.disclosed)
      .map((p) => `${p.file}:${p.line} cites ${p.target} with no word that it is absent`);
    expect(undisclosed).toEqual([]);
  });

  it('reports a renamed target, a retitled test and a bare pointer (mutation)', () => {
    // Every branch above, driven on content of this test's own making rather
    // than on the tree, so each failure message is measured rather than assumed.
    const shipped = new Set<string>();
    const cite = (body: string) => pointersIn('x.mjs', body, shipped);

    const bare = cite('// see `test/template/gone.test.ts` › "a behaviour"');
    expect(bare, 'a citation was not parsed at all').toHaveLength(1);
    expect(bare[0]!.target).toBe('gone.test.ts');
    expect(bare[0]!.names).toEqual(['a behaviour']);
    expect(bare[0]!.disclosed, 'a pointer with no marker was read as disclosed').toBe(false);

    const marked = cite(
      '// pinned in `test/template/gone.test.ts` (absent in a generated rig) › "a behaviour"',
    );
    expect(marked[0]!.disclosed, 'a marked pointer was read as undisclosed').toBe(true);

    // The wrapped form, which is the ordinary one in this tree.
    const wrapped = cite(
      [
        '// pinned in `test/template/gone.test.ts` — absent in a generated',
        '// rig — › "a behaviour"',
      ].join('\n'),
    );
    expect(wrapped[0]!.disclosed, 'a marker wrapped across two lines was not seen').toBe(true);

    // And the name half, against a source of this test's own making: a retitled
    // test stops matching, a parameterised name still does, and a name that
    // wraps in the source is found because both sides are normalised.
    const source = [
      "it('a behaviour', () => {});",
      "it.each([1])('refuses %s",
      "  outright', () => {});",
    ].join('\n');
    expect(declares(source, 'a behaviour'), 'a declared name was reported missing').toBe(true);
    expect(declares(source, 'a different behaviour'), 'a retitled test still matched').toBe(false);
    expect(declares(source, 'refuses %s outright'), 'a parameterised name did not match').toBe(
      true,
    );
    expect(declares(source, 'accepts %s outright'), 'a renamed parameterised test matched').toBe(
      false,
    );
  });
});
