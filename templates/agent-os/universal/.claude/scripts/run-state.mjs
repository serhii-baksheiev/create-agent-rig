/**
 * The run's own state — the four values `stopConditionOf` asks for and nothing
 * used to answer.
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
 * into a checkout-wide file, a regression would stop **every future run
 * forever** with nothing that clears it, and two runs sharing a checkout would
 * stop each other on a counter neither of them raised.
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
 * ⚠ **It assumes one writer**, like the journal beside it. The merge is
 * read-then-write with no lock, so two processes sharing a run directory can
 * lose one of their patches. One run directory per run is the caller's part of
 * the contract, and the `loop` skill states it.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * Shallow by design: the fields are flat values plus two small objects
 * (`budget`, `triggersFired`), and a deep merge would make "clear this field"
 * unexpressible — the caller passing `{budget: {...}}` means *this budget now*,
 * not *these keys added to whatever was there*.
 *
 * 🔴 **Write-then-rename, because the reader is another process.** A plain
 * write leaves a window where the file on disk is half a JSON document, and the
 * reader above turns that into `{}` — a silently forgotten escalation streak.
 * A rename within one directory is atomic on every platform this runs on, so a
 * reader sees either the old state or the new one and never a torn one.
 */
export const updateState = (runDir, patch) => {
  const next = { ...readState(runDir), ...patch };
  const file = statePathIn(runDir);
  // The temp name carries the pid so a second writer cannot clobber the first
  // one's half-written file — the merge above is still unsafe under two
  // writers, but a torn read is not how it fails.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
};
