/**
 * Per-branch review budget: retained legacy counts and evidence-bound fan-outs.
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
 * Evidence-backed writes take a short exclusive counter lock. That makes the receipt
 * and increment one operation: two processes cannot both consume the final slot or
 * the same fan-out. Pinned by the generator's
 * `test/template/gate-round-evidence.test.ts` (absent in a generated rig) ›
 * "lets only one concurrent distinct fan-out spend the final base-cap slot" and ›
 * "records concurrent attempts to consume the same fan-out exactly once".
 * `recordGateRound` remains deliberately unlocked for direct legacy callers, so
 * mixed legacy writers retain the pre-existing lost-increment race, pinned by
 * `test/template/concurrent-sessions.test.ts` (absent in a generated rig) ›
 * "eight concurrent recordGateRound calls all exit 0 and leave one parseable counter between one and eight".
 *
 * ⚠ **And a second crash, Windows-only, measured on the same race (RP-120):** a
 * rename over a file another process holds open is refused there with `EPERM`, for
 * exactly as long as the handle is open — a reader's `readFileSync` is enough. Eight
 * racing callers lost one to it in four rounds of thirty, and each loser left its
 * temp file behind. So the rename is retried within a fixed budget
 * (`RENAME_BUDGET_MS`: the pauses between attempts never exceed it; the rename
 * calls themselves add their own wall time), and a loser that still cannot rename
 * removes its temp file and reports the code and the file rather than a bare
 * `EPERM`. That is a bounded retry, not a lock: the count can still lose an
 * increment, and nothing waits on a holder past the budget. Pinned by the
 * generator's `test/template/gate-rounds.test.ts` (absent in a generated rig) ›
 * "retries the rename while another process holds the counter open, and still counts the round"
 * and › "gives up past its budget, removes its temp file, keeps the old count, and names the code and the file".
 */

import { closeSync, openSync, renameSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// Git ref names cannot contain NUL, so numeric receipt entries under this prefix
// cannot collide with a CLI branch and survive older numeric-only writers.
const RECEIPTS_KEY = '\u0000rig:gate-round-evidence';
const RECEIPT_PREFIX = `${RECEIPTS_KEY}:`;
const RESERVATION_PREFIX = '\u0000rig:gate-round-reservation:';
const COMPLETED_RESERVATION_PREFIX = '\u0000rig:gate-round-reservation-completed:';
const RELEASED_RESERVATION_PREFIX = '\u0000rig:gate-round-reservation-released:';

const receiptKeyFor = (branch, identity) => `${RECEIPT_PREFIX}${JSON.stringify([branch, identity])}`;

const receiptFromKey = (key) => {
  if (!key.startsWith(RECEIPT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(key.slice(RECEIPT_PREFIX.length));
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const reservationKeyFor = (reservation) => `${RESERVATION_PREFIX}${JSON.stringify(reservation)}`;

const releasedReservationKeyFor = (reservation) =>
  `${RELEASED_RESERVATION_PREFIX}${JSON.stringify(reservation)}`;

const reservationFromKey = (key) => {
  if (!key.startsWith(RESERVATION_PREFIX)) return null;
  try {
    const reservation = JSON.parse(key.slice(RESERVATION_PREFIX.length));
    return Array.isArray(reservation) && reservation.length === 7 &&
      reservation.every((value, index) =>
        index === 3
          ? Number.isInteger(value) && value >= 0
          : index === 5 || index === 6
            ? value === null || typeof value === 'string'
            : typeof value === 'string' && value !== '',
      )
      ? {
          branch: reservation[0],
          head: reservation[1],
          runDir: reservation[2],
          seqFloor: reservation[3],
          token: reservation[4],
          ticket: reservation[5],
          authorizationHead: reservation[6],
        }
      : null;
  } catch {
    return null;
  }
};

const releasedReservationFromKey = (key) => {
  if (!key.startsWith(RELEASED_RESERVATION_PREFIX)) return null;
  return reservationFromKey(`${RESERVATION_PREFIX}${key.slice(RELEASED_RESERVATION_PREFIX.length)}`);
};

const completedReservationKeyFor = (reservation) =>
  `${COMPLETED_RESERVATION_PREFIX}${JSON.stringify(reservation)}`;

const completedReservationFromKey = (key) => {
  if (!key.startsWith(COMPLETED_RESERVATION_PREFIX)) return null;
  try {
    const reservation = JSON.parse(key.slice(COMPLETED_RESERVATION_PREFIX.length));
    return Array.isArray(reservation) && reservation.length === 8 &&
      reservation.every((value, index) =>
        index === 3 || index === 7
          ? Number.isInteger(value) && value >= (index === 3 ? 0 : 1)
          : index === 5 || index === 6
            ? value === null || typeof value === 'string'
            : typeof value === 'string' && value !== '',
      )
      ? {
          branch: reservation[0], head: reservation[1], runDir: reservation[2],
          seqFloor: reservation[3], token: reservation[4], ticket: reservation[5],
          authorizationHead: reservation[6], fanOuts: reservation[7],
        }
      : null;
  } catch {
    return null;
  }
};

const readRoundState = (file) => {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return {
        rounds: Object.create(null), receipts: Object.create(null), reservations: [],
        completedReservations: [], releasedReservations: [],
      };
    }
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
  const receipts = Object.create(null);
  const reservations = [];
  const completedReservations = [];
  const releasedReservations = [];
  for (const [branch, count] of Object.entries(parsed)) {
    if (branch.startsWith(COMPLETED_RESERVATION_PREFIX)) {
      const reservation = completedReservationFromKey(branch);
      if (reservation === null || count !== 1) {
        throw new Error(`${file} has invalid completed gate-round reservations, so replay safety cannot be trusted.`);
      }
      clean[branch] = count;
      completedReservations.push({ ...reservation, key: branch });
      continue;
    }
    if (branch.startsWith(RESERVATION_PREFIX)) {
      const reservation = reservationFromKey(branch);
      if (reservation === null || count !== 1) {
        throw new Error(`${file} has invalid gate-round reservations, so the available budget cannot be trusted.`);
      }
      clean[branch] = count;
      reservations.push({ ...reservation, key: branch });
      continue;
    }
    if (branch.startsWith(RELEASED_RESERVATION_PREFIX)) {
      const reservation = releasedReservationFromKey(branch);
      if (reservation === null || count !== 1) {
        throw new Error(`${file} has invalid released gate-round reservations, so late evidence cannot be admitted safely.`);
      }
      clean[branch] = count;
      releasedReservations.push({ ...reservation, key: branch });
      continue;
    }
    if (branch.startsWith(RECEIPT_PREFIX)) {
      const receipt = receiptFromKey(branch);
      if (receipt === null || count !== 1) {
        throw new Error(
          `${file} has invalid gate-round evidence receipts, so duplicate evidence cannot be detected.`,
        );
      }
      clean[branch] = count;
      const [receiptBranch, identity] = receipt;
      receipts[receiptBranch] = [...(receipts[receiptBranch] ?? []), identity];
      continue;
    }
    if (!Number.isInteger(count) || count <= 0) continue;
    clean[branch] = count;
  }
  const stored = parsed[RECEIPTS_KEY];
  if (stored !== undefined) {
    throw new Error(
      `${file} has unsupported gate-round evidence receipts, so duplicate evidence cannot be detected.`,
    );
  }
  return { rounds: clean, receipts, reservations, completedReservations, releasedReservations };
};

const readRounds = (file) => readRoundState(file).rounds;

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

/** Whether this branch already consumed one durable reviewer-fan-out record. */
export const gateRoundEvidenceRecorded = ({ branch, projectRoot, roundsPath, evidenceIdentity } = {}) => {
  if (typeof evidenceIdentity !== 'string' || evidenceIdentity === '') return false;
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  return (readRoundState(file).receipts[requireBranch(branch)] ?? []).includes(evidenceIdentity);
};

export const gateRoundReservationFor = ({ branch, projectRoot, roundsPath, token } = {}) => {
  if (typeof token !== 'string' || token === '') return null;
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  const key = requireBranch(branch);
  return readRoundState(file).reservations.find(
    (reservation) => reservation.branch === key && reservation.token === token,
  ) ?? null;
};

export const completedGateRoundReservationFor = ({ branch, projectRoot, roundsPath, token } = {}) => {
  if (typeof token !== 'string' || token === '') return null;
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  const key = requireBranch(branch);
  return readRoundState(file).completedReservations.find(
    (reservation) => reservation.branch === key && reservation.token === token,
  ) ?? null;
};

const writeRoundState = (file, rounds) => {
  const updated = Object.assign(Object.create(null), rounds);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(updated, null, 2)}\n`);
  replaceWithRetry(temp, file);
};

const COUNTER_LOCK_ATTEMPTS = 200;
const COUNTER_LOCK_BACKOFF_MS = 10;

const withCounterLock = (file, work) => {
  const lock = `${file}.lock`;
  let held = false;
  for (let attempt = 1; attempt <= COUNTER_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx');
      closeSync(fd);
      held = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt < COUNTER_LOCK_ATTEMPTS) pause(COUNTER_LOCK_BACKOFF_MS);
    }
  }
  if (!held) throw new Error(`${lock} remained held while recording a gate round; nothing was counted.`);
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
};

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
  const { rounds } = readRoundState(file);
  const next = (rounds[key] ?? 0) + 1;
  rounds[key] = next;
  writeRoundState(file, rounds);

  return { rounds: next };
};

/** Count one durable reviewer-fan-out decision at most once. */
export const recordEvidenceGateRound = ({
  branch,
  projectRoot,
  roundsPath,
  evidenceIdentity,
  max,
} = {}) => {
  const key = requireBranch(branch);
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  if (typeof evidenceIdentity !== 'string' || evidenceIdentity === '') {
    throw new Error('a gate-round evidence identity is required before a round can be counted.');
  }
  return withCounterLock(file, () => {
    const { rounds, receipts } = readRoundState(file);
    const spent = rounds[key] ?? 0;
    const seen = receipts[key] ?? [];
    if (seen.includes(evidenceIdentity)) return { rounds: spent, recorded: false };
    if (Number.isInteger(max) && spent >= max) {
      return { rounds: spent + 1, spent, recorded: false, exhausted: true };
    }
    const next = spent + 1;
    rounds[key] = next;
    rounds[receiptKeyFor(key, evidenceIdentity)] = 1;
    writeRoundState(file, rounds);
    return { rounds: next, recorded: true };
  });
};

export const reconcileEvidenceGateRounds = ({
  branch,
  projectRoot,
  roundsPath,
  evidenceIdentities,
} = {}) => {
  const key = requireBranch(branch);
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  return withCounterLock(file, () => {
    const { rounds, receipts } = readRoundState(file);
    const seen = receipts[key] ?? [];
    const unrecorded = evidenceIdentities.filter((identity) => !seen.includes(identity));
    if (unrecorded.length === 0) return { rounds: rounds[key] ?? 0, recorded: 0 };
    const spent = rounds[key] ?? 0;
    // Numeric-only writers predate evidence receipts. Once such a count and an
    // unreceipted historic fan-out meet, there is no durable way to tell whether
    // the event is the round already in `spent` or a later one. Refuse before
    // mutation rather than silently recounting it.
    // See test/template/gate-round-evidence.test.ts (absent in a generated rig):
    // "refuses ambiguous numeric-only legacy reconciliation without recounting its tokenless fan-out".
    // Pinned by `test/template/gate-round-evidence.test.ts` › "refuses ambiguous
    // numeric-only legacy reconciliation without recounting its tokenless fan-out".
    if (spent !== seen.length) {
      throw new Error(
        'legacy numeric-only gate-round state cannot be reconciled with unreceipted reviewer fan-out evidence: the association is ambiguous.',
      );
    }
    const next = spent + unrecorded.length;
    rounds[key] = next;
    for (const identity of unrecorded) rounds[receiptKeyFor(key, identity)] = 1;
    writeRoundState(file, rounds);
    return { rounds: next, recorded: unrecorded.length };
  });
};

export const reserveGateRound = ({
  branch,
  projectRoot,
  roundsPath,
  reservation,
  max,
  hasUnaccountedEvidence,
  withEvidenceLock,
  afterPersist,
} = {}) => {
  const key = requireBranch(branch);
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  const reservationKey = reservationKeyFor([
    reservation?.branch,
    reservation?.head,
    reservation?.runDir,
    reservation?.seqFloor,
    reservation?.token,
    reservation?.ticket ?? null,
    reservation?.authorizationHead ?? null,
  ]);
  if (reservationFromKey(reservationKey) === null || reservation.branch !== key) {
    throw new Error('the gate-round reservation has invalid binding data.');
  }
  return withCounterLock(file, () => {
    const { rounds, receipts, reservations, completedReservations, releasedReservations } = readRoundState(file);
    const spent = rounds[key] ?? 0;
    const sameRun = reservations.find(
      (existing) =>
        existing.branch === key &&
        existing.runDir === reservation.runDir &&
        existing.head === reservation.head,
    );
    if (sameRun) return { reserved: false, pending: true, reservation: sameRun, spent };
    const authorizationUsed =
      reservation.ticket !== null &&
      (reservations.some(
          (existing) =>
            existing.branch === key &&
            existing.ticket === reservation.ticket &&
            existing.authorizationHead === reservation.authorizationHead,
        ) ||
        completedReservations.some(
          (existing) =>
            existing.branch === key &&
            existing.ticket === reservation.ticket &&
            existing.authorizationHead === reservation.authorizationHead,
        ));
    if (authorizationUsed) return { reserved: false, authorizationUsed: true, spent };
    const transition = () => {
      if (hasUnaccountedEvidence?.({ receipts, reservations, completedReservations, releasedReservations })) {
        return { reserved: false, pendingEvidence: true, spent };
      }
      const held = reservations.filter((existing) => existing.branch === key).length;
      if (Number.isInteger(max) && spent + held >= max) {
        return { reserved: false, exhausted: true, spent, held };
      }
      rounds[reservationKey] = 1;
      writeRoundState(file, rounds);
      let postPersist;
      try {
        postPersist = afterPersist?.();
      } catch (error) {
        delete rounds[reservationKey];
        writeRoundState(file, rounds);
        throw error;
      }
      if (postPersist?.refused) {
        delete rounds[reservationKey];
        writeRoundState(file, rounds);
        return { reserved: false, authorizationRefused: true, why: postPersist.why, spent, held };
      }
      return { reserved: true, reservation, spent, held };
    };
    return withEvidenceLock
      ? withEvidenceLock({ reservations, completedReservations, releasedReservations }, transition)
      : transition();
  });
};

export const consumeReservedEvidenceGateRound = ({
  branch,
  projectRoot,
  roundsPath,
  token,
  evidenceIdentities,
  evidenceForReservation,
  withEvidenceLock,
} = {}) => {
  const key = requireBranch(branch);
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  return withCounterLock(file, () => {
    const { rounds, receipts, reservations, completedReservations, releasedReservations } = readRoundState(file);
    const reservation = reservations.find((existing) => existing.branch === key && existing.token === token);
    if (!reservation) {
      const completed = completedReservations.find((existing) => existing.branch === key && existing.token === token);
      if (completed) {
        const transition = () => {
          const identities = evidenceForReservation ? evidenceForReservation(completed) : evidenceIdentities;
          const seen = receipts[key] ?? [];
          const unrecorded = identities.filter((identity) => !seen.includes(identity));
          if (unrecorded.length === 0) return { rounds: rounds[key] ?? 0, completed, recorded: 0 };
          const next = (rounds[key] ?? 0) + unrecorded.length;
          rounds[key] = next;
          for (const identity of unrecorded) rounds[receiptKeyFor(key, identity)] = 1;
          delete rounds[completed.key];
          const updated = { ...completed, fanOuts: completed.fanOuts + unrecorded.length };
          rounds[completedReservationKeyFor([
            updated.branch,
            updated.head,
            updated.runDir,
            updated.seqFloor,
            updated.token,
            updated.ticket,
            updated.authorizationHead,
            updated.fanOuts,
          ])] = 1;
          writeRoundState(file, rounds);
          return { rounds: next, completed: updated, recorded: unrecorded.length };
        };
        return withEvidenceLock ? withEvidenceLock(completed, transition) : transition();
      }
      const released = releasedReservations.find((existing) => existing.branch === key && existing.token === token);
      if (released) {
        const transition = () => {
          const identities = evidenceForReservation ? evidenceForReservation(released) : evidenceIdentities;
          if (!Array.isArray(identities) || identities.length === 0) {
            throw new Error('the released gate-round reservation has no matching post-release reviewer fan-out evidence.');
          }
          const seen = receipts[key] ?? [];
          const unrecorded = identities.filter((identity) => !seen.includes(identity));
          const next = (rounds[key] ?? 0) + unrecorded.length;
          if (unrecorded.length > 0) {
            rounds[key] = next;
            for (const identity of unrecorded) rounds[receiptKeyFor(key, identity)] = 1;
            writeRoundState(file, rounds);
          }
          return { rounds: next, released: true, fanOuts: identities.length, recorded: unrecorded.length };
        };
        return withEvidenceLock ? withEvidenceLock(released, transition) : transition();
      }
      throw new Error('the gate-round reservation is no longer active.');
    }
    const transition = () => {
      const identities = evidenceForReservation ? evidenceForReservation(reservation) : evidenceIdentities;
      if (!Array.isArray(identities) || identities.length === 0) {
        throw new Error('the gate-round reservation has no matching post-reservation reviewer fan-out evidence.');
      }
      const next = (rounds[key] ?? 0) + identities.length;
      rounds[key] = next;
      for (const evidenceIdentity of identities) {
        rounds[receiptKeyFor(key, evidenceIdentity)] = 1;
      }
      delete rounds[reservation.key];
      rounds[completedReservationKeyFor([
        reservation.branch,
        reservation.head,
        reservation.runDir,
        reservation.seqFloor,
        reservation.token,
        reservation.ticket,
        reservation.authorizationHead,
        identities.length,
      ])] = 1;
      writeRoundState(file, rounds);
      return { rounds: next, completed: null };
    };
    return withEvidenceLock ? withEvidenceLock(reservation, transition) : transition();
  });
};

export const releaseGateRoundReservation = ({
  branch,
  projectRoot,
  roundsPath,
  token,
  hasEvidenceForReservation,
  withEvidenceLock,
} = {}) => {
  const key = requireBranch(branch);
  const file = roundsPath ?? gateRoundsPathFor(projectRoot);
  return withCounterLock(file, () => {
    const { rounds, reservations } = readRoundState(file);
    const reservation = reservations.find((existing) => existing.branch === key && existing.token === token);
    if (!reservation) throw new Error('the gate-round reservation is no longer active.');
    const transition = () => {
      if (hasEvidenceForReservation?.(reservation)) {
        return { released: false, pendingEvidence: true };
      }
      delete rounds[reservation.key];
      rounds[releasedReservationKeyFor([
        reservation.branch,
        reservation.head,
        reservation.runDir,
        reservation.seqFloor,
        reservation.token,
        reservation.ticket,
        reservation.authorizationHead,
      ])] = 1;
      writeRoundState(file, rounds);
      return { released: true };
    };
    return withEvidenceLock ? withEvidenceLock(reservation, transition) : transition();
  });
};

// How many times the rename is tried, and how long each retry waits.
const RENAME_ATTEMPTS = 20;
const RENAME_BACKOFF_MS = 10;
/** The whole budget a caller can spend pausing on a held-open counter. */
export const RENAME_BUDGET_MS = RENAME_ATTEMPTS * RENAME_BACKOFF_MS;

const RETRIED_CODES = new Set(['EPERM', 'EBUSY']);

// A synchronous pause: this module is synchronous end to end (the CLI counts a round
// and exits), and `Atomics.wait` on a throwaway buffer is the one sleep that shape
// allows without a spin.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Rename `temp` over `file`, retrying a Windows-style refusal within the budget.
 *
 * Every attempt past the last, and every failure of another kind, ends the same way:
 * the temp file is removed so the counter's directory holds nothing but the counter,
 * and the error names the file and the code — the CLI prints that as "could not run",
 * which pr-ship reads as a command failure to retry, not as an exhausted cap.
 */
const replaceWithRetry = (temp, file) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      const code = error?.code ?? 'unknown error';
      if (RETRIED_CODES.has(code) && attempt < RENAME_ATTEMPTS) {
        pause(RENAME_BACKOFF_MS);
        continue;
      }
      // The cleanup must not displace the diagnosis: a temp file that cannot be
      // removed (held open too, on Windows) is reported beside the rename
      // failure, and the rename failure stays the error the caller sees.
      let cleanup = 'and the temp file was removed';
      try {
        rmSync(temp, { force: true });
      } catch (removal) {
        cleanup = `but the temp file ${temp} could not be removed (${removal?.code ?? 'unknown error'})`;
      }
      throw new Error(
        `${file} could not be replaced after ${attempt} attempt${attempt === 1 ? '' : 's'} ` +
          `(${code}): another process may be holding it open. The round was NOT counted ` +
          `${cleanup}; run the command again.`,
        { cause: error },
      );
    }
  }
};
