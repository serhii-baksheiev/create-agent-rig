// RP-180 round 3, prose blocker P8 (rewritten round 4, blocker C): Core-layer
// documents must never instruct or presuppose a workflow-only capability
// without saying so — a Core-only rig following its own rulebook literally
// must never be told to run a command, rely on a skill, or read a file that
// its own install never gave it.
//
// This file scans every Core-layer document for a mention of a
// workflow-layer FILE (its full relative path, or a distinctive basename)
// or a workflow-only SKILL NAME written in backticks (`` `loop` ``,
// `` `pr-ship` ``) — both read from `layers.json` itself, never hand-listed.
// Each mention must sit in a paragraph (or its immediate neighbours — a
// caveat sentence followed by a code example, or a table intro followed by
// its rows, read as one unit to a human) or under a heading that ITSELF
// states the STRICT qualifying phrase, or be on the explicit, reasoned
// allow-list below.
//
// Coverage is PARAGRAPH-level, not sentence-level: an unrelated sentence
// that happens to state the strict phrase in the SAME paragraph as a
// workflow-layer mention counts as covering it, even though it qualifies
// nothing about that specific mention. This is a deliberate looseness — a
// drift guard against a caveat silently disappearing from a paragraph that
// used to have one, not a defence against someone deliberately padding a
// paragraph with the phrase to sneak an unqualified mention past this check.
//
// The strict phrase — `/opt-in workflow layer|--layer workflow|workflow
// layer/` — is deliberately narrower than the bare word "workflow" (round
// 3's predicate). The bare word passed on an incidental citation of
// `.claude/rules/workflow.md` by NAME, or on that file's own H1 ("Workflow —
// TDD, branches, PR policy, Definition of Done", which contains "Workflow"
// and qualifies nothing), so stripping every caveat from `workflow.md`, or
// deleting CLAUDE.md's whole "opt-in workflow layer" section, both stayed
// green. The strict phrase requires an actual qualifying clause, not the
// word appearing anywhere for any reason.
//
// What is OUT of scope, stated rather than silently assumed: a Core `.mjs`
// file's own header comments (this file walks Core `.md`/`.toml` documents
// only — a hook or script's internal comments are not user-facing rulebook
// prose, and `layers-split.test.ts`'s import-graph check already covers the
// one thing that matters for `.mjs` files: that Core code never imports a
// workflow-layer module); and a skill name mentioned WITHOUT backticks (an
// English sentence saying "loop over the items" is not a citation of the
// `loop` skill, and there is no reliable way to tell the two apart short of
// requiring the same backtick convention this rulebook already uses
// everywhere it names a skill on purpose).
//
// What is scanned, and why the composed root copy is separate from the
// rig-facing one: `templates/agent-os/universal/CLAUDE.md` (and `AGENTS.md`)
// ARE scanned directly, by their real path — this is what a GENERATED RIG
// actually receives, and the check that matters for the ticket's own
// acceptance ("Core rulebook must be true for a Core-only rig"). The
// composed root `CLAUDE.md`/`AGENTS.md` (universal plus this repository's
// own addendum) is ALSO scanned, separately, labelled as what it is: this
// repository's OWN dogfood copy, which can introduce its own additional
// mentions the universal source does not have.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');

interface LayersJson {
  process: string[];
  workflow: string[];
}

async function layers(): Promise<LayersJson> {
  return JSON.parse(await readFile(path.join(universalDir, 'layers.json'), 'utf8')) as LayersJson;
}

interface CoreDoc {
  /** How the doc is named in violation messages — includes a `(dogfood copy)`
   *  suffix for the two root-level files, so a reader never mistakes them for
   *  the rig-facing template source. */
  label: string;
  abs: string;
  content: string;
}

/**
 * Every Core document worth scanning: the process array's own .md/.toml
 * entries PLUS the two maps, all read from `templates/agent-os/universal/`
 * (the RIG-FACING set — what a generated Core-only rig actually receives;
 * `CLAUDE.md`/`AGENTS.md` are never IN the `process` array — `init.ts`'s
 * `MAPS` applies them outside the per-layer loop — so they are added here by
 * name, read from the template source directly, labelled by their real
 * path), plus the two COMPOSED maps at the repo root, labelled as this
 * repository's own dogfood copy (universal plus this repo's own addendum,
 * which the universal source alone does not carry).
 */
async function coreDocuments(): Promise<CoreDoc[]> {
  const manifest = await layers();
  const rigFacingRels = [
    ...new Set(manifest.process.filter((rel) => rel.endsWith('.md') || rel.endsWith('.toml'))),
    'CLAUDE.md',
    'AGENTS.md',
  ];
  const docs: CoreDoc[] = [];
  for (const rel of rigFacingRels) {
    const abs = path.join(universalDir, ...rel.split('/'));
    docs.push({ label: rel, abs, content: await readFile(abs, 'utf8') });
  }
  for (const rel of ['CLAUDE.md', 'AGENTS.md']) {
    const abs = path.join(repoRoot, rel);
    docs.push({ label: `${rel} (dogfood copy)`, abs, content: await readFile(abs, 'utf8') });
  }
  return docs;
}

/** `.claude/skills/<name>/…` or `.agents/skills/<name>/…` → `<name>`. */
function skillNameOf(rel: string): string | null {
  const m = /^\.(?:claude|agents)\/skills\/([^/]+)\//.exec(rel);
  return m ? m[1]! : null;
}

/**
 * Basenames excluded from matching: generic enough (a single common noun, no
 * hyphen, reused across unrelated contexts — `core.mjs`, `index.mjs`,
 * `state.mjs`, `checkout.mjs` are exactly the shape a completely unrelated
 * sentence would also contain) that matching them bare would manufacture
 * false positives rather than find real references. Every workflow-layer
 * path is still matched by its FULL relative path regardless of this list —
 * this only narrows the additional, looser basename-alone match.
 */
const GENERIC_BASENAMES = new Set([
  'core.mjs',
  'index.mjs',
  'state.mjs',
  'checkout.mjs',
  'SKILL.md',
]);

/**
 * Explicit, reasoned exceptions — a hit here is never a violation regardless
 * of paragraph coverage. Every entry needs a file, a distinguishing
 * substring of the matched line, and a reason; an entry naming a
 * substring that no longer appears in that file is itself a failure below,
 * so this list cannot silently outlive what it was written for.
 */
// RP-186: the generator addendum is composed into the root AGENTS.md only —
// CLAUDE.md there is a short shim that imports it and carries no addendum
// text of its own, so there is no longer a "CLAUDE.md (dogfood copy)" entry
// to exempt here.
const ALLOWLIST: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  {
    file: 'AGENTS.md (dogfood copy)',
    contains: 'detect-missed-gate` and the `loop` skill here are ahead of the copies',
    reason:
      'this repository\'s own addendum ("Repo-specific rules", item 0), describing THIS ' +
      'generator repo — which dogfoods the workflow layer unconditionally, never a claim ' +
      'about what a generated Core-only rig has (see docs/decisions/workflow-layer-split.md ' +
      'on how sync-agent-os.mjs installs every layer into this repo regardless of the split)',
  },
  {
    file: 'AGENTS.md (dogfood copy)',
    contains: '(`.agents/`, `.codex/`), **`journal/README.md`** and',
    reason:
      'this repository\'s own addendum ("Repo-specific rules", item 5), listing what ' +
      "sync-agent-os.mjs synchronises into THIS repo's own tree — again a statement about " +
      'this always-workflow-ful dogfood repo, not an instruction to a generated rig',
  },
];

interface Hit {
  file: string;
  line: number;
  text: string;
  matched: string;
}

function findHits(rel: string, content: string, needles: string[]): Hit[] {
  const lines = content.split('\n');
  const hits: Hit[] = [];
  lines.forEach((line, i) => {
    for (const needle of needles) {
      if (line.includes(needle)) {
        hits.push({ file: rel, line: i, text: line, matched: needle });
        break;
      }
    }
  });
  return hits;
}

/** The blank-line-delimited block containing `idx`: `[start, end]` inclusive. */
function paragraphBoundsAt(lines: string[], idx: number): [number, number] {
  let start = idx;
  while (start > 0 && lines[start - 1]!.trim() !== '') start -= 1;
  let end = idx;
  while (end < lines.length - 1 && lines[end + 1]!.trim() !== '') end += 1;
  return [start, end];
}

/**
 * The STRICT qualifying phrase — deliberately not the bare word "workflow"
 * (round 3's predicate, which a mere citation of `.claude/rules/workflow.md`
 * or that file's own H1 satisfied for free, and which let stripping every
 * real caveat out of a document stay green). A paragraph, its immediate
 * neighbours, or a heading must contain one of these to count as covered.
 */
const STRICT_WORKFLOW_PHRASE = /opt-in workflow layer|--layer workflow|workflow layer/;

/**
 * Coverage text for a hit at `idx`: its own paragraph plus the immediately
 * preceding and following paragraphs (a caveat sentence followed by a code
 * example, or a table intro followed by its rows, are separate
 * blank-line-delimited blocks that read as one unit to a human). A heading
 * is deliberately NOT included as ambient coverage here — see
 * `headingCoversAt` below, checked separately, and only when the heading
 * ITSELF states the strict phrase (round 4, blocker C: the round-3 version
 * widened to "every ancestor heading, or the whole enclosing section",
 * which is exactly how a real, unqualified mention in
 * `check-premises/SKILL.md` and `worktree-task/SKILL.md` passed unnoticed —
 * a whole section inherits its covering caveat from ONE sentence somewhere
 * in it, which is too coarse a unit to trust here).
 */
function paragraphCoverageTextFor(lines: string[], idx: number): string {
  const [start, end] = paragraphBoundsAt(lines, idx);
  const parts: string[] = [lines.slice(start, end + 1).join('\n')];
  if (start > 0) {
    const [pStart, pEnd] = paragraphBoundsAt(lines, start - 1);
    parts.unshift(lines.slice(pStart, pEnd + 1).join('\n'));
  }
  if (end < lines.length - 1) {
    const [nStart, nEnd] = paragraphBoundsAt(lines, end + 1);
    parts.push(lines.slice(nStart, nEnd + 1).join('\n'));
  }
  return parts.join('\n');
}

/**
 * Whether the nearest heading AT OR ABOVE `idx` itself states the strict
 * phrase — a heading counts only on its own words, never because something
 * elsewhere under it happens to.
 */
function headingCoversAt(lines: string[], idx: number): boolean {
  for (let i = idx; i >= 0; i -= 1) {
    const m = /^#{1,6}\s/.exec(lines[i]!);
    if (m) return STRICT_WORKFLOW_PHRASE.test(lines[i]!);
  }
  return false;
}

async function scan(): Promise<{ hit: Hit; covered: boolean; allowed: boolean }[]> {
  const manifest = await layers();
  const paths = manifest.workflow;
  const basenames = [...new Set(paths.map((p) => path.posix.basename(p)))].filter(
    (b) => !GENERIC_BASENAMES.has(b),
  );
  const skillNames = [...new Set(paths.map(skillNameOf).filter((s): s is string => s !== null))];
  const needles = [...paths, ...basenames, ...skillNames.map((s) => `\`${s}\``)];

  const docs = await coreDocuments();
  const results: { hit: Hit; covered: boolean; allowed: boolean }[] = [];
  for (const { label, content } of docs) {
    const lines = content.split('\n');
    const hits = findHits(label, content, needles);
    for (const hit of hits) {
      const covered =
        STRICT_WORKFLOW_PHRASE.test(paragraphCoverageTextFor(lines, hit.line)) ||
        headingCoversAt(lines, hit.line);
      const allowed = ALLOWLIST.some(
        (entry) =>
          entry.file === label && hit.text.includes(entry.contains) && entry.reason.trim() !== '',
      );
      results.push({ hit, covered, allowed });
    }
  }
  return results;
}

describe('Core-layer documents never presuppose the opt-in workflow layer silently (RP-180 round 4, blocker C)', () => {
  it('every mention of a workflow-layer path or skill, in a Core document, sits in a paragraph or heading stating the strict workflow-layer phrase', async () => {
    const results = await scan();
    const violations = results
      .filter((r) => !r.covered && !r.allowed)
      .map(
        (r) =>
          `${r.hit.file}:${r.hit.line + 1} mentions "${r.hit.matched}" with no qualifying phrase ` +
          `in its paragraph or heading: ${JSON.stringify(r.hit.text.trim())}`,
      );
    expect(violations).toEqual([]);
  });

  // The allow-list itself cannot outlive what it exempts: an entry naming a
  // substring absent from the file it names is a stale exemption, exactly
  // like `doctor.mjs`'s own stale-exemption check.
  it('every allow-list entry still matches something in the file it names', async () => {
    const docs = await coreDocuments();
    const byLabel = new Map(docs.map((d) => [d.label, d.content]));
    const stale = ALLOWLIST.filter(
      (entry) => !(byLabel.get(entry.file) ?? '').includes(entry.contains),
    );
    expect(stale).toEqual([]);
  });

  // Mutations: this suite must have teeth going forward, not only on the
  // fixed sample above. Three documents, three different shapes of removal.
  describe('mutation: stripping a caveat turns the scan red', () => {
    async function scanMutated(label: string, mutatedContent: string): Promise<string[]> {
      const manifest = await layers();
      const basenames = [...new Set(manifest.workflow.map((p) => path.posix.basename(p)))].filter(
        (b) => !GENERIC_BASENAMES.has(b),
      );
      const skillNames = [
        ...new Set(manifest.workflow.map(skillNameOf).filter((s): s is string => s !== null)),
      ];
      const needles = [...manifest.workflow, ...basenames, ...skillNames.map((s) => `\`${s}\``)];
      const lines = mutatedContent.split('\n');
      const hits = findHits(label, mutatedContent, needles);
      return hits
        .filter(
          (hit) =>
            !STRICT_WORKFLOW_PHRASE.test(paragraphCoverageTextFor(lines, hit.line)) &&
            !headingCoversAt(lines, hit.line),
        )
        .map((hit) => `${hit.file}:${hit.line + 1}`);
    }

    // Deletes every line matching the strict phrase itself, wherever it sits
    // in the file — the general shape of "someone stripped every caveat" —
    // rather than a hand-picked substring list that could leave one
    // surviving occurrence (a parenthetical repeating `--layer workflow`)
    // and mask the mutation. Headings that state the phrase are stripped too
    // (`headingCoversAt` would otherwise keep covering everything under a
    // heading whose OWN caveat text this mutation is supposed to remove).
    function stripEveryStrictPhraseLine(content: string): string {
      return content
        .split('\n')
        .filter((line) => !STRICT_WORKFLOW_PHRASE.test(line))
        .join('\n');
    }

    it('autonomy.md: stripping the stop-rule caveat is caught', async () => {
      const docs = await coreDocuments();
      const doc = docs.find((d) => d.label === '.claude/rules/autonomy.md');
      if (!doc) throw new Error('fixture: autonomy.md not found');
      const mutated = stripEveryStrictPhraseLine(doc.content);
      expect(mutated, 'fixture: the mutation must change the text').not.toBe(doc.content);
      expect(mutated).toContain('run-state.mjs');
      const uncovered = await scanMutated(doc.label, mutated);
      expect(uncovered.length, 'mutation must be caught').toBeGreaterThan(0);
    });

    it('workflow.md: stripping the pr-ship layer caveat is caught', async () => {
      const docs = await coreDocuments();
      const doc = docs.find((d) => d.label === '.claude/rules/workflow.md');
      if (!doc) throw new Error('fixture: workflow.md not found');
      const mutated = stripEveryStrictPhraseLine(doc.content);
      expect(mutated, 'fixture: the mutation must change the text').not.toBe(doc.content);
      expect(mutated).toContain('`pr-ship`');
      const uncovered = await scanMutated(doc.label, mutated);
      expect(uncovered.length, 'mutation must be caught').toBeGreaterThan(0);
    });

    // RP-186: AGENTS.md is now the canonical, rig-facing rulebook that
    // carries the "Four things"/elevated-paths prose this mutation targets —
    // CLAUDE.md is a short shim that imports it and states none of these
    // needles itself, so the mutation moved to the file that actually has
    // the text to strip.
    it('AGENTS.md: stripping every workflow-layer caveat is caught (the paths and skill names stay, cited elsewhere in the file)', async () => {
      const docs = await coreDocuments();
      // The rig-facing template source, not the dogfood copy — this is the
      // file a generated rig actually receives, and the one the mutation
      // matters for.
      const doc = docs.find((d) => d.label === 'AGENTS.md');
      if (!doc) throw new Error('fixture: AGENTS.md not found');
      // A single "delete the opt-in workflow layer section" mutation is not
      // enough here: AGENTS.md has SEVERAL independently-qualified mentions
      // (the "Four things"/gitignore item, the elevated-paths intro) whose
      // OWN caveat sits outside that one section, so deleting only that
      // section leaves every remaining mention still covered by its own
      // nearby text — a true negative, not a broken mutation. Stripping
      // every strict-phrase-bearing line, the same general mutation the
      // other two documents use, removes ALL of them at once.
      const mutated = stripEveryStrictPhraseLine(doc.content);
      expect(mutated, 'fixture: the mutation must change the text').not.toBe(doc.content);
      expect(mutated).toContain('.claude/queue.json');
      const uncovered = await scanMutated(doc.label, mutated);
      expect(uncovered.length, 'mutation must be caught').toBeGreaterThan(0);
    });
  });
});
