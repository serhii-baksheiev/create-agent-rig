// RP-314: `templates/agent-os/profiles.json` is the static data behind
// `--preset <name>` — deliberately OUTSIDE `templates/agent-os/universal/`,
// since it is read by the CLI itself (which preset names exist, what each
// one composes) rather than installed into a generated rig. This is a
// data-validity test: every preset's own layers and integration ids must
// actually exist in the catalogues that decide what they mean.
//
// RP-313 adds the `composed` preset (the `sdd` layer set plus the Spec Kit
// AND Playwright MCP integration names) — the earlier "composed is
// explicitly out of scope … before its time" comments this file carried
// named exactly this item as the one that would add it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '../src/integrations/registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesPath = path.join(repoRoot, 'templates', 'agent-os', 'profiles.json');

type Preset = { layers: string[]; integrations: string[] };
type Profiles = { schemaVersion: number; presets: Record<string, Preset> };

async function loadProfiles(): Promise<Profiles> {
  return JSON.parse(await readFile(profilesPath, 'utf8')) as Profiles;
}

describe('templates/agent-os/profiles.json — the static preset data (RP-314, RP-313)', () => {
  it('declares schemaVersion 1 and ships exactly the minimal, sdd and composed presets', async () => {
    const profiles = await loadProfiles();
    expect(profiles.schemaVersion).toBe(1);
    expect(Object.keys(profiles.presets).sort()).toEqual(['composed', 'minimal', 'sdd']);
  });

  it('minimal installs the process layer only, with no integrations', async () => {
    const profiles = await loadProfiles();
    expect(profiles.presets.minimal).toEqual({ layers: ['process'], integrations: [] });
  });

  it('sdd installs the process and workflow layers plus the spec-kit integration', async () => {
    const profiles = await loadProfiles();
    expect(profiles.presets.sdd).toEqual({
      layers: ['process', 'workflow'],
      integrations: ['spec-kit'],
    });
  });

  // RP-313: composed is exactly sdd's layer set, plus Playwright MCP's
  // integration name alongside Spec Kit's — never replacing it.
  it('composed installs the process and workflow layers plus the spec-kit and playwright-mcp integrations', async () => {
    const profiles = await loadProfiles();
    expect(profiles.presets.composed).toEqual({
      layers: ['process', 'workflow'],
      integrations: ['spec-kit', 'playwright-mcp'],
    });
  });

  it('every preset names only layers a rig can actually compose (process, workflow)', async () => {
    const profiles = await loadProfiles();
    const knownLayers = new Set(['process', 'workflow']);
    const unknown = Object.entries(profiles.presets).flatMap(([name, preset]) =>
      preset.layers
        .filter((layer) => !knownLayers.has(layer))
        .map((layer) => `${name} names unknown layer "${layer}"`),
    );
    expect(unknown).toEqual([]);
  });

  it('every preset names only integration ids the registry knows', async () => {
    const profiles = await loadProfiles();
    const knownIds = new Set(REGISTRY.map((entry) => entry.id));
    const unknown = Object.entries(profiles.presets).flatMap(([name, preset]) =>
      preset.integrations
        .filter((id) => !knownIds.has(id as (typeof REGISTRY)[number]['id']))
        .map((id) => `${name} names unknown integration id "${id}"`),
    );
    expect(unknown).toEqual([]);
  });

  it('declares no preset named after a reserved or ambiguous word ("profile")', async () => {
    const profiles = await loadProfiles();
    expect(Object.keys(profiles.presets)).not.toContain('profile');
  });
});
