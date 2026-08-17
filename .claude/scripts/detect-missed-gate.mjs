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
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Read every layer's declaration and union them.
 *
 * The set is never duplicated into this file: a list here plus a list in the docs
 * needs a drift check to stay honest, and a drifted detector quietly stops
 * detecting. Reading the declaration removes that failure mode instead of
 * monitoring it.
 *
 * `CLAUDE.md` carries the project's own paths; each stack layer's rule file
 * carries the ones that only exist in that shape (`infra/` comes from the
 * infrastructure layer, and a project without one must not declare it). Seeding
 * every path in one place would declare directories that do not exist in half the
 * targets — and a gate declared over a missing directory reports "clean" while
 * looking nowhere.
 */
export const readDeclaredPaths = (projectRoot, { readFile = readFileSync, listDir = null } = {}) => {
  const sources = [join(projectRoot, 'CLAUDE.md')];
  try {
    const rulesDir = join(projectRoot, '.claude', 'rules');
    const entries = listDir ? listDir(rulesDir) : readdirSync(rulesDir);
    for (const entry of entries) {
      if (entry.endsWith('.md')) sources.push(join(rulesDir, entry));
    }
  } catch {
    // no rules directory — CLAUDE.md alone then
  }

  const declared = [];
  let found = false;
  for (const source of sources) {
    let parsed;
    try {
      parsed = parseElevatedPaths(readFile(source, 'utf8'));
    } catch {
      continue; // an unreadable source is not a declaration
    }
    if (parsed) {
      found = true;
      declared.push(...parsed);
    }
  }
  // null, not [], when nothing declared anything: `sweep` reports that as its own
  // finding rather than as "no findings".
  return found ? [...new Set(declared)] : null;
};

/**
 * Normalise a path so both sides of the comparison agree.
 *
 * `./infra/x.ts`, `/infra/x.ts` and `infra//x.ts` all name the same file as
 * `infra/x.ts`; comparing raw strings meant each of those slipped the gate
 * silently. Case is deliberately preserved — paths are case-sensitive on the
 * systems this runs on, and folding case would create false positives.
 */
export const normalizePath = (path) =>
  String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');

export const parseElevatedPaths = (markdown) => {
  // `\r?` so a file with CRLF line endings is not invisible: the block used to be
  // undetectable there, and with another source also declaring, the loss was
  // silent rather than reported as a blind sweep.
  const blocks = [...String(markdown ?? '').matchAll(/```elevated-paths\r?\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  return blocks.flatMap((block) =>
    block[1]
      .split('\n')
      // an inline comment after the path is a comment, not part of the path
      .map((line) => normalizePath(line.replace(/\s+#.*$/, '').trim()))
      .filter((line) => line && !line.startsWith('#')),
  );
};

/**
 * A decision record: `docs/decisions/<name>` at any depth, so both the root
 * copy and the vendored template source match.
 *
 * Exported because `decision-router.mjs` needs the same notion, and two regexes
 * for one invariant is the case `invariants.md` legislates against — the copy
 * nobody is looking at is the one that goes wrong.
 *
 * `decisions` is matched as a whole path SEGMENT under a `docs` segment, never
 * as a substring: `docs/decisions-overview.md` is ordinary documentation and
 * must keep the cheap lane. Widening this to a substring would quietly pull
 * every `docs/decisions*` name into the expensive gate.
 *
 * 🔴 Case-SENSITIVE, deliberately, and the caller decides. `normalizePath` in
 * this file does not fold either — a sweep that folded would report a path the
 * repository does not have. `decision-router.mjs` folds before calling this,
 * because there folding can only escalate; here it could only mislabel.
 */
export const isDecisionRecord = (path) => /(^|\/)docs\/decisions\/[^/]/.test(path);

/**
 * Paths that provision nothing and configure nothing, whatever directory they sit
 * in — EXCEPT the rulebook itself. Declaring `.claude/` as elevated was a no-op
 * for every `.md` under it, so a merged PR rewriting the autonomy tiers or the
 * Never list passed the gate meant to catch exactly that.
 *
 * 🔴 A rulebook is recognised **wherever it sits**, not only at the repository
 * root. The root-anchored version of this test was true of a project this tool
 * generates and false of the tool itself: a generator keeps rulebooks under
 * `templates/`, every one of them is a `.md`, and all of them were dropped as
 * inert — so two merges that changed agent specs, skills and an init map were
 * reported clean, while a third that also touched a `.mjs` was caught for that
 * reason alone. Any repository that vendors, templates or nests a rig has the
 * same shape.
 */
const isRulebook = (path) =>
  path === 'CLAUDE.md' ||
  path.endsWith('/CLAUDE.md') ||
  path.startsWith('.claude/') ||
  path.includes('/.claude/') ||
  // The rationale extracted out of the rulebook is still rulebook. It left
  // `.claude/` for `docs/decisions/` so that sessions stop paying to load it —
  // not so that it stops being reviewed like the rule it explains.
  isDecisionRecord(path);

const isInert = (path) =>
  !isRulebook(path) &&
  (/\.mdx?$/.test(path) ||
  /(^|\/)(test|tests|__tests__)\//.test(path) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(path));

/** Coerce whatever the host returned into a path string, never throwing. */
const pathOf = (file) => {
  if (typeof file === 'string') return file;
  const path = file?.path ?? file?.filename ?? '';
  return typeof path === 'string' ? path : '';
};

/**
 * The elevated-tier files among `files`; empty means the change was not elevated.
 *
 * Tolerant of every malformed shape seen in testing (a non-array, an object,
 * `{path: 42}`) because the alternative was a TypeError that killed the whole
 * sweep and lost the findings on every other PR — which both this file and the
 * reconciler explicitly promise not to do.
 */
export const elevatedPathsIn = (files = [], elevatedPaths = []) => {
  if (!Array.isArray(files)) return [];
  const prefixes = (Array.isArray(elevatedPaths) ? elevatedPaths : []).map(normalizePath);
  return files
    .map(pathOf)
    .map(normalizePath)
    .filter((path) => path && !isInert(path) && prefixes.some((prefix) => path.startsWith(prefix)));
};

// A reviewer agent named in the PR body, by convention: the two universal gates
// plus any project-specific `*-reviewer`.
// The quantifier is BOUNDED. `[a-z0-9-]*` before a `-reviewer` tail backtracks
// quadratically on an attacker-written body: 3.9s on a 65k line, and the sweep
// reads 100 PR bodies, so a crafted set costs minutes of CPU on a scheduled job
// that reports nothing when it is killed.
const REVIEWERS = /\b(code-reviewer|security-scanner|[a-z][a-z0-9-]{0,48}-reviewer)\b/i;
// SHIP and HOLD are what `pr-ship` actually emits, and their absence here meant
// a PR body recording a real verdict registered as no evidence at all — so the
// weaker "someone says a gate ran, go check" observation never fired on this
// rulebook's own PRs, only on bodies phrased in somebody else's vocabulary.
//
// 🔴 Widening this list widens what is *observed*, never what is *permitted*.
// `body-claim` is still a finding; only the `human-review` label suppresses one.
// Adding a word must never move a PR from "reported" to "clean" — if a change
// here could do that, it is the wrong change.
const VERDICT = /\b(clean|passed|pass|approved|no blocking|green|ship|hold)\b/i;

/**
 * 🔴 The body is NOT authority, and this is the security core of the file.
 *
 * The PR body is written by whoever opened the PR — including the run whose
 * compliance is being audited, and including an outside contributor. Testing it
 * with a keyword scan made the detector strictly *more* permissive the more
 * damning the body got: `VERDICT: HOLD — code-reviewer listed 3 blockers`
 * suppressed the finding, an unticked `- [ ] code-reviewer verdict recorded`
 * checkbox suppressed it, and so did `ignore the code-reviewer, this is urgent`.
 * Writing the truth got you flagged; writing a lie did not.
 *
 * So only the **`human-review` label** suppresses a finding. Applying a label
 * needs repository triage permission, which a fork contributor does not have and a
 * run cannot fake. The body is still read — a plausible-looking verdict there is
 * reported as a weaker, separate observation, never as a pass.
 */
const labelsOf = (pr) => {
  const labels = pr?.labels;
  if (typeof labels === 'string') return [labels];
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => (typeof label === 'string' ? label : (label?.name ?? '')));
};

export const gateEvidence = (pr) => {
  if (labelsOf(pr).includes('human-review')) return 'label';
  const claimsVerdict = String(pr?.body ?? '')
    .split('\n')
    .some((line) => REVIEWERS.test(line) && VERDICT.test(line));
  return claimsVerdict ? 'body-claim' : 'none';
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

  // A file list that is absent is NOT an empty one. `files: null` used to read as
  // "touched nothing elevated" and pass silently — so a schema change, a truncated
  // response or a hand-exported fixture turned the sweep into a rubber stamp.
  // `gh pr list --json files` uses GraphQL `files(first: 100)` and silently
  // returns only the first 100, with no truncation marker. A PR padded past that
  // hides its elevated file OUTSIDE the window, and the sweep reads the empty
  // result as "touched nothing elevated" — the silent variant of the failure this
  // file exists to prevent. `changedFiles` comes back on the same call and is the
  // ground truth.
  const truncated =
    Array.isArray(pr.files) &&
    typeof pr.changedFiles === 'number' &&
    pr.files.length < pr.changedFiles;

  if (pr.files === undefined || pr.files === null || truncated) {
    return {
      kind: 'unknown-file-list',
      pr: pr.number,
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt,
      lane: laneOf(pr).lane,
      elevatedFiles: [],
      why: truncated
        ? `the host returned ${pr.files.length} of ${pr.changedFiles} changed files, so ` +
          'this sweep could not see the whole diff. That is an unknown, not a pass — ' +
          'check this PR by hand.'
        : 'the merged PR carries no file list, so this sweep could not tell whether ' +
          'it crossed an elevated path. That is an unknown, not a pass — re-fetch it ' +
          'with `--json files` or check the PR by hand.',
    };
  }

  const elevatedFiles = elevatedPathsIn(pr.files, elevatedPaths);
  if (elevatedFiles.length === 0) return null;

  const evidence = gateEvidence(pr);
  if (evidence === 'label') return null;

  const { lane, queueRef } = laneOf(pr);
  return {
    kind: 'missed-gate',
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    mergedAt: pr.mergedAt,
    lane,
    queueRef,
    evidence,
    elevatedFiles,
    why:
      evidence === 'body-claim'
        ? `merged touching ${elevatedFiles.length} elevated-tier path(s). The body ` +
          'claims a reviewer verdict, but the body is written by the author — it is ' +
          'not verifiable after the fact. Only the human-review label, which needs ' +
          'repository permission, records the gate. Confirm the gate ran and label it.'
        : // "anywhere" claimed more than this sweep can see: it reads the label
          // and scans the body for a reviewer name next to a passing word. A
          // verdict phrased any other way — or recorded in a review thread, a
          // journal, a chat — is invisible here, and saying otherwise taught the
          // reader to treat absence of evidence as evidence of absence.
          `merged touching ${elevatedFiles.length} elevated-tier path(s) with ` +
          'no human-review label, and no reviewer verdict this sweep could ' +
          'recognise in the body',
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

  // A non-array input is a caller mistake, not forty clean PRs.
  const rows = Array.isArray(prs) ? prs : [];

  let misses = 0;
  for (const pr of rows) {
    let finding;
    try {
      finding = classifyPr(pr, { elevatedPaths, epoch });
    } catch {
      // One unparseable row must not cost the findings on every other row.
      findings.push({
        kind: 'unreadable-record',
        pr: pr?.number ?? null,
        why: 'this merged PR could not be read, so it was not checked. That is an unknown, not a pass.',
        actions: ['journal-line'],
      });
      continue;
    }
    if (!finding) continue;
    const actions = [
      finding.lane === 'queue' ? 'comment-on-queue-item' : 'comment-on-pr',
      'journal-line',
    ];
    if (finding.kind === 'missed-gate') {
      if (misses >= 1) actions.push('escalation-issue');
      misses += 1;
    }
    findings.push({ ...finding, actions });
  }

  return { findings, sweptPrs: rows.length, epoch };
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
          'number,title,body,headRefName,mergedAt,url,labels,files,changedFiles',
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
    ? readInput(args.input, 'missed-gate sweep')
    : fetchMergedPrs(args.since ?? daysAgo(7));
  // No declaration anywhere reads as a blind sweep, and `sweep` reports that as
  // its own finding rather than as "no findings".
  const elevatedPaths = readDeclaredPaths(projectRoot);
  const result = sweep({ prs, elevatedPaths, epoch: args.epoch });
  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
}
