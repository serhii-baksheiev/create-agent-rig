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
