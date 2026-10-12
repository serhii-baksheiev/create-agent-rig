// Outcome Evidence over a named run set (RP-355): item occurrences read out of
// run journals, and the outcome signals computed from them. Read-only and
// pure — it takes what `revalidation-report.mjs`'s `readRuns` returned and
// writes nothing. Each signal's meaning is `lib/outcome-signals.mjs`'s, and
// `docs/decisions/outcome-signals.md` is the contract: unknown is never zero,
// and no output names a person.
//
// Tests: `test/template/evidence-query.test.ts` (absent in a generated rig).

import { SIGNALS } from './outcome-signals.mjs';

const TAKEN = /^taken (.+)$/;
const FAN_OUT = 'reviewer-fan-out';
const ROUTING = 'review-routing:';

const versionOf = (name) => SIGNALS.find((signal) => signal.name === name).signalVersion;

/**
 * One occurrence per `taken <id>` item selection, running to the next
 * item selection of any verdict or the end of the run. `records` are the
 * decisions and events strictly inside that window, in `seq` order.
 */
export const itemOccurrences = (entry) => {
  const all = [...(entry.decisions ?? []), ...(entry.events ?? [])].sort((a, b) => a.seq - b.seq);
  const occurrences = [];
  let open = null;
  for (const record of all) {
    if (record.gate === 'item-selection') {
      const taken = TAKEN.exec(record.verdict ?? '');
      open = taken
        ? { run: entry.run, ticket: taken[1], seq: record.seq, at: record.at, records: [] }
        : null;
      if (open) occurrences.push(open);
      continue;
    }
    if (open) open.records.push(record);
  }
  return occurrences;
};

const fanOutsOf = (item) => item.records.filter((record) => record.gate === FAN_OUT);

const laneOf = (occurrence) => {
  const routed = occurrence.records.find(
    (record) =>
      typeof record.gate === 'string' && record.gate.startsWith(ROUTING) && record.verdict === 'route',
  );
  return routed ? routed.gate.slice(ROUTING.length) : 'unknown';
};

/** SHIP, HOLD or other for the first reviewed head, or null when it cannot be read. */
const firstVerdictOf = (occurrence) => {
  const fanOuts = fanOutsOf(occurrence);
  const head = fanOuts[0]?.headSha;
  if (typeof head !== 'string' || head === '') return null;
  const reviewers = fanOuts.filter((fan) => fan.headSha === head).at(-1).reviewers ?? [];
  if (!Array.isArray(reviewers) || reviewers.length === 0) return null;
  const words = [];
  for (const reviewer of reviewers) {
    const answer = occurrence.records.find(
      (record) => record.gate === reviewer && record.headSha === head,
    );
    if (!answer) return null;
    words.push(answer.verdict);
  }
  if (words.every((word) => word === 'SHIP')) return 'SHIP';
  if (words.includes('HOLD')) return 'HOLD';
  return 'other';
};

const counts = () => ({ SHIP: 0, HOLD: 0, other: 0 });

/** Whether the first fan-out launched no reviewer at all — the deterministic lane's shape. */
const launchedNoReviewer = (item) => {
  const fanOuts = fanOutsOf(item);
  const head = fanOuts[0]?.headSha;
  const reviewers = fanOuts.filter((fan) => fan.headSha === head).at(-1)?.reviewers;
  return Array.isArray(reviewers) && reviewers.length === 0;
};

const firstShippingVerdict = (occurrences) => {
  const reviewed = occurrences.filter((occurrence) => fanOutsOf(occurrence).length > 0);
  // Every reviewed item counts toward its lane, so a shift toward the
  // deterministic lane — which launches no reviewer — stays visible.
  // Null-prototype maps: a lane name is journal text, and `__proto__` or
  // `constructor` must land under its own key, never on Object.prototype.
  const lanes = Object.create(null);
  for (const item of reviewed) lanes[laneOf(item)] = (lanes[laneOf(item)] ?? 0) + 1;
  const eligible = reviewed.filter((item) => !launchedNoReviewer(item));
  const result = { ...counts(), lanes, byLane: Object.create(null) };
  let observed = 0;
  for (const occurrence of eligible) {
    const verdict = firstVerdictOf(occurrence);
    if (verdict === null) continue;
    observed += 1;
    result[verdict] += 1;
    const lane = laneOf(occurrence);
    result.byLane[lane] ??= counts();
    result.byLane[lane][verdict] += 1;
  }
  return {
    name: 'first-shipping-verdict',
    signalVersion: versionOf('first-shipping-verdict'),
    eligible: eligible.length,
    observed,
    unknown: eligible.length - observed,
    result,
  };
};

const gateRounds = (occurrences) => {
  const distribution = {};
  let observed = 0;
  for (const occurrence of occurrences) {
    const closed = occurrence.records.some((record) => record.kind === 'item-closed');
    const heads = new Set(
      fanOutsOf(occurrence)
        .map((fan) => fan.headSha)
        .filter((head) => typeof head === 'string' && head !== ''),
    );
    if (!closed || heads.size === 0) continue;
    observed += 1;
    distribution[heads.size] = (distribution[heads.size] ?? 0) + 1;
  }
  return {
    name: 'gate-rounds',
    signalVersion: versionOf('gate-rounds'),
    eligible: occurrences.length,
    observed,
    unknown: occurrences.length - observed,
    result: { distribution },
  };
};

/**
 * One item per ticket across the named runs: its occurrences joined in the
 * order they were taken, so an item taken again in a later run keeps its
 * first verdict and the rounds both runs spent.
 */
const itemsOf = (occurrences) => {
  const byTicket = new Map();
  for (const occurrence of [...occurrences].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const item = byTicket.get(occurrence.ticket);
    if (item) {
      for (const record of occurrence.records) item.records.push(record);
      item.itemTied &&= occurrence.itemTied;
      item.occurrences.push(occurrence);
    } else {
      byTicket.set(occurrence.ticket, {
        ticket: occurrence.ticket,
        itemTied: occurrence.itemTied,
        records: [...occurrence.records],
        occurrences: [occurrence],
      });
    }
  }
  return [...byTicket.values()];
};

/**
 * The event kinds 1.7.0 journals with their item (RP-446, RP-447). A run
 * that carries none of them cannot tell "nothing happened" from "nothing was
 * recorded", so its items are unknown for the signals that read them.
 */
const ITEM_TIED = new Set(['item-escalated', 'item-closed', 'continuation']);

const interventions = (items) => {
  const distribution = {};
  let escalations = 0;
  let delegatedDecisions = 0;
  let observed = 0;
  for (const item of items) {
    if (!item.itemTied) continue;
    observed += 1;
    const escalated = item.records.filter((record) => record.kind === 'item-escalated').length;
    const delegated = item.records.filter((record) => record.kind === 'delegated-decision').length;
    escalations += escalated;
    delegatedDecisions += delegated;
    distribution[escalated + delegated] = (distribution[escalated + delegated] ?? 0) + 1;
  }
  return {
    name: 'interventions',
    signalVersion: versionOf('interventions'),
    eligible: items.length,
    observed,
    unknown: items.length - observed,
    result: { escalations, delegatedDecisions, distribution },
  };
};

/**
 * A continuation is resolved by a close or a re-escalation of its item in a
 * LATER run than the one that wrote it: §6 posts the note and then escalates
 * in the same run, so a same-run escalation is the stop itself. An item still
 * open is unresolved, never a failed recovery (RP-447, Jira RP-447 24373).
 */
const continuation = (items) => {
  const result = { resolved: { closed: 0, reEscalated: 0 }, unresolved: 0 };
  let eligible = 0;
  for (const item of items) {
    for (const occurrence of item.occurrences) {
      for (const note of occurrence.records.filter((record) => record.kind === 'continuation')) {
        eligible += 1;
        const later = item.occurrences.filter(
          (other) => other.run !== occurrence.run && Date.parse(other.at) > Date.parse(note.at),
        );
        const kinds = new Set(later.flatMap((other) => other.records.map((record) => record.kind)));
        if (kinds.has('item-closed')) result.resolved.closed += 1;
        else if (kinds.has('item-escalated')) result.resolved.reEscalated += 1;
        else result.unresolved += 1;
      }
    }
  }
  return {
    name: 'continuation',
    signalVersion: versionOf('continuation'),
    eligible,
    observed: eligible,
    unknown: 0,
    result,
  };
};

const median = (sorted) =>
  sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

/**
 * Total wall time from an item's first valid claim (a SELECT revalidation
 * that continued) to the commit its close revalidation proved it merged
 * (`evidence.ownMergeAdvance.to`), read through `commitTime`. Nothing is
 * subtracted: CI and review waits are part of it. An item without both ends
 * is excluded and counted as unknown.
 */
const isClaim = (record) => record.kind === 'revalidation' && record.data?.point === 'SELECT';

const claimToMerge = (items, commitTime) => {
  const claimed = items.filter((item) => item.records.some(isClaim));
  const durations = [];
  for (const item of claimed) {
    const claim = item.records.find(
      (record) => isClaim(record) && record.data?.action === 'continue',
    );
    const merged = item.records.find(
      (record) =>
        record.kind === 'revalidation' &&
        record.data?.point === 'BEFORE_CLOSE' &&
        typeof record.data?.evidence?.ownMergeAdvance?.to === 'string',
    );
    if (!claim || !merged) continue;
    const end = Date.parse(commitTime(merged.data.evidence.ownMergeAdvance.to) ?? '');
    const start = Date.parse(claim.at);
    if (!Number.isFinite(end) || !Number.isFinite(start)) continue;
    durations.push(end - start);
  }
  durations.sort((a, b) => a - b);
  return {
    name: 'claim-to-merge',
    signalVersion: versionOf('claim-to-merge'),
    eligible: claimed.length,
    observed: durations.length,
    unknown: claimed.length - durations.length,
    result: {
      wallTimeMs:
        durations.length === 0
          ? null
          : { min: durations[0], median: median(durations), max: durations.at(-1) },
    },
  };
};

/** The outcome report over already-read runs; a refused run is listed, never dropped. */
export const outcomeOf = ({ runs, commitTime = () => null }) => {
  const read = [];
  const skipped = [];
  const occurrences = [];
  for (const entry of runs) {
    if (entry.error) {
      skipped.push({ run: entry.run, why: entry.error });
      continue;
    }
    read.push(entry.run);
    const itemTied = (entry.events ?? []).some((event) => ITEM_TIED.has(event.kind));
    for (const occurrence of itemOccurrences(entry)) occurrences.push({ ...occurrence, itemTied });
  }
  const items = itemsOf(occurrences);
  return {
    schemaVersion: 1,
    runs: { read, skipped },
    signals: [
      firstShippingVerdict(items),
      gateRounds(items),
      claimToMerge(items, commitTime),
      interventions(items),
      continuation(items),
    ],
  };
};
