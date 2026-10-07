/**
 * Playwright MCP (RP-313): an upstream-owned browser-verification provider,
 * wired through the ordinary MCP integration path and launched over stdio by
 * `npx` at this exact version — the same pinning discipline as Spec Kit and
 * Probity, and covered by the owned entry's hash. Nothing of Playwright's is
 * vendored; Rig only writes the harness entries and the declaration.
 */
export const PLAYWRIGHT_MCP_VERSION = '0.0.83';
