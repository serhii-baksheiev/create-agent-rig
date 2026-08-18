import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR-79: three writers already record the three halves of a gate round — the
// router journals the reviewer set the route ASKED FOR
// (`decision-router.mjs`, `gate: "review-routing:<lane>"`), `pr-ship` journals
// the set it actually LAUNCHED (`gate: "reviewer-fan-out"`), and each verdict
// that parsed is journaled under the reviewer's own name. Nothing compares
// them.
//
// 🔴 So the two failures this whole layer exists to stop are, today, invisible
// from the trace: a reviewer the router named and nobody started, and a
// reviewer that answered — for a commit two pushes ago. Both end in a merge
// that reads as fully gated. `coverageOf` is the comparison, and it is a pure
// function so the rule has one implementation and the CLI is only its call site.
//
// Every path here is the TEMPLATE copy under `templates/agent-os/universal/`,
// never the synced `.claude/` one: the template is the source, and an assertion
// against the copy would pass on a stale sync.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'lib', 'gate-coverage.mjs');
const cliPath = path.join(scriptsDir, 'verdict.mjs');
const runJournalPath = path.join(scriptsDir, 'run-journal.mjs');

/** One record as `readRun` hands it back: the journal's own fields, plus the writer's. */
type JournalRecord = Record<string, unknown>;

/**
 * What `coverageOf` answers.
 *
 * The four finding lists are reviewer NAMES, because the name is what the
 * operator has to act on and what the CLI prints; `routed` and `launched` are
 * the two sets they were derived from, kept so a reader can see the subtraction
 * rather than take it on trust.
 */
interface Coverage {
  ok: boolean;
  routed: string[];
  launched: string[];
  neverLaunched: string[];
  unanswered: string[];
  unattributed: string[];
  stale: string[];
  /** Present only when the run cannot be judged at all — see the rule-7 block. */
  reason?: string;
}

interface GateCoverageModule {
  coverageOf(input: { records: unknown; headSha: unknown }): Coverage;
}

const load = async (): Promise<GateCoverageModule> =>
  (await import(pathToFileURL(modulePath).href)) as unknown as GateCoverageModule;

/**
 * The function under test, or a refusal that names what is missing — a bare
 * `undefined is not a function` says nothing about the contract being pinned.
 */
const coverageOf = async (records: JournalRecord[], headSha: string = HEAD): Promise<Coverage> => {
  const module = await load();
  if (typeof module.coverageOf !== 'function') {
    throw new Error(
      '`lib/gate-coverage.mjs` exports no `coverageOf({ records, headSha })` — the one ' +
        'place that compares what a route asked for, what the fan-out launched, and what ' +
        'came back.',
    );
  }
  return module.coverageOf({ records, headSha });
};

/** The commit the round is about, and the one it is not. */
const HEAD = '9c1f0a7d4b3e2c5a8f6d0b9e7c4a1f2d3e5b6c70';
const OLDER = '0b7e5c31f2a4d6e8b0c9a7f5d3e1b2c4a6f8d0e2';

/** The router's line for the lane that claimed the change — the only one carrying a set. */
const routed = (reviewers: string[], lane = 'model'): JournalRecord => ({
  gate: `review-routing:${lane}`,
  verdict: 'route',
  why: 'the expensive path is warranted',
  reviewers,
});

/**
 * The router's line for a lane that declined. It carries NO `reviewers` key —
 * the set belongs to the route, not to the gates that passed on it — and a
 * coverage answer that read one off it would compare against a lane nobody took.
 */
const declined = (lane: string): JournalRecord => ({
  gate: `review-routing:${lane}`,
  verdict: 'skipped',
  why: 'not evaluated — a risk flag escalated ahead of it',
});

/** `pr-ship`'s record of what it actually started, for which commit. */
const fanOut = (reviewers: string[], headSha: string = HEAD): JournalRecord => ({
  gate: 'reviewer-fan-out',
  verdict: 'launched',
  why: null,
  headSha,
  reviewers,
});

/** One reviewer's verdict, as `pr-ship` journals the block `check` printed. */
const answered = (gate: string, over: JournalRecord = {}): JournalRecord => ({
  gate,
  verdict: 'SHIP',
  why: null,
  blockers: [],
  headSha: HEAD,
  ...over,
});

/**
 * The records in journal order, with the two fields every record carries.
 *
 * `seq` and `at` are the journal's own, so a fixture that omitted them would be
 * testing a shape `readRun` never returns — and a key whose value is `undefined`
 * is DROPPED, because these records come back through JSONL and a key that
 * serialises to nothing arrives absent. A fixture carrying `headSha: undefined`
 * would let an implementation that tests `'headSha' in record` pass here and
 * miss every real one.
 */
const journal = (...records: JournalRecord[]): JournalRecord[] =>
  records.map((record, index) =>
    JSON.parse(
      JSON.stringify({
        seq: index + 1,
        at: `2026-08-18T09:${String(index).padStart(2, '0')}:00.000Z`,
        ...record,
      }),
    ),
  ) as JournalRecord[];

/** A module's source with its comments removed — a prose scan is not a code scan. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the fan-out a coverage answer is about is the last one', () => {
  // 🔴 A branch gets a second gate round after fixes, and the round's whole
  // question is "did THIS round's reviewers answer". Reading any fan-out but
  // the last one answers about a round that is already over.
  it('reads the reviewers of the last fan-out rather than the round before it', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer', { verdict: 'HOLD', blockers: [{ rule: 'r', note: 'n' }] }),
        fanOut(['code-reviewer', 'prose-reviewer']),
        answered('code-reviewer'),
        answered('prose-reviewer'),
      ),
    );
    expect(coverage.launched.sort()).toEqual(['code-reviewer', 'prose-reviewer']);
    expect(coverage.ok).toBe(true);
  });

  it('does not let a verdict from the previous round cover the current one', async () => {
    // The dangerous half: `code-reviewer` answered in round 1, was relaunched in
    // round 2 and said nothing. Its old record is still in the journal, and a
    // reader that scans the whole file finds an answer and reports coverage.
    const coverage = await coverageOf(
      journal(
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
        fanOut(['code-reviewer', 'prose-reviewer']),
        answered('prose-reviewer'),
      ),
    );
    expect(coverage.unanswered).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(false);
  });
});

describe('a reviewer nobody started is not a reviewer that stayed silent', () => {
  // The two need opposite responses — launch it, versus go and read why it said
  // nothing — and a single "missing" list makes the round that has to tell them
  // apart guess.
  const routedTwoLaunchedOne = (): JournalRecord[] =>
    journal(
      routed(['code-reviewer', 'security-scanner']),
      fanOut(['code-reviewer']),
      answered('code-reviewer'),
    );

  it('names a reviewer the route asked for and the fan-out never started', async () => {
    const coverage = await coverageOf(routedTwoLaunchedOne());
    expect(coverage.routed.sort()).toEqual(['code-reviewer', 'security-scanner']);
    expect(coverage.neverLaunched).toEqual(['security-scanner']);
    expect(coverage.ok).toBe(false);
  });

  it('keeps that reviewer out of the unanswered list, because the fix is a different one', async () => {
    const coverage = await coverageOf(routedTwoLaunchedOne());
    expect(coverage.unanswered).toEqual([]);
  });

  it('reads no reviewer set off a lane that declined the change', async () => {
    // Only the routed line carries a set. Treating a declined lane's line as a
    // route would compare the answers against a lane nobody took.
    const coverage = await coverageOf(
      journal(
        declined('deterministic'),
        declined('fast-path'),
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
      ),
    );
    expect(coverage.routed).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(true);
  });

  it('reports nothing when the fan-out started a reviewer the route never named', async () => {
    // The lane is a floor, never a ceiling (`workflow.md`): the triggers may only
    // ADD reviewers, so a launched set larger than the routed one is the ordinary
    // case and must not read as a finding.
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer', 'prose-reviewer']),
        answered('code-reviewer'),
        answered('prose-reviewer'),
      ),
    );
    expect(coverage.neverLaunched).toEqual([]);
    expect(coverage.ok).toBe(true);
  });
});

describe('a reviewer that was launched and returned nothing is named', () => {
  it('names a launched reviewer with no verdict record after the fan-out', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer', 'prose-reviewer']),
        fanOut(['code-reviewer', 'prose-reviewer']),
        answered('code-reviewer'),
      ),
    );
    expect(coverage.unanswered).toEqual(['prose-reviewer']);
    expect(coverage.neverLaunched).toEqual([]);
    expect(coverage.ok).toBe(false);
  });

  it('does not read another writer’s record as the reviewer’s answer', async () => {
    // `decisions.jsonl` carries every gate's line, not only the reviewers': the
    // router's own, `pr-ship`'s, a deploy verdict. A coverage answer that counted
    // any record after the fan-out would report a reviewer answered because the
    // session wrote something else.
    const coverage = await coverageOf(
      journal(
        fanOut(['prose-reviewer']),
        { gate: 'pr-ship', verdict: 'SHIP', why: null, blockers: [], headSha: HEAD },
        {
          gate: 'review-routing:model',
          verdict: 'route',
          why: null,
          reviewers: ['prose-reviewer'],
        },
      ),
    );
    expect(coverage.unanswered).toEqual(['prose-reviewer']);
    expect(coverage.ok).toBe(false);
  });
});

describe('a verdict that names no commit cannot say it answered for this one', () => {
  // 🔴 Unknown is never a pass here. `headSha` is optional in the schema — every
  // report written before AR-101 omits it — so absence is the state this check
  // is most likely to meet, and reading it as "it must have meant the head I am
  // holding" is the exact inference AR-101's limit 6 forbids.
  const withUnattributed = (): JournalRecord[] =>
    journal(
      routed(['code-reviewer']),
      fanOut(['code-reviewer']),
      answered('code-reviewer', { headSha: undefined }),
    );

  it('names a reviewer whose verdict carried no commit at all', async () => {
    const records = withUnattributed();
    // The fixture IS the case, so it is asserted rather than assumed: the key is
    // absent, which is how an omitted field comes back out of the journal file.
    const verdictRecord = records[records.length - 1] as JournalRecord;
    expect('headSha' in verdictRecord).toBe(false);
    expect((await coverageOf(records)).unattributed).toEqual(['code-reviewer']);
  });

  it('refuses to count it as coverage of the commit asked about', async () => {
    const coverage = await coverageOf(withUnattributed());
    expect(coverage.ok).toBe(false);
    // and it is reported as the case it IS: the reviewer answered, so telling
    // the author it was never launched or never answered sends them to relaunch
    // a reviewer that has already spoken.
    expect(coverage.unanswered).toEqual([]);
    expect(coverage.neverLaunched).toEqual([]);
  });
});

describe('a verdict for another commit is not coverage of this one', () => {
  it('names a reviewer that answered for a different commit', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer', { headSha: OLDER }),
      ),
    );
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(false);
    expect(coverage.unanswered).toEqual([]);
  });

  it('accepts the reviewer that answered for the commit asked about', async () => {
    const coverage = await coverageOf(
      journal(fanOut(['code-reviewer']), answered('code-reviewer', { headSha: HEAD })),
      HEAD,
    );
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });
});

describe('coverage holds only when nothing at all is outstanding', () => {
  it('answers ok with four empty lists when every launched reviewer answered for this commit', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer', 'prose-reviewer']),
        fanOut(['code-reviewer', 'prose-reviewer']),
        answered('code-reviewer', { verdict: 'HOLD', blockers: [{ rule: 'r', note: 'n' }] }),
        answered('prose-reviewer'),
      ),
    );
    // A HOLD is an ANSWER. Coverage is about who spoke for which commit, never
    // about what they said — a check that read a stop as a gap would report the
    // working case as the broken one.
    expect(coverage).toMatchObject({
      ok: true,
      neverLaunched: [],
      unanswered: [],
      unattributed: [],
      stale: [],
    });
  });

  it('answers ok for a lane that launched nobody and had nobody to answer', async () => {
    // The `deterministic` lane launches no reviewer. Its fan-out is `[]`, and
    // vacuous coverage over an empty set is the honest answer — which is exactly
    // why the missing-fan-out case below must NOT reach the same one.
    const coverage = await coverageOf(journal(routed([], 'deterministic'), fanOut([])));
    expect(coverage.ok).toBe(true);
    expect(coverage.launched).toEqual([]);
  });

  it.each([
    [
      'a reviewer nobody launched',
      // The same reviewer in all four rows, because the assertion below names
      // one: the row under test is the CASE, never which reviewer it happened to.
      () => journal(routed(['code-reviewer']), fanOut([])),
      'neverLaunched',
    ],
    [
      'a reviewer that answered nothing',
      () => journal(routed(['code-reviewer']), fanOut(['code-reviewer'])),
      'unanswered',
    ],
    [
      'a verdict naming no commit',
      () => journal(fanOut(['code-reviewer']), answered('code-reviewer', { headSha: undefined })),
      'unattributed',
    ],
    [
      'a verdict for another commit',
      () => journal(fanOut(['code-reviewer']), answered('code-reviewer', { headSha: OLDER })),
      'stale',
    ],
  ])('refuses on %s, on its own', async (_label, build, key) => {
    const coverage = await coverageOf(build());
    expect(coverage.ok).toBe(false);
    expect(coverage[key as keyof Coverage]).toEqual(['code-reviewer']);
  });
});

// 🔴 The vacuous pass is the failure this whole item is about, so the case where
// there is nothing to compare against gets its own answer. A run whose journal
// records no fan-out has not been shown to be covered; it has been shown to be
// unreadable, and the four empty lists of a clean round are the exact shape it
// would otherwise take.
describe('a run with no fan-out recorded is never read as a pass', () => {
  const noFanOut = (): JournalRecord[] =>
    journal(routed(['code-reviewer']), answered('code-reviewer'), {
      gate: 'pr-ship',
      verdict: 'SHIP',
      why: null,
      blockers: [],
      headSha: HEAD,
    });

  it('refuses a run whose journal records no fan-out at all', async () => {
    expect((await coverageOf(noFanOut())).ok).toBe(false);
  });

  it('says why, instead of handing back four empty lists that read as a clean round', async () => {
    const coverage = await coverageOf(noFanOut());
    expect(coverage.neverLaunched).toEqual([]);
    expect(coverage.unanswered).toEqual([]);
    expect(coverage.unattributed).toEqual([]);
    expect(coverage.stale).toEqual([]);
    // The one field that distinguishes "nothing was outstanding" from "nothing
    // could be compared" — the CLI prints it, and without it the two are one.
    expect(typeof coverage.reason, 'the refusal names no reason').toBe('string');
    expect(coverage.reason).toMatch(/fan.?out/i);
  });

  it('names no reason when a fan-out was there to compare against', async () => {
    // Omitted is not empty, the same way it is for `headSha` in the verdict
    // schema: a reason present on every answer is a reason a caller stops reading.
    const coverage = await coverageOf(journal(fanOut([])));
    expect('reason' in coverage).toBe(false);
  });
});

describe('the answer is a function of its arguments and nothing else', () => {
  it('reads no clock, no environment and no filesystem', async () => {
    // The rule the whole module exists under (`architecture.md`): values like
    // "now" and "which run directory" enter from the caller. Comments are
    // stripped first — prose saying "no clock here" is not a clock.
    const code = withoutComments(await readFile(modulePath, 'utf8'));
    for (const impurity of [
      /from\s+['"]node:/,
      /require\s*\(/,
      /process\.env/,
      /process\.argv/,
      /Date\.now\s*\(/,
      /new\s+Date\s*\(/,
      /Math\.random\s*\(/,
    ]) {
      expect(code, `\`${impurity.source}\` in a module that must stay pure`).not.toMatch(impurity);
    }
  });

  it('gives the same answer twice for the same records', async () => {
    const build = (): JournalRecord[] =>
      journal(routed(['code-reviewer']), fanOut(['code-reviewer', 'prose-reviewer']));
    expect(await coverageOf(build())).toEqual(await coverageOf(build()));
  });

  it('leaves the records it was handed exactly as they were', async () => {
    // The caller is holding `readRun(...).decisions` and goes on to use it — a
    // sort or a splice in here reorders somebody else's journal view.
    const records = journal(
      routed(['code-reviewer', 'security-scanner']),
      fanOut(['prose-reviewer', 'code-reviewer']),
      answered('code-reviewer'),
    );
    const before = JSON.parse(JSON.stringify(records)) as JournalRecord[];
    await coverageOf(records);
    expect(records).toEqual(before);
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
 * One child run of the CLI. `RIG_RUN_DIR` is passed explicitly — it is the one
 * ambient variable in this layer that changes a script's exit code, so no case
 * may pick it up from the operator's session.
 */
const runCli = (args: string[], runDir?: string): Promise<CliResult> =>
  new Promise((resolve) => {
    const env = { ...process.env };
    delete env.RIG_RUN_DIR;
    if (runDir !== undefined) env.RIG_RUN_DIR = runDir;
    execFile(process.execPath, [cliPath, ...args], { cwd: repoRoot, env }, (error, out, err) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout: String(out),
        stderr: String(err),
        out: String(out) + String(err),
      });
    });
  });

/**
 * A run directory holding these records — written through `run-journal.mjs`
 * itself, so a fixture cannot drift from the shape the real writers produce.
 */
const runDirWith = async (records: JournalRecord[]): Promise<string> => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  const { recordDecision } = (await import(pathToFileURL(runJournalPath).href)) as {
    recordDecision(input: Record<string, unknown>): unknown;
  };
  records.forEach((record, index) => {
    // `seq` and `at` are the journal writer's own to assign — a fixture that
    // supplied them would be asserting the writer's job rather than using it.
    const fields: Record<string, unknown> = { ...record };
    delete fields['seq'];
    delete fields['at'];
    recordDecision({
      runDir,
      ...fields,
      now: `2026-08-18T09:${String(index).padStart(2, '0')}:00.000Z`,
    });
  });
  return runDir;
};

describe('`coverage` is what a gate runs before it believes its own fan-out', () => {
  it('exits 0 when every launched reviewer answered for the commit', async () => {
    const runDir = await runDirWith(
      journal(routed(['code-reviewer']), fanOut(['code-reviewer']), answered('code-reviewer')),
    );
    const result = await runCli(['coverage', HEAD], runDir);
    expect(result.code, result.out).toBe(0);
    // A pass and a skip both exit 0, so the pass must not claim to be a skip —
    // otherwise the operator reads "nothing was checked" as the good news.
    expect(result.out).not.toMatch(/skip/i);
  });

  it('exits 1 and names the reviewer that was never launched', async () => {
    const runDir = await runDirWith(
      journal(
        routed(['code-reviewer', 'security-scanner']),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
      ),
    );
    const result = await runCli(['coverage', HEAD], runDir);
    expect(result.code, result.out).toBe(1);
    expect(result.stderr).toContain('security-scanner');
    expect(result.stderr).toMatch(/never launched|not launched|nobody (started|launched)/i);
  });

  it('tells the four cases apart, so a reader knows which fix each one needs', async () => {
    const runDir = await runDirWith(
      journal(
        routed(['security-scanner', 'code-reviewer', 'prose-reviewer', 'load-test-reviewer']),
        fanOut(['code-reviewer', 'prose-reviewer', 'load-test-reviewer']),
        answered('prose-reviewer', { headSha: undefined }),
        answered('load-test-reviewer', { headSha: OLDER }),
      ),
    );
    const result = await runCli(['coverage', HEAD], runDir);
    expect(result.code, result.out).toBe(1);

    const lineFor = (reviewer: string): string => {
      const line = result.stderr.split('\n').find((text) => text.includes(reviewer));
      expect(line, `nothing in the output names \`${reviewer}\``).toBeTruthy();
      return line ?? '';
    };
    // relaunch it
    expect(lineFor('security-scanner')).toMatch(
      /never launched|not launched|nobody (started|launched)/i,
    );
    // go and read why it said nothing
    expect(lineFor('code-reviewer')).toMatch(
      /unanswered|did not answer|no verdict|never answered/i,
    );
    // it spoke, but about no commit at all
    expect(lineFor('prose-reviewer')).toMatch(
      /named no commit|no commit|which commit|unattributed/i,
    );
    // it spoke about a commit that is not this one
    expect(lineFor('load-test-reviewer')).toMatch(/stale|another commit|different commit|older/i);
  });

  it('says it was skipped when no run directory is declared, rather than passing silently', async () => {
    // 🔴 Exit 0 with an empty stdout is indistinguishable from a clean round, and
    // an unattended session reads it as one. The skip is the honest answer — the
    // run kept no trace — and it has to be said out loud.
    const result = await runCli(['coverage', HEAD]);
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toMatch(/skip/i);
    expect(result.stdout).toMatch(/RIG_RUN_DIR|run director/i);
  });

  it('refuses a run with no fan-out recorded rather than reporting it clean', async () => {
    const runDir = await runDirWith(journal(routed(['code-reviewer']), answered('code-reviewer')));
    const result = await runCli(['coverage', HEAD], runDir);
    expect(result.code, result.out).toBe(1);
    expect(result.stderr).toMatch(/fan.?out/i);
  });

  it('says the commit argument is missing rather than calling `coverage` unknown', async () => {
    // The same two arms `check` keeps apart: the subcommand was right and the
    // ARGUMENT was not supplied, and reporting the opposite sends the operator
    // looking for a typo that is not there.
    const runDir = await runDirWith(journal(fanOut([])));
    const result = await runCli(['coverage'], runDir);
    expect(result.code, result.out).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/not a subcommand|unknown subcommand/i);
    expect(result.stderr).toMatch(/commit|sha/i);
    expect(result.stderr).toMatch(/missing|no commit|needs|without/i);
  });

  it('names `coverage` in the usage line beside `check`', async () => {
    const result = await runCli([]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/usage/i);
    expect(result.out).toMatch(/check/);
    expect(result.out).toMatch(/coverage/);
  });

  it('leaves `check` reading one report, run directory declared or not', async () => {
    // The regression guard on the new subcommand: `check` answers about the
    // report it was handed and has never read the journal. A `check` that
    // started consulting `RIG_RUN_DIR` would refuse reports in every run that
    // declared one.
    const dir = await mkdtemp(path.join(tmpdir(), 'verdict-'));
    const report = path.join(dir, 'report.md');
    await writeFile(
      report,
      [
        '```json',
        JSON.stringify({ gate: 'code-reviewer', verdict: 'SHIP', blockers: [] }),
        '```',
        '',
      ].join('\n'),
    );
    const runDir = await runDirWith(journal(fanOut(['prose-reviewer'])));

    for (const where of [undefined, runDir]) {
      const result = await runCli(['check', report, 'code-reviewer'], where);
      expect(result.code, result.out).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ gate: 'code-reviewer', verdict: 'SHIP' });
    }
  });
});

// 🔴 AR-79 defect. `coverageOf` decides "this reviewer answered for this commit"
// by exact string equality, but `lib/verdict.mjs` deliberately accepts an
// ABBREVIATED commit id — `/^[0-9a-f]{7,64}$/i`, with a seven-character sha
// pinned as accepted in `verdict.test.ts`. So a reviewer that answered
// `9c1f0a7` for the very commit `git rev-parse HEAD` prints in full is reported
// as `stale`, "it answered for another commit": a false HOLD on honest work.
//
// The rule an abbreviated id needs is git's own: two ids name the same commit
// when one is a prefix of the other, compared case-insensitively. The schema's
// seven-character floor is what makes that safe enough to rely on — which is
// also why a shorter value, one the schema refuses upstream, must not be
// stretched into a prefix match down here.
describe('an abbreviated commit id and a full one are the same commit', () => {
  /** The seven characters git prints by default for `HEAD`. */
  const HEAD_SHORT = HEAD.slice(0, 7);

  /**
   * A different commit that agrees with `HEAD` for its first six characters and
   * diverges at the seventh — `OLDER` shares nothing with `HEAD`, so it cannot
   * catch a prefix comparison that truncates to a fixed length before comparing.
   */
  const SIBLING_SHORT = `${HEAD.slice(0, 6)}8`;

  /** The same trap at full length: forty characters agreeing for the first seven. */
  const SIBLING_FULL = `${HEAD.slice(0, HEAD.length - 1)}1`;

  const covered = (verdictSha: string, argument: string = HEAD): Promise<Coverage> =>
    coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer', { headSha: verdictSha }),
      ),
      argument,
    );

  it('counts a seven-character verdict as coverage of the full commit asked about', async () => {
    const coverage = await covered(HEAD_SHORT);
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('counts a full-length verdict as coverage when the commit asked about is abbreviated', async () => {
    // The mirror, because the argument is whatever the caller had to hand: the
    // CLI is given a commit id, not necessarily the one the reviewer wrote.
    const coverage = await covered(HEAD, HEAD_SHORT);
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('counts an uppercase verdict as coverage of the same commit in lowercase', async () => {
    // `verdict.test.ts` pins uppercase hex as accepted and round-tripped
    // unchanged — "uppercase hex, which git prints on request" — so this value
    // reaches `coverageOf` in practice rather than in principle.
    const coverage = await covered(HEAD.toUpperCase());
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('counts an abbreviated uppercase verdict as coverage of the full lowercase commit', async () => {
    const coverage = await covered(HEAD_SHORT.toUpperCase());
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('still calls a verdict for an unrelated commit stale', async () => {
    // The regression guard on the widening: prefix matching must not turn the
    // check into "some commit was named".
    const coverage = await covered(OLDER);
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(false);
  });

  it('still calls a verdict stale when the two ids diverge inside the seven compared', async () => {
    // The case that forbids the lazy fix. Truncating both to six characters
    // before comparing would read this reviewer as having answered for `HEAD`,
    // and the whole point of the check is that it did not.
    const coverage = await covered(SIBLING_SHORT);
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(false);
  });

  it('still calls a verdict stale when two full ids agree for their first seven characters', async () => {
    // The same trap one level up: comparing a fixed seven characters of two
    // full-length ids would call two different commits one.
    const coverage = await covered(SIBLING_FULL);
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(false);
  });

  it('calls a verdict shorter than the schema’s seven-character floor stale rather than coverage', async () => {
    // 🔴 The answer pinned here is STALE, not coverage. `coverageOf` never
    // validates — it is handed whatever is in the journal — and six characters
    // is a value `lib/verdict.mjs` refuses upstream ("six characters, one short
    // of the shortest sha"). Seven is the floor that makes a prefix safe to
    // trust; stretching a shorter one into a match would let a value nothing
    // accepted decide that a gate was covered. It named a commit, so it is not
    // `unattributed` either — the reviewer spoke, and what it said cannot be
    // matched to this commit.
    const coverage = await covered(HEAD.slice(0, 6));
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.unattributed).toEqual([]);
    expect(coverage.ok).toBe(false);
  });
});
