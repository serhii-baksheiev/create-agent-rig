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

type Status = 'pass' | 'warn' | 'fail';
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
};
export type DoctorOptions = { cwd: string; args: string[]; env?: NodeJS.ProcessEnv };
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

function text(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
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
  let contentDrift = false;
  let lineDrift = false;
  let absent = false;
  let unreadable = false;
  for (const [rel, recorded] of Object.entries(manifest.files)) {
    const expected = rel === '.codex/config.toml' ? (codexHash ?? recorded) : recorded;
    const file = await readBounded(root, rel, 1024 * 1024);
    if (file.status === 'absent') {
      absent = true;
      continue;
    }
    if (file.status !== 'ok') {
      unreadable = true;
      continue;
    }
    if (sha256(file.bytes) === expected) continue;
    const decodedFile = text(file.bytes);
    if (
      decodedFile !== undefined &&
      (sha256(decodedFile.replace(/\r\n/g, '\n')) === expected ||
        sha256(decodedFile.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')) === expected)
    )
      lineDrift = true;
    else contentDrift = true;
  }
  checks.push({
    id: 'rig-owned-files',
    status: unreadable ? 'fail' : absent || contentDrift || lineDrift ? 'warn' : 'pass',
    reason: unreadable
      ? 'unreadable-owned-file'
      : absent
        ? 'absent-owned-file'
        : contentDrift
          ? 'content-drift'
          : lineDrift
            ? 'line-ending-drift'
            : 'pristine',
  });
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
      inspectGuards({ repoDir: options.cwd }),
      inspectWorkflow({ repoDir: options.cwd }),
    ]);
    checks.push({ id: 'guards', ...guards }, { id: 'workflow', ...workflow });
  }
  const memory = await inspectMemory({ repoDir: options.cwd, env: options.env ?? process.env });
  checks.push({ id: 'custom-memory', status: memory.status, reason: memory.reason });
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
    checks: checks.map(({ rigVersion, ...check }) => ({
      ...check,
      status: check.status === 'pass' ? 'ok' : check.status,
      detail:
        check.reason === 'workflow-verified'
          ? 'Workflow and frozen revalidation scripts match this package; the RP-26 decision is not observed.'
          : check.id === 'rig-version' && rigVersion
            ? `${check.reason.replaceAll('-', ' ')} (cli ${rigVersion.cli}, repository ${rigVersion.repository})`
            : check.reason.replaceAll('-', ' '),
      fix:
        check.status === 'pass'
          ? ''
          : check.id === 'rig-version'
            ? rigVersionFix(check.reason, rigVersion ?? { cli: '', repository: '' })
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
