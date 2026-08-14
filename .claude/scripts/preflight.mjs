#!/usr/bin/env node
// Preflight for an unattended run — walked ONCE, before the first task.
//
//   node .claude/scripts/preflight.mjs           # the block, ready to paste
//   node .claude/scripts/preflight.mjs --json
//
// Every scripted item below has already cost a run somewhere: they are cheap
// before task #1 and expensive at turn 40.
//
// 🔴 **It prints the items it did NOT check, every time.** That is the whole
// reason it is safe to script half a checklist. The honest objection to a partial
// script — "a script that half-checks is worse than a list the run actually
// reads" — is true exactly while the boundary is invisible. A silent script would
// let a GO on three items read as a pass on six.
//
// 🔴 **`unknown` never becomes `pass`.** A probe that could not run tells you
// nothing, and "I could not look" recorded as "it is fine" is the failure this
// checklist exists to prevent.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// One implementation of the brake, shared with the hook that enforces it. This
// file used to carry its own `process.env.AGENT_LOOP_STOP || <default>`, which is
// the replace-not-add bug — fixed in the hook and left open here for a full review
// cycle, because preflight is the only scripted brake check and had no test.
import { brakeIsOn } from './stop-flag.mjs';

/** The items this script cannot check: judgement, or a call worth more than it saves. */
export const UNCHECKED = [
  'the queue is reachable through its adapter (`node .claude/scripts/queue/index.mjs next`)',
  'no stray worktree from a dead session that this run might mistake for its own',
  'a budget is declared for this run, and it is written down somewhere the run can re-read',
];

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

const run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: withoutGitLocation(),
  }).trim();

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
 * STOP on any hard failure; CAUTION on anything that is not a clean pass; GO only
 * when every scripted item genuinely passed. The three unscripted items are still
 * the reader's.
 *
 * `stale` and `unknown` both give CAUTION but are never merged into one word:
 * "I looked and it is stale" is actionable, "I could not look" is not, and neither
 * ever becomes a pass.
 */
export const verdictOf = (checks) => {
  const values = Object.values(checks);
  if (values.some((check) => check?.ok === false)) return 'STOP';
  if (values.some((check) => check?.ok !== true)) return 'CAUTION';
  return 'GO';
};

export const report = (checks, { unchecked = UNCHECKED } = {}) => {
  const verdict = verdictOf(checks);
  const mark = (ok) =>
    ok === true ? 'pass' : ok === false ? 'FAIL' : ok === 'stale' ? 'stale' : 'unknown';
  const lines = [
    `**preflight** — verdict: ${verdict}`,
    '',
    ...Object.entries(checks).map(([key, check]) => `- ${mark(check?.ok)} · ${key} — ${check?.detail ?? ''}`),
    '',
    `_Not checked by this script — still yours (${unchecked.length}):_`,
    ...unchecked.map((item) => `- ${item}`),
    '',
    '_An item skipped twice is the signal to script it or drop it: a checklist',
    "nobody completes decays into one nobody reads._",
  ];
  return { verdict, checks, unchecked, rendered: lines.join('\n') };
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
  const checks = {
    killSwitch: checkKillSwitch(),
    defaultBranchFresh: checkDefaultBranchFresh(),
    lastDeploy: checkLastDeploy(),
  };
  const result = report(checks);
  process.stdout.write(
    process.argv.includes('--json')
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${result.rendered}\n`,
  );
}
