// Outcome Evidence signal definitions (RP-356): the one source a report reads
// a signal's meaning from. Data only — nothing here computes a signal; the
// contract around it is `docs/decisions/outcome-signals.md`.
//
// A signal whose meaning changes gets a new `signalVersion`, and two values
// of different versions are never compared. `groupBy` is the only grouping a
// report may apply, and no dimension names a person.
//
// Tests: `test/template/outcome-signals.test.ts` (absent in a generated rig).

const freezeSignal = (signal) =>
  Object.freeze({
    ...signal,
    limits: Object.freeze([...signal.limits]),
    comparableOn: Object.freeze([...signal.comparableOn]),
    groupBy: Object.freeze([...signal.groupBy]),
  });

/** The dimensions a signal may be compared on or grouped by. */
export const DIMENSIONS = Object.freeze(['repository', 'signalVersion', 'harness', 'lane', 'population']);

/** What a baseline/current comparison can answer. */
export const COMPARISON_RESULTS = Object.freeze(['comparable', 'not comparable', 'insufficient']);

/** A value the evidence does not establish — never zero. */
export const UNKNOWN = 'unknown';

const BASE_COMPARABLE_ON = ['repository', 'signalVersion', 'population'];

export const SIGNALS = Object.freeze(
  [
    {
      name: 'first-shipping-verdict',
      signalVersion: 1,
      definition: 'The distribution of the first gate verdict recorded for each item: SHIP or HOLD at its first reviewed head.',
      source: 'reviewer verdict records in the run journal (decisions.jsonl)',
      population: 'items with at least one recorded gate verdict in the named runs',
      unknown: 'an item with no recorded gate verdict',
      limits: [
        'the review lane is part of the interpretation: a deterministic or fast-path lane launches fewer reviewers',
        'a successor or re-filed item starts its own "first" and can hide an earlier HOLD',
        'descriptive evidence, not a quality score',
      ],
      comparableOn: [...BASE_COMPARABLE_ON, 'lane'],
      groupBy: ['lane'],
    },
    {
      name: 'gate-rounds',
      signalVersion: 1,
      definition: 'The number of gate rounds a branch took before its merge: review and rework cycles.',
      source: 'the per-branch gate-round counter and reviewer fan-out records',
      population: 'merged branches whose gate rounds were recorded in the named runs',
      unknown: 'a branch whose gate evidence stayed local or was not recorded',
      limits: ['gate evidence kept only on one machine leaves historical runs unknown'],
      comparableOn: [...BASE_COMPARABLE_ON, 'lane'],
      groupBy: ['lane'],
    },
    {
      name: 'claim-to-merge',
      signalVersion: 1,
      definition: 'The total wall time from an item’s claim to its merge.',
      source: 'the claim event in the run journal and the merge commit of the item’s change',
      population: 'items with both a recorded claim and an authoritative merge',
      unknown: 'an item without an authoritative merge endpoint, which is excluded rather than forced in',
      limits: [
        'total wall time includes waiting on CI and on reviews',
        'it is not active engineering time, and no subtraction of pauses turns it into one',
      ],
      comparableOn: [...BASE_COMPARABLE_ON],
      groupBy: [],
    },
    {
      name: 'interventions',
      signalVersion: 1,
      definition: 'The recorded escalations and delegated decisions an item needed.',
      source: 'escalation and delegated-decision records in the run journal and item records',
      population: 'items selected in the named runs',
      unknown: 'an item whose run journal is missing',
      limits: ['tracker-specific conventions, such as reassignment, are outside the built-in scope'],
      comparableOn: [...BASE_COMPARABLE_ON],
      groupBy: [],
    },
    {
      name: 'continuation',
      signalVersion: 1,
      definition: 'The resolution state of recorded continuations: resolved, unresolved or unknown.',
      source: 'continuation records and their resolution events',
      population: 'continuations recorded in the named runs',
      unknown: 'a continuation whose resolution cannot be read',
      limits: ['open or unresolved work is not counted as a failed recovery'],
      comparableOn: [...BASE_COMPARABLE_ON],
      groupBy: [],
    },
    {
      name: 'tokens-per-ship',
      signalVersion: 1,
      definition: 'Dispatch token usage per SHIP verdict, per harness.',
      source: 'dispatch usage records in the run journal',
      population: 'SHIP verdicts whose dispatches carry trustworthy usage records',
      unknown: 'a SHIP whose dispatches carry no usage record',
      limits: ['conditional on trustworthy dispatch usage evidence', 'never compared across harnesses'],
      comparableOn: [...BASE_COMPARABLE_ON, 'harness'],
      groupBy: ['harness'],
      conditional: true,
    },
  ].map(freezeSignal),
);
