#!/usr/bin/env node
// Detect duplicate ticket branches and PRs before parallel work.
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
//   1. remote branches — `git ls-remote --heads origin` (one call, capped at
//      MAX_REFS refs read, fail-closed past the cap — see Limits);
//   2. open PRs — `gh pr list --state open --search "<id>" --json
//      number,title,headRefName,url,isCrossRepository --limit 101`, filtered
//      CLIENT-SIDE by the same token rule. GitHub's `--search` is fuzzy; the
//      filter, not the search, is the authority —
//      `test/template/duplicate-work.test.ts` (absent in a generated rig) ›
//      "exit 0 — gh's fuzzy search returns a PR whose title/head do not carry
//      the exact token, filtered out client-side".
//
// Each source reports one of THREE statuses, not two:
//   read           — consulted; its list is trusted evidence
//   unavailable    — applicable but could not be read (gh missing, a cap
//                    hit, an unreachable remote) — never read as "no match"
//   not-applicable — nothing to check: no `origin` remote at all (both
//                    sources — `git remote get-url origin` answering "No
//                    such remote", never any other git failure), or (the
//                    `pr` source only) `gh` itself reporting that none of
//                    the configured remotes point to a known GitHub host —
//                    decided by what `gh` answers, never by reading the
//                    origin URL's text (see Limits)
//
// Matching is a token match bounded by non-alphanumerics — `_` counts as a
// boundary too, which a plain `\b` does not (it treats `_` as a word
// character) — never fuzzy title matching: `matchesTicket('RP-220', text)`
// looks for `RP-220` in `text` at that boundary, case-insensitively. A bare
// issue number (`220`, no letter prefix) is matched far more narrowly — only
// `#220` in a title, or a `<type>/220-` branch token — because a loose number
// is common English text, not a ticket reference.
//
// The current checkout's own branch, and any open, SAME-REPOSITORY PR whose
// `headRefName` is that branch, are excluded: that is this controller's own
// work, not a duplicate. A fork PR naming the same branch is NOT excluded —
// `headRefName` alone does not prove the PR belongs to this repository.
//
// Exit codes:
//   0  clean          — every APPLICABLE source was read and nothing else
//                        carries the id (all sources may be not-applicable)
//   2  duplicate-work — another branch or PR carries the id (see stdout for
//                        which one, and the field that matched) — a match
//                        outranks an unavailable other source
//   3  unverifiable   — an applicable source could not be read (gh missing,
//                        a cap hit); the caller MUST treat this as not-clean
//   1  usage refusal  — no/invalid --ticket, or an unknown flag
//
// `--json` prints one object:
//   { ticket, verdict, matches: [{ source, ref, field, url? }],
//     sources: [{ name, status }] }
//
// The verdict is always printed before the run journal is touched, so a
// journal failure downstream can only ever add a stderr warning — it never
// withholds or changes the exit code the caller already computed (see the
// journal-failure note in Limits). When `RIG_RUN_DIR` is declared, one event
// (`kind: 'duplicate-work'`, `data` the object above) is appended to this
// run's journal — silently, like every other optional trace in this rig, so
// an undeclared run writes nothing.
//
// --- Limits -----------------------------------------------------------
//
// - A cap hit fails CLOSED, never a silent slice: more than MAX_REFS branch
//   refs, or a PR listing that still fills `--limit 101`, reports that
//   source `unavailable` rather than reading (and matching against) only the
//   first page — `test/template/duplicate-work.test.ts` (absent in a
//   generated rig) › "exit 3, verdict unverifiable — branch source hits the
//   ref cap and fails closed, never a silent slice" and › "exit 3 — 101 open
//   PRs is the cap: pr source unavailable, never a silent read of the first
//   100".
// - A bare issue number matches only `#<n>` in a title or a `<type>/<n>-`
//   branch token, never a loose number in prose —
//   `test/template/duplicate-work.test.ts` (absent in a generated rig) ›
//   "matchesTicket — a token match bounded by non-alphanumerics, never
//   fuzzy" (the bare-issue-number cases).
// - `gh` missing (a spawn error) or failing for any reason OTHER than "no
//   known GitHub host among the configured remotes" reports the `pr` source
//   `unavailable`, never read as "no PR" —
//   `test/template/duplicate-work.test.ts` (absent in a generated rig) ›
//   "exit 3, verdict unverifiable — gh is missing/failing on a GitHub
//   origin, never reported as clean".
// - The `branch` source reads only the remote named `origin` — a fork
//   workflow that pushes to a differently-named remote, or renames `origin`,
//   is invisible to it.
// - With no `origin` at all, `gh` is never asked: both sources are
//   `not-applicable` and the verdict is `clean` —
//   `test/template/duplicate-work.test.ts` (absent in a generated rig) ›
//   "exit 0, verdict clean — no origin remote at all makes BOTH sources not-applicable".
//   A checkout that shares work through a remote with any other name is
//   therefore not checked at all.
// - Otherwise the `pr` source reads the repository `gh` selects among the
//   configured remotes, by gh's own rules — not necessarily `origin`. Which
//   repository gh queried is not checked here: an untested design limit.
// - Any `gh` answer of "no known GitHub host" makes the `pr` source
//   `not-applicable`, whatever the host —
//   `test/template/duplicate-work.test.ts` (absent in a generated rig) ›
//   "exit 0, verdict clean — gh answers "not a known GitHub host", so the PR source is not-applicable (decided by gh, not URL text)".
//   A GitHub host gh does not recognise therefore has its PRs read as
//   `not-applicable`, not `unavailable`.
// - On a non-GitHub tracker rig, telling "not applicable" apart from "gh
//   could not be reached" still needs `gh` installed and runnable: it is
//   `gh`'s own refusal message that reports "not a GitHub remote" now (see
//   the module header), not a read of the origin URL's text, so a rig with
//   no `gh` on PATH at all reports the `pr` source `unavailable` rather than
//   `not-applicable`, even where no GitHub remote was ever going to apply.
// - A journal write failure never hides an already-computed verdict — the
//   verdict is printed first, and only a stderr warning follows a failed
//   write — `test/template/duplicate-work.test.ts` (absent in a generated
//   rig) › "a journal write failure still prints the verdict, and the exit
//   code is the verdict's — never the usage-refusal 1".
// - Own-work exclusion is exact-string: the checkout's current branch name,
//   and a same-repository PR's `headRefName` equal to it. A rename, a fork
//   working the same ticket under a differently-spelled branch, or a
//   detached HEAD (`git rev-parse --abbrev-ref HEAD` answers the literal
//   string `HEAD`, which matches no real branch name) is not recognised as
//   "own" — pinned, not just documented: `test/template/duplicate-work.test.ts`
//   (absent in a generated rig) › "detached HEAD — own-work exclusion
//   misses, so the checkout's own branch is (mis)reported as a duplicate
//   (pinned current behaviour)".
// - A same-id branch under a naming convention `matchesTicket` does not
//   recognise (no boundary-bounded occurrence of the id anywhere in the ref)
//   is not seen — an untested design limit: fuzzy title matching is
//   deliberately ruled out above for exactly this trade-off.
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
const PR_REQUEST_LIMIT = MAX_PRS + 1;
const MAX_BUFFER = 16 * 1024 * 1024;
const PR_FIELDS = 'number,title,headRefName,url,isCrossRepository';
// `git remote get-url origin`'s own exit code for "no such remote" — the
// ONLY git failure either source reads as "no origin". See `originStatus`.
const NO_ORIGIN_EXIT_CODE = 2;
// `gh`'s own wording when it cannot even tell the origin is a GitHub remote
// — read from gh's stderr, never from the origin URL's own text (round 3;
// see `openPrs`).
const GH_NOT_A_GITHUB_REMOTE = [
  /none of the git remotes configured for this repository point to a known GitHub host/i,
  /no git remotes found/i,
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A token match bounded by non-alphanumerics, never fuzzy.
 *
 * An id shaped like `RP-220` (a letter, then `-`, then digits) is matched
 * against a boundary built from a negative lookaround on `[A-Za-z0-9]` rather
 * than `\b`: `\b` treats `_` as a word character, so `rp-220_fix` would fail a
 * plain `\bRP-220\b` match even though no reasonable reading takes `220_fix`
 * as one token with `220` — `_` is itself a boundary here, matching
 * `feat/rp-220_fix`.
 *
 * A bare issue number (`220`, no letter prefix) is loose English text far too
 * often for the same kind of match to be safe — `there were 220 of them`
 * would match. So it is matched only as `#220` (a title reference) or as a
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
    const bounded = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`, 'i');
    return bounded.test(value);
  }
  return false;
};

/**
 * The verdict and evidence, from what the two sources answered.
 *
 * `branches`/`prs` are `{ status: 'read' | 'unavailable' | 'not-applicable',
 * refs/items }` — `status` decides whether the source's own list is trusted
 * at all, so only a `read` source contributes matches.
 *
 * Precedence: a match found from a source that WAS read always wins
 * (`duplicate-work`), regardless of the other source's status. Failing that,
 * any source left `unavailable` makes the result `unverifiable` — a source
 * that could not be read might have hidden a real duplicate. A source that is
 * `not-applicable` never does that: there is nothing there to hide (no
 * `origin` at all, or no remote gh knows as GitHub), so a checkout with
 * every source `not-applicable` — or a mix of `not-applicable` and `read` —
 * is `clean`, never `unverifiable`.
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
      const isOwnPr = pr.headRefName === ownBranch && pr.isCrossRepository !== true;
      if (isOwnPr) continue;
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
      : sources.some((source) => source.status === 'unavailable')
        ? 'unverifiable'
        : 'clean';

  return { ticket, verdict, matches, sources };
};

const EXIT_CODES = Object.freeze({ clean: 0, 'duplicate-work': 2, unverifiable: 3 });

// --- Acquisition -----------------------------------------------------------

/** The checkout's own current branch, or `null` when it cannot be told
 *  (including a detached HEAD, which answers the literal string `HEAD` — see
 *  the Limits note on why that is not recognised as "own" either). */
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

/**
 * `git remote get-url origin`'s own answer, read for its EXIT CODE rather
 * than the URL's text. `noOrigin: true` is git's own "No such remote
 * 'origin'" (exit code `NO_ORIGIN_EXIT_CODE`) — the one git failure both
 * sources read as "nothing to compare against". Any OTHER git failure (a
 * non-repo cwd's fatal exit, a corrupt config, git itself missing) comes
 * back as `ok: false, noOrigin: false`: a real failure, not an absence, so
 * the branch source reports it `unavailable` rather than folding it into
 * "no origin" — and the pr source still goes on to ask `gh`, since only the
 * exit-code-2 case rules that out (see `openPrs`).
 */
const originStatus = (cwd) => {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
    }).trim();
    return { ok: true, noOrigin: false, url };
  } catch (error) {
    return { ok: false, noOrigin: error?.status === NO_ORIGIN_EXIT_CODE };
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
 * `{ status, refs }` for the `branch` source: `not-applicable` with no
 * `origin` at all (`origin.noOrigin`); `unavailable` when `origin` itself
 * could not be resolved for any OTHER reason (a non-repo cwd, a corrupt
 * config); otherwise one `git ls-remote` call, capped at `MAX_REFS` — more
 * refs than that, or any other git failure (unreachable remote, a buffer
 * overflow past `MAX_BUFFER`), reports `unavailable`, never a truncated
 * `read`.
 */
const remoteBranches = (cwd, origin) => {
  if (origin.noOrigin) return { status: 'not-applicable', refs: [] };
  if (!origin.ok) return { status: 'unavailable', refs: [] };
  try {
    const raw = execFileSync('git', ['ls-remote', '--heads', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
      maxBuffer: MAX_BUFFER,
    });
    const refs = parseHeads(raw);
    if (refs.length > MAX_REFS) return { status: 'unavailable', refs: [] };
    return { status: 'read', refs };
  } catch {
    return { status: 'unavailable', refs: [] };
  }
};

/**
 * `{ status, items }` for the `pr` source: `not-applicable` with no `origin`
 * at all (`origin.noOrigin`) — `gh` is never even asked then. Otherwise,
 * applicability is decided by what `gh` itself answers, never by the
 * origin URL's spelling (round 3 retires that heuristic — a GHE alias or a
 * non-`github.com` hostname mapped in `gh`'s own config is exactly the case
 * it got wrong): one `gh pr list` call, asked for `MAX_PRS + 1` rows.
 * Getting that many back means there may be more than `MAX_PRS` open PRs
 * matching the search, so the source reports `unavailable` (cap) rather than
 * reading only the first page. A `gh` failure is read from what it reports:
 * `gh` missing entirely (a spawn error, no stderr to read) is `unavailable`;
 * `gh` failing with stderr saying it found no known GitHub host among the
 * configured remotes is `not-applicable` — gh's own answer that no remote
 * of this checkout is one it can query; any other `gh` failure, or a JSON body that is
 * not an array, is `unavailable` — never "no PR".
 */
const openPrs = (ticket, cwd, origin) => {
  if (origin.noOrigin) return { status: 'not-applicable', items: [] };
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
        String(PR_REQUEST_LIMIT),
      ],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: withoutGitLocation(),
        maxBuffer: MAX_BUFFER,
      },
    );
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { status: 'unavailable', items: [] };
    if (parsed.length > MAX_PRS) return { status: 'unavailable', items: [] };
    return {
      status: 'read',
      items: parsed.map((row) => ({
        number: row?.number,
        title: typeof row?.title === 'string' ? row.title : '',
        headRefName: typeof row?.headRefName === 'string' ? row.headRefName : '',
        url: typeof row?.url === 'string' ? row.url : undefined,
        isCrossRepository: row?.isCrossRepository === true,
      })),
    };
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const notAGitHubRemote = GH_NOT_A_GITHUB_REMOTE.some((pattern) => pattern.test(stderr));
    return { status: notAGitHubRemote ? 'not-applicable' : 'unavailable', items: [] };
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
      `- ${match.source}: ${JSON.stringify(match.ref)} (matched ${match.field}` +
        `${match.url ? `, ${JSON.stringify(match.url)}` : ''})`,
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
      'Not every applicable source could be read, so this is not a clean result — treat it ' +
        'as NOT clean.',
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
  const origin = originStatus(cwd);
  const branches = remoteBranches(cwd, origin);
  const prs = openPrs(parsed.ticket, cwd, origin);
  const result = classify({ ticket: parsed.ticket, ownBranch, branches, prs });
  const exitCode = EXIT_CODES[result.verdict];

  // Printed BEFORE the journal write below, deliberately: exit 1 must never
  // hide a verdict that was already computed, so a journal failure past this
  // point can only ever add a stderr warning.
  process.stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : renderText(result));

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
      const traceOnly = typeof exhausted === 'function' && exhausted(error);
      const note = traceOnly
        ? 'the duplicate-work check above still stands; only its trace was not recorded.'
        : 'the verdict above still stands; only its journal entry was not written.';
      process.stderr.write(`run journal: ${error?.message ?? error}\n  ${note}\n`);
    }
  }

  process.exit(exitCode);
}
