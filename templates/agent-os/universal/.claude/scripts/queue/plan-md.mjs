// Queue adapter: the Agent queue in PLAN.md.
//
// This is the DEFAULT because it is the only adapter that works the moment a
// project is generated — a fresh project has no remote, no tracker and no CI, and
// a loop that cannot read its queue until someone provisions one is a loop that
// never runs on day one.
//
// 🔴 **Its limit, stated rather than discovered:** a flat list carries no
// dependency links. `blockedBy` is therefore always empty here, which means the
// blocker filter is vacuous — not satisfied, absent. Nothing goes stale either,
// because there is nothing to keep in step; but the moment work in this project
// has real dependencies, move to an adapter whose tracker can express them
// (`github-issues`). Ordering the list by hand is not a dependency graph.
import { readFileSync, writeFileSync } from 'node:fs';
import { fingerprintOf, validateProposal } from './core.mjs';

export const name = 'plan-md';

const AGENT_QUEUE = /^##\s+Agent queue\s*$/im;
const NEXT_HEADING = /^##\s+/m;

/** The Agent queue section's raw body, or '' when the section is absent. */
const agentQueueBody = (plan) => {
  const start = plan.search(AGENT_QUEUE);
  if (start === -1) return '';
  const after = plan.slice(start).replace(AGENT_QUEUE, '');
  const end = after.search(NEXT_HEADING);
  return end === -1 ? after : after.slice(0, end);
};

/**
 * Inline markers, so a flat list can still carry the few facts selection needs.
 * Anything unmarked is a normal, unconditional item — which is the common case
 * and should stay the cheapest thing to write.
 */
const MARKERS = {
  elevated: /\[elevated\]/i,
  triage: /\[triage\]/i,
  triggerAuto: /\[trigger-auto\]/i,
  triggerHuman: /\[trigger-human\]/i,
};

/** Parse the Agent queue into neutral tickets. Order in the file IS the priority. */
export const parsePlan = (plan) => {
  const body = agentQueueBody(String(plan ?? ''));
  // Strip HTML comments first: a fresh project ships the example items commented
  // out, and a loop that picks up the instructions as work is worse than useless.
  const live = body.replace(/<!--[\s\S]*?-->/g, '');

  const items = [];
  for (const line of live.split('\n')) {
    const match = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[1];
    const title = raw
      .replace(/\[(elevated|triage|trigger-auto|trigger-human)\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    items.push({
      id: String(items.length + 1),
      title,
      raw,
      url: null,
      state: 'open',
      labels: [],
      tier: MARKERS.elevated.test(raw) ? 'elevated' : 'normal',
      // No links are expressible in a flat list — see the limit at the top.
      blockedBy: [],
      blocks: [],
      priority: items.length,
      createdAt: null,
      triage: MARKERS.triage.test(raw),
      trigger: MARKERS.triggerAuto.test(raw)
        ? 'auto'
        : MARKERS.triggerHuman.test(raw)
          ? 'human'
          : null,
    });
  }
  return items;
};

/** Remove a closed item's line: a queue states what is next, not what is done. */
export const closeInPlan = (plan, id) => {
  const tickets = parsePlan(plan);
    const target = tickets.find((t) => t.id === String(id));
  if (!target) return plan;
  const lines = String(plan).split('\n');
  const index = lines.findIndex((line) => /^\s*[-*]\s+/.test(line) && line.includes(target.raw));
  if (index === -1) return plan;
  lines.splice(index, 1);
  return lines.join('\n');
};

const planPath = (options) => options?.planPath ?? 'PLAN.md';
const readPlan = (options) => readFileSync(planPath(options), 'utf8');

// --- the adapter contract ------------------------------------------------------

export const listEligible = (options = {}) => parsePlan(readPlan(options));

/** Vacuously empty here, and honestly so — a flat list cannot express a dependency. */
export const resolveBlockers = () => [];

/**
 * There is nothing to claim in a text file that two sessions could both hold, so
 * this returns the instruction instead of pretending to lock. The real isolation
 * for concurrent sessions is a worktree (`.claude/skills/worktree-task`).
 */
export const claim = (ticket) => ({
  ok: true,
  note:
    `PLAN.md cannot express "in progress", so claiming ${ticket.id} is not ` +
    'observable by another session. If a second session may run, take the task in ' +
    'its own worktree and say so in the journal.',
});

export const close = (ticket, { prUrl = null, planPath: p } = {}) => {
  const file = p ?? 'PLAN.md';
  writeFileSync(file, closeInPlan(readFileSync(file, 'utf8'), ticket.id));
  return { ok: true, prUrl };
};

/** A flat list has no comment thread; the journal is where this lands. */
export const comment = (ticket, body) => ({
  ok: false,
  journalInstead: `${ticket.id} — ${body}`,
  why: 'PLAN.md has no comment thread: write it as a journal entry in the same file.',
});

export const escalate = (ticket, diagnosis) => ({
  ok: false,
  journalInstead: `escalated ${ticket.id}: ${diagnosis}`,
  why:
    'PLAN.md has no per-item state, so an escalated item cannot be marked ' +
    'unselectable. Move it to the Operator queue in the same edit, or the next ' +
    'run picks it straight back up.',
});

/**
 * A proposal, forced into triage.
 *
 * 🔴 INVARIANT 2: the agent never creates its own queue items. A proposal is not
 * work — it goes to a state the selection query cannot reach, and promoting it is
 * a human act. Without this, a scheduler plus an improvement loop is a closed
 * circuit that invents and executes its own work.
 */
export const triageItemFor = (proposal) => {
  validateProposal(proposal);
  const fingerprint = fingerprintOf(proposal);
  return {
    title: `proposal: ${proposal.change}`,
    body: [
      `- **finding** — ${proposal.finding}`,
      `- **part to change** — ${proposal.part}`,
      `- **proposed change** — ${proposal.change}`,
      `- **how the next run proves it** — ${proposal.proof}`,
      '',
      `fingerprint: ${fingerprint}`,
      '',
      'The loop proposes; the owner patches. Self-applying a change to its own',
      'rulebook is how an unattended run drifts irreversibly.',
    ].join('\n'),
    labels: ['triage'],
    selectable: false,
    fingerprint,
  };
};

export const proposeTriage = (proposal, { planPath: p } = {}) => {
  const item = triageItemFor(proposal);
  return {
    ok: false,
    item,
    why:
      `PLAN.md has no triage state. Add "${item.title}" to the **Operator queue** ` +
      `of ${p ?? 'PLAN.md'} — never the Agent queue — and keep the fingerprint line ` +
      'so a later run increments it instead of filing a duplicate.',
  };
};
