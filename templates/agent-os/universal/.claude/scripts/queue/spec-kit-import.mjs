// A deliberately narrow Spec Kit bridge: one tasks.md becomes GitHub Issues.
// It does not select, claim, or schedule work. GitHub's ordinary queue remains
// the authority that reads the dependency projection at runtime.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { sanitizeDiagnostic } from '../reconcile-external-prs.mjs';
import { boundedSummary } from './jira.mjs';

const MAX_TASKS_BYTES = 1024 * 1024;
const MAX_TASKS = 1000;
const MAX_TASK_DESCRIPTION_BYTES = 64 * 1024;
// GitHub refuses a longer issue title; the full task text stays in the body.
const MAX_GITHUB_TITLE_LENGTH = 256;
const titleOf = (task) => boundedSummary(task.title, MAX_GITHUB_TITLE_LENGTH);
// Exported — RP-279's `spec-kit-jira.mjs` writes the identical label on its
// own projected issues, so the two targets cannot drift onto two different
// spellings of "this is managed by Rig Spec Kit import" (`invariants.md`: one
// mechanism, one implementation).
export const PROJECTED_LABEL = 'rig-spec-kit';
// The GitHub queue adapter writes these labels during normal lifecycle
// transitions. A fresh Spec Kit projection must provision them before it
// creates work that a controller can claim, escalate, or route to triage.
const REQUIRED_LABELS = Object.freeze([
  { name: 'in-progress', color: '0E8A16', description: 'Claimed by a Rig controller' },
  { name: 'escalated', color: 'D93F0B', description: 'Needs a recorded diagnosis before continuation' },
  { name: 'triage', color: 'FBCA04', description: 'Proposal awaiting operator disposition' },
  { name: PROJECTED_LABEL, color: '0E8A16', description: 'Managed by Rig Spec Kit import' },
]);
const TASK_LINE = /^\s*-\s*\[[ xX]\]\s+(T\d{3,})\s+(.+?)\s*$/;
const TASK_LIKE_LINE = /^\s*-\s*\[[ xX]\]\s+(T\S*)\b/;
const DEPENDENCY_CLAUSE = /\s+\(depends on ([^)]+)\)\s*$/i;
const VALID_DEPENDENCIES = /^T\d{3,}(?:\s*,\s*T\d{3,})*$/;
const CANONICAL_MARKER = /^<!--\s*rig-spec-kit-task:([a-z0-9][a-z0-9-]*:T\d{3,})\s*-->[ \t]*(?:\r?\n|$)/;
const ISSUE_URL = /\/(\d+)\s*$/;

const hasControlCharacter = (value) =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

const gh = (projectRoot, args) => {
  try {
    return execFileSync('gh', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (error) {
    const operation = args.slice(0, 2).join(' ');
    const status = Number.isInteger(error?.status) ? ` (exit ${error.status})` : '';
    throw new Error(`GitHub ${operation} failed${status}${reasonOf(error?.stderr)}.`, { cause: error });
  }
};

// gh's own reason, through the stderr sanitizer reconcile-external-prs.mjs
// already applies to a subprocess's diagnostics.
const reasonOf = (stderr) => {
  const line = sanitizeDiagnostic(stderr);
  return line === '' ? '' : `: ${line}`;
};

const issueNumberOf = (output) => {
  const match = ISSUE_URL.exec(String(output));
  if (!match) throw new Error('GitHub did not return an issue URL after creating a projected task.');
  return Number(match[1]);
};

const refuseSymlink = (path, label) => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}.`);
  return stat;
};

const featureTasksPath = (projectRoot, explicitTasksPath = null) => {
  const specs = join(projectRoot, 'specs');
  const specsStat = refuseSymlink(specs, 'specs root');
  if (!specsStat) throw new Error('Spec Kit import needs exactly one specs/<feature-slug>/tasks.md.');
  if (!specsStat.isDirectory()) throw new Error(`specs root is not a directory: ${specs}.`);
  if (explicitTasksPath !== null) {
    const selected = resolve(projectRoot, explicitTasksPath);
    const selectedRelative = relative(projectRoot, selected);
    if (selectedRelative === '' || selectedRelative.startsWith('..') || selectedRelative.includes(':')) {
      throw new Error('explicit tasks path must stay inside the project.');
    }
    const segments = selectedRelative.split(/[\\/]/);
    if (
      segments.length !== 3 ||
      segments[0] !== 'specs' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(segments[1]) ||
      segments[2] !== 'tasks.md'
    ) {
      throw new Error('explicit tasks path must be specs/<feature-slug>/tasks.md.');
    }
    const directory = join(specs, segments[1]);
    const directoryStat = refuseSymlink(directory, 'specs feature directory');
    const taskStat = refuseSymlink(selected, 'tasks.md');
    if (!directoryStat?.isDirectory() || !taskStat?.isFile()) {
      throw new Error(`explicit tasks path is missing or invalid: ${selectedRelative}.`);
    }
    return { slug: segments[1], path: selected, directory };
  }
  const matches = readdirSync(specs, { withFileTypes: true })
    .filter((entry) => /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
    .map((entry) => ({ slug: entry.name, path: join(specs, entry.name, 'tasks.md'), directory: join(specs, entry.name) }))
    .filter(({ directory, path }) => {
      const directoryStat = refuseSymlink(directory, 'specs feature directory');
      const taskStat = refuseSymlink(path, 'tasks.md');
      return directoryStat?.isDirectory() && taskStat?.isFile();
    });
  if (matches.length !== 1) {
    throw new Error(`Spec Kit import needs exactly one specs/<feature-slug>/tasks.md, found ${matches.length}.`);
  }
  return matches[0];
};

export const parseTasks = ({ projectRoot = process.cwd(), tasksPath = null } = {}) => {
  const { slug, path } = featureTasksPath(resolve(projectRoot), tasksPath);
  const bytes = lstatSync(path).size;
  if (bytes > MAX_TASKS_BYTES) {
    throw new Error(`tasks.md is ${bytes} bytes; the ${MAX_TASKS_BYTES}-byte import limit was exceeded.`);
  }
  const seen = new Set();
  const tasks = [];
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    const match = TASK_LINE.exec(line);
    if (!match) {
      if (TASK_LIKE_LINE.test(line)) throw new Error(`malformed task id at tasks.md:${index + 1}; expected T###.`);
      continue;
    }
    const [, id, sourceText] = match;
    if (seen.has(id)) throw new Error(`duplicate task id ${id} at tasks.md:${index + 1}.`);
    seen.add(id);
    const dependencyClause = DEPENDENCY_CLAUSE.exec(sourceText);
    if (/\s+\(depends on\b/i.test(sourceText) && !dependencyClause) {
      throw new Error(`malformed dependency for ${id} at tasks.md:${index + 1}; expected a closed T### list.`);
    }
    if (dependencyClause && !VALID_DEPENDENCIES.test(dependencyClause[1])) {
      throw new Error(`malformed dependency for ${id} at tasks.md:${index + 1}; expected T###.`);
    }
    const title = (dependencyClause ? sourceText.slice(0, dependencyClause.index) : sourceText).trim();
    if (!title) throw new Error(`malformed task ${id} at tasks.md:${index + 1}; description is required.`);
    if (hasControlCharacter(title)) {
      throw new Error(`malformed task ${id} at tasks.md:${index + 1}; description contains a control character.`);
    }
    if (Buffer.byteLength(title, 'utf8') >= MAX_TASK_DESCRIPTION_BYTES) {
      throw new Error(
        `task ${id} at tasks.md:${index + 1} exceeds the ${MAX_TASK_DESCRIPTION_BYTES}-byte description limit.`,
      );
    }
    const dependencies = dependencyClause ? dependencyClause[1].split(',').map((value) => value.trim()) : [];
    tasks.push({ id, identity: `${slug}:${id}`, title, dependencies });
    if (tasks.length > MAX_TASKS) throw new Error(`tasks.md exceeds the ${MAX_TASKS}-task import limit.`);
  }
  if (tasks.length === 0) throw new Error('tasks.md contains no importable checklist tasks.');
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!seen.has(dependency)) throw new Error(`task ${task.id} depends on unknown task ${dependency}.`);
    }
  }
  return { slug, path, tasks };
};

// Exported — the Jira target projects the identical dependency graph onto
// native "Blocks" links rather than a body line, and must read it from the
// same place the GitHub target does (`invariants.md`: one mechanism, one
// implementation — the dependency MODEL stays here regardless of target).
export const dependenciesFor = (task) =>
  task.dependencies.map((id) => `${task.identity.split(':')[0]}:${id}`);

// GitHub's queue recognises dependency phrases at the start of a line.
// Prefix matching task prose so it cannot create a false blocker.
const safeTaskText = (title) => (/^\s*(?:blocked by|depends on|blocker)\b/i.test(title) ? `Task: ${title}` : title);

const bodyFor = (task, numbers) => {
  const blockers = dependenciesFor(task).map((identity) => numbers[identity]);
  if (blockers.some((number) => !Number.isInteger(number))) {
    throw new Error(`task ${task.identity} cannot project blockers before its GitHub issue numbers exist.`);
  }
  return [
    `<!-- rig-spec-kit-task:${task.identity} -->`,
    '',
    safeTaskText(task.title),
    ...(blockers.length ? ['', ...blockers.map((number) => `Blocked by #${number}`)] : []),
  ].join('\n');
};

const labelNames = (issue) =>
  (issue?.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);

const identityIndex = (issues, identities) => {
  const wanted = new Set(identities);
  const index = new Map();
  for (const issue of issues) {
    // A copied marker alone is not ownership. It must carry the label created
    // by this bridge, otherwise the user-owned issue is intentionally ignored.
    if (!labelNames(issue).includes(PROJECTED_LABEL)) continue;
    const marker = CANONICAL_MARKER.exec(String(issue.body ?? ''));
    if (!marker || !wanted.has(marker[1])) continue;
    const matches = index.get(marker[1]) ?? [];
    matches.push(issue);
    index.set(marker[1], matches);
  }
  for (const [identity, matches] of index) {
    if (matches.length > 1) throw new Error(`ambiguous existing projection for ${identity}.`);
  }
  return index;
};

const listIssues = (projectRoot) => {
  const issues = JSON.parse(
    gh(projectRoot, ['issue', 'list', '--state', 'all', '--limit', String(MAX_TASKS), '--json', 'number,title,body,labels']),
  );
  if (!Array.isArray(issues)) throw new Error('GitHub returned an invalid issue list for Spec Kit import.');
  if (issues.length === MAX_TASKS) throw new Error(`GitHub issue list reached the ${MAX_TASKS}-issue safety limit; refusing incomplete projection.`);
  return issues;
};

const changeFor = (task, issue, numbers) => {
  if (!issue) {
    return { identity: task.identity, action: 'create', dependencies: dependenciesFor(task), body: null };
  }
  // A dry-run can reconcile an existing dependent task while its newly added
  // dependency still has no GitHub number. That future issue means this one
  // needs an update, but must not make planning depend on a write.
  if (dependenciesFor(task).some((identity) => !Number.isInteger(numbers[identity]))) {
    return { identity: task.identity, action: 'update', dependencies: dependenciesFor(task), body: null };
  }
  const body = bodyFor(task, numbers);
  const action = issue.title === titleOf(task) && issue.body === body ? 'unchanged' : 'update';
  return { identity: task.identity, action, dependencies: dependenciesFor(task), body };
};

// Exported — the Jira target creates issues in the identical topological
// order, so a dependent's Blocks link can always name an already-existing
// blocker key.
export const creationOrder = (tasks) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependencies)]));
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter((id) => remaining.get(id).size === 0);
    if (ready.length === 0) throw new Error('Spec Kit task dependencies contain a cycle; refusing before GitHub writes.');
    for (const id of ready) {
      ordered.push(byId.get(id));
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return ordered;
};

const ensureLabels = (projectRoot) => {
  const listed = gh(projectRoot, ['label', 'list', '--limit', String(MAX_TASKS), '--json', 'name']);
  // Treat only literal empty output as an empty label list. Whitespace and
  // malformed JSON still fail closed through JSON.parse below.
  const labels = JSON.parse(listed === '' ? '[]' : listed);
  if (!Array.isArray(labels)) throw new Error('GitHub returned an invalid label list for Spec Kit import.');
  const existing = new Set(labels.map((label) => label?.name).filter((name) => typeof name === 'string'));
  const missing = REQUIRED_LABELS.filter((label) => !existing.has(label.name));
  if (labels.length + missing.length > MAX_TASKS) {
    throw new Error(`GitHub label list reached the ${MAX_TASKS}-label safety limit; refusing incomplete projection.`);
  }
  for (const label of missing) {
    gh(projectRoot, ['label', 'create', label.name, '--color', label.color, '--description', label.description]);
  }
};

// Exported — the Jira target reports the identical shape. Pinned in
// `test/template/spec-kit-import-jira.test.ts` (absent in a generated rig) › "dry-run
// report matches the github-issues target's shape and identities for the
// same tasks.md", with its own `target` rather than a second copy of this
// aggregation.
export const reportFor = (dryRun, tasks, changes, target = 'github-issues') => {
  const counts = { create: 0, update: 0, unchanged: 0 };
  for (const change of changes) counts[change.action] += 1;
  return {
    dryRun,
    source: 'spec-kit',
    target,
    taskCount: tasks.length,
    dependencyCount: tasks.reduce((count, task) => count + task.dependencies.length, 0),
    counts,
    changes: changes
      .filter((change) => change.action !== 'unchanged')
      .map(({ identity, action, dependencies }) => ({ identity, action, dependencies })),
  };
};

// A dynamic import, not a static one: `spec-kit-jira.mjs` imports
// `parseTasks`/`creationOrder`/`dependenciesFor`/`reportFor`/`PROJECTED_LABEL`
// from THIS module (they are the identity/dependency compilation it reuses
// unchanged), so a static import back here would be a circular module
// dependency. Resolved only when a caller actually asks for `target: 'jira'`.
const importSpecKitToJira = async (options) => {
  const { importSpecKitToJira: run } = await import('./spec-kit-jira.mjs');
  return run(options);
};

export const importSpecKit = ({
  projectRoot = process.cwd(),
  tasksPath = null,
  dryRun = false,
  target = 'github-issues',
} = {}) => {
  const root = resolve(projectRoot);
  if (target === 'jira') return importSpecKitToJira({ projectRoot: root, tasksPath, dryRun });
  if (target !== 'github-issues') {
    throw new Error(
      `spec-kit import: unknown target ${JSON.stringify(target)}. Known targets: ` +
        'github-issues, jira.',
    );
  }
  const { tasks } = parseTasks({ projectRoot: root, tasksPath });
  // Validate graph topology before label or issue creation. Existing issue
  // numbers are irrelevant to whether a source cycle is a valid projection.
  const ordered = creationOrder(tasks);
  const indexed = identityIndex(listIssues(root), tasks.map((task) => task.identity));
  const numbers = Object.fromEntries([...indexed].map(([identity, issues]) => [identity, Number(issues[0].number)]));
  if (dryRun) {
    const planned = tasks.map((task) => changeFor(task, indexed.get(task.identity)?.[0] ?? null, numbers));
    return reportFor(true, tasks, planned);
  }

  ensureLabels(root);
  const created = new Set();
  for (const task of ordered) {
    if (numbers[task.identity]) continue;
    const output = gh(root, [
      'issue', 'create', '--title', titleOf(task), '--body', bodyFor(task, numbers), '--label', PROJECTED_LABEL,
    ]);
    numbers[task.identity] = issueNumberOf(output);
    created.add(task.identity);
  }

  const changes = [];
  for (const task of tasks) {
    const existingIssue = indexed.get(task.identity)?.[0] ?? null;
    const change = changeFor(task, existingIssue, numbers);
    if (created.has(task.identity)) {
      changes.push({ ...change, action: 'create' });
    } else if (change.action === 'update') {
      gh(root, ['issue', 'edit', String(existingIssue.number), '--body', change.body, '--title', titleOf(task)]);
      changes.push(change);
    } else {
      changes.push(change);
    }
  }
  return reportFor(false, tasks, changes);
};
