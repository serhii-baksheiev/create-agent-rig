/**
 * The closed, release-owned integrations matrix (RP-22, plan §1.1).
 *
 * A declaration in a repository (`.rig/integrations.json`) can only ever name
 * an `id` from {@link REGISTRY} plus a few validated scalars — never a
 * command, a URL, an argument, an environment variable or a header. Every
 * argv element a later slice spawns comes from an in-code descriptor here,
 * because the declaration is committed and therefore untrusted input
 * (`manifest.ts` and `uninstall.ts` already state this posture for their own
 * files).
 *
 * This module is pure: no `node:child_process`, no `node:net`, no filesystem.
 * Pinned by `packages/cli/test/integrations-registry.test.ts` › "registry.ts
 * and declaration.ts import neither child_process nor any net module".
 */

/** The harnesses Rig configures integrations for. */
export type Harness = 'claude-code' | 'codex';

/** What kind of thing the integration is. */
export type Mode =
  'external-installer' | 'native-plugin' | 'hosted-service' | 'external-executable';

/** How Rig gets the integration installed or configured, for one harness. */
export type Route =
  | 'claude-plugin-cli'
  | 'mcp-config'
  | 'external-installer'
  | 'codex-plugin-guided'
  | 'guided-manual'
  | 'subsystem-manifest';

export type ProviderSource = {
  kind: 'github' | 'npm' | 'pypi' | 'https' | 'marketplace';
  locator: string;
  official: boolean;
  verifiedOn: string;
  docsUrl: string;
};

export type ProviderLicense = { kind: 'spdx'; id: string } | { kind: 'terms'; url: string } | null;

export type VersionPolicy =
  { kind: 'pinned'; default: string } | { kind: 'floating'; reason: string };

export type ProviderRoute = { route: Route; automation: 'automatic' | 'guided' };

export type ProviderDescriptor = {
  id: string;
  displayName: string;
  capability: 'methodology' | 'design' | 'board' | 'memory';
  exclusiveGroup?: 'methodology';
  mode: Mode;
  source: ProviderSource;
  license: ProviderLicense;
  versionPolicy: VersionPolicy;
  routes: Partial<Record<Harness, ProviderRoute>>;
  stability: 'supported' | 'preview';
  trademark?: string;
};

export type DescriptorRejectionReason =
  'unknown-license' | 'non-official-source' | 'unpinnable-version' | 'malformed';

export type DescriptorValidation = { ok: true } | { ok: false; reason: DescriptorRejectionReason };

const isHttpsUrl = (value: string): boolean => value.startsWith('https://');

/**
 * The three refusal rules a shipped descriptor must never trip. This is a
 * check on the release's OWN registry entries, not on committed input — the
 * declaration parser (`declaration.ts`) calls it per referenced descriptor so
 * a future registry entry that regresses one of these rules is refused the
 * same way a hostile declaration would be, rather than trusted because it
 * lives in-tree.
 */
export function validateDescriptor(descriptor: ProviderDescriptor): DescriptorValidation {
  if (descriptor.license === null) return { ok: false, reason: 'unknown-license' };
  if (descriptor.source.official !== true) return { ok: false, reason: 'non-official-source' };
  if (!isHttpsUrl(descriptor.source.docsUrl)) return { ok: false, reason: 'non-official-source' };
  if (descriptor.source.kind === 'https' && !isHttpsUrl(descriptor.source.locator)) {
    return { ok: false, reason: 'non-official-source' };
  }
  if (descriptor.mode === 'external-installer' && descriptor.versionPolicy.kind === 'floating') {
    return { ok: false, reason: 'unpinnable-version' };
  }
  return { ok: true };
}

/**
 * The finite, release-owned provider matrix. One entry in this slice: the
 * existing Memory custom-executable path, exposed through the same registry
 * shape the routed providers of later slices will use. Every other provider
 * arrives in its own slice with a dated verification (plan §1.1, S1 brief).
 */
export const REGISTRY: readonly ProviderDescriptor[] = [
  {
    id: 'memory-custom-executable',
    displayName: 'Custom Memory Executable',
    capability: 'memory',
    mode: 'external-executable',
    source: {
      kind: 'github',
      locator: 'serhii-baksheiev/create-agent-rig',
      official: true,
      verifiedOn: '2026-09-20',
      docsUrl: 'https://github.com/serhii-baksheiev/create-agent-rig#readme',
    },
    license: {
      kind: 'terms',
      url: 'https://github.com/serhii-baksheiev/create-agent-rig/blob/master/LICENSE',
    },
    versionPolicy: {
      kind: 'floating',
      reason: 'compatibility is the handshake, not a range',
    },
    routes: {
      'claude-code': { route: 'subsystem-manifest', automation: 'automatic' },
      codex: { route: 'subsystem-manifest', automation: 'automatic' },
    },
    stability: 'supported',
  },
];
