import { EXACT_VERSION_PATTERN } from './declaration.js';

/**
 * Playwright MCP (RP-313): an upstream-owned browser-verification provider,
 * wired through the ordinary MCP integration path and launched over stdio by
 * `npx` at this exact version — the same pinning discipline as Spec Kit and
 * Probity, and covered by the owned entry's hash. Nothing of Playwright's is
 * vendored; Rig only writes the harness entries and the declaration.
 */
export const PLAYWRIGHT_MCP_VERSION = '0.0.83';

/**
 * The repository's override (RP-445): a declared version counts only when it
 * names one exact release. A tag such as `latest`, still accepted for
 * compatibility, leaves the Rig-tested version in force.
 */
export function playwrightOverride(declared: string | undefined): string | undefined {
  return declared !== undefined && EXACT_VERSION_PATTERN.test(declared) ? declared : undefined;
}
