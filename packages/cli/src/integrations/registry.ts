/** The finite release matrix. Provider lifecycle, credentials and provider data
 * are deliberately outside Rig's declaration. */
export type Harness = 'claude-code' | 'codex';
export type ProviderDescriptor = {
  id: 'figma-mcp' | 'atlassian-mcp' | 'basic-memory' | 'spec-kit';
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
]);
