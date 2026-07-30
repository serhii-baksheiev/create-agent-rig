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

const AGENT_QUEUE = /^##\s+Agent queue\s*$/i;
const ANY_HEADING = /^##\s+/;

/**
 * Locate the Agent queue by LINE RANGE, and say whether it was found at all.
 *
 * "No such heading" and "heading present, nothing under it" used to collapse into
 * the same empty string, so a renamed heading or a bad merge read as a legitimately
 * empty queue — reported as a successful end of session. They are different
 * answers and only one of them is good news.
 */
export const readQueue = (plan) => {
  const lines = String(plan ?? '').split('\n');
  const start = lines.findIndex((line) => AGENT_QUEUE.test(line));
  if (start === -1) return { found: false, lines, start: -1, end: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ANY_HEADING.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { found: true, lines, start: start + 1, end };
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

/**
 * Parse the Agent queue into neutral tickets. Order in the file IS the priority.
 *
 * Each ticket records the **physical line** it came from, and that — not its text
 * — is what identifies it for a later write.
 */
export const parsePlan = (plan) => {
  const { found, lines, start, end } = readQueue(plan);
  if (!found) return [];

  const items = [];
  let inComment = false;
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    // A fresh project ships its example items commented out, and a loop that
    // picks up the instructions as work is worse than useless.
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }

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
      line: index, // the identity a write uses — never the text
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

/**
 * Remove a closed item's line: a queue states what is next, not what is done.
 *
 * Deletes the recorded line index, which is inside the Agent queue by
 * construction. The previous version searched the whole file for a line
 * *containing* the item's text and deleted the first hit — so an item whose title
 * was a prefix of another silently destroyed the wrong entry, and a human's
 * Operator-queue line could be destroyed instead. Verified: closing item 2 of
 * ["fix the parser bug in edge cases", "fix the parser"] deleted item 1.
 */
export const closeInPlan = (plan, id) => {
  const target = parsePlan(plan).find((ticket) => ticket.id === String(id));
  if (!target) return plan;
  const lines = String(plan).split('\n');
  lines.splice(target.line, 1);
  return lines.join('\n');
};

const planPath = (options) => options?.planPath ?? 'PLAN.md';
const readPlan = (options) => readFileSync(planPath(options), 'utf8');

// --- the adapter contract ------------------------------------------------------

/**
 * Throws when the Agent queue section is absent, rather than returning [].
 *
 * A renamed heading or a bad merge is a queue that cannot be read — and the CLI
 * turns that into `queue-unreadable`, not into the `queue-empty` success that a
 * genuinely empty section produces. Collapsing the two meant a structural bug in
 * PLAN.md was reported as "a legitimate end of session".
 */
export const listEligible = (options = {}) => {
  const plan = readPlan(options);
  if (!readQueue(plan).found) {
    throw new Error(
      `${planPath(options)} has no "## Agent queue" heading, so the queue cannot be ` +
        'read. That is a structural problem in the file, not an empty queue — fix ' +
        'the heading rather than treating this as a finished session.',
    );
  }
  return parsePlan(plan);
};

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
    // The `[triage]` marker is load-bearing, not decoration: plan-md has no
    // persisted label field, so placement under the Operator queue used to be the
    // ONLY thing keeping a proposal unselectable. With the marker in the title, a
    // proposal pasted under the wrong heading is still refused by `selectionOf` —
    // the same belt and braces the other two adapters get from a real label.
    title: `proposal: ${proposal.change} [triage]`,
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
