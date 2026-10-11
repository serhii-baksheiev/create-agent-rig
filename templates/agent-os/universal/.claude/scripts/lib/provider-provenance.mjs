// External-provider version provenance (RP-443): which exact provider
// versions a rig declares, pins or has installed, read from the files the rig
// and the providers already keep. Offline and read-only. A file that is over
// 256 KiB, a symlinked file, unreadable or not valid JSON reads as absent, and
// a value that is not an exact semver reads as unknown — a version is reported
// only when one of these files states it, never inferred from another.
//
// Tests: `test/template/provider-provenance.test.ts` (absent in a generated rig).

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecretValues } from './secrets.mjs';

const MAX_BYTES = 256 * 1024;
/** An exact semver: a dist-tag or a range names no version. */
const EXACT_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
const PLAYWRIGHT_ARG = /^@playwright\/mcp@(.+)$/;
const PLAYWRIGHT_IN_TOML = /["']@playwright\/mcp@([^"']+)["']/;

/**
 * A value that is both an exact semver AND free of the shared credential
 * vocabulary, or null. `EXACT_VERSION`'s pre-release/build suffixes are
 * `[0-9A-Za-z.-]{1,40}` — wide enough to admit a credential shape verbatim
 * (RP-443) — so this is never read without the second check: a version is
 * reported only when a file states one, never a credential that merely
 * fits the semver grammar.
 */
const versionOrNull = (value) =>
  typeof value === 'string' && EXACT_VERSION.test(value) && findSecretValues(value).length === 0
    ? value
    : null;

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
 * Every raw Playwright MCP pin candidate the rig's own wiring names —
 * `@playwright/mcp@<text>` in `.mcp.json`, then in `.codex/config.toml` —
 * in the same files, servers and order `playwrightPin` reads, and
 * UNFILTERED: a candidate here may be a dist-tag, a range, or a
 * credential-shaped value, because `versionOrNull` has not judged any of
 * them yet. The `.codex/config.toml` side stops at its first match, exactly
 * as `playwrightPin` always has — a second, later pin there has never been
 * read.
 */
const playwrightPinCandidates = (projectRoot) => {
  const candidates = [];
  const servers = readJson(join(projectRoot, '.mcp.json'))?.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const server of Object.values(servers)) {
      for (const arg of Array.isArray(server?.args) ? server.args : []) {
        const match = typeof arg === 'string' ? PLAYWRIGHT_ARG.exec(arg) : null;
        if (match) candidates.push(match[1]);
      }
    }
  }
  const toml = readBounded(join(projectRoot, '.codex', 'config.toml'));
  for (const line of toml === null ? [] : toml.split('\n')) {
    const hash = line.indexOf('#');
    const match = PLAYWRIGHT_IN_TOML.exec(hash === -1 ? line : line.slice(0, hash));
    if (match) {
      candidates.push(match[1]);
      break;
    }
  }
  return candidates;
};

/**
 * The exact Playwright MCP version the rig's own MCP wiring launches —
 * `@playwright/mcp@<v>` in `.mcp.json`, else in `.codex/config.toml` — or null
 * when neither pins an exact version.
 */
export const playwrightPin = async (projectRoot) => {
  for (const candidate of playwrightPinCandidates(projectRoot)) {
    const version = versionOrNull(candidate);
    if (version) return version;
  }
  return null;
};

/**
 * Whether the rig's own Playwright MCP wiring names a pin whose raw text is
 * credential-shaped (RP-443) — checked over the same candidates
 * `playwrightPin` reads, before `versionOrNull` has filtered any of them.
 *
 * `playwrightPin` returns null for a credential-shaped candidate exactly as
 * it does for a dist-tag or a range — "no exact version" reads the same
 * whatever the reason. A caller that needs to tell "nothing configured" and
 * "configured, and a credential" apart — to refuse the second even when a
 * clean `--producer-version` was also given, with nothing left to literally
 * "disagree" with — reads this instead.
 */
export const playwrightPinCredentialShaped = (projectRoot) =>
  playwrightPinCandidates(projectRoot).some((candidate) => findSecretValues(candidate).length > 0);

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
