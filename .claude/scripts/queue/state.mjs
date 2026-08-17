/**
 * The queue's own state — today, exactly one field: the tier of the last item
 * the loop closed.
 *
 * 🔴 **Why this file exists at all.** `selectNext` rations the elevated tier by
 * spacing: never two elevated items back to back — where the FIRST one is the
 * half of the tier that executes (`tierOf` below), and the second is still any
 * item whose marker says `elevated`. The asymmetry is not an oversight: a
 * candidate has no diff yet, so there is nothing to classify it from, while a
 * close does. It reads
 * `config.lastCompletedTier` — and nothing anywhere wrote it, so the filter was
 * called with `null` on every selection and **the ration never fired between
 * tasks**. The rule was upheld by whichever session happened to read it, which
 * is precisely the guarantee a mechanical filter exists to replace. A filter
 * whose input nobody supplies is indistinguishable from a filter that agrees
 * with you, and neither a green suite nor a reading of `core.mjs` shows it.
 *
 * 🔴 **The tier is computed from the change, never taken from the item's
 * marker.** `autonomy.md`: *"the tier is decided by what the change touches, not
 * by what the task said it would touch"*, and the `loop` skill calls the marker
 * *"a pre-filter, not the authority"*. Rationing on the marker would mean a
 * marker written one tier low silently buys a second elevated item in a row —
 * which is the failure this repo has already recorded, on the very item that
 * produced this module. The marker stays useful as a hint and a hygiene signal;
 * it is not the value anything rations on.
 *
 * That costs no judgement: the gate sweep already decides this question
 * mechanically, and this module calls the sweep's own functions rather than
 * re-deriving the rules. **One mechanism, one implementation**
 * (`invariants.md`) — two files deciding "is this path elevated" would disagree,
 * and the one nobody is looking at would be the wrong one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { elevatedPathsIn, executesNothing, readDeclaredPaths } from '../detect-missed-gate.mjs';
import { updateState } from '../run-state.mjs';
import { mainCheckoutRoot } from './checkout.mjs';

/** Where the per-checkout state lives, unless a caller names the file. */
const stateFileFor = (statePath, projectRoot) =>
  statePath ?? join(mainCheckoutRoot(projectRoot), '.claude', 'queue.state.json');

/**
 * The state file as an object, or `{}` when it is absent or unusable.
 *
 * Deliberately forgiving, and deliberately different from the reader in
 * `index.mjs`. That one REFUSES a malformed tier, because rationing on a value
 * nobody wrote is the defect it was built for. This one is the writers' side: its
 * job is to not lose the fields it is not writing, and a file it cannot parse has
 * no fields to lose. Refusing here would make a corrupt state file unrecoverable
 * by the very command that would overwrite it.
 */
const readStateFile = (file) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
};

/**
 * The round counts, keyed by branch, with anything malformed dropped.
 *
 * Syntax is not shape (the same lesson `index.mjs` records about the tier): a
 * `gateRounds` of `42`, `"two"`, `["fix/a"]` or `{ "fix/a": -1 }` all parse and
 * carry no count. Every one of them reads as "no rounds yet" — which is the safe
 * direction here, because it costs one extra allowed round rather than refusing a
 * gate nobody has run.
 */
const roundsIn = (state) => {
  const map = state.gateRounds;
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return {};
  const clean = {};
  for (const [branch, count] of Object.entries(map)) {
    if (Number.isInteger(count) && count > 0) clean[branch] = count;
  }
  return clean;
};

const requireBranch = (branch) => {
  if (typeof branch !== 'string' || branch.trim() === '') {
    throw new Error(
      `a gate round is counted per branch, and the branch was ${JSON.stringify(branch)}. ` +
        'Pass `git rev-parse --abbrev-ref HEAD`; a missing branch would share one ' +
        'counter across every task in the checkout.',
    );
  }
  return branch;
};

/** How many gate rounds this branch has already recorded. Zero when unknown. */
export const gateRoundsFor = ({ branch, projectRoot, statePath } = {}) =>
  roundsIn(readStateFile(stateFileFor(statePath, projectRoot)))[requireBranch(branch)] ?? 0;

/**
 * Count one gate round for this branch and return the new total.
 *
 * 🔴 **It merges, and so does `recordCompletedTier` now — this is the part the
 * item that asked for the cap got wrong.** That function used to write this file
 * with a whole-file `writeFileSync`, and its own comment said it "owns its file
 * outright". True while the file held one field; the moment a second writer
 * appears, the first close of any item would have silently deleted the round count
 * of every branch still in gate. Both writers read-modify-write now, and the test
 * that pins it asserts both directions.
 *
 * ⚠ The limit, since two writers on one file invites the question: this is
 * read-modify-write with no lock, so two processes racing on the SAME checkout can
 * lose one increment. The loop is single-threaded per checkout by construction
 * (concurrent tasks get their own worktree, and `mainCheckoutRoot` sends the state
 * to the checkout that outlives them), so the race needs two loops in one
 * directory — which is the case `worktree-task` exists to prevent. A lost
 * increment costs one extra allowed round, never a missed refusal of a later one.
 *
 * ⚠ Nothing prunes the map. One key per branch that ever entered the gate, in a
 * per-checkout file that is gitignored; a merged branch's key is dead weight of a
 * few bytes. Pruning would need to ask git which branches still exist, and a
 * wrong answer there deletes a live counter — which is the failure this cap
 * exists to prevent, so the dead weight is the cheaper mistake.
 */
export const recordGateRound = ({ branch, projectRoot, statePath } = {}) => {
  requireBranch(branch);
  const file = stateFileFor(statePath, projectRoot);
  const state = readStateFile(file);
  const rounds = roundsIn(state);
  const next = (rounds[branch] ?? 0) + 1;
  writeFileSync(
    file,
    `${JSON.stringify({ ...state, gateRounds: { ...rounds, [branch]: next } }, null, 2)}\n`,
  );
  return { rounds: next };
};


/**
 * The tier of a close, from the elevated paths the change crossed.
 *
 * 🔴 **The elevated tier splits in two, and only the ration reads the split.**
 * `elevated-prose` is still an elevated change everywhere it is REVIEWED — the
 * model lane, the cold readers, the `human-review` label, the gate sweep. It
 * simply does not space the next item, because the rule's own stated purpose is
 * about what compounds: *"one **unreviewed** schema or permissions change is
 * recoverable; a chain of them compounding overnight is not"*. A rule file
 * cannot compound into a broken runtime overnight, because nothing executes it —
 * and in a repository whose rulebook lives under a declared path, spacing on the
 * undivided word halts the queue rather than pacing it.
 *
 * A mixed diff is `elevated-mechanism`: the half that runs decides. Reading the
 * tier off the first path, or off "most of them are documents", would ship a
 * ration any diff can opt out of by also touching a `.md`.
 *
 * The predicate is `executesNothing` — **`.md` only, not `.mdx`** — imported
 * from `detect-missed-gate.mjs` so it sits beside the sweep's own markdown test
 * rather than drifting from it. The two are deliberately different and the
 * difference is the ration's whole subject: the sweep asks *does this need a
 * reviewer*, this asks *can it compound overnight*, and MDX is a program that
 * renders (`docs/decisions/review-lanes.md`).
 *
 * ⚠ **The limit worth knowing before trusting this:** a skill's `SKILL.md` is
 * prose by this test, and some of them carry shell snippets an agent copies and
 * runs. The owner's ruling is that skills stay prose for rationing — they are
 * reviewed like the rules they are, and rewriting a procedure is not the chain
 * of unreviewed compounding changes the ration was bought to stop. It is,
 * however, the weakest ground the "no runtime executes it" justification stands
 * on, and the place to look first if the ration ever turns out too loose.
 *
 * ⚠ Two more limits, both erring toward holding: the test is case-sensitive, so
 * `RULES.MD` records `elevated-mechanism`; and only paths `elevatedPathsIn`
 * already returned reach here, so a non-rulebook `.md` was dropped as inert long
 * before and records `normal` — which clears the ration outright rather than as
 * prose (`docs/decisions/review-lanes.md`).
 */
const tierOf = (elevated) => {
  if (elevated.length === 0) return 'normal';
  return elevated.every(executesNothing) ? 'elevated-prose' : 'elevated-mechanism';
};

/**
 * Record the tier of the change that just closed an item.
 *
 * `changedFiles` is the diff's file list — `git diff --name-only <base>...<head>`
 * for the merged PR. It is a required argument and not a defaulted one, which is
 * the whole point of the two refusals below.
 *
 * Returns `{ tier, elevatedPaths }`: the value written, and the files that
 * earned it, so the close step can journal *why* rather than just *what*.
 * `elevatedPaths` is always an array — empty on a normal change, never absent,
 * and **unaffected by the prose/mechanism split above**. `elevatedPaths` answers
 * "what did this change cross", which is the gate's question and not the
 * ration's: a prose merge that stopped listing its rulebook files would look
 * clean to the sweep that exists to catch exactly those merges.
 *
 * 🔴 **It writes a state file BESIDE the queue config, never into it — and that
 * is not a preference.** `.claude/queue.json` is composed from the rig's
 * template layer, so a runtime value written into it is drift: the repository's
 * own sync check fails, and in a generated project the next `upgrade` has a
 * conflict on a file the project never edited. The item that asked for this
 * named the config as the target ("the file `selectNext` already reads"); it was
 * right about the reader and wrong about the file, and the drift check is what
 * proved it. Config is composed and tracked; state is per-checkout and ignored.
 *
 * ⚠ **The limit this cannot see, stated rather than covered by a test that
 * would only look like coverage:** a file list that arrived **truncated** — a
 * split on the wrong separator, a hand-trimmed array, a caller that filtered
 * before passing — is indistinguishable here from a complete one, and a
 * truncated list that drops the elevated file records `normal`. The empty-list
 * refusal below does not catch it, because a short list is not an empty one.
 * The caller owns completeness. (A `maxBuffer` overflow is NOT one of these
 * cases: `execFileSync`, which the documented snippet uses, throws `ENOBUFS`
 * rather than returning a short string — measured, so it fails loudly.)
 */
export const recordCompletedTier = ({ changedFiles, projectRoot, statePath, runDir } = {}) => {
  // 🔴 An absent file list is NOT a normal change. A zero and an unknown look
  // identical in a count and mean opposite things, and guessing `normal` here
  // would rebuild the exact blind spot this module closes: the permissive
  // answer, written confidently, with nothing to show it was never measured.
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error(
      'recordCompletedTier needs the changed file list of the closing change ' +
        '(`git diff --name-only <base>...<head>`). An empty or missing list is an ' +
        'absence, not a normal-tier change, and writing a tier from it would ration ' +
        'the queue on a value nobody measured.',
    );
  }

  // Same refusal, one layer up: a project that declares no elevated path at all
  // would make every change look `normal` forever. `readDeclaredPaths` returns
  // null rather than [] for exactly this case, and the sweep treats it as its
  // own finding rather than as "no findings".
  const declared = readDeclaredPaths(projectRoot);
  if (!declared || declared.length === 0) {
    throw new Error(
      'nothing in this project declares an elevated path, so no tier can be ' +
        'computed: add an `elevated-paths` block to CLAUDE.md or a rule file. ' +
        'Treating the absence as `normal` would ration on a declaration that ' +
        'does not exist.',
    );
  }

  const elevated = elevatedPathsIn(changedFiles, declared);
  const tier = tierOf(elevated);

  // State only. It deliberately does NOT carry `adapter` or `options`: two files
  // answering "which queue is this" is two answers with no rule for which wins,
  // and the loser is whichever one nobody is looking at.
  //
  // The default lands in the MAIN checkout even when the close runs inside a
  // worktree — see `mainCheckoutRoot`. An explicit `statePath` is used verbatim
  // and never re-resolved: it is the escape hatch tests and odd layouts need,
  // and silently relocating it would make it useless.
  //
  // Note the asymmetry, which is deliberate: the DECLARATION is read from the
  // given `projectRoot` (the worktree's own `CLAUDE.md` is the rulebook the
  // change was written against), while the STATE goes to the checkout that
  // outlives the task.
  const file = stateFileFor(statePath, projectRoot);
  // 🔴 Read-modify-write, not a whole-file write. This line used to own the file
  // outright, which was correct while `lastCompletedTier` was its only field —
  // and became a silent deletion the moment `gateRounds` joined it: the first
  // close of any item would have wiped the round count of every branch still in
  // gate, handing back the unbounded rounds the cap exists to stop.
  const existing = readStateFile(file);
  writeFileSync(file, `${JSON.stringify({ ...existing, lastCompletedTier: tier }, null, 2)}\n`);

  // The run's own state, when the run declared a directory. Two files because
  // the two values have different lifetimes: the tier rations ACROSS runs and
  // belongs to the checkout, while the escalation streak means "twice in a row
  // in THIS run" — see `run-state.mjs`. Writing either into the other's file
  // silently breaks the rule it exists for.
  //
  // 🔴 A close BREAKS the streak, and that is the point of writing it here.
  // "Two escalations in a row" ends when something lands in between; a counter
  // nothing resets turns the second escalation of a long, otherwise healthy run
  // into a permanent stop.
  //
  // `updateState` merges, so the budget and the trigger record this run has
  // accumulated survive — unlike the whole-file write above, which owns its
  // file outright.
  //
  // The tier goes into both files, and only one of them is read back: selection
  // takes it from the per-checkout file above. The run-state copy is a trace of
  // what this run closed — the item's own state shape names it — not a second
  // input to the ration, and reading it as one would be the per-run clean slate
  // this module exists to prevent.
  //
  // ⚠ **Deliberately untried, unlike the same call inside `recordEscalation`.**
  // There the caller has already mutated a tracker, so a throw would report a
  // successful escalation as a failure and invite a double-posted comment. Here
  // the durable half — the tier the ration reads — is already on disk one line
  // above, and the half that can still fail is the streak reset, whose loss
  // stops the run EARLIER than it needed to. A failure that errs toward
  // stopping is one to hear about, not one to swallow.
  if (runDir) updateState(runDir, { lastCompletedTier: tier, escalations: 0 });

  return { tier, elevatedPaths: elevated };
};
