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

/** Zero options at the personal stage: one implicit target (PLAN.md §6). */
export const DEFAULT_TARGET = 'aws-serverless';
