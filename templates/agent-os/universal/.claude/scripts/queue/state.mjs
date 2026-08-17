/**
 * The queue's own state — today, exactly one field: the tier of the last item
 * the loop closed.
 *
 * 🔴 **Why this file exists at all.** `selectNext` rations the elevated tier by
 * spacing: never two elevated items back to back. It reads
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

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { elevatedPathsIn, isDocument, readDeclaredPaths } from '../detect-missed-gate.mjs';
import { updateState } from '../run-state.mjs';
import { mainCheckoutRoot } from './checkout.mjs';


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
 * `isDocument` is the sweep's own predicate, imported rather than restated —
 * two notions of "document" is the two-implementations defect `invariants.md`
 * names, with the copy nobody looks at rationing on a rule the other one does
 * not have.
 */
const tierOf = (elevated) => {
  if (elevated.length === 0) return 'normal';
  return elevated.every(isDocument) ? 'elevated-prose' : 'elevated-mechanism';
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
  const file = statePath ?? join(mainCheckoutRoot(projectRoot), '.claude', 'queue.state.json');
  writeFileSync(file, `${JSON.stringify({ lastCompletedTier: tier }, null, 2)}\n`);

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
