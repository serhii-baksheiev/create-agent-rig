// External-provider version provenance (RP-443): which exact provider
// versions a rig declares, pins or has installed, read from the files the rig
// and the providers already keep. Offline and read-only. A file that is over
// 256 KiB, a symlink, unreadable or not valid JSON reads as absent, and a
// value that is not a version token reads as unknown — a version is reported
// only when one of these files states it, never inferred from another.
//
// Tests: `test/template/provider-provenance.test.ts` (absent in a generated rig).

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 256 * 1024;
/** One version token — the shape `evidence-attach.mjs --producer-version` accepts. */
const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const PLAYWRIGHT_ARG = /^@playwright\/mcp@(.+)$/;
const PLAYWRIGHT_IN_TOML = /["']@playwright\/mcp@([^"']+)["']/;

const versionOrNull = (value) =>
  typeof value === 'string' && VERSION_TOKEN.test(value) ? value : null;

/** A regular, bounded file's text, or null. */
const readBounded = (file) => {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const readJson = (file) => {
  const text = readBounded(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The `.rig/integrations.json` entry for one provider id, or null. */
const declarationEntry = (projectRoot, id) => {
  const declaration = readJson(join(projectRoot, '.rig', 'integrations.json'));
  const entries = Array.isArray(declaration?.integrations) ? declaration.integrations : [];
  return entries.find((entry) => entry && typeof entry === 'object' && entry.id === id) ?? null;
};

/**
 * The exact Playwright MCP version the rig's own MCP wiring launches —
 * `@playwright/mcp@<v>` in `.mcp.json`, else in `.codex/config.toml` — or null
 * when neither pins an exact version.
 */
export const playwrightPin = async (projectRoot) => {
  const servers = readJson(join(projectRoot, '.mcp.json'))?.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const server of Object.values(servers)) {
      for (const arg of Array.isArray(server?.args) ? server.args : []) {
        const match = typeof arg === 'string' ? PLAYWRIGHT_ARG.exec(arg) : null;
        const version = match ? versionOrNull(match[1]) : null;
        if (version) return version;
      }
    }
  }
  const toml = readBounded(join(projectRoot, '.codex', 'config.toml'));
  const match = toml === null ? null : PLAYWRIGHT_IN_TOML.exec(toml);
  return match ? versionOrNull(match[1]) : null;
};

/**
 * The Spec Kit version behind the project's Spec Kit files: `installed` from
 * Spec Kit's own `.specify/init-options.json`, else `declared` from the
 * `.rig/integrations.json` entry, else unknown.
 */
export const specKitVersion = async (projectRoot) => {
  const installed = versionOrNull(
    readJson(join(projectRoot, '.specify', 'init-options.json'))?.speckit_version,
  );
  if (installed) return { version: installed, source: 'installed' };
  const declared = versionOrNull(declarationEntry(projectRoot, 'spec-kit')?.version);
  if (declared) return { version: declared, source: 'declared' };
  return { version: null, source: 'unknown' };
};

/**
 * Probity's provenance in this project: whether the declaration selects it,
 * the version it declares, and the version installed under `node_modules` —
 * each read on its own.
 */
export const probityProvenance = async (projectRoot) => {
  const entry = declarationEntry(projectRoot, 'probity');
  return {
    selected: entry?.selected === true,
    declared: versionOrNull(entry?.version),
    installed: versionOrNull(
      readJson(join(projectRoot, 'node_modules', '@nizos', 'probity', 'package.json'))?.version,
    ),
  };
};
