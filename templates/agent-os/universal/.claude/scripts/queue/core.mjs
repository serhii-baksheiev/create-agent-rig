// The queue seam — everything ABOVE it.
//
// Selection, blocker resolution, the tier ration, the sort and the stop
// conditions are domain-free: they are the same whether the queue lives in
// PLAN.md, in an issue tracker or in a spreadsheet. This file holds all of it and
// touches nothing outside itself — no I/O, no clock, no network — so it is
// exhaustively testable and identical for every adapter.
//
// Below the seam sits one adapter per tracker (`plan-md.mjs`,
// `github-issues.mjs`, …), whose only job is to map that tracker's records onto
// the neutral Ticket shape below and to perform the six write operations.
//
// A Ticket:
//   {
//     id, title, url,
//     state:     'open' | 'in-progress' | 'closed',
//     labels:    string[],                       // informational, never decisive
//     tier:      'normal' | 'elevated',
//     blockedBy: [{ id, resolved }],             // FROM LINKS — see invariant 1
//     blocks:    string[],                       // ids this one unblocks
//     priority:  number,                         // lower is more urgent
//     createdAt: ISO string | null,
//     triage:    boolean,                        // a proposal — never selectable
//     trigger:   'auto' | 'human' | null,        // null means unconditional
//     body:      string | null,                  // the item's text — see below
//     raw:       string | undefined,             // adapter-private; not read here
//   }
//
// 🔴 **Why `body` is on the neutral shape, decided rather than drifted into.**
// Two hygiene checks need the item's text: a body that claims a blocker the
// links do not carry, and a document link that is broken on its face. The
// alternative was to implement them inside each adapter — the same invariant in
// three places, which `.claude/rules/invariants.md` says will disagree, with the
// copy nobody is looking at being the wrong one. Here they are one function,
// testable on fixtures, and the adapters stay thin.
//
// The item that asked for these called one of them "body vs labels". It is
// **body vs links**, deliberately: invariant 1 in this same file says a label is
// never decisive, so a check that compared the body against labels would be
// asking the one source the rest of the module refuses to trust. Recorded here
// rather than silently substituted.
//
// **`null` is a real answer and it is not `''`.** `plan-md` is a flat list with
// no per-item body; it must say "I cannot answer" rather than "checked, found
// nothing", because the second one silently converts a blind spot into a pass.
// Every check below therefore returns `null` — no finding — when `body` is not
// a non-empty string.
//
// `raw` is the adapter's own record of the line or record it parsed. It is
// deliberately NOT read by this file: it exists for the adapter's writes.

/**
 * The operations every adapter provides. A second tracker is an adapter, not a
 * rewrite — and this list is what "an adapter" means, mechanically.
 */
export const ADAPTER_CONTRACT = [
  'listEligible',
  'resolveBlockers',
  'claim',
  'close',
  'comment',
  'escalate',
  'proposeTriage',
];

/**
 * Why an item was passed over, as a closed vocabulary.
 *
 * The reason strings below are written for a human and change freely; a counter
 * that grouped them by re-parsing that prose would break the first time a word
 * did. `SPACING` is the one cause no filter produces — it belongs to the tier
 * ration in `selectNext`, which is why it lives here rather than in `selectionOf`.
 */
export const SKIP_CAUSES = Object.freeze([
  'closed',
  'in-progress',
  'triage',
  'escalated',
  'blocked',
  'trigger',
  'spacing',
]);

/**
 * The causes that hold a takeable item back — and the reason the stop conditions
 * cannot treat "something was skipped" as one thing.
 *
 * Each of these clears WITHOUT new work being written: a normal item lands, a
 * blocker closes, another session finishes, a human declares the window. The
 * three causes NOT in this list — `closed`, `triage`, `escalated` — are items
 * out of play, and on a tracker-backed adapter they accumulate forever: an
 * escalated issue stays open and merely gains a label, and the loop files a
 * `triage` proposal at every stop. Counting those as "the queue is full, wait"
 * would make `queue-empty` unreachable from the first stop that escalated or
 * proposed anything — so a drained queue would report "wait and interleave" and
 * the owner would never be told to refill. That is the same refill-versus-wait
 * inversion this split exists to remove, pointing the other way.
 */
export const HOLDING_CAUSES = Object.freeze(['blocked', 'in-progress', 'spacing', 'trigger']);

/**
 * Is this item takeable, and if not, why not?
 *
 * The filters run in order and every rejection carries a reason: an unexplained
 * skip is indistinguishable from a bug in the filter. Each reason also carries a
 * `cause` tag, so the stop line can say what is holding the queue back without
 * reading the prose back.
 */
export const selectionOf = (ticket, { triggersFired = null } = {}) => {
  const reasons = [];
  const causes = [];
  const labels = ticket.labels ?? [];

  // Filter order is the order these are pushed in; a cause repeats at most once,
  // because two trigger reasons are still one thing holding the item back.
  const reject = (cause, why) => {
    reasons.push(why);
    if (!causes.includes(cause)) causes.push(cause);
  };

  if (ticket.state === 'closed') reject('closed', 'already closed');
  if (ticket.state === 'in-progress') {
    reject('in-progress', 'already in progress — another session may be on it');
  }

  // Belt and braces, and deliberately so. A triage item is a proposal the loop
  // itself wrote; excluding it only by the ABSENCE of a ready marker would mean
  // one careless hand adding that marker closes the loop's feedback path into its
  // own input — the exact circuit the firewall exists to break.
  if (ticket.triage || labels.includes('triage')) {
    reject('triage', 'a triage proposal: promotion to work is a human act');
  }

  if (labels.includes('escalated')) {
    reject('escalated', 'escalated — it is waiting on a human, not on another attempt');
  }

  // 🔴 INVARIANT 1: blockers resolve from LINKS, never from labels.
  //
  // A `ready`/`blocked` label is a hand-maintained snapshot; the links are the
  // dependency. This matters most in continuous mode, because the loop is what
  // closes the blockers — and nothing updates a dependent's label when its
  // blocker lands. A label-driven loop stalls on work it just unblocked itself,
  // and takes work whose blocker is still open. Both directions have been seen.
  const open = (ticket.blockedBy ?? []).filter((blocker) => !blocker.resolved);
  if (open.length > 0) {
    reject('blocked', `blocked by ${open.map((b) => b.id).join(', ')} (from links, not labels)`);
  }

  // No trigger label means unconditional, not missing data. Work that is
  // genuinely conditional says so.
  if (ticket.trigger === 'human') {
    reject(
      'trigger',
      'trigger-human: a window, a demand or a "pass" is a human declaration — ' +
        'never self-taken, only handed over explicitly',
    );
  }
  if (ticket.trigger === 'auto') {
    const fired = triggersFired?.[ticket.id];
    if (fired !== true) {
      reject(
        'trigger',
        fired === undefined
          ? 'trigger-auto with no verification of the trigger this run — ' +
            'unverified is not fired'
          : 'trigger-auto and the trigger has not fired',
      );
    }
  }

  return { eligible: reasons.length === 0, reasons, causes };
};

/**
 * The queue-hygiene finding for this item, or null.
 *
 * Reported, never silently corrected: a loop that quietly rewrites the queue's
 * own metadata removes the evidence that the metadata is unreliable.
 */
export const hygieneOf = (ticket) => {
  const labels = ticket.labels ?? [];
  const open = (ticket.blockedBy ?? []).filter((blocker) => !blocker.resolved);

  if (labels.includes('blocked') && open.length === 0) {
    return {
      kind: 'stale-blocked-label',
      id: ticket.id,
      why:
        (ticket.blockedBy ?? []).length === 0
          ? 'labelled blocked with no blocker links at all — a data bug, not a dependency'
          : 'labelled blocked, but every blocker it links to is resolved',
    };
  }
  if (labels.includes('ready') && open.length > 0) {
    return {
      kind: 'stale-ready-label',
      id: ticket.id,
      why: `labelled ready while ${open.map((b) => b.id).join(', ')} still blocks it`,
    };
  }

  const links = ticket.blockedBy ?? [];
  const body = typeof ticket.body === 'string' ? ticket.body : '';

  // Everything below needs the item's text. `null`/'' means the adapter has none
  // (plan-md), which is "cannot answer" and never a pass — see the shape note at
  // the top of this file.
  if (body.trim() === '') return null;

  if (
    SPLIT_IN_BODY.test(body) &&
    links.length >= 2 &&
    open.length === 0 &&
    ticket.state !== 'closed'
  ) {
    return {
      kind: 'split-parent-left-open',
      id: ticket.id,
      why:
        'its body says it was split up, every part it links to is resolved, and it ' +
        'is still open — either it wants closing, or the work it kept is written ' +
        'down nowhere',
      // 🔴 Limit, and the reason this reads the body at all: "every dependency
      // resolved and still open" describes EVERY healthy multi-dependency item
      // from the moment its last blocker lands — including one the queue is about
      // to hand out, and one the loop is working right now. A check that fires on
      // those gets muted, and a muted check reports nothing about anything. The
      // body is the only place the neutral shape carries the word "split", so an
      // adapter without one (plan-md) cannot raise this finding at all.
    };
  }

  if (BLOCKER_IN_BODY.test(body) && links.length === 0) {
    return {
      kind: 'body-claims-unlinked-blocker',
      id: ticket.id,
      why:
        'a dependency line in the body names a blocker the item carries no link ' +
        'for, so selection sees it as unblocked. Either the link is missing or the ' +
        'adapter failed to parse it — worse than a stale label, because this one ' +
        'takes work whose blocker may still be open',
    };
  }

  const broken = brokenLinkIn(body);
  if (broken) {
    return {
      kind: 'broken-document-link',
      id: ticket.id,
      why:
        `the body links to a document with no destination (${broken}) — the item ` +
        'points at context nobody can reach',
      // 🔴 Limit: this core is pure, so it cannot fetch or stat anything. It
      // catches a link that is broken ON ITS FACE — empty, or a placeholder.
      // A link that is well-formed and dead is invisible here, by design.
    };
  }

  return null;
};

/**
 * A dependency **line**, matching the convention `github-issues.mjs` parses.
 *
 * Anchoring to the line start is what makes it honest rather than merely narrow.
 * Unanchored, it fired on "this WAS blocked by #7 last week, and #7 landed" and
 * on "nothing is blocked by this item" — then printed a finding asserting a live
 * blocker the body had just denied. A check that reports the opposite of what the
 * text says is worse than no check.
 *
 * Linear: the bounded classes on either side of each boundary are disjoint, so
 * there is no ambiguous split to backtrack over.
 */
const BLOCKER_IN_BODY = /^[-*\t ]{0,4}(?:blocked by|depends on|blocker)[ \t:]{0,8}[#A-Za-z0-9]/im;

/** The item saying, in its own words, that it was broken into other items. */
const SPLIT_IN_BODY = /\b(?:split into|split up into|broken into|broken up into|superseded by|subtasks?:)/i;

/**
 * A markdown link, destination captured for a plain-string test afterwards.
 *
 * 🔴 The destination is ONE bounded quantifier on purpose. The obvious regex —
 * `\(\s*(?:TODO|TBD)?\s*\)` — puts two unbounded quantifiers around an optional
 * group, which is `\s*\s*`: a whitespace run with no closing paren is re-split at
 * every position. Measured on this module at 1.7s for 32k spaces and ~7s at the
 * 64k body cap, in a function the loop runs for every item in the queue. That is
 * the same defect, in the same shape, that `github-issues.mjs` records fixing —
 * written out here because remembering it once evidently was not enough.
 */
const LINK = /\[[^\]]{0,120}\]\(([^)]{0,40})\)/;
const PLACEHOLDER = /^(?:TODO|TBD|link|url)$/i;

/** Control bytes stripped: this string is printed to a terminal. */
const printable = (text) => text.replace(/[^\x20-\x7E]/g, '').slice(0, 40);

const brokenLinkIn = (body) => {
  const match = LINK.exec(body);
  if (!match) return null;
  const destination = String(match[1] ?? '').trim();
  if (destination !== '' && !PLACEHOLDER.test(destination)) return null;
  return printable(match[0]);
};

/**
 * The sort among survivors.
 *
 * Unblocking the queue comes first: it keeps the loop fed, which is the whole
 * point of running one. Then the tracker's priority, then creation order — the
 * last tiebreak exists so selection is deterministic rather than incidental.
 */
export const sortCandidates = (tickets) =>
  [...tickets].sort((a, b) => {
    const unblocks = (t) => ((t.blocks ?? []).length > 0 ? 0 : 1);
    if (unblocks(a) !== unblocks(b)) return unblocks(a) - unblocks(b);
    if ((a.priority ?? 999) !== (b.priority ?? 999)) return (a.priority ?? 999) - (b.priority ?? 999);
    return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
  });

/**
 * Pick the next item, or explain why nothing was taken.
 *
 * The elevated tier is rationed by **spacing, not counting**: a per-run count is
 * meaningless when the run has no end. Never two elevated items back to back —
 * one unreviewed schema or permissions change is recoverable; a chain of them
 * compounding overnight is not.
 */
export const selectNext = (tickets, { lastCompletedTier = null, triggersFired = null } = {}) => {
  const skipped = [];
  const candidates = [];

  for (const ticket of tickets) {
    const selection = selectionOf(ticket, { triggersFired });
    if (!selection.eligible) {
      skipped.push({
        id: ticket.id,
        reason: selection.reasons.join('; '),
        causes: selection.causes,
      });
      continue;
    }
    if (ticket.tier === 'elevated' && lastCompletedTier === 'elevated') {
      skipped.push({
        id: ticket.id,
        reason:
          'elevated, and the last completed item was elevated too — never two back ' +
          'to back. Land a normal item on a healthy runtime first.',
        causes: ['spacing'],
      });
      continue;
    }
    candidates.push(ticket);
  }

  const [ticket = null] = sortCandidates(candidates);
  return { ticket, skipped, candidates: candidates.length };
};

/**
 * Split the skipped records into the ones holding takeable work back and the
 * ones that are simply out of play.
 *
 * A record with no cause this module recognises counts as **held**: it is the
 * reading that stops rather than the one that declares the queue drained, and an
 * unclassified skip is exactly where a wrong declaration would come from.
 *
 * Bounded by construction: one forward pass, no recursion, and every array it
 * builds is bounded by the input it walks.
 */
const partitionSkipped = (skipped) => {
  const held = [];
  let parked = 0;
  for (const skip of skipped) {
    const causes = Array.isArray(skip?.causes) ? skip.causes : [];
    const holding = causes.find((cause) => HOLDING_CAUSES.includes(cause));
    const known = causes.find((cause) => SKIP_CAUSES.includes(cause));
    if (holding || !known) held.push(holding ?? 'an unnamed filter');
    else parked += 1;
  }
  return { held, parked };
};

/**
 * "N held by X, M by Y" — what is holding the queue back, as a partition.
 *
 * Each held item counts ONCE, under the first holding cause that rejected it, so
 * the parts foot to the total beside them. Counting it under every cause would
 * read as a breakdown and silently sum past that number.
 *
 * Bounded by construction: one forward pass, and a tally whose key set is the
 * holding vocabulary plus one bucket for a record that carries no tag at all.
 */
const heldBreakdown = (held) => {
  const tally = new Map();
  for (const cause of held) tally.set(cause, (tally.get(cause) ?? 0) + 1);
  return [...tally.entries()]
    .sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB))
    .map(([tag, count]) => `${count} held by ${tag}`)
    .join(', ');
};

/**
 * The parked pile, named rather than left to grow unseen.
 *
 * Reported beside the held count and never summed with it: they ask the owner
 * for different things, and one number covering both would ask for neither.
 */
const parkedNote = (parked) =>
  parked === 0
    ? ''
    : ` A further ${parked} item(s) are parked — escalated, in triage or closed. ` +
      'Those wait on a human, never on time, and they grow every time this loop ' +
      'escalates an item or files a proposal.';

/**
 * Should the whole run stop? Checked in severity order, because a regression must
 * not be reported as an empty queue.
 *
 * A per-task stop (three strikes, invariant conflict, a blocking reviewer
 * verdict) does NOT end the run — escalate that item and take the next one. Only
 * the conditions here end it.
 */
export const stopConditionOf = ({
  candidates = 0,
  skipped = [],
  lastDeployVerdict = null,
  consecutiveEscalations = 0,
  killSwitch = false,
  budgetExhausted = false,
  queueReadable = true,
} = {}) => {
  if (!queueReadable) {
    return {
      kind: 'queue-unreadable',
      success: false,
      why:
        'the queue could not be read. Stop and say so — never fall back to memory ' +
        'or to a stale copy for a queue; a remembered queue is how a loop works on ' +
        'items that no longer exist.',
    };
  }
  if (lastDeployVerdict === 'REGRESSION') {
    return {
      kind: 'runtime-regression',
      success: false,
      why:
        'the deployed surface came back unhealthy. Deploy the revert first, ' +
        'diagnose second, and start no new work on top of it — a regression ' +
        'compounds into everything built above it.',
    };
  }
  if (killSwitch) {
    return {
      kind: 'kill-switch',
      success: true,
      why:
        'the kill switch is set. Stop at the current task boundary: finish it, ' +
        'push the branch, open the PR, write the journal entry, exit. Losing ' +
        'in-flight work is not what stopping cleanly means.',
    };
  }
  if (consecutiveEscalations >= 2) {
    return {
      kind: 'repeated-escalation',
      success: false,
      why:
        'two tasks in a row hit a wall, so the third likely will too — the wall is ' +
        'systemic rather than task-local. This is the main guard against grinding a ' +
        'broken assumption for hours.',
    };
  }
  if (budgetExhausted) {
    return {
      kind: 'budget',
      success: true,
      why:
        'the declared budget cannot plausibly fit another task. Stop now rather ' +
        'than starting something that will be abandoned half-done.',
    };
  }
  if (candidates === 0) {
    const { held, parked } = partitionSkipped(skipped);
    if (held.length > 0) {
      return {
        kind: 'nothing-selectable',
        success: true,
        why:
          `${held.length} item(s) are takeable work held back right now — ` +
          `${heldBreakdown(held)}.${parkedNote(parked)} This is NOT an empty queue, ` +
          'and the two ask for opposite things: an empty queue wants refilling, ' +
          'whereas this one still holds work. Spacing clears when a normal item ' +
          'lands, a blocker when its item closes, in-progress when the other ' +
          'session finishes, a trigger when a human declares it — so the action is ' +
          'to interleave or to wait, never to refill and never to invent work.',
      };
    }
    return {
      kind: 'queue-empty',
      success: true,
      why:
        'no item survives the filters and nothing is merely held back — the queue ' +
        `is genuinely out of work.${parkedNote(parked)} This is a legitimate end of ` +
        'session, not an invitation to refactor: **do not invent work**. Refilling ' +
        "the queue is the owner's job.",
    };
  }
  return null;
};

/**
 * The stable fingerprint of an improvement proposal.
 *
 * Under a scheduler against a finite queue the most common stops are the two that
 * hand out nothing — "queue empty" and "nothing selectable"; twenty such stops
 * must produce ONE proposal with a count of twenty, not twenty proposals. Dedupe
 * by fingerprint, then increment.
 */
export const fingerprintOf = ({ finding, part, change }) =>
  [finding, part, change]
    .map((piece) =>
      String(piece ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40),
    )
    .join(':');

/**
 * The already-filed proposal carrying this fingerprint, or null.
 *
 * Pure and shared by every adapter, so the dedupe DECISION is testable without a
 * tracker, a credential or a network call — and so the three adapters cannot drift
 * into three different answers. Candidates are `{ id, body }`.
 */
export const duplicateOf = (item, candidates = []) =>
  (Array.isArray(candidates) ? candidates : []).find((candidate) =>
    String(candidate?.body ?? '').includes(item.fingerprint),
  ) ?? null;

/**
 * The four parts a proposal must name. A proposal missing any of them is not
 * ready to file — and the cap of three elsewhere is the mechanism, not a budget:
 * an unbounded improvement list is another diary, and three forces a choice.
 */
export const validateProposal = (proposal) => {
  const missing = ['finding', 'part', 'change', 'proof'].filter((key) => !proposal?.[key]);
  if (missing.length > 0) {
    throw new Error(
      `a proposal must name all four parts; missing: ${missing.join(', ')}. ` +
        '(finding it came from, part to change, the change itself, and how the next ' +
        'run would prove it worked)',
    );
  }
  return proposal;
};
