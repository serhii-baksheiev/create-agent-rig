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
import { duplicateOf, fingerprintOf, validateProposal } from './core.mjs';
import { recordEscalation } from '../run-state.mjs';

export const name = 'plan-md';

const AGENT_QUEUE = /^##\s+Agent queue\s*$/i;
const OPERATOR_QUEUE = /^##\s+Operator queue\s*$/i;
const ANY_HEADING = /^##\s+/;

/**
 * Locate a `## ` section by LINE RANGE, and say whether it was found at all.
 *
 * "No such heading" and "heading present, nothing under it" used to collapse into
 * the same empty string, so a renamed heading or a bad merge read as a legitimately
 * empty queue — reported as a successful end of session. They are different
 * answers and only one of them is good news.
 *
 * Parameterised by heading because there are now two callers and the alternative
 * was a second copy of this scan — and two implementations of one mechanism
 * disagree eventually, with the unwatched one being the wrong one
 * (`invariants.md`). The Agent-queue caller keeps its own name below.
 */
const sectionRange = (plan, heading) => {
  const lines = String(plan ?? '').split('\n');
  const start = lines.findIndex((line) => heading.test(line));
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

export const readQueue = (plan) => sectionRange(plan, AGENT_QUEUE);

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
      // 🔴 `null`, not `''`: a flat list has no per-item body, and the hygiene
      // checks must read that as "this adapter cannot answer" rather than
      // "checked, found nothing". An empty string would silently turn a blind
      // spot into a clean bill of health. `raw` above is the line itself, kept
      // for writes — it is not a body and core does not read it as one.
      body: null,
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

// 🔴 The bare default is cwd-relative on purpose, and that is a contract rather
// than an oversight. This module is imported directly as well as driven by the
// CLI, and a direct caller's cwd is the only project it can mean. The CLI, which
// knows where its config lives, supplies an absolute `planPath` instead — see
// `optionsWithPlanPath` in `index.mjs`. Resolving this default from the module's
// own location would point every call at the rig's own tree; the behaviour is
// pinned by queue.test.ts › "never resolves that default from its own location on
// disk".
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
  why: 'PLAN.md has no comment thread: write it as a journal entry in journal/YYYY-MM.md for the current month.',
});

export const escalate = (ticket, diagnosis, { env = process.env } = {}) => {
  // The count is recorded even though this adapter cannot mark the item: the two
  // are different facts. "This queue has no per-item state" is a plan-md limit;
  // "two tasks in a row hit a wall" is about the run, and it must stop the run
  // whichever tracker it is reading.
  recordEscalation(env.RIG_RUN_DIR);
  return {
    ok: false,
    journalInstead: `escalated ${ticket.id}: ${diagnosis}`,
    why:
      'PLAN.md has no per-item state, so an escalated item cannot be marked ' +
      'unselectable. Move it to the Operator queue in the same edit, or the next ' +
      'run picks it straight back up.',
  };
};

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

/**
 * The trailing fields this adapter writes, and the only thing it will ever edit.
 *
 * 🔴 Both patterns are anchored to the END of the line, and that is the whole
 * point. An unanchored `seen ×(\d+)` matched the FIRST such token in the bullet —
 * and a proposal is free text, so a proposal *about* the counter ("render
 * `seen ×2` as twice") put one there itself. Observed: the count read back as 3
 * then 4 while the file still said ×1, and the increment rewrote the number
 * inside the finding — silently altering the human-facing record of what the loop
 * found, which `core.mjs` forbids for queue metadata in as many words.
 */
const TAIL = /·\sfingerprint: `([^`]*)`\s·\sseen ×(\d+)\s*$/;
const COUNT = /seen ×(\d+)\s*$/;

/**
 * Fold a field onto one line.
 *
 * 🔴 A bullet is spliced into the file as a single array element and joined with
 * newlines, so a `\n` inside a proposal's own prose became REAL lines in the
 * plan. Two things broke at once: the `fingerprint … seen ×N` tail landed on a
 * different physical line from the bullet, which defeated dedup permanently; and
 * a pasted `## Agent queue` line became a heading — on a plan whose Operator
 * queue comes first, `selectNext` then handed the run its own proposal as
 * ordinary work, with the `[triage]` marker stranded on the line above.
 *
 * Not an exotic input: `autonomy.md` tells an escalating run to report "verbatim
 * errors, not summaries", so a stack trace in `finding` is the expected case.
 * The text survives; its layout does not — and "layout" includes interior runs
 * of tabs and spaces, which collapse to one space each. `parsePlan` normalises
 * titles the same way, so this is the house convention rather than a special
 * case, but it is wider than "newlines are folded" and worth knowing before
 * relying on a field surviving byte-for-byte.
 *
 * 🔴 One quantifier over one class, because the obvious spelling was quadratic:
 * putting an unbounded whitespace quantifier in front of a line-terminator class
 * — which is a SUBSET of whitespace — makes the engine re-split a whitespace run
 * at every offset. Measured at 6.7s on 65k spaces, 103s on 256k, and 0s the
 * moment a newline appears after the run, which is why every injection fixture
 * missed it. That is the fourth time this shape has landed in this queue layer;
 * `core.mjs` already says remembering it once was not enough.
 *
 * JS `\s` covers U+2028 and U+2029 as well as the ASCII set, so those fold too.
 * U+0085 and NUL do not, and they survive verbatim — harmless, because
 * `split('\n')` is this adapter's whole line model, but a renderer may show them
 * as breaks.
 *
 * Exported for its cost guard. Measuring the fold through `proposeTriage` meant
 * measuring the plan file it rewrites per call — which grew as the measurement
 * ran, and read DEARER on a faster machine. The guard measures this function
 * directly instead; nothing outside the test imports it.
 */
export const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The proposal as ONE Operator-queue bullet: a flat list cannot hold a body.
 *
 * The counter goes LAST, after the fingerprint, so the anchors above land on the
 * adapter's own fields whatever the proposal's prose happens to contain.
 */
const bulletFor = (item, proposal, seen) =>
  `- **${oneLine(item.title)}** — finding: ${oneLine(proposal.finding)} · ` +
  `part: ${oneLine(proposal.part)} · proof: ${oneLine(proposal.proof)} · ` +
  `fingerprint: \`${item.fingerprint}\` · seen ×${seen}`;

/**
 * File a proposal into the **Operator queue** — never the Agent queue.
 *
 * This adapter used to return `ok: false` and instruct a human to file it by
 * hand, which is a channel only in form: over the loop's entire history that
 * instruction produced one triage ticket. A channel nobody walks is where
 * findings go to die, and the findings it loses are the ones about the loop
 * itself.
 *
 * 🔴 Two invariants, and the writing is what puts them at risk:
 * - it appends **only** inside the Operator queue's line range, so the agent can
 *   never file itself selectable work;
 * - the `[triage]` marker rides in the title, so even a proposal moved under the
 *   wrong heading by hand is still refused by `selectionOf`.
 *
 * Deduping is the shared `duplicateOf` from `core.mjs`, so the three adapters
 * cannot drift into three different answers about what counts as the same
 * proposal. Twenty "queue empty" stops must leave ONE proposal counted twenty
 * times, not twenty proposals.
 *
 * Bounded by construction: work is linear in the section's length, no recursion,
 * no rescanning, and `validateProposal` throws before the file is read — an
 * incomplete proposal cannot leave a partial write behind.
 *
 * One difference from the other two adapters, deliberate and worth knowing:
 * `incremented` is the **fingerprint** here, where `github-issues` returns an
 * issue number and `jira` an issue key. A flat list has no per-item identifier
 * that survives an edit — the line index shifts the moment anything above it
 * changes — and the fingerprint is the only stable name this adapter can give.
 *
 * What this cannot see, stated so nobody relies on cover it lacks:
 * - a filed bullet whose trailing `fingerprint … seen ×N` fields a human has
 *   edited away no longer matches, so the next call files a second bullet
 *   rather than incrementing. That is the deliberate direction to fail in: a
 *   duplicate is visible and cheap, editing somebody else's line is not;
 * - a HUMAN line ending in this adapter's exact `· fingerprint: \`x\` · seen ×N`
 *   shape is indistinguishable from one the adapter wrote, and gets incremented
 *   instead of the proposal being filed. Reachable only by hand — a proposal's
 *   own prose cannot trigger it, because the real tail is always appended after
 *   every field — but the check is a shape test, not an authorship proof;
 * - two *distinct* proposals can still be treated as one, by two separate
 *   mechanisms in `core.mjs`, both shared by all three adapters and neither
 *   fixable here. `fingerprintOf` truncates each part to 40 characters, so two
 *   long proposals differing only past that point produce the SAME fingerprint;
 *   and `duplicateOf` matches by substring, so a short fingerprint that is a
 *   prefix of a longer one matches it even when both are well under 40
 *   characters (`f:p:rename-the` against `f:p:rename-the-counter`). The prefix
 *   case bites in one direction only: the short one filed second is swallowed,
 *   the reverse order files both. When it bites, the caller is told
 *   `{ok: true, incremented: <the short fingerprint>}` for a bullet that carries
 *   the long one — the same "incremented something that does not exist" shape
 *   this adapter has a test for in the quoted-prose case;
 * - a CRLF plan file comes back mixed — `sectionRange` splits on `\n`, so every
 *   pre-existing line keeps its `\r` and the appended bullet has none. An
 *   increment drops the `\r` from the line it rewrites, because the counter
 *   pattern's trailing whitespace is inside the match;
 * - only the FIRST `## Operator queue` is ever written to: `sectionRange` uses
 *   `findIndex`, so a second one later in the file is invisible;
 * - a missing plan file throws `ENOENT` from the read rather than returning
 *   `ok: false` — loud, so nothing is lost, but it is not one of the structured
 *   refusals;
 * - `seen` is returned only by this adapter; the other two report no count at
 *   all;
 * - `sectionRange` does not know about code fences, so a fenced
 *   "## Operator queue" line inside another section captures the write. The
 *   line arithmetic still holds and `parsePlan` truncates at the same line, so
 *   the bullet stays unselectable — but a reader sees it under the wrong
 *   heading.
 */
export const proposeTriage = (proposal, { planPath: p } = {}) => {
  const item = triageItemFor(proposal);
  const file = p ?? 'PLAN.md';
  const plan = readFileSync(file, 'utf8');
  const { found, lines, start, end } = sectionRange(plan, OPERATOR_QUEUE);
  if (!found) {
    return {
      ok: false,
      item,
      why:
        `${file} has no "## Operator queue" heading, so a proposal has nowhere to ` +
        'land that the selection query cannot reach. Add the heading rather than ' +
        'filing this into the Agent queue.',
    };
  }

  // 🔴 Only lines carrying THIS adapter's trailing field shape are candidates —
  // which is a test of shape, not proof of authorship, and the limits list above
  // says what a hand-written mimic costs. The other two adapters get
  // that restriction free from their tracker (`--label triage`); plan-md has no
  // label, and "every line in the section" — the first version of this — handed
  // the Operator queue's human prose to the deduper. Observed: a human's
  // "we discussed <fingerprint> in March and decided against it" became the
  // counter for that very proposal, which was then never filed while the caller
  // was told ok: true. The humans' page is not the agent's to edit.
  //
  // And the body handed to `duplicateOf` is the fingerprint FIELD, never the
  // whole bullet: `duplicateOf` matches by substring, so a proposal whose prose
  // quoted another proposal's fingerprint — which the loop does, since that
  // string is what `incremented` returns and what the journal cites — captured
  // that proposal's counter and was never filed, while the caller was told it
  // had incremented a bullet that does not exist.
  const candidates = [];
  for (let i = start; i < end; i += 1) {
    const tail = TAIL.exec(lines[i]);
    if (tail) candidates.push({ id: String(i), body: tail[1] });
  }
  const existing = duplicateOf(item, candidates);

  if (existing) {
    const at = Number(existing.id);
    const current = Number(TAIL.exec(lines[at])[2]);
    lines[at] = lines[at].replace(COUNT, `seen ×${current + 1}`);
    writeFileSync(file, lines.join('\n'));
    return { ok: true, incremented: item.fingerprint, seen: current + 1, item };
  }

  // Append after the section's last non-empty line, so any blank line before the
  // next heading survives and the file stays diff-clean. A section that has no
  // blank line — an empty Operator queue whose heading is followed straight by
  // the next one — gains none: the bullet lands flush against that heading.
  let at = end;
  while (at > start && lines[at - 1].trim() === '') at -= 1;
  lines.splice(at, 0, bulletFor(item, proposal, 1));
  writeFileSync(file, lines.join('\n'));
  return { ok: true, filed: item.title, seen: 1, item };
};
