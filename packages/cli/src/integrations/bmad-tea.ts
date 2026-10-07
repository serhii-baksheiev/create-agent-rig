import { resolveReadableInside } from '../lib/safe-path.js';
import { readBounded } from './verify.js';

/**
 * BMAD Method's Test Architecture Enterprise (TEA) module (RP-315): an
 * upstream-managed, advisory evidence provider — closer in shape to Probity
 * than to a plain MCP server. Rig never installs, upgrades or removes TEA
 * (the manual step is `npx bmad-method install --modules tea`, run by the
 * operator); it only reads the upstream installer's own state, read-only.
 * The pinned version below is the one Rig was checked against, not a
 * version Rig enforces or can upgrade to — TEA evidence stays advisory
 * regardless of which version is actually installed.
 */
export const BMAD_TEA_VERSION = '1.27.2';

const MANIFEST_REL = '_bmad/_config/manifest.yaml';
const TEA_CONFIG_REL = '_bmad/tea/config.yaml';
const MAX_MANIFEST_BYTES = 64 * 1024;
/** The shape `evidence-attach.mjs --producer-version` accepts; any other upstream text never reaches diagnostics. */
const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export type BmadTeaInspectionStatus = 'pass' | 'warn';
export type BmadTeaInspectionReason =
  | 'not-installed'
  | 'version-unknown'
  | 'config-missing'
  | 'version-drift'
  | 'manifest-unreadable'
  | 'installed';
export type BmadTeaInspection = {
  status: BmadTeaInspectionStatus;
  reason: BmadTeaInspectionReason;
  version?: string;
};

/** Strip one pair of matching surrounding quotes from a YAML scalar. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === last && (first === '"' || first === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * The `tea` entry's own `version` field, read from the top-level `modules:`
 * sequence only — a `tea` name under any other key (e.g. `ides:`) never
 * matches. A bounded, single forward pass over text already capped by the
 * caller's `readBounded`: an item starts at a `- name: tea` line inside the
 * `modules:` block, and the block itself ends at the next line that starts
 * at column zero (a sibling top-level key). `found` is false when no `tea`
 * entry exists under `modules:` at all; when it does, `version` is
 * `undefined` exactly when that entry carries no `version:` field.
 */
function findTeaModuleVersion(text: string): { found: boolean; version?: string } {
  let inModules = false;
  let inTeaItem = false;
  let found = false;
  let version: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (!inModules) {
      if (line === 'modules:') inModules = true;
      continue;
    }
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      inModules = false;
      inTeaItem = false;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('- name:')) {
      inTeaItem = stripQuotes(trimmed.slice('- name:'.length).trim()) === 'tea';
      if (inTeaItem) {
        found = true;
        version = undefined;
      }
      continue;
    }
    if (inTeaItem && trimmed.startsWith('version:')) {
      version = stripQuotes(trimmed.slice('version:'.length).trim());
    }
  }
  return { found, version };
}

/**
 * Read-only doctor surface over the BMAD installer's own manifest
 * (`_bmad/_config/manifest.yaml`) and the TEA module's own config
 * (`_bmad/tea/config.yaml`). Never spawns a process, never writes anything,
 * and never fails hard — the furthest this goes is `warn`, because TEA
 * evidence is advisory, not a gate.
 */
export async function inspectBmadTea(repoDir: string): Promise<BmadTeaInspection> {
  const manifest = await readBounded(repoDir, MANIFEST_REL, MAX_MANIFEST_BYTES);
  if (manifest.status === 'absent') return { status: 'warn', reason: 'not-installed' };
  if (manifest.status !== 'ok') return { status: 'warn', reason: 'manifest-unreadable' };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(manifest.bytes);
  } catch {
    return { status: 'warn', reason: 'manifest-unreadable' };
  }

  const tea = findTeaModuleVersion(text);
  if (!tea.found) return { status: 'warn', reason: 'not-installed' };
  if (tea.version === undefined || !VERSION_TOKEN.test(tea.version))
    return { status: 'warn', reason: 'version-unknown' };

  const config = await resolveReadableInside(repoDir, TEA_CONFIG_REL, 'file');
  if (config.status !== 'ok') return { status: 'warn', reason: 'config-missing' };

  if (tea.version !== BMAD_TEA_VERSION)
    return { status: 'warn', reason: 'version-drift', version: tea.version };
  return { status: 'pass', reason: 'installed', version: tea.version };
}
