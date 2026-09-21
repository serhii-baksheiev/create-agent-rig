import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { DECLARATION_REL, MAX_DECLARATION_BYTES, parseDeclaration } from './declaration.js';
import { readMcpConfig } from './mcp-json.js';
import { REGISTRY, type Harness } from './registry.js';
import { matchesIgnoringLineEndings } from '../lib/manifest.js';
import { resolveReadableInside } from '../lib/safe-path.js';

const MCP_REL = '.mcp.json';
const CODEX_REL = '.codex/config.toml';
const MAX_WIRING_BYTES = 64 * 1024;

export type WiringStatus = 'healthy' | 'missing' | 'drift' | 'unowned' | 'unreadable';
export type LauncherStatus = 'observed' | 'missing' | 'not-applicable';
export type Verification = {
  wiring: WiringStatus;
  launcher: LauncherStatus;
  runtime: 'unverified';
  connectivity: 'not-observed';
  trust: 'not-observed';
  reason?: 'invalid-config' | 'unsafe-or-too-large';
};
export type IntegrationVerification = {
  id: string;
  harnesses: Partial<Record<Harness, Verification>>;
};
export type DoctorIssue = {
  scope: 'declaration' | 'integration';
  status: 'missing' | 'invalid' | 'rejected';
  reason?: 'not-in-matrix' | 'arbitrary-command-refused' | 'malformed';
};
export type VerifyIntegrationsResult = {
  integrations: IntegrationVerification[];
  issues: DoctorIssue[];
};
export type LauncherLocator = (name: 'uvx') => Promise<string | null>;
export type VerifyIntegrationsOptions = {
  repoDir: string;
  locateLauncher?: LauncherLocator;
  env?: NodeJS.ProcessEnv;
};

type BoundedRead =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'absent' }
  | { status: 'unsafe' | 'too-large' | 'invalid-utf8' };

function sha256(value: Buffer | unknown): string {
  const input = Buffer.isBuffer(value) ? value : JSON.stringify(value);
  return createHash('sha256').update(input).digest('hex');
}

/** Read only regular, in-repository files and cap every allocation before I/O. */
export async function readBounded(repoDir: string, rel: string, max: number): Promise<BoundedRead> {
  const resolved = await resolveReadableInside(repoDir, rel, 'file');
  if (resolved.status === 'absent') return { status: 'absent' };
  if (resolved.status !== 'ok') return { status: 'unsafe' };

  const flags =
    constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolved.path, flags);
  } catch {
    return { status: 'unsafe' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: 'unsafe' };
    if (info.size > max) return { status: 'too-large' };
    const bytes = Buffer.alloc(max + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > max) return { status: 'too-large' };
    return { status: 'ok', bytes: bytes.subarray(0, offset) };
  } catch {
    return { status: 'unsafe' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decode(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function defaultLocateLauncher(name: 'uvx', env = process.env): Promise<string | null> {
  const variable = env.PATH ?? env.Path;
  if (variable === undefined) return null;
  for (const directory of variable.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      // Follow a machine-installed launcher symlink, but never execute it.
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // A PATH member not present on this machine is not a diagnostic failure.
    }
  }
  return null;
}

function verification(wiring: WiringStatus, launcher: LauncherStatus): Verification {
  return {
    wiring,
    launcher,
    runtime: 'unverified',
    connectivity: 'not-observed',
    trust: 'not-observed',
  };
}

function mcpServerName(id: string): string | undefined {
  if (id === 'figma-mcp') return 'figma';
  if (id === 'atlassian-mcp') return 'atlassian';
  if (id === 'basic-memory') return 'basic-memory';
  return undefined;
}

/**
 * Pure doctor surface for Rig-owned wiring. It deliberately neither starts a
 * launcher nor connects to a provider, so launcher presence is only observed
 * and provider runtime/connectivity/trust remain unverified.
 */
export async function verifyIntegrations(
  options: VerifyIntegrationsOptions,
): Promise<VerifyIntegrationsResult> {
  const declaration = await readBounded(options.repoDir, DECLARATION_REL, MAX_DECLARATION_BYTES);
  if (declaration.status === 'absent')
    return { integrations: [], issues: [{ scope: 'declaration', status: 'missing' }] };
  if (declaration.status !== 'ok')
    return { integrations: [], issues: [{ scope: 'declaration', status: 'invalid' }] };
  const declarationText = decode(declaration.bytes);
  if (declarationText === null)
    return { integrations: [], issues: [{ scope: 'declaration', status: 'invalid' }] };

  const parsed = parseDeclaration(declarationText, REGISTRY);
  if (parsed.status === 'invalid')
    return { integrations: [], issues: [{ scope: 'declaration', status: 'invalid' }] };

  const issues: DoctorIssue[] = parsed.rejected.map(({ reason }) => ({
    scope: 'integration',
    status: 'rejected',
    reason,
  }));
  const claudeFile = await readBounded(options.repoDir, MCP_REL, MAX_WIRING_BYTES);
  let claudeServers: Record<string, unknown> | undefined;
  if (claudeFile.status === 'ok') {
    const text = decode(claudeFile.bytes);
    if (text !== null) {
      try {
        claudeServers = readMcpConfig(text).mcpServers;
      } catch {
        // The status below reports drift without echoing untrusted JSON.
      }
    }
  }
  const codexFile = await readBounded(options.repoDir, CODEX_REL, MAX_WIRING_BYTES);
  const locator = options.locateLauncher ?? ((name) => defaultLocateLauncher(name, options.env));
  const integrations: IntegrationVerification[] = [];

  for (const entry of parsed.entries) {
    const harnesses: Partial<Record<Harness, Verification>> = {};
    for (const harness of entry.harnesses ?? []) {
      if (harness === 'claude-code') {
        const entryHash = entry.targets?.['claude-code']?.entryHash;
        const name = mcpServerName(entry.id);
        let wiring: WiringStatus;
        if (entryHash === undefined) wiring = 'unowned';
        else if (claudeFile.status === 'absent') wiring = 'missing';
        else if (claudeServers === undefined) wiring = 'unreadable';
        else if (name === undefined) wiring = 'unowned';
        else if (!(name in claudeServers)) wiring = 'missing';
        else wiring = sha256(claudeServers[name]) === entryHash ? 'healthy' : 'drift';

        let launcher: LauncherStatus = 'not-applicable';
        if (entry.id === 'basic-memory' && wiring === 'healthy')
          launcher = (await locator('uvx')) === null ? 'missing' : 'observed';
        harnesses[harness] = verification(wiring, launcher);
        if (wiring === 'unreadable')
          harnesses[harness].reason =
            claudeFile.status === 'ok' ? 'invalid-config' : 'unsafe-or-too-large';
        continue;
      }

      const expectedHash = parsed.targets?.codex?.fileHash;
      const wiring: WiringStatus =
        expectedHash === undefined
          ? 'unowned'
          : codexFile.status === 'absent'
            ? 'missing'
            : codexFile.status !== 'ok'
              ? 'unreadable'
              : matchesIgnoringLineEndings(codexFile.bytes, expectedHash)
                ? 'healthy'
                : 'drift';
      const launcher =
        entry.id === 'basic-memory' && wiring === 'healthy'
          ? (await locator('uvx')) === null
            ? 'missing'
            : 'observed'
          : 'not-applicable';
      harnesses[harness] = verification(wiring, launcher);
      if (wiring === 'unreadable') harnesses[harness].reason = 'unsafe-or-too-large';
    }
    integrations.push({ id: entry.id, harnesses });
  }
  return { integrations, issues };
}
