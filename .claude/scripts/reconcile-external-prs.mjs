#!/usr/bin/env node
// Reconcile the lane the journal never sees.
//
// Work reaches the default branch through more than one lane. The queue lane
// leaves a queue item, a journal entry and a cost figure. Work that arrives from
// outside — an issue someone filed and someone else fixed, a change the owner
// asked for directly — leaves none of those. So the journal's output and cost
// blocks describe ONE lane while reading as if they described the repo.
//
// This does not instrument the other lane; it cannot, because that lane does not
// read these skills. It reconciles **after the fact**, from merged PRs, which is
// the only vantage point this side actually has.
//
//   node .claude/scripts/reconcile-external-prs.mjs --since 2026-07-20
//   node .claude/scripts/reconcile-external-prs.mjs --since 2026-07-20 --json
//   node .claude/scripts/reconcile-external-prs.mjs --input prs.json   # offline
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Imported, never copied: one home for the elevated declaration and one home for
// the lane rule. A second copy of either would drift, and each copy would keep
// passing on its own.
// `readDeclaredPaths` unions CLAUDE.md with every .claude/rules/*.md declaration,
// so this sweep sees exactly what the gate sweep sees — including the paths a
// stack layer contributes for its own shape.
import { elevatedPathsIn, laneOf, readDeclaredPaths } from './detect-missed-gate.mjs';

/**
 * The audit trail for work that already happened: a record born **closed**.
 *
 * It is a record, not work — and it deliberately carries no `ready`-style
 * selectable state. A selectable queue item describing work that already merged
 * is the loop feeding itself, which is the one thing the queue firewall exists
 * to prevent (.claude/skills/loop/SKILL.md).
 */
export const auditRecordFor = (pr, lane = laneOf(pr)) => ({
  title: `External-lane merge — PR #${pr.number}: ${pr.title}`,
  body: [
    'Audit record for work that reached the default branch outside the queue.',
    '',
    `- PR: ${pr.url ?? `#${pr.number}`}`,
    lane.closesIssue ? `- Closes issue: #${lane.closesIssue}` : '- Closed no issue.',
    `- Merged: ${pr.mergedAt ?? 'unknown'}`,
    '',
    'Filed already closed by `.claude/scripts/reconcile-external-prs.mjs`, so the',
    'merge is traceable from the journal to a record to a PR.',
    '',
    'This record is **not work**. It must never become selectable, or a run would',
    'pick up something that has already shipped.',
  ].join('\n'),
  labels: ['external-lane', 'audit'],
  state: 'closed',
  pr: pr.number,
});

/**
 * Split merged PRs by lane, mark the externally-originated ones that crossed an
 * elevated path, and collect findings.
 *
 * Never throws on a malformed record: a sweep that dies on one bad row reports
 * nothing about the other forty.
 */
export const reconcile = ({ prs = [], elevatedPaths = [], auditRecords = {} } = {}) => {
  const external = [];
  const queue = [];
  const ownerDirected = [];
  const findings = [];

  for (const pr of prs) {
    if (!pr || typeof pr !== 'object' || pr.number === undefined) continue;
    let lane;
    try {
      lane = laneOf(pr);
    } catch {
      continue;
    }

    const entry = {
      pr: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
      url: pr.url,
      lane: lane.lane,
      queueRef: lane.queueRef,
      closesIssue: lane.closesIssue,
    };

    if (lane.finding) {
      findings.push({
        pr: pr.number,
        kind: lane.finding,
        why:
          `branch ${pr.headRefName} carries the queue reference ${lane.queueRef} but ` +
          'the title and body do not. A queue-driven PR should never lose it — and ' +
          'without the branch this merge would have been counted as external',
      });
    }

    if (lane.lane === 'external') {
      const elevatedFiles = elevatedPathsIn(pr.files ?? [], elevatedPaths ?? []);
      external.push({
        ...entry,
        elevatedFiles,
        // For tier purposes this lane is untrusted-origin: an elevated diff
        // arriving from it never merges on the strength of the gate alone.
        untrustedOrigin: elevatedFiles.length > 0,
        auditRecord: auditRecords[pr.number] ?? null,
      });
    } else if (lane.lane === 'queue') {
      queue.push(entry);
    } else {
      ownerDirected.push(entry);
    }
  }

  return { external, queue, ownerDirected, findings, sweptPrs: prs.length };
};

/** The `external lane` block for the journal in PLAN.md. */
export const renderJournalBlock = (result) => {
  const lines = ['**external lane**', ''];

  if (result.external.length === 0) {
    lines.push(
      `- no externally-originated merges in this window (swept ${result.sweptPrs} merged PR(s)).`,
    );
  } else {
    for (const e of result.external) {
      const marks = [
        e.closesIssue ? `closes #${e.closesIssue}` : 'closes no issue',
        e.untrustedOrigin
          ? `⚠ crossed an elevated path (${e.elevatedFiles.join(', ')}) — the gate applies here too`
          : 'no elevated path crossed',
        `audit record: ${e.auditRecord ?? 'not filed'}`,
      ];
      lines.push(`- PR #${e.pr} — ${e.title} · ${marks.join(' · ')}`);
    }
  }

  for (const f of result.findings) {
    lines.push(`- 🔴 finding · PR #${f.pr} — ${f.why}`);
  }

  lines.push('');
  lines.push(
    `_Queue lane this window: ${result.queue.length} PR(s); owner-directed: ` +
      `${result.ownerDirected.length}. The cost figures in the journal cover the ` +
      'queue lane only — read the two together, or a "cheap" session will sit ' +
      'beside an expensive lane the totals never mention._',
  );
  return lines.join('\n');
};

// --- CLI -----------------------------------------------------------------------------

const parseArgs = (argv) => {
  const args = { json: false, since: null, input: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--since') args.since = argv[++i];
    else if (argv[i] === '--input') args.input = argv[++i];
  }
  return args;
};

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Same rule as the gate sweep: "could not look" must never render as "clean". */
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
          'number,title,body,headRefName,mergedAt,url,files',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  } catch (error) {
    process.stderr.write(
      'lane reconciliation: could not list merged PRs — the `gh` CLI is missing, ' +
        'unauthenticated, or the API is unreachable. No lane was reconciled; do not ' +
        'record an empty `external lane` block from this run. Use --input <file> to ' +
        'work offline.\n' +
        `  ${String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]}\n`,
    );
    process.exit(1);
  }
};

/**
 * Was this file invoked directly?
 *
 * Compared by REALPATH on both sides: ESM resolves `import.meta.url` through
 * symlinks while `process.argv[1]` keeps the path as typed, so a project living
 * under a symlinked directory (a macOS temp dir, a symlinked home, a checkout
 * behind a link) would fail a naive equality check — and the script would exit 0
 * having printed nothing, which reads exactly like "no findings".
 */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const prs = args.input
    ? JSON.parse(readFileSync(args.input, 'utf8'))
    : fetchMergedPrs(args.since ?? daysAgo(7));
  // Lane sorting still works without a declaration; only the elevated marks go
  // missing, and they render as "no elevated path crossed" rather than lying.
  const elevatedPaths = readDeclaredPaths(projectRoot) ?? [];
  const result = reconcile({ prs, elevatedPaths });
  process.stdout.write(
    args.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderJournalBlock(result)}\n`,
  );
}
