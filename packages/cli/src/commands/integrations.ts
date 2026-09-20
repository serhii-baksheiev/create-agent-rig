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
//
// RP-22 round 2 (gate cycle 1 findings): `readDeclarationFile` is the ONE
// place either verb reads `.rig/integrations.json`, with one failure policy;
// every filesystem read on this module's paths (the declaration, one
// receipt, the receipts directory) goes through `resolveReadableInside`
// first, which refuses a symlink component in either direction — a
// committed `.rig/integrations.json` pointing outside the repository is
// never silently honoured for reading any more than `resolveWritableInside`
// would silently write through it. `add` never prunes a declaration entry
// the current registry rejects; it preserves it verbatim (see
// `addIntegration`'s own doc comment) and names it. Every read is
// size-bounded before the bytes are loaded (`stat` first), and the receipts
// directory scan is bounded to `MAX_ORPHAN_CANDIDATES` with an explicit
// `orphanScan` signal when the bound is hit or the directory could not be
// read at all. Pinned by packages/cli/test/integrations-cli.test.ts.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DECLARATION_REL,
  DECLARATION_SCHEMA_VERSION,
  MAX_DECLARATION_BYTES,
  VERSION_PATTERN,
  parseDeclaration,
  serializeDeclaration,
  truncateForMessage,
  type DeclaredIntegration,
  type Rejection,
  type RejectionReason,
} from '../integrations/declaration.js';
import {
  MAX_RECEIPT_BYTES,
  RECEIPTS_DIR_REL,
  parseReceipt,
  type Receipt,
} from '../integrations/receipt.js';
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
import { hasControlCharacter } from '../lib/safe-text.js';
import {
  resolveReadableInside,
  resolveWritableInside,
  type SafeReadResult,
} from '../lib/safe-path.js';

const HARNESSES: readonly Harness[] = ['claude-code', 'codex'];

/**
 * Bounded, cheap-to-check display sanitiser for a value that ORIGINATES
 * outside this process — a CLI positional argument, a value read back from a
 * committed file — before it is interpolated into human-facing PROSE
 * (stdout/stderr text, never a `--json` payload: `JSON.stringify` already
 * escapes every control/format character on its own, and truncating an
 * actual data value there would misrepresent it). Truncates first
 * (`truncateForMessage`, the same 64-character cap `declaration.ts` and
 * `receipt.ts` already use — bounding the per-character pass below to at
 * most 65 code points regardless of the input's real length), then replaces
 * every character `hasControlCharacter` — the SAME predicate `declaration.ts`
 * and `receipt.ts` scan committed input with — flags, with U+FFFD. Closes the
 * gap gate cycle 1 measured: an OSC/CSI-shaped `<id>` on `setup add` forged a
 * fake success line on a terminal that interprets escape sequences (RP-22
 * round 2, advisory).
 */
function sanitizeForDisplay(value: string): string {
  const truncated = truncateForMessage(value);
  return [...truncated]
    .map((character) => (hasControlCharacter(character) ? '�' : character))
    .join('');
}

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
// Shared, symlink-safe, bounded reads (RP-22 round 2, blocker 2)
//
// ONE function reads `.rig/integrations.json` for both `add` and `verify`,
// with ONE failure policy, so the two can never quietly diverge on what
// counts as "unreadable" the way gate cycle 1 found them doing (`verify`
// rethrew a non-ENOENT errno as an uncaught exception; `add` already refused
// it gracefully). Every read this module performs — the declaration, one
// receipt, the receipts directory — walks through `resolveReadableInside`
// first: a symlink component is refused, never followed, in either
// direction, and a file/directory type mismatch (`EISDIR`/`ENOTDIR` waiting
// to happen) is caught before any read is attempted. Size is checked with a
// `stat` before the bytes are loaded, so an oversized file is refused
// without ever being read whole into memory.
// ---------------------------------------------------------------------------

function ioErrorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'unknown error';
}

function describeUnsafeRead(
  resolved: Extract<SafeReadResult, { status: 'unsafe' }>,
  label: string,
): string {
  switch (resolved.reason) {
    case 'symlink':
      return `${label} path contains a symlink component`;
    case 'wrong-kind':
      return `${label} path is not the expected kind of entry`;
    case 'escapes-root':
      return `${label} path resolves outside the repository`;
    case 'io-error':
      return `${label} could not be read (${resolved.code ?? 'unknown error'})`;
    /* c8 ignore next 2 -- exhaustiveness guard: SafeReadResult's reason union is closed */
    default: {
      const exhaustive: never = resolved.reason;
      return `${label} could not be read (${String(exhaustive)})`;
    }
  }
}

export type DeclarationRead =
  | { status: 'absent' }
  | { status: 'ok'; raw: string; entries: DeclaredIntegration[]; rejected: Rejection[] }
  /**
   * `symlink` distinguishes ONE sub-case a caller may treat differently:
   * `add` proceeds as if there were nothing to preserve when the ONLY
   * problem is a symlink (the write step below refuses the identical path
   * anyway, so nothing is ever silently trusted or overwritten), but refuses
   * outright, bytes untouched, for every OTHER invalid shape — bad JSON, an
   * oversized file, a control character, a directory sitting at the path, a
   * genuine I/O error — where retrying as a write would either repeat the
   * same unreadable shape or throw a raw `EISDIR` out of `writeFile`.
   * `verify` ignores this flag entirely: any `invalid` is reported the same
   * way, because it never writes.
   */
  | { status: 'invalid'; error: string; symlink: boolean };

async function readDeclarationFile(
  repoDir: string,
  registry: readonly ProviderDescriptor[],
): Promise<DeclarationRead> {
  const resolved = await resolveReadableInside(repoDir, DECLARATION_REL, 'file');
  if (resolved.status === 'absent') return { status: 'absent' };
  if (resolved.status === 'unsafe') {
    return {
      status: 'invalid',
      error: describeUnsafeRead(resolved, 'the declaration'),
      symlink: resolved.reason === 'symlink',
    };
  }

  let size: number;
  try {
    size = (await stat(resolved.path)).size;
  } catch (error) {
    return {
      status: 'invalid',
      error: `the declaration could not be read (${ioErrorCode(error)})`,
      symlink: false,
    };
  }
  if (size > MAX_DECLARATION_BYTES) {
    return { status: 'invalid', error: 'the declaration is larger than 64 KiB', symlink: false };
  }

  let raw: string;
  try {
    raw = await readFile(resolved.path, 'utf8');
  } catch (error) {
    return {
      status: 'invalid',
      error: `the declaration could not be read (${ioErrorCode(error)})`,
      symlink: false,
    };
  }

  const parsed = parseDeclaration(raw, registry);
  if (parsed.status === 'invalid')
    return { status: 'invalid', error: parsed.error, symlink: false };
  return { status: 'ok', raw, entries: parsed.entries, rejected: parsed.rejected };
}

type ReceiptStatus = 'absent' | 'present' | 'invalid';

async function readReceiptFile(
  repoDir: string,
  id: string,
): Promise<{ status: ReceiptStatus; receipt?: Receipt }> {
  const resolved = await resolveReadableInside(repoDir, `${RECEIPTS_DIR_REL}/${id}.json`, 'file');
  if (resolved.status === 'absent') return { status: 'absent' };
  if (resolved.status === 'unsafe') return { status: 'invalid' };

  let size: number;
  try {
    size = (await stat(resolved.path)).size;
  } catch {
    return { status: 'invalid' };
  }
  if (size > MAX_RECEIPT_BYTES) return { status: 'invalid' };

  let raw: string;
  try {
    raw = await readFile(resolved.path, 'utf8');
  } catch {
    return { status: 'invalid' };
  }
  const parsed = parseReceipt(raw);
  if (parsed.status === 'invalid') return { status: 'invalid' };
  return { status: 'present', receipt: parsed.receipt };
}

/**
 * The most orphan CANDIDATES one `verify` run reads and parses. Sized well
 * above any real project's integration count. The cost this bounds is the
 * per-candidate file I/O (a symlink-safe walk plus a bounded read) inside
 * the loop below, not the `readdir` call itself — so the cap applies to the
 * CANDIDATE list (already filtered to `.json` names, already excluding
 * accepted ids and any `--only` mismatch), never to the raw directory entry
 * count. Measured (gate cycle 1): an unbounded scan over 30 000 files took
 * 13.8 s.
 */
export const MAX_ORPHAN_CANDIDATES = 500;

export type OrphanScan = 'complete' | 'truncated' | 'unreadable';

async function scanOrphanedReceipts(
  repoDir: string,
  acceptedIds: ReadonlySet<string>,
  only: string | undefined,
): Promise<{ orphaned: string[]; scan: OrphanScan }> {
  const resolved = await resolveReadableInside(repoDir, RECEIPTS_DIR_REL, 'directory');
  if (resolved.status === 'absent') return { orphaned: [], scan: 'complete' };
  // Unreadable is reported, not silenced into "no orphans": a directory
  // that could not be read is not evidence of an empty one.
  if (resolved.status === 'unsafe') return { orphaned: [], scan: 'unreadable' };

  let names: string[];
  try {
    names = await readdir(resolved.path);
  } catch {
    return { orphaned: [], scan: 'unreadable' };
  }

  const candidates = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => !acceptedIds.has(id))
    .filter((id) => only === undefined || id === only)
    .sort();

  const scan: OrphanScan = candidates.length > MAX_ORPHAN_CANDIDATES ? 'truncated' : 'complete';
  const bounded = candidates.slice(0, MAX_ORPHAN_CANDIDATES);

  const orphaned: string[] = [];
  for (const id of bounded) {
    const result = await readReceiptFile(repoDir, id);
    if (result.status === 'present') orphaned.push(id);
  }
  return { orphaned, scan };
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
  /** The on-disk declaration does not parse (and is not merely a symlink), so a safe upsert is impossible. */
  | 'declaration-unreadable'
  /** `resolveWritableInside` refused the write (a symlink, or an escape). */
  | 'write-refused';

export type AddOutcome =
  | {
      outcome: 'written' | 'dry-run';
      entry: DeclaredIntegration;
      changed: boolean;
      /** Ids this call preserved verbatim because the CURRENT registry rejects them — never pruned silently. */
      preservedRejected: string[];
    }
  | { outcome: 'refused'; reason: AddRefusalReason; message?: string };

/**
 * Re-parse the raw declaration text to recover each entry's ORIGINAL,
 * unmodified JSON value. Safe to call only once `readDeclarationFile` has
 * already returned `status: 'ok'` for this same `raw` — that already proved
 * the whole file is well-formed JSON, within depth and control-character
 * bounds, with `integrations` an array of plain objects each carrying a
 * unique string `id` (`parseDeclaration`'s own file-level checks). This is
 * the ONLY way to recover a REJECTED entry's original shape:
 * `parseDeclaration`'s `rejected` array is evidence for a human (an id and a
 * reason), never a value meant to round-trip.
 */
function rawIntegrationEntries(raw: string): Record<string, unknown>[] {
  const root = JSON.parse(raw) as { integrations: Record<string, unknown>[] };
  return root.integrations;
}

/**
 * Byte-stable ordering, extended for preserved-rejected entries (RP-22
 * round 2, blocker 1): accepted entries and verbatim preserved-rejected raw
 * entries sort together, by `id`, in ONE list — the same key
 * `serializeDeclaration` itself sorts accepted entries by, so the file's
 * overall ordering rule does not fork into "accepted entries here, rejected
 * ones somewhere else". A preserved entry's OWN fields are never rewritten
 * or normalised: it is written back exactly as `JSON.parse` produced it
 * (the same keys, in the same order — a JS object preserves string-key
 * insertion order — the same values), never routed through
 * `serializeDeclaration`'s per-entry canonical shape. "Verbatim" means the
 * same JSON VALUE, not the same original file bytes: the file as a whole is
 * still always re-serialized with the two-space-indent, trailing-newline
 * convention this format always uses — there is no partial-file, leave-the-
 * rest-untouched write mode here, any more than there is one for `upgrade`.
 */
function serializeWithPreservedRejected(
  accepted: readonly DeclaredIntegration[],
  preservedRaw: readonly Record<string, unknown>[],
): string {
  const canonical = JSON.parse(serializeDeclaration(accepted)) as {
    integrations: Record<string, unknown>[];
  };
  const merged = [...canonical.integrations, ...preservedRaw].sort((a, b) => {
    const aId = a.id as string;
    const bId = b.id as string;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
  return `${JSON.stringify(
    { schemaVersion: DECLARATION_SCHEMA_VERSION, integrations: merged },
    null,
    2,
  )}\n`;
}

/**
 * Validate `id` (plus `required`/`version`) against `registry`, then create
 * or update its entry in `.rig/integrations.json`. Upsert, not replace: a
 * field the caller did not pass keeps the PREVIOUSLY recorded value (so a
 * later `add <id>` with no `--required` does not silently drop an earlier
 * `--required`) — `harnesses` is likewise always carried over unchanged,
 * because this verb never sets it. Validation reuses `parseDeclaration`
 * itself (serialize the candidate whole-file shape, then re-parse it against
 * the same registry) rather than re-deriving the registry-membership,
 * version-pattern and exclusive-group rules a second time
 * (`.claude/rules/invariants.md`, "One mechanism, one implementation").
 *
 * **Every entry the CURRENT registry rejects is preserved verbatim**, never
 * pruned (RP-22 round 2, blocker 1): a declaration naming a provider this
 * release's registry does not (yet) know about — or one that fails a rule a
 * later registry change tightened — is evidence someone wants that
 * provider, and `add` has no business erasing it just because it was asked
 * to write a DIFFERENT id. Their ids are returned in `preservedRejected`, so
 * a caller (and the prose renderer) can say so.
 */
export async function addIntegration(options: AddOptions): Promise<AddOutcome> {
  const registry = options.registry ?? REGISTRY;
  const read = await readDeclarationFile(options.repoDir, registry);

  let previousEntries: DeclaredIntegration[] = [];
  let previousRaw: string | undefined;
  let previousRawEntries: Record<string, unknown>[] = [];
  let previousRejectedIds = new Set<string>();

  if (read.status === 'ok') {
    previousEntries = read.entries;
    previousRaw = read.raw;
    previousRawEntries = rawIntegrationEntries(read.raw);
    previousRejectedIds = new Set(read.rejected.map((rejection) => rejection.id));
  } else if (read.status === 'invalid' && !read.symlink) {
    // Bytes on disk are left exactly as they are — this is a refusal, not an
    // attempt that failed partway.
    return {
      outcome: 'refused',
      reason: 'declaration-unreadable',
      message: `the existing declaration is invalid: ${read.error}`,
    };
  }
  // Otherwise: `read.status === 'absent'`, or `'invalid'` for a symlink
  // specifically — proceed with nothing to preserve. The write step below
  // re-resolves the identical path and refuses the symlink case the same
  // way `resolveWritableInside` always has, so nothing is ever silently
  // trusted from, or overwritten through, a symlinked declaration.

  const preservedRaw = previousRawEntries.filter(
    (entry) => entry.id !== options.id && previousRejectedIds.has(entry.id as string),
  );

  const previous = previousEntries.find((entry) => entry.id === options.id);
  const required = options.required ?? previous?.required;
  const version = options.version ?? previous?.version;
  const candidate: DeclaredIntegration = {
    id: options.id,
    ...(required !== undefined ? { required } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(previous?.harnesses !== undefined ? { harnesses: previous.harnesses } : {}),
  };

  const upsertedAccepted = [
    ...previousEntries.filter((entry) => entry.id !== options.id),
    candidate,
  ];
  const candidateText = serializeDeclaration(upsertedAccepted);
  const reparsed = parseDeclaration(candidateText, registry);
  /* c8 ignore start -- defensive: candidateText is `serializeDeclaration`'s own closed output shape */
  if (reparsed.status === 'invalid') {
    return { outcome: 'refused', reason: 'declaration-unreadable', message: reparsed.error };
  }
  /* c8 ignore stop */

  const ownRejection = reparsed.rejected.find((rejection) => rejection.id === options.id);
  if (ownRejection !== undefined) {
    let message = ownRejection.message;
    if (ownRejection.reason === 'not-in-matrix') {
      message = `"${sanitizeForDisplay(options.id)}" is not in the registry — see \`setup list\` for the supported ids`;
    } else if (ownRejection.reason === 'malformed' && message === undefined) {
      message = `the version pin does not match the accepted pattern ${VERSION_PATTERN.source}`;
    }
    return { outcome: 'refused', reason: ownRejection.reason, message };
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
        `adding "${sanitizeForDisplay(options.id)}" would also reject "${sanitizeForDisplay(collateralRejection.id)}"` +
        (collateralRejection.message !== undefined ? `: ${collateralRejection.message}` : ''),
    };
  }

  const finalEntry = reparsed.entries.find((entry) => entry.id === options.id);
  /* c8 ignore start -- defensive: `options.id` is exactly the id `candidate` was built with, above */
  if (finalEntry === undefined) {
    return {
      outcome: 'refused',
      reason: 'declaration-unreadable',
      message: 'the candidate entry vanished on re-parse',
    };
  }
  /* c8 ignore stop */

  const finalText = serializeWithPreservedRejected(reparsed.entries, preservedRaw);
  const changed = previousRaw !== finalText;
  const preservedRejected = preservedRaw.map((entry) => entry.id as string).sort();

  // Containment is decided BEFORE anything is created (RP-22 round 2,
  // blocker 3): a `.rig` committed as a (possibly dangling) symlink must be
  // refused by `resolveWritableInside`'s own per-segment symlink check, not
  // crash inside a naive `mkdir` that runs before that check ever sees it.
  // This also makes `--dry-run` honest against the SAME shape a real run
  // would refuse — a dry run against a symlinked declaration reports
  // `refused`, not a falsely clean `dry-run` outcome.
  const preflight = await resolveWritableInside(options.repoDir, DECLARATION_REL);
  if (preflight === null) {
    return {
      outcome: 'refused',
      reason: 'write-refused',
      message: `refusing to write ${DECLARATION_REL} through a symlink or outside the repository`,
    };
  }

  if (options.dryRun === true) {
    return { outcome: 'dry-run', entry: finalEntry, changed, preservedRejected };
  }

  // `resolveWritableInside`'s own contract: call once to check (tolerating a
  // missing `.rig/`), create the directory, then call it again immediately
  // before the write — the second call makes the newly created chain
  // evidence too, closing the window between the first check and `mkdir`.
  await mkdir(path.dirname(preflight), { recursive: true });
  const checked = await resolveWritableInside(options.repoDir, DECLARATION_REL);
  if (checked === null) {
    return {
      outcome: 'refused',
      reason: 'write-refused',
      message: `refusing to write ${DECLARATION_REL} through a symlink or outside the repository`,
    };
  }
  await writeFile(checked, finalText);
  return { outcome: 'written', entry: finalEntry, changed, preservedRejected };
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

/**
 * The closed value domains this payload carries (RP-22 round 2 advisory —
 * enumerated here so RP-21's doctor mapping, and `docs/command-contract.md`,
 * have one place to read them from):
 *
 * - `declaration`: `absent | ok | invalid`.
 * - per-harness `receipt`: `absent | present | invalid`.
 * - `orphanScan`: `complete | truncated | unreadable`.
 * - per-harness `state`: `InstanceState` (`../integrations/state.ts`).
 */
export type VerifyPayload = {
  schemaVersion: 1;
  command: 'setup';
  verb: 'verify';
  declaration: 'absent' | 'ok' | 'invalid';
  error?: string;
  integrations: VerifyIntegrationPayload[];
  rejected: Rejection[];
  orphaned: string[];
  orphanScan: OrphanScan;
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
 *
 * **Fail closed on an unreadable receipt (RP-22 round 2, blocker 2).** A
 * receipt that exists but could not be read (a symlink, an oversized file,
 * a parse failure) never lets a harness read `installed` — the very record
 * that would back that claim is exactly what could not be examined, so the
 * state is downgraded to `unverified` instead. This applies whether or not
 * the integration is `required`: an optional integration's `verify` output
 * is read by a human too, and a silent "installed" behind an unreadable
 * receipt is misplaced confidence either way.
 */
export async function verifyIntegrations(
  options: VerifyOptions,
): Promise<{ payload: VerifyPayload; exitCode: number }> {
  const registry = options.registry ?? REGISTRY;
  const probe = options.probe ?? defaultProbe;
  const registryById = new Map(registry.map((descriptor) => [descriptor.id, descriptor]));

  const read = await readDeclarationFile(options.repoDir, registry);

  if (read.status === 'absent') {
    const { orphaned, scan } = await scanOrphanedReceipts(options.repoDir, new Set(), options.only);
    return {
      payload: {
        schemaVersion: 1,
        command: 'setup',
        verb: 'verify',
        declaration: 'absent',
        integrations: [],
        rejected: [],
        orphaned,
        orphanScan: scan,
      },
      exitCode: 0,
    };
  }

  if (read.status === 'invalid') {
    // Orphan detection does not depend on the declaration parsing — an
    // unparseable `.rig/integrations.json` says nothing about whether
    // `.rig/receipts/` itself has anything worth reporting.
    const { orphaned, scan } = await scanOrphanedReceipts(options.repoDir, new Set(), options.only);
    return {
      payload: {
        schemaVersion: 1,
        command: 'setup',
        verb: 'verify',
        declaration: 'invalid',
        error: read.error,
        integrations: [],
        rejected: [],
        orphaned,
        orphanScan: scan,
      },
      exitCode: 1,
    };
  }

  const scopedEntries =
    options.only !== undefined
      ? read.entries.filter((entry) => entry.id === options.only)
      : read.entries;
  const scopedRejected =
    options.only !== undefined
      ? read.rejected.filter((rejection) => rejection.id === options.only)
      : read.rejected;
  const acceptedIds = new Set(read.entries.map((entry) => entry.id));
  const { orphaned, scan } = await scanOrphanedReceipts(options.repoDir, acceptedIds, options.only);

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
    const receiptResult = await readReceiptFile(options.repoDir, entry.id);

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
      let state = classify(declaredInput, baseline, observed);

      const receiptStatusForHarness: ReceiptStatus =
        receiptResult.status === 'present'
          ? receiptAct !== undefined
            ? 'present'
            : 'absent'
          : receiptResult.status;

      // Fail closed: an unreadable receipt never counts as confirming
      // `installed` (see the doc comment above).
      if (receiptStatusForHarness === 'invalid' && state === 'installed') {
        state = 'unverified';
      }
      if (state !== 'installed') fullyInstalled = false;

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
      orphanScan: scan,
    },
    exitCode: anyRequiredNotInstalled ? 1 : 0,
  };
}

function renderVerifyProse(payload: VerifyPayload, only: string | undefined): string {
  if (payload.declaration === 'absent') return 'No .rig/integrations.json in this repository.\n';
  if (payload.declaration === 'invalid') {
    return `The declaration does not parse: ${sanitizeForDisplay(payload.error ?? '')}\n`;
  }
  const lines: string[] = [];
  for (const entry of payload.integrations) {
    lines.push(`${sanitizeForDisplay(entry.id)}${entry.required ? ' (required)' : ''}`);
    for (const [harness, harnessPayload] of Object.entries(entry.harnesses)) {
      lines.push(`  ${harness}: ${harnessPayload.state} via ${harnessPayload.route}`);
    }
  }
  for (const rejection of payload.rejected) {
    lines.push(`${sanitizeForDisplay(rejection.id)}: rejected (${rejection.reason})`);
  }
  for (const id of payload.orphaned) {
    lines.push(`${sanitizeForDisplay(id)}: orphaned receipt, no declaration`);
  }
  if (lines.length > 0) return `${lines.join('\n')}\n`;
  // Distinguish "nothing declared at all" from "--only named something not
  // present here" (RP-22 round 2, CLI-UX advisory) — the two used to print
  // the identical "Nothing declared." line.
  if (only !== undefined) {
    return `No integration named "${sanitizeForDisplay(only)}" is declared here.\n`;
  }
  return 'Nothing declared.\n';
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
      payload.preservedRejected = outcome.preservedRejected;
    }
    return {
      exitCode: outcome.outcome === 'refused' ? 1 : 0,
      stdout: `${JSON.stringify(payload)}\n`,
      stderr: '',
    };
  }

  const displayId = sanitizeForDisplay(id);
  if (outcome.outcome === 'refused') {
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        `setup add: refused "${displayId}" (${outcome.reason})` +
        (outcome.message !== undefined ? ` — ${sanitizeForDisplay(outcome.message)}` : '') +
        '\n',
    };
  }
  const verb = outcome.outcome === 'dry-run' ? 'Would write' : 'Wrote';
  const preservedNote =
    outcome.preservedRejected.length > 0
      ? ` (also preserved ${outcome.preservedRejected.length} rejected entr${outcome.preservedRejected.length === 1 ? 'y' : 'ies'}: ${outcome.preservedRejected.map(sanitizeForDisplay).join(', ')})`
      : '';
  return {
    exitCode: 0,
    stdout: `${verb} ${DECLARATION_REL} — ${displayId}${outcome.changed ? '' : ' (unchanged)'}${preservedNote}\n`,
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
  return { exitCode, stdout: renderVerifyProse(payload, values.only), stderr: '' };
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
