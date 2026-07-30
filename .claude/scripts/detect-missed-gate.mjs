#!/usr/bin/env node
// The one finding a run cannot raise about itself.
//
// A change that touches an elevated-tier path must go through a reviewer gate
// (.claude/rules/autonomy.md, "Tier 2"; .claude/rules/workflow.md, "PR flow").
// When a run continues past that gate, the miss is invisible by construction:
// **the run that missed the gate is exactly the run that will not report it.**
// A run that had known was a run that would have run the gate.
//
// So this sweep runs OUTSIDE any run, over merged PRs, reading only merged
// artifacts. It costs a run nothing and cannot be skipped by one.
//
//   node .claude/scripts/detect-missed-gate.mjs                     # last 7 days
//   node .claude/scripts/detect-missed-gate.mjs --since 2026-07-01 --json
//   node .claude/scripts/detect-missed-gate.mjs --input prs.json    # offline
//   node .claude/scripts/detect-missed-gate.mjs --epoch 2026-07-01  # ignore older merges
//
// 🔴 **Never invoke it as a step inside a run.** A check the run performs on
// itself is a check the run in a hurry skips — running it inside would give back
// exactly the property that makes it worth having. A scheduled job, a weekly
// habit, or a human is the right caller.
//
// It always exits 0 unless it could not run at all: findings are the output, not
// the status. A non-zero exit would make a sweep that FOUND something look like
// a sweep that BROKE.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The elevated path set is declared ONCE, in a fenced ```elevated-paths``` block
 * in CLAUDE.md, and read from there. The alternative — a list in this file plus
 * a list in the docs — needs a drift check to stay honest, and a drifted
 * detector quietly stops detecting. One home removes the failure mode instead of
 * monitoring it.
 *
 * Every block in the document contributes, so a stack layer or a repo addendum
 * can add its own paths without editing anyone else's block.
 */
export const parseElevatedPaths = (markdown) => {
  const blocks = [...String(markdown ?? '').matchAll(/```elevated-paths\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  return blocks.flatMap((block) =>
    block[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
};

/** Paths that provision nothing and configure nothing, whatever directory they sit in. */
const isInert = (path) =>
  /\.mdx?$/.test(path) ||
  /(^|\/)(test|tests|__tests__)\//.test(path) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

const pathOf = (file) => (typeof file === 'string' ? file : (file?.path ?? ''));

/** The elevated-tier files among `files`; empty means the change was not elevated. */
export const elevatedPathsIn = (files = [], elevatedPaths = []) =>
  files
    .map(pathOf)
    .filter((path) => path && !isInert(path) && elevatedPaths.some((p) => path.startsWith(p)));

// A reviewer agent named in the PR body, by convention: the two universal gates
// plus any project-specific `*-reviewer`.
const REVIEWERS = /\b(code-reviewer|security-scanner|[a-z][a-z0-9-]*-reviewer)\b/i;
const VERDICT = /\b(clean|passed|pass|approved|no blocking|green|verdict)\b/i;
// A reviewer named only to say it did NOT run is not a recorded verdict — it is
// the confession that the gate was skipped.
const NEGATED = /\b(not run|not applicable|no[t]? applicable|skipped|did not run|unavailable|n\/a)\b/i;

/**
 * Did this PR record that the gate ran? Two mechanical proxies: the
 * `human-review` label, or a reviewer verdict written in the body.
 *
 * Attendance is deliberately NOT the test — "a human was watching" is not
 * recoverable from merged artifacts. The observable half of the same rule is:
 * the gate requires its verdict to be *recorded*, so an unrecorded gate is a
 * finding whether or not anyone was watching. A reviewer who ran the gate and
 * wrote it down is never flagged; one who ran it silently is — correctly,
 * because afterwards nothing distinguishes that merge from a skipped gate.
 */
const gateRecorded = (pr) => {
  const labels = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
  if (labels.includes('human-review')) return true;
  return String(pr.body ?? '')
    .split('\n')
    .some((line) => REVIEWERS.test(line) && VERDICT.test(line) && !NEGATED.test(line));
};

/**
 * Which lane produced this PR. The branch convention (`<type>/<queue-id>-<slug>`
 * — see the `worktree-task` skill) is the discriminator, because it is the one
 * mark a queue-driven run always leaves and an outside contributor never does.
 */
const BRANCH_CONVENTION = /^(?:feat|fix|docs|chore|refactor|test|perf)\/((?:[A-Z][A-Z0-9]*-)?\d+)-/;
const QUEUE_REF = /#(\d+)\b|\b([A-Z][A-Z0-9]+-\d+)\b/;
const CLOSES_ISSUE = /\b(?:clos(?:e|es|ed)|fix(?:e[sd])?|resolv(?:e|es|ed))\s+#(\d+)/i;

export const queueRefOf = (pr) => {
  const fromBranch = String(pr?.headRefName ?? '').match(BRANCH_CONVENTION)?.[1] ?? null;
  const text = `${pr?.title ?? ''}\n${pr?.body ?? ''}`;
  const inText = text.match(QUEUE_REF);
  const fromText = inText ? (inText[1] ?? inText[2] ?? null) : null;
  const closesIssue = text.match(CLOSES_ISSUE)?.[1] ?? null;
  return { fromBranch, fromText, closesIssue };
};

export const laneOf = (pr) => {
  const { fromBranch, fromText, closesIssue } = queueRefOf(pr);
  // A queue-driven PR whose description lost the reference is still recognisably
  // queue-driven. Counting it as external would corrupt the accounting AND hide
  // the broken convention — so the lane stays `queue` and the gap is a finding.
  if (fromBranch) {
    return {
      lane: 'queue',
      queueRef: fromBranch,
      closesIssue,
      finding: fromText === null ? 'queue-ref-missing-from-description' : null,
    };
  }
  if (closesIssue) return { lane: 'external', queueRef: null, closesIssue, finding: null };
  // No reference anywhere and nothing closed: owner-directed work outside both
  // lanes. Recorded, not flagged — it is legitimate.
  return { lane: 'owner-directed', queueRef: null, closesIssue: null, finding: null };
};

/**
 * One merged PR → a `missed-gate` finding, or null. Three tests in order: merged
 * after the epoch, touched an elevated path, no recorded gate.
 */
export const classifyPr = (pr, { elevatedPaths = [], epoch = null } = {}) => {
  if (!pr || typeof pr !== 'object') return null;
  if (!pr.mergedAt) return null;
  if (epoch && new Date(pr.mergedAt) < new Date(epoch)) return null;

  const elevatedFiles = elevatedPathsIn(pr.files ?? [], elevatedPaths);
  if (elevatedFiles.length === 0) return null;
  if (gateRecorded(pr)) return null;

  const { lane, queueRef } = laneOf(pr);
  return {
    kind: 'missed-gate',
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    mergedAt: pr.mergedAt,
    lane,
    queueRef,
    elevatedFiles,
    why:
      `merged touching ${elevatedFiles.length} elevated-tier path(s) with ` +
      'no reviewer verdict recorded on the PR and no human-review label',
  };
};

/**
 * A sweep over merged PRs.
 *
 * Escalation grows with the second miss: the first is commented and journaled;
 * a second inside the same window opens an escalation issue, because two misses
 * is a hole in the gate logic rather than one slip.
 */
export const sweep = ({ prs = [], elevatedPaths = [], epoch = null } = {}) => {
  const findings = [];

  // No declaration is not "nothing to find" — it is a blind sweep, and a blind
  // sweep reporting "no findings" is the most misleading output this tool has.
  if (elevatedPaths === null || elevatedPaths.length === 0) {
    findings.push({
      kind: 'no-elevated-paths-declared',
      why:
        'CLAUDE.md declares no `elevated-paths` block, so this sweep cannot tell ' +
        'an elevated merge from an ordinary one. Until it does, "no findings" ' +
        'means "did not look".',
      actions: ['journal-line', 'escalation-issue'],
    });
    return { findings, sweptPrs: prs.length, epoch };
  }

  let misses = 0;
  for (const pr of prs) {
    const finding = classifyPr(pr, { elevatedPaths, epoch });
    if (!finding) continue;
    const actions = [
      finding.lane === 'queue' ? 'comment-on-queue-item' : 'comment-on-pr',
      'journal-line',
    ];
    if (misses >= 1) actions.push('escalation-issue');
    misses += 1;
    findings.push({ ...finding, actions });
  }

  return { findings, sweptPrs: prs.length, epoch };
};

// --- CLI -----------------------------------------------------------------------------

const parseArgs = (argv) => {
  const args = { json: false, since: null, epoch: null, input: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--since') args.since = argv[++i];
    else if (flag === '--epoch') args.epoch = argv[++i];
    else if (flag === '--input') args.input = argv[++i];
  }
  return args;
};

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Findings are the output, not the status — but that cuts both ways: a sweep that
 * could not reach the API must be unmistakably different from a clean sweep. So
 * this is the one path that exits non-zero, and it says why in one line rather
 * than dumping a stack.
 */
const fetchMergedPrs = (since) => {
  try {
    return JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'merged',
          '--limit',
          '100',
          '--search',
          `merged:>=${since}`,
          '--json',
          'number,title,body,headRefName,mergedAt,url,labels,files',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  } catch (error) {
    process.stderr.write(
      'missed-gate sweep: could not list merged PRs — the `gh` CLI is missing, ' +
        'unauthenticated, or the API is unreachable. This is NOT a clean sweep; ' +
        'nothing was checked. Use --input <file> to sweep an exported list offline.\n' +
        `  ${String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]}\n`,
    );
    process.exit(1);
  }
};

export const render = (result) => {
  if (result.findings.length === 0) {
    return (
      `missed-gate sweep: ${result.sweptPrs} merged PR(s) swept — no findings` +
      `${result.epoch ? ` (epoch ${result.epoch})` : ''}.\n`
    );
  }
  const lines = [
    `missed-gate sweep: ${result.findings.length} finding(s) over ${result.sweptPrs} merged PR(s).`,
    '',
  ];
  for (const f of result.findings) {
    if (f.kind === 'no-elevated-paths-declared') {
      lines.push(`  [${f.kind}] ${f.why}`);
    } else {
      lines.push(
        `  [missed-gate] #${f.pr} (${f.lane}${f.queueRef ? `, ${f.queueRef}` : ''}) — ${f.title}`,
      );
      lines.push(`      elevated files: ${f.elevatedFiles.join(', ')}`);
      lines.push(`      ${f.why}`);
    }
    lines.push(`      actions: ${f.actions.join(' → ')}`);
    lines.push('');
  }
  return lines.join('\n');
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const prs = args.input
    ? JSON.parse(readFileSync(args.input, 'utf8'))
    : fetchMergedPrs(args.since ?? daysAgo(7));
  let elevatedPaths;
  try {
    elevatedPaths = parseElevatedPaths(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8'));
  } catch {
    // No CLAUDE.md at all reads the same as no declaration: a blind sweep, and
    // `sweep` reports that as its own finding rather than as "no findings".
    elevatedPaths = null;
  }
  const result = sweep({ prs, elevatedPaths, epoch: args.epoch });
  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
}
