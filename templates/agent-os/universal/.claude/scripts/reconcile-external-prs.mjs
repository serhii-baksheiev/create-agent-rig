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
// The one credential vocabulary (`guard-secret-file`, the commit sweep and this
// diagnostic all read it): a second list of token shapes here would drift.
import { SECRET_VALUE_PATTERNS } from './lib/secrets.mjs';

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

  const rows = Array.isArray(prs) ? prs : [];

  for (const pr of rows) {
    if (!pr || typeof pr !== 'object' || pr.number === undefined) continue;
    // Only `classifyPr` used to check this, so an unmerged PR was rendered as a
    // merge in the journal block.
    if (!pr.mergedAt) continue;

    let lane;
    let elevatedFiles;
    try {
      lane = laneOf(pr);
      // Computed for EVERY lane. It used to run only for `external`, and the lane
      // is decided by the branch name — which a fork contributor chooses freely.
      // So a contributor could opt out of the untrusted-origin mark by naming
      // their branch `feat/12-…`, which is the opposite of what the mark is for.
      elevatedFiles = elevatedPathsIn(pr.files ?? [], elevatedPaths ?? []);
    } catch {
      findings.push({
        pr: pr.number,
        kind: 'unreadable-record',
        why: 'this merged PR could not be read, so its lane and elevated paths are unknown — not clean.',
      });
      continue;
    }

    // `authorAssociation` is the trustworthy signal when the host supplies it: it
    // comes from the forge, not from the contributor.
    const association = String(pr.authorAssociation ?? '').toUpperCase();
    const trustedAuthor = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);
    const entry = {
      pr: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
      url: pr.url,
      lane: lane.lane,
      queueRef: lane.queueRef,
      closesIssue: lane.closesIssue,
      elevatedFiles,
      untrustedOrigin: elevatedFiles.length > 0 && !trustedAuthor,
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
      external.push({ ...entry, auditRecord: auditRecords[pr.number] ?? null });
    } else if (lane.lane === 'queue') {
      queue.push(entry);
    } else {
      ownerDirected.push(entry);
    }
  }

  return { external, queue, ownerDirected, findings, sweptPrs: rows.length };
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

/**
 * Read an offline fixture, or say plainly why it could not be read.
 *
 * A raw SyntaxError stack, or a silent fall-through to the live repo when
 * `--input` was given without a value, are both worse than a one-line diagnosis:
 * this tool's whole value is that "could not look" never renders as "clean".
 */
const readInput = (file, label) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `${label}: could not read ${file} as JSON — nothing was checked. ` +
        `${String(error?.message ?? error).split('\n')[0]}\n`,
    );
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      `${label}: ${file} does not contain a JSON array of merged PRs, so nothing ` +
        'was checked. Expected the shape `gh pr list --json …` produces.\n',
    );
    process.exit(1);
  }
  return parsed;
};

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

// --- Acquisition (RP-99) --------------------------------------------------------
//
// Two calls, not one. `gh pr list --json` does not know `authorAssociation` on
// every supported `gh` (2.71.2 answers `Unknown JSON field`), so the BASE
// projection asks only for fields every `gh` has, and the association — the
// trust signal — is fetched afterwards through one GraphQL query. When that
// second step fails for any reason the base list is returned WITHOUT the field
// and `reconcile()` treats those PRs as untrusted; a missing signal never
// becomes a trusted one. Pinned in the generator's
// test/template/reconcile-acquisition.test.ts (absent in a generated rig).

/** The base projection: fields every supported `gh` serves. */
const BASE_FIELDS = ['number', 'title', 'body', 'headRefName', 'mergedAt', 'url', 'files', 'changedFiles'];
/** What GitHub returns for `authorAssociation`: an upper-case enum word. */
const ASSOCIATION_SHAPE = /^[A-Z_]{1,32}$/;
const MAX_PRS = 100;

/** The default runner: one `gh` child, stdout as text, a thrown error otherwise. */
const execGh = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A base record the rest of this script can read: an object with a numeric PR number. */
const isPrRecord = (row) =>
  row !== null && typeof row === 'object' && !Array.isArray(row) && Number.isInteger(row.number);

/**
 * The merged PRs since `since`, plus the warnings the acquisition produced.
 *
 * Throws only from the BASE list — the caller classifies that with
 * `classifyAcquisitionFailure`. A parsed base list that is not an array is
 * thrown with `notAnArray: true` (JSON.parse succeeded, so a SyntaxError would
 * misdescribe it). Enrichment never throws: it degrades to a warning.
 */
export const fetchMergedPrs = (since, { exec = execGh } = {}) => {
  const raw = exec('gh', [
    'pr',
    'list',
    '--state',
    'merged',
    '--limit',
    String(MAX_PRS),
    '--search',
    `merged:>=${since}`,
    '--json',
    BASE_FIELDS.join(','),
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error('gh pr list answered with something other than a JSON array'), {
      notAnArray: true,
    });
  }

  const warnings = [];
  const prs = [];
  for (const row of parsed.slice(0, MAX_PRS)) {
    if (!isPrRecord(row)) {
      warnings.push('a merged-PR record without a numeric `number` was dropped from the sweep');
      continue;
    }
    // Copy the base fields only; whatever else `gh` returned does not travel.
    const record = {};
    for (const field of BASE_FIELDS) if (row[field] !== undefined) record[field] = row[field];
    prs.push(record);
  }
  if (prs.length === 0) return { prs, warnings };

  const associations = fetchAuthorAssociations(prs, exec);
  if (associations === null) {
    warnings.push(
      'author association unavailable for this window — every external merge below is treated as untrusted origin',
    );
    return { prs, warnings };
  }
  for (const pr of prs) {
    const value = associations.get(pr.number);
    if (value === undefined) continue;
    if (typeof value === 'string' && ASSOCIATION_SHAPE.test(value)) pr.authorAssociation = value;
    else warnings.push(`PR #${pr.number}: an author association of an unexpected shape was dropped`);
  }
  return { prs, warnings };
};

/**
 * `number → authorAssociation` for the listed PRs through one GraphQL query, or
 * `null` when the answer cannot be trusted: a failed call, unusable JSON, a
 * repository name of an unexpected shape. Never throws.
 */
const fetchAuthorAssociations = (prs, exec) => {
  try {
    const repo = JSON.parse(exec('gh', ['repo', 'view', '--json', 'nameWithOwner']));
    const nameWithOwner = typeof repo?.nameWithOwner === 'string' ? repo.nameWithOwner : '';
    const parts = nameWithOwner.split('/');
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))) return null;
    const [owner, name] = parts;
    const fields = prs
      .map((pr) => `pr${pr.number}: pullRequest(number: ${pr.number}) { authorAssociation }`)
      .join(' ');
    const query = `query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`;
    const answer = JSON.parse(exec('gh', ['api', 'graphql', '-f', `query=${query}`]));
    const repository = answer?.data?.repository;
    if (repository === null || typeof repository !== 'object') return null;
    const out = new Map();
    for (const pr of prs) {
      const value = repository[`pr${pr.number}`]?.authorAssociation;
      if (value !== undefined) out.set(pr.number, value);
    }
    return out;
  } catch {
    return null;
  }
};

// --- Failure diagnostics (RP-99) -----------------------------------------------

const CAUSES = Object.freeze({
  'gh-missing': 'the `gh` CLI could not be started (not installed, or not on PATH)',
  'gh-unauthenticated': 'the `gh` CLI is not authenticated for this host — run `gh auth login`',
  'api-unreachable': 'the GitHub API could not be reached',
  'unsupported-projection': 'this `gh` version does not serve a field the sweep asked for',
  'malformed-response': '`gh` answered, but not with the JSON array the sweep expects',
  unknown: 'the cause is unknown',
});
const STDERR_UNAUTHENTICATED = /gh auth login|not logged in|HTTP 401|authentication required/i;
const STDERR_UNREACHABLE =
  /dial tcp|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|HTTP 5\d\d|could not connect|connection refused/i;
const STDERR_UNSUPPORTED = /Unknown JSON field/i;
// ESC-led sequences (CSI, OSC and the single-character escapes), then every
// remaining C0/C1 control character. Two passes, each linear.
// eslint-disable-next-line no-control-regex -- the pattern exists to remove these very bytes
const TERMINAL_SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- likewise
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const AUTHORIZATION_VALUE = /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}|\bAuthorization:\s*[^\s]+(?:\s+[^\s]+)?/gi;
const DIAGNOSTIC_CAP = 200;
// Redaction runs on this much of the line, and the 200-character cut comes
// after it: cutting first can shorten a token below what its pattern needs and
// print the prefix. Any token reaching into the first 200 characters is still
// far longer than every pattern's minimum at this bound.
const REDACTION_WINDOW = 4096;

/**
 * One printable line of a subprocess's stderr: no terminal sequences or control
 * characters, the first non-empty line only, every credential shape the shared
 * vocabulary knows — plus HTTP authorization values — replaced by `[redacted]`,
 * and then at most 200 characters.
 */
export const sanitizeDiagnostic = (text) => {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const stripped = source.replace(TERMINAL_SEQUENCES, '').replace(CONTROL_CHARACTERS, '');
  const line = stripped.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  let out = line.trim().slice(0, REDACTION_WINDOW);
  out = out.replace(AUTHORIZATION_VALUE, '[redacted]');
  for (const { pattern } of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[redacted]');
  }
  return out.slice(0, DIAGNOSTIC_CAP);
};

/**
 * The cause the evidence supports, and nothing more. `detail` is the sanitized
 * first stderr line — the actionable remainder for an `unknown` failure, and
 * the matched line for the evidenced ones — or `null` when there was none.
 */
export const classifyAcquisitionFailure = (error) => {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const detail = stderr.trim() === '' ? null : sanitizeDiagnostic(stderr);
  if (error?.code === 'ENOENT') return { cause: 'gh-missing', detail };
  if (error instanceof SyntaxError || error?.notAnArray === true) {
    return { cause: 'malformed-response', detail };
  }
  if (STDERR_UNSUPPORTED.test(stderr)) return { cause: 'unsupported-projection', detail };
  if (STDERR_UNAUTHENTICATED.test(stderr)) return { cause: 'gh-unauthenticated', detail };
  if (STDERR_UNREACHABLE.test(stderr)) return { cause: 'api-unreachable', detail };
  return { cause: 'unknown', detail };
};

/** The message the CLI prints for a failed acquisition: one cause, named. */
export const acquisitionFailureMessage = ({ cause, detail }) => {
  const named = CAUSES[cause] ?? CAUSES.unknown;
  return (
    `lane reconciliation: could not list merged PRs — ${named}. ` +
    'No lane was reconciled; do not record an empty `external lane` block from this run. ' +
    'Use --input <file> to work offline.' +
    (detail ? `\n  ${detail}` : '')
  );
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
  let prs;
  let warnings = [];
  if (args.input) {
    prs = readInput(args.input, 'lane reconciliation');
  } else {
    try {
      ({ prs, warnings } = fetchMergedPrs(args.since ?? daysAgo(7)));
    } catch (error) {
      process.stderr.write(`${acquisitionFailureMessage(classifyAcquisitionFailure(error))}\n`);
      process.exit(1);
    }
  }
  for (const warning of warnings) process.stderr.write(`lane reconciliation: ${warning}\n`);
  // Lane sorting still works without a declaration; only the elevated marks go
  // missing, and they render as "no elevated path crossed" rather than lying.
  const elevatedPaths = readDeclaredPaths(projectRoot) ?? [];
  const result = reconcile({ prs, elevatedPaths });
  process.stdout.write(
    args.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderJournalBlock(result)}\n`,
  );
}
