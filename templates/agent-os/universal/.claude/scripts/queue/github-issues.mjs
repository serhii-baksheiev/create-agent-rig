// Queue adapter: issues in the project's own repository, via the `gh` CLI.
//
// The upgrade from `plan-md` once a project has a remote: issues carry per-item
// state, a comment thread, labels and — crucially — a dependency that can be
// written down and then READ FRESH, which is what invariant 1 needs.
//
// How a dependency is expressed here: a line in the issue body naming the blocker.
//
//     Blocked by #7
//     Depends on #9
//
// That is a **link, not a label**: the line names the blocker, and the blocker's
// own current state decides whether this item is takeable. A `blocked` label would
// be a snapshot that nothing updates when the blocker lands; this cannot go stale,
// because it is re-resolved from the blockers themselves on every selection.
import { execFileSync } from 'node:child_process';
import { duplicateOf, fingerprintOf, validateProposal } from './core.mjs';
import { recordEscalation } from '../run-state.mjs';

export const name = 'github-issues';

/**
 * A dependency line, and everything after the keyword on it.
 *
 * Two defects fixed here at once. It used to anchor `$` right after the number,
 * so `Blocked by #7, waiting on design` matched nothing and the dependent read as
 * unblocked — a silent miss, not a safe failure. And `\s*:?\s*` put two unbounded
 * quantifiers side by side, which backtracks quadratically: a 64k issue body that
 * matched the keyword but never reached a `#` cost ~13s, and the queue is re-read
 * on every task, so anyone able to open an issue could tax every selection.
 */
const BLOCKED_BY = /^[ \t]*(?:blocked by|depends on|blocker)[ \t:]*(.*)$/gim;
const ISSUE_REF = /#(\d+)/g;
const PRIORITY = /^(?:priority[:-]|p)(\d+)$/i;

const labelNames = (issue) =>
  (issue?.labels ?? []).map((label) => (typeof label === 'string' ? label : (label?.name ?? '')));

/** The blocker ids this issue's body links to — several per line is fine. */
export const blockerIdsOf = (issue) => {
  const ids = [];
  for (const line of String(issue?.body ?? '').matchAll(BLOCKED_BY)) {
    for (const ref of String(line[1] ?? '').matchAll(ISSUE_REF)) ids.push(ref[1]);
  }
  return [...new Set(ids)];
};

/**
 * Map one issue onto the neutral Ticket shape.
 *
 * `states` maps a blocker id to its state, as read in the same pass. A blocker
 * whose state is not in the map counts as UNRESOLVED: "I could not look" must
 * never resolve to "it is fine".
 */
export const toTicket = (issue, states = {}) => {
  const labels = labelNames(issue);
  const priorityLabel = labels.map((label) => PRIORITY.exec(label)).find(Boolean);

  return {
    id: String(issue.number),
    title: issue.title,
    url: issue.url ?? null,
    state:
      String(issue.state ?? '').toUpperCase() === 'CLOSED'
        ? 'closed'
        : labels.includes('in-progress')
          ? 'in-progress'
          : 'open',
    labels,
    tier: labels.includes('human-review') ? 'elevated' : 'normal',
    blockedBy: blockerIdsOf(issue).map((id) => ({
      id,
      resolved: String(states[id] ?? '').toUpperCase() === 'CLOSED',
    })),
    blocks: [],
    priority: priorityLabel ? Number(priorityLabel[1]) : 999,
    createdAt: issue.createdAt ?? null,
    // The take-up marker for revalidation at SELECT — GitHub bumps it on edits,
    // comments and state changes alike. `null` when the listing did not carry it.
    updatedAt: issue.updatedAt ?? null,
    // The body travels on the neutral shape so the hygiene checks live in one
    // place (core.mjs) instead of once per adapter. This adapter also parses it
    // internally for blocker links — the two readings are independent on
    // purpose: that is exactly the disagreement `body-claims-unlinked-blocker`
    // exists to surface.
    body: typeof issue.body === 'string' ? issue.body : null,
    triage: labels.includes('triage'),
    trigger: labels.includes('trigger-auto')
      ? 'auto'
      : labels.includes('trigger-human')
        ? 'human'
        : null,
  };
};

/**
 * blocker id → the ids it blocks. Feeds the sort rule that puts an item which
 * unblocks others first: unblocking the queue is what keeps the loop fed.
 */
export const blocksIndex = (issues) => {
  const index = {};
  for (const issue of issues) {
    for (const blockerId of blockerIdsOf(issue)) {
      (index[blockerId] ??= []).push(String(issue.number));
    }
  }
  return index;
};

/**
 * Run `gh` and return its raw output.
 *
 * The write commands — `issue edit|close|comment|create` — have **no `--json`
 * flag**; they print plain text (an issue URL, or `✓ Closed issue #12`). Parsing
 * that as JSON threw *after* the mutation had already been applied, which was the
 * worst possible shape of failure: `escalate()` posted its diagnosis and then died
 * before adding the label that keeps the item out of the next selection, so the
 * loop re-picked the stuck task — the exact thing this adapter documents as
 * prevented. So JSON parsing now happens only where JSON is actually produced.
 */
const ghText = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const ghJson = (args) => JSON.parse(ghText(args));

const FIELDS = 'number,title,body,state,labels,url,createdAt,updatedAt';

// --- the adapter contract ------------------------------------------------------

/**
 * Every open issue, mapped and cross-linked.
 *
 * Deliberately queries fresh on every call and never caches: the queue changes as
 * the loop itself closes items and unblocks their dependents.
 */
export const listEligible = ({ limit = 100, issues = null } = {}) => {
  const raw =
    issues ?? ghJson(['issue', 'list', '--state', 'all', '--limit', String(limit), '--json', FIELDS]);
  const states = Object.fromEntries(raw.map((issue) => [String(issue.number), issue.state]));
  const blocks = blocksIndex(raw);
  return raw
    .filter((issue) => String(issue.state ?? '').toUpperCase() !== 'CLOSED')
    .map((issue) => {
      const ticket = toTicket(issue, states);
      return { ...ticket, blocks: blocks[ticket.id] ?? [] };
    });
};

export const resolveBlockers = (ticket) => (ticket.blockedBy ?? []).filter((b) => !b.resolved);

/** `To Do → In Progress` before the first file is edited, not when the PR opens. */
export const claim = (ticket) => {
  ghText(['issue', 'edit', ticket.id, '--add-label', 'in-progress']);
  return { ok: true };
};

export const close = (ticket, { prUrl = null } = {}) => {
  const note = prUrl ? `Landed in ${prUrl}.` : 'Closed by the run.';
  ghText(['issue', 'comment', ticket.id, '--body', note]);
  ghText(['issue', 'close', ticket.id]);
  ghText(['issue', 'edit', ticket.id, '--remove-label', 'in-progress']);
  return { ok: true };
};

export const comment = (ticket, body) => {
  ghText(['issue', 'comment', ticket.id, '--body', body]);
  return { ok: true };
};

/**
 * Escalate: the diagnosis goes on the item, and the item is labelled so the next
 * selection cannot pick it up again. It stays OPEN and stays claimed — moving it
 * back to a selectable state is how one stuck task gets worked three times.
 */
export const escalate = (ticket, diagnosis, { env = process.env } = {}) => {
  ghText(['issue', 'comment', ticket.id, '--body', diagnosis]);
  ghText(['issue', 'edit', ticket.id, '--add-label', 'escalated']);
  // Counted through the one recorder, never a counter of this adapter's own —
  // "twice in a row" has to mean the same thing on every tracker.
  recordEscalation(env.RIG_RUN_DIR);
  return { ok: true };
};

/**
 * A proposal, forced into triage.
 *
 * 🔴 INVARIANT 2: the agent never creates its own work. `triage` is excluded from
 * selection twice over (by the label filter and by `selectionOf`), and the item
 * never gets a ready marker — so the only route from proposal to work runs through
 * a human. Without that, a scheduler plus an improvement loop is a closed circuit.
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
      'rulebook is how an unattended run drifts irreversibly — and it collides with',
      'the rule that the agent authors no work for itself.',
    ].join('\n'),
    labels: ['triage'],
    selectable: false,
    fingerprint,
  };
};

/**
 * File the proposal — or increment the one already there.
 *
 * Under a scheduler against a finite queue the most common stops are the two that
 * hand out nothing — "queue empty" and "nothing selectable";
 * twenty such stops must produce one proposal with a count of twenty.
 */
export const proposeTriage = (proposal, { existing = null } = {}) => {
  const item = triageItemFor(proposal);
  const found =
    existing ??
    ghJson(['issue', 'list', '--label', 'triage', '--state', 'all', '--limit', '100', '--json', FIELDS]);
  const duplicate = duplicateOf(
    item,
    found.map((issue) => ({ id: String(issue.number), body: issue.body })),
  );

  if (duplicate) {
    ghText([
      'issue',
      'comment',
      duplicate.id,
      '--body',
      `Seen again this session (fingerprint \`${item.fingerprint}\`). Incrementing rather than filing a duplicate.`,
    ]);
    return { ok: true, incremented: String(duplicate.number), item };
  }

  ghText(['issue', 'create', '--title', item.title, '--body', item.body, '--label', 'triage']);
  return { ok: true, filed: item.title, item };
};
