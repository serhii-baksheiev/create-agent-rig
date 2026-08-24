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
const prShipPath = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'skills',
  'pr-ship',
  'SKILL.md',
);
const gateCoverageDecisionPath = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  'docs',
  'decisions',
  'gate-coverage.md',
);

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
        // Round 2's own routing record is fixture, not case: a round judged
        // against a route it never journalled is refused on that ground alone
        // ("the route a round is judged against is that round's own", below),
        // and without this line the `ok` asserted here would be the wrong one.
        // `pr-ship` re-enters at step 0 after a HOLD, so a real second round
        // re-routes before it re-launches — this is the shape a run produces.
        routed(['code-reviewer', 'prose-reviewer']),
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

// AR-118: a route after the last fan-out has two honest readings and the
// journal cannot choose between them. Either the fan-out record for that route
// is missing, or the router was rerun after a completed fan-out. Treating the
// earlier fan-out as if it consumed the later route silently joins two rounds.
// The only safe recovery is the same under both readings: rerun the fan-out for
// this head and write the record that makes the round boundary explicit.
describe('a route left unconsumed after the final fan-out makes this round unreadable', () => {
  const expectAmbiguousRoundReason = (reason: string | undefined): void => {
    expect(typeof reason, 'the unreadable round names no reason').toBe('string');
    expect(reason).toMatch(/fan.?out.*(?:missing|not (?:written|recorded))|missing.*fan.?out/i);
    expect(reason).toMatch(/router.*(?:re-?ran|ran again)|routing.*after.*fan.?out/i);
    expect(reason).toMatch(/rerun.*fan.?out.*(?:this|current).*(?:head|commit)/i);
  };

  it('refuses a non-empty route after the final fan-out without inventing coverage facts', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
        routed(['security-scanner']),
      ),
    );

    expect(coverage.ok).toBe(false);
    // The pending route is recorded fact and may be returned. There is no
    // fan-out that can safely be paired with it, so none of the comparison
    // lists may be manufactured from the completed round before it.
    expect(coverage.routed).toEqual(['security-scanner']);
    expect(coverage.launched).toEqual([]);
    expect(coverage.neverLaunched).toEqual([]);
    expect(coverage.unanswered).toEqual([]);
    expect(coverage.unattributed).toEqual([]);
    expect(coverage.stale).toEqual([]);
    expectAmbiguousRoundReason(coverage.reason);
  });

  it('refuses an empty route after the final fan-out instead of losing it to a truthy check', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
        routed([], 'deterministic'),
      ),
    );

    expect(coverage.ok).toBe(false);
    expect(coverage.routed).toEqual([]);
    expect(coverage.launched).toEqual([]);
    expect(coverage.neverLaunched).toEqual([]);
    expect(coverage.unanswered).toEqual([]);
    expect(coverage.unattributed).toEqual([]);
    expect(coverage.stale).toEqual([]);
    expectAmbiguousRoundReason(coverage.reason);
  });

  it('accepts two honest route to fan-out to answers rounds with no route left over', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer'], OLDER),
        answered('code-reviewer', { headSha: OLDER }),
        routed(['code-reviewer', 'prose-reviewer']),
        fanOut(['code-reviewer', 'prose-reviewer']),
        answered('code-reviewer'),
        answered('prose-reviewer'),
      ),
    );

    expect(coverage.ok).toBe(true);
    expect(coverage.routed).toEqual(['code-reviewer', 'prose-reviewer']);
    expect(coverage.launched).toEqual(['code-reviewer', 'prose-reviewer']);
    expect('reason' in coverage).toBe(false);
  });
});

describe('the fan-out record itself belongs to the head being checked', () => {
  const expectFanOutHeadRefusal = (coverage: Coverage): void => {
    expect(coverage.ok).toBe(false);
    // A route and launched set from another or unattributed head cannot be
    // turned into facts about this head merely because fresh verdict records
    // happen to follow them.
    expect(coverage.routed).toEqual([]);
    expect(coverage.launched).toEqual([]);
    expect(coverage.neverLaunched).toEqual([]);
    expect(coverage.unanswered).toEqual([]);
    expect(coverage.unattributed).toEqual([]);
    expect(coverage.stale).toEqual([]);
    expect(typeof coverage.reason, 'the fan-out head refusal names no reason').toBe('string');
    expect(coverage.reason).toMatch(/fan.?out.*(?:head|commit)/i);
    expect(coverage.reason).toMatch(/rerun.*fan.?out.*(?:this|current).*(?:head|commit)/i);
  };

  it('refuses an older fan-out even when every later verdict names the requested head', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer', 'prose-reviewer']),
        fanOut(['code-reviewer', 'prose-reviewer'], OLDER),
        answered('code-reviewer'),
        answered('prose-reviewer'),
      ),
    );

    expectFanOutHeadRefusal(coverage);
    expect(coverage.reason).toMatch(/(?:older|different|another|does not match)/i);
  });

  it('refuses a fan-out that names no head instead of attributing it from fresh verdicts', async () => {
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        { ...fanOut(['code-reviewer']), headSha: undefined },
        answered('code-reviewer'),
      ),
    );

    expectFanOutHeadRefusal(coverage);
    expect(coverage.reason).toMatch(/(?:missing|absent|unattributed|names no)/i);
  });
});

describe('the shipped gate instructions name every unreadable-round branch', () => {
  it('does not claim reason belongs only to missing fan-out', async () => {
    const header = (await readFile(modulePath, 'utf8')).split('/** The gate name')[0] ?? '';
    expect(header).not.toMatch(/present on no other answer/i);
    expect(header).toMatch(/missing fan.?out/i);
    expect(header).toMatch(/missing route/i);
    expect(header).toMatch(/(?:unconsumed|left over) route/i);
  });

  it('names a fan-out with no head as its own unreadable boundary', async () => {
    const header = (await readFile(modulePath, 'utf8')).split('/** The gate name')[0] ?? '';
    expect(header).toMatch(
      /fan.?out (?:missing (?:a |its )?(?:head|commit)|(?:with|that names)[^\n]*(?:no|absent)[^\n]*(?:head|commit))/i,
    );
  });

  it('names a fan-out for a different head as its own unreadable boundary', async () => {
    const header = (await readFile(modulePath, 'utf8')).split('/** The gate name')[0] ?? '';
    expect(header).toMatch(
      /fan.?out[^\n]*(?:different|mismatch(?:ed)?|other)[^\n]*(?:head|commit)/i,
    );
  });

  it('requires a fan-out record even when the launched set is empty', async () => {
    const source = await readFile(prShipPath, 'utf8');
    expect(source).toMatch(/record[^\n]*fan.?out[^\n]*even when[^\n]*(?:set|list)[^\n]*empty/i);
  });

  it('distinguishes declared-run coverage from an undeclared-run skip at exit zero', async () => {
    const source = await readFile(prShipPath, 'utf8');
    expect(source).toMatch(/\bdeclared run\b[\s\S]{0,180}\bexit 0\b[\s\S]{0,100}\bcoverage\b/i);
    expect(source).toMatch(
      /(?=[\s\S]{0,180}(?:unset|no) `?RIG_RUN_DIR`?)(?=[\s\S]{0,180}\bexit 0\b)(?=[\s\S]{0,180}\bskip(?:ped)?\b)/i,
    );
  });

  it('describes reason-only unreadable-round failures beside reviewer-list failures', async () => {
    const source = await readFile(prShipPath, 'utf8');
    expect(source).toMatch(
      /exit 1[\s\S]*(?:reason-only|reason without a reviewer)[\s\S]*unreadable[\s\S]*(?:reviewer lists|reviewer-list)/i,
    );
  });

  it('does not promise that every reason-only boundary has a remedy', async () => {
    const source = await readFile(prShipPath, 'utf8');
    expect(source).not.toMatch(/reason-only[^.]*prints? the evidence boundary and remedy/i);
  });

  it('always prints the boundary but offers a remedy only when recovery is unambiguous', async () => {
    const source = await readFile(prShipPath, 'utf8');
    expect(source).toMatch(
      /reason-only[\s\S]{0,180}(?:always|each)[\s\S]{0,100}(?:evidence )?boundary/i,
    );
    expect(source).toMatch(
      /remed(?:y|ies)[\s\S]{0,100}only when[\s\S]{0,100}(?:unambiguous|available|safe)/i,
    );
  });

  it('does not point a shipped module at a generator-only test path', async () => {
    const header = (await readFile(modulePath, 'utf8')).split('/** The gate name')[0] ?? '';
    expect(header).not.toContain('test/template/gate-coverage.test.ts');
  });

  it('names the shipped module path exactly in the canonical decision', async () => {
    const decision = await readFile(gateCoverageDecisionPath, 'utf8');
    expect(decision).toContain('.claude/scripts/lib/gate-coverage.mjs');
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
      journal(routed(['prose-reviewer']), fanOut(['prose-reviewer']), {
        gate: 'pr-ship',
        verdict: 'SHIP',
        why: null,
        blockers: [],
        headSha: HEAD,
      }),
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
    // The `routed` record is part of the fixture rather than of the case: a run
    // that journalled no route at all is refused on that ground alone (see "a
    // round whose route was never journalled is not a covered round"), and
    // without it this test would be asserting the wrong `ok`.
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer', { headSha: HEAD }),
      ),
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
    //
    // The `routed([])` record is fixture, not case: a journal carrying NO
    // routing record now carries a reason of its own ("a round whose route was
    // never journalled is not a covered round" below), and omitted is not empty
    // on that side too — so the fan-out has to be the only thing this test
    // varies for it to keep testing what it was written to test.
    const coverage = await coverageOf(journal(routed([], 'deterministic'), fanOut([])));
    expect('reason' in coverage).toBe(false);
  });
});

// 🔴 AR-79, round 1. The routed set is assigned by ONE thing: a record matching
// `review-routing:` that carries a `reviewers` array. With no such record the
// routed set stays `[]`, `neverLaunched` can never fire, and the answer is
// `ok: true` — for a round in which nothing is known to have been routed. That
// is the vacuous pass this module exists to refuse, wearing the shape of the
// `deterministic` lane's legitimate empty route.
//
// It needs no crafting to reach: `decision-router.mjs` catches its own journal
// failure and carries on, and a second gate round driven from a fresh
// `RIG_RUN_DIR` has no routing line in it at all.
//
// The distinction pinned here is the same "omitted is not empty" the `headSha`
// schema keeps: *a set was recorded and it was empty* versus *no set was
// recorded*.
describe('a round whose route was never journalled is not a covered round', () => {
  const noRoute = (): JournalRecord[] =>
    journal(fanOut(['code-reviewer']), answered('code-reviewer'));

  it('refuses a run whose journal records no routed reviewer set at all', async () => {
    expect((await coverageOf(noRoute())).ok).toBe(false);
  });

  it('says why in the field the missing fan-out already uses, so a caller reads one', async () => {
    const coverage = await coverageOf(noRoute());
    expect(typeof coverage.reason, 'the refusal names no reason').toBe('string');
    expect(coverage.reason).toMatch(/rout(e|ed|ing)/i);
  });

  it('refuses a run in which every lane declined and none of them recorded a set', async () => {
    // `declined()` carries no `reviewers` key by design — the set belongs to the
    // route, not to the lanes that passed on it — so a journal of nothing but
    // declines has recorded no routed set either. Same unreadable round, three
    // records instead of none.
    const coverage = await coverageOf(
      journal(
        declined('deterministic'),
        declined('fast-path'),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
      ),
    );
    expect(coverage.ok).toBe(false);
    expect(coverage.reason).toMatch(/rout(e|ed|ing)/i);
  });

  it('still names the reviewers it can, because the reason is not the only thing to act on', async () => {
    // Unlike a missing FAN-OUT, this round has a launched set and answers to
    // compare against it, so the four lists are computable — and a refusal that
    // dropped them would cost the reader the finding they could act on today.
    const coverage = await coverageOf(
      journal(fanOut(['code-reviewer', 'prose-reviewer']), answered('code-reviewer')),
    );
    expect(coverage.unanswered).toEqual(['prose-reviewer']);
    expect([...coverage.launched].sort()).toEqual(['code-reviewer', 'prose-reviewer']);
  });

  it('reads a recorded empty route as an empty route rather than as a missing one', async () => {
    // The `deterministic` lane routes nobody and journals that it routed nobody.
    // It is the case the refusal above must not swallow, and the only thing
    // telling the two apart is that the record exists.
    const coverage = await coverageOf(journal(routed([], 'deterministic'), fanOut([])));
    expect(coverage.ok).toBe(true);
    expect('reason' in coverage).toBe(false);
  });
});

// 🔴 AR-79, round 2. The ANSWERS are already scoped to the round — everything
// after the last fan-out — and the ROUTE is not: it is read from the last
// `review-routing:` record carrying a set ANYWHERE in the journal. A run
// directory spans more than one round, so an earlier round's route satisfies the
// refusal for a later round that journalled none, and the earlier round's SET is
// inherited along with it.
//
// It needs no crafting to reach: `decision-router.mjs` catches its own journal
// failure and carries on, so a round whose routing line was never written still
// reports `ok: true` against the route of the round before it — while the
// reviewer THIS round's route asked for was never launched and never spoke.
//
// The worst shape is an inherited EMPTY route: round 1 on the `deterministic`
// lane leaves `routed` at `[]` for every later round, and `neverLaunched` is then
// unconditionally empty — the comparison cannot fire at all.
//
// The rule: the route belongs to the round, exactly as the answers do. The
// routing record that counts is the last one carrying `reviewers` whose position
// is after the previous fan-out and before the last one.
const secondRoundWithNoRouteOfItsOwn = (firstRoute: JournalRecord): JournalRecord[] =>
  journal(
    firstRoute,
    fanOut(['code-reviewer'], OLDER),
    answered('code-reviewer', { headSha: OLDER }),
    // Round 2: the router's line never reached the journal, so the only thing
    // recorded is what was launched and what came back.
    fanOut(['code-reviewer']),
    answered('code-reviewer'),
  );

describe('the route a round is judged against is that round’s own', () => {
  it('refuses a second round that journalled no route, instead of reading the first round’s', async () => {
    const coverage = await coverageOf(
      secondRoundWithNoRouteOfItsOwn(routed(['code-reviewer'])),
      HEAD,
    );
    expect(coverage.ok).toBe(false);
    expect(typeof coverage.reason, 'the refusal names no reason').toBe('string');
    expect(coverage.reason).toMatch(/rout(e|ed|ing)/i);
  });

  it('inherits no reviewer from the route of the round before it', async () => {
    // The security half. `security-scanner` is what round 2's route asked for;
    // nothing recorded it, nothing launched it, and round 1's route — which
    // named only `code-reviewer` and was fully satisfied — is what the answer
    // was compared against.
    const coverage = await coverageOf(
      secondRoundWithNoRouteOfItsOwn(routed(['code-reviewer'])),
      HEAD,
    );
    expect(coverage.routed).toEqual([]);
  });

  it('refuses a second round with no route even when the first round routed nobody', async () => {
    // 🔴 The shape with no findings of its own to give it away. Round 1 took the
    // `deterministic` lane, so the inherited route is `[]` — every later round
    // then has an empty `routed`, `neverLaunched` can never fire, and the answer
    // is a pass computed from a comparison that never happened.
    const coverage = await coverageOf(
      journal(
        routed([], 'deterministic'),
        fanOut([], OLDER),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
      ),
      HEAD,
    );
    expect(coverage.ok).toBe(false);
    expect(coverage.reason).toMatch(/rout(e|ed|ing)/i);
  });

  it('judges a second round that carries its own route by that route alone', async () => {
    // Round 1 routed two reviewers; round 2 re-routed to one. The reviewer round
    // 1 asked for is not outstanding in round 2 — nobody asked for it, and
    // naming it would send the author to relaunch a gate this round does not
    // want.
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer', 'security-scanner']),
        fanOut(['code-reviewer', 'security-scanner'], OLDER),
        answered('code-reviewer', { headSha: OLDER }),
        answered('security-scanner', { headSha: OLDER }),
        routed(['code-reviewer']),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
      ),
      HEAD,
    );
    expect(coverage.routed).toEqual(['code-reviewer']);
    expect(coverage.neverLaunched).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('names a reviewer the second round’s own route asked for and nobody launched', async () => {
    // The other direction of the same rule: round 1 was complete, and that does
    // not cover a reviewer round 2 added and never started.
    const coverage = await coverageOf(
      journal(
        routed(['code-reviewer']),
        fanOut(['code-reviewer'], OLDER),
        answered('code-reviewer', { headSha: OLDER }),
        routed(['code-reviewer', 'security-scanner']),
        fanOut(['code-reviewer']),
        answered('code-reviewer'),
      ),
      HEAD,
    );
    expect(coverage.neverLaunched).toEqual(['security-scanner']);
    expect(coverage.ok).toBe(false);
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

  it('refuses a run that journalled no route rather than reporting it clean', async () => {
    const runDir = await runDirWith(journal(fanOut(['code-reviewer']), answered('code-reviewer')));
    const result = await runCli(['coverage', HEAD], runDir);
    expect(result.code, result.out).toBe(1);
    expect(result.stderr).toMatch(/rout(e|ed|ing)/i);
  });

  it('refuses a second round that journalled no route, through a real run directory', async () => {
    // 🔴 The end-to-end half of "the route a round is judged against is that
    // round's own": a run directory is not per-round, so this is the ordinary
    // shape of a branch that got a second gate round — and the answer it gets
    // today is `coverage complete`, exit 0.
    const runDir = await runDirWith(secondRoundWithNoRouteOfItsOwn(routed(['code-reviewer'])));
    const result = await runCli(['coverage', HEAD], runDir);
    expect(result.code, result.out).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/rout(e|ed|ing)/i);
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

  // 🔴 AR-79, round 1. Only `undefined` is caught today, so any other argument
  // is carried straight into the comparison: `<head>garbage` is reported as
  // COVERED by the prefix rule, and `''` reports every reviewer stale. Both are
  // answers about a commit nobody named, and the first exits 0.
  //
  // `lib/verdict.mjs` already fixes the shape a commit id has (7–64 hex,
  // `isCommitId`); the argument this CLI compares against is the same kind of
  // value and gets the same check, before anything is decided from it.
  describe('the commit `coverage` is asked about has to be a commit id', () => {
    /**
     * The refusal has to name the SHAPE — 7 to 64 characters of hex — the same
     * way the verdict schema's does; several phrasings satisfy it, and none of
     * them may leave the reader without the shape.
     */
    const namesTheShape = /hex|0-9a-f|7\D{1,4}64/i;

    /** A round that IS covered, so a refusal here can only be about the argument. */
    const coveredRun = (): Promise<string> =>
      runDirWith(
        journal(routed(['code-reviewer']), fanOut(['code-reviewer']), answered('code-reviewer')),
      );

    it.each([
      ['a value that merely extends a commit id', `${HEAD}garbage`],
      ['an empty argument', ''],
      ['a value starting with a dash', '-9c1f0a7'],
      ['a path traversal', '../x'],
      ['text that is not hex at all', 'not-a-commit'],
      ['six characters, one short of the shortest sha', '9c1f0a'],
      ['sixty-five characters, one past the longest', 'a'.repeat(65)],
      ['a commit id with whitespace around it', ` ${HEAD} `],
    ])('refuses %s instead of answering about it', async (_label, commit) => {
      const result = await runCli(['coverage', commit], await coveredRun());
      expect(result.code, result.out).toBe(1);
      // Nothing on stdout, for the same reason `check` promises it: a caller
      // redirecting it would capture an answer this command has just refused.
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(namesTheShape);
      // and it stays the OTHER arm of the pair: an operator told no commit was
      // given goes looking for the argument they can see they passed.
      expect(result.stderr).not.toMatch(/no commit was given/i);
    });

    it('still answers about an abbreviated commit, which is a commit id too', async () => {
      // The regression guard on the check: the schema accepts seven characters,
      // so a caller that abbreviated must not be refused by the shape.
      const result = await runCli(['coverage', HEAD.slice(0, 7)], await coveredRun());
      expect(result.code, result.out).toBe(0);
      expect(result.stdout).toMatch(/coverage complete/i);
    });
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
        fanOut(['code-reviewer'], argument),
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

  // 🔴 AR-79, round 1: the prefix rule is only safe in ONE direction, and the
  // other one is reachable through the fully validated path. A value formed by
  // APPENDING to the full forty-character head has that head as its prefix, so
  // it is reported as coverage of it — and being 7–64 hex it passes `isCommitId`
  // and reaches the journal as an ordinary `headSha`.
  //
  // The rule that makes every case in this describe consistent: two ids name the
  // same commit when they are EQUAL, or when the shorter is a prefix of a
  // COMPLETE one — the forty characters git prints for a sha1, or the sixty-four
  // of the longer hash. A value of any other length is an abbreviation of
  // nothing, and an abbreviation is only ever resolved against a whole id.

  /** The sixty-four characters of the longer hash, abbreviating to the same seven. */
  const HEAD_LONG = `${HEAD.slice(0, 7)}${'f'.repeat(57)}`;

  /** What `--abbrev=12` prints: neither a complete id nor the length of its partner. */
  const HEAD_MEDIUM = HEAD.slice(0, 12);

  /** The full head with ten more hex characters welded on — no commit is fifty long. */
  const EXTENDED = `${HEAD}0f1e2d3c4b`;

  it('counts a twelve-character verdict as coverage of the full commit it abbreviates', async () => {
    // The length that is neither complete nor equal to its partner: it can only
    // be judged by the rule above, not by either id being the size the other is.
    const coverage = await covered(HEAD_MEDIUM);
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('counts a seven-character verdict as coverage of the sixty-four character hash it abbreviates', async () => {
    const coverage = await covered(HEAD_LONG.slice(0, 7), HEAD_LONG);
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('counts a sixty-four character verdict as coverage of the same commit asked about in seven', async () => {
    const coverage = await covered(HEAD_LONG, HEAD_LONG.slice(0, 7));
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('counts two identical abbreviations as the same commit, complete or not', async () => {
    // Equality is the other half of the rule and it is length-independent: two
    // ids that are the same text are the same commit, whatever length they are.
    const coverage = await covered(HEAD_SHORT, HEAD_SHORT);
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('calls a fifty-character value that merely extends the full commit stale', async () => {
    // 🔴 The defect. `EXTENDED` starts with every character of `HEAD`, and
    // nothing about that makes it the same commit — no hash is fifty long, so it
    // is an id nobody abbreviated from anything.
    const coverage = await covered(EXTENDED);
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.unattributed).toEqual([]);
    expect(coverage.ok).toBe(false);
  });

  it('calls the same extension stale when it is the commit asked about instead', async () => {
    // The mirror, because the comparison is symmetric: the caller's argument is
    // whatever it had to hand, and a value nothing produced must not become the
    // yardstick either.
    const coverage = await covered(HEAD, EXTENDED);
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(false);
  });

  it('calls a value one character past the full commit stale', async () => {
    // The narrowest form of the same thing: it is not the SIZE of the extension
    // that decides, it is that the longer id is not a length any commit has.
    const coverage = await covered(`${HEAD}0`);
    expect(coverage.stale).toEqual(['code-reviewer']);
    expect(coverage.ok).toBe(false);
  });

  // The one pair where the floor and the ceiling MEET: a complete forty-character
  // id that is a prefix of a complete sixty-four character one. The rule decides
  // it as a match — it could be a sha-256 abbreviated to forty or a sha-1 with
  // characters welded on, nothing pure can resolve which, and the first reading is
  // the one an honest run produces.
  //
  // No fixture above reaches it in either direction: `HEAD_LONG` shares only seven
  // characters with `HEAD`, and `EXTENDED`/`${HEAD}0` are fifty and forty-one,
  // which the ceiling refuses outright. So the outcome is currently chosen rather
  // than derived, and a later tightening would flip it with the whole suite green.

  /**
   * `HEAD` extended to sixty-four hex characters — a COMPLETE id of the longer
   * hash that has the complete forty-character one as its prefix.
   */
  const HEAD_AS_PREFIX_OF_COMPLETE = `${HEAD}${'a1b2c3d4e5f6'.repeat(2)}`;

  it('counts a forty-character verdict as coverage of the complete sixty-four character id it prefixes', async () => {
    // The fixture IS the case, so the pair is asserted rather than assumed:
    // forty characters, sixty-four characters, one a prefix of the other.
    expect(HEAD).toHaveLength(40);
    expect(HEAD_AS_PREFIX_OF_COMPLETE).toHaveLength(64);
    expect(HEAD_AS_PREFIX_OF_COMPLETE.startsWith(HEAD)).toBe(true);

    const coverage = await covered(HEAD, HEAD_AS_PREFIX_OF_COMPLETE);
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('counts a complete sixty-four character verdict as coverage of the forty-character commit it extends', async () => {
    // The mirror, because the comparison is symmetric and the argument is
    // whatever the caller had to hand.
    expect(HEAD_AS_PREFIX_OF_COMPLETE).toHaveLength(64);
    expect(HEAD_AS_PREFIX_OF_COMPLETE.startsWith(HEAD)).toBe(true);

    const coverage = await covered(HEAD_AS_PREFIX_OF_COMPLETE, HEAD);
    expect(coverage.stale).toEqual([]);
    expect(coverage.ok).toBe(true);
  });
});

// 🔴 AR-79, round 1. The coverage refusal prints reviewer names straight out of
// the journal, and `recordDecision` checks that array for strings and nothing
// more — the names are typed by the model driving `pr-ship`, which is the same
// class of value every other quoted field in this CLI already sanitises. A name
// carrying a CR or a cursor sequence repaints the line it is printed on, and
// that line is a merge-gating refusal: the operator watching the fan-out reads a
// HOLD as a pass, while the exit code (which nobody is looking at) says 1.
//
// `safeForDiagnosis` in `lib/verdict.mjs` is the one sanitiser for this, and
// `verdict.mjs` already imports it. Pinned end to end through the CLI, because
// the journal round trip is part of the path the value takes.
describe('a reviewer name in a coverage refusal cannot repaint the operator’s screen', () => {
  /** ESC, built rather than typed: a raw escape byte is one the next reader cannot see. */
  const ESC = String.fromCharCode(0x1b);

  /** The C1 control introducer — the single-character spelling of the same escape. */
  const C1 = String.fromCharCode(0x9b);

  /**
   * What a name would carry to erase the refusal above it and print a pass in
   * its place: erase the line, move up one, return the carriage, reset.
   */
  const painted = (identity: string): string =>
    `${ESC}[2K${identity}${ESC}[1A\r${C1}0m all gates clear`;

  /**
   * Newlines are the refusal's own — it writes one per reviewer — so they come
   * out first, and every remaining control character is one it did not intend.
   */
  const paintableCharsIn = (stderr: string): string[] =>
    [...stderr.split('\n').join('')].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });

  it.each([
    [
      'the fan-out launched and nothing answered for',
      (name: string): JournalRecord[] => journal(routed([name]), fanOut([name])),
    ],
    [
      'the route asked for and the fan-out never launched',
      (name: string): JournalRecord[] => journal(routed([name]), fanOut([])),
    ],
  ])('prints no control character out of a name %s', async (_label, build) => {
    const runDir = await runDirWith(build(painted('code-reviewer')));
    const result = await runCli(['coverage', HEAD], runDir);
    expect(result.code, result.out).toBe(1);
    expect(result.stdout).toBe('');
    expect(paintableCharsIn(result.stderr)).toEqual([]);
    // and the reviewer stays identifiable, or the fix trades one unreadable
    // diagnosis for another: the payload arrives as its own visible words.
    expect(result.stderr).toContain('code-reviewer');
  });
});
