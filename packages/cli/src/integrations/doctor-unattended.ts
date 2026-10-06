import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANIFEST_REL, parseManifest, type RigManifest } from '../lib/manifest.js';
import { agentOsUniversalDir } from '../templates.js';
import type { GuardInspection } from './doctor-guards.js';
import { readBounded } from './verify.js';

/**
 * Unattended readiness (RP-282), reported against the posture contract
 * `.claude/scripts/lib/posture.mjs` (RP-280). The CLI reads this package's own
 * copy of the module, as `doctor-guards` does for `unattended-flag.mjs`, so the
 * list of conditions and the outcome-to-status mapping are never restated here.
 */

export type Outcome = 'pass' | 'fail' | 'unknown';
export type UnattendedStatus = 'ok' | 'warn' | 'fail';
export type UnattendedCondition = {
  id: string;
  classification: string;
  outcome: Outcome;
  status: UnattendedStatus;
};
export type UnattendedReport = { status: UnattendedStatus; conditions: UnattendedCondition[] };

type PostureModule = {
  POSTURE_CONDITIONS: ReadonlyArray<{ id: string; classification: string; surfaces: string[] }>;
  doctorStatus: (id: string, outcome: Outcome) => UnattendedStatus;
};

type StopFlagModule = { stopFlags: (env: NodeJS.ProcessEnv) => string[] };

const PROJECT_PLACEHOLDER = ['__PROJECT', 'NAME__'].join('_');

const loadScript = async <T>(...rel: string[]): Promise<T> =>
  (await import(
    pathToFileURL(path.join(agentOsUniversalDir(), '.claude', 'scripts', ...rel)).href
  )) as T;

/**
 * The kill switch, read through the package's own `stop-flag.mjs` — the module
 * preflight and `guard-bash` read it through — with the one substitution
 * placeholder filled in from this repository's manifest, as `init` fills it.
 */
async function killSwitch(env: NodeJS.ProcessEnv, project: string | undefined): Promise<Outcome> {
  if (project === undefined) return 'unknown';
  const { stopFlags } = await loadScript<StopFlagModule>('stop-flag.mjs');
  const armed = stopFlags(env)
    .map((flag) => flag.replaceAll(PROJECT_PLACEHOLDER, project))
    .some((flag) => {
      try {
        return existsSync(flag);
      } catch {
        return false;
      }
    });
  return armed ? 'fail' : 'pass';
}

type ClaimRecordsModule = { readRevalidationContract: (projectRoot: string) => unknown };

/** The detection contract, read through the same reader preflight uses. */
async function detectionContract(repoDir: string): Promise<Outcome> {
  const { readRevalidationContract } = await loadScript<ClaimRecordsModule>(
    'lib',
    'claim-records.mjs',
  );
  try {
    readRevalidationContract(repoDir);
    return 'pass';
  } catch {
    return 'fail';
  }
}

/**
 * The Definition-of-Done gate has something to run: `.claude/hooks/dod-checks.json`
 * is a non-empty array, the shape `gate-stop-dod` reads. Absent or empty is the
 * inert gate; a file that does not parse was not judged.
 */
async function dodChecks(repoDir: string): Promise<Outcome> {
  const source = await readBounded(repoDir, '.claude/hooks/dod-checks.json', 64 * 1024);
  if (source.status === 'absent') return 'fail';
  if (source.status !== 'ok') return 'unknown';
  let checks: unknown;
  try {
    checks = JSON.parse(source.bytes.toString('utf8'));
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(checks)) return 'unknown';
  return checks.length > 0 ? 'pass' : 'fail';
}

/**
 * The runtime paths `.gitignore` must name: one for every rig, four more with
 * the workflow layer. AGENTS.md ("Four things this install left for you to
 * finish", item 3) prints the same lines for a reader.
 */
export const RUNTIME_IGNORES = Object.freeze({
  core: Object.freeze(['.claude/worktrees/']),
  workflow: Object.freeze([
    '.claude/queue.state.json',
    '.claude/queue.board',
    '.claude/gate-rounds.json',
    '.claude/runs/',
  ]),
});

async function gitignoreEntries(repoDir: string, layers: readonly string[]): Promise<Outcome> {
  const source = await readBounded(repoDir, '.gitignore', 1024 * 1024);
  if (source.status === 'absent') return 'fail';
  if (source.status !== 'ok') return 'unknown';
  const lines = new Set(
    source.bytes
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, '')),
  );
  const required = [
    ...RUNTIME_IGNORES.core,
    ...(layers.includes('workflow') ? RUNTIME_IGNORES.workflow : []),
  ];
  return required.every((entry) => lines.has(entry)) ? 'pass' : 'fail';
}

async function readManifest(repoDir: string): Promise<RigManifest | null> {
  const source = await readBounded(repoDir, MANIFEST_REL, 1024 * 1024);
  if (source.status !== 'ok') return null;
  return parseManifest(source.bytes.toString('utf8'));
}

/**
 * Wiring and integrity, read from the guard inspection doctor already ran.
 * `inspectGuards` checks wiring first and stops there, so integrity behind a
 * wiring failure was never looked at, and with no inspection at all (no valid
 * manifest) neither was.
 */
function guardOutcomes(guards: GuardInspection | undefined): Record<string, Outcome> {
  if (guards === undefined) {
    return { 'hook-wiring-missing': 'unknown', 'guard-integrity-failed': 'unknown' };
  }
  if (guards.reason === 'hook-wiring-invalid') {
    return { 'hook-wiring-missing': 'fail', 'guard-integrity-failed': 'unknown' };
  }
  return {
    'hook-wiring-missing': 'pass',
    'guard-integrity-failed': guards.status === 'pass' ? 'pass' : 'fail',
  };
}

export async function inspectUnattended(options: {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  guards?: GuardInspection;
  tracker?: Outcome;
}): Promise<UnattendedReport> {
  const posture = await loadScript<PostureModule>('lib', 'posture.mjs');
  const manifest = await readManifest(options.repoDir);
  const outcomes: Record<string, Outcome> = {
    'kill-switch-armed': await killSwitch(options.env, manifest?.project.name),
    'detection-contract-invalid': await detectionContract(options.repoDir),
    ...guardOutcomes(options.guards),
    'tracker-credentials-missing': options.tracker ?? 'unknown',
    'dod-checks-missing': await dodChecks(options.repoDir),
    'gitignore-runtime-entries-missing':
      manifest === null ? 'unknown' : await gitignoreEntries(options.repoDir, manifest.layers),
    'workflow-layer-missing':
      manifest === null ? 'unknown' : manifest.layers.includes('workflow') ? 'pass' : 'fail',
  };
  const conditions = posture.POSTURE_CONDITIONS.filter((c) => c.surfaces.includes('doctor')).map(
    (c): UnattendedCondition => {
      const outcome = outcomes[c.id] ?? 'unknown';
      return {
        id: c.id,
        classification: c.classification,
        outcome,
        status: posture.doctorStatus(c.id, outcome),
      };
    },
  );
  const status: UnattendedStatus = conditions.some((c) => c.status === 'fail')
    ? 'fail'
    : conditions.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
  return { status, conditions };
}
