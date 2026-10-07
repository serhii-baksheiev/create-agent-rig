import { readFileSync } from 'node:fs';
import path from 'node:path';
import { templatesRoot } from '../templates.js';
import type { Layer } from './manifest.js';

/**
 * Composition presets (RP-314): named bundles of layers an operator can ask
 * `init`/`create` for, plus the integrations doctor should expect. The data is
 * static (`templates/agent-os/profiles.json`); a preset is configuration sugar
 * over existing primitives and owns no runtime state, provider lifecycle,
 * scheduling, claims or merge decision — `docs/decisions/composition-presets.md`.
 */
export interface Preset {
  name: string;
  /** Layers the preset installs, unioned with whatever else the run asked for. */
  layers: Layer[];
  /** Integration ids doctor expects; `init` never installs or declares them. */
  integrations: string[];
}

interface ProfilesFile {
  schemaVersion: number;
  presets: Record<string, { layers: Layer[]; integrations: string[] }>;
}

const readProfiles = (): ProfilesFile =>
  JSON.parse(
    readFileSync(path.join(templatesRoot(), 'agent-os', 'profiles.json'), 'utf8'),
  ) as ProfilesFile;

/** Every preset name this CLI ships, sorted. */
export const presetNames = (): string[] => Object.keys(readProfiles().presets).sort();

export class PresetError extends Error {}

/** The named preset, or a {@link PresetError} naming the known presets. */
export function resolvePreset(name: string): Preset {
  const presets = readProfiles().presets;
  if (!Object.hasOwn(presets, name)) {
    throw new PresetError(
      `Unknown --preset "${name}" — known presets: ${presetNames().join(', ')}.`,
    );
  }
  const { layers, integrations } = presets[name]!;
  return { name, layers: [...layers], integrations: [...integrations] };
}

/** The preset a manifest names, or null for none or a name this CLI does not ship. */
export function knownPreset(name: string | undefined): Preset | null {
  if (name === undefined) return null;
  try {
    return resolvePreset(name);
  } catch {
    return null;
  }
}
