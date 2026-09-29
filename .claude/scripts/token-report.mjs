#!/usr/bin/env node
/**
 * token-report.mjs — read-only, deterministic. Turns the dispatch evidence
 * RP-225 already journals (`dispatch-start`/`dispatch-end` events,
 * `.claude/hooks/record-dispatch.mjs`) into engineering economics: how many
 * tokens moved, for which ticket, dispatched by which controller/harness, as
 * which agent role, declared for which model/effort — correlated with the
 * selection loop's own `item-selection` decisions and the reviewer fan-out's
 * `reviewer-fan-out`/per-reviewer decisions already in the run journal. See
 * test/template/token-report.test.ts (absent in a generated rig) for the
 * exact contract.
 *
 *   node .claude/scripts/token-report.mjs --since <ISO> [--runs <dir>] [--json]
 *
 * `--json` prints the full structured report — test/template/token-report.test.ts
 * (absent in a generated rig) › "exits 0 with a JSON document on --json".
 * Without it, the default is a short human text render — runs read/skipped,
 * one line per dispatch group (run, controller/harness, ticket, agentType,
 * model/effort, dispatch counts, per-harness usage), one line per ticket
 * occurrence (attempts, gate rounds, outcome, wall time, dispatches) —
 * ending with the money line — test/template/token-report.test.ts (absent
 * in a generated rig) › "the text render ends with the money line".
 *
 * Reads `<runs>/<run-id>/` the same way `revalidation-report.mjs` does —
 * this script reuses that script's `readRuns` (default `--runs` also
 * resolves through `queue/checkout.mjs`'s `mainCheckoutRoot`, the same
 * main-checkout rule) and `run-journal.mjs`'s `readRun`. A run `readRun`
 * refuses is counted under `runs.skipped`, with why, never dropped silently
 * — test/template/token-report.test.ts (absent in a generated rig) › "a run
 * readRun refuses is counted under skipped, with why, and excluded from
 * every other section".
 *
 * It is read-only: no write/append call appears in this file's own source —
 * test/template/token-report.test.ts (absent in a generated rig) › "contains
 * no write-call literal in its own source" — and running it, CLI included,
 * leaves every run directory byte-identical — test/template/token-report.test.ts
 * (absent in a generated rig) › "leaves the run-directory tree byte-identical
 * after tokenReportOf and the CLI both run".
 *
 * `--since` is a PER-RECORD filter — `Date.parse(record.at) >= since`,
 * applied to every decision and event before attribution or grouping ever
 * sees it, mirroring `revalidation-report.mjs`'s own `at >= since` semantics
 * (a record whose own `at` fails to parse falls OUT, the same NaN-safe
 * direction that script takes) — test/template/token-report.test.ts (absent
 * in a generated rig) › "excludes a decision or dispatch whose own at is
 * before --since from every section, mirroring revalidation-report.mjs's at
 * >= since semantics".
 *
 * DISPATCH GROUPING — one row per (run, controller, harness, ticket,
 * agentType, model, effort) combination actually seen in a `dispatch-start`
 * event — test/template/token-report.test.ts (absent in a generated rig) ›
 * "groups one dispatch pair by its declared model/effort, with the ticket
 * the selection named". `controller`/`harness`/`agentType` are `'unknown'`
 * when the start record carries no such field, never guessed —
 * test/template/token-report.test.ts (absent in a generated rig) › "reports
 * unknown (never guessed) for every field a dispatch record omits". Each of
 * the three is trusted only as a non-empty string, else `'unknown'` — never
 * coerced — so a non-string value (an array, or an object with a
 * non-callable `toString`) neither leaks a raw value into the group key nor
 * crashes the report — test/template/token-report.test.ts (absent in a
 * generated rig) › "a dispatch-start whose agentType is an array carrying a
 * terminal escape is not trusted as a string: it renders as unknown, and the
 * text output carries no control character", and test/template/token-report.test.ts
 * (absent in a generated rig) › "a dispatch-start whose controller has a
 * non-callable toString does not crash the report: it exits 0, a healthy run
 * next to it is still reported, and the field reads unknown".
 * `model`/`effort` are the start's own `declaredModel`/`declaredEffort` when
 * present (`modelSource`/`effortSource`: `'declared'`), else
 * `'unknown'`/`'unknown'` — this script never infers a model from anywhere
 * else. A Claude dispatch and a Codex dispatch are always separate groups,
 * each carrying only its own harness's usage object — usage is never summed
 * across harnesses — test/template/token-report.test.ts (absent in a
 * generated rig) › "a Claude dispatch and a Codex dispatch under the same
 * ticket and agent role render as two separate groups, never summed".
 *
 * USAGE — a group's `usage.claude`/`usage.codex` is the SUM, per numeric
 * field, across every ended dispatch in that group whose `dispatch-end`
 * carried a `usage` object — test/template/token-report.test.ts (absent in
 * a generated rig) › "sums a numeric usage counter across every ended
 * dispatch in the same group". A field absent or non-numeric on ANY
 * usage-bearing dispatch in the group makes the group's total for that
 * field `null` — never a partial sum, and never `0` for "not measured" —
 * test/template/token-report.test.ts (absent in a generated rig) › "a
 * counter present on one usage-bearing dispatch and absent on another in
 * the same group is null, never partially summed", and test/template/token-report.test.ts
 * (absent in a generated rig) › "an absent claude usage field is null, not
 * zero" (codex: › "an absent codex usage field is null, not zero"). Each
 * group's `dispatches.withUsage` — how many of its ended dispatches carried
 * a usage object — is present only when that count is strictly between `0`
 * and `dispatches.ended`, so a fully- or never-measured group is not made
 * noisier than the plain `ended`/`noEndObserved` pair already is —
 * test/template/token-report.test.ts (absent in a generated rig) › "each
 * group reports how many of its dispatches carried usage, so partial
 * coverage is visible". A `usage` object present on a `dispatch-end` but
 * carrying no finite numeric field (e.g. `{}`) is not usage: it does not
 * count toward `withUsage`, does not flip the money line, and its slot
 * stays `null` — test/template/token-report.test.ts (absent in a generated
 * rig) › "a dispatch with usage: {} (no numeric field) does not flip the
 * money line to "usage measured" and is not counted as withUsage".
 *
 * TICKET ATTRIBUTION — which ticket a record (a dispatch-start, here) belongs
 * to is the latest `item-selection` decision whose verdict matches
 * `/^taken (.+)$/` at a smaller seq than the record's own; a
 * "stopped" selection is invisible to attribution: dispatches after it
 * still belong to the last taken ticket — test/template/token-report.test.ts
 * (absent in a generated rig) › "a "stopped" selection is invisible to
 * attribution: dispatches after it still belong to the last taken ticket".
 * A record with no such decision before it attributes to `'no-ticket'` —
 * test/template/token-report.test.ts (absent in a generated rig) › "a
 * dispatch before any selection in the run is bucketed under no-ticket".
 *
 * TICKET OCCURRENCES — each `taken <id>` selection opens exactly one
 * occurrence, whose WINDOW (gateRounds/reviewerOutcomes/outcome/wallTimeMs/
 * dispatches) runs from that decision's own seq up to the seq of the very
 * next `item-selection` decision of ANY verdict — including `stopped`, which
 * closes the window without opening one of its own — or the run end when
 * there is none after it — test/template/token-report.test.ts (absent in a
 * generated rig) › "measures from the selection to the next selection,
 * whatever its verdict", and test/template/token-report.test.ts (absent in
 * a generated rig) › "measures to the run end when there is no next
 * selection". `gateRounds` counts `reviewer-fan-out` decisions in the
 * window; `reviewerOutcomes` tallies, by `gate` name and `verdict`, every
 * OTHER decision in the window whose `gate` is one the window's own
 * `reviewer-fan-out` decision(s) actually named in their `reviewers` list —
 * a gate that ran without being named by a fan-out round (`check-premises`,
 * a `review-routing:*` lane) is invisible to both `reviewerOutcomes` and
 * `outcome` — test/template/token-report.test.ts (absent in a generated
 * rig) › "excludes check-premises and review-routing:* decisions from
 * reviewerOutcomes even though they fall inside the window". `outcome` maps
 * each such reviewer gate to its verdict from after the window's LAST
 * `reviewer-fan-out` round — one verdict per reviewer, not a tally — or
 * `null` when the window has no fan-out round at all —
 * test/template/token-report.test.ts (absent in a generated rig) › "counts
 * reviewer-fan-out decisions in the window, tallies every round, and
 * reports the last round as the outcome", and test/template/token-report.test.ts
 * (absent in a generated rig) › "a window with no reviewer-fan-out at all
 * reports zero gate rounds and a null outcome". `attempts` is a count of
 * `taken <id>` decisions for that ticket across every run read, not scoped
 * to one run — test/template/token-report.test.ts (absent in a generated
 * rig) › "attempts counts "taken <id>" across every run read, not scoped to
 * one run". One synthetic `'no-ticket'` entry covers every record — decision
 * or event, of any kind — that sits before a run's first `item-selection`
 * decision of any verdict, when any such record exists; its occurrences
 * carry `seq`/`at`/`wallTimeMs` as `null` — there is no selection to measure
 * from.
 *
 * DISPATCH PAIRING — a `dispatch-start`/`dispatch-end` pair sharing the same
 * `agentRef` (matched FIFO per `agentRef`, oldest unmatched start first) is
 * `ended`; a `dispatch-start` with no matching `dispatch-end` is
 * `noEndObserved` — test/template/token-report.test.ts (absent in a
 * generated rig) › "pairs a dispatch-start and dispatch-end sharing
 * agentRef as ended", and test/template/token-report.test.ts (absent in a
 * generated rig) › "a dispatch-start with no matching dispatch-end counts
 * as noEndObserved". A run that journals NO dispatch event at all (neither
 * kind) reports `dispatches: 'unavailable'` for every occurrence in that
 * run — never `0`, which would read as "checked and found none" —
 * test/template/token-report.test.ts (absent in a generated rig) › "a run
 * with no dispatch events at all reports dispatches as unavailable, never
 * zero".
 *
 * MONEY — `money.line` is exactly one of two sentences (Jira RP-225 comment
 * 20198): `'usage measured; monetary cost unavailable'` when at least one
 * DISPLAYED `dispatchGroups[].usage.claude`/`.codex` slot is non-null, else
 * `'usage unavailable; monetary cost unavailable'` —
 * test/template/token-report.test.ts (absent in a generated rig) › "reads
 * "usage measured; monetary cost unavailable" when any displayed dispatch
 * group carries usage", and test/template/token-report.test.ts (absent in a
 * generated rig) › "reads "usage unavailable; monetary cost unavailable"
 * when no dispatch anywhere carries usage". A dispatch whose harness this
 * script does not recognise never reaches a displayed slot, so it cannot
 * flip the line even though the dispatch itself carried usage —
 * test/template/token-report.test.ts (absent in a generated rig) › "a lone
 * unknown-harness usage does not flip the money line to "usage measured"
 * when no group displays it". `money.estimate` is always `null` — the
 * optional API-equivalent estimate from a user-supplied dated pricing file
 * is explicitly deferred, not in this script; the CLI refuses `--pricing` as
 * an unrecognised argument for the same reason — test/template/token-report.test.ts
 * (absent in a generated rig) › "refuses --pricing as an unrecognised
 * argument — the optional estimate is deferred, not in this PR".
 *
 * USAGE EVIDENCE (RP-292) — a dispatch group's own `usage.claude`/`usage.codex`
 * answers "was usage measured", never "was the dispatch/hook path even
 * available to measure it" — left implicit, a reader has to infer hook
 * wiring and dispatch-witness availability from the ABSENCE of a usage
 * object, which conflates "the hook never ran" with "the hook ran but the
 * harness did not report usage". `report.usageEvidence = { claude, codex,
 * controller }` makes that explicit instead — test/template/token-report.test.ts
 * (absent in a generated rig) › "reports configured-no-witness, with a
 * reason that configuration is not execution, when the hook is wired but no
 * dispatch was ever observed", › "reports not-configured — a different
 * state and reason than configured-no-witness — when the hook is not wired
 * and no dispatch was observed", › "reports witnessed from a dispatch-start
 * alone, even when the hook is not wired in configuration — witness comes
 * only from events", and › "never reports witnessed from configuration
 * alone, for either harness, when the run journals no dispatch event at
 * all".
 *
 * Per harness (`claude`/`codex`), `usageEvidence.<harness>` is `{ wiring,
 * state, reason, unavailableReasons }`. `state` is derived from JOURNALLED
 * EVENTS ONLY: `'witnessed'` iff at least one `dispatch-start`/`dispatch-end`
 * for that harness exists anywhere in the filtered set read, independent of
 * `wiring` — configuration can never by itself produce `'witnessed'`.
 * Otherwise `state` follows the caller-supplied `wiring` — `tokenReportOf`'s
 * new optional input `wiring: { claude, codex }`, each
 * `'configured'`/`'not-configured'`/`'unknown'`, defaulting to `'unknown'`
 * for both when omitted: `'configured'` becomes `'configured-no-witness'`,
 * and `'not-configured'`/`'unknown'` pass through unchanged. `'trusted'` is
 * never a reported state — Codex does not run project-level hooks for an
 * untrusted project, so an absence of Codex dispatch evidence is explained
 * in `reason`, never claimed as a trust verdict this script cannot observe
 * — test/template/token-report.test.ts (absent in a generated rig) › "reports
 * configured-no-witness with a reason naming that project-hook trust is not
 * observed and untrusted hooks are skipped silently, and never reports the
 * state "trusted"".
 *
 * `unavailableReasons` tallies, per harness, the same `usageUnavailable`
 * status code `record-dispatch.mjs` itself journals on a `dispatch-end`, of
 * every `dispatch-end` that harness journalled with one — restricted to a
 * safe identifier set (`recordUnavailableReason` below) rather than merely
 * the C0/DEL/C1 control range the text render strips elsewhere, and bounded:
 * at most `UNAVAILABLE_REASON_DISTINCT_CODES_MAX` (20) distinct codes per
 * harness per report, each truncated to `UNAVAILABLE_REASON_CODE_MAX_LENGTH`
 * (200) characters — never grown without bound — test/template/token-report.test.ts
 * (absent in a generated rig) › "tallies usageUnavailable reason codes per
 * harness in usageEvidence and in the rendered evidence line, while the
 * money line keeps its exact existing sentence", › "a dispatch-end carrying
 * usageUnavailable rollout-identity-mismatch tallies the same way a Claude
 * code does", › "a hostile usageUnavailable code carrying a control
 * character reaches neither the text nor the --json output raw", › "a code
 * carrying a literal newline plus a forged "usage evidence:" line does not
 * produce a second such line in the text render", and › "a code carrying a
 * bidi override control (U+202E) reaches neither the text nor the --json
 * output raw".
 *
 * `controller` is a FIXED statement, never a computation:
 * `record-dispatch.mjs` only journals `SubagentStart`/`SubagentStop`, never
 * the controller's (parent session's) own turn, so there is no journalled
 * evidence for it to report — test/template/token-report.test.ts (absent in
 * a generated rig) › "states that controller (parent session) usage is
 * unavailable, and why — only subagent dispatches are journalled".
 *
 * WIRING — the CLI's own `wiring` input to `tokenReportOf` (pure itself, and
 * tested directly above) is computed only by the CLI, from the `--runs`
 * directory's OWN git checkout — never the CLI's `cwd` — reading only that
 * checkout's `.claude/settings.json` and `.codex/hooks.json` for a
 * `record-dispatch.mjs` command declared under
 * `SubagentStart`/`SubagentStop`; this script never reads a personal/global
 * config (`~/.codex`, `~/.claude`). A `--runs` directory that is not itself
 * inside a git checkout reads as `'unknown'` for both harnesses — there is
 * nothing to read, not "read and found absent" — test/template/token-report.test.ts
 * (absent in a generated rig) › "the CLI reports wiring as unknown, never
 * not-configured, for a --runs directory that is not itself part of a git
 * checkout". Each config file read is bounded to `WIRING_FILE_MAX_BYTES`
 * (256 KiB — both files are a few KB to tens of KB in this repo today); a
 * file over that cap, unparseable, or unreadable for any reason other than
 * "does not exist" reads as `'unknown'` rather than guessed at; a config
 * file that genuinely does not exist reads as `'not-configured'` — a
 * successful read finding nothing declared, not a failure. render()'s text
 * output carries one `usage evidence: ...` line, immediately before the
 * money line, which stays exactly `{ line, estimate }` and last —
 * test/template/token-report.test.ts (absent in a generated rig) › "renders
 * the usage evidence line before the money line, which stays last, and
 * leaves money as exactly {line, estimate}".
 *
 * SAFETY — `reviewerOutcomes` and its per-gate `outcome` are keyed by a
 * journal-supplied `gate` name, so both are built on `Object.create(null)`
 * rather than an object literal: a gate literally named `__proto__` or
 * `constructor` is tallied under its own key instead of reaching
 * `Object.prototype`/the `Object` constructor itself —
 * test/template/token-report.test.ts (absent in a generated rig) › "a
 * decision whose gate is '__proto__', named as a reviewer by its own
 * fan-out, does not pollute Object.prototype for a later run in the same
 * report", and test/template/token-report.test.ts (absent in a generated
 * rig) › "a decision whose gate is literally 'constructor' is tallied under
 * its own key, not routed to the Function constructor". `unavailableReasons`
 * is built the same way, for the same reason: its keys are a
 * journal-supplied `usageUnavailable` string.
 *
 * LIMITS:
 *   - Grouping and attribution are exact-match only — no fuzzy ticket-id or
 *     model-name reconciliation is attempted.
 *   - A window opened by a `stopped` (or any non-`taken`) `item-selection`
 *     decision is never an occurrence; activity after such a decision and
 *     before the next `taken` one is visible only through dispatch-group
 *     attribution, never through any `tickets[].occurrences` entry.
 *   - This script does not validate that the harness's own usage accounting
 *     is correct — it only sums and never invents a number for a field a
 *     dispatch did not report.
 *   - Window and attribution scans are O(records × selections) per run — one
 *     filter pass per selection window, and one scan of `takenSelections`
 *     per dispatch. Fine at the journal sizes this rig produces; not bounded
 *     against an adversarially large journal.
 *   - ORPHAN DISPATCH-ENDS (RP-294) — `record-dispatch.mjs` marks a
 *     `dispatch-end` `orphan: true` when its `agentRef` has no earlier
 *     `dispatch-start` anywhere in the run's own journal AND the payload carries
 *     no valid `agent_type` (a harness-internal
 *     `SubagentStop`, not a real agent dispatch). This script trusts that
 *     explicit flag rather than re-deriving "orphan" from its own pairing
 *     miss — a `dispatch-end` with no matching start but no `orphan` field
 *     (e.g. a journal written before RP-294) is not counted as an orphan,
 *     and stays invisible to every count exactly as before. An orphan end is
 *     excluded from `dispatchGroups` and from every
 *     `tickets[].occurrences[].dispatches` count, and its total is reported
 *     separately as the top-level `orphanEnds` — summed across every run
 *     read — test/template/token-report.test.ts (absent in a generated rig)
 *     › "excludes an orphan dispatch-end (orphan: true, no matching start)
 *     from every dispatch count, and reports it as its own orphanEnds
 *     count".
 *   - The text render sanitizes the whole rendered document once, after every
 *     line (including the `JSON.stringify`-built `usage`/`outcome`
 *     fragments) is assembled — stripping C0 controls except `\n`/`\t`, DEL
 *     (U+007F) and the C1 range (U+0080-U+009F, including CSI U+009B) — so a
 *     hostile journal cannot plant a terminal escape in the operator's shell
 *     — test/template/token-report.test.ts (absent in a generated rig) › "the
 *     text render (default mode) contains no character in the
 *     C0(<space)/DEL/C1 control range from a hostile gate name, verdict, or
 *     usage evidenceSource". `--json` output goes through `JSON.stringify`,
 *     which escapes C0 on its own but leaves DEL/C1 raw; this script rewrites
 *     exactly that leftover range as `\u00XX` escapes, so the document still
 *     parses to the same values — test/template/token-report.test.ts (absent
 *     in a generated rig) › "--json output contains no raw DEL/C1 byte either
 *     — JSON.stringify does not escape \u007f-\u009f on its own — and still
 *     parses as JSON".
 *   - `usageEvidence.<harness>.unavailableReasons` caps at
 *     `UNAVAILABLE_REASON_DISTINCT_CODES_MAX` (20) distinct codes per harness
 *     per report, each truncated to `UNAVAILABLE_REASON_CODE_MAX_LENGTH`
 *     (200) characters — a dispatch-end journalling many, or one arbitrarily
 *     long, `usageUnavailable` code cannot grow the report without bound —
 *     test/template/token-report.test.ts (absent in a generated rig) › "keeps
 *     exactly %s distinct codes when more than that many are journalled" and
 *     › "truncates a usageUnavailable code longer than %s characters to
 *     exactly that length".
 *   - The CLI's wiring resolution reads at most `WIRING_FILE_MAX_BYTES` (256
 *     KiB) from each of `.claude/settings.json`/`.codex/hooks.json`, bounded
 *     on bytes actually READ rather than on `stat().size` (which a virtual
 *     file can misreport) — test/template/token-report.test.ts (absent in a
 *     generated rig) › "finishes within a bound and reports claude wiring as
 *     unknown when .claude/settings.json is a symlink to /proc/self/pagemap,
 *     instead of reading it without bound" (codex: › "… .codex/hooks.json is
 *     a symlink to /proc/self/pagemap …").
 *   - It runs one bounded (5s timeout) `git rev-parse --show-toplevel` per
 *     invocation to find the `--runs` directory's own checkout root, correct
 *     for a linked worktree and a `--separate-git-dir` checkout alike (never
 *     the main checkout, and never wherever a detached git directory
 *     happens to live) — test/template/token-report.test.ts (absent in a
 *     generated rig) › "reads the worktree's own .claude/settings.json, not
 *     the main checkout's, when --runs lives inside a linked worktree" and ›
 *     "reads the checkout's own .claude/settings.json when the git directory
 *     lives outside the working tree (git init --separate-git-dir)".
 *   - It reads no other file, and never a personal/global config: a resolved
 *     checkout root that IS the caller's own home directory reads as
 *     `'unknown'` for both harnesses rather than being read —
 *     test/template/token-report.test.ts (absent in a generated rig) ›
 *     "reports wiring as unknown, never configured, when --runs resolves its
 *     checkout root to the child's own HOME".
 */

import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutGitLocation } from './git-env.mjs';
import { mainCheckoutRoot } from './queue/checkout.mjs';
import { readRuns } from './revalidation-report.mjs';

const TAKEN_RE = /^taken (.+)$/;

/** Sums one numeric field across every raw usage object in the list; `null`
 * unless the field is a finite number on every one of them — never a partial
 * sum, and never `0` standing in for "not measured". */
const summedField = (rawList, field) => {
  let sum = 0;
  for (const raw of rawList) {
    const value = raw?.[field];
    if (!Number.isFinite(value)) return null;
    sum += value;
  }
  return sum;
};

/** The one `evidenceSource` every raw usage object in the list agrees on;
 * `null` when any of them omits it or disagrees. */
const sharedEvidenceSource = (rawList) => {
  const first = rawList[0]?.evidenceSource;
  if (typeof first !== 'string') return null;
  for (const raw of rawList) {
    if (raw?.evidenceSource !== first) return null;
  }
  return first;
};

/** A dispatch's declared field (`controller`/`harness`/`agentType`) is
 * trusted only as a non-empty string, else `'unknown'` — never guessed, and
 * never coerced (a non-string value, e.g. an array or an object with a
 * non-callable `toString`, would otherwise reach `Array.prototype.join` in
 * the group key and either leak raw terminal escapes or throw). */
const stringOrUnknown = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value : 'unknown';

/** Whether a raw usage object carries at least one finite numeric counter —
 * an object with no such field (e.g. `{}`) is not usage: it must not count
 * toward `withUsage`, must not flip the money line, and its slot stays
 * `null`. */
const hasFiniteNumericField = (value) =>
  value !== null && typeof value === 'object' && Object.values(value).some(Number.isFinite);

const claudeUsageOf = (rawList) => {
  if (rawList.length === 0) return null;
  return {
    evidenceSource: sharedEvidenceSource(rawList),
    requests: summedField(rawList, 'requests'),
    inputTokens: summedField(rawList, 'inputTokens'),
    outputTokens: summedField(rawList, 'outputTokens'),
    cacheCreationInputTokens: summedField(rawList, 'cacheCreationInputTokens'),
    cacheReadInputTokens: summedField(rawList, 'cacheReadInputTokens'),
  };
};

const codexUsageOf = (rawList) => {
  if (rawList.length === 0) return null;
  return {
    inputTokens: summedField(rawList, 'inputTokens'),
    cachedInputTokens: summedField(rawList, 'cachedInputTokens'),
    outputTokens: summedField(rawList, 'outputTokens'),
    reasoningOutputTokens: summedField(rawList, 'reasoningOutputTokens'),
  };
};

// --- usageEvidence (RP-292) — see the header's USAGE EVIDENCE section. ---

/** Bounds on `usageEvidence.<harness>.unavailableReasons` — an adversarial
 * run could otherwise journal unboundedly many distinct `usageUnavailable`
 * codes, or one arbitrarily long one; both are capped rather than grown
 * without bound, the same posture the rest of this script already takes
 * toward untrusted journal content. */
const UNAVAILABLE_REASON_DISTINCT_CODES_MAX = 20;
const UNAVAILABLE_REASON_CODE_MAX_LENGTH = 200;

/** `usageUnavailable` is a machine-written status code, never prose, so it is
 * restricted to a safe identifier set rather than merely stripped of the C0/
 * DEL/C1 control range `stripControlChars` targets — that range does not
 * cover the wider Unicode bidi-control block (e.g. U+202E RIGHT-TO-LEFT
 * OVERRIDE), and a literal newline in an otherwise-clean code could forge a
 * second `usage evidence: ...` line in the text render. Every character
 * outside `[A-Za-z0-9._:-]` is replaced with `?` before truncation —
 * test/template/token-report.test.ts (absent in a generated rig) › "a code
 * carrying a literal newline plus a forged "usage evidence:" line does not
 * produce a second such line in the text render" and › "a code carrying a
 * bidi override control (U+202E) reaches neither the text nor the --json
 * output raw". */
const UNAVAILABLE_REASON_UNSAFE_CHAR_RE = /[^A-Za-z0-9._:-]/g;

/** Tallies one `usageUnavailable` code into `bucket` (an `Object.create(null)`
 * map — see SAFETY in the header: a code literally named `__proto__` or
 * `constructor` is tallied under its own key, not routed to
 * `Object.prototype`/`Object` itself). `rawCode` is restricted to the safe
 * identifier set above, then truncated to `UNAVAILABLE_REASON_CODE_MAX_LENGTH`.
 * Once `bucket` already holds `UNAVAILABLE_REASON_DISTINCT_CODES_MAX`
 * distinct codes, a NEW code is dropped rather than added; a repeat of an
 * already-known code still tallies. */
const recordUnavailableReason = (bucket, rawCode) => {
  const sanitized = rawCode
    .replace(UNAVAILABLE_REASON_UNSAFE_CHAR_RE, '?')
    .slice(0, UNAVAILABLE_REASON_CODE_MAX_LENGTH);
  if (sanitized === '') return;
  if (
    !(sanitized in bucket) &&
    Object.keys(bucket).length >= UNAVAILABLE_REASON_DISTINCT_CODES_MAX
  ) {
    return;
  }
  bucket[sanitized] = (bucket[sanitized] ?? 0) + 1;
};

/** Fixed, never computed: `record-dispatch.mjs` only journals
 * `SubagentStart`/`SubagentStop`, never the controller's (parent session's)
 * own turn, so there is no journalled evidence for it to report. */
const CONTROLLER_UNAVAILABLE_REASON =
  "controller (parent session) usage is never measured: record-dispatch.mjs only journals SubagentStart/SubagentStop for a dispatched subagent, never the controller's (parent session's) own turn.";

/** Per-harness reason text for each `usageEvidence.<harness>.state` — see
 * the header's USAGE EVIDENCE section. Codex's `configured-no-witness`
 * reason names untrusted-hook handling in prose; neither reason ever uses
 * the word "trusted" as a claimed state. */
const USAGE_EVIDENCE_REASONS = {
  claude: {
    witnessed:
      'a dispatch-start or dispatch-end event for claude was journalled in the runs read; hook configuration is informational only, never the evidence itself.',
    'configured-no-witness':
      'the SubagentStart/SubagentStop record-dispatch.mjs hook is configured for claude, but configuration is not execution: no dispatch-start or dispatch-end event for claude was journalled in the runs read.',
    'not-configured':
      'no record-dispatch.mjs hook is declared under SubagentStart/SubagentStop for claude in this checkout, and no dispatch-start or dispatch-end event for claude was journalled in the runs read.',
    unknown:
      'claude hook wiring could not be determined for this --runs directory (it is not inside a git checkout, its .claude/settings.json could not be read, or wiring was not supplied), and no dispatch-start or dispatch-end event for claude was journalled in the runs read.',
  },
  codex: {
    witnessed:
      'a dispatch-start or dispatch-end event for codex was journalled in the runs read; hook configuration is informational only, never the evidence itself.',
    'configured-no-witness':
      'the SubagentStart/SubagentStop record-dispatch.mjs hook is configured for codex, but Codex does not run project-level hooks until trust is explicitly granted for that project, and untrusted hooks are skipped silently — so configuration is not execution: no dispatch-start or dispatch-end event for codex was journalled in the runs read.',
    'not-configured':
      'no record-dispatch.mjs hook is declared under SubagentStart/SubagentStop for codex in this checkout, and no dispatch-start or dispatch-end event for codex was journalled in the runs read.',
    unknown:
      'codex hook wiring could not be determined for this --runs directory (it is not inside a git checkout, its .codex/hooks.json could not be read, or wiring was not supplied), and no dispatch-start or dispatch-end event for codex was journalled in the runs read.',
  },
};

/** One harness's `usageEvidence` entry. `state` comes from journalled events
 * ONLY (`witnessed`); otherwise it follows the caller-supplied `wiring` —
 * `'configured'` becomes `'configured-no-witness'`, `'not-configured'`/
 * `'unknown'` pass through unchanged. A `wiringState` this script does not
 * recognise is treated as `'unknown'`, never guessed into `'configured'`. */
const harnessUsageEvidence = (harness, wiringState, witnessed, unavailableReasonsBucket) => {
  const normalizedWiring =
    wiringState === 'configured' || wiringState === 'not-configured' ? wiringState : 'unknown';
  const state = witnessed
    ? 'witnessed'
    : normalizedWiring === 'configured'
      ? 'configured-no-witness'
      : normalizedWiring;
  return {
    wiring: normalizedWiring,
    state,
    reason: USAGE_EVIDENCE_REASONS[harness][state],
    // Spread — not a mutating assignment — into a fresh object literal: safe
    // even for a bucket key literally named "__proto__", because object
    // literal spread copies own enumerable properties as data properties
    // (CopyDataProperties) rather than going through property assignment's
    // "__proto__" setter trap.
    unavailableReasons: { ...unavailableReasonsBucket },
  };
};

/** The report over already-read runs — pure, so the grouping is testable alone. */
export const tokenReportOf = ({ runs, since, wiring }) => {
  const sinceMs = Date.parse(since);
  const read = [];
  const skipped = [];
  const dispatchGroups = new Map();
  const groupUsageRaw = new Map();
  const ticketMap = new Map();
  const wiringInput = wiring ?? {};
  // Witnessed and unavailableReasons are accumulated across EVERY run read,
  // never scoped to one run — see the header's USAGE EVIDENCE section.
  const witnessed = { claude: false, codex: false };
  const unavailableReasonsRaw = { claude: Object.create(null), codex: Object.create(null) };
  let orphanEnds = 0;

  const ensureTicket = (ticket) => {
    let entry = ticketMap.get(ticket);
    if (!entry) {
      entry = { ticket, attempts: 0, occurrences: [] };
      ticketMap.set(ticket, entry);
    }
    return entry;
  };

  for (const entry of runs) {
    if (entry.error) {
      skipped.push({ run: entry.run, why: entry.error });
      continue;
    }
    read.push(entry.run);
    const runName = entry.run;
    // Per-record filter, applied before attribution/grouping ever sees a
    // record — mirrors revalidation-report.mjs's `at >= since`. Written as
    // "inside the window", so an `at` that does not parse falls OUT (the NaN
    // comparison would otherwise count it in).
    const decisions = (entry.decisions ?? []).filter(
      (record) => Date.parse(record.at) >= sinceMs,
    );
    const events = (entry.events ?? []).filter((record) => Date.parse(record.at) >= sinceMs);
    const all = [
      ...decisions.map((record) => ({ ...record, __type: 'decision' })),
      ...events.map((record) => ({ ...record, __type: 'event' })),
    ].sort((a, b) => a.seq - b.seq);

    const selections = decisions
      .filter((record) => record.gate === 'item-selection')
      .sort((a, b) => a.seq - b.seq);
    const takenSelections = selections.filter((record) => TAKEN_RE.test(record.verdict));

    const attributionAt = (seq) => {
      let best = null;
      for (const selection of takenSelections) {
        if (selection.seq < seq && (best === null || selection.seq > best.seq)) best = selection;
      }
      return best ? TAKEN_RE.exec(best.verdict)[1] : 'no-ticket';
    };

    const dispatchEvents = events
      .filter((event) => event.kind === 'dispatch-start' || event.kind === 'dispatch-end')
      .sort((a, b) => a.seq - b.seq);
    const hasDispatchEvidence = dispatchEvents.length > 0;

    // usageEvidence witness/unavailableReasons — from journalled events ONLY,
    // independent of dispatch grouping/pairing above (a group's `harness` is
    // coerced through `stringOrUnknown`; witness is an exact 'claude'/'codex'
    // match on the raw event so it is never inferred through that coercion).
    for (const event of dispatchEvents) {
      // An orphan end (RP-294) is not a dispatch, so it is neither a witness
      // nor a usage record.
      if (event.kind === 'dispatch-end' && event.data?.orphan === true) continue;
      const harnessRaw = event.data?.harness;
      if (harnessRaw === 'claude') witnessed.claude = true;
      else if (harnessRaw === 'codex') witnessed.codex = true;
      else continue;
      if (event.kind !== 'dispatch-end') continue;
      const code = event.data?.usageUnavailable;
      if (typeof code === 'string' && code.trim() !== '') {
        recordUnavailableReason(unavailableReasonsRaw[harnessRaw], code);
      }
    }

    const pairs = [];
    const queueByRef = new Map();
    for (const event of dispatchEvents) {
      // RP-294: an explicit `orphan: true` on a dispatch-end is trusted
      // verbatim — never re-derived from a pairing miss — and excluded from
      // pairing/dispatchGroups entirely; its own total is reported
      // separately as `orphanEnds`. A dispatch-end with no matching start
      // and NO `orphan` field falls through unchanged, exactly as before.
      if (event.kind === 'dispatch-end' && event.data?.orphan === true) {
        orphanEnds += 1;
        continue;
      }
      const ref = event.data?.agentRef;
      if (event.kind === 'dispatch-start') {
        const pair = { start: event, end: null };
        pairs.push(pair);
        if (!queueByRef.has(ref)) queueByRef.set(ref, []);
        queueByRef.get(ref).push(pair);
      } else {
        const queue = queueByRef.get(ref);
        if (queue && queue.length > 0) queue.shift().end = event;
      }
    }

    for (const pair of pairs) {
      const start = pair.start;
      const controller = stringOrUnknown(start.data?.controller);
      const harness = stringOrUnknown(start.data?.harness);
      const agentType = stringOrUnknown(start.data?.agentType);
      const ticket = attributionAt(start.seq);
      const declaredModel = start.data?.declaredModel;
      const hasModel = typeof declaredModel === 'string' && declaredModel.trim() !== '';
      const model = hasModel ? declaredModel : 'unknown';
      const modelSource = hasModel ? 'declared' : 'unknown';
      const declaredEffort = start.data?.declaredEffort;
      const hasEffort = typeof declaredEffort === 'string' && declaredEffort.trim() !== '';
      const effort = hasEffort ? declaredEffort : 'unknown';
      const effortSource = hasEffort ? 'declared' : 'unknown';

      const key = ['dispatch', runName, controller, harness, ticket, agentType, model, effort].join(
        '|',
      );
      let group = dispatchGroups.get(key);
      if (!group) {
        group = {
          key,
          run: runName,
          controller,
          harness,
          ticket,
          agentType,
          model,
          modelSource,
          effort,
          effortSource,
          dispatches: { ended: 0, noEndObserved: 0 },
          usage: { claude: null, codex: null },
        };
        dispatchGroups.set(key, group);
        groupUsageRaw.set(key, { claude: [], codex: [], withUsage: 0 });
      }
      if (pair.end) group.dispatches.ended += 1;
      else group.dispatches.noEndObserved += 1;

      if (pair.end) {
        const usageRaw = pair.end.data?.usage;
        if (hasFiniteNumericField(usageRaw)) {
          const raws = groupUsageRaw.get(key);
          raws.withUsage += 1;
          if (harness === 'claude') raws.claude.push(usageRaw);
          else if (harness === 'codex') raws.codex.push(usageRaw);
        }
      }
    }

    const windowStats = (loExclusive, hiExclusive) => {
      const inWindow = all.filter((record) => record.seq > loExclusive && record.seq < hiExclusive);
      const fanOuts = inWindow.filter(
        (record) => record.__type === 'decision' && record.gate === 'reviewer-fan-out',
      );
      const reviewerNames = new Set();
      for (const fan of fanOuts) {
        if (Array.isArray(fan.reviewers)) {
          for (const name of fan.reviewers) if (typeof name === 'string') reviewerNames.add(name);
        }
      }
      const reviewerDecisions = inWindow.filter(
        (record) =>
          record.__type === 'decision' &&
          record.gate !== 'item-selection' &&
          record.gate !== 'reviewer-fan-out' &&
          reviewerNames.has(record.gate),
      );
      // Object.create(null): `decision.gate` is journal-supplied, and a gate
      // literally named __proto__/constructor must not reach
      // Object.prototype/Object itself through a plain object literal.
      const reviewerOutcomes = Object.create(null);
      for (const decision of reviewerDecisions) {
        const bucket = (reviewerOutcomes[decision.gate] ??= Object.create(null));
        bucket[decision.verdict] = (bucket[decision.verdict] ?? 0) + 1;
      }
      let outcome = null;
      if (fanOuts.length > 0) {
        const lastRoundSeq = fanOuts[fanOuts.length - 1].seq;
        outcome = Object.create(null);
        for (const decision of reviewerDecisions) {
          if (decision.seq > lastRoundSeq) outcome[decision.gate] = decision.verdict;
        }
      }
      let dispatches;
      if (!hasDispatchEvidence) {
        dispatches = 'unavailable';
      } else {
        let ended = 0;
        let noEndObserved = 0;
        for (const pair of pairs) {
          if (pair.start.seq > loExclusive && pair.start.seq < hiExclusive) {
            if (pair.end) ended += 1;
            else noEndObserved += 1;
          }
        }
        dispatches = { ended, noEndObserved };
      }
      return { gateRounds: fanOuts.length, reviewerOutcomes, outcome, dispatches };
    };

    const firstSelection = selections[0];
    const preHi = firstSelection ? firstSelection.seq : Infinity;
    const preActivity = all.filter((record) => record.seq < preHi);
    if (preActivity.length > 0) {
      const stats = windowStats(0, preHi);
      ensureTicket('no-ticket').occurrences.push({
        run: runName,
        seq: null,
        at: null,
        gateRounds: stats.gateRounds,
        reviewerOutcomes: stats.reviewerOutcomes,
        outcome: stats.outcome,
        wallTimeMs: null,
        dispatches: stats.dispatches,
      });
    }

    for (let index = 0; index < selections.length; index += 1) {
      const selection = selections[index];
      const match = TAKEN_RE.exec(selection.verdict);
      if (!match) continue;
      const ticketId = match[1];
      const next = selections[index + 1];
      const hi = next ? next.seq : Infinity;
      const stats = windowStats(selection.seq, hi);
      let endAt = null;
      if (next) endAt = next.at;
      else {
        const runEnd = events.find((event) => event.kind === 'run-end');
        if (runEnd) endAt = runEnd.at;
      }
      const wallTimeMs = endAt ? Date.parse(endAt) - Date.parse(selection.at) : null;

      const ticketEntry = ensureTicket(ticketId);
      ticketEntry.attempts += 1;
      ticketEntry.occurrences.push({
        run: runName,
        seq: selection.seq,
        at: selection.at,
        gateRounds: stats.gateRounds,
        reviewerOutcomes: stats.reviewerOutcomes,
        outcome: stats.outcome,
        wallTimeMs,
        dispatches: stats.dispatches,
      });
    }
  }

  for (const [key, group] of dispatchGroups) {
    const raws = groupUsageRaw.get(key);
    group.usage.claude = claudeUsageOf(raws.claude);
    group.usage.codex = codexUsageOf(raws.codex);
    if (raws.withUsage > 0 && raws.withUsage < group.dispatches.ended) {
      group.dispatches.withUsage = raws.withUsage;
    }
  }

  const usageDisplayed = [...dispatchGroups.values()].some(
    (group) => group.usage.claude !== null || group.usage.codex !== null,
  );
  const money = {
    line: usageDisplayed
      ? 'usage measured; monetary cost unavailable'
      : 'usage unavailable; monetary cost unavailable',
    estimate: null,
  };

  const usageEvidence = {
    claude: harnessUsageEvidence(
      'claude',
      wiringInput.claude,
      witnessed.claude,
      unavailableReasonsRaw.claude,
    ),
    codex: harnessUsageEvidence(
      'codex',
      wiringInput.codex,
      witnessed.codex,
      unavailableReasonsRaw.codex,
    ),
    controller: { available: false, reason: CONTROLLER_UNAVAILABLE_REASON },
  };

  return {
    since,
    runs: { read: read.length, skipped },
    dispatchGroups: [...dispatchGroups.values()],
    tickets: [...ticketMap.values()],
    usageEvidence,
    orphanEnds,
    money,
  };
};

/** Strips C0 (except `\n`/`\t`), DEL and C1 control characters from a whole
 * piece of text before it reaches the operator's terminal — see the header's
 * LIMITS. Applied once, to the fully rendered text, rather than per
 * interpolated field: that also covers a `JSON.stringify`-built fragment
 * (`usage`, `outcome`), which a per-field pass over the named scalars alone
 * would miss. */
// eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
const stripControlChars = (text) => text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');

/** `{code=count, ...}`, or `{}` when `reasons` is empty — the compact form
 * `renderUsageEvidenceLine` uses for `unavailableReasons`. */
const formatUnavailableReasons = (reasons) => {
  const entries = Object.entries(reasons);
  if (entries.length === 0) return '{}';
  return `{${entries.map(([code, count]) => `${code}=${count}`).join(', ')}}`;
};

/** The single `usage evidence: ...` line — see the header's USAGE EVIDENCE
 * section. Rendered as one line so it sits immediately before the money
 * line without splitting the "last line is the money line" contract. */
const renderUsageEvidenceLine = ({ claude, codex, controller }) =>
  `usage evidence: claude=${claude.state}(wiring=${claude.wiring}) ` +
  `codex=${codex.state}(wiring=${codex.wiring}) controller=unavailable ` +
  `unavailableReasons: claude=${formatUnavailableReasons(claude.unavailableReasons)} ` +
  `codex=${formatUnavailableReasons(codex.unavailableReasons)} (${controller.reason})`;

/** The short human text render — ends with the money line, always. */
export const render = (report) => {
  const lines = [`token usage since ${report.since}`];
  lines.push(`runs: ${report.runs.read} read, ${report.runs.skipped.length} skipped`);
  for (const { run, why } of report.runs.skipped) lines.push(`  skipped ${run} — ${why}`);

  lines.push(`dispatch groups: ${report.dispatchGroups.length}`);
  for (const group of report.dispatchGroups) {
    const usageParts = [];
    if (group.usage.claude) usageParts.push(`claude=${JSON.stringify(group.usage.claude)}`);
    if (group.usage.codex) usageParts.push(`codex=${JSON.stringify(group.usage.codex)}`);
    const usage = usageParts.length > 0 ? usageParts.join(' ') : 'usage=none';
    const withUsage =
      group.dispatches.withUsage === undefined ? '' : ` withUsage=${group.dispatches.withUsage}`;
    lines.push(
      `  ${group.run} ${group.controller}/${group.harness} ${group.ticket} ${group.agentType} ` +
        `model=${group.model}(${group.modelSource}) effort=${group.effort}(${group.effortSource}) ` +
        `ended=${group.dispatches.ended} noEndObserved=${group.dispatches.noEndObserved}${withUsage} ${usage}`,
    );
  }

  lines.push(`tickets: ${report.tickets.length}`);
  for (const ticket of report.tickets) {
    lines.push(`  ${ticket.ticket} attempts=${ticket.attempts} occurrences=${ticket.occurrences.length}`);
    for (const occurrence of ticket.occurrences) {
      const dispatches =
        occurrence.dispatches === 'unavailable'
          ? 'unavailable'
          : `ended=${occurrence.dispatches.ended} noEndObserved=${occurrence.dispatches.noEndObserved}`;
      lines.push(
        `    run=${occurrence.run} seq=${occurrence.seq ?? 'n/a'} gateRounds=${occurrence.gateRounds} ` +
          `outcome=${occurrence.outcome ? JSON.stringify(occurrence.outcome) : 'null'} ` +
          `wallTimeMs=${occurrence.wallTimeMs ?? 'null'} dispatches=${dispatches}`,
      );
    }
  }

  lines.push(renderUsageEvidenceLine(report.usageEvidence));
  lines.push(report.money.line);
  return stripControlChars(`${lines.join('\n')}\n`);
};

/** `JSON.stringify` escapes C0 (below U+0020) on its own but leaves DEL
 * (U+007F) and the C1 range (U+0080-U+009F, including CSI U+009B) as raw
 * bytes — see the header's LIMITS. Rewriting exactly that range as `\u00XX`
 * keeps the document valid JSON, parsing to the same values, with no raw
 * high-control byte reaching the operator's terminal. */
const escapeHighControlChars = (jsonText) =>
  jsonText.replace(/[\x7F-\x9F]/g, (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);

// --- CLI wiring resolution (RP-292) — see the header's WIRING section. ---

/** Bytes read from each of `.claude/settings.json`/`.codex/hooks.json` when
 * resolving CLI wiring. Both files are a few KB to tens of KB in this repo
 * today; a file over this cap reads as `'unknown'` rather than being read
 * (partially) and guessed at. */
const WIRING_FILE_MAX_BYTES = 256 * 1024;

/**
 * The checkout root that CONTAINS `startDir`, or `null` when `startDir` is
 * not itself inside a git checkout (or git cannot be run).
 *
 * `--show-toplevel`, not `dirname(--git-common-dir)`: the latter answers
 * "where does the git DIRECTORY live", which is the MAIN checkout for a
 * linked worktree (`git worktree add`) and the parent of wherever
 * `--separate-git-dir` put the git directory for that shape — neither is
 * `startDir`'s own working-tree root. `--show-toplevel` answers "which
 * working tree contains `startDir`" directly, so a linked worktree and a
 * `--separate-git-dir` checkout both report their own root — test/template/token-report.test.ts
 * (absent in a generated rig) › "reads the worktree's own .claude/settings.json,
 * not the main checkout's, when --runs lives inside a linked worktree" and ›
 * "reads the checkout's own .claude/settings.json when the git directory
 * lives outside the working tree (git init --separate-git-dir)".
 *
 * Deliberately NOT `mainCheckoutRoot` from `queue/checkout.mjs`: that
 * function's fallback-to-`startDir` on exactly those same two failures makes
 * its return value indistinguishable from "startDir really is the checkout
 * root". Wiring needs that distinction — a `--runs` directory outside any
 * checkout must read as `'unknown'`, never as "read this directory's own
 * non-existent config" — test/template/token-report.test.ts (absent in a
 * generated rig) › "the CLI reports wiring as unknown, never not-configured,
 * for a --runs directory that is not itself part of a git checkout".
 */
const gitCheckoutRootOrNull = (startDir) => {
  try {
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...withoutGitLocation(), LC_ALL: 'C', LANGUAGE: '' },
      timeout: 5_000,
    }).trim();
    return toplevel ? resolve(toplevel) : null;
  } catch {
    return null;
  }
};

/** Whether `checkoutRoot` IS the caller's own home directory — compared by
 * realpath, since either side can be reached through a symlink. A failure
 * to resolve either realpath is treated the same as a match (the safe
 * direction here: this script never reads personal/global config, so an
 * inability to tell must not let a home-rooted checkout through as an
 * ordinary one) — test/template/token-report.test.ts (absent in a generated
 * rig) › "reports wiring as unknown, never configured, when --runs resolves
 * its checkout root to the child's own HOME". */
const isHomeDirectory = (checkoutRoot) => {
  try {
    return realpathSync(checkoutRoot) === realpathSync(homedir());
  } catch {
    return true;
  }
};

/** Whether `filePath` declares a `record-dispatch.mjs` command under
 * `SubagentStart`/`SubagentStop` — `'configured'`/`'not-configured'`/
 * `'unknown'`. Bounded on bytes actually READ (at most
 * `WIRING_FILE_MAX_BYTES + 1`, into a fixed buffer), never on `stat().size`:
 * a virtual file (e.g. `/proc/self/pagemap`) can report a size unrelated to
 * how much a read would actually pull from it, so a size-only guard lets an
 * effectively unbounded read through — test/template/token-report.test.ts
 * (absent in a generated rig) › "finishes within a bound and reports claude
 * wiring as unknown when .claude/settings.json is a symlink to
 * /proc/self/pagemap, instead of reading it without bound" (codex: › "…
 * .codex/hooks.json is a symlink to /proc/self/pagemap …"). Reading through
 * the already-open descriptor also closes the stat-then-read race: nothing
 * can replace the file between checking it and reading it. Any failure other
 * than "the file does not exist" — too large, unparseable, unreadable — reads
 * as `'unknown'` rather than guessed at. */
const recordDispatchConfiguredIn = (filePath) => {
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    return error?.code === 'ENOENT' ? 'not-configured' : 'unknown';
  }
  try {
    let stat;
    try {
      stat = fstatSync(fd);
    } catch {
      return 'unknown';
    }
    if (!stat.isFile()) return 'unknown';
    const buffer = Buffer.alloc(WIRING_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      let bytesRead;
      try {
        bytesRead = readSync(fd, buffer, total, buffer.length - total, null);
      } catch {
        return 'unknown';
      }
      if (bytesRead <= 0) break;
      total += bytesRead;
    }
    if (total > WIRING_FILE_MAX_BYTES) return 'unknown';
    let config;
    try {
      config = JSON.parse(buffer.toString('utf8', 0, total));
    } catch {
      return 'unknown';
    }
    for (const eventName of ['SubagentStart', 'SubagentStop']) {
      const matchers = config?.hooks?.[eventName];
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        const hooks = matcher?.hooks;
        if (!Array.isArray(hooks)) continue;
        for (const hook of hooks) {
          if (typeof hook?.command === 'string' && hook.command.includes('record-dispatch.mjs')) {
            return 'configured';
          }
        }
      }
    }
    return 'not-configured';
  } finally {
    closeSync(fd);
  }
};

/** The CLI's own `wiring: { claude, codex }`, from the `--runs` directory's
 * OWN checkout — never the CLI's `cwd`, and never a personal/global config
 * (`~/.codex`, `~/.claude`). A checkout root that IS the caller's own home
 * directory is personal config by definition, so it reads as `'unknown'` for
 * both harnesses rather than being read — test/template/token-report.test.ts
 * (absent in a generated rig) › "reports wiring as unknown, never configured,
 * when --runs resolves its checkout root to the child's own HOME". */
const resolveWiring = (runsDir) => {
  const checkoutRoot = gitCheckoutRootOrNull(runsDir);
  if (checkoutRoot === null) return { claude: 'unknown', codex: 'unknown' };
  if (isHomeDirectory(checkoutRoot)) return { claude: 'unknown', codex: 'unknown' };
  return {
    claude: recordDispatchConfiguredIn(join(checkoutRoot, '.claude', 'settings.json')),
    codex: recordDispatchConfiguredIn(join(checkoutRoot, '.codex', 'hooks.json')),
  };
};

const parseArgs = (argv) => {
  const args = { since: null, runs: null, json: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--since') args.since = argv[++i] ?? null;
    else if (arg === '--runs') args.runs = argv[++i] ?? null;
    else if (args.bad === null) args.bad = arg;
  }
  return args;
};

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
  const refuse = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };
  if (args.bad !== null) refuse(`unrecognised argument: ${args.bad}`);
  if (!args.since || Number.isNaN(Date.parse(args.since))) {
    refuse(
      `--since needs an ISO date (got ${args.since ?? '(none)'}); a report with no window reports nothing honest.`,
    );
  }
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const runsDir =
    args.runs ?? join(mainCheckoutRoot(join(scriptsDir, '..', '..')), '.claude', 'runs');
  const wiring = resolveWiring(runsDir);
  let runs;
  try {
    runs = readRuns(runsDir);
  } catch (error) {
    refuse(error.message);
  }
  const report = tokenReportOf({ runs, since: new Date(args.since).toISOString(), wiring });
  process.stdout.write(
    args.json ? `${escapeHighControlChars(JSON.stringify(report, null, 2))}\n` : render(report),
  );
}
