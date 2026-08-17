/**
 * How many times a branch has entered the review gate.
 *
 * 🔴 **Its own file, and that is the whole design.** The item that asked for this
 * named `queue.state.json` — the file holding `lastCompletedTier` — as the place to
 * put the count. A review round measured what that costs: `recordCompletedTier`
 * writes that file whole, so either the two writers merge or the first close of any
 * item deletes the round count of every branch still in gate. Merging was
 * implemented, and then it turned out to be worse: a state file that fails to parse
 * reads as `{}` to a merging writer, which then writes its snapshot back and the
 * tier is **silently gone** — and a missing tier is the permissive value that lets a
 * second elevated item straight through. A lost round costs one extra review; a lost
 * tier disables the ration the queue is spaced by.
 *
 * Two files, one writer each. The counter cannot damage the ration and `state.mjs`
 * goes back to owning its file outright — so a lost round is now the worst this
 * mechanism can do, where before it could lose the tier.
 *
 * ⚠ **What that does NOT fix, measured rather than reasoned:** `recordGateRound` is
 * read-modify-write with no lock. Eight concurrent calls on one counter recorded
 * **four** rounds — the file is shared across every worktree of a repo by design
 * (`gateRoundsPathFor`), so this is reachable whenever two loops run in one
 * repository at once, not only in one directory. Each lost increment buys one extra
 * allowed round. A lock is not worth it for that: the loop is sequential per task,
 * and the failure is bounded and in the generous direction. What was worth fixing is
 * the crash it came with — a fixed temp filename made the losers of that race fail
 * with `ENOENT` on rename, reporting "could not run" for a condition nothing named.
 */

import { renameSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mainCheckoutRoot } from './checkout.mjs';

/**
 * Where the counter lives, unless a caller names the file.
 *
 * The default lands in the MAIN checkout even when the gate runs inside a worktree
 * — the same rule `state.mjs` follows, and for the same reason: a task's worktree is
 * shorter-lived than the task.
 */
export const gateRoundsPathFor = (projectRoot) =>
  join(mainCheckoutRoot(projectRoot), '.claude', 'gate-rounds.json');

/**
 * The counts, keyed by branch.
 *
 * An absent file is zero rounds — the normal state of a fresh checkout. A file that
 * exists and does not parse is **refused**, not read as zero: reading it as zero
 * hands the branch a full cap again, and it does so at the exact moment something is
 * already wrong with the file.
 */
const readRounds = (file) => {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return Object.create(null);
    throw new Error(
      `${file} exists but could not be read (${error?.code ?? 'unknown error'}), so the ` +
        'gate rounds for this branch are unknown. Refusing rather than starting the ' +
        'count again, which would hand this branch a full cap.',
      { cause: error },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON, so the gate rounds cannot be read: ` +
        `${String(error?.message ?? error).split('\n')[0]}. Delete the file to start ` +
        'the count over — deliberately, rather than by accident.',
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${file} is valid JSON but not an object of branch counts, so the gate rounds ` +
        'cannot be read. Expected `{ "<branch>": <positive integer> }`. Delete the ' +
        'file to start the count over.',
    );
  }

  // A single malformed entry is dropped rather than refused: one bad key costs that
  // branch a fresh cap, while refusing would block every branch in the checkout.
  //
  // 🔴 `Object.create(null)`, not `{}`. A branch named `__proto__` or `constructor`
  // otherwise resolves to an inherited value rather than a count, so the increment
  // produced `"[object Object]1"` — a string, which every numeric comparison against
  // the cap answers `false`, i.e. unlimited rounds. Absurd branch name, real class of
  // defect, and the failure was silent.
  const clean = Object.create(null);
  for (const [branch, count] of Object.entries(parsed)) {
    if (Number.isInteger(count) && count > 0) clean[branch] = count;
  }
  return clean;
};

/**
 * The branch a count belongs to.
 *
 * 🔴 `HEAD` is refused, and it is the case this check exists for. On a detached
 * checkout — mid-rebase, after `gh pr checkout` of a fork, in CI —
 * `git rev-parse --abbrev-ref HEAD` prints the literal string `HEAD`, which is a
 * non-empty string and would key one shared counter for every task in the
 * directory. A review round found exactly that hole under a comment claiming it was
 * closed.
 */
const requireBranch = (branch) => {
  if (typeof branch !== 'string' || branch.trim() === '') {
    throw new Error(
      `a gate round is counted per branch, and the branch was ${JSON.stringify(branch)}.`,
    );
  }
  if (branch.trim() === 'HEAD') {
    throw new Error(
      'the branch is the literal "HEAD", which is what a detached checkout reports. ' +
        'Counting under it would share one budget across every task in this ' +
        'directory. Check out the branch under review, or pass its name explicitly.',
    );
  }
  return branch.trim();
};

/** How many rounds this branch has recorded. Zero when the file is absent. */
export const gateRoundsFor = ({ branch, projectRoot, roundsPath } = {}) =>
  readRounds(roundsPath ?? gateRoundsPathFor(projectRoot))[requireBranch(branch)] ?? 0;

/**
 * Count one round for this branch and return the new total.
 *
 * Write-then-rename, because a plain write leaves a window where the file on disk is
 * half a JSON document — and the reader above refuses such a file, which would turn
 * a crash mid-write into a gate nobody can run. `run-state.mjs` reached the same
 * conclusion about the same class of file.
 *
 * The temp name carries the pid. A fixed `${file}.tmp` was measured failing: under
 * concurrent calls the first rename consumed the shared temp file and the rest died
 * with `ENOENT` on rename, which this command reports as "could not run" — a
 * diagnosis for a cause nothing named. Per-pid temps make a concurrent loser lose
 * only its increment, which is the bounded failure the docblock above states.
 */
export const recordGateRound = ({ branch, projectRoot, roundsPath } = {}) => {
  const key = requireBranch(branch);
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  const rounds = readRounds(file);
  const next = (rounds[key] ?? 0) + 1;

  // Spread into a null-prototype object for the same reason `readRounds` builds one:
  // `{ ...rounds }` would give the result a prototype again, and `JSON.stringify`
  // then writes a `__proto__` key that the next read cannot see as its own.
  const updated = Object.assign(Object.create(null), rounds, { [key]: next });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(updated, null, 2)}\n`);
  renameSync(temp, file);

  return { rounds: next };
};
