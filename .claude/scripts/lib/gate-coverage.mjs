/**
 * Gate coverage — did every reviewer this round asked for actually answer, and
 * for the commit being merged?
 *
 * Three writers already record the three halves of a gate round, and until this
 * module existed nothing compared them:
 *
 *   - `decision-router.mjs` journals the set the route ASKED FOR, on the lane it
 *     actually took (`gate: "review-routing:<lane>"`, with `reviewers`);
 *   - `pr-ship` journals the set it actually LAUNCHED, with the head it launched
 *     against (`gate: "reviewer-fan-out"`);
 *   - each verdict that PARSED is journalled under the reviewer's own name.
 *
 * The two failures that hide in the gap between them both end in a merge that
 * reads as fully gated: a reviewer the router named and nobody started, and a
 * reviewer that answered — about a commit two pushes ago.
 *
 * 🔴 **A verdict that names no commit is not coverage of this one.** `headSha` is
 * optional in the schema — every report written before it existed omits one — and
 * reading absence as "it must have meant the head I am holding" is the inference
 * the schema's own limit 6 forbids. It gets its own list rather than a pass.
 *
 * 🔴 **No fan-out record is not a clean round.** A run whose journal records no
 * fan-out has not been shown to be covered, it has been shown to be unreadable —
 * and four empty lists are exactly what a clean round looks like. That case
 * answers `ok: false` and says why in `reason`, which is present on no other
 * answer.
 *
 * Pure by design, and tested for it: the records and the commit come from the
 * caller, so the rule has one implementation and the CLI is only its call site.
 */

/** The gate name `pr-ship` writes its fan-out under. */
const FAN_OUT = 'reviewer-fan-out';

/** Every lane the router reports on shares this prefix; only the taken one carries a set. */
const ROUTING = 'review-routing:';

const gateOf = (record) => (typeof record?.gate === 'string' ? record.gate : '');

/**
 * The reviewer names in a journalled set.
 *
 * `recordDecision` checks for a list of strings and nothing about what a name
 * is, so a blank one is dropped here rather than reported as a reviewer nobody
 * can launch.
 */
const namesOf = (value) =>
  Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name.trim() !== '') : [];

/** Order-preserving, because the output is read by a human looking for a name. */
const uniq = (names) => [...new Set(names)];

/**
 * The shortest commit id the verdict schema accepts, and the floor a prefix
 * match needs to be worth anything (`lib/verdict.mjs`, `isCommitId`).
 */
const SHORTEST_COMMIT = 7;

/**
 * Are these two ids the same commit?
 *
 * 🔴 **Not string equality, and the difference is a false HOLD.** The schema
 * accepts an abbreviated id, so a reviewer may answer `b4e3ef0` about the commit
 * `git rev-parse HEAD` prints in full — the same commit, written shorter. Exact
 * comparison reports that as answered-for-another-commit and holds the merge on
 * honest work, which is the way a guard loses the room.
 *
 * So: the shorter is a prefix of the longer, case-insensitively, the way git
 * resolves an abbreviation itself. **Both must reach the schema's floor.** A
 * value shorter than that is one `parseVerdict` refuses upstream, and stretching
 * it into a match would let a value nothing accepted decide that a gate was
 * covered.
 */
const sameCommit = (one, other) => {
  if (one.length < SHORTEST_COMMIT || other.length < SHORTEST_COMMIT) return false;
  const [shorter, longer] =
    one.length <= other.length ? [one.toLowerCase(), other.toLowerCase()] : [other.toLowerCase(), one.toLowerCase()];
  return longer.startsWith(shorter);
};

/**
 * Which reviewers are outstanding for `headSha`, and in which of the four ways.
 *
 * @param {{ records?: unknown, headSha?: unknown }} input
 *   `records` is `readRun(...).decisions` — the run's decision journal, in
 *   journal order. `headSha` is the commit the round is about.
 * @returns {{
 *   ok: boolean, routed: string[], launched: string[],
 *   neverLaunched: string[], unanswered: string[],
 *   unattributed: string[], stale: string[], reason?: string,
 * }}
 */
export const coverageOf = ({ records, headSha } = {}) => {
  const journal = Array.isArray(records) ? records : [];
  const target = typeof headSha === 'string' ? headSha : '';

  // One forward pass, keeping the LAST of each: a branch gets a second gate
  // round after fixes, and the round's whole question is whether THIS round's
  // reviewers answered. An earlier fan-out answers about a round already over.
  let routedNames = [];
  let fanOutAt = -1;
  let launchedNames = [];

  for (let index = 0; index < journal.length; index += 1) {
    const record = journal[index];
    const gate = gateOf(record);
    // Only the taken lane carries a set; a declined lane's line has no
    // `reviewers` key at all, and reading one off it would compare the answers
    // against a lane nobody took.
    if (gate.startsWith(ROUTING) && Array.isArray(record?.reviewers)) {
      routedNames = namesOf(record.reviewers);
    }
    if (gate === FAN_OUT) {
      fanOutAt = index;
      launchedNames = namesOf(record?.reviewers);
    }
  }

  const routed = uniq(routedNames);

  if (fanOutAt === -1) {
    return {
      ok: false,
      routed,
      launched: [],
      neverLaunched: [],
      unanswered: [],
      unattributed: [],
      stale: [],
      reason:
        'this run journalled no reviewer fan-out, so there is no set to check the verdicts ' +
        'against. That is not a round with nothing outstanding — it is a round nothing can ' +
        'read, and the two look identical from the lists alone.',
    };
  }

  const launched = uniq(launchedNames);
  // Answers are the records that come AFTER the fan-out. A verdict from the
  // previous round is still in the journal, and a reader that scanned the whole
  // file would find an answer and report the current round covered.
  const after = journal.slice(fanOutAt + 1);

  // The lane is a floor and never a ceiling — the triggers may only ADD
  // reviewers — so a launched set larger than the routed one is the ordinary
  // case and is not a finding. Only the other direction is.
  const neverLaunched = routed.filter((name) => !launched.includes(name));

  const unanswered = [];
  const unattributed = [];
  const stale = [];

  for (const name of launched) {
    // Matched by gate name, which is what keeps another writer's record — the
    // router's own line, `pr-ship`'s, a deploy verdict — from being read as a
    // reviewer's answer.
    const commits = after
      .filter((record) => gateOf(record) === name)
      .map((record) => record?.headSha)
      .filter((commit) => typeof commit === 'string' && commit !== '');

    const answered = after.some((record) => gateOf(record) === name);
    if (!answered) {
      unanswered.push(name);
    } else if (commits.some((commit) => sameCommit(commit, target))) {
      // Covered. A HOLD counts here exactly as a SHIP does: coverage is about
      // who spoke for which commit, never about what they said.
    } else if (commits.length === 0) {
      unattributed.push(name);
    } else {
      stale.push(name);
    }
  }

  return {
    ok:
      neverLaunched.length === 0 &&
      unanswered.length === 0 &&
      unattributed.length === 0 &&
      stale.length === 0,
    routed,
    launched,
    neverLaunched,
    unanswered,
    unattributed,
    stale,
  };
};
