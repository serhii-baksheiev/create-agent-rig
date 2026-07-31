// The kill switch — one implementation, imported by everything that reads it.
//
// It lived in two places once: `guard-bash.mjs` (the hook that enforces it) and
// `preflight.mjs` (the check that reports it before a run starts). The hole was
// fixed in the hook and left open in preflight for a whole review cycle, which is
// the argument for this file existing at all — a brake with two implementations
// has two chances to be wrong, and the one nobody is looking at is the one that is.
//
// 🔴 The env variable may only ADD a brake, never remove one.
//
// `AGENT_LOOP_STOP` used to REPLACE the machine-level path, so any value naming a
// file that does not exist turned the brake off while the operator's real flag sat
// untouched in their home directory. An override that can disarm a brake is not an
// override, it is a bypass — and it was reachable from `.claude/settings.json`,
// which hooks inherit.
//
// Machine-level, not repo-level, on purpose: a git worktree is its own project
// root, so a flag dropped in the main checkout would be invisible to a session
// running inside one. A brake that is silently absent is worse than no brake.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Every path that arms the brake. The machine-level default is always first. */
export const stopFlags = (env = process.env) => {
  const paths = [join(homedir(), '.claude', 'create-agent-rig-loop-STOP')];
  const extra = env.AGENT_LOOP_STOP;
  if (extra) {
    // The raw value first, so a path containing the platform delimiter still
    // arms; then the split, so a list works too.
    paths.push(extra, ...extra.split(delimiter));
  }
  return [...new Set(paths.filter(Boolean))];
};

/** The armed flag file, or null. */
export const brakeIsOn = (env = process.env) =>
  stopFlags(env).find((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }) ?? null;
