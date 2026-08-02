/**
 * Target registry. A target is a coherent, self-contained skeleton — never a
 * parameterized abstraction (PLAN.md §2). New target = new directory + one entry here.
 */
export interface Target {
  /** Directory name under `templates/skeleton/`. */
  skeletonDir: string;
  /**
   * agent-os stack layers composed on top of `universal`, in order
   * (directories under `templates/agent-os/stack/`).
   */
  stacks: readonly string[];
  /** Default region substituted for `__REGION__` (cloud targets only). */
  defaultRegion?: string;
}

export const TARGETS: Record<string, Target> = {
  'aws-serverless': {
    skeletonDir: 'aws-serverless',
    stacks: ['node-ts', 'aws-cdk'],
    defaultRegion: 'eu-central-1',
  },
  'node-service': {
    skeletonDir: 'node-service',
    stacks: ['node-ts'],
  },
};

export const TARGET_NAMES = Object.keys(TARGETS);

/**
 * The pre-selected entry in the interactive menu, and the API-level default.
 *
 * 🔴 **Not the fallback for a non-interactive run.** A run with no TTY and no
 * `--target` is *refused* (`index.ts`) — never prompt into a pipe, and never
 * guess a whole project shape for a script that did not say. This constant is
 * what `Enter`, an out-of-range number or an unrecognised name resolve to at the
 * prompt (`prompts.ts`), plus what `createProject` uses when called as a library
 * with no target.
 *
 * The comment this replaces said "one implicit target", which was stale from
 * when there was one. Its first correction claimed the CLI defaults silently in
 * CI — the opposite of what it does, in the file a maintainer would open to
 * check exactly that.
 */
export const DEFAULT_TARGET = 'aws-serverless';
