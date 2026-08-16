// Queue adapter: Jira issues, via the REST API.
//
// The second adapter exists to prove the seam holds: everything about *selection*
// lives in `core.mjs` and is imported, not re-derived. An adapter that answers
// "is this takeable?" for itself is a second answer to the same question, and the
// two will disagree the first time one of them is edited.
//
// Credentials come from the environment and nowhere else:
//
//     JIRA_BASE_URL   https://your-site.atlassian.net
//     JIRA_EMAIL      the account the token belongs to
//     JIRA_API_TOKEN  an API token, never a password
//
// There is deliberately no default, no fallback and no example value: a
// placeholder that looks like a credential is a credential someone will commit.
// Configure the project in `.claude/queue.json`:
//
//     { "adapter": "jira", "options": { "project": "ABC" } }
//     { "adapter": "jira", "options": { "jql": "project = ABC AND ..." } }
import { duplicateOf, fingerprintOf, validateProposal } from './core.mjs';

export const name = 'jira';

/** Jira's own default priority ladder. An unrecognised name sorts last, never first. */
const PRIORITY = { highest: 1, high: 2, medium: 3, low: 4, lowest: 5 };

/**
 * The link types that express a dependency. "relates to" and "duplicates" are
 * neither, and treating them as blockers would stall the queue on commentary.
 */
const BLOCKED_BY = /^(is blocked by|blocked by)$/i;
const BLOCKS = /^blocks$/i;

const statusCategory = (fields) => String(fields?.status?.statusCategory?.key ?? '').toLowerCase();

/** Jira timestamps use +0000 rather than Z; normalise so string compare sorts right. */
const toIso = (created) => {
  if (!created) return null;
  const parsed = new Date(created);
  return Number.isNaN(parsed.getTime()) ? String(created) : parsed.toISOString();
};

/**
 * Flatten an Atlassian-document description down to its text.
 *
 * Only the fingerprint line needs to be findable, so a recursive text harvest is
 * enough — and it tolerates a plain-string description from an older API shape.
 */
export const descriptionTextOf = (issue) => {
  // Depth-capped: the document is written by whoever filed the issue, and an
  // unbounded walk overflows the stack at ~10k levels — which would stop the loop
  // filing or deduplicating any proposal at all.
  const walk = (node, depth) => {
    if (depth > 64) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map((child) => walk(child, depth + 1)).join('\n');
    if (node && typeof node === 'object') {
      return [node.text ?? '', walk(node.content ?? [], depth + 1)].filter(Boolean).join('\n');
    }
    return '';
  };
  return walk(issue?.fields?.description ?? '', 0);
};

/** Map one Jira issue onto the neutral Ticket shape. */
export const toTicket = (issue) => {
  const fields = issue?.fields ?? {};
  const labels = fields.labels ?? [];
  const links = fields.issuelinks ?? [];
  const category = statusCategory(fields);

  // 🔴 INVARIANT 1: the dependency is the LINK, and the blocker's own status
  // decides. A `blocked` label is a snapshot nobody updates when the blocker
  // lands; this is re-read from the blocker every time selection runs. A blocker
  // whose status is not readable counts as unresolved — "could not look" is never
  // "it is fine".
  const blockedBy = links
    .filter((link) => BLOCKED_BY.test(String(link?.type?.inward ?? '')) && link?.inwardIssue)
    .map((link) => ({
      id: link.inwardIssue.key,
      resolved: statusCategory(link.inwardIssue.fields) === 'done',
    }));

  const blocks = links
    .filter((link) => BLOCKS.test(String(link?.type?.outward ?? '')) && link?.outwardIssue)
    .map((link) => link.outwardIssue.key);

  return {
    id: issue.key,
    title: fields.summary ?? '',
    url: issue.self ?? null,
    state: category === 'done' ? 'closed' : category === 'indeterminate' ? 'in-progress' : 'open',
    labels,
    // The marker is `elevated`, the same word the plan-md adapter reads out of an
    // `[elevated]` line — one name for one fact, so `core.mjs` rations the same
    // way whichever tracker the item came from. It is deliberately NOT
    // `human-review`: on a Jira board that is a workflow label meaning "a human
    // is looking at it", which is a different claim entirely, and reading it as
    // the tier rations the queue on a signal that means something else.
    tier: labels.includes('elevated') ? 'elevated' : 'normal',
    blockedBy,
    blocks,
    priority: PRIORITY[String(fields.priority?.name ?? '').toLowerCase()] ?? 999,
    createdAt: toIso(fields.created),
    // Flattened from the document description — the same text this adapter
    // already reads internally, now visible to the shared hygiene checks.
    body: descriptionTextOf(issue) || null,
    triage: labels.includes('triage'),
    trigger: labels.includes('trigger-auto')
      ? 'auto'
      : labels.includes('trigger-human')
        ? 'human'
        : null,
  };
};

/**
 * The lanes selection never takes, named once so the query and the post-filter
 * below cannot drift apart (`invariants.md`: one mechanism, one implementation).
 *
 * - `triage` is the loop's own filed proposals. Excluding them only by the
 *   absence of a ready marker means one careless hand adding that marker closes
 *   the loop's feedback path into its own input.
 * - `operator-queue` is the owner's lane. An item sitting there is work a HUMAN
 *   has taken, so the loop picking one up is two sessions on one task.
 */
export const EXCLUDED_LABELS = ['triage', 'operator-queue'];

/**
 * The selection query.
 *
 * Both lanes are excluded here by label, in the adapter's own filter rather than
 * in an `options.jql` a reinstall would drop.
 *
 * ⚠ JQL gotcha that makes the parenthesised form necessary: `labels != x` does
 * **not** match issues whose labels field is empty. Without `OR labels IS EMPTY`
 * this query would silently skip every unlabelled item — which is most of them.
 * Both exclusions therefore live INSIDE that one group; a second, unguarded
 * exclusion anywhere in the query reintroduces the hole while still reading right.
 *
 * ⚠ And the group stays FLAT — `labels != a AND labels != b OR labels IS EMPTY`,
 * not `labels NOT IN (a, b) OR …`. Both forms are valid JQL and both were run
 * against a live Jira, returning identical result sets — so this is a
 * readability choice with no behaviour attached, and switching back would be
 * behaviour-neutral. Flat wins because the `NOT IN` form's nested parentheses
 * hide the `IS EMPTY` guard from any reader — human or test — that matches
 * innermost groups. `AND` binds tighter than `OR` in JQL, so the flat form means
 * `(a AND b) OR empty`, which is the intent.
 */
export const buildJql = ({ project = null, jql = null } = {}) => {
  if (jql) return jql;
  if (!project) {
    throw new Error(
      'the jira adapter needs either options.project or options.jql in ' +
        '.claude/queue.json. It will not guess a project: reading the wrong queue ' +
        'is worse than refusing to start.',
    );
  }
  const excluded = EXCLUDED_LABELS.map((label) => `labels != "${label}"`).join(' AND ');
  return (
    `project = ${project} AND statusCategory != Done ` +
    `AND (${excluded} OR labels IS EMPTY) ` +
    'ORDER BY priority DESC, created ASC'
  );
};

export const requireCredentials = (env = process.env) => {
  const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `the jira adapter needs ${missing.join(', ')} in the environment. ` +
        'Set them in your shell or your secret manager — never in a file in this repo.',
    );
  }
  const baseUrl = String(env.JIRA_BASE_URL).replace(/\/$/, '');
  // Basic auth carries the token in a trivially reversible header, so the
  // transport is part of the credential handling: a mis-set or tampered
  // JIRA_BASE_URL over http would put it on the wire in clear.
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new Error(
      `JIRA_BASE_URL must use https (got ${baseUrl.split(':')[0]}://…). Basic auth ` +
        'sends the API token on every request; over http it is readable in transit.',
    );
  }
  return { baseUrl, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN };
};

const request = async (route, { method = 'GET', body = null, env = process.env } = {}) => {
  const { baseUrl, email, token } = requireCredentials(env);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    // The status alone; never echo the response body, which can carry the token
    // back in an error envelope.
    throw new Error(`jira ${method} ${route} failed: ${response.status} ${response.statusText}`);
  }
  return response.status === 204 ? null : response.json();
};

// `description` is requested because the triage dedupe matches the fingerprint
// inside it. Without it the dedupe silently never matched, so every "queue empty"
// stop filed a fresh issue instead of incrementing the one already there.
//
// A LIST, not a comma-joined string: the replacement endpoint takes its arguments
// in a JSON body, where `fields` is an array. Measured, because the failure mode
// decides how hard this is to notice: sending the joined form the retired query
// parameter wanted answers `400 Invalid request payload`, not a 200 with empty
// fields. It fails loudly, so a wrong value here cannot sit undetected.
const FIELDS = ['summary', 'status', 'labels', 'priority', 'created', 'issuelinks', 'description'];

// --- the adapter contract ------------------------------------------------------

/**
 * Query fresh every time — the queue changes as the loop closes items and
 * unblocks their dependents, so a list read at the start of a run is wrong by the
 * second task. `issues` is the offline seam the tests use.
 */
export const listEligible = async ({
  issues = null,
  project = null,
  jql = null,
  limit = 100,
  env = process.env,
} = {}) => {
  // `issues` is the offline seam: the mapping is pure, so every shape it has to
  // handle is testable without a network or a credential.
  const response = issues ? { issues } : await search({ project, jql, limit, env });
  return (
    response.issues
      .map(toTicket)
      .filter((ticket) => ticket.state !== 'closed')
      // Deliberately a SECOND enforcement of the same list the query already
      // carries, and only here: `core.mjs` drops `triage` itself, with its own
      // stated reason, but nothing downstream knows about `operator-queue`. This
      // filter is what still holds when the query is bypassed — an `options.jql`
      // override, or a board whose labels were renamed. Both read EXCLUDED_LABELS,
      // so the two can disagree only by someone editing one of them.
      .filter((ticket) => !ticket.labels.some((label) => EXCLUDED_LABELS.includes(label)))
  );
};

/**
 * 🔴 `POST /rest/api/3/search/jql`, never `GET /rest/api/3/search` — the latter
 * was retired by Atlassian and answers `410 Gone`. Measured against a live Jira,
 * with the same credential answering `200` on `/rest/api/3/myself`, so it is the
 * path and not the auth. Both searching call sites (`listEligible` and the
 * `proposeTriage` dedupe) come through here, which is why one fix covers both.
 *
 * Not handled here on purpose: the response also carries `nextPageToken` for
 * cursor pagination, so a board with more open issues than `limit` still loses
 * its tail — as does a retry policy and a request timeout. Those belong together
 * in one change; half a pagination interface with nothing testing it is worse
 * than none.
 */
export const search = async ({ project = null, jql = null, limit = 100, env = process.env } = {}) =>
  request('/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql: buildJql({ project, jql }), maxResults: limit, fields: FIELDS },
    env,
  });

export const resolveBlockers = (ticket) => (ticket.blockedBy ?? []).filter((b) => !b.resolved);

/**
 * Claim it before the first file is edited, not when the PR opens: an item being
 * worked while it still reads as available is invisible to the human and
 * re-selectable by the very next query.
 */
export const claim = async (ticket, { transitionId = null, env = process.env } = {}) => {
  if (!transitionId) {
    const available = await request(`/rest/api/3/issue/${ticket.id}/transitions`, { env });
    const target = available.transitions.find(
      (transition) => statusCategory(transition.to ? { status: transition.to } : {}) === 'indeterminate',
    );
    if (!target) {
      throw new Error(
        `no in-progress transition available for ${ticket.id} — the board's workflow ` +
          'differs from the default. Pass options.transitionId.',
      );
    }
    transitionId = target.id;
  }
  await request(`/rest/api/3/issue/${ticket.id}/transitions`, {
    method: 'POST',
    body: { transition: { id: transitionId } },
    env,
  });
  return { ok: true };
};

export const comment = async (ticket, body, { env = process.env } = {}) => {
  await request(`/rest/api/3/issue/${ticket.id}/comment`, {
    method: 'POST',
    body: {
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
    },
    env,
  });
  return { ok: true };
};

export const close = async (ticket, { prUrl = null, transitionId = null, env = process.env } = {}) => {
  await comment(ticket, prUrl ? `Landed in ${prUrl}.` : 'Closed by the run.', { env });
  if (transitionId) {
    await request(`/rest/api/3/issue/${ticket.id}/transitions`, {
      method: 'POST',
      body: { transition: { id: transitionId } },
      env,
    });
  }
  return { ok: true, transitioned: Boolean(transitionId) };
};

/**
 * Escalate: the diagnosis goes on the item and the item is labelled so the next
 * selection cannot pick it up. It stays IN PROGRESS on purpose — moving it back to
 * a selectable state is how one stuck task gets worked three times.
 */
export const escalate = async (ticket, diagnosis, { env = process.env } = {}) => {
  await comment(ticket, diagnosis, { env });
  await request(`/rest/api/3/issue/${ticket.id}`, {
    method: 'PUT',
    body: { update: { labels: [{ add: 'escalated' }] } },
    env,
  });
  return { ok: true };
};

/**
 * 🔴 INVARIANT 2: the agent never creates its own work. A proposal is labelled
 * `triage`, which `buildJql` excludes explicitly, and it never receives a ready
 * marker — so the only route from proposal to work runs through a human.
 */
export const triageItemFor = (proposal) => {
  validateProposal(proposal);
  const fingerprint = fingerprintOf(proposal);
  return {
    title: `proposal: ${proposal.change}`,
    body: [
      `- finding — ${proposal.finding}`,
      `- part to change — ${proposal.part}`,
      `- proposed change — ${proposal.change}`,
      `- how the next run proves it — ${proposal.proof}`,
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

/** File the proposal, or increment the one already carrying this fingerprint. */
export const proposeTriage = async (
  proposal,
  { project = null, existing = null, env = process.env } = {},
) => {
  const item = triageItemFor(proposal);
  // Compared against the issue's DESCRIPTION, which is where the fingerprint was
  // written. The previous version mapped candidates through `toTicket` — which
  // emits no body at all — so the predicate was always false and twenty identical
  // stops filed twenty issues against the tracker.
  const found =
    existing ??
    (await search({ jql: 'labels = triage ORDER BY created DESC', env })).issues.map((issue) => ({
      id: issue.key,
      body: descriptionTextOf(issue),
    }));
  const duplicate = duplicateOf(item, found);

  if (duplicate) {
    await comment(duplicate, `Seen again (fingerprint ${item.fingerprint}). Incrementing.`, { env });
    return { ok: true, incremented: duplicate.id, item };
  }
  if (!project) {
    throw new Error('filing a triage proposal needs options.project');
  }
  await request('/rest/api/3/issue', {
    method: 'POST',
    body: {
      fields: {
        project: { key: project },
        summary: item.title,
        issuetype: { name: 'Task' },
        labels: item.labels,
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: item.body }] }],
        },
      },
    },
    env,
  });
  return { ok: true, filed: item.title, item };
};
