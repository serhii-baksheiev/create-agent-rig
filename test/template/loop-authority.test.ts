// RP-342: a new controller session must be able to start the loop with a
// declared decision authority, recover the active workflow from durable
// evidence rather than conversational memory, and resolve a per-item stop
// (RP-341's `ITEM_STOPS`) through the one authority contract (RP-339) and
// its durable-evidence CLI (RP-340's `delegated-decision.mjs`) — all without
// a daemon, a background scheduler, or a private controller-to-controller
// state service.
//
// This file pins the PROSE side of that integration: what the `loop` skill
// (`templates/agent-os/universal/.claude/skills/loop/SKILL.md`) says, in the
// sections where a session reading it top-to-bottom would need it — launch
// (§1), per-item escalation (§6), and cold-start/resume. The CLI side (the
// new `resolve` subcommand of `delegated-decision.mjs`) is pinned in
// `delegated-decision.test.ts` instead, next to the rest of that CLI.
//
// The §6 <-> ITEM_STOPS correspondence check mirrors the shape in
// `correspondence.test.ts` (one source, checked in both directions, each
// direction proved by a mutation on an IN-MEMORY copy — never a mutated
// file) rather than restating that file's helpers.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const skillPath = path.join(universalDir, '.claude', 'skills', 'loop', 'SKILL.md');
const stopClassPath = path.join(universalDir, '.claude', 'scripts', 'queue', 'stop-class.mjs');
const decisionAuthorityDocPath = path.join(
  universalDir,
  'docs',
  'decisions',
  'decision-authority.md',
);

interface StopClassModule {
  ITEM_STOPS: ReadonlyArray<{ id: string; stopClass: string; decision: string | null }>;
}

const loadStopClass = (): Promise<StopClassModule> =>
  import(pathToFileURL(stopClassPath).href) as Promise<StopClassModule>;

/** The text strictly between (and not including) two markers, each matched by substring. */
const sectionBetween = (content: string, startMarker: string, endMarker: string): string => {
  const start = content.indexOf(startMarker);
  expect(start, `"${startMarker}" must exist in the file`).toBeGreaterThan(-1);
  const end = content.indexOf(endMarker, start + startMarker.length);
  expect(end, `"${endMarker}" must exist after "${startMarker}"`).toBeGreaterThan(start);
  return content.slice(start, end);
};

/**
 * The text between the line STARTING WITH `startPrefix` and the next line
 * starting with `endPrefix` — matched at line-start rather than against a
 * full heading string, so a future rewording of the heading text itself does
 * not retitle what this helper locates.
 */
const sectionByLinePrefix = (content: string, startPrefix: string, endPrefix: string): string => {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line.startsWith(startPrefix));
  expect(startIndex, `no line starts with "${startPrefix}"`).toBeGreaterThan(-1);
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.startsWith(endPrefix),
  );
  expect(endIndex, `no line after "${startPrefix}" starts with "${endPrefix}"`).toBeGreaterThan(
    startIndex,
  );
  return lines.slice(startIndex, endIndex).join('\n');
};

/**
 * §6.0 itself, bounded by its own heading and the next heading line of
 * either level (`## ` or `### `) — §6 carries other `###` subsections after
 * 6.0, so "all of §6" is not the same span as "just §6.0".
 */
const section60Only = (content: string): string => {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line.startsWith('### 6.0'));
  expect(startIndex, 'no line starts with "### 6.0"').toBeGreaterThan(-1);
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && (line.startsWith('## ') || line.startsWith('### ')),
  );
  expect(endIndex, 'no heading line follows "### 6.0"').toBeGreaterThan(startIndex);
  return lines.slice(startIndex, endIndex).join('\n');
};

describe('loop skill §1 — launching and declaring the run authority', () => {
  it('names the --unattended and --decision-authority launch intent', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section1 = sectionBetween(content, '## 1. Preflight', '## 2. Selection');
    expect(section1).toContain('--unattended');
    expect(section1).toContain('--decision-authority <owner|delegated>');
  });

  it('shows preflight run with --decision-authority on the same command line', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section1 = sectionBetween(content, '## 1. Preflight', '## 2. Selection');
    expect(section1).toMatch(/node \.claude\/scripts\/preflight\.mjs[^\n]*--decision-authority/);
  });

  it('shows "run-state.mjs authority" AFTER the run directory is first declared', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section1 = sectionBetween(content, '## 1. Preflight', '## 2. Selection');
    const runDirIndex = section1.indexOf('RIG_RUN_DIR=');
    expect(runDirIndex, 'the run directory must be declared somewhere in §1').toBeGreaterThan(-1);
    const authorityIndex = section1.indexOf('run-state.mjs authority');
    expect(authorityIndex, '"run-state.mjs authority" must appear in §1').toBeGreaterThan(-1);
    expect(
      authorityIndex,
      'declaring the authority before the run directory exists leaves it with nowhere to be written',
    ).toBeGreaterThan(runDirIndex);
  });
});

describe('loop skill §3 — what keeps the loop running references §6.0', () => {
  it('names §6.0 between "## 3. What keeps the loop running" and "## 4. Budget"', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section3 = sectionBetween(content, '## 3. What keeps the loop running', '## 4. Budget');
    expect(section3).toContain('§6.0');
  });
});

describe('loop skill §6 — resolving a per-item stop through the authority contract', () => {
  it('names the resolve and record commands, and all three resolution words', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section6 = sectionBetween(content, '## 6. Escalation', '## 6a.');
    expect(section6).toContain('delegated-decision.mjs resolve --stop');
    expect(section6).toContain('delegated-decision.mjs record');
    expect(section6).toContain('decide-and-continue');
    expect(section6).toContain('escalate-item');
    expect(section6).toContain('stop-run');
  });

  it('states that a decide-and-continue resolution does not escalate the item', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section6 = sectionBetween(content, '## 6. Escalation', '## 6a.');
    // Precise but not brittle: "decide-and-continue", then within 200
    // characters (no sentence boundary enforced, since the clause may itself
    // span a comma or an em dash) a negation word, then "escalat(e/ion/ing)"
    // — in either order relative to the negation, which is why the second
    // alternative covers "never escalates ... after a decide-and-continue"
    // phrasing too.
    const NEGATED_ESCALATION =
      /decide-and-continue[^.]{0,200}(?:not|never)[^.]{0,200}escalat|(?:not|never)[^.]{0,200}escalat[^.]{0,200}decide-and-continue/i;
    expect(section6).toMatch(NEGATED_ESCALATION);
  });

  it('on a non-zero record exit, tells the run to read delegated-decision.mjs list --ticket before deciding whether the decision was made', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section6 = sectionBetween(content, '## 6. Escalation', '## 6a.');
    // Paragraph-scoped (split on a blank line) rather than "found anywhere in
    // §6", so the two clauses are pinned as one coherent instruction rather
    // than two words that merely both occur somewhere in the section.
    const paragraphs = section6.split(/\n\s*\n/);
    const paragraph = paragraphs.find(
      (p) => /exits non-zero/i.test(p) && p.includes('list --ticket'),
    );
    expect(
      paragraph,
      'no paragraph in §6 ties a non-zero `record` exit to reading `delegated-decision.mjs list --ticket` before deciding whether the decision was made',
    ).toBeTruthy();
  });

  it('ties elevated-path-scope to the merge: human-review names the same paragraph, table row, or §6.0 subsection', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section6 = sectionBetween(content, '## 6. Escalation', '## 6a.');
    // §6.0 is the subsection the stop table itself lives in. §6 carries no
    // other `#`-heading after it (checked: only "### 6.0" appears between
    // "## 6. Escalation" and "## 6a."), so §6.0 runs from its own heading to
    // the end of §6 — there is nothing else to bound it against.
    const section60Start = section6.indexOf('### 6.0');
    expect(section60Start, '"### 6.0" must exist in §6').toBeGreaterThan(-1);
    const section60 = section6.slice(section60Start);
    const paragraphs = section60.split(/\n\s*\n/);
    const sameParagraph = paragraphs.find(
      (p) => p.includes('elevated-path-scope') && p.includes('human-review'),
    );
    const sameTableRow = section60
      .split('\n')
      .find(
        (line) =>
          line.trim().startsWith('|') &&
          line.includes('elevated-path-scope') &&
          line.includes('human-review'),
      );
    expect(
      Boolean(sameParagraph) || Boolean(sameTableRow),
      '§6.0 must name human-review in the same paragraph or table row as elevated-path-scope',
    ).toBe(true);
  });

  it('every ITEM_STOPS id is named in the §6 stop table, and vice versa', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section6 = sectionBetween(content, '## 6. Escalation', '## 6a.');
    const { ITEM_STOPS } = await loadStopClass();
    const moduleIds = ITEM_STOPS.map((s) => s.id);
    const tableIds = tableIdsIn(section6);
    expect(stopsCorrespondence(moduleIds, tableIds)).toEqual({ unmentioned: [], unknown: [] });
  });

  it('reports a table id the module does not know (mutation: extra table id, in-memory only)', async () => {
    const { ITEM_STOPS } = await loadStopClass();
    const moduleIds = ITEM_STOPS.map((s) => s.id);
    const mutatedTableIds = [...moduleIds, 'made-up-stop-id'];
    expect(stopsCorrespondence(moduleIds, mutatedTableIds).unknown).toEqual(['made-up-stop-id']);
  });

  it('reports a module id the table does not mention (mutation: extended ITEM_STOPS, in-memory only)', async () => {
    const { ITEM_STOPS } = await loadStopClass();
    const moduleIds = ITEM_STOPS.map((s) => s.id);
    const mutatedModuleIds = [...moduleIds, 'made-up-stop-id-2'];
    // The "table" side here is the real module ids on purpose, isolating the
    // mutation to the module side alone — never a file read, and never a
    // mutation of the real table (which this suite never writes to).
    expect(stopsCorrespondence(mutatedModuleIds, moduleIds).unmentioned).toEqual([
      'made-up-stop-id-2',
    ]);
  });
});

/** The `` `<id>` `` cells inside markdown-table rows (lines starting with `|`) in `section`. */
function tableIdsIn(section: string): string[] {
  const ids = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    for (const match of line.matchAll(/`([a-z][a-z0-9-]*)`/g)) {
      ids.add(match[1]!);
    }
  }
  return [...ids];
}

/** Names the offenders in either direction; empty on full correspondence. */
function stopsCorrespondence(
  moduleIds: string[],
  tableIds: string[],
): { unmentioned: string[]; unknown: string[] } {
  return {
    unmentioned: moduleIds.filter((id) => !tableIds.includes(id)),
    unknown: tableIds.filter((id) => !moduleIds.includes(id)),
  };
}

describe('loop skill — cold start / resume reads durable evidence, not memory', () => {
  it('names delegated-decision.mjs list --ticket --json, and applies a recorded decision rather than re-asking', async () => {
    const content = await readFile(skillPath, 'utf8');
    // Searched over the WHOLE file deliberately: the cold-start/resume
    // guidance is not assumed to land in any one numbered section.
    const paragraphs = content.split(/\n\s*\n/);
    const paragraph = paragraphs.find(
      (p) => p.includes('delegated-decision.mjs list --ticket') && p.includes('--json'),
    );
    expect(
      paragraph,
      'no paragraph names delegated-decision.mjs list --ticket with --json',
    ).toBeTruthy();
    // "applied rather than re-asked": a recorded decision is used as-is, not
    // put back to the (possibly absent) owner. Matches e.g. "already made",
    // "applied", "is not re-asked", "rather than asking again" — documented
    // here because the wording is this test's own choice, not a quoted
    // contract.
    const APPLIED_NOT_REASKED =
      /(appl(?:y|ied|ies)|already\s+made|reuse[sd]?)[^.]{0,200}(?:rather than|instead of|not|never)[^.]{0,200}(?:re-?ask|ask(?:ing)?\s+again)/i;
    expect(paragraph!).toMatch(APPLIED_NOT_REASKED);
  });
});

describe('docs/decisions/decision-authority.md — the loop-integration follow-up is no longer deferred', () => {
  it('the Consequences section no longer lists "how the loop starts and resumes" as separate future work', async () => {
    const content = await readFile(decisionAuthorityDocPath, 'utf8');
    const idx = content.indexOf('## Consequences');
    expect(idx, '## Consequences must exist').toBeGreaterThan(-1);
    const consequences = content.slice(idx);
    // Whitespace-tolerant: the prose wraps at ~80 columns, so the literal
    // phrase spans a line break in the source ("...the loop starts and\n
    // resumes under a declared authority...").
    expect(consequences).not.toMatch(/loop\s+starts\s+and\s+resumes/);
  });
});

// RP-312 gate round 3: the commit instruction belongs next to
// `.rig/claims/<item-id>.json`'s own commit instruction in §2 — the point
// selection itself already tells a resuming session to commit a durable
// record — not inside §6.0's per-stop resolution text, which is read only
// once a stop has actually fired and never on the ordinary cold-start/resume
// path this instruction has to survive. `.rig/evidence/<ticket>.jsonl` is
// written by `evidence-attach.mjs` the same way `.rig/claims/` and
// `.rig/decisions/` are, and a resume on another machine has nothing to read
// from any of them unless each is committed.
describe('loop skill §2 — the evidence record is committed alongside the claim baseline', () => {
  const COMMIT_EVIDENCE = /[Cc]ommit[^\n]{0,120}\.rig\/evidence\//;

  it('names .rig/evidence/<ticket>.jsonl in a commit instruction, in §2 next to .rig/claims/', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section2 = sectionByLinePrefix(content, '## 2.', '## 3.');
    expect(section2).toMatch(COMMIT_EVIDENCE);
    expect(section2).toContain('.rig/claims/');
  });

  it('never carries the .rig/evidence/ commit instruction inside §6.0 — a stop-resolution section a cold-start/resume never reads', async () => {
    const content = await readFile(skillPath, 'utf8');
    const section60 = section60Only(content);
    expect(section60).not.toMatch(COMMIT_EVIDENCE);
  });
});
