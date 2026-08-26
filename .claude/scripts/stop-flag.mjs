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
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * BOTH homes, env-derived first: `$HOME` (what `.claude/settings.json` can set —
 * pointing it at an empty directory once disarmed the brake) and the password
 * database's, which ignores the environment, so the operator's real flag is
 * always among the paths checked. Shared with the unattended flag (AR-51): one
 * lookup, one place to be wrong.
 */
export const homesOf = (env = process.env) => {
  const homes = new Set([env.HOME || homedir()]);
  try {
    homes.add(userInfo().homedir);
  } catch {
    // no password entry — the env-derived home is all there is
  }
  return [...homes];
};

/** Every path that arms the brake. The machine-level default is always first. */
export const stopFlags = (env = process.env) => {
  const paths = homesOf(env).map((home) => join(home, '.claude', 'create-agent-rig-loop-STOP'));
  const extra = env.AGENT_LOOP_STOP;
  if (extra) {
    // Filtered and CAPPED before the spread, never after. Spreading an
    // input-derived array is unbounded: 115k empty entries from `':'.repeat(…)`
    // overflowed the argument limit, and the RangeError was swallowed into
    // "allow" by the hook's fail-open catch — disarming every rule while the
    // brake was armed. Bounded work is not a performance concern here, it is the
    // security property.
    const extras = extra
      .split(delimiter)
      .filter(Boolean)
      .slice(0, 32);
    paths.push(extra, ...extras);
  }
  return [...new Set(paths)].slice(0, 64);
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
