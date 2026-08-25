/**
 * The run's own state — three of the four values `stopConditionOf` asks for and
 * nothing used to answer. The fourth, `killSwitch`, is deliberately not here:
 * it is already mechanical in `guard-bash` and scripted in preflight, and a
 * second answer to "is the brake on" is the disagreement `invariants.md`
 * forbids.
 *
 * 🔴 **Why this file exists.** `core.mjs` takes `consecutiveEscalations`,
 * `lastDeployVerdict`, `budgetExhausted` and `killSwitch`, and every branch that
 * reads them was live — but the CLI called it with `candidates` and `skipped`
 * only, so all four held their defaults on every real selection. The values
 * were "remembered" by the session instead, which is precisely the guarantee a
 * mechanical check exists to replace, and they are lost at compaction — the
 * moment a long run needs them most. A stop rule nobody can supply the input
 * for is a stop rule that never fires.
 *
 * 🔴 **Per run, not per checkout, and the difference is the whole design.**
 * `escalations` means *two in a row in this run*; a declared budget belongs to
 * this run; a `REGRESSION` verdict is about the deploy this run made. Written
 * into a checkout-wide file, every one of them would outlive the run that
 * learned it: two runs sharing a checkout would stop each other on a counter
 * neither of them raised, and a regression would carry into tomorrow's run,
 * which knows nothing about the deploy that caused it and is the run best
 * placed to fix it. (`HEALTHY` below can clear a verdict — so the argument is
 * *whose fact is it*, not *can it be undone*. A stop that has to be
 * hand-cleared by a run that did not set it is a stop that will be
 * hand-cleared without being read.)
 *
 * The one value that is genuinely per-checkout stays where it is:
 * `lastCompletedTier` in `queue/state.mjs` rations elevated work *across* runs,
 * so moving it here would hand each new run a clean slate and restore the exact
 * defect that file was written to close. The close writes both, deliberately.
 *
 * **What this module does NOT own:** the run-id convention and creating the
 * directory. Those belong to whatever drives the run — here the `loop` skill,
 * which declares `RIG_RUN_DIR` in its preflight. Handed a `runDir`, this module
 * uses it verbatim, exactly as `run-journal.mjs` does. Two owners of one
 * convention disagree the first time either changes.
 *
 * ⚠ **It assumes one writer**, like the journal beside it — but degrades
 * differently, and the difference is worth knowing before relying on either.
 * The journal *detects* a collision through its sequence and refuses; this
 * merge is read-then-write with no lock, so two processes sharing a run
 * directory silently lose one of their patches. Measured: four processes ×
 * 200 increments recorded 215. The loss is always downward, so the stop this
 * file exists to fire fires **late or never** — never early. One run directory
 * per run is the caller's part of the contract, and the `loop` skill states it.
 */

import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE = 'state.json';

/** The state file's path inside a run directory — one definition, not two. */
export const statePathIn = (runDir) => join(runDir, STATE);

/**
 * What the run has recorded so far; `{}` when it has recorded nothing.
 *
 * 🔴 **Unreadable is empty, and that is a decision rather than an oversight.**
 * A corrupt or half-written state file must not stop the run from selecting
 * work: the failure mode of reading it as "no state" is today's behaviour —
 * which is exactly what the caller had before this module — while the failure
 * mode of throwing is a run that cannot take an item because of a file that
 * only ever *adds* stop conditions. Fail towards the behaviour that was already
 * trusted.
 *
 * Note the asymmetry with `run-journal.mjs`, which refuses a broken sequence
 * loudly: the journal's whole job is to be trustworthy evidence, so a journal
 * that cannot vouch for itself must say so. This file's job is to supply stop
 * inputs, and an absent input is a defined state there.
 */
export const readState = (runDir) => {
  if (!runDir) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePathIn(runDir), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Merge `patch` over what is already recorded, and return the result.
 *
 * Shallow by design: the fields are flat values plus one object
 * (`triggersFired`), and a deep merge would make "clear this field"
 * unexpressible — a caller passing an object means *this value now*, not
 * *these keys added to whatever was there*. The `trigger` command therefore
 * merges its own map before calling, where the intent is explicit.
 *
 * 🔴 **Write-then-rename, because the reader is another process.** A plain
 * write leaves a window where the file on disk is half a JSON document, and the
 * reader above turns that into `{}` — a silently forgotten escalation streak.
 * A rename within one directory is atomic on **POSIX**, so a reader sees either
 * the old state or the new one and never a torn one. On Windows the same call
 * goes through `MoveFileEx`, which does not guarantee atomicity when it
 * replaces an existing file and fails outright if the destination is open — so
 * there the failure is loud rather than torn, which is the direction to prefer
 * if it ever has to be handled.
 */
export const updateState = (runDir, patch) => {
  const next = { ...readState(runDir), ...patch };
  const file = statePathIn(runDir);
  // The temp name carries the pid so a second writer cannot clobber the first
  // one's half-written file — the merge above is still unsafe under two
  // writers, but a torn read is not how it fails.
  const tmp = `${file}.${process.pid}.tmp`;
  // `wx` refuses an existing path rather than writing through it. Without it a
  // symlink planted at the temp name is followed, and the rename then makes
  // `state.json` itself that symlink — so the run's stop conditions would be
  // read from, and written to, a file somebody else chose. The pid narrows who
  // can guess the name; it does not stop anyone who watches the directory.
  //
  // `0o600` narrows this file specifically. It is not a claim about the run
  // directory: `run-journal.mjs` appends beside it at the default mode, and its
  // records carry the same run's item ids.
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    // A failed rename used to leave the temp file behind, where `wx` then
    // refuses any later write from a process that redraws the same pid — the
    // name carries it, so this is a narrow collision rather than a bricked run,
    // and it is loud either way. The one case this cannot clean is a process
    // killed between the write and the rename: no handler runs, and the temp
    // leaks until the run directory is discarded. The unlink's own failure is
    // swallowed on purpose: the caller needs the rename's error, not this one.
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file is already gone, or unreachable for the same reason the rename was */
    }
    throw error;
  }
  return next;
};

/**
 * Count one task that hit a wall, and hand back the new total.
 *
 * 🔴 **One recorder, called by three adapters — not three counters.** Every
 * adapter's `escalate()` needs this, and three copies of read-then-increment is
 * how the number means something different depending on which tracker the rig
 * happens to use (`invariants.md`, "one mechanism, one implementation"). The
 * adapters own *how a tracker records an escalation*; the count of them in this
 * run is not tracker business at all.
 *
 * 🔴 **Where to call it from, stated because the next adapter's author cannot
 * infer it:** the count rises **after** the tracker has been mutated, and
 * unconditionally only where the adapter mutates no tracker at all. So
 * `github-issues` and `jira` call this last, once the comment and the label
 * have landed; `plan-md` calls it immediately, because a flat list has nothing
 * to write. Called first, the count would claim an escalation the tracker never
 * received — and it is the count, not the tracker, that ends the run.
 *
 * A run that declared no directory records nothing and **does not throw**: an
 * attended session escalating an item by hand is an ordinary thing to do, and a
 * recorder that refused there would push callers into not calling it.
 *
 * A stored value that is not a number reads as none. It is the same permissive
 * read as {@link readState} and for the same reason — a hand-edited state file
 * must not be able to make the count `NaN`, which compares false against every
 * threshold and silently disables the stop it feeds.
 */
export const recordEscalation = (runDir) => {
  if (!runDir) return 0;
  const onDisk = readState(runDir).escalations;
  const current = Number.isInteger(onDisk) && onDisk >= 0 ? onDisk : 0;
  try {
    updateState(runDir, { escalations: current + 1 });
    return current + 1;
  } catch (error) {
    // 🔴 **This one call tolerates a failed write, and the reason is the caller,
    // not the value.** Two of the three adapters run this AFTER the tracker is
    // already mutated — the comment posted, the `escalated` label applied — so a
    // stale `RIG_RUN_DIR` (an export surviving the last run, a cleaned run
    // directory, a worktree the loop's `mkdir -p` never reached) would turn a
    // fully successful escalation into a thrown error. The caller then retries,
    // and the retry double-posts the diagnosis onto the issue.
    //
    // Loud, not silent: swallowing this quietly would trade a crash for a lie,
    // and the count feeding the two-in-a-row stop would drift below the truth
    // with nothing to show for it. Stderr, never stdout — a stray line on stdout
    // lands inside `queue next --json`'s document.
    //
    // `updateState` itself keeps throwing. The CLI writers below refuse loudly
    // on purpose, and only this call site has a mutated tracker behind it.
    process.stderr.write(
      `run state: the escalation was NOT counted in ${runDir} — ${error.message}\n` +
        '  the tracker was updated; only the local count was lost. Fix the run ' +
        'directory before the next task, or the two-in-a-row stop reads low.\n',
    );
    // The count actually on disk, not the one intended: a caller journalling
    // this number must not record a streak the state file does not carry.
    return current;
  }
};

/**
 * The take-up snapshot: the selected item's `updatedAt` marker, keyed by id, as
 * seen at SELECT. `queue/core.mjs` › revalidationOf compares the next selection
 * against it, so a stale take-up is reported rather than silently continued.
 *
 * Per run, like everything else here — a snapshot from yesterday's run is not
 * a take-up this run made. Merged by id, so a second item does not erase the
 * first; re-recording an id moves its baseline forward. A marker that is not a
 * string is not recorded at all: `plan-md` has none, and writing `null` would
 * later compare equal to `null` and read as "unchanged".
 *
 * No run directory → nothing written, `null` back, no throw: an attended
 * selection has no run to snapshot into, exactly as {@link recordEscalation}.
 */
export const recordTakeUp = (runDir, { id, updatedAt } = {}) => {
  if (!runDir || typeof updatedAt !== 'string' || id === undefined || id === null) return null;
  const state = readState(runDir);
  const takeUps = typeof state.takeUps === 'object' && state.takeUps !== null ? state.takeUps : {};
  return updateState(runDir, { takeUps: { ...takeUps, [String(id)]: updatedAt } });
};

/**
 * The stop inputs, read out of a state object that anything may have written.
 *
 * 🔴 **An uninterpretable value is never "no stop".** The writers here are
 * careful — `recordEscalation` refuses a non-integer, the CLI checks its
 * vocabulary before writing — but the file is documented as hand-editable, and
 * the reader used to pass whatever JSON held straight into JS comparisons.
 * Measured, before this existed: `{"escalations":{}}` selected work, because
 * `{} >= 2` is `NaN >= 2`; so did a `lastDeployVerdict` that was an object,
 * because `=== 'REGRESSION'` is false for one. Both are the dangerous
 * direction — a value that *looks* like a recorded stop and silently disables
 * it.
 *
 * So this throws, naming the field, and the caller refuses to select. The
 * permissive readings that remain are the ones where absence is a defined
 * state: no file, no key, or an explicit `null`.
 */
export const stopInputsOf = (state = {}) => {
  const refuse = (field, value) => {
    // 🔴 The rendering has a CONSTANT failure path, and that is not fussiness.
    // `JSON.stringify` recurses, so a deeply nested value overflows the stack
    // *inside the refusal* — the operator then gets `Maximum call stack size
    // exceeded` from a function whose entire job is to name the field that is
    // wrong. `String(value)` is no fallback: on an array it recurses too, via
    // `join`. Measured: `JSON.stringify` gives out around 6 800 levels deep.
    let rendered;
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = '(a value too deeply nested to print)';
    }
    throw new Error(
      `run state: ${field} is ${rendered ?? typeof value}, which is not a value this ` +
        `can act on. An input a stop condition cannot read must not be read as ` +
        `"no stop" — fix or delete the field rather than leaving it.`,
    );
  };

  // 🔴 **A type gate ahead of the coercion — because `Number()` decides this
  // question on the wrong axis.** The rule the three fields share is: coerce
  // where any coercion fails safe, refuse where it fails dangerous. `Number()`
  // gets that right for `"5"`, and wrong for everything that quietly becomes 0
  // or 1: measured, `true` read as one escalation, and `false`, `''`, `' '` and
  // `[]` all read as none — a present value silently disabling the stop it was
  // written to enforce, which is the exact case this function exists for. What
  // survives the gate is still coerced, and every one of those coercions rounds
  // toward stopping earlier (`"1e3"` → 1000, `"0x10"` → 16).
  //
  // A hand-edit reaching for `"2"` means two; one reaching for `false` does not
  // mean zero escalations, it means the file is not saying anything this can
  // act on.
  //
  // **An array is refused rather than unwrapped**, though a one-element array
  // used to read as its contents. Nothing writes one — `recordEscalation`
  // writes an integer, `recordCompletedTier` writes `0`, and the CLI writes
  // only the other three fields — and the branch that
  // accepted it carried three defects of the very kind above: `[null]` read as
  // zero, a multi-element array was refused only by an untested length check,
  // and the unwrapping recursed as deep as its input. A shape with no writer is
  // not a shape worth interpreting.
  const countOf = (value) => {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  const escalations = state.escalations ?? 0;
  const count = countOf(escalations);
  if (count === null) refuse('escalations', escalations);

  const verdict = state.lastDeployVerdict ?? null;
  if (verdict !== null && typeof verdict !== 'string') refuse('lastDeployVerdict', verdict);
  // A verdict outside the vocabulary is the same defect wearing a plausible
  // spelling: `REGRESSED` would sit in the file looking recorded and matching
  // nothing. Case is normalised, exactly as the CLI normalises it on the way in.
  const normalised = verdict === null ? null : verdict.toUpperCase();
  if (normalised !== null && !DEPLOY_VERDICTS.includes(normalised)) {
    refuse('lastDeployVerdict', verdict);
  }

  // `triggersFired` is deliberately absent from this, and its absence is a
  // decision rather than an oversight: `core.mjs` compares `fired !== true`
  // strictly, so a string, a number or a nonsense shape can only ever leave an
  // item held back. Every misreading fails in the safe direction, which is the
  // one case this function has nothing to add to.
  return {
    consecutiveEscalations: count,
    lastDeployVerdict: normalised,
    // Any truthy value means exhausted: the only writer stores `true`, and a
    // hand-edit reaching for `"yes"` means yes. A flag has an honest `false`,
    // unlike a count — so unlike `escalations` above, nothing here needs
    // refusing: no present value silently disables the stop.
    budgetExhausted: Boolean(state.budgetExhausted),
  };
};

/**
 * The post-deploy verdict, as `autonomy.md` defines it: binary, and the only
 * two words `stopConditionOf` can act on.
 *
 * `HEALTHY` is not decoration. The field is `lastDeployVerdict` and "last" is
 * the whole of it — without a word that clears a regression, one bad deploy
 * ends every later selection in the run and the operator's only way out is to
 * hand-edit a state file.
 */
export const DEPLOY_VERDICTS = Object.freeze(['REGRESSION', 'HEALTHY']);

/**
 * The budget vocabulary — one word, and **no word that lifts it**.
 *
 * The asymmetry with {@link DEPLOY_VERDICTS} is deliberate. `lastDeployVerdict`
 * is about the *last* deploy, so a revert-and-redeploy inside the same run
 * genuinely changes the answer and `HEALTHY` names that event. Spend only
 * accumulates: nothing a run does later refunds it, so "un-exhaust" would name
 * no event at all — it would name a decision to keep going, taken by the run
 * that declared the stop. This is the one stop a run could lift on its own
 * authority, which is exactly why it cannot.
 *
 * The escape hatch already exists and is cheaper than a word: a new run gets a
 * new run directory, and therefore a clean state.
 */
export const BUDGET_WORDS = Object.freeze(['EXHAUSTED']);

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

/**
 * What each command writes, and what it refuses first.
 *
 * Two shapes share this table: `deploy` and `budget` take a word from a closed
 * vocabulary, `trigger` takes an item id, which is whatever the tracker calls
 * it — so it validates presence instead of membership (`words: null`). That
 * sentinel leaks into three places below, which is the price of one table over
 * two handlers; a fourth command is where that stops being worth it.
 */
const COMMANDS = Object.freeze({
  deploy: {
    words: DEPLOY_VERDICTS,
    field: 'lastDeployVerdict',
    // The verdict is stored as the word itself: `stopConditionOf` compares it
    // to `'REGRESSION'`, so the value on disk has to be the canonical spelling.
    valueOf: (word) => word,
    missingDir:
      'there is no run to record this verdict against. The run declares it in ' +
      'preflight; a verdict written nowhere would read as a healthy deploy to the ' +
      'next selection.',
  },
  budget: {
    words: BUDGET_WORDS,
    field: 'budgetExhausted',
    valueOf: () => true,
    missingDir:
      'there is no run whose budget this could exhaust. A budget belongs to one ' +
      'run — that is why a new run starts with a clean one.',
  },
  // The one command whose argument is not a vocabulary: an item id is whatever
  // the tracker calls it. So it validates presence rather than membership —
  // `trigger` with nothing after it must refuse rather than fire everything.
  trigger: {
    words: null,
    field: 'triggersFired',
    // Merged, not replaced: the shallow merge in `updateState` would drop the
    // triggers already fired this run, and a second declaration must not
    // silently retract the first.
    valueOf: (id, state) => ({ ...(state.triggersFired ?? {}), [id]: true }),
    missingDir:
      'there is no run for this trigger to be fired in. A declaration belongs to ' +
      'one run, which is what stops it carrying into tomorrow.',
    missingWord:
      'trigger needs the id of the item whose trigger fired. Firing nothing in ' +
      'particular would either do nothing or arm every gated item at once, and ' +
      'both are worse than refusing.',
  },
});

// The CLI the post-deploy step and the budget check call. It exists because both
// values are produced by a judgement taken outside any module — and a stop
// condition nothing can write is the state this whole file was added to end.
//
// 🔴 **Reading is permissive; writing refuses.** `readState` turns an absent or
// corrupt file into `{}` because an absent stop input is a defined state. A
// write has nowhere to go instead, and exiting 0 would tell the operator the
// regression was filed while the next selection hands out work on top of it —
// the one move `autonomy.md` names as never fix-forward.
if (invokedDirectly()) {
  const [command, word] = process.argv.slice(2);
  const runDir = process.env.RIG_RUN_DIR;
  const spec = Object.hasOwn(COMMANDS, String(command)) ? COMMANDS[command] : null;

  if (!spec) {
    const names = Object.entries(COMMANDS).map(
      ([name, { words }]) => `\`${name} <${words ? words.join('|').toLowerCase() : 'item-id'}>\``,
    );
    process.stderr.write(
      `unknown command: ${command ?? '(none)'}. This CLI has ${names.length}: ` +
        `${names.slice(0, -1).join(', ')} and ${names.at(-1)}. Everything else in this ` +
        'module is an import, not a command.\n',
    );
    process.exit(1);
  }
  if (!runDir) {
    process.stderr.write(`RIG_RUN_DIR is not set, so ${spec.missingDir}\n`);
    process.exit(1);
  }

  // Case is normalised rather than refused: a lowercase word is not a typo of
  // meaning, while `REGRESSED` is — it matches nothing in `stopConditionOf` and
  // would sit in the file looking recorded and stopping nothing. An item id is
  // not a vocabulary, so it is taken as given and only checked for presence.
  const given = String(word ?? '');
  if (spec.words) {
    const normalised = given.toUpperCase();
    if (!spec.words.includes(normalised)) {
      process.stderr.write(
        `unknown ${command} word: ${word ?? '(none)'}. It must be one of ` +
          `${spec.words.join(', ')} — the vocabulary the stop conditions compare ` +
          'against. A word outside it would be stored, read back, and match nothing.\n',
      );
      process.exit(1);
    }
  } else if (given === '') {
    process.stderr.write(`${spec.missingWord}\n`);
    process.exit(1);
  }

  const argument = spec.words ? given.toUpperCase() : given;
  const value = spec.valueOf(argument, readState(runDir));
  updateState(runDir, { [spec.field]: value });
  process.stdout.write(`run state: ${spec.field} = ${JSON.stringify(value)}\n`);
}
