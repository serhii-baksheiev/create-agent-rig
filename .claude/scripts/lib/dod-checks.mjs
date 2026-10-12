// dod-checks.mjs — which `.claude/hooks/dod-checks.json` entries gate-stop-dod
// runs as commands. One implementation, read by the hook that runs them and by
// doctor, which reports whether the gate has anything to run (RP-423).
//
// The predicate is exactly the three shapes `spawnSync` throws on, and no
// wider: the shell answers every other unrunnable string with 127, which is a
// verdict. Filtering past these three converts a real block into a skip.

/** Whether gate-stop-dod runs this dod-checks.json entry as a command. */
export const isRunnableDodEntry = (command) =>
  typeof command === 'string' && command !== '' && !command.includes('\0');
