import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');

const templatePlan = () => readFile(path.join(universalDir, 'PLAN.md'), 'utf8');
const templateJournalReadme = () =>
  readFile(path.join(universalDir, 'journal', 'README.md'), 'utf8');
const repoPlan = () => readFile(path.join(repoRoot, 'PLAN.md'), 'utf8');

/** `YYYY-MM.md` — the one filename shape a month file is allowed to have. */
export const MONTH_FILE = /^\d{4}-(0[1-9]|1[0-2])\.md$/;

/**
 * The `## Journal` SECTION — a heading on its own line, not the two words.
 *
 * Anchored on purpose: a plan that explains the move legitimately mentions the
 * old heading in prose ("the heading here is deliberately **not** `## Journal`",
 * which is a useful thing to say). Matching the bare substring would fail that
 * sentence, and a check that fires on a correct implementation gets deleted.
 */
const JOURNAL_HEADING = /^##\s+Journal\s*$/m;

export type MonthFile = {
  /** file name, e.g. `2026-08.md` */
  name: string;
  /** the `YYYY-MM` stem */
  month: string;
  /** the file's opening `#` heading, or null if it does not open with one */
  title: string | null;
  /** every `###` entry heading, in document order */
  entries: string[];
  /** any heading that is neither the opening `#` nor a `###` entry */
  strayHeadings: string[];
  content: string;
};

/**
 * Parse one month file into its headings.
 *
 * 🔴 Exported for AR-44, which owns the newest-on-top ORDER check and nothing
 * here does: journal entries are date-free by convention ("order carries the
 * sequence"), so deciding which of two entries is newer is that ticket's
 * subject, not a side effect of this move. What this gives AR-44 is the parse —
 * `entries` in document order, fence-aware — so it can assert on order without
 * re-deriving the file shape. Do not add an ordering assertion here.
 */
export function parseMonthFile(name: string, content: string): MonthFile {
  const headings: Array<{ level: number; text: string }> = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    // fenced blocks hold shell comments that look exactly like headings
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) headings.push({ level: heading[1]!.length, text: heading[2]! });
  }
  const opens = headings[0]?.level === 1;
  const rest = headings.slice(opens ? 1 : 0);
  return {
    name,
    month: name.replace(/\.md$/, ''),
    title: opens ? headings[0]!.text : null,
    entries: rest.filter((h) => h.level === 3).map((h) => h.text),
    strayHeadings: rest.filter((h) => h.level !== 3).map((h) => `${'#'.repeat(h.level)} ${h.text}`),
    content,
  };
}

/** Every `YYYY-MM.md` in a journal directory, parsed, in filename order. */
export async function readMonthFiles(dir: string): Promise<MonthFile[]> {
  const names = (await readdir(dir)).filter((n) => MONTH_FILE.test(n)).sort();
  return Promise.all(
    names.map(async (n) => parseMonthFile(n, await readFile(path.join(dir, n), 'utf8'))),
  );
}

/**
 * Does `companion` appear within `radius` characters of some occurrence of
 * `anchor`? The unit is a *passage*, not a sentence, on purpose: these checks
 * guard facts that must survive a rewrite, and a check that fails when a
 * sentence is reworded without changing its content is a check that gets
 * deleted — after which the fact it guarded is unprotected again.
 */
function nearAnchor(text: string, anchor: RegExp, companion: RegExp, radius = 800): boolean {
  const scan = new RegExp(
    anchor.source,
    anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`,
  );
  for (const match of text.matchAll(scan)) {
    const start = Math.max(0, match.index - radius);
    if (companion.test(text.slice(start, match.index + match[0].length + radius))) return true;
  }
  return false;
}

// AR-64: `## Journal` was the largest single block of text in this factory —
// 58.1 KB of a 102 KB PLAN.md, ~22k tokens re-read by every session that opens
// the plan. The journal moves to `journal/YYYY-MM.md`, one file per month,
// newest-on-top inside each file; PLAN.md keeps its name, both queue headings
// and its phases. The queue parser (`plan-md.mjs`) reads those headings and is
// untouched by this move — the tests below are about the DOCUMENT, not the
// parser (the `## Journal` strings in queue.test.ts are parser fixtures: an
// arbitrary trailing heading that bounds the Agent queue section, and they stay).

describe('PLAN.md is the queues, and the journal is not in it (template)', () => {
  it('carries both queue headings and no journal section', async () => {
    const plan = await templatePlan();
    // the two headings the queue adapter resolves by name — the move must not
    // touch them, and a plan without them makes `loop` throw `queue-unreadable`
    expect(plan).toContain('## Agent queue');
    expect(plan).toContain('## Operator queue');
    expect(plan).not.toMatch(JOURNAL_HEADING);
    // and the field list left with the section: a plan that still documents the
    // entry shape is a plan a session still reads for it
    expect(plan).not.toContain('**unblocked**');
  });
});

describe('journal/README.md seeds the convention (template)', () => {
  it('exists and names every field an entry can carry', async () => {
    const readme = await templateJournalReadme();
    // the fields are what makes an entry visibly INCOMPLETE rather than a diary
    // that reads fine and proves nothing — each is pinned in its bold form,
    // because the bold marker is what a later reader (or a sweep) keys on
    for (const field of [
      'done',
      'escalated',
      'reviewed',
      'stopped at',
      'unblocked',
      'queue hygiene',
      'cost',
    ]) {
      expect(readme, field).toContain(`**${field}**`);
    }
  });

  it('keeps `unblocked` un-droppable, with all three answers that do not substitute', async () => {
    const readme = await templateJournalReadme();
    expect(readme).toMatch(/never\s+dropped/i);
    // three answers, and the distinction between them is the whole field:
    // named dependents; "nothing was waiting" (asked, found none); and "this
    // queue cannot be asked" — a flat list is ABSENT, not satisfied. Collapsing
    // the third into the second claims a look no query could perform.
    expect(readme).toMatch(/nothing\s+was\s+waiting/i);
    expect(readme).toMatch(/no\s+dependency\s+links/i);
    expect(readme).toMatch(/absent\*?\*?,\s+not\s+satisfied/i);
    expect(readme).toMatch(/substitute/i);
  });

  it('says an unobservable field stays empty and is never estimated', async () => {
    const readme = await templateJournalReadme();
    // a plausible number will be believed — by the next reader and by the next
    // run reasoning about its own budget. The gap is the information.
    expect(readme).toMatch(/visibly\s+empty/i);
    expect(readme).toMatch(/never\s+estimated|not\s+estimated/i);
  });

  it('states the file convention: one file per month, named YYYY-MM.md, newest on top', async () => {
    const readme = await templateJournalReadme();
    expect(readme).toContain('YYYY-MM.md');
    expect(readme).toMatch(/one\s+file\s+per\s+month/i);
    // ordering inside the file. `run-journal.mjs` is the opposite on purpose
    // (append-only, oldest-first machine trace); stating this here is what keeps
    // the two artifacts from being read as one.
    expect(readme).toMatch(/newest[-\s]on[-\s]top/i);
  });
});

describe('the loop skill writes the journal to the month file (template)', () => {
  const loopSkill = () =>
    readFile(path.join(universalDir, '.claude', 'skills', 'loop', 'SKILL.md'), 'utf8');

  it('§7 sends the entry to journal/YYYY-MM.md', async () => {
    const content = await loopSkill();
    const section = /## 7\.[\s\S]*?(?=\n## |$)/.exec(content);
    expect(section, 'the journal section must still exist').toBeTruthy();
    expect(section![0]).toContain('journal/YYYY-MM.md');
  });

  it('sends no session to PLAN.md for the journal or its fields', async () => {
    const content = await loopSkill();
    // a pointer into a heading that no longer exists is a dead reference, and
    // this skill carried three of them (the intro, §7's field list, and the
    // run-trace contrast in §7). What is forbidden is naming PLAN.md and the
    // journal section in one breath — a standalone historical mention of the
    // old heading is not a pointer and stays legal.
    expect(content).not.toMatch(/PLAN\.md`?[\s\S]{0,60}## Journal/i);
    expect(content).not.toMatch(/## Journal[\s\S]{0,60}PLAN\.md/i);
    expect(content).not.toMatch(/PLAN\.md`?\s+holds[\s\S]{0,80}journal/i);
  });
});

describe("this repo's own journal left PLAN.md (dogfooding)", () => {
  it('keeps the queues and the phases, and no longer carries the journal', async () => {
    const plan = await repoPlan();
    expect(plan).toContain('## Agent queue');
    expect(plan).toContain('## Operator queue');
    expect(plan).toContain('## 7. Phases');
    expect(plan).not.toMatch(JOURNAL_HEADING);
  });

  it('keeps every PLAN.md inside the context budget that motivated the move', async () => {
    // 🔴 The ticket text says 24 KB for this repo, and the session that took
    // AR-64 first ruled 32 KB. Both are unreachable without deleting something
    // the same decision protects, and the arithmetic is exact rather than
    // approximate: after the journal moved and both queue sections were cut to
    // bullets, PLAN.md measured 37,498 bytes — 4,730 over 32 KB — while the
    // three `[carried → AR-n]` bullets in the Operator queue weigh 4,680. They
    // ARE the overage. Deleting one hand-performs the defect AR-48 is about:
    // the bullet is the fingerprint's only home under `plan-md`, so without it
    // the next run files the same proposal again as a fresh `seen ×1`. The
    // remaining 5 KB could only come from `## 7. Phases`, which the decision
    // keeps.
    //
    // So the owner ruled 40 KB. The move still takes this file from 102 KB to
    // ~37.5 KB — 63% of the read cost, almost all of it the journal rather than
    // the prose. When AR-48 moves the dedup base off `plan-md` and the carried
    // bullets can go, this can drop to 32 KB in one edit.
    const budgets: Array<[string, number]> = [
      [path.join(universalDir, 'PLAN.md'), 4 * 1024],
      [path.join(repoRoot, 'PLAN.md'), 40 * 1024],
    ];
    for (const [file, limit] of budgets) {
      const { size } = await stat(file);
      expect(size, `${path.relative(repoRoot, file)} is ${size} bytes`).toBeLessThanOrEqual(limit);
    }
  });

  it('has month files, and nothing else pretending to be one', async () => {
    const entries = await readdir(path.join(repoRoot, 'journal'), { withFileTypes: true });
    const markdown = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
      .map((e) => e.name);
    expect(
      markdown.length,
      'the journal moved here, so at least one month file exists',
    ).toBeGreaterThan(0);
    for (const name of markdown) expect(name, name).toMatch(MONTH_FILE);
  });

  it('opens every month file with its own heading and lists entries as ### under it', async () => {
    // The cheap structural half of the convention: one `#` for the month, then
    // a flat run of `###` entries. It is the anchor AR-44 needs — that ticket
    // asserts a NEW entry lands directly under the top heading, which is only
    // decidable once "directly under the top heading" has a shape.
    //
    // The heading TEXT is deliberately unpinned: `# 2026-08` and
    // `# August 2026` are both legal, and pinning one would fail a rewrite that
    // changes nothing about the structure.
    const files = await readMonthFiles(path.join(repoRoot, 'journal'));
    expect(files.length, 'at least one month file exists').toBeGreaterThan(0);
    for (const file of files) {
      expect(file.title, `${file.name} must open with a single \`#\` heading`).not.toBeNull();
      expect(file.entries.length, `${file.name} carries entries`).toBeGreaterThan(0);
      expect(file.strayHeadings, `${file.name}: entries are \`###\`, nothing between`).toEqual([]);
    }
  });

  it('carries the migrated entries rather than losing them', async () => {
    // The canary is the heading of the OLDEST entry in today's `## Journal`, and
    // that is why it was chosen: a partial migration keeps the newest entries
    // and drops the tail, so pinning the newest one would pass on exactly the
    // failure worth catching. It appears exactly once in the repo today.
    const canary = "queues added to this repo's own PLAN.md, brief decomposed";
    const files = await readMonthFiles(path.join(repoRoot, 'journal'));
    expect(
      files.some((f) => f.entries.includes(canary)),
      `no month file carries the entry: ${canary}`,
    ).toBe(true);
    // moved, not copied — a duplicate leaves the bytes in the file the move was
    // supposed to shrink
    expect(await repoPlan()).not.toContain(canary);
  });
});

/**
 * 🔴 A RATCHET, not a red-to-green driver — and the difference is deliberate.
 *
 * AR-64 cuts ~15 KB of prose out of this repo's two queue sections. Most of it
 * is safely cuttable because the same fact is enforced in code and stated
 * elsewhere: the tier marker as a pre-filter is in `loop/SKILL.md` and
 * `queue/state.mjs`, blockers-from-links is in `loop/SKILL.md`, the
 * no-Flowa-copies rule is `CLAUDE.md` rule 0, and the migration map
 * ("34 items → AR-1…AR-34, nothing dropped") is history that belongs in the
 * journal. **That prose was cut on purpose — do not "helpfully" restore it.**
 *
 * The three facts below are the exception the owner ruled on: they exist ONLY
 * here, and until now the only thing protecting them was that somebody read
 * them — which is exactly the property this task removes. They pass today, and
 * that is the correct outcome for a guard whose job is to fail on the cut.
 *
 * One test per fact, not one test for the three: a careless cut usually takes
 * one of them, and a single test would name only the first casualty.
 *
 * Each assertion pins the load-bearing PAIRING inside a passage, never a
 * sentence — see `nearAnchor`. A legitimate rewrite keeps the pairing; a
 * deletion cannot.
 */
describe('three facts stated nowhere else survive the queue-section cut', () => {
  it('says the empty `## Agent queue` heading stays, and why the verdicts are opposite', async () => {
    // Deleting a contentless heading reads as tidying. It is not: `plan-md.mjs`
    // throws on a missing heading and the CLI turns that into `queue-unreadable`
    // / exit 1, while an empty section is `queue-empty` / exit 0 — opposite
    // verdicts from a one-line edit. The mechanism is in the code and tested
    // there; the INSTRUCTION not to delete this particular heading is not.
    //
    // (The current prose adds "Nothing else in this repository states that
    // condition", which is now inaccurate — the code states and enforces it.
    // That overstatement is deliberately NOT pinned; only the instruction is.)
    const plan = await repoPlan();
    const anchor = /queue-unreadable/;
    expect(nearAnchor(plan, anchor, /queue-empty/, 400), 'both verdicts, named together').toBe(
      true,
    );
    expect(nearAnchor(plan, anchor, /heading/i, 400), 'the passage is about the heading').toBe(
      true,
    );
    expect(
      nearAnchor(
        plan,
        anchor,
        /\bstays\b|must not be (deleted|removed)|do not (delete|remove)|not tidying/i,
        400,
      ),
      'and says the heading is kept',
    ).toBe(true);
  });

  it('warns that `AR-n` names two numberings and resolves to the wrong one silently', async () => {
    // Keys on board 34 are Jira issues; the same-looking keys in the port brief
    // and in the journal are the brief's own numbering, which predates the
    // project. Every brief-sense key now also exists as a real ticket, so
    // following a citation lands on an unrelated issue AND NO ERROR — the
    // silent-wrong-answer property is the whole reason this is written down.
    const plan = await repoPlan();
    const anchor = /AR-n|numbering/i;
    expect(nearAnchor(plan, anchor, /brief/i, 600), 'the second sense is named').toBe(true);
    expect(
      nearAnchor(plan, anchor, /(unrelated|different|wrong) (issue|ticket|item)/i, 600),
      'what a reader lands on',
    ).toBe(true);
    expect(
      nearAnchor(plan, anchor, /no error|without an? error|silently|no warning/i, 600),
      'and that it fails silently — the property that makes it dangerous',
    ).toBe(true);
  });

  it('warns that `ready` is a hint no selection path reads, and what filtering on it costs', async () => {
    // A JQL filter on `labels = ready` against a board that does not carry the
    // label returns an empty set, and an empty set with nothing skipped is
    // `queue-empty` — exit 0, a "successful session", with 40 issues open. That
    // is the all-elevated-queue-reports-itself-empty failure in the one shape
    // `nothing-selectable` cannot catch.
    const plan = await repoPlan();
    const anchor = /\bready\b/; // \b keeps "already" out
    expect(nearAnchor(plan, anchor, /selection/i, 600), 'the passage is about selection').toBe(
      true,
    );
    expect(
      nearAnchor(plan, anchor, /(no|not|never|nothing)[^.]{0,60}reads?\b/i, 600),
      'and says selection does not read it',
    ).toBe(true);
    for (const consequence of [/empty set/i, /queue-empty/, /exit 0/i]) {
      expect(
        nearAnchor(plan, anchor, consequence, 600),
        `the cost of trusting it: ${consequence.source}`,
      ).toBe(true);
    }
  });
});
