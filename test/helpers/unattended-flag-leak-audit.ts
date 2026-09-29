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
export async function auditFor(
  options: { env?: NodeJS.ProcessEnv; homes?: string[] } = {},
): Promise<() => Promise<void>> {
  const env = options.env ?? process.env;

  if (env.RIG_SCRUB_TEST_CHILD) {
    return async () => {};
  }

  let homes = options.homes;
  if (homes === undefined) {
    const { homesOf } = (await import(pathToFileURL(stopFlagScript).href)) as {
      homesOf: (env?: NodeJS.ProcessEnv) => string[];
    };
    homes = homesOf();
  }

  const snapshot = await snapshotUnattendedFlags(homes);

  return async () => {
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
