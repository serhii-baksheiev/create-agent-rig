#!/usr/bin/env node
// Preflight for an unattended run — walked ONCE, before the first task.
//
//   node .claude/scripts/preflight.mjs           # the block, ready to paste
//   node .claude/scripts/preflight.mjs --json
//   node .claude/scripts/preflight.mjs --unattended
//   node .claude/scripts/preflight.mjs --decision-authority <owner|delegated>
//
// The last two report the run's authority posture (RP-339) alongside the
// scripted checks and change nothing else it reports — pinned in
// test/template/preflight-authority.test.ts (absent in a generated rig) ›
// "verdict, checks and uncheckedConditions are deep-equal with and without
// the flags, on an ordinary CAUTION fixture".
//
// Every scripted item below has already cost a run somewhere: they are cheap
// before task #1 and expensive at turn 40.
//
// 🔴 **It prints the items it did NOT check, every time.** That is the whole
// reason it is safe to script half a checklist. The honest objection to a partial
// script — "a script that half-checks is worse than a list the run actually
// reads" — is true exactly while the boundary is invisible. A silent script would
// let a GO on the scripted subset read as a pass on the whole checklist.
//
// 🔴 **`unknown` never becomes `pass`.** A probe that could not run tells you
// nothing, and "I could not look" recorded as "it is fine" is the failure this
// checklist exists to prevent.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// One implementation of the brake, shared with the hook that enforces it. This
// file used to carry its own `process.env.AGENT_LOOP_STOP || <default>`, which is
// the replace-not-add bug — fixed in the hook and left open here for a full review
// cycle, because preflight is the only scripted brake check and had no test.
import { brakeIsOn } from './stop-flag.mjs';
import { readRevalidationContract } from './lib/claim-records.mjs';
import { preflightVerdict } from './lib/posture.mjs';
import { authorityPosture, DECISION_AUTHORITIES } from './lib/authority.mjs';
import { readUnattended } from './unattended-flag.mjs';
import { loadConfig, optionsWithPlanPath, resolveAdapter } from './queue/index.mjs';

/**
 * Each scripted check, keyed as the JSON output names it, and the posture
 * condition (`lib/posture.mjs`, RP-280) it reports.
 */
export const CHECK_IDS = Object.freeze({
  killSwitch: 'kill-switch-armed',
  runDirNotExported: 'run-dir-inherited',
  unattendedFlag: 'unattended-flag-stale',
  detectionContract: 'detection-contract-invalid',
  queue: 'queue-unreadable',
  defaultBranchFresh: 'default-branch-stale',
  lastDeploy: 'last-deploy-failed',
});

/**
 * The items this script cannot check — judgement, or a call worth more than it
 * saves — each with the posture condition that names it.
 */
export const UNCHECKED_CONDITIONS = Object.freeze([
  Object.freeze({
    id: 'stray-worktree',
    detail: 'no stray worktree from a dead session that this run might mistake for its own',
  }),
  Object.freeze({
    id: 'budget-declared',
    detail: 'a budget is declared for this run, and it is written down somewhere the run can re-read',
  }),
]);

export const UNCHECKED = UNCHECKED_CONDITIONS.map(({ detail }) => detail);

/**
 * The environment loses the variables that locate a git repository.
 *
 * A process started under a git hook inherits an absolute `GIT_DIR`, and every
 * probe below would then answer about a DIFFERENT repository — `fetch` writing
 * into it, `rev-parse` comparing its refs. This file's whole point is that an
 * `unknown` never becomes a `pass`; a confident answer about the wrong repo is
 * worse than either.
 *
 * 🔴 Limit: only repository *location* is stripped. `gh` inherits the rest of
 * the environment on purpose — its credentials live there.
 *
 * It lives in `git-env.mjs` and is re-exported here, so callers that already
 * import it from this file keep working while the queue seam — which must not
 * pull a CLI script into its read path — imports the small module directly.
 */
export { withoutGitLocation } from './git-env.mjs';
import { withoutGitLocation } from './git-env.mjs';

/**
 * RP-255: `checkLastDeploy` shells out to `gh run list` through this same
 * helper, with no bound of its own — measured on hosted windows-e2e, a
 * healthy cold `gh` start runs ~5-7 s steady, stalling past 15 s under load.
 * 10 s sits comfortably above a healthy start and strictly below this
 * project's 15 s vitest testTimeout, so a hung child fails closed instead of
 * taking the whole preflight run down with it. `run()` is shared with the
 * `git` probes BELOW it (`checkDefaultBranchFresh`'s `fetch`/`rev-parse`
 * calls); bounding the one helper bounds both. That means a `git fetch` slow
 * enough to cross this same 10 s bound is caught the same way a stalled `gh`
 * is: `checkDefaultBranchFresh` reports `unknown` (CAUTION), never GO — a
 * fetch that merely ran long is indistinguishable here from one that could
 * not run at all, and both must read as "could not confirm", not as a pass.
 */
export const GH_CHILD_TIMEOUT_MS = 10_000;

const run = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
      timeout: GH_CHILD_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') {
      throw new Error(
        `${command} ${args.join(' ')} did not complete within ${GH_CHILD_TIMEOUT_MS}ms and was killed`,
        { cause: error },
      );
    }
    throw error;
  }
};

/** The kill switch must be absent before a run starts. */
export const checkKillSwitch = () => {
  const armed = brakeIsOn();
  return armed
    ? { ok: false, detail: `kill switch is SET (${armed}) — do not start; deal with the cause` }
    : { ok: true, detail: 'absent' };
};

/**
 * The local default branch must match the remote.
 *
 * `fetch` is not `pull`, and a stale working tree reads as current — this exact
 * confusion has produced confidently-wrong runtime diagnoses more than once.
 */
export const checkDefaultBranchFresh = () => {
  try {
    const branch =
      run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
        .split('/')
        .pop() || 'main';
    run('git', ['fetch', '--quiet', 'origin', branch]);
    const local = run('git', ['rev-parse', branch]);
    const remote = run('git', ['rev-parse', `origin/${branch}`]);
    return local === remote
      ? { ok: true, detail: `${branch} == origin/${branch}` }
      : {
          // `stale`, not `unknown`: the probe RAN and produced a definite answer.
          // Reporting a known-stale branch as "could not look" collapsed the two
          // states this file exists to keep apart.
          ok: 'stale',
          detail: `local ${branch} differs from origin/${branch} — pull before starting`,
        };
  } catch (error) {
    return { ok: 'unknown', detail: `could not compare: ${String(error.message ?? error).split('\n')[0]}` };
  }
};

/**
 * `RIG_RUN_DIR` must not already be exported when preflight runs (AR-139).
 *
 * Preflight walks BEFORE this run declares its directory (`loop` §1), so a
 * value already in the environment is a leak — an `export` that outlived an
 * earlier run, or a shell that inherited one. Everything the run then spawns
 * inherits it too: the queue CLI under test, the gate scripts, and the real
 * run's append-only trace receives their fixture records. Measured at 38
 * fixture selections and 22 fixture revalidation events, plus two tests
 * exiting 1 and blamed on load. A hard failure, because starting on it puts
 * this run's stops in somebody else's file.
 */
export const checkRunDirNotExported = (env = process.env) => {
  const value = env.RIG_RUN_DIR;
  return value
    ? {
        ok: false,
        detail:
          `RIG_RUN_DIR is already exported (${value}) — a leak from an earlier run. ` +
          '`unset RIG_RUN_DIR`, then declare this run\'s own directory; an inherited ' +
          "one lands this run's trace and stop conditions in somebody else's file",
      }
    : { ok: true, detail: 'not exported' };
};

/**
 * No unattended flag may already be on disk for this checkout: preflight walks
 * before this run arms its own, so one found here belongs to an earlier run.
 */
export const checkUnattendedFlag = (projectRoot, env = process.env) => {
  const flag = readUnattended({ ...env, CLAUDE_PROJECT_DIR: projectRoot });
  if (!flag.on) return { ok: true, detail: 'not armed for this checkout' };
  if (flag.unreadable) {
    return {
      ok: false,
      detail: `an unattended flag is on disk and unreadable (${flag.path}): ${flag.why} — remove it before starting`,
    };
  }
  return {
    ok: false,
    detail:
      `an unattended flag is already armed for this checkout (item ${flag.item ?? 'unnamed'}) — ` +
      'an earlier run left it; clear it with `unattended-flag.mjs off --root <checkout>` before starting',
  };
};

export const checkDetectionContract = (projectRoot) => {
  try {
    const contract = readRevalidationContract(projectRoot);
    return {
      ok: true,
      detail:
        `${contract.detection.mode} via ${contract.detection.sources.join(' + ')}, ` +
        `${contract.detection.acceptedLatency} accepted latency, no push`,
    };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
};

// See test/template/preflight-queue.test.ts (absent in a generated rig) ›
// "reads exactly one adapter listing without selecting, claiming, or writing queue and run files".
export const checkQueue = async (projectRoot) => {
  try {
    const configPath = join(projectRoot, '.claude', 'queue.json');
    const config = loadConfig(configPath, { strictRead: true });
    const adapterName = config.adapter ?? 'plan-md';
    const adapter = await resolveAdapter(adapterName);
    if (
      config.options?.scope !== undefined &&
      config.options.scope !== null &&
      adapter.supportsScope === false
    ) {
      throw new Error(
        `${adapter.name} does not support options.scope: PLAN.md markers are not tracker labels, so ` +
          'a label scope cannot select a narrower queue. Use a tracker adapter with labels instead.',
      );
    }
    await adapter.listEligible(optionsWithPlanPath(config.options, configPath));
    return { ok: true, detail: `queue readable through ${adapterName}` };
  } catch (error) {
    const diagnostic = Array.from(String(error?.message ?? error), (character) => {
      const code = character.codePointAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
    }).join('');
    return {
      ok: false,
      detail: `could not read queue: ${diagnostic}`,
    };
  }
};

/** The last deploy must have concluded successfully — never start on a broken runtime. */
export const checkLastDeploy = ({ workflow = 'deploy' } = {}) => {
  try {
    const runs = JSON.parse(
      run('gh', ['run', 'list', '--workflow', workflow, '--limit', '1', '--json', 'conclusion,url']),
    );
    if (runs.length === 0) return { ok: 'unknown', detail: 'no deploy run found yet' };
    const [last] = runs;
    return last.conclusion === 'success'
      ? { ok: true, detail: `last deploy succeeded (${last.url})` }
      : { ok: false, detail: `last deploy concluded ${last.conclusion} (${last.url})` };
  } catch (error) {
    return {
      ok: 'unknown',
      detail: `could not read deploy history: ${String(error.message ?? error).split('\n')[0]}`,
    };
  }
};

/**
 * A check's answer as the posture contract reads it. `stale` is an observed
 * failure — the probe ran and the condition holds — so it is `fail`, never
 * `unknown`; anything else is `unknown`.
 */
const outcomeOf = (ok) => (ok === true ? 'pass' : ok === false || ok === 'stale' ? 'fail' : 'unknown');

/**
 * The verdict is the posture contract's `preflightVerdict`, not a policy of
 * this file's own: a required condition that fails is STOP, an advisory one
 * that fails or anything `unknown` is CAUTION, and each item in `unchecked` is
 * named as `unknown` — so GO needs every scripted item to pass and nothing left
 * unchecked. `stale` and `unknown` both give CAUTION but keep their own words
 * in the rendered block: "I looked and it is stale" is actionable, "I could not
 * look" is not.
 */
export const verdictOf = (checks, unchecked = []) =>
  preflightVerdict({
    ...Object.fromEntries(
      Object.entries(checks).map(([key, check]) => [CHECK_IDS[key] ?? key, outcomeOf(check?.ok)]),
    ),
    ...Object.fromEntries(unchecked.map(({ id }) => [id, 'unknown'])),
  });

// RP-343: `authority`, when passed, is `lib/authority.mjs`'s own
// `authorityPosture` object — report() never computes or restates it, only
// renders the three lines a caller's posture already carries.
export const report = (checks, { unchecked = UNCHECKED_CONDITIONS, authority } = {}) => {
  const verdict = verdictOf(checks, unchecked);
  const identified = Object.fromEntries(
    Object.entries(checks).map(([key, check]) => [
      key,
      { ...check, id: CHECK_IDS[key], outcome: outcomeOf(check?.ok) },
    ]),
  );
  const mark = (ok) =>
    ok === true ? 'pass' : ok === false ? 'FAIL' : ok === 'stale' ? 'stale' : 'unknown';
  const lines = [
    `**preflight** — verdict: ${verdict}`,
    '',
    ...Object.entries(identified).map(
      ([key, check]) => `- ${mark(check.ok)} · ${key} (${check.id}) — ${check.detail ?? ''}`,
    ),
    ...(authority
      ? [
          '',
          `Execution mode: ${authority.executionMode}`,
          `Decision authority: ${authority.decisionAuthority}`,
          `Publication authority: ${authority.publicationAuthority}`,
        ]
      : []),
    '',
    `_Not checked by this script — still yours (${unchecked.length}):_`,
    ...unchecked.map(({ id, detail }) => `- ${id} — ${detail}`),
    '',
    '_An item skipped twice is the signal to script it or drop it: a checklist',
    "nobody completes decays into one nobody reads._",
  ];
  return {
    verdict,
    checks: identified,
    unchecked: unchecked.map(({ detail }) => detail),
    uncheckedConditions: unchecked.map(({ id, detail }) => ({ id, outcome: 'unknown', detail })),
    rendered: lines.join('\n'),
    ...(authority ? { authority } : {}),
  };
};

/**
 * `--unattended` and `--decision-authority <value>` (space-separated only —
 * an `=` form or a repeated `--decision-authority` is a form this script does
 * not read, and reading it as "no value" would silently report a default, so
 * it is refused instead). Returns `{ error: true }` when the flags cannot be
 * parsed into values the contract recognises; the caller refuses before
 * producing any report.
 */
export const parseAuthorityArgs = (argv) => {
  if (argv.some((arg) => arg.startsWith('--decision-authority=') || arg.startsWith('--unattended='))) {
    return { error: true };
  }
  if (argv.filter((arg) => arg === '--decision-authority').length > 1) return { error: true };
  const unattended = argv.includes('--unattended');
  const index = argv.indexOf('--decision-authority');
  if (index === -1) return { unattended };
  const value = argv[index + 1];
  if (!DECISION_AUTHORITIES.includes(value)) return { error: true };
  return { unattended, decisionAuthority: value };
};

/**
 * Was this file invoked directly?
 *
 * Compared by REALPATH on both sides: ESM resolves `import.meta.url` through
 * symlinks while `process.argv[1]` keeps the path as typed, so a project living
 * under a symlinked directory (a macOS temp dir, a symlinked home, a checkout
 * behind a link) would fail a naive equality check — and the script would exit 0
 * having printed nothing, which reads exactly like "no findings".
 */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  // Refused BEFORE any check runs or any report is produced — an
  // unparsable authority flag means the operator asked for a posture this
  // run cannot honestly report, not "fall back to the default".
  const parsedAuthority = parseAuthorityArgs(argv);
  if (parsedAuthority.error) {
    process.stderr.write(
      `preflight takes --unattended as a bare flag and --decision-authority at most once, space-separated, as exactly one of: ${DECISION_AUTHORITIES.join(', ')}\n`,
    );
    process.exit(1);
  }
  const authority = authorityPosture({
    // An absent --unattended says nothing about who is watching, so it stays
    // `unknown` (the contract's parse of undefined), never `attended`.
    executionMode: parsedAuthority.unattended ? 'unattended' : undefined,
    decisionAuthority: parsedAuthority.decisionAuthority,
  });
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const checks = {
    killSwitch: checkKillSwitch(),
    runDirNotExported: checkRunDirNotExported(),
    unattendedFlag: checkUnattendedFlag(projectRoot),
    detectionContract: checkDetectionContract(projectRoot),
    queue: await checkQueue(projectRoot),
    defaultBranchFresh: checkDefaultBranchFresh(),
    lastDeploy: checkLastDeploy(),
  };
  const result = report(checks, { authority });
  process.stdout.write(
    argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${result.rendered}\n`,
  );
}
