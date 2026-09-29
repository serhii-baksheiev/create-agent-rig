import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newUnattendedFlags, snapshotUnattendedFlags } from './unattended-flag-audit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const stopFlagScript = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'stop-flag.mjs',
);

// RP-271: `writeUnattended` (unattended-flag.mjs) mirrors a scoped record into
// every home `stop-flag.mjs`'s `homesOf` names — always including the real
// `userInfo().homedir`, which no fixture `HOME` override can take out of the
// set. A test that arms the flag and then throws before its bare
// `clearUnattended` call leaves a `__PROJECT_NAME__-*-loop-UNATTENDED` file
// sitting in the operator's REAL `~/.claude`. This global setup is the
// run-wide backstop: it snapshots those real homes' flag files once, before
// this project's tests run (`snapshotUnattendedFlags`,
// test/helpers/unattended-flag-audit.ts), and its teardown fails the whole
// run — the same before/after shape test/e2e/pack-once.ts uses for its own
// setup/teardown — when any are new (`newUnattendedFlags`).
//
// `homesOf` is imported from the template tree's own stop-flag.mjs rather
// than re-derived, because it is called with no `env` override — it has to
// read the REAL process.env exactly as unattended-flag.mjs's own mirrored
// write does, and a second hand-copy of that lookup is a second place for the
// two homes to drift apart. This is not the independent-oracle case: `homesOf`
// only says WHERE to look; WHICH filenames count as a leaked flag still comes
// from unattended-flag-audit.ts's own hand-written pattern, never from this
// script's hashing.
//
// ⚠ Known limit, stated rather than papered over (RP-271): the real home is
// shared by every checkout on this machine, and a leaked-flag record
// (`{"item","runDir","allow"}`) carries no field that names the process or
// checkout that wrote it — two concurrent runs of this same suite write the
// identical literal `item`/`runDir` strings from queue-board.test.ts, so
// there is no content-based oracle here that can tell "this run's leak" apart
// from "another concurrent run's flag, armed and not yet cleared, that will
// still clear itself before that run's own teardown". A flag this teardown
// reports is therefore proof that ONE run leaked one — read the path and the
// JSON it names before assuming it was this run when several are in flight on
// one machine.
//
// RP-288 (Jira comment 21563, failure-diagnostician finding): the above
// "will still clear itself" case was not actually tolerated — a peer run's
// SCOPED arm mirrors into the real home the moment it is written, and this
// audit's first check could observe it before the peer's own clear ran,
// reporting a flag that was never actually leaked. Measured: a flag-free run
// failed the audit in 4 of 121 runs, beside a peer suite that armed and
// correctly cleared its own flag in that window. Teardown now RE-CHECKS a
// candidate once more after `recheckWindowMs` (default ~35 s — the `doctor`
// guard batch this repo runs can itself take up to a 30 s timeout, so the
// window has to outlast that) before reporting it; only a candidate still
// present at the SECOND check is thrown on. ⚠ This shifts, rather than
// removes, the known limit above: a PEER flag held longer than the recheck
// window is still reported as if it were this run's own leak — the window
// is a bound on how long a legitimate concurrent arm may plausibly last, not
// a guarantee that every non-leak is distinguishable from a slow peer.
//
// RP-296: `test/template/rig-run-dir-scrub.test.ts` › "holds with the
// variable exported around the whole vitest process" spawns a NESTED vitest
// (env `RIG_SCRUB_TEST_CHILD=1`) reusing this repo's own vitest.config.ts, so
// the nested run also executes this same global setup. That nested teardown
// would snapshot the real homes at nested-setup time and compare again at
// nested-teardown time — but the same real homes are shared with every OTHER
// test file of the same outer `pnpm test`, several of which legitimately arm
// and clear the flag while the nested child is alive, so the nested
// snapshot/teardown pair races the outer run's own tests and can report a
// leak that is not its own. The marker means "this is the nested child" — it
// skips the audit entirely, because the outer run's own (unmarked) audit
// already owns anything this child could leak. See
// `unattended-flag-leak-audit-nested.test.ts` › "the nested RIG_SCRUB_TEST_CHILD
// marker suppresses the RP-271 leak audit".
/**
 * The recheck window's default, in ms (RP-288): long enough to outlast a
 * legitimate peer's scoped arm/clear, including the `doctor` guard batch's
 * own up-to-30s timeout — see the header comment above for the measurement
 * behind the choice.
 */
const DEFAULT_RECHECK_WINDOW_MS = 35_000;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function auditFor(
  options: {
    env?: NodeJS.ProcessEnv;
    homes?: string[];
    recheckWindowMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<() => Promise<void>> {
  const env = options.env ?? process.env;

  if (env.RIG_SCRUB_TEST_CHILD === '1') {
    return async () => {};
  }

  let homes = options.homes;
  if (homes === undefined) {
    const { homesOf } = (await import(pathToFileURL(stopFlagScript).href)) as {
      homesOf: (env?: NodeJS.ProcessEnv) => string[];
    };
    homes = homesOf();
  }

  const recheckWindowMs = options.recheckWindowMs ?? DEFAULT_RECHECK_WINDOW_MS;
  const sleep = options.sleep ?? realSleep;

  const snapshot = await snapshotUnattendedFlags(homes);

  return async () => {
    const firstCheck = await newUnattendedFlags(snapshot);
    if (firstCheck.length === 0) return;

    // RP-288: a candidate seen once is not yet a leak — a peer run's scoped
    // arm can be mid-flight. Wait out the recheck window and look again at
    // the SAME snapshot before reporting anything.
    await sleep(recheckWindowMs);
    const leaked = await newUnattendedFlags(snapshot);
    if (leaked.length === 0) return;
    throw new Error(
      `RP-271: ${leaked.length} unattended flag(s) leaked into a real home during this run:\n` +
        leaked.map((p) => `  ${p}`).join('\n') +
        '\n\nA test armed the unattended flag (writeUnattended) and did not clear it on every ' +
        'path — the mirrored write always reaches the real home, never only a fixture HOME ' +
        'override (homesOf, stop-flag.mjs). Wrap the arm/act/clear sequence in try/finally.',
    );
  };
}

export default function setup(): Promise<() => Promise<void>> {
  return auditFor();
}
