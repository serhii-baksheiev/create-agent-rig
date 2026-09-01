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
 * Those 27 sit in 5 of the 31 files this scans. The other 26 — the layers' own
 * `CLAUDE.md`, `AGENTS.md`, `PLAN.md` and `journal/README.md` among them — were
 * clean at `7cecf137` already and are scanned so they stay that way, not
 * because they were offenders.
 *
 * ⚠ **Scoped deliberately, and the scope is the point.** This checks the
 * artifacts a generated project is INSTRUCTED BY: every layer's rules, skills
 * and agent specs in both harnesses' copies, plus each layer's own top-level
 * instruction markdown — `CLAUDE.md` first among them, since that is the
 * document a generated rig, and a downstream governance reviewer, reads before
 * any other. It is NOT a repository-wide ban on the letters `AR` or `RP` — this
 * repository's own docs, journal, decision records and tests name real tickets
 * legitimately, and a global rule would fire on every one of them.
 *
 * Four exclusions, each on a stated ground rather than by omission. The list is
 * the guard's claim about its own reach, so it is enumerated against the filter
 * below rather than recalled:
 *
 * - `templates/agent-os/universal/docs/decisions/` — a record's whole job is to
 *   say what happened, and the defect history it carries is why the rule beside
 *   it is worded as it is. What ships as an instruction is held here; what ships
 *   as an explanation of one is not.
 * - the shipped `.claude/scripts/**` and `.claude/hooks/**` — those citations
 *   are code comments addressed to whoever edits the mechanism, not instructions
 *   the agent is told to follow. Counted on `7cecf137` with the same regex this
 *   file scans with: 71 citations of 24 distinct ids across 22 files, unchanged
 *   at this head. Whether a downstream governance reviewer reads them as the
 *   same defect is a live question and NOT settled here; widening to them is a
 *   separate item, not an oversight this file quietly covers.
 * - `.codex/` — TOML, not markdown, so the scan cannot read it as prose. Clean
 *   today and not guarded here. `.claude/agents/` agent specs ARE included,
 *   because an agent spec is an instruction by the same definition; `.agents/`
 *   receives skills only, never agent specs, so it contributes none.
 * - non-markdown assets sitting INSIDE the scanned directories — today
 *   `.claude/skills/new-invariant/guard-invariant.example{,.test}.mjs` and their
 *   `.agents` twins. They are code a project copies, not prose it follows, and
 *   they are clean today. The `/\.mdx?$/` test below is what excludes them, and
 *   this bullet is why.
 *
 * `templates/agent-os/init/*.md` was on this list and is NOT an exclusion any
 * more: it is markdown, and it is the `CLAUDE.md` an `init`-installed rig
 * receives, so it is scanned.
 */

/**
 * The backlog namespaces of THIS repository, owned by this test and listed
 * rather than inferred.
 *
 * 🔴 **Deliberately not the lexical shape `KEY-123`.** That shape also fits
 * `RFC-3339`, `SHA-256` and `UTF-8` — identifiers a generator-neutral document
 * may name legitimately — so a guard built on the shape rejects honest work and
 * gets turned off. The invariant RP-67 states is about *this repository's
 * backlog leaking downstream*, and that is what the set names. A new board here
 * gains a key on this line; nothing else changes.
 */
const BACKLOG_KEYS = ['AR', 'RP'];
const TICKET = new RegExp(String.raw`\b(?:${BACKLOG_KEYS.join('|')})-\d+\b`, 'g');

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
 *
 * Two shapes, because a rig is instructed by two:
 *
 * 1. the rules, skills and agent specs of every layer, in both harness trees;
 * 2. the **top-level instruction markdown of each layer** — `CLAUDE.md`,
 *    `AGENTS.md`, `PLAN.md`, `journal/README.md`, and the `init` layer's own
 *    `CLAUDE.md`/`AGENTS.md`. The first of those is the document a generated
 *    rig reads before any other, so a scan that skipped it would open every
 *    file except the one a downstream reviewer opens first.
 */
const neutralSurface = (): string[] =>
  walk(agentOsDir)
    .map((full) => path.relative(repoRoot, full).split(path.sep).join('/'))
    .filter(
      (rel) =>
        (/\/(\.claude|\.agents)\/(rules|skills|agents)\//.test(rel) ||
          // a layer's own instruction markdown, at the layer root or one
          // directory under it, but never inside a harness tree or docs/
          /^templates\/agent-os\/(universal|init|stack\/[^/]+)\/([^/]+\/)?[^/]+\.mdx?$/.test(
            rel,
          )) &&
        !/\/(docs|\.codex)\//.test(rel) &&
        /\.mdx?$/.test(rel),
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
    // and each layer's own top-level instruction markdown — named one by one,
    // because "the surface is non-empty" would still hold if the widening that
    // brought these in were reverted, and that is exactly how a guard goes back
    // to opening every file except the one read first.
    for (const rel of [
      'templates/agent-os/universal/CLAUDE.md',
      'templates/agent-os/universal/AGENTS.md',
      'templates/agent-os/universal/PLAN.md',
      'templates/agent-os/universal/journal/README.md',
      'templates/agent-os/init/CLAUDE.md',
      'templates/agent-os/init/AGENTS.md',
    ]) {
      expect(files, `${rel} is instruction a rig receives`).toContain(rel);
    }
    // the stated exclusions really are excluded, or the list above is prose
    expect(files.some((f) => f.includes('/docs/decisions/'))).toBe(false);
    expect(files.some((f) => f.includes('/.claude/scripts/'))).toBe(false);
    expect(files.some((f) => f.includes('/.claude/hooks/'))).toBe(false);
    expect(files.some((f) => f.includes('/.codex/'))).toBe(false);
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

  it('is non-vacuous: catches this backlog, and clears placeholders and same-shaped standards', () => {
    expect('a rule that cites AR-124 for provenance'.match(TICKET)).toEqual(['AR-124']);
    expect('a rule that cites RP-70 for provenance'.match(TICKET)).toEqual(['RP-70']);
    expect('a rule that cites <ticket-id> instead'.match(TICKET)).toBeNull();
    expect('the board is <board-id>'.match(TICKET)).toBeNull();
    // and legitimate identifiers of the same lexical shape stay allowed: the
    // guard names this repository's backlog, it does not own the shape.
    expect('timestamps are RFC-3339'.match(TICKET)).toBeNull();
    expect('digests are SHA-256 and text is UTF-8'.match(TICKET)).toBeNull();
  });
});
