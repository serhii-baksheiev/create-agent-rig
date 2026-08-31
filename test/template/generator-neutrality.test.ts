import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentOsDir = path.join(repoRoot, 'templates', 'agent-os');

/**
 * RP-67: the artifacts a generated project reads as its own instructions cited
 * this repository's backlog. Counted on `7cecf137`, per file, in the canonical
 * layer: the `loop` skill 11 citations of 9 distinct ids (AR-115, AR-116,
 * AR-117, AR-124, AR-132, AR-135, AR-139, AR-142, AR-144), the `pr-ship` skill
 * 2 of 2 (AR-141, AR-134), and the node-ts stack rule 1 (AR-149, alongside two
 * commit SHAs and two PR numbers of this repository) — 14 citations of 12
 * distinct ids, doubled to 27 by the `.agents` projections. A downstream reader
 * cannot open any of them; the provenance is real and belongs to a tracker they
 * have no access to, so in a generator-neutral artifact it is noise shaped like
 * a reference.
 *
 * ⚠ **Scoped deliberately, and the scope is the point.** This checks the
 * artifacts a generated project is INSTRUCTED BY: the rules and skills of the
 * universal layer and of every stack overlay, in both harnesses' copies. It is
 * NOT a repository-wide ban on the letters `AR` or `RP` — this repository's own
 * docs, journal, decision records and tests name real tickets legitimately, and
 * a global rule would fire on every one of them.
 *
 * Three exclusions, each on a stated ground rather than by omission:
 *
 * - `templates/agent-os/universal/docs/decisions/` — a record's whole job is to
 *   say what happened, and the defect history it carries is why the rule beside
 *   it is worded as it is. What ships as an instruction is held here; what ships
 *   as an explanation of one is not.
 * - the shipped `.claude/scripts/**` and `.claude/hooks/**` — those citations
 *   are code comments addressed to whoever edits the mechanism, not instructions
 *   the agent is told to follow, and they still carry roughly a hundred. Whether
 *   a downstream governance reviewer reads them as the same defect is a live
 *   question and NOT settled here; widening to them is a separate item, not an
 *   oversight this file quietly covers.
 * - `.codex/agents/*.toml` and `templates/agent-os/init/*.md` — a different
 *   format and a different layer. Both are clean today, and neither is guarded
 *   by this scan; `.claude/agents/` and `.agents/` agent specs ARE included
 *   below, because an agent spec is an instruction by the same definition.
 */

/** A tracker identifier: an uppercase project key, a hyphen, a number. */
const TICKET = /\b[A-Z][A-Z0-9]*-\d+\b/g;

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

/**
 * The generator-neutral surface: what a generated project reads as its own
 * instructions. Both harnesses — Claude's `.claude/` tree and the Codex
 * projection under `.agents/` — because a rig receives both.
 */
const neutralSurface = (): string[] =>
  walk(agentOsDir)
    .map((full) => path.relative(repoRoot, full).split(path.sep).join('/'))
    .filter(
      (rel) => /\/(\.claude|\.agents)\/(rules|skills|agents)\//.test(rel) && /\.mdx?$/.test(rel),
    )
    .sort();

describe('the generator-neutral surface names no ticket of this repository', () => {
  it('has a surface to check at all — a scan that found nothing to read is not a pass', () => {
    const files = neutralSurface();
    expect(files.length).toBeGreaterThan(8);
    // both harnesses, or the projection quietly stopped being covered
    expect(files.some((f) => f.includes('/.claude/'))).toBe(true);
    expect(files.some((f) => f.includes('/.agents/'))).toBe(true);
    // and the stack overlays, not only the universal layer
    expect(files.some((f) => f.includes('/stack/'))).toBe(true);
  });

  it('carries no concrete tracker identifier in any rule or skill it ships', () => {
    const offenders: string[] = [];
    for (const rel of neutralSurface()) {
      const text = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        for (const hit of line.match(TICKET) ?? []) offenders.push(`${rel}:${i + 1}  ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not hand a real board name to the queue command as if it were the default', () => {
    const offenders: string[] = [];
    for (const rel of neutralSurface()) {
      const text = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        const hit = /queue\/index\.mjs\s+board\s+(?!<)[A-Z][A-Z0-9]*\b/.exec(line);
        if (hit) offenders.push(`${rel}:${i + 1}  ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is non-vacuous: the pattern catches a real identifier and clears a synthetic placeholder', () => {
    expect('a rule that cites AR-124 for provenance'.match(TICKET)).toEqual(['AR-124']);
    expect('a rule that cites RP-70 for provenance'.match(TICKET)).toEqual(['RP-70']);
    expect('a rule that cites <ticket-id> instead'.match(TICKET)).toBeNull();
    expect('the board is <board-id>'.match(TICKET)).toBeNull();
  });
});
