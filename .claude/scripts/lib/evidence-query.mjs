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

const fanOutsOf = (occurrence) => occurrence.records.filter((record) => record.gate === FAN_OUT);

const laneOf = (occurrence) => {
  const routed = occurrence.records.find(
    (record) => record.gate?.startsWith(ROUTING) && record.verdict === 'route',
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
    const answer = occurrence.records
      .filter((record) => record.gate === reviewer && record.headSha === head)
      .at(-1);
    if (!answer) return null;
    words.push(answer.verdict);
  }
  if (words.every((word) => word === 'SHIP')) return 'SHIP';
  if (words.includes('HOLD')) return 'HOLD';
  return 'other';
};

const counts = () => ({ SHIP: 0, HOLD: 0, other: 0 });

const firstShippingVerdict = (occurrences) => {
  const eligible = occurrences.filter((occurrence) => fanOutsOf(occurrence).length > 0);
  const result = { ...counts(), byLane: {} };
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

/** The outcome report over already-read runs; a refused run is listed, never dropped. */
export const outcomeOf = ({ runs }) => {
  const read = [];
  const skipped = [];
  const occurrences = [];
  for (const entry of runs) {
    if (entry.error) {
      skipped.push({ run: entry.run, why: entry.error });
      continue;
    }
    read.push(entry.run);
    occurrences.push(...itemOccurrences(entry));
  }
  return {
    schemaVersion: 1,
    runs: { read, skipped },
    signals: [firstShippingVerdict(occurrences), gateRounds(occurrences)],
  };
};
