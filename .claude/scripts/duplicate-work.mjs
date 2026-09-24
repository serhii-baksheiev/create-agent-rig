#!/usr/bin/env node
// Detect duplicate ticket branches and PRs before parallel work.
// (.claude/runs/20260924-070359-rp-222/brief.md, "Detect duplicate ticket
// branches and PRs before parallel work" — RP-222.)
//
// Two independent controllers can pick up the same ticket id at the same
// time, and nothing in this rig registers a claim anywhere both would see —
// `.rig/claims/<id>.json` versions revalidation state, it is not a lock. This
// script is the cheap check that runs before either moment costs real work:
// before a claim, and again before a PR.
//
//   node .claude/scripts/duplicate-work.mjs --ticket RP-220 [--json]
//
// It reads two bounded, native sources — never a branch registry this rig
// would have to keep in sync:
//
//   1. remote branches — `git ls-remote --heads origin` (one call, at most
//      5,000 refs read);
//   2. open PRs — `gh pr list --state open --search "<id>" --json
//      number,title,headRefName,url --limit 100`, filtered CLIENT-SIDE by the
//      same token rule. GitHub's `--search` is fuzzy; the filter, not the
//      search, is the authority — see the "gh's fuzzy search" test below.
//
// Matching is a token match bounded by non-alphanumerics, never fuzzy title
// matching: `matchesTicket('RP-220', text)` looks for `RP-220` in `text` at a
// word boundary, case-insensitively. A bare issue number (`220`, no letter
// prefix) is matched far more narrowly — only `#220` in a title, or a
// `<type>/220-` branch token — because a loose number is common English text,
// not a ticket reference.
//
// The current checkout's own branch, and any PR whose `headRefName` is that
// branch, are excluded: that is this controller's own work, not a duplicate.
//
// Exit codes:
//   0  clean          — every source was read; nothing else carries the id
//   2  duplicate-work — another branch or PR carries the id (see stdout for
//                        which one, and the field that matched)
//   3  unverifiable   — a source could not be read (gh missing, no `origin`,
//                        a cap hit); the caller MUST treat this as not-clean
//   1  usage refusal  — no/invalid --ticket, or an unknown flag
//
// `--json` prints one object:
//   { ticket, verdict, matches: [{ source, ref, field, url? }],
//     sources: [{ name, status }] }
//
// When `RIG_RUN_DIR` is declared, one event (`kind: 'duplicate-work'`, `data`
// the object above) is appended to this run's journal — silently, like every
// other optional trace in this rig, so an undeclared run writes nothing.
//
// --- Limits -----------------------------------------------------------
//
// - GitHub search is fuzzy and the client-side token filter is the
//   authority, not `gh`'s own ranking — `test/template/duplicate-work.test.ts`
//   (absent in a generated rig) › "exit 0 — gh's fuzzy search returns a PR
//   whose title/head do not carry the exact token, filtered out client-side".
// - A bare issue number matches only `#<n>` in a title or a `<type>/<n>-`
//   branch token, never a loose number in prose —
//   `test/template/duplicate-work.test.ts` (absent in a generated rig) ›
//   "matchesTicket — a token match bounded by non-alphanumerics, never
//   fuzzy" (the bare-issue-number cases).
// - `gh` missing, unauthenticated, or the repo having no GitHub remote all
//   read the same way: the `pr` source is `unavailable`, never read as "no
//   PR" — `test/template/duplicate-work.test.ts` (absent in a generated rig)
//   › "exit 3, verdict unverifiable — gh is missing/failing, never reported
//   as clean".
// - No `origin` remote makes the `branch` source `unavailable` the same way
//   — `test/template/duplicate-work.test.ts` (absent in a generated rig) ›
//   "exit 3 — no origin remote at all".
// - Own-work exclusion is exact-string: the checkout's current branch name,
//   and a PR's `headRefName` equal to it. A rename, a fork working the same
//   ticket under a differently-spelled branch, or a detached HEAD is not
//   recognised as "own" — untested design limit.
// - `git ls-remote --heads origin` is capped at 5,000 refs read; a remote
//   with more is truncated silently past that point — untested design
//   limit, and a branch registry was explicitly ruled out by the brief as
//   the alternative.
// - A same-id branch under a naming convention `matchesTicket` does not
//   recognise (no word-bounded occurrence of the id anywhere in the ref) is
//   not seen — untested design limit; the brief rules out fuzzy title
//   matching for exactly this trade-off.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// One implementation of the sanitised git environment, imported rather than
// reimplemented — `git-env.mjs`'s own header has the incident this guards
// against. All upstream test pointers in this script name the generator
// suite, absent in a generated rig.
import { withoutGitLocation } from './git-env.mjs';

const ID_SHAPE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const BARE_NUMBER_SHAPE = /^\d+$/;
const MAX_REFS = 5000;
const MAX_PRS = 100;
const PR_FIELDS = 'number,title,headRefName,url';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A token match bounded by non-alphanumerics, never fuzzy.
 *
 * An id shaped like `RP-220` (a letter, then `-`, then digits) is matched at
 * a word boundary, case-insensitively — `\bRP-220\b` finds it in
 * `rp-220-verified-claims` and refuses `rp-2200`/`rp-22`/`xrp-220`, because a
 * word boundary sits only where an alphanumeric run starts or ends.
 *
 * A bare issue number (`220`, no letter prefix) is loose English text far too
 * often for a plain `\b` match to be safe — `there were 220 of them` would
 * match. So it is matched only as `#220` (a title reference) or as a
 * `<type>/220-` branch token (`fix/220-my-work`), never as a number sitting
 * on its own.
 */
export const matchesTicket = (id, text) => {
  const value = typeof text === 'string' ? text : '';
  if (BARE_NUMBER_SHAPE.test(id)) {
    const number = escapeRegExp(id);
    const issueRef = new RegExp(`#${number}(?!\\d)`);
    const branchToken = new RegExp(`(^|/)${number}-`);
    return issueRef.test(value) || branchToken.test(value);
  }
  if (ID_SHAPE.test(id)) {
    return new RegExp(`\\b${escapeRegExp(id)}\\b`, 'i').test(value);
  }
  return false;
};

/**
 * The verdict and evidence, from what the two sources answered.
 *
 * `branches`/`prs` are `{ status: 'read' | 'unavailable', refs/items }` —
 * `status` decides whether the source's own list is trusted at all, so an
 * `unavailable` source contributes no matches even if it carries stale data.
 *
 * A match found from an `unavailable` source could never occur (its list is
 * never consulted), so `duplicate-work` always outranks `unverifiable`: any
 * match found from a source that WAS read is real evidence, regardless of
 * whether the other source could be read.
 */
export const classify = ({
  ticket,
  ownBranch = null,
  branches = { status: 'unavailable', refs: [] },
  prs = { status: 'unavailable', items: [] },
} = {}) => {
  const matches = [];

  if (branches.status === 'read') {
    for (const ref of branches.refs ?? []) {
      if (ref === ownBranch) continue;
      if (matchesTicket(ticket, ref)) matches.push({ source: 'branch', ref, field: 'ref' });
    }
  }

  if (prs.status === 'read') {
    for (const pr of prs.items ?? []) {
      if (pr.headRefName === ownBranch) continue;
      if (matchesTicket(ticket, pr.title)) {
        matches.push({ source: 'pr', ref: pr.headRefName, field: 'title', url: pr.url });
      } else if (matchesTicket(ticket, pr.headRefName)) {
        matches.push({ source: 'pr', ref: pr.headRefName, field: 'headRefName', url: pr.url });
      }
    }
  }

  const sources = [
    { name: 'branch', status: branches.status },
    { name: 'pr', status: prs.status },
  ];

  const verdict =
    matches.length > 0
      ? 'duplicate-work'
      : sources.some((source) => source.status !== 'read')
        ? 'unverifiable'
        : 'clean';

  return { ticket, verdict, matches, sources };
};

const EXIT_CODES = Object.freeze({ clean: 0, 'duplicate-work': 2, unverifiable: 3 });

// --- Acquisition -----------------------------------------------------------

/** The checkout's own current branch, or `null` when it cannot be told. */
const currentBranch = (cwd) => {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
    }).trim();
  } catch {
    return null;
  }
};

/** `refs/heads/<name>` lines from `git ls-remote --heads` → bare branch names. */
const parseHeads = (raw) =>
  raw
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter((ref) => typeof ref === 'string' && ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));

/**
 * `{ status, refs }` for the `branch` source: one `git ls-remote` call,
 * capped at `MAX_REFS`. A missing `origin`, an unreachable remote, or any
 * other git failure reports `unavailable` — never an empty, "clean" list.
 */
const remoteBranches = (cwd) => {
  try {
    const raw = execFileSync('git', ['ls-remote', '--heads', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
    });
    return { status: 'read', refs: parseHeads(raw).slice(0, MAX_REFS) };
  } catch {
    return { status: 'unavailable', refs: [] };
  }
};

/**
 * `{ status, items }` for the `pr` source: one `gh pr list` call. `gh`
 * missing, unauthenticated, offline, or answering with something other than
 * a JSON array all report `unavailable` — never "no PR".
 */
const openPrs = (ticket, cwd) => {
  try {
    const raw = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--search',
        ticket,
        '--json',
        PR_FIELDS,
        '--limit',
        String(MAX_PRS),
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { status: 'unavailable', items: [] };
    return {
      status: 'read',
      items: parsed.slice(0, MAX_PRS).map((row) => ({
        number: row?.number,
        title: typeof row?.title === 'string' ? row.title : '',
        headRefName: typeof row?.headRefName === 'string' ? row.headRefName : '',
        url: typeof row?.url === 'string' ? row.url : undefined,
      })),
    };
  } catch {
    return { status: 'unavailable', items: [] };
  }
};

// --- CLI -----------------------------------------------------------------------------

const parseArgs = (argv) => {
  let ticket = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--ticket') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: '--ticket needs a value (a ticket id such as RP-220, or a bare issue number)' };
      }
      ticket = value;
      i += 1;
    } else if (flag === '--json') {
      json = true;
    } else {
      return { error: `unknown flag ${flag}` };
    }
  }
  if (!ticket) {
    return { error: 'usage: node duplicate-work.mjs --ticket <ticket-id> [--json]' };
  }
  if (!ID_SHAPE.test(ticket) && !BARE_NUMBER_SHAPE.test(ticket)) {
    return {
      error:
        `--ticket ${JSON.stringify(ticket)} is not a ticket-id shape (e.g. RP-220) or a ` +
        'bare issue number (e.g. 220)',
    };
  }
  return { ok: true, ticket, json };
};

const renderText = (result) => {
  const lines = [
    `duplicate-work: ${result.ticket} — ${result.verdict}`,
    `sources: ${result.sources.map((source) => `${source.name}=${source.status}`).join(', ')}`,
  ];
  for (const match of result.matches) {
    lines.push(
      `- ${match.source}: ${match.ref} (matched ${match.field}${match.url ? `, ${match.url}` : ''})`,
    );
  }
  if (result.verdict === 'duplicate-work') {
    lines.push(
      '',
      `Another branch or open PR already carries ${result.ticket}. Re-read the item and ` +
        'the other branch/PR: take over through the tracker, or stop here — never start a ' +
        'second implementation.',
    );
  } else if (result.verdict === 'unverifiable') {
    lines.push(
      '',
      'Not every source could be read, so this is not a clean result — treat it as NOT clean.',
    );
  }
  return `${lines.join('\n')}\n`;
};

/**
 * Was this file invoked directly?
 *
 * Compared by REALPATH on both sides, exactly as its siblings do — see
 * `detect-missed-gate.mjs`'s copy of this same function for the symlink case
 * it guards against.
 */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`usage: node duplicate-work.mjs --ticket <ticket-id> [--json]\n${parsed.error}\n`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const ownBranch = currentBranch(cwd);
  const branches = remoteBranches(cwd);
  const prs = openPrs(parsed.ticket, cwd);
  const result = classify({ ticket: parsed.ticket, ownBranch, branches, prs });
  const exitCode = EXIT_CODES[result.verdict];

  // Written only when the run declared `RIG_RUN_DIR` — undeclared means
  // nothing is written, silently, like every other optional trace in this
  // rig (no default run-directory convention is invented here).
  const runDir = process.env.RIG_RUN_DIR;
  if (runDir) {
    let journal = null;
    try {
      journal = await import('./run-journal.mjs');
      journal.recordEvent({ runDir, kind: 'duplicate-work', data: result, now: new Date().toISOString() });
    } catch (error) {
      const exhausted = journal?.isTraceExhausted;
      if (typeof exhausted === 'function' && exhausted(error)) {
        process.stderr.write(
          `run journal: ${error.message}\n  the duplicate-work check above still stands; ` +
            'only its trace was not recorded.\n',
        );
      } else {
        process.stderr.write(`run journal: ${error?.message ?? error}\n`);
        process.exit(1);
      }
    }
  }

  process.stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : renderText(result));
  process.exit(exitCode);
}
