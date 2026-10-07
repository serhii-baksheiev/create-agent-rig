/** The finite release matrix. Provider lifecycle, credentials and provider data
 * are deliberately outside Rig's declaration. */
export type Harness = 'claude-code' | 'codex';
export type ProviderDescriptor = {
  id:
    | 'figma-mcp'
    | 'atlassian-mcp'
    | 'playwright-mcp'
    | 'basic-memory'
    | 'spec-kit'
    | 'probity'
    | 'bmad-tea';
  displayName: string;
  routes: Partial<Record<Harness, 'automatic' | 'pending'>>;
};
export const REGISTRY: readonly ProviderDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'basic-memory',
    displayName: 'Basic Memory (wiring-only preview)',
    routes: Object.freeze({ 'claude-code': 'automatic', codex: 'automatic' }),
  }),
  Object.freeze({
    id: 'spec-kit',
    displayName: 'Spec Kit (upstream-managed)',
    routes: Object.freeze({ 'claude-code': 'automatic', codex: 'automatic' }),
  }),
  Object.freeze({
    id: 'figma-mcp',
    displayName: 'Figma MCP',
    routes: Object.freeze({ 'claude-code': 'automatic', codex: 'automatic' }),
  }),
  Object.freeze({
    id: 'atlassian-mcp',
    displayName: 'Atlassian MCP',
    routes: Object.freeze({ 'claude-code': 'automatic', codex: 'automatic' }),
  }),
  Object.freeze({
    id: 'playwright-mcp',
    displayName: 'Playwright MCP',
    routes: Object.freeze({ 'claude-code': 'automatic', codex: 'automatic' }),
  }),
  Object.freeze({
    id: 'probity',
    displayName: 'Probity (upstream TDD enforcement)',
    routes: Object.freeze({ 'claude-code': 'automatic', codex: 'automatic' }),
  }),
  Object.freeze({
    id: 'bmad-tea',
    displayName: 'BMAD TEA (upstream-managed, evidence only)',
    routes: Object.freeze({ 'claude-code': 'automatic', codex: 'automatic' }),
  }),
]);

/**
 * Providers that are never rendered into any harness's MCP config — closer
 * in shape to upstream-managed tooling (Spec Kit, Probity) than to a plain
 * MCP server. Exported once so `integrations.ts` and `doctor.ts` cannot
 * disagree about which ids this covers (`.claude/rules/invariants.md`, "One
 * mechanism, one implementation").
 */
export const NON_MCP_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'spec-kit',
  'probity',
  'bmad-tea',
]);
