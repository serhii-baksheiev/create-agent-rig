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
 * exact contract; every behaviour claim below points at the test that proves
 * it, rather than restating a number nothing checks.
 *
 *   node .claude/scripts/token-report.mjs --since <ISO> [--runs <dir>] [--json]
 *
 * `--json` prints the full structured report (› "exits 0 with a JSON document
 * on --json"). Without it, the default is a short human text render — runs
 * read/skipped, one line per dispatch group (run, controller/harness, ticket,
 * agentType, model/effort, dispatch counts, per-harness usage), one line per
 * ticket occurrence (attempts, gate rounds, outcome, wall time, dispatches) —
 * ending with the money line (› "the text render ends with the money line").
 *
 * Reads `<runs>/<run-id>/` the same way `revalidation-report.mjs` does — this
 * script reuses that script's `readRuns` (default `--runs` also resolves
 * through `queue/checkout.mjs`'s `mainCheckoutRoot`, the same main-checkout
 * rule) and `run-journal.mjs`'s `readRun`. A run `readRun` refuses is counted
 * under `runs.skipped`, with why, never dropped silently
 * (› "a run readRun refuses is counted under skipped, with why, and excluded
 * from every other section").
 *
 * It is read-only: no write/append call appears in this file's own source
 * (› "contains no write-call literal in its own source"), and running it,
 * CLI included, leaves every run directory byte-identical
 * (› "leaves the run-directory tree byte-identical after tokenReportOf and
 * the CLI both run").
 *
 * DISPATCH GROUPING — one row per (run, controller, harness, ticket,
 * agentType, model, effort) combination actually seen in a `dispatch-start`
 * event (› "groups one dispatch pair by its declared model/effort, with the
 * ticket the selection named"). `controller`/`harness`/`agentType` are
 * `'unknown'` when the start record carries no such field, never guessed
 * (› "reports unknown (never guessed) for every field a dispatch record
 * omits"). `model`/`effort` are the start's own `declaredModel`/
 * `declaredEffort` when present (`modelSource`/`effortSource`: `'declared'`),
 * else `'unknown'`/`'unknown'` — this script never infers a model from
 * anywhere else. A Claude dispatch and a Codex dispatch are always separate
 * groups, each carrying only its own harness's usage object — usage is never
 * summed across harnesses (› "a Claude dispatch and a Codex dispatch under
 * the same ticket and agent role render as two separate groups, never
 * summed").
 *
 * TICKET ATTRIBUTION — which ticket a record (a dispatch-start, here) belongs
 * to is the latest `item-selection` decision whose verdict matches
 * `/^taken (.+)$/` at a smaller seq than the record's own; a `stopped ...`
 * selection is invisible to attribution (› "a 'stopped' selection is
 * invisible to attribution: dispatches after it still belong to the last
 * taken ticket"). A record with no such decision before it attributes to
 * `'no-ticket'` (› "a dispatch before any selection in the run is bucketed
 * under no-ticket").
 *
 * TICKET OCCURRENCES — each `taken <id>` selection opens exactly one
 * occurrence, whose WINDOW (gateRounds/reviewerOutcomes/outcome/wallTimeMs/
 * dispatches) runs from that decision's own seq up to the seq of the very
 * next `item-selection` decision of ANY verdict — including `stopped`, which
 * closes the window without opening one of its own — or the run end when
 * there is none after it (› "measures from the selection to the next
 * selection, whatever its verdict", › "measures to the run end when there is
 * no next selection"). `gateRounds` counts `reviewer-fan-out` decisions in
 * the window; `reviewerOutcomes` tallies every other decision in the window
 * by its own `gate` name and `verdict`; `outcome` is the tally restricted to
 * decisions after the window's LAST `reviewer-fan-out` round, or `null` when
 * the window has none (› "counts reviewer-fan-out decisions in the window,
 * tallies every round, and reports the last round as the outcome", › "a
 * window with no reviewer-fan-out at all reports zero gate rounds and a null
 * outcome"). `attempts` is a count of `taken <id>` decisions for that ticket
 * across every run read, not scoped to one run (› "attempts counts 'taken
 * <id>' across every run read, not scoped to one run"). One synthetic
 * `'no-ticket'` entry covers dispatch/decision activity before a run's first
 * `taken` selection, when any exists; its occurrences carry `seq`/`at`/
 * `wallTimeMs` as `null` — there is no selection to measure from.
 *
 * DISPATCH PAIRING — a `dispatch-start`/`dispatch-end` pair sharing the same
 * `agentRef` (matched FIFO per `agentRef`, oldest unmatched start first) is
 * `ended`; a `dispatch-start` with no matching `dispatch-end` is
 * `noEndObserved` (› "pairs a dispatch-start and dispatch-end sharing
 * agentRef as ended", › "a dispatch-start with no matching dispatch-end
 * counts as noEndObserved"). A run that journals NO dispatch event at all
 * (neither kind) reports `dispatches: 'unavailable'` for every occurrence in
 * that run — never `0`, which would read as "checked and found none" (› "a
 * run with no dispatch events at all reports dispatches as unavailable,
 * never zero").
 *
 * MONEY — `money.line` is exactly one of two sentences (Jira RP-225 comment
 * 20198): `'usage measured; monetary cost unavailable'` when at least one
 * dispatch anywhere in the runs READ (not skipped) carries a `usage` object,
 * else `'usage unavailable; monetary cost unavailable'` (› both money-line
 * tests). `money.estimate` is always `null` — the optional API-equivalent
 * estimate from a user-supplied dated pricing file is explicitly deferred,
 * not in this script; the CLI refuses `--pricing` as an unrecognised
 * argument for the same reason (› "refuses --pricing as an unrecognised
 * argument — the optional estimate is deferred, not in this PR").
 *
 * LIMITS:
 *   - Grouping and attribution are exact-match only — no fuzzy ticket-id or
 *     model-name reconciliation is attempted.
 *   - A window opened by a `stopped` (or any non-`taken`) `item-selection`
 *     decision is never an occurrence; activity after such a decision and
 *     before the next `taken` one is visible only through dispatch-group
 *     attribution, never through any `tickets[].occurrences` entry.
 *   - Usage totals are copied from the dispatch-end record's own `usage`
 *     object verbatim (defaulting an absent numeric field to `0` and an
 *     absent `evidenceSource` to `'unknown'`) — this script does not
 *     validate that the harness's own accounting is correct.
 */

import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from './queue/checkout.mjs';
import { readRuns } from './revalidation-report.mjs';

const TAKEN_RE = /^taken (.+)$/;

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

const claudeUsageOf = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  return {
    evidenceSource: typeof raw.evidenceSource === 'string' ? raw.evidenceSource : 'unknown',
    requests: num(raw.requests),
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    cacheCreationInputTokens: num(raw.cacheCreationInputTokens),
    cacheReadInputTokens: num(raw.cacheReadInputTokens),
  };
};

const codexUsageOf = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  return {
    inputTokens: num(raw.inputTokens),
    cachedInputTokens: num(raw.cachedInputTokens),
    outputTokens: num(raw.outputTokens),
    reasoningOutputTokens: num(raw.reasoningOutputTokens),
  };
};

/** The report over already-read runs — pure, so the grouping is testable alone. */
export const tokenReportOf = ({ runs, since }) => {
  const read = [];
  const skipped = [];
  const dispatchGroups = new Map();
  const ticketMap = new Map();
  let usageSeen = false;

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
    const decisions = entry.decisions ?? [];
    const events = entry.events ?? [];
    const all = [
      ...decisions.map((record) => ({ ...record, __type: 'decision' })),
      ...events.map((record) => ({ ...record, __type: 'event' })),
    ].sort((a, b) => a.seq - b.seq);

    for (const event of events) {
      if (event.kind !== 'dispatch-start' && event.kind !== 'dispatch-end') continue;
      if (event.data && typeof event.data === 'object' && event.data.usage) usageSeen = true;
    }

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

    const pairs = [];
    const queueByRef = new Map();
    for (const event of dispatchEvents) {
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
      const controller = start.data?.controller ?? 'unknown';
      const harness = start.data?.harness ?? 'unknown';
      const agentType = start.data?.agentType ?? 'unknown';
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
      }
      if (pair.end) group.dispatches.ended += 1;
      else group.dispatches.noEndObserved += 1;

      if (pair.end) {
        const usageRaw = pair.end.data?.usage;
        if (usageRaw && typeof usageRaw === 'object') {
          if (harness === 'claude') group.usage.claude = claudeUsageOf(usageRaw);
          else if (harness === 'codex') group.usage.codex = codexUsageOf(usageRaw);
        }
      }
    }

    const windowStats = (loExclusive, hiExclusive) => {
      const inWindow = all.filter((record) => record.seq > loExclusive && record.seq < hiExclusive);
      const fanOuts = inWindow.filter(
        (record) => record.__type === 'decision' && record.gate === 'reviewer-fan-out',
      );
      const reviewerDecisions = inWindow.filter(
        (record) =>
          record.__type === 'decision' &&
          record.gate !== 'item-selection' &&
          record.gate !== 'reviewer-fan-out',
      );
      const reviewerOutcomes = {};
      for (const decision of reviewerDecisions) {
        const bucket = (reviewerOutcomes[decision.gate] ??= {});
        bucket[decision.verdict] = (bucket[decision.verdict] ?? 0) + 1;
      }
      let outcome = null;
      if (fanOuts.length > 0) {
        const lastRoundSeq = fanOuts[fanOuts.length - 1].seq;
        outcome = {};
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

  const money = {
    line: usageSeen
      ? 'usage measured; monetary cost unavailable'
      : 'usage unavailable; monetary cost unavailable',
    estimate: null,
  };

  return {
    since,
    runs: { read: read.length, skipped },
    dispatchGroups: [...dispatchGroups.values()],
    tickets: [...ticketMap.values()],
    money,
  };
};

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
    lines.push(
      `  ${group.run} ${group.controller}/${group.harness} ${group.ticket} ${group.agentType} ` +
        `model=${group.model}(${group.modelSource}) effort=${group.effort}(${group.effortSource}) ` +
        `ended=${group.dispatches.ended} noEndObserved=${group.dispatches.noEndObserved} ${usage}`,
    );
  }

  lines.push(`tickets: ${report.tickets.length}`);
  for (const ticket of report.tickets) {
    lines.push(
      `  ${ticket.ticket} attempts=${ticket.attempts} occurrences=${ticket.occurrences.length}`,
    );
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

  lines.push(report.money.line);
  return `${lines.join('\n')}\n`;
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
  let runs;
  try {
    runs = readRuns(runsDir);
  } catch (error) {
    refuse(error.message);
  }
  const report = tokenReportOf({ runs, since: new Date(args.since).toISOString() });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
}
