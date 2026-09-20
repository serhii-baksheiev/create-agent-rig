// RP-180 round 3, prose blocker P8: seven Core-layer documents instructed or
// presupposed a workflow-only capability without saying so — a Core-only rig
// following its own rulebook literally would run a command
// (`run-state.mjs`), rely on a skill (`loop`, `pr-ship`) or read a file
// (`journal/README.md`) that install never gave it. The dangling-reference
// check that already existed (`test/template/init-layer.test.ts`) only
// scanned `.claude/…` paths inside CLAUDE.md — none of the seven blockers
// were paths under `.claude/` inside CLAUDE.md specifically, so nothing
// caught them.
//
// This file is the mechanical check for the general shape: every Core
// document, scanned for a mention of a workflow-layer FILE or a
// workflow-only SKILL NAME, each mention required to sit in a paragraph (or
// under the nearest heading above it) that names the workflow layer, or to
// be on the explicit, reasoned allow-list below.
//
// What counts as "the workflow layer" or a "workflow-only skill name" is
// read from `layers.json` itself, never hand-listed here — the closed set
// this file's own `layers-split.test.ts` already pins. What counts as
// "named" is a structural check (does the covering paragraph/heading contain
// the word "workflow"), independent of whatever the prose being scanned
// happens to say — this file does not trust the documents it is checking to
// grade themselves.
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

/** Every Core document worth scanning: the process array's own .md/.toml
 *  entries, plus the two composed maps (never in the array — `init.ts`'s
 *  `MAPS` applies them outside the per-layer loop) and PLAN.md (already in
 *  the array, restated here only because the ticket names it explicitly). */
async function coreDocuments(): Promise<Array<{ rel: string; content: string }>> {
  const manifest = await layers();
  const rels = new Set(
    manifest.process.filter((rel) => rel.endsWith('.md') || rel.endsWith('.toml')),
  );
  rels.add('CLAUDE.md');
  rels.add('AGENTS.md');
  const docs: Array<{ rel: string; content: string }> = [];
  for (const rel of rels) {
    // CLAUDE.md/AGENTS.md are read from the repo root — the COMPOSED
    // artifact (universal + this repo's own addendum) is what a reader (and
    // a generated rig) actually receives; the universal source alone would
    // miss anything the addendum itself introduces.
    const base = rel === 'CLAUDE.md' || rel === 'AGENTS.md' ? repoRoot : universalDir;
    docs.push({ rel, content: await readFile(path.join(base, ...rel.split('/')), 'utf8') });
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
const ALLOWLIST: ReadonlyArray<{ file: string; contains: string; reason: string }> = [];

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
 * The active heading breadcrumb at `idx` — the most recent heading line seen
 * at each level (1–6) while scanning from the top of the file, so a mention
 * deep under an H3 is still "covered" by an ancestor H1/H2 that names the
 * workflow layer, exactly the way a reader treats a document's own title as
 * governing everything under it.
 */
function activeHeadingsAt(lines: string[], idx: number): string[] {
  const stack: Array<string | null> = new Array(7).fill(null);
  for (let i = 0; i < idx; i += 1) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (m) {
      const level = m[1]!.length;
      stack[level] = lines[i]!;
      for (let l = level + 1; l <= 6; l += 1) stack[l] = null;
    }
  }
  return stack.filter((s): s is string => s !== null);
}

/**
 * The nearest heading AT OR ABOVE `idx`, and the body of the section it
 * opens — from that heading down to the next heading of the same or a
 * shallower level (exclusive), or end of file. A section that states its
 * workflow-layer caveat ONCE, near the top, and then writes the rest of the
 * section as though the layer is present (exactly the shape
 * `autonomy.md`'s "gate is swept from outside" section and
 * `review-lanes.md`'s router tables use) is covered throughout — a
 * per-paragraph requirement would force the same sentence repeated many
 * times over for no gain in what a reader actually learns.
 */
function sectionTextFor(lines: string[], idx: number): string {
  let headingIdx = -1;
  let headingLevel = 7;
  for (let i = idx; i >= 0; i -= 1) {
    const m = /^(#{1,6})\s/.exec(lines[i]!);
    if (m) {
      headingIdx = i;
      headingLevel = m[1]!.length;
      break;
    }
  }
  if (headingIdx === -1) return '';
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s/.exec(lines[i]!);
    if (m && m[1]!.length <= headingLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(headingIdx, end).join('\n');
}

/**
 * Coverage text for a hit at `idx`: its own paragraph plus the immediately
 * preceding and following paragraphs (a caveat sentence followed by a code
 * example, or a table intro followed by its rows, are separate
 * blank-line-delimited blocks that read as one unit to a human), every
 * active heading above it, and the enclosing section's own body (see
 * {@link sectionTextFor}). A mention is "covered" when this text names the
 * workflow layer anywhere.
 */
function coverageTextFor(lines: string[], idx: number): string {
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
  return [...activeHeadingsAt(lines, idx), sectionTextFor(lines, idx), ...parts].join('\n');
}

const WORKFLOW_MENTION = /workflow/i;

async function scan(): Promise<{ hit: Hit; covered: boolean; allowed: boolean }[]> {
  const manifest = await layers();
  const paths = manifest.workflow;
  const basenames = [...new Set(paths.map((p) => path.posix.basename(p)))].filter(
    (b) => !GENERIC_BASENAMES.has(b),
  );
  const skillNames = [...new Set(paths.map(skillNameOf).filter((s): s is string => s !== null))];
  const pathNeedles = paths;
  const basenameNeedles = basenames;
  const skillNeedles = skillNames.map((s) => `\`${s}\``);
  const needles = [...pathNeedles, ...basenameNeedles, ...skillNeedles];

  const docs = await coreDocuments();
  const results: { hit: Hit; covered: boolean; allowed: boolean }[] = [];
  for (const { rel, content } of docs) {
    const lines = content.split('\n');
    const hits = findHits(rel, content, needles);
    for (const hit of hits) {
      const coverage = coverageTextFor(lines, hit.line);
      const covered = WORKFLOW_MENTION.test(coverage);
      const allowed = ALLOWLIST.some(
        (entry) =>
          entry.file === rel && hit.text.includes(entry.contains) && entry.reason.trim() !== '',
      );
      results.push({ hit, covered, allowed });
    }
  }
  return results;
}

describe('Core-layer documents never presuppose the opt-in workflow layer silently (RP-180 round 3, P8)', () => {
  it('every mention of a workflow-layer path or skill, in a Core document, sits in a paragraph or heading naming the workflow layer', async () => {
    const results = await scan();
    const violations = results
      .filter((r) => !r.covered && !r.allowed)
      .map(
        (r) =>
          `${r.hit.file}:${r.hit.line + 1} mentions "${r.hit.matched}" with no "workflow" in its ` +
          `paragraph or heading: ${JSON.stringify(r.hit.text.trim())}`,
      );
    expect(violations).toEqual([]);
  });

  // The allow-list itself cannot outlive what it exempts: an entry naming a
  // substring absent from the file it names is a stale exemption, exactly
  // like `doctor.mjs`'s own stale-exemption check.
  it('every allow-list entry still matches something in the file it names', async () => {
    const docs = await coreDocuments();
    const byFile = new Map(docs.map((d) => [d.rel, d.content]));
    const stale = ALLOWLIST.filter(
      (entry) => !(byFile.get(entry.file) ?? '').includes(entry.contains),
    );
    expect(stale).toEqual([]);
  });

  // Mutation: this suite must have teeth going forward, not only on the
  // fixed sample above. Strip the layer caveat back out of one already-fixed
  // paragraph and confirm the scan reports it.
  it('mutation: removing a caveat from an already-fixed paragraph turns the scan red', async () => {
    const docs = await coreDocuments();
    const autonomy = docs.find((d) => d.rel === '.claude/rules/autonomy.md');
    if (!autonomy) throw new Error('fixture: autonomy.md not found among Core documents');
    // Strip exactly the qualifier this round added, leaving the bare
    // unconditional mention `run-state.mjs` behind — the pre-fix shape. Line
    // by line rather than one big regex, so a rewording of the surrounding
    // prose (which does not touch these exact lines) cannot silently make
    // this mutation a no-op.
    const linesIn = autonomy.content.split('\n');
    const mutatedLines = linesIn.filter(
      (line) =>
        !line.includes('**With the opt-in workflow layer installed**') &&
        !line.includes('`run-state.mjs` ships only with it') &&
        !line.includes('both words also get recorded as a mechanical verdict:') &&
        !line.includes('Without the layer, there is no automated selection to gate') &&
        !line.includes('verify-then-revert rule still applies'),
    );
    const mutated = mutatedLines.join('\n');
    expect(mutated, 'fixture: the mutation must actually change the text').not.toBe(
      autonomy.content,
    );
    expect(mutated).toContain('run-state.mjs');
    // The specific bullet's own paragraph, post-mutation, no longer carries
    // the qualifier — checked on the bullet's paragraph alone, since the
    // unrelated (and unmutated) "Post-deploy verification" section further
    // down the same file legitimately still says "workflow layer" and would
    // otherwise make this assertion pass for the wrong reason.
    const mutatedLinesArr = mutated.split('\n');
    const bulletIdx = mutatedLinesArr.findIndex((l) => l.includes('run-state.mjs'));
    expect(
      bulletIdx,
      'fixture: run-state.mjs must still appear post-mutation',
    ).toBeGreaterThanOrEqual(0);
    expect(coverageTextFor(mutatedLinesArr, bulletIdx)).not.toMatch(
      /opt-in workflow layer|--layer workflow/,
    );

    const manifest = await layers();
    const basenames = [...new Set(manifest.workflow.map((p) => path.posix.basename(p)))].filter(
      (b) => !GENERIC_BASENAMES.has(b),
    );
    const lines = mutated.split('\n');
    const hits = findHits('.claude/rules/autonomy.md', mutated, [
      ...manifest.workflow,
      ...basenames,
    ]);
    const uncovered = hits.filter(
      (hit) => !WORKFLOW_MENTION.test(coverageTextFor(lines, hit.line)),
    );
    expect(uncovered.length, 'mutation must be caught').toBeGreaterThan(0);
  });
});
