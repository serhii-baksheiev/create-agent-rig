import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR-65: a gate verdict stops being prose the calling session pattern-matches by
// eye. Every reviewer and every gate ends with one fenced ```json block, and
// `lib/verdict.mjs` is the single place that says what such a block may contain
// — so "one verdict per run", "every blocker names what it violates" and "a HOLD
// lists at least one blocker" become things a caller can CHECK rather than read.
//
// 🔴 The headline case is the last one: today a session can return `VERDICT:
// HOLD` and list nothing, and nothing downstream notices that the stop it just
// obeyed named no reason. The mirror — a SHIP carrying blockers — is the same
// defect from the other side, and it is worse, because it reads as a pass.
//
// The parser is handed reviewer output, which is model-written text: it never
// throws, it reports EVERY problem it found, and it never answers `ok` and
// `problems` at the same time.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'lib', 'verdict.mjs');
const cliPath = path.join(scriptsDir, 'verdict.mjs');

/** The canonical verdict a successful parse hands back. */
interface Verdict {
  gate: string;
  verdict: string;
  blockers: unknown[];
  advisories: unknown[];
  evidence: unknown[];
}

type ParseResult =
  | { ok: true; verdict: Verdict; problems?: undefined }
  | { ok: false; problems: string[]; verdict?: undefined };

interface VerdictModule {
  VERDICT_WORDS: readonly string[];
  GATE_VOCABULARY: Readonly<Record<string, readonly string[]>>;
  BLOCKING_VERDICTS: readonly string[];
  parseVerdict(text: string): ParseResult;
}

const load = async (): Promise<VerdictModule> =>
  (await import(pathToFileURL(modulePath).href)) as unknown as VerdictModule;

const parse = async (text: string): Promise<ParseResult> => (await load()).parseVerdict(text);

/** One fenced json block, the way a spec tells a reviewer to end its report. */
const fenced = (value: unknown): string =>
  ['```json', JSON.stringify(value, null, 2), '```'].join('\n');

/** A whole reviewer answer: prose, then the block. */
const answer = (value: unknown, prose = 'Reviewed the diff against the item.'): string =>
  [prose, '', fenced(value), ''].join('\n');

const blocker = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  rule: 'Test integrity',
  note: 'the failing case was deleted rather than fixed',
  ...over,
});

const ship = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  gate: 'code-reviewer',
  verdict: 'SHIP',
  blockers: [],
  ...over,
});

const hold = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  gate: 'code-reviewer',
  verdict: 'HOLD',
  blockers: [blocker()],
  ...over,
});

/**
 * The problems of a refused parse — reported as a refusal when the parse
 * unexpectedly succeeded, rather than as a confusing assertion about
 * `undefined`.
 */
const problemsOf = (result: ParseResult): string[] => {
  if (result.ok) {
    throw new Error(`expected a refusal, but the parse returned ${JSON.stringify(result.verdict)}`);
  }
  expect(Array.isArray(result.problems)).toBe(true);
  expect(result.problems.length).toBeGreaterThan(0);
  for (const problem of result.problems) expect(typeof problem).toBe('string');
  return result.problems;
};

const acceptedVerdict = (result: ParseResult): Verdict => {
  if (!result.ok) {
    throw new Error(
      `expected an accepted verdict, but the parse refused:\n${result.problems.join('\n')}`,
    );
  }
  return result.verdict;
};

describe('one vocabulary, and each gate gets the part of it that it can mean', () => {
  it('names every word a gate is allowed to return', async () => {
    const { VERDICT_WORDS } = await load();
    expect([...VERDICT_WORDS].sort()).toEqual(
      [
        'HEALTHY',
        'HOLD',
        'NOT_APPLICABLE',
        'PREMISES_HOLD',
        'PREMISE_FALSE',
        'REGRESSION',
        'SHIP',
        'UNMEASURED',
        'UNVERIFIABLE',
      ].sort(),
    );
  });

  it('cannot be widened at runtime by the caller that imported it', async () => {
    const { VERDICT_WORDS, GATE_VOCABULARY, BLOCKING_VERDICTS } = await load();
    // A shared list a caller can push onto is a shared list one caller can
    // silently extend — and the extension travels to every other importer.
    expect(Object.isFrozen(VERDICT_WORDS)).toBe(true);
    expect(Object.isFrozen(GATE_VOCABULARY)).toBe(true);
    expect(Object.isFrozen(BLOCKING_VERDICTS)).toBe(true);
    expect(() => (VERDICT_WORDS as string[]).push('LGTM')).toThrow();
  });

  // 🔴 The gates whose NAMES the stack-neutral layer may carry — which is not
  // the same set as the gates a target runs. `post-deploy-verify` lives in the
  // aws-cdk stack and is listed; `cdk-diff-reviewer` is not, because its name
  // contains a provider term and `composition.test.ts` refuses one anywhere
  // under `universal/`. That gate reaches the schema as an unknown gate,
  // covered by the documented limit below.
  it('gives each gate only the words that gate can mean', async () => {
    const { GATE_VOCABULARY, VERDICT_WORDS } = await load();
    const expected: Record<string, string[]> = {
      'pr-ship': ['SHIP', 'HOLD'],
      'code-reviewer': ['SHIP', 'HOLD', 'NOT_APPLICABLE'],
      'prose-reviewer': ['SHIP', 'HOLD', 'NOT_APPLICABLE'],
      'security-scanner': ['SHIP', 'HOLD', 'NOT_APPLICABLE'],
      'check-premises': ['PREMISES_HOLD', 'PREMISE_FALSE', 'UNVERIFIABLE', 'UNMEASURED'],
      'post-deploy-verify': ['HEALTHY', 'REGRESSION'],
    };
    expect(Object.keys(GATE_VOCABULARY).sort()).toEqual(Object.keys(expected).sort());
    for (const [gate, words] of Object.entries(expected)) {
      expect([...(GATE_VOCABULARY[gate] ?? [])].sort(), gate).toEqual([...words].sort());
    }
    // and no gate may return a word the shared list does not carry
    for (const words of Object.values(GATE_VOCABULARY)) {
      for (const word of words) expect(VERDICT_WORDS).toContain(word);
    }
  });

  it('names the words that mean stop, and leaves the rest out of them', async () => {
    const { BLOCKING_VERDICTS } = await load();
    expect([...BLOCKING_VERDICTS].sort()).toEqual(
      ['HOLD', 'PREMISE_FALSE', 'REGRESSION', 'UNMEASURED', 'UNVERIFIABLE'].sort(),
    );
    for (const passing of ['SHIP', 'PREMISES_HOLD', 'HEALTHY', 'NOT_APPLICABLE']) {
      expect(BLOCKING_VERDICTS, passing).not.toContain(passing);
    }
  });
});

describe('the verdict is the block the report ends with', () => {
  it('reads the last fenced json block, not an example quoted earlier', async () => {
    // A reviewer that shows the shape it was asked for and then answers is
    // giving ONE verdict; a parser that reads the first block reads the
    // example, which is somebody else's gate and usually the opposite word.
    const text = [
      'The spec asked for this shape:',
      '',
      fenced({ gate: 'code-reviewer', verdict: 'SHIP', blockers: [] }),
      '',
      'My actual finding:',
      '',
      fenced(hold({ gate: 'prose-reviewer' })),
    ].join('\n');

    const verdict = acceptedVerdict(await parse(text));
    expect(verdict.gate).toBe('prose-reviewer');
    expect(verdict.verdict).toBe('HOLD');
  });

  it('refuses the answer when the block it ends with is the malformed one', async () => {
    // The mirror of the case above, and the one that proves the rule is "last"
    // rather than "any": a valid block earlier in the report must not rescue an
    // invalid final answer.
    const text = [fenced(ship()), '', 'On reflection:', '', fenced(ship({ verdict: 'HOLD' }))].join(
      '\n',
    );
    expect(problemsOf(await parse(text)).join('\n')).toMatch(/blocker/i);
  });

  it('refuses a report with no fenced json block at all, and says which is missing', async () => {
    const problems = problemsOf(await parse('VERDICT: SHIP — looks good to me.'));
    expect(problems.join('\n')).toMatch(/json/i);
    expect(problems.join('\n')).toMatch(/block/i);
  });

  it('refuses a block that is not JSON', async () => {
    const text = ['```json', '{ gate: code-reviewer, verdict: SHIP }', '```'].join('\n');
    expect(problemsOf(await parse(text)).join('\n')).toMatch(/json|parse/i);
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"SHIP"'],
    ['null', 'null'],
    ['a number', '42'],
  ])('refuses a block whose JSON is %s rather than an object', async (_label, json) => {
    const text = ['```json', json, '```'].join('\n');
    expect(problemsOf(await parse(text)).join('\n')).toMatch(/object/i);
  });
});

// 🔴 The block is delimited by a fence, and a reviewer quoting one INSIDE its
// answer is not exotic: a blocker's `note` showing the deleted test, or a
// second report appended to the same file, both put ``` in the body. Reading to
// the first ``` after the opening fence cuts the block there — and the half in
// front of the cut is sometimes valid JSON, which is the dangerous shape.
describe('a fence inside the block body is refused, not quietly cut out of it', () => {
  const FENCE = '```';

  /**
   * The refusal has to name the FENCE as the cause. Deliberately not `/fence/i`:
   * the module's existing "the final fenced json block is not JSON" already
   * carries that word incidentally, and a reader told only "not JSON" goes
   * hunting for a syntax error in a block that has none.
   */
  const namesTheFence = /backtick|```|closing fence|inner fence|fence inside|fence in the/i;

  it('refuses a block whose body carries a fence, and says the fence is why', async () => {
    // The honest reviewer case: the note quotes the test it is complaining
    // about. Ambiguous input fails closed here — but "not JSON" sends the
    // reader hunting for a syntax error in a block that has none.
    const note = [`the case removed was:`, FENCE, "it('refuses an empty title')", FENCE].join('\n');
    const problems = problemsOf(await parse(answer(hold({ blockers: [blocker({ note })] }))));
    expect(problems.join('\n')).toMatch(namesTheFence);
  });

  it('refuses rather than accepting the part of the body in front of an inner fence', async () => {
    // Measured on the shipped module: this returns `ok: true` with SHIP today.
    // The body ends in a HOLD; everything after the inner fence is invisible,
    // and what the caller acts on is the opposite of what the report said.
    const text = ['```json', JSON.stringify(ship()), FENCE, JSON.stringify(hold()), FENCE].join(
      '\n',
    );
    expect(problemsOf(await parse(text)).join('\n')).toMatch(namesTheFence);
  });

  it('states the fence as a fifth limit in the module, where the next reader looks', async () => {
    // `invariants.md` ("State the limits — and test them"): the header claims
    // its list is exhaustive, so a limit missing from it is cover the reader
    // believes they have. The behaviour above and this sentence ship together.
    const source = await readFile(modulePath, 'utf8');
    const fifth = source.split(/\n \* 5\. /)[1]?.split('*/')[0] ?? '';
    expect(fifth, 'the module lists no fifth limit').not.toBe('');
    expect(fifth).toMatch(/fence|backtick|```/i);
  });
});

describe('the gate and the word it returned have to agree', () => {
  it.each([
    ['no gate at all', { verdict: 'SHIP', blockers: [] }],
    ['an empty gate', { gate: '', verdict: 'SHIP', blockers: [] }],
    ['a gate that is not a name', { gate: 7, verdict: 'SHIP', blockers: [] }],
  ])('refuses a verdict naming %s', async (_label, value) => {
    expect(problemsOf(await parse(answer(value))).join('\n')).toMatch(/gate/i);
  });

  it('refuses a word no gate in this rulebook may return', async () => {
    const problems = problemsOf(await parse(answer(ship({ verdict: 'LGTM' }))));
    expect(problems.join('\n')).toMatch(/verdict/i);
    expect(problems.join('\n')).toContain('LGTM');
  });

  it.each([
    ['code-reviewer', 'HEALTHY'],
    ['post-deploy-verify', 'SHIP'],
    ['check-premises', 'HOLD'],
    ['pr-ship', 'NOT_APPLICABLE'],
  ])('refuses %s returning %s — a word that belongs to another gate', async (gate, word) => {
    const problems = problemsOf(await parse(answer({ gate, verdict: word, blockers: [] })));
    expect(problems.join('\n')).toContain(gate);
    expect(problems.join('\n')).toContain(word);
  });

  // 🔴 A DOCUMENTED LIMIT, pinned so it stays a decision rather than becoming a
  // discovery: a project may add gates of its own, and refusing every name this
  // rulebook did not ship would make the schema unusable in exactly the repos
  // that extended it. The cost is that a typo'd gate name is accepted with any
  // word from the shared list — that is what the limit buys, and it is stated
  // in the module rather than left for a reader to infer.
  it('accepts a gate this rulebook does not know, with any word from the shared list', async () => {
    const shipped = acceptedVerdict(
      await parse(answer({ gate: 'load-test-reviewer', verdict: 'SHIP', blockers: [] })),
    );
    expect(shipped.gate).toBe('load-test-reviewer');

    const regressed = acceptedVerdict(
      await parse(
        answer({ gate: 'load-test-reviewer', verdict: 'REGRESSION', blockers: [blocker()] }),
      ),
    );
    expect(regressed.verdict).toBe('REGRESSION');
  });

  it('states that limit in the module, where the next reader of it looks', async () => {
    const source = await readFile(modulePath, 'utf8');
    expect(source).toMatch(/limit/i);
    expect(source).toMatch(/GATE_VOCABULARY/);
  });
});

describe('a blocker names what it violates', () => {
  const holdWith = (...blockers: unknown[]) => answer(hold({ blockers }));

  it('refuses a blocker that names no rule', async () => {
    const problems = problemsOf(await parse(holdWith({ note: 'this feels wrong' })));
    expect(problems.join('\n')).toMatch(/rule/i);
  });

  it('refuses a blocker whose rule is empty', async () => {
    expect(problemsOf(await parse(holdWith(blocker({ rule: '' })))).join('\n')).toMatch(/rule/i);
  });

  it('refuses a blocker that names no note', async () => {
    const problems = problemsOf(await parse(holdWith({ rule: 'Test integrity' })));
    expect(problems.join('\n')).toMatch(/note/i);
  });

  it.each([
    ['a string', 'the tests are weakened'],
    ['null', null],
    ['a list', []],
  ])('refuses a blocker that is %s rather than an object', async (_label, value) => {
    expect(problemsOf(await parse(holdWith(value))).join('\n')).toMatch(/blocker/i);
  });

  // A failing CI check and a Definition-of-Done line have no file and no line.
  // Requiring one would make every run INVENT a location to satisfy the schema,
  // which is worse than the free prose this whole item replaces.
  it('accepts a blocker with no file, because a failing check has no file:line', async () => {
    const verdict = acceptedVerdict(
      await parse(
        holdWith({ rule: 'required check `ci`', note: 'failed on the head commit: 3 tests red' }),
      ),
    );
    expect(verdict.blockers).toHaveLength(1);
  });

  it('accepts a blocker that names a file and the line inside it', async () => {
    const verdict = acceptedVerdict(
      await parse(holdWith(blocker({ file: 'packages/core/src/note.ts', line: 42 }))),
    );
    expect(verdict.blockers[0]).toMatchObject({ file: 'packages/core/src/note.ts', line: 42 });
  });

  it('refuses a blocker that names a file but no line', async () => {
    const problems = problemsOf(
      await parse(holdWith(blocker({ file: 'packages/core/src/note.ts' }))),
    );
    expect(problems.join('\n')).toMatch(/line/i);
  });

  it('refuses a blocker that names a line but no file', async () => {
    const problems = problemsOf(await parse(holdWith(blocker({ line: 42 }))));
    expect(problems.join('\n')).toMatch(/file/i);
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['a string', '42'],
  ])('refuses a line that is %s — a location has to be one', async (_label, line) => {
    const problems = problemsOf(await parse(holdWith(blocker({ file: 'src/a.ts', line }))));
    expect(problems.join('\n')).toMatch(/line/i);
  });

  it.each([
    ['omitted', undefined],
    ['a string', 'gate rounds exhausted'],
    ['an object', { first: 'gate rounds exhausted' }],
    ['null', null],
  ])('refuses a verdict whose blockers are %s rather than a list', async (_label, blockers) => {
    const block: Record<string, unknown> = { gate: 'code-reviewer', verdict: 'HOLD' };
    if (blockers !== undefined) block['blockers'] = blockers;
    expect(problemsOf(await parse(answer(block))).join('\n')).toMatch(/blockers/i);
  });
});

// 🔴 The item's headline. A stop nobody can act on is worse than no stop: the
// author has to guess what to fix, and the guess is usually "nothing".
describe('a verdict that means stop names at least one blocker', () => {
  it.each([
    ['pr-ship', 'HOLD'],
    ['code-reviewer', 'HOLD'],
    ['post-deploy-verify', 'REGRESSION'],
    ['check-premises', 'PREMISE_FALSE'],
    ['check-premises', 'UNVERIFIABLE'],
    ['check-premises', 'UNMEASURED'],
  ])('refuses a %s returning %s with an empty blocker list', async (gate, word) => {
    const problems = problemsOf(await parse(answer({ gate, verdict: word, blockers: [] })));
    // The caller has to be able to FIND this refusal among the others, so the
    // sentence names the missing thing rather than merely being non-empty.
    expect(problems.join('\n')).toMatch(/blocker/i);
    expect(problems.join('\n')).toMatch(/no blocker|names no|at least one|empty/i);
  });
});

// The mirror, and the more dangerous half: this one reads as a pass while
// carrying the reasons it should not have been one.
describe('a verdict that means proceed cannot carry a blocker', () => {
  it.each([
    ['code-reviewer', 'SHIP'],
    ['check-premises', 'PREMISES_HOLD'],
    ['post-deploy-verify', 'HEALTHY'],
    ['security-scanner', 'NOT_APPLICABLE'],
  ])('refuses a %s returning %s while listing a blocker', async (gate, word) => {
    const problems = problemsOf(
      await parse(answer({ gate, verdict: word, blockers: [blocker()] })),
    );
    expect(problems.join('\n')).toMatch(/blocker/i);
    expect(problems.join('\n')).toContain(word);
  });
});

describe('the optional lists arrive as lists or not at all', () => {
  it('hands back empty advisories and evidence when the block omits them', async () => {
    // The exact shape, not a subset: a caller that has to test for `undefined`
    // before iterating is a caller that will forget once.
    expect(acceptedVerdict(await parse(answer(ship())))).toEqual({
      gate: 'code-reviewer',
      verdict: 'SHIP',
      blockers: [],
      advisories: [],
      evidence: [],
    });
  });

  it('keeps the advisories and the evidence a reviewer supplied', async () => {
    const verdict = acceptedVerdict(
      await parse(
        answer(
          ship({
            advisories: [{ note: 'the helper could be shared' }],
            evidence: ['pnpm test — 412 passed', 'gh api …/check-runs → success'],
          }),
        ),
      ),
    );
    expect(verdict.advisories).toHaveLength(1);
    expect(verdict.evidence).toEqual(['pnpm test — 412 passed', 'gh api …/check-runs → success']);
  });

  it.each([
    ['a string', 'ran the suite'],
    ['an object', { suite: 'green' }],
  ])('refuses evidence that is %s rather than a list', async (_label, evidence) => {
    expect(problemsOf(await parse(answer(ship({ evidence })))).join('\n')).toMatch(/evidence/i);
  });

  it('refuses an evidence entry that is not a line of text', async () => {
    const problems = problemsOf(await parse(answer(ship({ evidence: [{ ran: 'pnpm test' }] }))));
    expect(problems.join('\n')).toMatch(/evidence/i);
  });

  it('refuses advisories that are not a list', async () => {
    const problems = problemsOf(await parse(answer(ship({ advisories: 'nothing major' }))));
    expect(problems.join('\n')).toMatch(/advisor/i);
  });
});

describe('nothing in the block is quietly ignored', () => {
  it('refuses a key the shape does not define, naming the key', async () => {
    // Silently dropping `severity` means a reviewer believing it reported one.
    // The whole point of a schema here is that the caller and the reviewer
    // agree on what was said.
    const problems = problemsOf(await parse(answer(ship({ severity: 'high' }))));
    expect(problems.join('\n')).toContain('severity');
  });

  it('reports every problem in the block, not the first one it hit', async () => {
    // A parser that stops at the first problem costs a round per problem, and
    // the gate that consumes this has a counted, finite number of rounds.
    const problems = problemsOf(
      await parse(
        answer({ gate: 'code-reviewer', verdict: 'HEALTHY', blockers: [], severity: 'high' }),
      ),
    ).join('\n');
    expect(problems).toMatch(/HEALTHY|verdict/);
    expect(problems).toContain('severity');
    expect(problems).toMatch(/code-reviewer/);
  });

  it('never answers ok and problems at the same time', async () => {
    for (const text of [
      answer(ship()),
      answer(hold()),
      answer(ship({ verdict: 'HOLD' })),
      'no block here at all',
    ]) {
      const result = await parse(text);
      if (result.ok) {
        expect(result.problems, text).toBeUndefined();
        expect(result.verdict, text).toBeTruthy();
      } else {
        expect(result.verdict, text).toBeUndefined();
        expect(result.problems.length, text).toBeGreaterThan(0);
      }
    }
  });

  it('never throws, whatever text a reviewer hands it', async () => {
    const { parseVerdict } = await load();
    for (const text of [
      '',
      '```json',
      '```json\n',
      '```json\n{\n```',
      '```json\nundefined\n```',
      '```json\n{"gate":"code-reviewer"}\n```',
      `\`\`\`json\n${'['.repeat(1000)}\n\`\`\``,
      '```json\n{"gate":"code-reviewer","verdict":"SHIP","blockers":null}\n```',
      'VERDICT: SHIP\n\n```\n{"gate":"code-reviewer"}\n```',
    ]) {
      expect(() => parseVerdict(text), JSON.stringify(text.slice(0, 40))).not.toThrow();
    }
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams, for the assertion messages that only need something readable. */
  out: string;
}

/**
 * One child run of the CLI, with the two streams kept apart: the verdict goes
 * to stdout and the diagnosis to stderr, and a case below turns on a refusal
 * printing NOTHING on stdout — which concatenation would erase.
 *
 * The environment is hermetic in the sense the neighbouring script tests use
 * (`gate-scripts.test.ts`): `RIG_RUN_DIR` is the one ambient variable in this
 * layer that changes a script's exit code, so no case can pick it up from the
 * operator's session.
 */
const runCli = (args: string[], stdin = ''): Promise<CliResult> =>
  new Promise((resolve) => {
    const env = { ...process.env };
    delete env.RIG_RUN_DIR;
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: repoRoot, env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
          out: stdout + stderr,
        });
      },
    );
    child.stdin?.end(stdin);
  });

/** Whatever text a gate captured, on disk — including text no helper composes. */
const rawReportFile = async (text: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'verdict-'));
  const file = path.join(dir, 'report.md');
  await writeFile(file, text);
  return file;
};

/** A reviewer's report on disk, the way `pr-ship` will have captured it. */
const reportFile = (value: unknown): Promise<string> => rawReportFile(answer(value));

describe('the verdict CLI is what a gate calls before it believes a reviewer', () => {
  it('prints the parsed verdict and exits 0 on a well-formed block', async () => {
    const result = await runCli(['check', await reportFile(ship())]);
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      gate: 'code-reviewer',
      verdict: 'SHIP',
      blockers: [],
      advisories: [],
      evidence: [],
    });
  });

  it('exits 0 on a well-formed HOLD — a refused change is not a broken check', async () => {
    // The same distinction the gate sweep turns on: a check that FOUND
    // something must not look like a check that BROKE. `pr-ship` reads the
    // parsed word, not the exit code, to learn the verdict.
    const result = await runCli(['check', await reportFile(hold())]);
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'HOLD' });
  });

  it('refuses a stop verdict that names no blocker, and prints no verdict at all', async () => {
    const result = await runCli(['check', await reportFile(ship({ verdict: 'HOLD' }))]);
    expect(result.code, result.out).toBe(1);
    // 🔴 stdout stays empty on a refusal. A caller redirecting stdout into a
    // file would otherwise capture a verdict this command just refused.
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/blocker/i);
  });

  it('reads the report from stdin when the file is `-`', async () => {
    const result = await runCli(['check', '-'], answer(hold({ gate: 'security-scanner' })));
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ gate: 'security-scanner', verdict: 'HOLD' });
  });

  it('refuses a run with no subcommand, with a usage line', async () => {
    const result = await runCli([]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/usage/i);
    expect(result.out).toMatch(/check/);
  });

  it('refuses a subcommand it does not have rather than guessing at one', async () => {
    const result = await runCli(['validate', await reportFile(ship())]);
    expect(result.code, result.out).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage/i);
  });

  it('names the report it could not read instead of dumping a stack', async () => {
    const missing = path.join(await mkdtemp(path.join(tmpdir(), 'verdict-')), 'nothing.md');
    const result = await runCli(['check', missing]);
    expect(result.code, result.out).toBe(1);
    expect(result.stderr).toContain(missing);
    expect(result.stderr).not.toMatch(/node:internal|at ModuleJob|at async/);
  });

  it('says the report argument is missing rather than calling `check` unknown', async () => {
    // The subcommand was right and the FILE was not supplied; reporting the
    // opposite sends the operator looking for a typo that is not there, and the
    // two arms are one branch away from each other in the source.
    const result = await runCli(['check']);
    expect(result.code, result.out).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/not a subcommand|unknown subcommand/i);
    expect(result.stderr).toMatch(/report|file/i);
    expect(result.stderr).toMatch(/missing|no report|no file|needs|without/i);
  });
});

// 🔴 `pr-ship` fans several reviewers out in one step and their answers end up
// in one place. Measured on the shipped CLI: a file holding `code-reviewer`'s
// HOLD followed by `prose-reviewer`'s SHIP exits 0 and prints the SHIP — the
// earlier stop is invisible, and the caller reads a pass that no gate gave it.
// So the caller says which gate it is checking, and the check refuses a verdict
// from a different one.
describe('`check` is told which gate it is checking', () => {
  it('accepts the verdict when the block names the gate the caller asked for', async () => {
    const result = await runCli(['check', await reportFile(hold()), 'code-reviewer']);
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ gate: 'code-reviewer', verdict: 'HOLD' });
  });

  it('refuses a verdict from another gate, naming the one asked for and the one found', async () => {
    const file = await reportFile(ship({ gate: 'prose-reviewer' }));
    const result = await runCli(['check', file, 'code-reviewer']);
    expect(result.code, result.out).toBe(1);
    // stdout stays empty for the same reason every other refusal keeps it empty:
    // a caller redirecting it would capture a verdict this command refused.
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('code-reviewer');
    expect(result.stderr).toContain('prose-reviewer');
  });

  it('refuses the trailing SHIP of a second report as the gate that held', async () => {
    // Two reviewers' answers concatenated into one capture — the shape that
    // makes the earlier gate's stop disappear behind the later gate's pass.
    const file = await rawReportFile(
      [answer(hold({ gate: 'code-reviewer' })), answer(ship({ gate: 'prose-reviewer' }))].join(
        '\n',
      ),
    );
    const result = await runCli(['check', file, 'code-reviewer']);
    expect(result.code, result.out).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('code-reviewer');
    expect(result.stderr).toContain('prose-reviewer');
  });

  it('accepts whatever gate the block names when no gate was asked for', async () => {
    // The argument is optional: every existing caller passes a file alone, and
    // a check that suddenly required a second argument would refuse them all.
    const result = await runCli(['check', await reportFile(ship({ gate: 'prose-reviewer' }))]);
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ gate: 'prose-reviewer', verdict: 'SHIP' });
  });
});

// 🔴 An accepted verdict is the path where nothing is supposed to go wrong, and
// it is the one that crashes: `checkBlocker` lets a blocker carry keys the shape
// does not define, so a nested value the printer cannot serialise reaches
// `JSON.stringify` and throws AFTER the parse said `ok`. What the caller sees is
// exit 1 with a raw node trace — which `pr-ship` reads as `incomplete`, turning
// a legitimate HOLD into "the reviewer did not answer".
describe('an accepted verdict does not crash the CLI on the way out', () => {
  it('refuses in a sentence of its own when a blocker nests past the printer', async () => {
    // Built rather than written out: the depth that defeats `JSON.stringify` is
    // thousands of levels, and a literal that deep is unreadable and unmaintainable.
    const depth = 50_000;
    const nested = `${'['.repeat(depth)}1${']'.repeat(depth)}`;
    const file = await rawReportFile(
      [
        'Reviewed the diff against the item.',
        '',
        '```json',
        `{"gate":"code-reviewer","verdict":"HOLD","blockers":[{"rule":"r","note":"n","x":${nested}}]}`,
        '```',
        '',
      ].join('\n'),
    );

    const result = await runCli(['check', file]);
    expect(result.code, result.out).toBe(1);
    expect(result.stdout).toBe('');
    // The file's own promise — "the path, not a stack": the operator needs to
    // know WHICH report could not be handled, and a node trace answers a
    // question nobody asked.
    expect(result.stderr).not.toMatch(/node:internal|at ModuleJob|at async|RangeError/);
    expect(result.stderr).toContain(file);
  });
});
