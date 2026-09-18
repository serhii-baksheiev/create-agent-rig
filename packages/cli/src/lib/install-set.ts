/**
 * One file an install owns: where it goes, where it came from, what it says.
 *
 * Shared by `init` (which builds these) and `upgrade` (which reads them) —
 * one shape, so the two commands cannot describe an installed file
 * differently. Before RP-177 this module also composed the per-target
 * agent-os stack overlays (`agentOsLayerDirs`/`agentOsInstallSet`); that
 * machinery is retired along with the stacks themselves — there is exactly
 * one payload now, and `commands/init.ts` builds it directly.
 */
export interface InstalledFile {
  rel: string;
  /** Template file behind it, or `null` when the CLI generates the content. */
  source: string | null;
  content: string;
}
