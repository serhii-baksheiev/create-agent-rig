import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentOsUniversalDir } from '../templates.js';
import {
  PROJECT_PLACEHOLDER,
  readManifest,
  type Outcome,
  type UnattendedReport,
} from './doctor-unattended.js';
import { readBounded } from './verify.js';

/**
 * Authority posture (RP-343 slice B), read through the package's own copy of
 * `.claude/scripts/lib/authority.mjs` (RP-339) — the single source of truth
 * for what `executionMode`/`decisionAuthority`/`publicationAuthority` mean,
 * never restated here. `safetyGates` and `killSwitch` are derived from the
 * conditions `inspectUnattended` already computed (`hook-wiring-missing`,
 * `guard-integrity-failed`, `kill-switch-armed`) — no new probes.
 *
 * RP-343 slice B round 1: the unattended flag itself is read WITHOUT calling
 * the package's own template copy of `unattended-flag.mjs`'s `readUnattended`
 * — that module's `FLAG_BASENAME` is the literal, never-substituted
 * `__PROJECT_NAME__-loop-UNATTENDED`, because only the INSTALLED copy inside a
 * repository gets `__PROJECT_NAME__` filled in at `init` time (the same
 * problem `doctor-unattended.ts`'s `killSwitch` already solved for
 * `stop-flag.mjs`). And the doctor must never import or execute the INSPECTED
 * repository's own installed copy of that module either (the same principle
 * `doctor-guards.ts` states for a modified installed guard) — so this file
 * reads the flag file itself, through the same bounded, symlink-refusing
 * `readBounded` primitive every other doctor probe uses, at the path the
 * template's own exported `unattendedFlags`/`homesOf` helpers compute once
 * substituted, scoped to the INSPECTED repo (`repoDir`) rather than whatever
 * `env.CLAUDE_PROJECT_DIR` the caller happens to carry.
 *
 * Limit, stated rather than hidden: this reimplements only the minimal shape
 * check doctor's own tests need — a JSON object with an optional string
 * `runDir` — not `unattended-flag.mjs`'s full `allow`-list validation
 * (widening entries, the `MAX_ALLOW_ENTRIES` cap, the multi-home mirror
 * check). `guard-rulebook` is the authority on whether a flag actually
 * authorizes an edit; this is a read-only report of what a flag APPEARS to
 * declare, for a human or a controller reading `doctor`, not a second
 * enforcement path.
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

type HomesModule = { homesOf: (env: NodeJS.ProcessEnv) => string[] };
type UnattendedFlagPathsModule = { unattendedFlags: (env: NodeJS.ProcessEnv) => string[] };

const loadScript = async <T>(...rel: string[]): Promise<T> =>
  (await import(
    pathToFileURL(path.join(agentOsUniversalDir(), '.claude', 'scripts', ...rel)).href
  )) as T;

/** Mirrors `run-state.mjs`'s own `MAX_STATE_BYTES` — one bound, read twice for different reasons. */
const MAX_STATE_BYTES = 256 * 1024;
/** Mirrors `unattended-flag.mjs`'s own `MAX_FLAG_BYTES` — same reason. */
const MAX_FLAG_BYTES = 64 * 1024;

type RawState = { decisionAuthority?: unknown };
type RawFlag = { runDir?: unknown };

/**
 * What the armed-flag lookup found, scoped to the inspected repo:
 * - `project-unknown` — no readable manifest, so the flag's own substituted
 *   name can never be computed; this is not "no flag armed", it is "cannot
 *   tell", and both authority fields must say so.
 * - `absent` — every home-scoped candidate for this repo is missing.
 * - `unreadable` — a candidate exists but is not a readable, well-formed JSON
 *   object (bounds exceeded, I/O refusal, invalid JSON, or the wrong shape).
 * - `armed` — a well-formed record was read; `runDir` is its string field, or
 *   `null` when absent or not a string.
 */
type FlagLookup =
  | { kind: 'project-unknown' }
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'armed'; runDir: string | null };

/**
 * The substituted, home-scoped candidate paths for `repoDir`'s own unattended
 * flag — `unattendedFlags` from the package's template copy computes the
 * checkout-scoped basename (still carrying the unsubstituted placeholder)
 * from whatever `CLAUDE_PROJECT_DIR` its env carries, so this overrides that
 * one field to `repoDir` before calling it — the INSPECTED repo, never the
 * caller's own `env.CLAUDE_PROJECT_DIR` (RP-343 slice B round 1). `homes` is
 * read the same way, from the unmodified env, so the two lists share both
 * length and order.
 */
async function candidateFlagPaths(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  project: string,
): Promise<Array<{ home: string; rel: string }>> {
  const { homesOf } = await loadScript<HomesModule>('stop-flag.mjs');
  const { unattendedFlags } = await loadScript<UnattendedFlagPathsModule>('unattended-flag.mjs');
  const homes = homesOf(env);
  const placeholderPaths = unattendedFlags({ ...env, CLAUDE_PROJECT_DIR: repoDir });
  return homes.map((home, index) => {
    const placeholderPath = placeholderPaths[index];
    const basename =
      placeholderPath === undefined
        ? ''
        : path.basename(placeholderPath).replaceAll(PROJECT_PLACEHOLDER, project);
    return { home, rel: `.claude/${basename}` };
  });
}

async function armedFlagFor(repoDir: string, env: NodeJS.ProcessEnv): Promise<FlagLookup> {
  const manifest = await readManifest(repoDir);
  const project = manifest?.project.name;
  if (project === undefined) return { kind: 'project-unknown' };
  const candidates = await candidateFlagPaths(repoDir, env, project);
  for (const { home, rel } of candidates) {
    const source = await readBounded(home, rel, MAX_FLAG_BYTES);
    if (source.status === 'absent') continue;
    if (source.status !== 'ok') return { kind: 'unreadable' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.bytes.toString('utf8'));
    } catch {
      return { kind: 'unreadable' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'unreadable' };
    }
    const runDir = (parsed as RawFlag).runDir;
    return { kind: 'armed', runDir: typeof runDir === 'string' ? runDir : null };
  }
  return { kind: 'absent' };
}

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
  // RP-343 slice B round 1: a relative `runDir` names no fixed location at
  // all — resolving it would mean resolving against the doctor process's own
  // cwd, not against anything the flag actually declared.
  if (runDir === null || !path.isAbsolute(runDir)) return 'unknown';
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

/**
 * Not a value `parseExecutionMode`/`parseDecisionAuthority` ever accepts as
 * `attended`/`unattended`/`owner`/`delegated` — passing it through forces
 * their own `unknown` branch, rather than this file hardcoding the literal
 * `'unknown'` itself (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation").
 */
const UNRESOLVABLE = 'rp343b-unresolvable';

export async function inspectAuthority(options: {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  unattended: UnattendedReport;
}): Promise<AuthorityReport> {
  const authority = await loadScript<AuthorityModule>('lib', 'authority.mjs');
  const flag = await armedFlagFor(options.repoDir, options.env);
  // `project-unknown` is not "no flag armed" — the flag's own substituted
  // name could never be computed, so neither field can honestly default to
  // the no-flag reading (`unknown`/`owner`); both report `unknown` instead.
  let rawExecutionMode: string | undefined;
  let rawDecisionAuthority: string | undefined;
  if (flag.kind === 'project-unknown') {
    rawExecutionMode = UNRESOLVABLE;
    rawDecisionAuthority = UNRESOLVABLE;
  } else if (flag.kind === 'unreadable') {
    // An armed flag that cannot be read declared SOMETHING, not nothing — it
    // must never collapse to the same `owner` default an entirely absent
    // flag reports (RP-343 slice B round 1). `executionMode` stays `unknown`
    // via the plain undefined-default path below.
    rawDecisionAuthority = UNRESOLVABLE;
  } else if (flag.kind === 'armed') {
    rawExecutionMode = 'unattended';
    rawDecisionAuthority = await decisionAuthorityFromRunDir(
      flag.runDir,
      authority.parseDecisionAuthority,
    );
  }
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
