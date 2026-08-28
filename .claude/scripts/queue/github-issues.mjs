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
import { duplicateOf, fingerprintOf, lifecycleOf, ownerOfLabels, validateProposal } from './core.mjs';
import { withAsOf } from './as-of.mjs';
import { recordEscalation, recordTakeUp } from '../run-state.mjs';
import { recordClaimTransition } from '../lib/claim-records.mjs';

export const name = 'github-issues';
export const claimedState = 'in-progress';

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
  const comments = Array.isArray(issue.comments) ? issue.comments : [];

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
    // Compatibility evidence only; `.rig/claims/` fingerprints decide drift.
    updatedAt: issue.updatedAt ?? null,
    // The body travels on the neutral shape so the hygiene checks live in one
    // place (core.mjs) instead of once per adapter. This adapter also parses it
    // internally for blocker links — the two readings are independent on
    // purpose: that is exactly the disagreement `body-claims-unlinked-blocker`
    // exists to surface.
    body: typeof issue.body === 'string' ? issue.body : null,
    commentary: {
      count: comments.length,
      ids: comments
        .map((comment) => comment?.id)
        .filter((id) => id !== undefined && id !== null)
        .map(String),
      // GitHub CLI expands `comments` to `comments(first: 100)` but exposes no
      // total or pageInfo beside the resulting array. Fewer than 100 proves the
      // first page was also the last; exactly 100 cannot prove there is no 101st
      // comment and must fail closed rather than fingerprint a partial thread.
      complete: Array.isArray(issue.comments) && comments.length < 100,
    },
    triage: labels.includes('triage'),
    trigger: labels.includes('trigger-auto')
      ? 'auto'
      : labels.includes('trigger-human')
        ? 'human'
        : null,
    // The repository this item belongs to (AR-132): `owner-<name>`, or null.
    owner: ownerOfLabels(labels),
    // The lifecycle and the scheduling flag (AR-144), read above the seam.
    ...lifecycleOf(labels),
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

const FIELDS = 'number,title,body,state,labels,url,createdAt,updatedAt,comments';

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
/**
 * Re-record the item's marker after a write of this adapter's own (AR-140) —
 * the same rule and the same limit as `jira.mjs` › rebaseline: only writes
 * made through this adapter re-baseline, and a read-back that fails is
 * announced, never thrown.
 */
const rebaseline = (ticket) => {
  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) return;
  try {
    const after = ghJson(['issue', 'view', ticket.id, '--json', 'updatedAt']);
    recordTakeUp(runDir, { id: ticket.id, updatedAt: after?.updatedAt ?? null });
  } catch (error) {
    process.stderr.write(
      `#${ticket.id}: the write landed, but its marker was NOT re-recorded in ${runDir} — ` +
        `${error.message}\n`,
    );
  }
};

export const claim = (ticket, { projectRoot = process.cwd() } = {}) => {
  ghText(['issue', 'edit', ticket.id, '--add-label', 'in-progress']);
  let workflowClaimRecorded = false;
  try {
    workflowClaimRecorded =
      recordClaimTransition({ projectRoot, ticket, claimedState }) !== null;
  } catch (error) {
    process.stderr.write(
      `#${ticket.id}: the workflow claim landed, but its durable acknowledgement was NOT recorded — ` +
        `${error.message}\n`,
    );
  }
  rebaseline(ticket);
  return { ok: true, workflowClaimRecorded };
};

/**
 * One issue by number, closed included — `gh issue view` sees every state,
 * where `listEligible` drops CLOSED for selection's sake. The offline `issues`
 * seam is honoured. `blocks` is empty here: the cross-index needs the whole
 * list, and a single view does not carry it.
 */
export const find = (id, { issues = null } = {}) => {
  const raw = issues
    ? (issues.find((issue) => String(issue.number) === String(id)) ?? null)
    : ghJson(['issue', 'view', String(id), '--json', FIELDS]);
  return raw ? toTicket(raw, {}) : null;
};

export const close = (ticket, { prUrl = null } = {}) => {
  const note = prUrl ? `Landed in ${prUrl}.` : 'Closed by the run.';
  ghText(['issue', 'comment', ticket.id, '--body', note]);
  ghText(['issue', 'close', ticket.id]);
  // Read back, never inferred: `gh issue close` exits 0 on an issue that was
  // already closed, or that a workflow reopened a moment later (AR-135). The
  // claim label goes only once the read-back says CLOSED — a close that did
  // not land leaves the item claimed, exactly as it was found.
  const after = ghJson(['issue', 'view', ticket.id, '--json', 'state']);
  const transitioned = String(after?.state ?? '').toUpperCase() === 'CLOSED';
  if (transitioned) ghText(['issue', 'edit', ticket.id, '--remove-label', 'in-progress']);
  rebaseline(ticket);
  return { ok: true, transitioned };
};

export const comment = (ticket, body) => {
  ghText(['issue', 'comment', ticket.id, '--body', body]);
  rebaseline(ticket);
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
  rebaseline(ticket);
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
      ...(proposal.measured ? [`- **measured** — ${proposal.measured}`, `- **inferred** — ${proposal.inferred}`] : []),
      '',
      `fingerprint: ${fingerprint}`,
      ...(proposal.asOf ? [`asOf: ${proposal.asOf}`] : []),
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
/** The proposals on file, as `{ id, body }` — every `triage`-labelled issue. */
export const listProposals = ({ existing = null } = {}) =>
  (
    existing ??
    ghJson(['issue', 'list', '--label', 'triage', '--state', 'all', '--limit', '100', '--json', FIELDS])
  ).map((issue) => ({ id: String(issue.number), body: issue.body }));

export const proposeTriage = (rawProposal, { existing = null } = {}) => {
  const proposal = withAsOf(rawProposal);
  const item = triageItemFor(proposal);
  const duplicate = duplicateOf(item, listProposals({ existing }));

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

  const url = ghText(['issue', 'create', '--title', item.title, '--body', item.body, '--label', 'triage']);
  // The proposal's own baseline (AR-138), as in jira.mjs: `gh issue create`
  // prints the new issue's URL, whose last segment is its number; the marker
  // is read back with `gh issue view`. No run directory → nothing recorded.
  // Best-effort for the same reason as there: the issue exists by now, and a
  // throw would make the caller file it again.
  const id = /\/(\d+)\s*$/.exec(String(url ?? ''))?.[1] ?? null;
  if (id && process.env.RIG_RUN_DIR) {
    try {
      const after = ghJson(['issue', 'view', id, '--json', 'updatedAt']);
      recordTakeUp(process.env.RIG_RUN_DIR, { id, updatedAt: after?.updatedAt ?? null });
    } catch (error) {
      process.stderr.write(
        `proposeTriage: #${id} is filed, but its baseline was NOT recorded in ` +
          `${process.env.RIG_RUN_DIR} — ${error.message}\n`,
      );
    }
  }
  return { ok: true, filed: item.title, id, item };
};
