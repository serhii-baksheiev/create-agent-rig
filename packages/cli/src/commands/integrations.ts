// `create-agent-rig setup list | add | verify` (RP-22 S4): the read-only
// registry/verification verbs plus the one declaration write. Legacy
// `setup --memory-root …` is a separate module (`./setup.js`) and is not
// touched by anything here; `index.ts` dispatches to this module only when
// the first `setup` argument is one of the three verbs below, so an existing
// invocation with none of them (including no arguments at all) still reaches
// the unchanged legacy path.
//
// No route adapter has landed yet at this slice (`mcp-config` is S5,
// `claude-plugin-cli` is S6, the guided routes are S7, the mapping from the
// existing Memory `handshake()` onto this module's `verify` payload is S8) —
// `defaultProbe` below is therefore honest rather than complete: every
// harness of every declared integration reads `unverified` with reason
// `no-sanctioned-probe` until a later slice supplies a real probe. `verify`
// accepts an injected `probe` (and an injected `registry`) so this module's
// OWN behaviour — declaration parsing, the exit-code rule, the payload shape,
// upsert semantics on `add` — is fully testable without waiting on those
// slices; a later slice widens the default, not this module's shape.
// Pinned by packages/cli/test/integrations-cli.test.ts.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DECLARATION_REL,
  parseDeclaration,
  serializeDeclaration,
  type DeclaredIntegration,
  type Rejection,
  type RejectionReason,
} from '../integrations/declaration.js';
import { parseReceipt, RECEIPTS_DIR_REL, type Receipt } from '../integrations/receipt.js';
import {
  REGISTRY,
  type Harness,
  type Mode,
  type ProviderDescriptor,
  type ProviderLicense,
  type ProviderRoute,
  type ProviderSource,
  type Route,
} from '../integrations/registry.js';
import {
  classify,
  type DeclaredInput,
  type InstanceState,
  type ObservedNow,
  type ReceiptBaseline,
} from '../integrations/state.js';
import { resolveWritableInside } from '../lib/safe-path.js';

const HARNESSES: readonly Harness[] = ['claude-code', 'codex'];

// ---------------------------------------------------------------------------
// setup list
// ---------------------------------------------------------------------------

export type ListEntry = {
  id: string;
  displayName: string;
  capability: ProviderDescriptor['capability'];
  mode: Mode;
  license: ProviderLicense;
  source: ProviderSource;
  stability: ProviderDescriptor['stability'];
  harnesses: Partial<Record<Harness, ProviderRoute>>;
};

/** The registry, projected to exactly the fields `setup list` documents. */
export function listRegistry(registry: readonly ProviderDescriptor[] = REGISTRY): ListEntry[] {
  return registry.map((descriptor) => ({
    id: descriptor.id,
    displayName: descriptor.displayName,
    capability: descriptor.capability,
    mode: descriptor.mode,
    license: descriptor.license,
    source: descriptor.source,
    stability: descriptor.stability,
    harnesses: descriptor.routes,
  }));
}

function renderListProse(entries: readonly ListEntry[]): string {
  if (entries.length === 0) return 'No integrations in the registry.\n';
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.id}  (${entry.capability}, ${entry.mode}, ${entry.stability})`);
    const license =
      entry.license === null
        ? '(no licence on record)'
        : entry.license.kind === 'spdx'
          ? entry.license.id
          : entry.license.url;
    lines.push(`  license: ${license}`);
    lines.push(`  source: ${entry.source.kind}:${entry.source.locator}`);
    for (const harness of HARNESSES) {
      const route = entry.harnesses[harness];
      if (route !== undefined) lines.push(`  ${harness}: ${route.route} (${route.automation})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// setup add
// ---------------------------------------------------------------------------

export type AddOptions = {
  repoDir: string;
  id: string;
  required?: boolean;
  version?: string;
  dryRun?: boolean;
  registry?: readonly ProviderDescriptor[];
};

export type AddRefusalReason =
  | RejectionReason
  /** The on-disk declaration does not parse, so a safe upsert is impossible. */
  | 'declaration-unreadable'
  /** `resolveWritableInside` refused the write (a symlink, or an escape). */
  | 'write-refused';

export type AddOutcome =
  | { outcome: 'written' | 'dry-run'; entry: DeclaredIntegration; changed: boolean }
  | { outcome: 'refused'; reason: AddRefusalReason; message?: string };

async function readDeclarationEntries(
  repoDir: string,
  registry: readonly ProviderDescriptor[],
): Promise<{ raw: string | undefined; entries: DeclaredIntegration[] } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(path.join(repoDir, ...DECLARATION_REL.split('/')), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: undefined, entries: [] };
    // Anything else — EISDIR from a symlink-to-directory planted at the
    // declaration path, EACCES, … — is reported the same way a file that
    // parses but is invalid is: refused, never thrown. `add` never follows a
    // hostile shape at this path any further than learning it cannot read it.
    return {
      error: `the existing declaration could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`,
    };
  }
  const parsed = parseDeclaration(raw, registry);
  if (parsed.status === 'invalid') return { error: parsed.error };
  return { raw, entries: parsed.entries };
}

/**
 * Validate `id` (plus `required`/`version`) against `registry`, then create or
 * update its entry in `.rig/integrations.json`. Upsert, not replace: a field
 * the caller did not pass keeps the PREVIOUSLY recorded value (so a later
 * `add <id>` with no `--required` does not silently drop an earlier
 * `--required`) — `harnesses` is likewise always carried over unchanged,
 * because this verb never sets it. Validation reuses `parseDeclaration`
 * itself (serialize the candidate whole-file shape, then re-parse it against
 * the same registry) rather than re-deriving the registry-membership,
 * version-pattern and exclusive-group rules a second time
 * (`.claude/rules/invariants.md`, "One mechanism, one implementation").
 */
export async function addIntegration(options: AddOptions): Promise<AddOutcome> {
  const registry = options.registry ?? REGISTRY;
  const existing = await readDeclarationEntries(options.repoDir, registry);
  if ('error' in existing) {
    return {
      outcome: 'refused',
      reason: 'declaration-unreadable',
      message: `the existing declaration is invalid: ${existing.error}`,
    };
  }

  const previous = existing.entries.find((entry) => entry.id === options.id);
  const required = options.required ?? previous?.required;
  const version = options.version ?? previous?.version;
  const candidate: DeclaredIntegration = {
    id: options.id,
    ...(required !== undefined ? { required } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(previous?.harnesses !== undefined ? { harnesses: previous.harnesses } : {}),
  };

  const upserted = [...existing.entries.filter((entry) => entry.id !== options.id), candidate];
  const candidateText = serializeDeclaration(upserted);
  const reparsed = parseDeclaration(candidateText, registry);
  if (reparsed.status === 'invalid') {
    // Cannot happen for a document `serializeDeclaration` itself produced —
    // guarded rather than asserted, per the fail-closed rule for a state that
    // "should never" occur.
    return { outcome: 'refused', reason: 'declaration-unreadable', message: reparsed.error };
  }
  const ownRejection = reparsed.rejected.find((rejection) => rejection.id === options.id);
  if (ownRejection !== undefined) {
    return { outcome: 'refused', reason: ownRejection.reason, message: ownRejection.message };
  }
  const collateralRejection = reparsed.rejected[0];
  if (collateralRejection !== undefined) {
    // Adding this entry pushed an EXISTING one into rejection — an exclusive-
    // group conflict with a provider declared earlier, most plausibly.
    // Refuse rather than silently rewrite another entry's fate as a side
    // effect of this one's addition.
    return {
      outcome: 'refused',
      reason: collateralRejection.reason,
      message:
        `adding "${options.id}" would also reject "${collateralRejection.id}"` +
        (collateralRejection.message !== undefined ? `: ${collateralRejection.message}` : ''),
    };
  }

  const finalEntry = reparsed.entries.find((entry) => entry.id === options.id);
  if (finalEntry === undefined) {
    return {
      outcome: 'refused',
      reason: 'declaration-unreadable',
      message: 'the candidate entry vanished on re-parse',
    };
  }
  const finalText = serializeDeclaration(reparsed.entries);
  const changed = existing.raw !== finalText;

  if (options.dryRun === true) {
    return { outcome: 'dry-run', entry: finalEntry, changed };
  }

  const naiveDest = path.join(options.repoDir, ...DECLARATION_REL.split('/'));
  await mkdir(path.dirname(naiveDest), { recursive: true });
  const checked = await resolveWritableInside(options.repoDir, DECLARATION_REL);
  if (checked === null) {
    return {
      outcome: 'refused',
      reason: 'write-refused',
      message: `refusing to write ${DECLARATION_REL} through a symlink or outside the repository`,
    };
  }
  await writeFile(checked, finalText);
  return { outcome: 'written', entry: finalEntry, changed };
}

// ---------------------------------------------------------------------------
// setup verify
// ---------------------------------------------------------------------------

/** What a probe found for one descriptor on one harness, right now. Injectable for tests. */
export type Prober = (descriptor: ProviderDescriptor, harness: Harness) => Promise<ObservedNow>;

/**
 * The only honest default before a route adapter exists: nothing has been
 * checked, and saying so (`unverified`, `no-sanctioned-probe`) is the state
 * vocabulary's own answer for exactly this case — never `missing` (which
 * claims a probe ran and found nothing) and never `installed`.
 */
export const defaultProbe: Prober = async () => ({
  present: false,
  kind: 'unverifiable',
  reason: 'no-sanctioned-probe',
});

type ReceiptStatus = 'absent' | 'present' | 'invalid';

async function readReceiptFor(
  repoDir: string,
  id: string,
): Promise<{ status: ReceiptStatus; receipt?: Receipt }> {
  let raw: string;
  try {
    raw = await readFile(path.join(repoDir, ...RECEIPTS_DIR_REL.split('/'), `${id}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    throw error;
  }
  const parsed = parseReceipt(raw);
  if (parsed.status === 'invalid') return { status: 'invalid' };
  return { status: 'present', receipt: parsed.receipt };
}

async function orphanedReceiptIds(
  repoDir: string,
  acceptedIds: ReadonlySet<string>,
  only: string | undefined,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(repoDir, ...RECEIPTS_DIR_REL.split('/')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (acceptedIds.has(id)) continue;
    if (only !== undefined && id !== only) continue;
    const result = await readReceiptFor(repoDir, id);
    if (result.status === 'present') ids.push(id);
  }
  return ids.sort();
}

export type VerifyHarnessPayload = {
  route: Route;
  automation: 'automatic' | 'guided';
  state: InstanceState;
  observed: { version: string | null; evidence: string[] };
  receipt: ReceiptStatus;
  notObserved: string[];
};

export type VerifyIntegrationPayload = {
  id: string;
  required: boolean;
  mode: Mode;
  harnesses: Partial<Record<Harness, VerifyHarnessPayload>>;
};

export type VerifyPayload = {
  schemaVersion: 1;
  command: 'setup';
  verb: 'verify';
  declaration: 'absent' | 'ok' | 'invalid';
  error?: string;
  integrations: VerifyIntegrationPayload[];
  rejected: Rejection[];
  orphaned: string[];
};

export type VerifyOptions = {
  repoDir: string;
  only?: string;
  registry?: readonly ProviderDescriptor[];
  probe?: Prober;
};

/**
 * Read `.rig/integrations.json` (never write) and classify each declared,
 * accepted integration on every harness it applies to. Exit rule (plan §S4):
 * 1 when the declaration itself is invalid, or when any REQUIRED integration
 * is not `installed` on every one of its applicable harnesses; 0 otherwise —
 * including "no declaration at all", which is success with an empty answer,
 * not a distinct code (`docs/command-contract.md`, "Emptiness is exit 0 plus
 * a field").
 *
 * A REJECTED entry (bad key, unknown id, malformed scalar, exclusive-group
 * conflict) never carries a `required` flag through to this function — the
 * declaration parser drops that context before the entry becomes a
 * `Rejection` — so a rejected entry is surfaced in `rejected` and never
 * affects the exit code on its own. This is the plan's own text taken
 * literally: "exits 1 when any required integration is not installed, and
 * also when the declaration is invalid" — nothing wider.
 */
export async function verifyIntegrations(
  options: VerifyOptions,
): Promise<{ payload: VerifyPayload; exitCode: number }> {
  const registry = options.registry ?? REGISTRY;
  const probe = options.probe ?? defaultProbe;
  const registryById = new Map(registry.map((descriptor) => [descriptor.id, descriptor]));

  let raw: string | undefined;
  try {
    raw = await readFile(path.join(options.repoDir, ...DECLARATION_REL.split('/')), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (raw === undefined) {
    const orphaned = await orphanedReceiptIds(options.repoDir, new Set(), options.only);
    return {
      payload: {
        schemaVersion: 1,
        command: 'setup',
        verb: 'verify',
        declaration: 'absent',
        integrations: [],
        rejected: [],
        orphaned,
      },
      exitCode: 0,
    };
  }

  const parsed = parseDeclaration(raw, registry);
  if (parsed.status === 'invalid') {
    return {
      payload: {
        schemaVersion: 1,
        command: 'setup',
        verb: 'verify',
        declaration: 'invalid',
        error: parsed.error,
        integrations: [],
        rejected: [],
        orphaned: [],
      },
      exitCode: 1,
    };
  }

  const scopedEntries =
    options.only !== undefined
      ? parsed.entries.filter((entry) => entry.id === options.only)
      : parsed.entries;
  const scopedRejected =
    options.only !== undefined
      ? parsed.rejected.filter((rejection) => rejection.id === options.only)
      : parsed.rejected;
  const acceptedIds = new Set(parsed.entries.map((entry) => entry.id));
  const orphaned = await orphanedReceiptIds(options.repoDir, acceptedIds, options.only);

  let anyRequiredNotInstalled = false;
  const integrations: VerifyIntegrationPayload[] = [];
  for (const entry of scopedEntries) {
    const descriptor = registryById.get(entry.id);
    if (descriptor === undefined) continue; // parseDeclaration already enforced membership
    const required = entry.required ?? false;
    // A frozen array cast: `entry.harnesses` is already a subset of
    // `descriptor.routes`'s own keys (parseDeclaration's `isHarnessSubset`),
    // and `Object.keys` of a `Partial<Record<Harness, …>>` erases that at the
    // type level without changing it at runtime.
    const harnessNames = entry.harnesses ?? (Object.keys(descriptor.routes) as Harness[]);
    const receiptResult = await readReceiptFor(options.repoDir, entry.id);

    const harnesses: Partial<Record<Harness, VerifyHarnessPayload>> = {};
    let fullyInstalled = true;
    for (const harness of harnessNames) {
      const routeInfo = descriptor.routes[harness];
      if (routeInfo === undefined) continue;
      const receiptAct = receiptResult.receipt?.acts[harness];
      const baseline: ReceiptBaseline | undefined =
        receiptAct !== undefined
          ? {
              version: receiptAct.observedAfter.version ?? null,
              digest: receiptAct.observedAfter.digest ?? null,
            }
          : undefined;
      const observed = await probe(descriptor, harness);
      const declaredInput: DeclaredInput = { kind: 'accepted', version: entry.version };
      const state = classify(declaredInput, baseline, observed);
      if (state !== 'installed') fullyInstalled = false;

      const receiptStatusForHarness: ReceiptStatus =
        receiptResult.status === 'present'
          ? receiptAct !== undefined
            ? 'present'
            : 'absent'
          : receiptResult.status;

      harnesses[harness] = {
        route: routeInfo.route,
        automation: routeInfo.automation,
        state,
        observed: {
          version: observed.present ? observed.version : null,
          evidence: [],
        },
        receipt: receiptStatusForHarness,
        notObserved: receiptAct?.notObserved ?? ['everything'],
      };
    }
    if (required && !fullyInstalled) anyRequiredNotInstalled = true;
    integrations.push({ id: entry.id, required, mode: descriptor.mode, harnesses });
  }

  return {
    payload: {
      schemaVersion: 1,
      command: 'setup',
      verb: 'verify',
      declaration: 'ok',
      integrations,
      rejected: scopedRejected,
      orphaned,
    },
    exitCode: anyRequiredNotInstalled ? 1 : 0,
  };
}

function renderVerifyProse(payload: VerifyPayload): string {
  if (payload.declaration === 'absent') return 'No .rig/integrations.json in this repository.\n';
  if (payload.declaration === 'invalid') {
    return `The declaration does not parse: ${payload.error}\n`;
  }
  const lines: string[] = [];
  for (const entry of payload.integrations) {
    lines.push(`${entry.id}${entry.required ? ' (required)' : ''}`);
    for (const [harness, harnessPayload] of Object.entries(entry.harnesses)) {
      lines.push(`  ${harness}: ${harnessPayload.state} via ${harnessPayload.route}`);
    }
  }
  for (const rejection of payload.rejected) {
    lines.push(`${rejection.id}: rejected (${rejection.reason})`);
  }
  for (const id of payload.orphaned) {
    lines.push(`${id}: orphaned receipt, no declaration`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : 'Nothing declared.\n';
}

// ---------------------------------------------------------------------------
// CLI dispatch — index.ts calls this once it has recognised one of the three
// new verbs as `rawArgs[0]`; the legacy `--memory-root` path never reaches it.
// ---------------------------------------------------------------------------

export type IntegrationsCliResult = { exitCode: number; stdout: string; stderr: string };

async function runList(
  args: string[],
  registry: readonly ProviderDescriptor[],
): Promise<IntegrationsCliResult> {
  let values: { json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
    }));
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${(error as Error).message}\n` };
  }
  if (positionals.length > 0) {
    return { exitCode: 1, stdout: '', stderr: 'setup list takes no positional arguments.\n' };
  }
  const entries = listRegistry(registry);
  if (values.json === true) {
    const payload = {
      schemaVersion: 1 as const,
      command: 'setup' as const,
      verb: 'list' as const,
      integrations: entries,
    };
    return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: '' };
  }
  return { exitCode: 0, stdout: renderListProse(entries), stderr: '' };
}

async function runAdd(
  args: string[],
  cwd: string,
  registry: readonly ProviderDescriptor[],
): Promise<IntegrationsCliResult> {
  let values: { required?: boolean; version?: string; 'dry-run'?: boolean; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        required: { type: 'boolean' },
        version: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${(error as Error).message}\n` };
  }
  if (positionals.length !== 1) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'setup add needs exactly one <id> (see create-agent-rig --help).\n',
    };
  }
  const id = positionals[0]!;
  const dryRun = values['dry-run'] === true;
  const outcome = await addIntegration({
    repoDir: cwd,
    id,
    required: values.required,
    version: values.version,
    dryRun,
    registry,
  });

  if (values.json === true) {
    const payload: Record<string, unknown> = {
      schemaVersion: 1,
      command: 'setup',
      verb: 'add',
      id,
      dryRun,
      outcome: outcome.outcome,
    };
    if (outcome.outcome === 'refused') {
      payload.reason = outcome.reason;
      if (outcome.message !== undefined) payload.error = outcome.message;
    } else {
      payload.changed = outcome.changed;
      payload.entry = outcome.entry;
    }
    return {
      exitCode: outcome.outcome === 'refused' ? 1 : 0,
      stdout: `${JSON.stringify(payload)}\n`,
      stderr: '',
    };
  }

  if (outcome.outcome === 'refused') {
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        `setup add: refused "${id}" (${outcome.reason})` +
        (outcome.message !== undefined ? ` — ${outcome.message}` : '') +
        '\n',
    };
  }
  const verb = outcome.outcome === 'dry-run' ? 'Would write' : 'Wrote';
  return {
    exitCode: 0,
    stdout: `${verb} ${DECLARATION_REL} — ${id}${outcome.changed ? '' : ' (unchanged)'}\n`,
    stderr: '',
  };
}

async function runVerify(
  args: string[],
  cwd: string,
  registry: readonly ProviderDescriptor[],
  probe: Prober | undefined,
): Promise<IntegrationsCliResult> {
  let values: { only?: string; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: { only: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    }));
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${(error as Error).message}\n` };
  }
  if (positionals.length > 0) {
    return { exitCode: 1, stdout: '', stderr: 'setup verify takes no positional arguments.\n' };
  }
  const { payload, exitCode } = await verifyIntegrations({
    repoDir: cwd,
    only: values.only,
    registry,
    probe,
  });
  if (values.json === true) {
    return { exitCode, stdout: `${JSON.stringify(payload)}\n`, stderr: '' };
  }
  return { exitCode, stdout: renderVerifyProse(payload), stderr: '' };
}

export type IntegrationsCliOptions = {
  verb: string;
  args: string[];
  cwd: string;
  registry?: readonly ProviderDescriptor[];
  probe?: Prober;
};

/** `list`/`add`/`verify` are the only verbs this dispatches; the caller
 * (`index.ts`) checks `rawArgs[0]` against them before ever calling this. */
export const INTEGRATIONS_VERBS = ['list', 'add', 'verify'] as const;

export async function runIntegrationsCommand(
  options: IntegrationsCliOptions,
): Promise<IntegrationsCliResult> {
  const registry = options.registry ?? REGISTRY;
  if (options.verb === 'list') return runList(options.args, registry);
  if (options.verb === 'add') return runAdd(options.args, options.cwd, registry);
  if (options.verb === 'verify')
    return runVerify(options.args, options.cwd, registry, options.probe);
  return {
    exitCode: 1,
    stdout: '',
    stderr: `Unknown setup verb "${options.verb}". Known verbs: ${INTEGRATIONS_VERBS.join(', ')}.\n`,
  };
}
