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
  // One item by id, WITHOUT the closed filter `listEligible` applies: the close
  // point has to see an item somebody already closed (AR-135). Each adapter
  // owns how — the decision is not made above the seam.
  'find',
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
  'trigger-auto',
  'trigger-human',
  'spacing',
]);

/**
 * The causes that hold a takeable item back — and the reason the stop conditions
 * cannot treat "something was skipped" as one thing.
 *
 * Each of these clears without the QUEUE being refilled: a normal item lands, a
 * blocker closes, another session finishes, a human declares the window. Two of
 * them do need something written, and the distinction cost three rewrites of the
 * stop line to get right — a `trigger-auto` item stays held until the
 * declaration is recorded in the run state, and a `trigger-human` item is freed
 * only by a human editing the item's own marker. They are separate tags for
 * that reason: one tag standing for two remedies makes every sentence about it
 * wrong for one of them. The
 * three causes NOT in this list — `closed`, `triage`, `escalated` — are items
 * out of play, waiting on a human. On a tracker-backed adapter they accumulate:
 * an escalated issue stays open and merely gains a label, and a proposal the
 * loop files stays open too. Counting those as "the queue is full, wait"
 * would make `queue-empty` unreachable from the first stop that escalated or
 * proposed anything — so a drained queue would report "wait and interleave" and
 * the owner would never be told to refill. That is the same refill-versus-wait
 * inversion this split exists to remove, pointing the other way.
 *
 * Under `plan-md` only `triage` is reachable of the three, and it matters that it
 * is: `parsePlan` reads the marker out of the bullet text, which is exactly the
 * case of a proposal that ended up under the wrong heading. `escalated` and
 * `closed` cannot appear there at all — a flat list carries no per-item state, so
 * `parsePlan` hands back `labels: []` and `state: 'open'` for every line. That is
 * an absence of state, NOT an adapter that filed the escalation somewhere safe.
 * `plan-md`'s own `escalate` says so: it writes nothing, returns `ok: false`, and
 * hands back the instruction to move the item to the Operator queue in the same
 * edit — because if that move is not made, the next run picks the item straight
 * back up.
 */
export const HOLDING_CAUSES = Object.freeze([
  'blocked',
  'in-progress',
  'spacing',
  'trigger-auto',
  'trigger-human',
]);

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
  // ⚠ **The markers are resolved by the adapter, `auto` first**, so an item
  // carrying BOTH reaches here as `auto` and one recorded declaration takes it.
  // Nothing refuses that combination and no hygiene check reports it — so this
  // branch describes the item as the adapter classified it, and claims nothing
  // about what the item's author wrote. "Never self-taken" would be exactly
  // that claim, and it would be false for the item most likely to carry both:
  // one an owner tightened from auto-gated to human-gated without deleting the
  // old marker, where the silent resolution goes to the LESS restrictive gate.
  if (ticket.trigger === 'human') {
    reject(
      'trigger-human',
      'trigger-human: a window, a demand or a "pass" is a human declaration — ' +
        'handed over explicitly, never taken on this marker alone',
    );
  }
  if (ticket.trigger === 'auto') {
    const fired = triggersFired?.[ticket.id];
    if (fired !== true) {
      reject(
        'trigger-auto',
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
 * The tiers a close can record that leave the next elevated item selectable.
 *
 * `normal` is the obvious one. `elevated-prose` is the narrowing: an elevated
 * change every one of whose elevated paths is a document (`state.mjs` decides
 * this from the diff, never from the item's marker). It is still elevated for
 * review — model lane, cold readers, the `human-review` label, the gate sweep —
 * and it does not space the next item, because the ration buys protection from
 * *unreviewed changes compounding overnight* and a document does not run.
 */
const CLEARS_SPACING = new Set(['normal', 'elevated-prose']);

/**
 * Does the last recorded tier leave the elevated ration open?
 *
 * 🔴 **Unknown means the RESTRICTIVE reading, never the permissive one.** Absent
 * is not unknown: `null`/`undefined` is the honest statement that nothing has
 * closed yet — what a fresh checkout with no state file says — and refusing it
 * would make a clone unable to take its first item. Everything else outside the
 * vocabulary holds: the legacy `'elevated'` an older state file still carries, a
 * word in the wrong case, a value that is not a string at all. An `===`
 * comparison against `'elevated-mechanism'` would read every one of those as
 * "nothing elevated closed" and hand out the next elevated item — un-rationing
 * the queue silently, which is the exact failure this seam exists to end.
 *
 * The CLI refuses an out-of-vocabulary tier before selection ever runs
 * (`index.mjs`), so this is the second of two layers rather than the only one —
 * and it is the layer that holds when `selectNext` is called directly.
 */
const clearsSpacing = (lastCompletedTier) =>
  lastCompletedTier === null ||
  lastCompletedTier === undefined ||
  CLEARS_SPACING.has(lastCompletedTier);

/**
 * How many times one branch may enter the review gate before the item stops.
 *
 * 🔴 **Why a cap exists.** Every other stop in `autonomy.md` has something red
 * behind it — a failing check, a conflicting rule, a false premise. A gate that
 * keeps finding fixable prose has nothing red at all, so three strikes never fires
 * and the run has no reason to stop re-entering it. That is not hypothetical: the
 * repository this rulebook was extracted from journalled multi-round gates on single
 * items with the whole suite green throughout, and its `budget` stop arriving "later
 * than it should have".
 *
 * Two is the cap because the second round is what verifies the first round's fixes.
 * A third means they are not converging, which is a diagnosis for a human rather
 * than another pass to buy.
 */
export const DEFAULT_MAX_GATE_ROUNDS = 2;

/**
 * Is this round allowed, and if not, what stops?
 *
 * Pure, and separate from the counter on disk, because the rule and the storage
 * fail differently: a wrong count is a bug in one file, a wrong rule is a bug in
 * every caller. `gate-rounds.mjs` owns the count; this owns the verdict.
 *
 * `rounds` is the number of rounds **including the one about to run**, so a cap of
 * 2 allows rounds 1 and 2 and refuses 3.
 *
 * The refusal is `documented-stall`, and what its diagnosis can contain is narrower
 * than the name suggests: the previous rounds' blockers are not persisted anywhere, so
 * what survives a compaction is the round count. The `loop` skill states the gap; do
 * not write this as if the blockers were available.
 *
 * It is deliberately NOT in `SKIP_CAUSES`: those are reasons an item was passed over
 * during selection, and this is a reason a task ends. One vocabulary holding both
 * would make every sentence about either one wrong.
 */
export const gateRoundVerdict = (rounds, max = DEFAULT_MAX_GATE_ROUNDS) => {
  // A cap under 1 refuses the FIRST round, which turns the gate off rather than
  // bounding it — the opposite of what this is for. Fail loudly on the
  // configuration rather than quietly on every PR.
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      `maxGateRounds must be an integer of at least 1, got ${JSON.stringify(max)}. ` +
        'A cap below 1 would refuse the first gate round, which disables the gate ' +
        'instead of bounding it.',
    );
  }
  const exceeded = rounds > max;
  return { rounds, max, exceeded, stop: exceeded ? 'documented-stall' : null };
};

/**
 * Pick the next item, or explain why nothing was taken.
 *
 * The elevated tier is rationed by **spacing, not counting**: a per-run count is
 * meaningless when the run has no end. Never two mechanism-touching elevated
 * items back to back — one unreviewed schema or permissions change is
 * recoverable; a chain of them compounding overnight is not.
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
    if (ticket.tier === 'elevated' && !clearsSpacing(lastCompletedTier)) {
      skipped.push({
        id: ticket.id,
        reason:
          `elevated, and the last completed change (${JSON.stringify(lastCompletedTier)}) ` +
          'did not clear the ration — never two back to back. Land a normal item, or ' +
          'an elevated change that is only prose, on a healthy runtime first.',
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
 * Revalidation at SELECT — is the item the run is about to take the item the
 * last take-up saw?
 *
 * The snapshot is the ticket's `updatedAt` marker as recorded at the previous
 * take-up in THIS run (`run-state.mjs` › recordTakeUp). One string compare on
 * the tracker's last-modified field, no second network call — the unchanged
 * case costs nothing. That the field moves on every edit, comment and status
 * change is the tracker's contract, assumed here and not checked.
 *
 * 🔴 **`changed` is three-valued, and `null` is the honest one.** An adapter
 * with no marker (`plan-md`) cannot say "unchanged"; it can only say it did not
 * look. Collapsing that into `false` would report a blind spot as a pass, which
 * is the one thing an evidence log must never do. `true` is reserved for a
 * marker that moved: a first sight (no snapshot yet) is `false` with the baseline
 * recorded, not a change.
 *
 * `action` says what the run does with it: `refresh` — re-read the item before
 * acting; `continue` — nothing moved; `unverifiable` — no marker to compare.
 *
 * ⚠ Limit: the marker moves on the run's OWN claim and comments too, so a
 * `true` on a re-offer can be self-inflicted. This function cannot tell who
 * moved it; the re-read can, and the `loop` skill records that conclusion as a
 * separate `revalidation-outcome` event.
 */
export const revalidationOf = ({ ticket, snapshot = null }) => {
  const to = typeof ticket?.updatedAt === 'string' ? ticket.updatedAt : null;
  const from = typeof snapshot === 'string' ? snapshot : null;
  const base = { ticket: ticket?.id ?? null, point: 'SELECT', from, to };
  if (to === null) return { ...base, changed: null, source: null, action: 'unverifiable' };
  const changed = from !== null && from !== to;
  return { ...base, changed, source: 'updatedAt', action: changed ? 'refresh' : 'continue' };
};

/**
 * Revalidation at BEFORE_PR — the aggregate over two sources, pure.
 *
 * `task` is what {@link revalidationOf} returned for the ticket against the
 * take-up snapshot; `mainChanged` is the list of cited paths the default branch
 * changed since the branch forked (`revalidate.mjs` computes it from git). One
 * source name per finding — `task:updatedAt`, `main:<path>` — so a hold names
 * exactly what moved, never "something changed".
 *
 * `changed` keeps the three values of the SELECT point: `true` when any source
 * moved; `null` when nothing moved but the task could not be checked (no
 * snapshot, no marker, no run) — a blind spot on one side is not a clean pass
 * on both; `false` only when both sides were compared and neither moved.
 */
export const beforePrRevalidationOf = ({ ticket, task = { changed: null }, mainChanged = [] }) => {
  const source = [
    ...(task?.changed === true ? ['task:updatedAt'] : []),
    ...mainChanged.map((path) => `main:${path}`),
  ];
  const changed = source.length > 0 ? true : task?.changed === null ? null : false;
  const action = changed === true ? 'hold' : changed === null ? 'unverifiable' : 'continue';
  return { ticket, point: 'BEFORE_PR', changed, source, action };
};

/**
 * Revalidation at BEFORE_CLOSE — the aggregate over the item's marker and its
 * state, pure. `task` is what {@link revalidationOf} returned against the last
 * validation; `state` is the item's neutral state now. At close the item is
 * expected `in-progress`: `closed` means someone else published it, `open`
 * means someone moved it back, and either is a change the close must not
 * paper over. Same three-valued `changed` and the same actions as BEFORE_PR;
 * `task:updatedAt` is named before `task:state`.
 */
export const beforeCloseRevalidationOf = ({ ticket, task = { changed: null }, state = null }) => {
  const source = [
    ...(task?.changed === true ? ['task:updatedAt'] : []),
    ...(state !== 'in-progress' ? ['task:state'] : []),
  ];
  const changed = source.length > 0 ? true : task?.changed === null ? null : false;
  const action = changed === true ? 'hold' : changed === null ? 'unverifiable' : 'continue';
  return { ticket, point: 'BEFORE_CLOSE', changed, source, action };
};

/**
 * Split the skipped records into the ones holding takeable work back and the
 * ones that are simply out of play.
 *
 * 🔴 **A parked cause outranks a holding one, per record** — and this precedence
 * is the whole mechanism, not a detail. An escalated item is left CLAIMED on
 * purpose (`escalate` labels it and nothing more), so on a tracker-backed
 * adapter it arrives carrying `['in-progress', 'escalated']`. Let the holding
 * cause win and every escalated item reads as "another session will finish it" —
 * an item no session is on, which only a human clears — and `queue-empty` is
 * unreachable from the first escalation onward. That is the exact defect this
 * split exists to remove, one label over.
 *
 * The rule generalises past that case: a parked cause says the item does not
 * come back into play without a human, and that outlasts any condition which
 * would clear on its own.
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
  const parked = [];
  for (const skip of skipped) {
    const causes = Array.isArray(skip?.causes) ? skip.causes : [];
    const parking = causes.find(
      (cause) => SKIP_CAUSES.includes(cause) && !HOLDING_CAUSES.includes(cause),
    );
    if (parking) {
      parked.push(parking);
      continue;
    }
    held.push(causes.find((cause) => HOLDING_CAUSES.includes(cause)) ?? 'an unnamed filter');
  }
  return { held, parked };
};

/**
 * "3 X, 1 Y" — a list of causes counted, as a partition.
 *
 * Each item counts ONCE, under the one cause it was classified by, so the parts
 * foot to the total beside them. Counting it under every cause it carries would
 * read as a breakdown and silently sum past that number.
 *
 * Bounded by construction: one forward pass, and a tally whose key set is the
 * closed vocabulary plus one bucket for a record that carries no tag at all.
 */
const breakdownOf = (causes, label = (count, tag) => `${count} ${tag}`) => {
  const tally = new Map();
  for (const cause of causes) tally.set(cause, (tally.get(cause) ?? 0) + 1);
  return [...tally.entries()]
    .sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB))
    .map(([tag, count]) => label(count, tag))
    .join(', ');
};

const heldBreakdown = (held) => breakdownOf(held, (count, tag) => `${count} held by ${tag}`);

/**
 * The parked pile, named rather than left to grow unseen.
 *
 * Reported beside the held count and never summed with it: they ask the owner
 * for different things, and one number covering both would ask for neither.
 *
 * It names the causes the pile actually carries rather than the vocabulary it
 * could have carried. A fixed list would announce `closed` — which no adapter
 * can present, since every one of them drops closed items before selection —
 * while staying silent about which of the reachable ones this pile is made of.
 *
 * It also stops at what it can see. How the pile GROWS differs per adapter (see
 * `HOLDING_CAUSES` above), so a line claiming one mechanism would be false on
 * another, and the stop line is not where that belongs.
 */
const parkedNote = (parked) =>
  parked.length === 0
    ? ''
    : ` A further ${parked.length} item(s) are parked — ${breakdownOf(parked)}. ` +
      'Those are not work this run can take and they wait on a human, never on ' +
      'time.';

/**
 * The trigger remedies, composed from the tags actually present.
 *
 * 🔴 **Why this is a function and not a sentence.** The two trigger kinds hold an
 * item back through different mechanisms and are freed by different acts: an
 * `auto` item waits for a declaration to be RECORDED, a `human` item is never
 * self-taken at all and only a human editing the item's own marker frees it.
 * When one cause tag stood for both, every fixed sentence keyed off it was
 * wrong for one kind — the clause was rewritten three times, each revision
 * repairing one sub-case and leaving the other, until the tags were split. So
 * the remedy now follows the pile: unreachable unless the tag that earns it is
 * in it, which makes a one-sided line structurally unavailable rather than
 * merely discouraged.
 *
 * The cost of getting this wrong is not a confusing sentence. Told to record a
 * declaration for a `human` item, an operator runs a command that reports
 * success, changes nothing, and — under an adapter whose ids are list positions
 * — leaves a live record that arms whatever occupies that slot next.
 */
const triggerNote = (held) => {
  const auto = held.includes('trigger-auto');
  const human = held.includes('trigger-human');
  if (!auto && !human) return '';
  return (
    ' A trigger is the exception, and the two kinds are freed differently:' +
    (auto
      ? ' a trigger-auto item waits for the declaration to be RECORDED — ' +
        '`node .claude/scripts/run-state.mjs trigger <item-id>` — so waiting it ' +
        'out waits forever;'
      : '') +
    (human
      ? ' an item held as trigger-human is not freed by recording a declaration ' +
        "— that does nothing here; only a human changing the item's own marker " +
        'frees it;'
      : '') +
    ' both are declarations, not delays.'
  );
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
          `session finishes.${triggerNote(held)} Otherwise the action is to ` +
          'interleave or to wait, never to refill and never to invent work.',
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
