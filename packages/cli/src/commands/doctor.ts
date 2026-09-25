import { parseArgs } from 'node:util';
import { MANIFEST_REL, parseManifest, sha256 } from '../lib/manifest.js';
import { readBounded, verifyIntegrations } from '../integrations/verify.js';
import {
  DECLARATION_REL,
  MAX_DECLARATION_BYTES,
  parseDeclaration,
} from '../integrations/declaration.js';
import { REGISTRY } from '../integrations/registry.js';
import {
  inspectSpecKit,
  SPEC_KIT_VERSION,
  type SpecKitInspection,
} from '../integrations/spec-kit.js';
import { inspectMemory } from '../integrations/memory-doctor.js';
import { inspectGuards } from '../integrations/doctor-guards.js';
import { inspectWorkflow } from '../integrations/doctor-workflow.js';
import { packageVersion } from '../lib/version.js';
import type { runProviderProcess } from '../integrations/spawn.js';
import { locateRegion, MAX_AGENTS_MD_REGION_BYTES } from '../lib/agents-md-region.js';

type Status = 'pass' | 'warn' | 'fail';
/**
 * Per-reason counts for `rig-owned-files` — carried through to the report so
 * a caller can see absence and content drift at once instead of `reason`'s
 * single precedence-picked word masking one behind the other (RP-239 A2). No
 * paths in it: that is `ownedFilePaths`'/`fix`'s job.
 */
type OwnedFileCounts = {
  absent: number;
  contentDrift: number;
  lineDrift: number;
  unreadable: number;
};
type OwnedFilePaths = {
  absent: string[];
  contentDrift: string[];
  lineDrift: string[];
  unreadable: string[];
};
type Check = {
  id: string;
  status: Status;
  reason: string;
  /**
   * Raw CLI and manifest-recorded versions, carried from `rigChecks` only for
   * `id: 'rig-version'` — used to build the human-facing `detail`/`fix` text
   * below and stripped before the record reaches the report (RP-229).
   */
  rigVersion?: { cli: string; repository: string };
  /** `rig-owned-files` only — reaches the report as-is; see `OwnedFileCounts`. */
  counts?: OwnedFileCounts;
  /**
   * `rig-owned-files` only — the specific paths behind each count above,
   * carried from `rigChecks` only to build the bounded `fix` text below and
   * stripped before the record reaches the report. A path appears in NO
   * other field on this record — not `reason`, not `detail` — only `fix`
   * (RP-239 A2; docs/command-contract.md, "fix is also the one field ... that
   * may name a file path").
   */
  ownedFilePaths?: OwnedFilePaths;
  /**
   * `personal-tracker` only, and only on the `warn` outcome — the required
   * tracker credential env var NAMES this run found missing. Carried from
   * `personalTrackerCheck` only to build `fix` below and stripped before the
   * record reaches the report; never surfaced in `reason` or `detail`
   * (RP-230 — variable VALUES must never appear anywhere in the payload, and
   * NAMES appear only in `fix`).
   */
  trackerMissingVars?: string[];
};
export type DoctorOptions = {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the guard fixture batch runner; production callers never pass it. */
  guardRunner?: typeof runProviderProcess;
};
export type DoctorResult = { exitCode: number; stdout: string; stderr: string };

const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;

/** Strict `major.minor.patch` parse — `null` for anything else (prerelease, garbage). */
function strictSemver(raw: string): [number, number, number] | null {
  if (!STRICT_SEMVER.test(raw)) return null;
  const [major, minor, patch] = raw.split('.').map(Number);
  return [major!, minor!, patch!];
}

/** `-1` when `a` < `b`, `0` when equal, `1` when `a` > `b`. */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * The `rig-version` fix text differs by reason (RP-229): `cli-older-than-repository`
 * names the exact recorded version to update to, while `version-uncomparable`
 * cannot — the recorded value may itself be the garbage that broke the
 * comparison — so it sends the developer to compare by hand instead. Both
 * name `setup` and `upgrade` as the operations to hold off on.
 */
function rigVersionFix(reason: string, versions: { cli: string; repository: string }): string {
  if (reason === 'cli-older-than-repository') {
    return `Update create-agent-rig to at least ${versions.repository} before running setup or upgrade in this repository.`;
  }
  return "Compare the CLI version with the version recorded in this repository's manifest by hand before running setup or upgrade.";
}

/** Bounded so a repository with an unusually large drift never grows `fix` without limit. */
const MAX_NAMED_OWNED_FILES = 10;

/**
 * Bounded, human-facing list of the specific paths behind a `rig-owned-files`
 * warning/failure. Paths appear ONLY here — never in `reason` or `detail`
 * (RP-239 A2; docs/command-contract.md, "fix is also the one field ... that
 * may name a file path"). Ordered unreadable, absent, content-drift,
 * line-drift — the same precedence `reason` itself uses.
 */
function ownedFilesFix(paths: OwnedFilePaths): string {
  const all = [...paths.unreadable, ...paths.absent, ...paths.contentDrift, ...paths.lineDrift];
  const named = all.slice(0, MAX_NAMED_OWNED_FILES);
  const remaining = all.length - named.length;
  const list = remaining > 0 ? `${named.join(', ')}, and ${remaining} more` : named.join(', ');
  return `Review the installation with create-agent-rig upgrade before accepting changes. Affected: ${list}.`;
}

function text(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const QUEUE_CONFIG_REL = '.claude/queue.json';
const CODEX_HOOKS_REL = '.codex/hooks.json';
/** Both are small, hand-edited config files — same bound as `DECLARATION_REL`. */
const MAX_PERSONAL_CHECK_BYTES = 64 * 1024;

/**
 * Required tracker credential env var NAMES, by queue adapter (RP-230).
 * `plan-md` needs nothing and `github-issues` delegates auth entirely to the
 * `gh` CLI, so both map to an empty list — present, not omitted, so a typo'd
 * adapter name is visibly "unknown to this map" rather than silently the same
 * as "needs nothing".
 *
 * `jira`'s list is a second copy of
 * `templates/agent-os/universal/.claude/scripts/queue/jira.mjs`'s own
 * `requireCredentials` (`jira.mjs:284`,
 * `['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']`) — that file is
 * template payload this package copies into a generated project, not a
 * module the CLI can import at runtime, so the names are duplicated here by
 * hand rather than shared. Keep the two lists in sync when either changes.
 */
const TRACKER_REQUIRED_ENV: Record<string, string[]> = {
  'plan-md': [],
  'github-issues': [],
  jira: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
};

/**
 * Presence-only report of the tracker credential env vars the repository's
 * own `.claude/queue.json` adapter requires (RP-230). `undefined` — no check
 * emitted at all — when there is nothing personal to check: no queue.json,
 * an unreadable or unparseable one, or an adapter this map does not require
 * anything for (`plan-md`, `github-issues`, or a name this map does not
 * know). Never inspects a credential VALUE, only whether its env var NAME is
 * set.
 */
async function personalTrackerCheck(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<Check | undefined> {
  const source = await readBounded(root, QUEUE_CONFIG_REL, MAX_PERSONAL_CHECK_BYTES);
  if (source.status !== 'ok') return undefined;
  const decoded = text(source.bytes);
  if (decoded === undefined) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  const adapter =
    config !== null &&
    typeof config === 'object' &&
    typeof (config as { adapter?: unknown }).adapter === 'string'
      ? (config as { adapter: string }).adapter
      : 'plan-md';
  const required = TRACKER_REQUIRED_ENV[adapter];
  if (required === undefined || required.length === 0) return undefined;
  const missing = required.filter((name) => !env[name]);
  if (missing.length === 0) {
    return { id: 'personal-tracker', status: 'pass', reason: 'tracker-credentials-present' };
  }
  return {
    id: 'personal-tracker',
    status: 'warn',
    reason: 'tracker-credentials-missing',
    trackerMissingVars: missing,
  };
}

/**
 * Diagnostic-only presence check for this repository's checked-in Codex
 * hook wiring (RP-230). Emitted only when `.codex/hooks.json` exists, and
 * always `warn` — Codex's own trust state for those hooks is not something
 * doctor has a deterministic signal for, so this never claims they are
 * active or already trusted.
 */
async function codexHookTrustCheck(root: string): Promise<Check | undefined> {
  const source = await readBounded(root, CODEX_HOOKS_REL, MAX_PERSONAL_CHECK_BYTES);
  if (source.status === 'absent') return undefined;
  return { id: 'codex-hook-trust', status: 'warn', reason: 'codex-hooks-need-review' };
}

async function rigChecks(root: string, codexHash?: string): Promise<Check[]> {
  const source = await readBounded(root, MANIFEST_REL, 1024 * 1024);
  if (source.status === 'absent')
    return [{ id: 'rig-manifest', status: 'warn', reason: 'not-installed' }];
  const decoded = source.status === 'ok' ? text(source.bytes) : undefined;
  const manifest = decoded === undefined ? null : parseManifest(decoded);
  if (manifest === null || Object.keys(manifest.files).length > 4096)
    return [{ id: 'rig-manifest', status: 'fail', reason: 'unreadable-manifest' }];
  const checks: Check[] = [{ id: 'rig-manifest', status: 'pass', reason: 'valid' }];
  const manifestVersion = strictSemver(manifest.version);
  // `packageVersion()` reads and parses this package's own `package.json` —
  // if that read or parse throws, the rig-version check degrades to
  // `version-uncomparable` rather than failing the whole doctor run.
  let cliRaw: string | undefined;
  try {
    cliRaw = await packageVersion();
  } catch {
    cliRaw = undefined;
  }
  const cliVersion = cliRaw === undefined ? null : strictSemver(cliRaw);
  const rigVersion = { cli: cliRaw ?? '', repository: manifest.version };
  if (manifestVersion === null || cliVersion === null) {
    checks.push({ id: 'rig-version', status: 'warn', reason: 'version-uncomparable', rigVersion });
  } else {
    const cmp = compareSemver(manifestVersion, cliVersion);
    checks.push({
      id: 'rig-version',
      status: cmp > 0 ? 'warn' : 'pass',
      reason:
        cmp > 0
          ? 'cli-older-than-repository'
          : cmp < 0
            ? 'repository-older-than-cli'
            : 'versions-match',
      rigVersion,
    });
  }
  const ownedFilePaths: OwnedFilePaths = {
    absent: [],
    contentDrift: [],
    lineDrift: [],
    unreadable: [],
  };
  for (const [rel, recorded] of Object.entries(manifest.files)) {
    const expected = rel === '.codex/config.toml' ? (codexHash ?? recorded) : recorded;
    const file = await readBounded(root, rel, 1024 * 1024);
    if (file.status === 'absent') {
      ownedFilePaths.absent.push(rel);
      continue;
    }
    if (file.status !== 'ok') {
      ownedFilePaths.unreadable.push(rel);
      continue;
    }
    if (sha256(file.bytes) === expected) continue;
    const decodedFile = text(file.bytes);
    if (
      decodedFile !== undefined &&
      (sha256(decodedFile.replace(/\r\n/g, '\n')) === expected ||
        sha256(decodedFile.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')) === expected)
    )
      ownedFilePaths.lineDrift.push(rel);
    else ownedFilePaths.contentDrift.push(rel);
  }
  const counts: OwnedFileCounts = {
    absent: ownedFilePaths.absent.length,
    contentDrift: ownedFilePaths.contentDrift.length,
    lineDrift: ownedFilePaths.lineDrift.length,
    unreadable: ownedFilePaths.unreadable.length,
  };
  checks.push({
    id: 'rig-owned-files',
    status:
      counts.unreadable > 0
        ? 'fail'
        : counts.absent > 0 || counts.contentDrift > 0 || counts.lineDrift > 0
          ? 'warn'
          : 'pass',
    reason:
      counts.unreadable > 0
        ? 'unreadable-owned-file'
        : counts.absent > 0
          ? 'absent-owned-file'
          : counts.contentDrift > 0
            ? 'content-drift'
            : counts.lineDrift > 0
              ? 'line-ending-drift'
              : 'pristine',
    counts,
    ownedFilePaths,
  });
  // RP-256 slice 2: the AGENTS.md managed region, judged the same way
  // `rig-owned-files` judges an ordinary file — `pass` (reported as `ok`,
  // like every other check here) when it is intact and its body's hash
  // still matches what the manifest vouches for, `warn` otherwise (the
  // region missing entirely, its markers malformed, or its body edited
  // since install). Absent from the report altogether when nothing is
  // region-tracked — a clean, pre-RP-256-slice-2 install has nothing new to
  // say here.
  const regionRecordedHash = manifest.regions?.['AGENTS.md'];
  if (regionRecordedHash !== undefined) {
    const file = await readBounded(root, 'AGENTS.md', MAX_AGENTS_MD_REGION_BYTES);
    const decodedRegionFile = file.status === 'ok' ? text(file.bytes) : undefined;
    const located = decodedRegionFile === undefined ? null : locateRegion(decodedRegionFile);
    const intact = located !== null && sha256(located.body) === regionRecordedHash;
    checks.push({
      id: 'rig-managed-regions',
      status: intact ? 'pass' : 'warn',
      reason:
        file.status === 'absent'
          ? 'region-file-missing'
          : file.status !== 'ok'
            ? 'region-file-unreadable'
            : intact
              ? 'pristine'
              : located === null
                ? 'region-markers-missing'
                : 'region-edited',
    });
  }
  return checks;
}

/** Read-only diagnosis. Runtime observations are returned, never persisted. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  let json: boolean;
  try {
    const parsed = parseArgs({
      args: options.args,
      allowPositionals: false,
      options: { json: { type: 'boolean' } },
    });
    json = parsed.values.json === true;
  } catch {
    return { exitCode: 2, stdout: '', stderr: 'doctor accepts only --json\n' };
  }
  const source = await readBounded(options.cwd, DECLARATION_REL, MAX_DECLARATION_BYTES);
  const declaration =
    source.status === 'ok' ? parseDeclaration(text(source.bytes) ?? '', REGISTRY) : undefined;
  const intent =
    declaration?.status === 'ok' && declaration.rejected.length === 0 ? declaration : undefined;
  const checks = await rigChecks(options.cwd, intent?.targets?.codex?.fileHash);
  if (checks.some((check) => check.id === 'rig-manifest' && check.status === 'pass')) {
    const [guards, workflow] = await Promise.all([
      inspectGuards({ repoDir: options.cwd, runner: options.guardRunner }),
      inspectWorkflow({ repoDir: options.cwd }),
    ]);
    checks.push({ id: 'guards', ...guards }, { id: 'workflow', ...workflow });
  }
  const memory = await inspectMemory({ repoDir: options.cwd, env: options.env ?? process.env });
  checks.push({ id: 'custom-memory', status: memory.status, reason: memory.reason });
  // RP-230: personal-machine onboarding diagnostics. Neither check depends
  // on the manifest, and neither can push doctor's own exit status past
  // `warn` — both are personal setup guidance, not installation failures.
  const personalTracker = await personalTrackerCheck(options.cwd, options.env ?? process.env);
  if (personalTracker) checks.push(personalTracker);
  const codexHookTrust = await codexHookTrustCheck(options.cwd);
  if (codexHookTrust) checks.push(codexHookTrust);
  let specKit: SpecKitInspection | undefined;
  const wiring = await verifyIntegrations({ repoDir: options.cwd, env: options.env });
  const invalid = wiring.issues.some((issue) => issue.status !== 'missing');
  const pendingHarness = wiring.integrations.some(
    (entry) => Object.keys(entry.harnesses).length === 0,
  );
  checks.push({
    id: 'integrations',
    status: invalid ? 'fail' : pendingHarness ? 'warn' : 'pass',
    reason: invalid
      ? 'invalid-declaration'
      : pendingHarness
        ? 'harness-selection-pending'
        : wiring.integrations.length
          ? 'declared'
          : 'not-selected',
  });
  for (const entry of wiring.integrations) {
    if (Object.keys(entry.harnesses).length === 0) {
      checks.push({
        id: `${entry.id}:harness-selection`,
        status: 'warn',
        reason: 'harness-selection-pending',
      });
      continue;
    }
    if (entry.id === 'spec-kit') {
      const selected = intent?.entries.find((candidate) => candidate.id === 'spec-kit');
      if (selected?.version !== SPEC_KIT_VERSION) {
        checks.push({ id: 'spec-kit', status: 'fail', reason: 'unsupported-requested-version' });
      } else {
        const inspection = await inspectSpecKit({
          repoDir: options.cwd,
          harnesses: selected.harnesses ?? [],
          env: options.env,
        });
        specKit = inspection;
        checks.push({ id: 'spec-kit', status: inspection.status, reason: inspection.reason });
      }
      continue;
    }
    for (const [harness, state] of Object.entries(entry.harnesses)) {
      checks.push({
        id: `${entry.id}:${harness}`,
        status:
          state.wiring === 'unreadable'
            ? 'fail'
            : state.wiring === 'healthy'
              ? state.launcher === 'missing'
                ? 'warn'
                : 'pass'
              : 'warn',
        reason:
          state.wiring === 'healthy'
            ? state.launcher === 'missing'
              ? 'launcher-missing'
              : 'wired'
            : state.wiring,
      });
    }
  }
  const status: Status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'pass';
  const wiringNames = {
    healthy: 'wired',
    missing: 'absent',
    drift: 'drifted',
    unowned: 'foreign',
    unreadable: 'unreadable',
  } as const;
  const integrations = wiring.integrations
    .filter((entry) => entry.id !== 'spec-kit')
    .map((entry) => ({
      id: entry.id,
      harnesses: Object.fromEntries(
        Object.entries(entry.harnesses).map(([harness, state]) => [
          harness,
          { ...state, wiring: wiringNames[state.wiring] },
        ]),
      ),
    }));
  const report = {
    schemaVersion: 1,
    status: status === 'pass' ? 'ok' : status,
    checks: checks.map(({ rigVersion, ownedFilePaths, trackerMissingVars, ...check }) => ({
      ...check,
      status: check.status === 'pass' ? 'ok' : check.status,
      detail:
        check.reason === 'workflow-verified'
          ? 'Workflow and frozen revalidation scripts match this package; the owner-level decision this mechanism depends on is not observed by doctor.'
          : check.id === 'rig-version' && rigVersion
            ? `${check.reason.replaceAll('-', ' ')} (cli ${rigVersion.cli}, repository ${rigVersion.repository})`
            : check.id === 'rig-owned-files' && check.counts
              ? `${check.reason.replaceAll('-', ' ')} (absent ${check.counts.absent}, content drift ${check.counts.contentDrift}, line drift ${check.counts.lineDrift}, unreadable ${check.counts.unreadable})`
              : check.reason.replaceAll('-', ' '),
      fix:
        check.status === 'pass'
          ? ''
          : check.id === 'rig-version'
            ? rigVersionFix(check.reason, rigVersion ?? { cli: '', repository: '' })
            : check.id === 'rig-owned-files' && ownedFilePaths
              ? ownedFilesFix(ownedFilePaths)
              : check.id === 'personal-tracker' && trackerMissingVars
                ? `Set the missing tracker credential environment variable(s): ${trackerMissingVars.join(', ')}.`
                : check.id === 'codex-hook-trust'
                  ? "Open Codex's own /hooks view and review the checked-in rig hooks there: a changed, non-managed hook can be skipped until it is re-trusted in that view."
                  : check.id.startsWith('rig-') || check.id === 'guards' || check.id === 'workflow'
                    ? 'Review the installation with create-agent-rig upgrade before accepting changes.'
                    : check.id === 'custom-memory'
                      ? 'Check the machine-scoped Memory installation and its compatible version.'
                      : check.id === 'spec-kit'
                        ? 'Check the pinned Spec Kit launcher and authoritative integration status.'
                        : 'Review create-agent-rig setup list and the intended provider wiring.',
    })),
    integrations,
    memory: { ...memory, status: memory.status === 'pass' ? 'ok' : memory.status },
    ...(specKit
      ? {
          specKit: {
            version: SPEC_KIT_VERSION,
            ...specKit,
            status: specKit.status === 'pass' ? 'ok' : specKit.status,
            connectivity: 'not-observed',
            trust: 'not-observed',
          },
        }
      : {}),
  };
  return {
    exitCode: status === 'fail' ? 1 : 0,
    stdout: json
      ? `${JSON.stringify(report)}\n`
      : `${report.checks.map((check) => `${check.status}: ${check.id}: ${check.detail}${check.fix ? ` — ${check.fix}` : ''}`).join('\n')}\n`,
    stderr: '',
  };
}
