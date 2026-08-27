// Queue adapter: Jira issues, via the REST API.
// All upstream test pointers in this script name the generator suite, absent in a generated rig.
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
//     { "adapter": "jira", "options": { "project": "ABC", "owner": "my-repo" } }
//
// `owner` names this checkout for the `owner-<name>` label (AR-132): an item
// marked for another repository is held, and a checkout that declares no
// owner holds every marked item, since it cannot confirm a match.
import { duplicateOf, fingerprintOf, validateProposal, ownerOfLabels, lifecycleOf } from './core.mjs';
import { withAsOf } from './as-of.mjs';
import { recordEscalation, recordTakeUp } from '../run-state.mjs';

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
    // English names first; a localised board ("Höchste", "Mittel") falls back
    // to the numeric priority id. Neither → 999.
    priority:
      PRIORITY[String(fields.priority?.name ?? '').toLowerCase()] ??
      (Number.isFinite(Number(fields.priority?.id)) && Number(fields.priority?.id) > 0
        ? Number(fields.priority?.id)
        : 999),
    createdAt: toIso(fields.created),
    // The take-up marker for revalidation at SELECT (`core.mjs` › revalidationOf):
    // the tracker's own last-modified field. That it moves on every status
    // change, edit and comment is Jira's contract, assumed and not checked
    // here. `null` when the search did not carry it — never `''`, which would
    // compare equal to itself and read as "unchanged" where the truth is "not
    // looked".
    updatedAt: toIso(fields.updated),
    // Flattened from the document description — the same text this adapter
    // already reads internally, now visible to the shared hygiene checks.
    body: descriptionTextOf(issue) || null,
    triage: labels.includes('triage'),
    trigger: labels.includes('trigger-auto')
      ? 'auto'
      : labels.includes('trigger-human')
        ? 'human'
        : null,
    // The repository this item belongs to (AR-132): `owner-<name>`, or null.
    owner: ownerOfLabels(labels),
    // The lifecycle and the scheduling flag (AR-144): `lifecycleOf` above the seam
    // owns the semantics; this adapter only hands it the labels.
    ...lifecycleOf(labels),
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
/**
 * A Jira project key: one uppercase letter, then up to nine of [A-Z0-9_].
 * Exported so the refusal below can name the rule it applied (AR-51).
 */
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

/**
 * The one place `options.project` and `options.jql` from `.claude/queue.json`
 * reach the query. Both used to be interpolated raw (AR-51): a committed
 * `queue.json` — a file a pull request can edit — could make this adapter read
 * another board, or anything the JQL grammar allows. A project key is now
 * validated against PROJECT_KEY, and an explicit `jql` must begin with
 * `project = <KEY>` — the same key when `options.project` is also given — so
 * an override has to NAME this board. ⚠ Naming is not confinement: a query
 * that leads with `project = AR` may still say `OR project = X` after it, and
 * the credential's own scope is what bounds that. The residual is accepted
 * because `.claude/queue.json` is part of the rulebook (`guard-rulebook`) and
 * a declared elevated path, so a change widening it reaches the model lane.
 */
/** The project key a config names — options.project, or the key options.jql leads with. */
export const projectKeyOf = ({ project = null, jql = null } = {}) => {
  buildJql({ project, jql }); // the same refusals, once
  if (project) return String(project);
  return /^\s*project\s*=\s*([A-Z][A-Z0-9_]{1,9})\b/.exec(String(jql))[1];
};

export const buildJql = ({ project = null, jql = null } = {}) => {
  if (project !== null && project !== undefined && !PROJECT_KEY.test(String(project))) {
    throw new Error(
      `options.project ${JSON.stringify(project)} is not a Jira project key — it must match ` +
        `${PROJECT_KEY.source}. It is interpolated into JQL, so anything else is refused, not quoted.`,
    );
  }
  if (jql) {
    const lead = /^\s*project\s*=\s*([A-Z][A-Z0-9_]{1,9})\b/.exec(String(jql));
    if (!lead) {
      throw new Error(
        'options.jql must begin with `project = <KEY>` (a key matching ' +
          `${PROJECT_KEY.source}) — a query that does not name its project can read any board.`,
      );
    }
    if (project && lead[1] !== project) {
      throw new Error(
        `options.jql names project ${lead[1]} while options.project is ${project} — an override ` +
          'may narrow the query, never point it at another board.',
      );
    }
    return jql;
  }
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

/** Statuses worth one more try: rate-limited, or a gateway that will be back. */
const TRANSIENT = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 20_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The wait before the next attempt: `Retry-After` in seconds when the server
 * names one, otherwise 500 ms doubling per attempt. Bounded by the attempt cap.
 */
const MAX_RETRY_AFTER_MS = 60_000;
const retryDelayMs = (response, attempt) => {
  // Seconds form only; the HTTP-date form is not parsed and falls to backoff
  // (› "falls back to the backoff when Retry-After is an HTTP-date, which it
  // does not parse"). Capped, because a header is input like any other:
  // `Retry-After: 86400` must not sleep the loop for a day (› "caps Retry-After
  // so a hostile header cannot sleep the loop for a day").
  const header = Number(response?.headers?.get?.('Retry-After'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_RETRY_AFTER_MS);
  return 500 * 2 ** (attempt - 1);
};

/**
 * One HTTP call to Jira, with the three things AR-54 added to it:
 *
 * - a timeout (`timeoutMs`, default 20 s) through an AbortController — a stalled
 *   connection used to block selection forever, and a loop that cannot read its
 *   queue must stop, not hang;
 * - a retry on 429/502/503/504, at most `MAX_ATTEMPTS`, honouring `Retry-After`;
 *   401/403/404 and every other status fail at once — a bad credential is not
 *   transient, and retrying it only delays the diagnosis;
 * - `retry.sleep` injectable, so a test measures the delay it would have waited
 *   instead of waiting it.
 *
 * Pinned in the generator's `test/template/queue-jira.test.ts` (absent in a
 * generated rig) › "hands fetch an AbortSignal", › "rejects naming the timeout
 * and the route when fetch never resolves", › "a 429 followed by a 200 yields
 * the 200 body", › "sleeps for the Retry-After the 429 carried, in
 * milliseconds", › "gives up after four consecutive 503s, naming the status and
 * the attempts" and › "does not retry a 401 — a bad credential is not transient".
 */
const request = async (
  route,
  { method = 'GET', body = null, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, retry = {} } = {},
) => {
  const { baseUrl, email, token } = requireCredentials(env);
  const sleep = retry.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let payload = null;
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      // The body is read INSIDE the timed region: headers can arrive and the
      // body then stall, which is the same hung connection with a 200 on it
      // (› "keeps the timeout armed while the body is read").
      if (response.ok && response.status !== 204) payload = await response.json();
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw new Error(`jira ${method} ${route} timed out after ${timeoutMs} ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return payload;
    if (TRANSIENT.has(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    // The status alone; never echo the response body, which can carry the token
    // back in an error envelope.
    const attempts = TRANSIENT.has(response.status) ? ` after ${attempt} attempts` : '';
    throw new Error(`jira ${method} ${route} failed: ${response.status} ${response.statusText}${attempts}`);
  }
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
const FIELDS = [
  'summary',
  'status',
  'labels',
  'priority',
  'created',
  'updated',
  'issuelinks',
  'description',
];

// --- the adapter contract ------------------------------------------------------

/**
 * Query fresh every time — the queue changes as the loop closes items and
 * unblocks their dependents, so a list read at the start of a run is wrong by the
 * second task. `issues` is the offline seam the tests use. Since AR-54 `limit`
 * is the PAGE size, not a result cap: `search` walks every page up to its own
 * `hardCap`, which this function leaves at the default (› "returns both pages
 * as one list").
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
 * Pages through `nextPageToken` until the server sends none, or `hardCap`
 * issues (default 1000) are in hand, or `maxPages` requests (default 100) have
 * been made — each cap is announced on stderr, never
 * silent, because a board whose tail is dropped is exactly the board the loop
 * would otherwise believe it had read. `timeoutMs` and `retry` travel down to
 * every page. Pinned in the generator's `test/template/queue-jira.test.ts`
 * (absent in a generated rig) › "returns both pages as one list", › "sends the
 * token from page 1 in the body of the request for page 2" and › "stops at
 * hardCap and says on stderr that the list was capped".
 */
export const search = async ({
  project = null,
  jql = null,
  limit = 100,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retry = {},
  hardCap = 1000,
  maxPages = 100,
} = {}) => {
  const query = buildJql({ project, jql });
  const issues = [];
  // Bounds beside hardCap, because a cap on issues alone is no bound at all
  // against a server that repeats a token: a token equal to the one just sent
  // ends the walk, and so does `maxPages` (default 100 requests), each with a
  // stderr line. An EMPTY page with a fresh token is NOT a stop — the enhanced
  // search endpoint may return short or empty pages while later pages exist,
  // and stopping there drops a real tail (› "keeps walking past an empty page
  // that carries a fresh token", › "stops paging when a page brings no issues,
  // even if the token repeats", › "caps the number of requests outright, and
  // says so on stderr").
  let nextPageToken = null;
  let pages = 0;
  do {
    pages += 1;
    const page = await request('/rest/api/3/search/jql', {
      method: 'POST',
      body: {
        jql: query,
        maxResults: limit,
        fields: FIELDS,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
      env,
      timeoutMs,
      retry,
    });
    const received = page?.issues ?? [];
    issues.push(...received.slice(0, Math.max(0, hardCap - issues.length)));
    const sent = nextPageToken;
    nextPageToken = page?.isLast === true ? null : (page?.nextPageToken ?? null);
    if (nextPageToken && nextPageToken === sent) {
      process.stderr.write(
        `jira search: the server repeated page token ${JSON.stringify(sent)} — ` +
          'stopping the walk; the tail of this board may not have been read\n',
      );
      break;
    }
    if (nextPageToken && pages >= maxPages) {
      process.stderr.write(
        `jira search: capped at ${maxPages} requests with more pages available — ` +
          'the tail of this board was not read; raise maxPages or narrow the JQL\n',
      );
      break;
    }
    if (issues.length >= hardCap && nextPageToken) {
      process.stderr.write(
        `jira search: capped at ${hardCap} issues with more pages available — ` +
          'the tail of this board was not read; raise hardCap or narrow the JQL\n',
      );
      break;
    }
  } while (nextPageToken);
  return { issues };
};

/**
 * One item by key, mapped raw — closed included. `listEligible` drops closed
 * items because selection must never take one; the close point needs to see
 * exactly that one. Honours the same offline `issues` seam.
 */
export const find = async (id, { issues = null, env = process.env } = {}) => {
  if (issues) {
    return issues.map(toTicket).find((ticket) => String(ticket.id) === String(id)) ?? null;
  }
  // 🔴 By key, never through `search`: `buildJql` carries `statusCategory != Done`
  // for selection's sake, so a search can never return the closed item this
  // point exists to see. A 404 is "the tracker has no such item" — `null`;
  // every other failure is raised as it is.
  try {
    const issue = await request(
      `/rest/api/3/issue/${encodeURIComponent(String(id))}?fields=${FIELDS.join(',')}`,
      { env },
    );
    return issue ? toTicket(issue) : null;
  } catch (error) {
    if (/ 404 /.test(String(error?.message))) return null;
    throw error;
  }
};

export const resolveBlockers = (ticket) => (ticket.blockedBy ?? []).filter((b) => !b.resolved);

/**
 * Claim it before the first file is edited, not when the PR opens: an item being
 * worked while it still reads as available is invisible to the human and
 * re-selectable by the very next query.
 */
/**
 * Re-record the item's marker after a write of this adapter's own (AR-140).
 *
 * Every write here — a claim, a comment, a close, an escalation — moves the
 * tracker's `updated`, and the next revalidation compared against the take-up
 * from before it — the generator's journal records one run whose every
 * BEFORE_PR catch was a hold on its own comment (`revalidation-report.mjs`
 * over that run). So the marker is read back after the write
 * and recorded as the take-up in the declared run; a hold that still fires is
 * a move by something other than this adapter.
 *
 * ⚠ Limit: only writes made THROUGH this adapter re-baseline. A comment the
 * session posts by another route — a REST call by hand, a connector — moves
 * the marker like anyone else's, and the next check holds on it.
 *
 * Best-effort, like `proposeTriage`'s baseline: the write has landed by now,
 * and a read-back the tracker refused or a stale run directory is announced on
 * stderr, never thrown — a thrown write is retried and lands twice.
 */
const recordMarker = (ticket, updatedAt, env) => {
  try {
    recordTakeUp(env.RIG_RUN_DIR, { id: ticket.id, updatedAt });
  } catch (error) {
    process.stderr.write(
      `${ticket.id}: the write landed, but its marker was NOT re-recorded in ` +
        `${env.RIG_RUN_DIR} — ${error.message}\n`,
    );
  }
};

const rebaseline = async (ticket, env) => {
  if (!env?.RIG_RUN_DIR) return;
  let updatedAt;
  try {
    const after = await request(`/rest/api/3/issue/${ticket.id}?fields=updated`, { env });
    updatedAt = toIso(after?.fields?.updated);
  } catch (error) {
    process.stderr.write(
      `${ticket.id}: the write landed, but its marker was NOT re-recorded in ` +
        `${env.RIG_RUN_DIR} — ${error.message}\n`,
    );
    return;
  }
  recordMarker(ticket, updatedAt, env);
};

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
  await rebaseline(ticket, env);
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
  await rebaseline(ticket, env);
  return { ok: true };
};

/**
 * 🔴 `transitioned` is read back from the tracker, never inferred from the
 * argument. The first version returned `Boolean(transitionId)` — a fact about
 * the call, reported as a fact about the issue — so a transition the workflow
 * rejected, or one that landed in a status outside the `done` category, was
 * published as a close (AR-135).
 */
export const close = async (ticket, { prUrl = null, transitionId = null, env = process.env } = {}) => {
  await comment(ticket, prUrl ? `Landed in ${prUrl}.` : 'Closed by the run.', { env });
  if (transitionId) {
    await request(`/rest/api/3/issue/${ticket.id}/transitions`, {
      method: 'POST',
      body: { transition: { id: transitionId } },
      env,
    });
  }
  // One read-back for both facts the close needs: the status that proves the
  // transition, and the marker the write produced (AR-140) — `comment` above
  // already re-baselined once; this is the read after the transition.
  const after = await request(`/rest/api/3/issue/${ticket.id}?fields=status,updated`, { env });
  const fields = after?.fields ?? {};
  // Through the same announce-never-throw path as `rebaseline`: the round
  // that inlined `recordTakeUp` here reintroduced a throw on a stale run
  // directory after the transition had landed.
  if (env?.RIG_RUN_DIR) recordMarker(ticket, toIso(fields.updated), env);
  return {
    ok: true,
    transitioned: statusCategory(fields) === 'done',
    status: fields.status?.name ?? null,
  };
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
  await rebaseline(ticket, env);
  // Counted through the one recorder, never a counter of this adapter's own —
  // "twice in a row" has to mean the same thing on every tracker.
  recordEscalation(env.RIG_RUN_DIR);
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
      ...(proposal.measured ? [`- measured — ${proposal.measured}`, `- inferred — ${proposal.inferred}`] : []),
      '',
      `fingerprint: ${fingerprint}`,
      ...(proposal.asOf ? [`asOf: ${proposal.asOf}`] : []),
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
/**
 * The proposals on file, as `{ id, body }` — every `triage`-labelled issue, the
 * body being its DESCRIPTION, which is where the fingerprint and `asOf` were
 * written. An earlier dedupe mapped candidates through `toTicket` — which emits
 * no body at all — so the predicate was always false and twenty identical stops
 * filed twenty issues against the tracker.
 */
export const listProposals = async ({
  existing = null,
  project = null,
  jql = null,
  env = process.env,
  retry = {},
} = {}) => {
  if (existing) return existing;
  // Project-qualified, like every query this adapter sends (AR-51): the key is
  // options.project, or the one options.jql leads with — `buildJql` refuses
  // both when they disagree, so the triage query can only read this board.
  const key = projectKeyOf({ project, jql });
  const response = await search({ jql: `project = ${key} AND labels = triage ORDER BY created DESC`, env, retry });
  return response.issues.map((issue) => ({ id: issue.key, body: descriptionTextOf(issue) }));
};

export const proposeTriage = async (
  rawProposal,
  { project = null, jql = null, existing = null, env = process.env, retry = {} } = {},
) => {
  const proposal = withAsOf(rawProposal);
  const item = triageItemFor(proposal);
  const duplicate = duplicateOf(item, await listProposals({ existing, project, jql, env, retry }));

  if (duplicate) {
    await comment(duplicate, `Seen again (fingerprint ${item.fingerprint}). Incrementing.`, { env });
    return { ok: true, incremented: duplicate.id, item };
  }
  if (!project) {
    throw new Error('filing a triage proposal needs options.project');
  }
  const created = await request('/rest/api/3/issue', {
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
  // The proposal's own baseline (AR-138): its marker as filed, recorded as a
  // take-up in the run that filed it, so the next run that is offered it
  // compares against something. Read back rather than assumed — the marker is
  // the tracker's, and `created` carries only the key. No run directory →
  // nothing recorded, and the proposal is still filed.
  //
  // 🔴 Best-effort, and it says so: the proposal is FILED by now, and a throw
  // here — a read-back the tracker refused, a stale or unwritable run
  // directory in `updateState` — would tell the caller the filing failed when
  // it succeeded, and the natural response (file again) double-files. The same
  // defect `recordEscalation` closes for escalations; announced on stderr,
  // because a baseline silently missing reads as a first sight later.
  const id = created?.key ?? null;
  if (id && env.RIG_RUN_DIR) {
    try {
      const after = await request(`/rest/api/3/issue/${id}?fields=updated`, { env });
      recordTakeUp(env.RIG_RUN_DIR, { id, updatedAt: toIso(after?.fields?.updated) });
    } catch (error) {
      process.stderr.write(
        `proposeTriage: ${id} is filed, but its baseline was NOT recorded in ` +
          `${env.RIG_RUN_DIR} — ${error.message}\n`,
      );
    }
  }
  return { ok: true, filed: item.title, id, item };
};
