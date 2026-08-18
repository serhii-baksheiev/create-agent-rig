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
 * Pure by design: the records and the commit come from the caller, so the rule
 * has one implementation and the CLI is only its call site. The purity is pinned
 * by `test/template/gate-coverage.test.ts` › "reads no clock, no environment and
 * no filesystem" — which lives in the generator that produced this project and
 * does not ship with the module, exactly as `.claude/rules/invariants.md` says of
 * the hooks. Edit this file here and that pin does not move with you.
 *
 * 🔴 **A round is judged against its OWN route, not the run's last one.** The
 * answers are scoped to the records after the last fan-out; the route needs the
 * mirror of that, and not having it made the refusal above vacuous in the case it
 * was written for. A run directory spans several rounds and several PRs, so an
 * earlier round's route would otherwise satisfy a later round that journalled
 * none — and its *set* would be inherited too, which after a `deterministic` lane
 * means `neverLaunched` is empty for the rest of the run whatever the route asked
 * for. So the route that counts is the last one carrying `reviewers` **between the
 * previous fan-out and the last one**: the route that produced the fan-out being
 * judged.
 *
 * A route journalled *after* the last fan-out belongs to a round that has not
 * launched yet, and is not read here.
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
 * The lengths a COMPLETE commit id has: sha-1 and sha-256.
 *
 * An abbreviation resolves against a complete id and nothing else. Without this,
 * any strict extension of a full id prefix-matched it — a 50-character value
 * built by appending to a 40-character commit was counted as coverage of that
 * commit, and it passes the schema (7–64 hex), so it arrives through the fully
 * validated path rather than as obvious junk.
 */
const COMPLETE_COMMIT_LENGTHS = new Set([40, 64]);

/**
 * Are these two ids the same commit?
 *
 * 🔴 **Not string equality, and the difference is a false HOLD.** The schema
 * accepts an abbreviated id, so a reviewer may answer `b4e3ef0` about the commit
 * `git rev-parse HEAD` prints in full — the same commit, written shorter. Exact
 * comparison reports that as answered-for-another-commit and holds the merge on
 * honest work, which is the way a guard loses the room.
 *
 * So: equal ids match, and otherwise the shorter must be a prefix of a
 * **complete** one, case-insensitively — the way git resolves an abbreviation.
 * Two bounds, each closing one direction:
 *
 * - **the floor.** Both must reach `SHORTEST_COMMIT`. A shorter value is one the
 *   verdict schema refuses, and stretching it into a match would let a value
 *   nothing accepted decide that a gate was covered. ⚠ The journal is the other
 *   way in and it does not apply that schema (`run-journal.mjs` takes `headSha`
 *   as any non-blank string), so this floor is enforced here on its own account,
 *   not on the strength of an upstream check.
 * - **the ceiling.** The longer must be a complete id. An abbreviation resolves
 *   against a whole commit; a value that merely *extends* one is not that commit
 *   written shorter, and counting it as coverage fails in the unsafe direction.
 *
 * One case is decided rather than left ambiguous: a 40-character value that
 * prefixes a 64-character one matches, because the longer is complete. It could
 * be a sha-256 abbreviated to 40 or a sha-1 with characters appended, and nothing
 * here can resolve which — a pure function has no repository to ask. The first
 * reading is the one an honest run produces.
 */
const sameCommit = (one, other) => {
  if (one.length < SHORTEST_COMMIT || other.length < SHORTEST_COMMIT) return false;
  const first = one.toLowerCase();
  const second = other.toLowerCase();
  if (first === second) return true;
  const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];
  if (!COMPLETE_COMMIT_LENGTHS.has(longer.length)) return false;
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
  //
  // `pendingRoute` is what makes the route round-scoped: a routing record is held
  // until a fan-out consumes it, and each fan-out takes only what was journalled
  // since the previous one. Nothing survives a fan-out, so no round can inherit
  // the round before it.
  let pendingRoute = null;
  let routeOfRound = null;
  let fanOutAt = -1;
  let launchedNames = [];

  for (let index = 0; index < journal.length; index += 1) {
    const record = journal[index];
    const gate = gateOf(record);
    // Only the taken lane carries a set; a declined lane's line has no
    // `reviewers` key at all, and reading one off it would compare the answers
    // against a lane nobody took.
    if (gate.startsWith(ROUTING) && Array.isArray(record?.reviewers)) {
      // A set was RECORDED, which is a different fact from the set being empty.
      // The `deterministic` lane legitimately routes nobody; a round that never
      // journalled a route knows nothing about who should have been launched.
      pendingRoute = namesOf(record.reviewers);
    }
    if (gate === FAN_OUT) {
      fanOutAt = index;
      launchedNames = namesOf(record?.reviewers);
      routeOfRound = pendingRoute;
      pendingRoute = null;
    }
  }

  const routeRecorded = routeOfRound !== null;
  const routedNames = routeOfRound ?? [];

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

  const outstanding =
    neverLaunched.length + unanswered.length + unattributed.length + stale.length;

  return {
    ok: routeRecorded && outstanding === 0,
    routed,
    launched,
    neverLaunched,
    unanswered,
    unattributed,
    stale,
    // Unlike the missing fan-out, this one still has a launched set and answers
    // to compare, so the four lists are computed and returned — the reason says
    // which half of the check could not run, rather than replacing the half that
    // could.
    ...(routeRecorded
      ? {}
      : {
          reason:
            'this round journalled no routed reviewer set, so `neverLaunched` was compared ' +
            'against nothing: a reviewer the route asked for and nobody launched would not ' +
            'appear. An empty route that WAS recorded is a different answer, and so is a ' +
            'route belonging to an earlier round — neither is this one.',
        }),
  };
};
