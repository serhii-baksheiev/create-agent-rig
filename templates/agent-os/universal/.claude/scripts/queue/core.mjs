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
 * Is this item takeable, and if not, why not?
 *
 * The filters run in order and every rejection carries a reason: an unexplained
 * skip is indistinguishable from a bug in the filter.
 */
export const selectionOf = (ticket, { triggersFired = null } = {}) => {
  const reasons = [];
  const labels = ticket.labels ?? [];

  if (ticket.state === 'closed') reasons.push('already closed');
  if (ticket.state === 'in-progress') {
    reasons.push('already in progress — another session may be on it');
  }

  // Belt and braces, and deliberately so. A triage item is a proposal the loop
  // itself wrote; excluding it only by the ABSENCE of a ready marker would mean
  // one careless hand adding that marker closes the loop's feedback path into its
  // own input — the exact circuit the firewall exists to break.
  if (ticket.triage || labels.includes('triage')) {
    reasons.push('a triage proposal: promotion to work is a human act');
  }

  if (labels.includes('escalated')) {
    reasons.push('escalated — it is waiting on a human, not on another attempt');
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
    reasons.push(`blocked by ${open.map((b) => b.id).join(', ')} (from links, not labels)`);
  }

  // No trigger label means unconditional, not missing data. Work that is
  // genuinely conditional says so.
  if (ticket.trigger === 'human') {
    reasons.push(
      'trigger-human: a window, a demand or a "pass" is a human declaration — ' +
        'never self-taken, only handed over explicitly',
    );
  }
  if (ticket.trigger === 'auto') {
    const fired = triggersFired?.[ticket.id];
    if (fired !== true) {
      reasons.push(
        fired === undefined
          ? 'trigger-auto with no verification of the trigger this run — ' +
            'unverified is not fired'
          : 'trigger-auto and the trigger has not fired',
      );
    }
  }

  return { eligible: reasons.length === 0, reasons };
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
  if (ticket.state !== 'closed' && links.length >= 2 && open.length === 0) {
    return {
      kind: 'split-parent-left-open',
      id: ticket.id,
      why:
        `every one of its ${links.length} dependencies is resolved and it is still ` +
        'open — a parent split into children usually wants closing, and if it has ' +
        'work of its own left, that work is what the item should say',
      // 🔴 Limit: the neutral shape cannot tell "split into children" from
      // "waited on two things". Both end here, and both are worth a human's
      // glance — this is a prompt to look, never a licence to close anything.
    };
  }

  // The body-derived checks. `null`/'' means the adapter has no body to give
  // (plan-md), which is "cannot answer" and never a pass — see the shape note.
  const body = typeof ticket.body === 'string' ? ticket.body : '';
  if (body.trim() !== '') {
    if (BLOCKER_IN_BODY.test(body) && links.length === 0) {
      return {
        kind: 'body-claims-unlinked-blocker',
        id: ticket.id,
        why:
          'the body states a blocker but the item carries no blocker link, so ' +
          'selection sees it as unblocked. Either the link is missing or the ' +
          'adapter failed to parse it — both are worse than a stale label, ' +
          'because this one takes work whose blocker is still open',
      };
    }
    const broken = BROKEN_LINK.exec(body);
    if (broken) {
      return {
        kind: 'broken-document-link',
        id: ticket.id,
        why:
          `the body links to a document with no destination (${broken[0].slice(0, 40)}) — ` +
          'the item points at context nobody can reach',
        // 🔴 Limit: this core is pure, so it cannot fetch or stat anything. It
        // catches a link that is broken ON ITS FACE — empty, or a placeholder.
        // A link that is well-formed and dead is invisible here, by design.
      };
    }
  }

  return null;
};

/**
 * A blocker stated in prose. Deliberately narrow: the conventions this rulebook
 * actually uses (`Blocked by #7`, `blocked by ABC-1`), not every phrasing in
 * which a human might imply a dependency. A hygiene check that fires on ordinary
 * writing gets muted, and a muted check reports nothing about anything.
 */
const BLOCKER_IN_BODY = /\bblocked\s+by\s+[#A-Za-z0-9-]+/i;

/**
 * A markdown link whose destination is absent or a placeholder. One pass, no
 * backtracking on the destination: the character class excludes `)` so it cannot
 * be made to scan the rest of the body repeatedly.
 */
const BROKEN_LINK = /\[[^\]]{0,120}\]\(\s*(?:TODO|TBD|link|url)?\s*\)/i;

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
      skipped.push({ id: ticket.id, reason: selection.reasons.join('; ') });
      continue;
    }
    if (ticket.tier === 'elevated' && lastCompletedTier === 'elevated') {
      skipped.push({
        id: ticket.id,
        reason:
          'elevated, and the last completed item was elevated too — never two back ' +
          'to back. Land a normal item on a healthy runtime first.',
      });
      continue;
    }
    candidates.push(ticket);
  }

  const [ticket = null] = sortCandidates(candidates);
  return { ticket, skipped, candidates: candidates.length };
};

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
    return {
      kind: 'queue-empty',
      success: true,
      why:
        'no item survives the filters. This is a legitimate end of session, not an ' +
        'invitation to refactor: **do not invent work**. Refilling the queue is the ' +
        "owner's job.",
    };
  }
  return null;
};

/**
 * The stable fingerprint of an improvement proposal.
 *
 * Under a scheduler against a finite queue the most common stop is "queue empty";
 * twenty such stops must produce ONE proposal with a count of twenty, not twenty
 * proposals. Dedupe by fingerprint, then increment.
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
