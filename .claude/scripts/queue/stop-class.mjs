// The closed stop-class vocabulary (RP-341): each stop it catalogues is a
// decision the rules route to the owner (`decision-needed`), a blocked item
// (`work-blocked`) or a run-level wall (`systemic-wall`, `hard-external-boundary`), and
// `resolutionOf` says what a decision authority may do about it. Decision
// kinds are checked against the one authority contract, `../lib/authority.mjs`
// (RP-339), never a second copy of it. Why: `docs/decisions/decision-authority.md`.
//
// Pinned in test/template/stop-class.test.ts (absent in a generated rig) ›
// "lists exactly the nine catalogued stops, in order, each with its stop
// class and decision".

import { mayResolve } from '../lib/authority.mjs';

const itemStop = (id, stopClass, decision = null) => Object.freeze({ id, stopClass, decision });

/** The closed list of stop classes. */
export const STOP_CLASSES = Object.freeze([
  'decision-needed',
  'work-blocked',
  'systemic-wall',
  'hard-external-boundary',
]);

/** The three resolutions a stop can reach. */
export const RESOLUTIONS = Object.freeze(['decide-and-continue', 'escalate-item', 'stop-run']);

/** The per-item stop catalogue: which class, and which delegable decision (if any). */
export const ITEM_STOPS = Object.freeze([
  itemStop('three-strikes', 'work-blocked'),
  itemStop('attempt-budget', 'work-blocked'),
  itemStop('blocking-verdict', 'work-blocked'),
  // No delegable decision yet: pr-ship's round counter has no delegated
  // override (RP-432), and check-premises leaves re-aiming a false premise
  // to a human — RP-342 round 1.
  itemStop('gate-round-cap', 'decision-needed'),
  itemStop('premise-false', 'decision-needed'),
  // A declared elevated path that is none of the Tier-2 change kinds is
  // delegable; an unplanned Tier-2 change kind (autonomy.md, "Surprise
  // scope") names no delegable decision, so it stays the owner's.
  itemStop('elevated-path-scope', 'decision-needed', 'elevated-change-acceptance'),
  itemStop('surprise-scope', 'decision-needed'),
  itemStop('invariant-conflict', 'decision-needed'),
  // One item waiting on something outside the run parks; independent work
  // continues. A wall that stops the whole run is a run-level stop instead.
  itemStop('external-blocker', 'work-blocked'),
]);

/** Every run-level stop `core.mjs`'s `stopConditionOf` can return, except the two clean ends, mapped to its class. */
export const RUN_STOP_CLASS = Object.freeze({
  'queue-unreadable': 'systemic-wall',
  'runtime-regression': 'systemic-wall',
  'revalidation-hold': 'systemic-wall',
  'repeated-escalation': 'systemic-wall',
  'kill-switch': 'hard-external-boundary',
  budget: 'hard-external-boundary',
  // `queue/index.mjs` emits this one itself, before stopConditionOf runs.
  'run-state-unreadable': 'systemic-wall',
});

/**
 * Turn a stop class, a decision authority and a decision id into one of the
 * three resolutions. Throws, naming it, for a stop class outside
 * `STOP_CLASSES` or a decision id neither of `authority.mjs`'s two lists
 * names — both vocabularies are closed.
 */
export const resolutionOf = ({ stopClass, authority, decision }) => {
  if (!STOP_CLASSES.includes(stopClass)) {
    throw new Error(`resolutionOf: "${stopClass}" is not a stop class this contract names.`);
  }
  if (stopClass === 'systemic-wall' || stopClass === 'hard-external-boundary') {
    return 'stop-run';
  }
  if (stopClass === 'work-blocked') {
    return 'escalate-item';
  }
  // decision-needed
  if (decision === null || decision === undefined) return 'escalate-item';
  return mayResolve(decision, authority) ? 'decide-and-continue' : 'escalate-item';
};
