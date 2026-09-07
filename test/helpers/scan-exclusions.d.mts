// Types for the plain-JavaScript helper beside it (RP-155): the module stays
// .mjs so the root eslint.config.mjs can import it before any build exists,
// and the TypeScript tests import it statically through this declaration.
export const SKIPPED_DIRECTORY_NAMES: readonly string[];
export const SKIPPED_REPOSITORY_PATHS: readonly string[];
export const SCAN_IGNORE_GLOBS: readonly string[];
export function skipsScan(repoRoot: string, absolutePath: string): boolean;
export function filesBelow(
  repoRoot: string,
  dir: string,
  options: { extension: string },
): Promise<string[]>;
