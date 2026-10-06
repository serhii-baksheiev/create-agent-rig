/**
 * The autonomous-controller authority contract (RP-339) — the single source
 * of truth for what a `delegated` decision authority may resolve on its own,
 * the closed list of boundaries that stay with the owner regardless of
 * delegation, and the one posture object every surface reports against. Mirrors `.claude/scripts/lib/posture.mjs`
 * (RP-280): same reason — one mechanism, one implementation
 * (`.claude/rules/invariants.md`) — applied to a second closed-vocabulary
 * contract. Why this is one module: `docs/decisions/decision-authority.md`.
 *
 * Adding an id is a deliberate contract change: see
 * test/template/authority.test.ts (absent in a generated rig) › "exports
 * exactly the delegable decision ids the contract names, in order, each
 * kebab-case" and › "exports exactly the non-delegable boundary ids the
 * contract names, in order, each kebab-case".
 */

const decision = (id, summary) => Object.freeze({ id, summary });

/** The two recognised execution modes. */
export const EXECUTION_MODES = Object.freeze(['attended', 'unattended']);

/** The two recognised decision authorities. */
export const DECISION_AUTHORITIES = Object.freeze(['owner', 'delegated']);

/** The backwards-compatible default when no decision authority is reported. */
export const DEFAULT_DECISION_AUTHORITY = 'owner';

/** Irreversible external publication is never delegable. */
export const PUBLICATION_AUTHORITY = 'owner';

/** The closed list of decisions a `delegated` authority may resolve. */
export const DELEGABLE_DECISIONS = Object.freeze([
  decision(
    'implementation-choice',
    'Choose among technically sound alternatives inside the item’s stated scope.',
  ),
  decision(
    'scope-correction',
    'Narrow or split an item within its stated intent, filing what is left as a tracked follow-up.',
  ),
  decision('work-sequencing', 'Choose which eligible item to take next and in what order.'),
  decision(
    'tracker-correction',
    'Correct labels, dependency links or stale text on a tracker item when evidence supports it.',
  ),
  decision(
    'finding-disposition',
    'Accept, reject or defer a non-blocking review finding, with the rationale recorded.',
  ),
  decision(
    'extra-gate-round',
    'Authorise another review round past the configured cap when a concrete blocker justifies it.',
  ),
  decision(
    'elevated-change-acceptance',
    'Accept a Tier-2 change confined to the repository — no new dependency or outbound integration, no public API, auth, schema or data change — that went through the full review and check flow.',
  ),
  decision('merge', 'Merge a change whose required reviews and required checks passed for its exact head.'),
  decision(
    'release-candidate-freeze',
    'Prepare and freeze a release candidate whose release gates pass — never publish it.',
  ),
]);

/** The closed list of boundaries that stay with the owner regardless of delegation. */
export const NON_DELEGABLE_BOUNDARIES = Object.freeze([
  decision('never-rule', 'Anything the autonomy rules list under Never.'),
  decision('kill-switch', 'The kill switch is set.'),
  decision('failing-mechanical-gate', 'A required check, hook or gate reports a failure.'),
  decision(
    'unreadable-evidence',
    'The queue, a claim, the run journal or other evidence is unreadable or corrupt.',
  ),
  decision('credential-protection', 'Secret and credential protections.'),
  decision(
    'hard-external-boundary',
    'A fact outside the repository the controller cannot change — quota, outage, missing access or credential.',
  ),
  decision('publication', 'Irreversible external publication — a package registry, a release, a tag.'),
]);

/** Exactly `undefined`/`null` default to `owner`; `owner`/`delegated` read as themselves; anything else is `unknown`. */
export const parseDecisionAuthority = (raw) => {
  if (raw === undefined || raw === null) return DEFAULT_DECISION_AUTHORITY;
  return DECISION_AUTHORITIES.includes(raw) ? raw : 'unknown';
};

/** Exactly `attended`/`unattended` read as themselves; anything else, including undefined/null, is `unknown`. */
export const parseExecutionMode = (raw) => (EXECUTION_MODES.includes(raw) ? raw : 'unknown');

/**
 * Whether `authority` may resolve `decisionId` on its own. Throws, naming the
 * id, when neither list names it — the vocabulary is closed. `true` only
 * for a delegable id under exactly `'delegated'`; `false` otherwise,
 * including every non-delegable id under every authority.
 */
export const mayResolve = (decisionId, authority) => {
  const isDelegable = DELEGABLE_DECISIONS.some((entry) => entry.id === decisionId);
  const isNonDelegable = NON_DELEGABLE_BOUNDARIES.some((entry) => entry.id === decisionId);
  if (!isDelegable && !isNonDelegable) {
    throw new Error(`mayResolve: "${decisionId}" is not a decision this contract names.`);
  }
  return isDelegable && authority === 'delegated';
};

/**
 * The one posture object every surface reports against: the parsed execution
 * mode, the parsed decision authority (defaulting to `owner`), and the fixed
 * publication authority. Any other input key is ignored.
 */
export const authorityPosture = ({ executionMode, decisionAuthority } = {}) =>
  Object.freeze({
    schemaVersion: 1,
    executionMode: parseExecutionMode(executionMode),
    decisionAuthority: parseDecisionAuthority(decisionAuthority),
    publicationAuthority: PUBLICATION_AUTHORITY,
  });
