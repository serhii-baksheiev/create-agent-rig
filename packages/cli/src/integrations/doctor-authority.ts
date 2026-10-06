import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentOsUniversalDir } from '../templates.js';
import type { Outcome, UnattendedReport } from './doctor-unattended.js';
import { readBounded } from './verify.js';

/**
 * Authority posture (RP-343 slice B), read through the package's own copy of
 * `.claude/scripts/lib/authority.mjs` (RP-339) — the single source of truth
 * for what `executionMode`/`decisionAuthority`/`publicationAuthority` mean,
 * never restated here. `safetyGates` and `killSwitch` are derived from the
 * conditions `inspectUnattended` already computed (`hook-wiring-missing`,
 * `guard-integrity-failed`, `kill-switch-armed`) — no new probes.
 */

export type GateState = 'enforced' | 'not-enforced' | 'unknown';
export type TriState = 'yes' | 'no' | 'unknown';
export type AuthorityReport = {
  schemaVersion: number;
  executionMode: string;
  decisionAuthority: string;
  publicationAuthority: string;
  safetyGates: GateState;
  killSwitch: { wired: TriState; armed: TriState };
};

type AuthorityModule = {
  authorityPosture: (input?: { executionMode?: unknown; decisionAuthority?: unknown }) => {
    schemaVersion: number;
    executionMode: string;
    decisionAuthority: string;
    publicationAuthority: string;
  };
  parseDecisionAuthority: (raw: unknown) => string;
};

type UnattendedFlagState =
  | { on: false }
  | {
      on: true;
      unreadable?: undefined;
      item: string | null;
      runDir: string | null;
      allow: string[];
    }
  | { on: true; unreadable: true; path: string; why: string };

type UnattendedFlagModule = { readUnattended: (env: NodeJS.ProcessEnv) => UnattendedFlagState };

const loadScript = async <T>(...rel: string[]): Promise<T> =>
  (await import(
    pathToFileURL(path.join(agentOsUniversalDir(), '.claude', 'scripts', ...rel)).href
  )) as T;

/** Mirrors `run-state.mjs`'s own `MAX_STATE_BYTES` — one bound, read twice for different reasons. */
const MAX_STATE_BYTES = 256 * 1024;

type RawState = { decisionAuthority?: unknown };

/**
 * `owner` when the field is absent (the contract default, via
 * `parseDecisionAuthority`), `unknown` when the file is missing, unreadable,
 * not valid JSON, or not a JSON object — distinct from "the field is absent",
 * which is exactly what makes this read file-shaped rather than a plain
 * `parseDecisionAuthority` call. Read with `readBounded`, the same
 * root-confined, symlink-refusing, size-capped primitive `doctor-unattended.ts`
 * and `doctor-workflow.ts` already use (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation") — `runDir` stands in for its `repoDir`.
 */
async function decisionAuthorityFromRunDir(
  runDir: string | null,
  parseDecisionAuthority: AuthorityModule['parseDecisionAuthority'],
): Promise<string> {
  if (runDir === null) return 'unknown';
  const source = await readBounded(runDir, 'state.json', MAX_STATE_BYTES);
  if (source.status !== 'ok') return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.bytes.toString('utf8'));
  } catch {
    return 'unknown';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unknown';
  return parseDecisionAuthority((parsed as RawState).decisionAuthority);
}

function outcomeOf(report: UnattendedReport, id: string): Outcome | undefined {
  return report.conditions.find((condition) => condition.id === id)?.outcome;
}

/** `not-enforced` if either gate failed, `unknown` if either is unobserved, else `enforced`. */
function safetyGatesFrom(report: UnattendedReport): GateState {
  const wiring = outcomeOf(report, 'hook-wiring-missing');
  const integrity = outcomeOf(report, 'guard-integrity-failed');
  if (wiring === 'fail' || integrity === 'fail') return 'not-enforced';
  if (
    wiring === undefined ||
    wiring === 'unknown' ||
    integrity === undefined ||
    integrity === 'unknown'
  )
    return 'unknown';
  return 'enforced';
}

function killSwitchFrom(report: UnattendedReport): AuthorityReport['killSwitch'] {
  const wiring = outcomeOf(report, 'hook-wiring-missing');
  const armed = outcomeOf(report, 'kill-switch-armed');
  const wired: TriState = wiring === 'pass' ? 'yes' : wiring === 'fail' ? 'no' : 'unknown';
  const armedState: TriState = armed === 'fail' ? 'yes' : armed === 'pass' ? 'no' : 'unknown';
  return { wired, armed: armedState };
}

export async function inspectAuthority(options: {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  unattended: UnattendedReport;
}): Promise<AuthorityReport> {
  const authority = await loadScript<AuthorityModule>('lib', 'authority.mjs');
  const { readUnattended } = await loadScript<UnattendedFlagModule>('unattended-flag.mjs');
  const flag = readUnattended(options.env);
  const armedReadable = flag.on === true && flag.unreadable !== true;
  const rawExecutionMode = armedReadable ? 'unattended' : undefined;
  const rawDecisionAuthority = armedReadable
    ? await decisionAuthorityFromRunDir(flag.runDir, authority.parseDecisionAuthority)
    : undefined;
  const posture = authority.authorityPosture({
    executionMode: rawExecutionMode,
    decisionAuthority: rawDecisionAuthority,
  });
  return {
    schemaVersion: posture.schemaVersion,
    executionMode: posture.executionMode,
    decisionAuthority: posture.decisionAuthority,
    publicationAuthority: posture.publicationAuthority,
    safetyGates: safetyGatesFrom(options.unattended),
    killSwitch: killSwitchFrom(options.unattended),
  };
}
