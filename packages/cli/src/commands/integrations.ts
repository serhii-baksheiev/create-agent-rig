import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DECLARATION_REL,
  MAX_DECLARATION_BYTES,
  parseDeclaration,
  serializeDeclaration,
  type DeclaredIntegration,
} from '../integrations/declaration.js';
import { REGISTRY, type Harness, type ProviderDescriptor } from '../integrations/registry.js';
import { resolveReadableInside, resolveWritableInside } from '../lib/safe-path.js';
import { hasControlCharacter } from '../lib/safe-text.js';
import { editMcpServers, readMcpConfig } from '../integrations/mcp-json.js';
import { initFileContents } from './init.js';
import { MANIFEST_REL, parseManifest, sha256 } from '../lib/manifest.js';
import {
  runSpecKitLifecycle,
  SPEC_KIT_VERSION,
  type SpecKitOptions,
  type SpecKitResult,
} from '../integrations/spec-kit.js';

const MCP = '.mcp.json';
const CODEX_CONFIG = '.codex/config.toml';
const MAX_MCP_BYTES = 64 * 1024;
type Snapshot = { rel: string; bytes: Buffer | null };
type Edit = Snapshot & { next: Buffer };
export type IntegrationsCliResult = { exitCode: number; stdout: string; stderr: string };
export type IntegrationsCliOptions = {
  verb: string;
  args: string[];
  cwd: string;
  registry?: readonly ProviderDescriptor[];
  isTTY?: boolean;
  confirm?: (plan: string) => Promise<boolean>;
  runSpecKit?: typeof runSpecKitLifecycle;
};
export const INTEGRATIONS_VERBS = ['list', 'add', 'apply', 'remove'] as const;
class Refusal extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function serverFor(id: string) {
  if (id === 'figma-mcp')
    return { name: 'figma', server: { type: 'http', url: 'https://mcp.figma.com/mcp' } };
  if (id === 'atlassian-mcp')
    return { name: 'atlassian', server: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' } };
  throw new Refusal('not-in-matrix');
}
function codexSection(id: string): string {
  const { name, server } = serverFor(id);
  if (server.type !== 'http') throw new Refusal('codex-provider-not-renderable');
  return `[mcp_servers.${name}]\nurl = ${JSON.stringify(server.url)}\n`;
}
function renderCodexConfig(base: string, entries: readonly DeclaredIntegration[]): Buffer {
  const sections = entries
    .filter((entry) => entry.id !== 'spec-kit' && entry.harnesses?.includes('codex'))
    .map((entry) => codexSection(entry.id))
    .sort((a, b) => a.localeCompare(b));
  return Buffer.from(
    `${base.replace(/\n*$/, '\n')}${sections.length ? `\n${sections.join('\n')}` : ''}`,
  );
}
async function snapshot(root: string, rel: string): Promise<Snapshot> {
  const resolved = await resolveReadableInside(root, rel, 'file');
  if (resolved.status === 'absent') return { rel, bytes: null };
  if (resolved.status !== 'ok') throw new Refusal('preimage-unreadable');
  const max = rel === DECLARATION_REL ? MAX_DECLARATION_BYTES : MAX_MCP_BYTES;
  const flags =
    constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(resolved.path, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Refusal('preimage-unreadable-or-too-large');
    const buffer = Buffer.alloc(max + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > max) throw new Refusal('preimage-too-large');
    return { rel, bytes: buffer.subarray(0, offset) };
  } finally {
    await handle.close();
  }
}
function decode(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Refusal('preimage-invalid-utf8');
  }
}
function readConfig(file: Snapshot) {
  if (file.bytes === null) return { mcpServers: {} as Record<string, unknown> };
  try {
    return readMcpConfig(decode(file.bytes));
  } catch {
    throw new Refusal('mcp-config-invalid-or-ambiguous');
  }
}
const equalBytes = (a: Buffer | null, b: Buffer | null) =>
  a === null ? b === null : b !== null && a.equals(b);
async function checkSnapshots(root: string, files: readonly Snapshot[]) {
  for (const file of files) {
    const current = await snapshot(root, file.rel);
    if (!equalBytes(current.bytes, file.bytes)) throw new Refusal('changed-since-plan');
  }
}
async function atomicWrite(root: string, rel: string, bytes: Buffer): Promise<void> {
  let dest = await resolveWritableInside(root, rel);
  if (dest === null) throw new Refusal('write-path-unsafe');
  await mkdir(path.dirname(dest), { recursive: true });
  dest = await resolveWritableInside(root, rel);
  if (dest === null) throw new Refusal('write-path-unsafe');
  const temporary = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    if ((await resolveWritableInside(root, rel)) !== dest) throw new Refusal('write-path-changed');
    await rename(temporary, dest);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}
async function applyEdits(root: string, preimages: Snapshot[], edits: Edit[]) {
  await checkSnapshots(root, preimages);
  for (const edit of edits) {
    if ((await resolveWritableInside(root, edit.rel)) === null)
      throw new Refusal('write-path-unsafe');
  }
  const written: Edit[] = [];
  try {
    for (const edit of edits) {
      await checkSnapshots(root, [{ rel: edit.rel, bytes: edit.bytes }]);
      await atomicWrite(root, edit.rel, edit.next);
      written.push(edit);
    }
  } catch (error) {
    let restored = true;
    for (const edit of written.reverse()) {
      try {
        await checkSnapshots(root, [{ rel: edit.rel, bytes: edit.next }]);
        if (edit.bytes !== null) await atomicWrite(root, edit.rel, edit.bytes);
        else {
          const dest = await resolveWritableInside(root, edit.rel);
          if (dest === null) throw new Refusal('rollback-path-unsafe');
          await unlink(dest);
        }
      } catch {
        restored = false;
      }
    }
    if (!restored) throw new Refusal('write-failed-rollback-incomplete');
    throw error;
  }
}

export async function runIntegrationsCommand(
  options: IntegrationsCliOptions,
): Promise<IntegrationsCliResult> {
  const json = options.args.includes('--json');
  const verb = INTEGRATIONS_VERBS.find((value) => value === options.verb);
  const respond = (
    payload: Record<string, unknown>,
    prose: string,
    exitCode = 0,
  ): IntegrationsCliResult => ({
    exitCode,
    stdout: json
      ? `${JSON.stringify({ schemaVersion: 1, command: 'setup', verb: verb ?? 'unknown', ...payload })}\n`
      : exitCode === 0
        ? `${prose}\n`
        : '',
    stderr: !json && exitCode !== 0 ? `${prose}\n` : '',
  });
  let upstreamApplied = false;
  let observed: SpecKitResult['observed'];
  try {
    if (verb === undefined)
      throw new Refusal(`unknown-verb; known: ${INTEGRATIONS_VERBS.join(', ')}`);
    if (options.args.some((arg) => hasControlCharacter(arg)))
      throw new Refusal('malformed-argument-control-character');
    const { values, positionals } = parseArgs({
      args: options.args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        ...(verb === 'list'
          ? {}
          : {
              yes: { type: 'boolean' as const },
              'dry-run': { type: 'boolean' as const },
              ...(verb === 'add'
                ? {
                    harness: { type: 'string' as const, multiple: true },
                    required: { type: 'boolean' as const },
                    version: { type: 'string' as const },
                    adopt: { type: 'boolean' as const },
                  }
                : {}),
            }),
      },
    });
    const registry = options.registry ?? REGISTRY;
    if (verb === 'list') {
      if (positionals.length) throw new Refusal('list-takes-no-provider');
      return respond(
        { integrations: registry },
        registry.map((entry) => `${entry.id}: ${entry.displayName}`).join('\n'),
      );
    }
    if (positionals.length > 1 || (verb !== 'apply' && positionals.length !== 1))
      throw new Refusal(verb === 'apply' ? 'at-most-one-id-required' : 'exactly-one-id-required');
    const id = positionals[0];
    if (id !== undefined && !registry.some((entry) => entry.id === id))
      throw new Refusal('not-in-matrix');
    if (values.adopt && id !== 'spec-kit') throw new Refusal('adopt-only-for-spec-kit');
    const [declarationFile, mcpFile, codexFile, manifestFile] = await Promise.all([
      snapshot(options.cwd, DECLARATION_REL),
      snapshot(options.cwd, MCP),
      snapshot(options.cwd, CODEX_CONFIG),
      snapshot(options.cwd, MANIFEST_REL),
    ]);
    const parsed =
      declarationFile.bytes === null
        ? { status: 'ok' as const, entries: [] as DeclaredIntegration[], rejected: [] }
        : parseDeclaration(decode(declarationFile.bytes), registry);
    if (parsed.status !== 'ok' || parsed.rejected.length)
      throw new Refusal('declaration-invalid-or-rejected');
    let entries = structuredClone(parsed.entries);
    let targets = structuredClone(parsed.targets);
    if (verb === 'add') {
      const previous = entries.find((entry) => entry.id === id);
      const requested: unknown = values.harness;
      if (
        requested !== undefined &&
        (!Array.isArray(requested) ||
          !requested.every((harness) => typeof harness === 'string') ||
          new Set(requested).size !== requested.length)
      )
        throw new Refusal('malformed-provider-selection');
      const harnesses = [
        ...new Set([
          ...(previous?.harnesses ?? []),
          ...(requested ?? previous?.harnesses ?? ['claude-code']),
        ]),
      ];
      const candidate = {
        ...previous,
        id: id!,
        selected: true as const,
        harnesses: harnesses as Harness[],
        ...(values.required !== undefined ? { required: values.required } : {}),
        ...(values.version !== undefined ? { version: values.version } : {}),
        ...(id === 'spec-kit' ? { version: values.version ?? SPEC_KIT_VERSION } : {}),
      };
      const checked = parseDeclaration(
        JSON.stringify({ schemaVersion: 1, integrations: [candidate] }),
        registry,
      );
      if (checked.status !== 'ok' || checked.rejected.length || checked.entries.length !== 1)
        throw new Refusal('malformed-provider-selection');
      entries = [...entries.filter((entry) => entry.id !== id), checked.entries[0]!];
    }
    const selected = entries.filter((entry) => id === undefined || entry.id === id);
    if (id !== undefined && !selected.length) throw new Refusal('integration-not-declared');
    const specKit = selected.find((entry) => entry.id === 'spec-kit');
    let upstreamOptions: SpecKitOptions | undefined;
    let upstreamPlan: string[] = [];
    if (specKit) {
      if (specKit.version !== SPEC_KIT_VERSION || specKit.targets !== undefined)
        throw new Refusal('spec-kit-pinned-version-and-upstream-ownership-required');
      upstreamOptions = {
        repoDir: options.cwd,
        operation: verb,
        harnesses: specKit.harnesses ?? [],
        managed: parsed.entries.some((entry) => entry.id === 'spec-kit'),
        adopt: values.adopt === true,
        consent: false,
      };
      const planned = await runSpecKitLifecycle(upstreamOptions);
      if (planned.reason !== 'consent-required')
        throw new Refusal(planned.reason ?? 'upstream-plan-refused');
      upstreamPlan = planned.plan;
      if (verb === 'remove') entries = entries.filter((entry) => entry.id !== 'spec-kit');
    }
    const selectedMcp = selected.filter((entry) => entry.id !== 'spec-kit');
    const needsClaude = selectedMcp.some((entry) => entry.harnesses?.includes('claude-code'));
    const servers = needsClaude ? { ...readConfig(mcpFile).mcpServers } : {};
    const mcpChanges = new Map<string, unknown | undefined>();
    for (const entry of selectedMcp) {
      if (entry.harnesses === undefined || entry.harnesses.length === 0)
        throw new Refusal('harness-unsupported-or-pending');
      if (!entry.harnesses.includes('claude-code')) {
        if (verb === 'remove') entries = entries.filter((candidate) => candidate.id !== entry.id);
        continue;
      }
      const { name, server } = serverFor(entry.id);
      const exists = Object.hasOwn(servers, name);
      const ownership = entry.targets?.['claude-code']?.entryHash;
      if (
        exists &&
        (ownership === undefined || hash(servers[name]) !== ownership || ownership !== hash(server))
      )
        throw new Refusal('foreign-or-modified-mcp-entry');
      if (verb === 'remove') {
        if (!exists || ownership === undefined) throw new Refusal('owned-mcp-entry-absent');
        delete servers[name];
        entries = entries.filter((candidate) => candidate.id !== entry.id);
        mcpChanges.set(name, undefined);
      } else {
        if (!exists) {
          servers[name] = server;
          mcpChanges.set(name, server);
        }
        entry.targets = { ...entry.targets, 'claude-code': { entryHash: hash(server) } };
      }
    }
    const codexSelected = selectedMcp.some((entry) => entry.harnesses?.includes('codex'));
    let nextCodex = codexFile.bytes;
    if (codexSelected) {
      const fragment = selectedMcp
        .filter((entry) => entry.harnesses?.includes('codex'))
        .map((entry) => codexSection(entry.id))
        .join('\n');
      const manifest =
        manifestFile.bytes === null ? null : parseManifest(decode(manifestFile.bytes));
      if (manifest === null) throw new Refusal('release-manifest-unreadable');
      const base = (await initFileContents(options.cwd, manifest.project, manifest.layers)).get(
        CODEX_CONFIG,
      );
      if (base === undefined) throw new Refusal('release-codex-baseline-unavailable');
      if (codexFile.bytes === null) {
        if (verb !== 'apply' || targets?.codex === undefined)
          throw new Refusal('codex-config-absent-explicit-apply-required');
      } else if (targets?.codex !== undefined) {
        if (sha256(codexFile.bytes) !== targets.codex.fileHash)
          throw new Refusal(`codex-config-conflict; managed provider fragment:\n${fragment}`);
      } else if (manifest.files[CODEX_CONFIG] !== sha256(codexFile.bytes)) {
        throw new Refusal(
          `codex-config-not-release-baseline; managed provider fragment:\n${fragment}`,
        );
      }
      nextCodex = renderCodexConfig(base, entries);
      targets = { ...(targets ?? {}), codex: { fileHash: sha256(nextCodex) } };
    }
    const nextDeclaration = Buffer.from(serializeDeclaration(entries, targets));
    if (nextDeclaration.length > MAX_DECLARATION_BYTES) throw new Refusal('declaration-too-large');
    const nextMcp =
      mcpChanges.size > 0
        ? Buffer.from(
            editMcpServers(
              mcpFile.bytes === null ? '{\n  "mcpServers": {}\n}\n' : decode(mcpFile.bytes),
              mcpChanges,
            ),
          )
        : mcpFile.bytes;
    if (nextMcp !== null && nextMcp.length > MAX_MCP_BYTES)
      throw new Refusal('mcp-config-too-large');
    const edits: Edit[] = [];
    if (!equalBytes(mcpFile.bytes, nextMcp) && nextMcp !== null)
      edits.push({ ...mcpFile, next: nextMcp });
    if (!equalBytes(codexFile.bytes, nextCodex) && nextCodex !== null)
      edits.push({ ...codexFile, next: nextCodex });
    if (!equalBytes(declarationFile.bytes, nextDeclaration))
      edits.push({ ...declarationFile, next: nextDeclaration });
    const plan = `${verb}: ${selected.map((entry) => entry.id).join(', ') || 'no integrations'}; write ${edits.map((edit) => edit.rel).join(', ') || 'nothing'}. MCP wiring does not verify authorization, connectivity or trust.${upstreamPlan.length ? '\n' + upstreamPlan.join('\n') : ''}`;
    if (values['dry-run'])
      return respond({ outcome: 'planned', dryRun: true, changed: false, plan }, plan);
    if (
      !values.yes &&
      (json ||
        options.isTTY === false ||
        options.confirm === undefined ||
        !(await options.confirm(plan)))
    )
      throw new Refusal('yes-required-for-json-or-noninteractive');
    const preimages = [declarationFile, mcpFile, codexFile, manifestFile];
    await checkSnapshots(options.cwd, preimages);
    if (upstreamOptions) {
      const rechecked = await runSpecKitLifecycle(upstreamOptions);
      if (
        rechecked.reason !== 'consent-required' ||
        JSON.stringify(rechecked.plan) !== JSON.stringify(upstreamPlan)
      )
        throw new Refusal('changed-since-plan');
      const result = await (options.runSpecKit ?? runSpecKitLifecycle)({
        ...upstreamOptions,
        consent: true,
      });
      observed = result.observed;
      if (!result.ok)
        throw new Refusal(result.reason ?? 'upstream-incomplete-use-adopt-and-status');
      upstreamApplied = true;
    }
    await applyEdits(options.cwd, preimages, edits);
    return respond(
      {
        outcome: verb === 'remove' ? 'removed' : 'written',
        changed: edits.length !== 0,
        ...(id === undefined ? {} : { id }),
        integrations: entries,
        ...(observed === undefined ? {} : { observed }),
      },
      plan,
    );
  } catch (error) {
    const failure =
      error instanceof Refusal ? error.message : 'invalid-arguments-or-unreadable-state';
    const reason = upstreamApplied
      ? `upstream-success-intent-not-recorded; use adopt/status; ${failure}`
      : failure;
    const diagnosis =
      observed === undefined ? '' : `\nUpstream status: ${JSON.stringify(observed)}`;
    return respond(
      { outcome: 'refused', reason, ...(observed === undefined ? {} : { observed }) },
      `setup: ${reason}${diagnosis}`,
      1,
    );
  }
}
