/**
 * Target registry. A target is a coherent, self-contained skeleton — never a
 * parameterized abstraction (PLAN.md §2). New target = new directory + one entry here.
 */
export interface Target {
  /** Directory name under `templates/skeleton/`. */
  skeletonDir: string;
  /** Default region substituted for `__REGION__` (only meaningful for cloud targets). */
  defaultRegion: string;
}

export const TARGETS: Record<string, Target> = {
  'aws-serverless': {
    skeletonDir: 'aws-serverless',
    defaultRegion: 'eu-central-1',
  },
};

/** Zero options at the personal stage: one implicit target (PLAN.md §6). */
export const DEFAULT_TARGET = 'aws-serverless';
