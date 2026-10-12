import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gitEnv } from '../lib/git-env.js';
import { substituteContent } from '../lib/substitute.js';
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
  POSTURE_CONDITIONS: ReadonlyArray<{
    id: string;
    classification: string;
    surfaces: string[];
    harness: string;
  }>;
  doctorStatus: (id: string, outcome: Outcome) => UnattendedStatus;
};

type StopFlagModule = {
  stopFlags: (env: NodeJS.ProcessEnv) => string[];
  armedFlag: (paths: string[]) => { path: string; code: string | null } | null;
};

/** Recognises a flag name the substitution placeholder has not been filled in. */
const PROJECT_PLACEHOLDER = ['__PROJECT', 'NAME__'].join('_');

const loadScript = async <T>(...rel: string[]): Promise<T> =>
  (await import(
    pathToFileURL(path.join(agentOsUniversalDir(), '.claude', 'scripts', ...rel)).href
  )) as T;

/**
 * The kill switch, read through the package's own `stop-flag.mjs` — the module
 * preflight and `guard-bash` read it through — with the one substitution
 * placeholder filled in from this repository's manifest, as `init` fills it.
 * Without a manifest the home flags cannot be named, but an AGENT_LOOP_STOP
 * path carries no placeholder and is still checked: armed there is `fail`.
 */
async function killSwitch(env: NodeJS.ProcessEnv, project: string | undefined): Promise<Outcome> {
  const { stopFlags, armedFlag } = await loadScript<StopFlagModule>('stop-flag.mjs');
  if (project === undefined) {
    const named = stopFlags(env).filter((flag) => !flag.includes(PROJECT_PLACEHOLDER));
    return armedFlag(named) === null ? 'unknown' : 'fail';
  }
  const armed = armedFlag(
    stopFlags(env).map((flag) => substituteContent(flag, { projectName: project })),
  );
  return armed === null ? 'pass' : 'fail';
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

interface DodChecksModule {
  isRunnableDodEntry: (command: unknown) => boolean;
}

/**
 * The Definition-of-Done gate has something to run: `.claude/hooks/dod-checks.json`
 * is a non-empty array of entries `gate-stop-dod` runs as commands — the one
 * predicate in `.claude/scripts/lib/dod-checks.mjs`, which the hook imports
 * too. Absent or empty is the inert gate, and any other entry is a check that
 * produces no verdict; a file that does not parse was not judged.
 */
async function dodChecks(repoDir: string): Promise<Outcome> {
  const { isRunnableDodEntry: runnable } = await loadScript<DodChecksModule>(
    'lib',
    'dod-checks.mjs',
  );
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
  return checks.length > 0 && checks.every(runnable) ? 'pass' : 'fail';
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

const runFile = promisify(execFile);

/**
 * The paths git ignores among `paths`, by this repository's own ignore rules —
 * the user's global excludes file is switched off, since it does not travel
 * with a clone — or null when git cannot answer here (no repository, no git,
 * or no answer inside the bound).
 */
async function gitIgnored(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  paths: readonly string[],
): Promise<Set<string> | null> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-c', 'core.excludesFile=', 'check-ignore', '--no-index', '--', ...paths],
      { cwd: repoDir, env: gitEnv(env), timeout: 10_000, killSignal: 'SIGKILL' },
    );
    return new Set(stdout.split(/\r?\n/));
  } catch (error) {
    // Exit 1 is git's answer "none of them is ignored", not a failure to answer.
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
    return code === 1 ? new Set() : null;
  }
}

async function gitignoreEntries(
  repoDir: string,
  layers: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Outcome> {
  const required = [
    ...RUNTIME_IGNORES.core,
    ...(layers.includes('workflow') ? RUNTIME_IGNORES.workflow : []),
  ];
  // A directory entry is asked about through a path inside it, which git
  // matches whether or not the directory exists yet.
  const probes = required.map((entry) => (entry.endsWith('/') ? `${entry}probe` : entry));
  const ignored = await gitIgnored(repoDir, env, probes);
  if (ignored !== null) return probes.every((probe) => ignored.has(probe)) ? 'pass' : 'fail';
  const source = await readBounded(repoDir, '.gitignore', 1024 * 1024);
  if (source.status === 'absent') return 'fail';
  if (source.status !== 'ok') return 'unknown';
  const lines = new Set(
    source.bytes
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, '')),
  );
  return required.every((entry) => lines.has(entry)) ? 'pass' : 'fail';
}

/** Exported so `doctor-authority.ts` reads the same manifest the same way. */
export async function readManifest(repoDir: string): Promise<RigManifest | null> {
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
  // A batch that never finished says nothing about whether the guards held;
  // a cleanup failure is only reported after the batch exited 0, so there the
  // guards held but the run left a fixture behind. Neither is a guard that
  // failed, which stays `fail` below.
  const inconclusive =
    guards.reason === 'guard-fixture-cleanup-failed' ||
    guards.reason === 'guard-fixture-batch-timeout';
  return {
    'hook-wiring-missing': 'pass',
    'guard-integrity-failed': guards.status === 'pass' ? 'pass' : inconclusive ? 'unknown' : 'fail',
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
      manifest === null
        ? 'unknown'
        : await gitignoreEntries(options.repoDir, manifest.layers, options.env),
    'workflow-layer-missing':
      manifest === null ? 'unknown' : manifest.layers.includes('workflow') ? 'pass' : 'fail',
  };
  // A Codex-only condition says nothing about a rig with no Codex hook wiring.
  const codexWired =
    (await readBounded(options.repoDir, '.codex/hooks.json', 1024 * 1024)).status !== 'absent';
  const conditions = posture.POSTURE_CONDITIONS.filter(
    (c) => c.surfaces.includes('doctor') && (codexWired || c.harness !== 'codex'),
  ).map((c): UnattendedCondition => {
    const outcome = outcomes[c.id] ?? 'unknown';
    return {
      id: c.id,
      classification: c.classification,
      outcome,
      status: posture.doctorStatus(c.id, outcome),
    };
  });
  const status: UnattendedStatus = conditions.some((c) => c.status === 'fail')
    ? 'fail'
    : conditions.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
  return { status, conditions };
}
