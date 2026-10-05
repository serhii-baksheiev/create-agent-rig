// RP-279 — the Jira half of the Spec Kit bridge. Everything about WHICH
// tasks exist and HOW they depend on each other is the GitHub target's own
// compilation, reused unchanged from `spec-kit-import.mjs`
// (`parseTasks`/`dependenciesFor`/`reportFor`/`PROJECTED_LABEL` —
// `invariants.md`: one mechanism, one implementation). This file is only
// what differs for Jira: a project key read from `.claude/queue.json`,
// credentials from the environment, and native "Blocks"/"is blocked by"
// issue links in place of a GitHub body line.
//
// The one piece deliberately NOT reused is `creationOrder` itself: its
// "whole ready batch at once" tie-break is the GitHub target's own observed
// behaviour (a committed contract this task must not change), and Jira's
// native dependency links make write ORDER directly observable through
// `listEligible`/`selectNext` the moment this run ends — a tie-break that
// reorders an independent task ahead of a dependent one the file lists
// first would let that independent task jump the dependent in the very
// next selection, for no reason a reader of tasks.md could find. This
// file's own `creationOrderForJira` below creates each task the instant its
// own dependencies are satisfied, scanning from the START of tasks.md every
// time — the same topological guarantee, with file order preserved
// wherever the graph allows it. Pinned in `test/template/spec-kit-import-jira.test.ts`
// (absent in a generated rig) › "an imported dependent is held by
// listEligible and selectNext until its blocker is done".
//
// `importSpecKit` in `spec-kit-import.mjs` is the only public entry point —
// it dynamically imports `importSpecKitToJira` here only once a caller asks
// for `target: 'jira'`, which is also what keeps the two modules' mutual
// reuse from being a circular STATIC import.
import { join } from 'node:path';
import { dependenciesFor, parseTasks, PROJECTED_LABEL, reportFor } from './spec-kit-import.mjs';
import {
  BLOCKED_BY,
  BLOCKS,
  boundedSummary,
  projectKeyOf,
  requireCredentials,
  request,
  search,
  toTicket,
} from './jira.mjs';
import { loadConfig } from './queue-config.mjs';

const MARKER_PREFIX = 'rig-spec-kit-task:';
const markerOf = (identity) => `${MARKER_PREFIX}${identity}`;
const identityOfMarker = (text) => (text.startsWith(MARKER_PREFIX) ? text.slice(MARKER_PREFIX.length) : null);

const PERMISSIONS_NEEDED = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'LINK_ISSUES'];

/**
 * A topological sort of `tasks` that creates each one the instant its own
 * dependencies are satisfied, scanning from the start of tasks.md every time
 * — see this file's header for why this differs from the shared
 * `creationOrder` in `spec-kit-import.mjs`. Bounded by the same `MAX_TASKS`
 * `parseTasks` already enforces, so the repeated full-list scan below is
 * capped, not unbounded.
 */
const creationOrderForJira = (tasks) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependencies)]));
  const ordered = [];
  while (remaining.size > 0) {
    const readyId = [...remaining.keys()].find((id) => remaining.get(id).size === 0);
    if (readyId === undefined) {
      throw new Error('Spec Kit task dependencies contain a cycle; refusing before Jira writes.');
    }
    ordered.push(byId.get(readyId));
    remaining.delete(readyId);
    for (const dependencies of remaining.values()) dependencies.delete(readyId);
  }
  return ordered;
};

/** The same Atlassian-document shape `jira.mjs`'s own `comment`/`proposeTriage` build, multi-paragraph. */
const adfOf = (paragraphs) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

/** The description's paragraphs, flattened to their first text run each. */
const paragraphsOf = (description) => {
  const content = Array.isArray(description?.content) ? description.content : [];
  return content.map((paragraph) => {
    const inline = Array.isArray(paragraph?.content) ? paragraph.content[0] : null;
    return typeof inline?.text === 'string' ? inline.text : '';
  });
};

/**
 * One project configuration, read exactly the way the queue CLI itself does —
 * including the board selector — so a Jira-target import can never read a
 * different project than the one `queue/index.mjs next` would select against.
 * `invariants.md`: one mechanism, one implementation.
 */
const projectConfigFor = (projectRoot) => {
  const configPath = join(projectRoot, '.claude', 'queue.json');
  const config = loadConfig(configPath);
  if (config.adapter !== 'jira') {
    throw new Error(
      `spec-kit --to jira needs .claude/queue.json to configure the jira adapter ` +
        `(found adapter: ${JSON.stringify(config.adapter ?? null)}). Set ` +
        '{ "adapter": "jira", "options": { "project": "<KEY>" } }.',
    );
  }
  const project = config.options?.project ?? null;
  const jql = config.options?.jql ?? null;
  if (!project && !jql) {
    throw new Error(
      'spec-kit --to jira needs a Jira project key at options.project (or options.jql) in ' +
        '.claude/queue.json.',
    );
  }
  return { project, jql };
};

/**
 * `mypermissions`, the "Blocks" link type, and `createmeta`'s own exposure of
 * `issuelinks` on the Task issue type — every one of them a READ, run before
 * any write so a missing capability is a refusal, never a half-applied
 * import. Returns the link type's own name, which is what every subsequent
 * write below sends back to Jira.
 */
const preflight = async ({ projectKey, env }) => {
  const permissionResponse = await request(
    `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}` +
      `&permissions=${PERMISSIONS_NEEDED.join(',')}`,
    { env },
  );
  const missing = PERMISSIONS_NEEDED.filter(
    (name) => permissionResponse?.permissions?.[name]?.havePermission !== true,
  );
  if (missing.length > 0) {
    throw new Error(
      `jira spec-kit import: missing ${missing.join(', ')} permission(s) on project ` +
        `${projectKey}; refusing before writing anything.`,
    );
  }

  const linkTypeResponse = await request('/rest/api/3/issueLinkType', { env });
  const linkTypes = Array.isArray(linkTypeResponse?.issueLinkTypes)
    ? linkTypeResponse.issueLinkTypes
    : [];
  const blocksType = linkTypes.find(
    (type) => BLOCKS.test(String(type?.outward ?? '')) && BLOCKED_BY.test(String(type?.inward ?? '')),
  );
  if (!blocksType) {
    throw new Error(
      'jira spec-kit import: no issue link type matches "blocks"/"is blocked by" — ' +
        'dependencies cannot be projected as native links; refusing before writing anything.',
    );
  }

  const createmeta = await request(
    `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}` +
      '&issuetypeNames=Task&expand=projects.issuetypes.fields',
    { env },
  );
  const project = (createmeta?.projects ?? []).find((entry) => entry?.key === projectKey);
  const taskType = (project?.issuetypes ?? []).find((entry) => entry?.name === 'Task');
  if (!taskType?.fields?.issuelinks) {
    throw new Error(
      `jira spec-kit import: createmeta for project ${projectKey} does not expose issuelinks ` +
        'on the Task issue type; dependencies cannot be projected. Refusing before writing ' +
        'anything.',
    );
  }

  return { linkTypeName: blocksType.name };
};

/**
 * The rig-spec-kit-labelled hits, read by the exact query the dry-run report
 * also pins. `reportRepeatedTokenTruncation: true` — this importer is about
 * to WRITE from what it reads, so a server that repeats an ambiguous page
 * token is treated as a truncated read rather than a genuinely empty tail
 * (`jira.mjs`'s own `search` defaults that ambiguity the other way for every
 * other caller — see its header for why).
 */
const searchProjected = async ({ projectKey, env }) => {
  const jql = `project = ${projectKey} AND labels = "${PROJECTED_LABEL}"`;
  const response = await search({
    project: projectKey,
    jql,
    env,
    reportRepeatedTokenTruncation: true,
  });
  if (response.truncated) {
    throw new Error(
      `jira spec-kit import: the ${PROJECTED_LABEL} search for project ${projectKey} was ` +
        'truncated — more pages existed than were read. Refusing before writing anything.',
    );
  }
  return response.issues;
};

/**
 * Re-read every search hit BY KEY and trust only what the fresh read shows —
 * a stale search index can list a label that the issue no longer carries, and
 * only the re-read is this bridge's ownership proof. Two owners of the same
 * identity is refused as ambiguous, never resolved by picking one.
 */
const reReadOwned = async (hits, wantedIdentities, env) => {
  const index = new Map();
  for (const hit of hits) {
    const key = hit.key;
    const fresh = await request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { env });
    const labels = fresh?.fields?.labels ?? [];
    if (!labels.includes(PROJECTED_LABEL)) continue;
    const identity = identityOfMarker(paragraphsOf(fresh?.fields?.description)[0] ?? '');
    if (!identity || !wantedIdentities.has(identity)) continue;
    const matches = index.get(identity) ?? [];
    matches.push({ key, issue: fresh });
    index.set(identity, matches);
  }
  for (const [identity, matches] of index) {
    if (matches.length > 1) throw new Error(`ambiguous existing projection for ${identity}.`);
  }
  return new Map([...index].map(([identity, matches]) => [identity, matches[0]]));
};

const plannedChange = (task, owned) => {
  if (!owned) return { identity: task.identity, action: 'create', dependencies: dependenciesFor(task) };
  const marker = markerOf(task.identity);
  const currentSummary = owned.issue.fields?.summary ?? '';
  const currentParagraphs = paragraphsOf(owned.issue.fields?.description);
  const changed =
    currentSummary !== boundedSummary(task.title) ||
    currentParagraphs[0] !== marker ||
    currentParagraphs[1] !== task.title;
  return {
    identity: task.identity,
    action: changed ? 'update' : 'unchanged',
    dependencies: dependenciesFor(task),
  };
};

export const importSpecKitToJira = async ({ projectRoot, tasksPath = null, dryRun = false }) => {
  const env = process.env;
  // Credentials first: a project missing from `.claude/queue.json` and a
  // missing credential are two different refusals, and the CLI's own usage
  // gate (`test/template/spec-kit-import.test.ts`, absent in a generated rig, ›
  // "accepts --to jira past the CLI usage gate, refusing only for a missing
  // Jira credential") must surface the credential one even when no config
  // exists yet.
  requireCredentials(env);

  const { project, jql } = projectConfigFor(projectRoot);
  const projectKey = projectKeyOf({ project, jql });

  const { tasks } = parseTasks({ projectRoot, tasksPath });
  const ordered = creationOrderForJira(tasks); // also validates the dependency graph has no cycle

  const { linkTypeName } = await preflight({ projectKey, env });

  const hits = await searchProjected({ projectKey, env });
  const wanted = new Set(tasks.map((task) => task.identity));
  const owned = await reReadOwned(hits, wanted, env);
  const keyToIdentity = new Map([...owned].map(([identity, entry]) => [entry.key, identity]));

  // Stale-link refusal, before any write: a Blocks link between two issues
  // this bridge owns that tasks.md no longer lists is drift this importer
  // must name and refuse, never silently delete.
  for (const task of tasks) {
    const entry = owned.get(task.identity);
    if (!entry) continue;
    const ticket = toTicket({ key: entry.key, fields: entry.issue.fields });
    const expectedDependencies = new Set(dependenciesFor(task));
    for (const blocker of ticket.blockedBy) {
      const blockerIdentity = keyToIdentity.get(blocker.id);
      if (blockerIdentity && !expectedDependencies.has(blockerIdentity)) {
        throw new Error(
          `jira spec-kit import: ${task.identity} (${entry.key}) carries a Blocks link to ` +
            `${blockerIdentity} (${blocker.id}) that tasks.md no longer lists; the link is ` +
            'stale and the import refuses before writing anything.',
        );
      }
    }
  }

  if (dryRun) {
    const planned = tasks.map((task) => plannedChange(task, owned.get(task.identity) ?? null));
    return reportFor(true, tasks, planned, 'jira');
  }

  const keyOf = new Map([...owned].map(([identity, entry]) => [identity, entry.key]));
  const createdThisRun = new Set();
  const createdKeys = [];
  for (const task of ordered) {
    if (keyOf.has(task.identity)) continue;
    const blockerKeys = dependenciesFor(task).map((dependency) => keyOf.get(dependency));
    const marker = markerOf(task.identity);
    const body = {
      fields: {
        project: { key: projectKey },
        issuetype: { name: 'Task' },
        summary: boundedSummary(task.title),
        description: adfOf([marker, task.title]),
        labels: [PROJECTED_LABEL],
      },
      ...(blockerKeys.length
        ? {
            update: {
              issuelinks: blockerKeys.map((blockerKey) => ({
                add: { type: { name: linkTypeName }, outwardIssue: { key: blockerKey } },
              })),
            },
          }
        : {}),
    };
    let created;
    try {
      created = await request('/rest/api/3/issue', { method: 'POST', body, env });
    } catch (error) {
      // Never retried, and never echoing task text: the keys already created
      // are the whole of what a caller needs to recover by hand.
      throw new Error(
        `jira spec-kit import: failed creating the issue for ${task.identity} after creating ` +
          `${createdKeys.join(', ') || 'no issues'} — ${error.message}`,
        { cause: error },
      );
    }
    const key = created?.key;
    if (typeof key !== 'string' || key === '') {
      throw new Error(
        `jira spec-kit import: the create response for ${task.identity} carried no issue key ` +
          `after creating ${createdKeys.join(', ') || 'no issues'}.`,
      );
    }
    keyOf.set(task.identity, key);
    createdThisRun.add(task.identity);
    createdKeys.push(key);
  }

  const changes = [];
  for (const task of tasks) {
    if (createdThisRun.has(task.identity)) {
      changes.push({ identity: task.identity, action: 'create', dependencies: dependenciesFor(task) });
      continue;
    }
    const entry = owned.get(task.identity);
    const key = keyOf.get(task.identity);
    const marker = markerOf(task.identity);
    const desiredSummary = boundedSummary(task.title);
    const desiredParagraphs = [marker, task.title];
    const currentSummary = entry.issue.fields?.summary ?? '';
    const currentParagraphs = paragraphsOf(entry.issue.fields?.description);
    const changed =
      currentSummary !== desiredSummary ||
      currentParagraphs[0] !== desiredParagraphs[0] ||
      currentParagraphs[1] !== desiredParagraphs[1];
    if (changed) {
      await request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { fields: { summary: desiredSummary, description: adfOf(desiredParagraphs) } },
        env,
      });
    }

    const ticket = toTicket({ key, fields: entry.issue.fields });
    const existingBlockers = new Set(ticket.blockedBy.map((blocker) => blocker.id));
    for (const dependencyIdentity of dependenciesFor(task)) {
      const blockerKey = keyOf.get(dependencyIdentity);
      if (!blockerKey || existingBlockers.has(blockerKey)) continue;
      await request('/rest/api/3/issueLink', {
        method: 'POST',
        body: {
          type: { name: linkTypeName },
          inwardIssue: { key },
          outwardIssue: { key: blockerKey },
        },
        env,
      });
      // Read the dependent back and require the link to actually be there —
      // a POST answering 2xx is not proof Jira applied the link this importer
      // asked for.
      const after = await request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { env });
      const afterTicket = toTicket({ key, fields: after?.fields ?? {} });
      if (!afterTicket.blockedBy.some((blocker) => blocker.id === blockerKey)) {
        throw new Error(
          `jira spec-kit import: added a Blocks link from ${key} to ${blockerKey} but the ` +
            're-read issue does not show it; refusing to continue.',
        );
      }
    }

    changes.push({
      identity: task.identity,
      action: changed ? 'update' : 'unchanged',
      dependencies: dependenciesFor(task),
    });
  }

  return reportFor(false, tasks, changes, 'jira');
};
