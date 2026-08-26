#!/usr/bin/env node
// The queue CLI — one command over whichever adapter this project uses.
//
//   node .claude/scripts/queue/index.mjs next            # the item to take, and why
//   node .claude/scripts/queue/index.mjs next --json
//   node .claude/scripts/queue/index.mjs list            # every item, with skip reasons
//   node .claude/scripts/queue/index.mjs hygiene         # stale labels, link anomalies, overtaken proposals
//   node .claude/scripts/queue/index.mjs gate-round --branch <b>   # count a gate round
//
// The adapter comes from `.claude/queue.json` (`{"adapter": "plan-md"}`) and
// defaults to `plan-md`, which is the only adapter that works in a freshly
// generated project. An unknown adapter is a hard error, never a fallback: a loop
// that silently reads the wrong queue is worse than one that refuses to start.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import {
  asOfOf,
  citedPathsOf,
  hygieneOf,
  overtakenOf,
  revalidationOf,
  selectNext,
  stopConditionOf,
} from './core.mjs';
import { changedSinceOf, headShaOf } from './as-of.mjs';
// One resolver, imported rather than re-derived: writer and reader disagreeing
// about which checkout they are in is the whole of the worktree defect. It lives
// apart from `state.mjs` so the read path does not drag the tier computation —
// and `detect-missed-gate.mjs` behind it — into a CLI that never calls either.
import { mainCheckoutRoot } from './checkout.mjs';

const ADAPTERS = {
  'plan-md': './plan-md.mjs',
  'github-issues': './github-issues.mjs',
  jira: './jira.mjs',
};

export const resolveAdapter = async (adapterName) => {
  const modulePath = ADAPTERS[adapterName];
  if (!modulePath) {
    throw new Error(
      `unknown queue adapter: ${adapterName}. Known adapters: ${Object.keys(ADAPTERS).join(', ')}.`,
    );
  }
  // Resolved against this file's own URL, not the cwd: the CLI runs from the
  // project root, from a worktree, and from a test harness.
  return import(new URL(modulePath, import.meta.url).href);
};

export const COMMANDS = ['next', 'list', 'hygiene', 'gate-round'];

/**
 * A missing config is the normal state of a fresh project. A config that exists
 * and does not parse is NOT — it used to fall back to `plan-md` silently, so a
 * trailing comma in `queue.json` made the loop read a different queue than the one
 * configured, which is the exact failure this file's header refuses for adapters.
 */
export const loadConfig = (configPath) => {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${configPath} exists but is not valid JSON, so the configured queue cannot be ` +
        `read: ${String(error?.message ?? error).split('\n')[0]}. Fix the file — ` +
        'silently reading a different queue is worse than refusing to start.',
      { cause: error },
    );
  }
};

/**
 * The state file that travels with a config: `<name>.json` → `<name>.state.json`.
 *
 * Derived from the config path rather than from the project root on purpose. The
 * two must stay a pair: a run pointed at a temp config by `--config` would
 * otherwise read the developer's own leftover state and let a tier from an
 * unrelated checkout decide its selection.
 */
export const statePathFor = (configPath) => configPath.replace(/(\.json)?$/, '.state.json');

/**
 * The project root a config path implies, or `null` when it implies none.
 *
 * A config inside a directory named `.claude` names a project: the rig puts it
 * there, so its parent is the root. Anything else — `--config /tmp/x.json`, a
 * config nested for a test fixture — is a bare file with no project around it,
 * and this returns `null` so the caller keeps whatever default it had.
 *
 * 🔴 Deliberately NOT `join(dirname(configPath), '..')`, which assumes every
 * config sits in a `.claude` directory: pointed at `<dir>/.claude-queue.json` it
 * climbs a level out of the project and looks for the plan in the parent.
 */
export const projectRootOfConfig = (configPath) => {
  const dir = dirname(configPath);
  return basename(dir) === '.claude' ? dirname(dir) : null;
};

/**
 * The adapter options the CLI hands down, with a plan path that does not depend
 * on the directory the command was typed in.
 *
 * 🔴 The asymmetry this closes: this file resolves its config from
 * `import.meta.url`, so the config is found from any directory — while
 * `plan-md`'s default is the bare relative `'PLAN.md'`, resolved against `cwd`.
 * Running the CLI from a subdirectory therefore found the adapter and then
 * reported `queue-unreadable`, which a run reads as a broken queue rather than as
 * a wrong directory.
 *
 * Two things are left exactly as they were, and both are load-bearing. An
 * explicit `options.planPath` still wins. And when the config implies no project
 * root, nothing is injected — so `plan-md`'s own `'PLAN.md'` still resolves
 * against the caller's cwd, which is the right answer when the adapter is
 * imported directly rather than through this CLI, as the `loop` skill does for
 * `proposeTriage`.
 */
export const optionsWithPlanPath = (options, configPath) => {
  const root = projectRootOfConfig(configPath);
  if (options?.planPath || root === null) return { ...options };
  return { ...options, planPath: join(root, 'PLAN.md') };
};

/**
 * Every tier a state file may carry, and the reason there are four.
 *
 * `state.mjs` writes three of them: `normal`, and the elevated tier split into
 * `elevated-prose` and `elevated-mechanism` — only the last of which spaces the
 * next item (`core.mjs`). The fourth, the bare `elevated`, is what a state file
 * written before that split still holds; it stays **readable** because a
 * checkout that upgrades mid-run would otherwise refuse to select at all, and
 * `core.mjs` reads it restrictively, so the legacy value rations exactly as it
 * did when it was written.
 */
const KNOWN_TIERS = ['normal', 'elevated', 'elevated-prose', 'elevated-mechanism'];

/**
 * Per-checkout state, kept OUT of the composed config.
 *
 * The config is a template-layer file: a runtime value written into it is drift
 * here and an upgrade conflict in a generated project. So the tier of the last
 * closed item lands beside it, in a gitignored file.
 *
 * Missing is not an error — it means no item has closed yet, and selection
 * proceeds with no spacing. Present-and-unparseable IS: the tier is then
 * *unknown*, and the silent reading of unknown is `null`, which is the
 * permissive value that lets a second elevated item straight through. That is
 * the exact failure this state file exists to end, so it refuses instead.
 */
export const loadState = (statePath) => {
  let raw;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (error) {
    // 🔴 ONLY a genuinely absent file means "nothing has closed yet". A bare
    // `catch` here read EACCES, a directory at the path, and a file left by a
    // container run under another uid as "absent" — each of them silently
    // yielding the permissive `null`, with nothing printed. One failed write
    // would have disabled the ration for good, and no adversary is needed.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return {};
    throw new Error(
      `${statePath} exists but could not be read (${error?.code ?? 'unknown error'}), ` +
        'so the last completed tier is unknown. Refusing rather than continuing: ' +
        'unknown reads as "nothing has closed yet", which is the value that lets a ' +
        'second elevated item through.',
      { cause: error },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${statePath} exists but is not valid JSON, so the last completed tier cannot ` +
        `be read: ${String(error?.message ?? error).split('\n')[0]}. Delete the file ` +
        'if you are unsure — an absent state means "nothing has closed yet", which is ' +
        'safe; a tier that cannot be read would silently disable the elevated ration.',
      { cause: error },
    );
  }

  // Syntax is not shape. `"elevated"`, `["elevated"]`, `123` and `"Elevated"` all
  // parse, and a state file shaped like any of them carries no tier at all — the
  // dereference below answers `undefined`, which reads as "nothing has closed
  // yet" and hands out an elevated item while the file looks like a working one.
  // (`core.mjs` now holds on an unrecognised tier rather than shrugging, but a
  // top-level array or number never reaches it as a tier in the first place.)
  // A top-level `null` was worse still: it parsed, then threw a raw TypeError
  // from the dereference, past the message that says the file is safe to delete.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${statePath} is valid JSON but not a state object, so the last completed tier ` +
        'cannot be read. Expected `{ "lastCompletedTier": "normal" | "elevated-prose" ' +
        '| "elevated-mechanism" }` — the legacy `"elevated"` is still accepted, and ' +
        'held. ' +
        'Delete the file if you are unsure — an absent state means "nothing has ' +
        'closed yet", which is safe.',
    );
  }

  // `null` is allowed and means exactly what an absent file means: nothing has
  // closed yet. It is the honest spelling of an absence, and refusing it would
  // protect nothing — deleting the file has the identical effect.
  const tier = parsed.lastCompletedTier;
  if (tier !== undefined && tier !== null && !KNOWN_TIERS.includes(tier)) {
    throw new Error(
      `${statePath} carries lastCompletedTier: ${JSON.stringify(tier)}, which is not ` +
        `one of ${KNOWN_TIERS.map((t) => `"${t}"`).join(' | ')}. A tier outside the ` +
        'vocabulary rations on a value nobody wrote, so it would report a working ' +
        'state file while the spacing rule ran on a guess. Delete the file if you ' +
        'are unsure.',
    );
  }

  return parsed;
};

const parseArgs = (argv) => {
  const args = { command: argv[0] ?? 'next', json: false, config: null, branch: null };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--branch') args.branch = argv[++i];
  }
  return args;
};

const renderNext = (result, stop, revalidation = null) => {
  if (stop) {
    const label = stop.kind.replaceAll('-', ' ');
    return `queue: ${label}${stop.success ? '' : ' (needs attention)'}\n  ${stop.why}\n`;
  }
  const lines = [`next: ${result.ticket.id} — ${result.ticket.title} [${result.ticket.tier}]`];
  // Only a marker that MOVED earns a line: the unchanged case stays quiet and
  // cheap, and the no-marker case is in the JSON and the event log, not here.
  if (revalidation?.changed === true) {
    lines.push(
      `revalidate: ${revalidation.ticket} hold — ${revalidation.source.join(', ')} ` +
        `(${revalidation.task.from} → ${revalidation.task.to}) — re-read the item before acting`,
    );
  }
  if (result.skipped.length > 0) {
    lines.push('', 'skipped:');
    for (const skip of result.skipped) lines.push(`  ${skip.id} — ${skip.reason}`);
  }
  return `${lines.join('\n')}\n`;
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
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  // An unrecognised command used to behave as `next`, discarding its argument —
  // so `claim 1` silently printed a selection and claimed nothing.
  if (!COMMANDS.includes(args.command)) {
    process.stderr.write(
      `unknown command: ${args.command}. Known commands: ${COMMANDS.join(', ')}. ` +
        'The write operations (claim, close, comment, escalate, proposeTriage) are ' +
        "the adapter's own API — import the adapter module rather than this CLI.\n",
    );
    process.exit(1);
  }

  // 🔴 **`gate-round` returns before the tracker is ever touched, and that is
  // load-bearing rather than an optimisation.** `pr-ship` calls this once per
  // round, and every other command below reaches the adapter — so routing this one
  // through the normal path would spend a network call per gate round and, worse,
  // would refuse to count a round while the tracker is unreachable. The counter is
  // a local file and a local config; a Jira outage must not hand a run unlimited
  // rounds.
  if (args.command === 'gate-round') {
    try {
      // 🔴 Inside the `try`, and a review round is why. Left outside it, a rig whose
      // `.claude/scripts/` predates this CLI printed a raw `ERR_MODULE_NOT_FOUND`
      // and exited 1 — which `pr-ship` step 0 would have read as "rounds
      // exhausted" and escalated a healthy item on. This file already records that
      // exact lesson about `resolveAdapter` fifty lines below; the reason it
      // repeated is that the lesson was written as prose and not as a test.
      const { gateRoundVerdict } = await import('./core.mjs');
      const { recordGateRound, gateRoundsPathFor } = await import('./gate-rounds.mjs');

      const configPath = args.config ?? join(projectRoot, '.claude', 'queue.json');
      const config = loadConfig(configPath);
      // An explicit `--config` keeps its counter beside it, so a run pointed at a
      // temp config never touches this checkout's real counts.
      const roundsPath = args.config
        ? configPath.replace(/(\.json)?$/, '.gate-rounds.json')
        : gateRoundsPathFor(projectRoot);

      // 🔴 Validate the cap BEFORE counting. A review round measured what the other
      // order costs: with `maxGateRounds: 0` every attempt recorded a round and then
      // exited 1, while this command's own message told the caller to fix the cause
      // and run step 0 again — so three attempts at a broken config left the branch
      // at three rounds and the next honest call refused a healthy item. A failed
      // run must not spend budget, and the message below must not have to lie about
      // whether it did.
      const verdictFor = (rounds) => gateRoundVerdict(rounds, config.options?.maxGateRounds);
      verdictFor(0);

      const { rounds } = recordGateRound({ branch: args.branch, roundsPath });
      const verdict = verdictFor(rounds);

      if (!verdict.exceeded) {
        process.stdout.write(
          `gate round ${verdict.rounds} of ${verdict.max} on ${args.branch}.\n` +
            (verdict.rounds === verdict.max
              ? '  This is the last round this branch gets. If it holds again, the item ' +
                'is escalated rather than re-reviewed.\n'
              : ''),
        );
        process.exit(0);
      }

      process.stderr.write(
        `GATE ROUNDS EXHAUSTED — ${verdict.rounds} rounds on ${args.branch}, cap is ` +
          `${verdict.max}: ${verdict.stop}.\n` +
          '  Do not run another round. The item stops here and goes back to a human ' +
          'with the round count and whatever the last gate reported. Whether those ' +
          'rounds were paying off is the reader\'s judgement — this command measured ' +
          'only the count (AR-115).\n' +
          '  Raising the cap to get one more pass on THIS item is the move this ' +
          'refusal exists to prevent.\n',
      );
      process.exit(2);
    } catch (error) {
      // 🔴 Exit 1, never 2, and the message says so. Exit 2 means one thing only —
      // the rounds are spent — because `pr-ship` acts on it by ending the task. A
      // broken config, an unreadable counter or a detached checkout must not be
      // read as a spent cap.
      process.stderr.write(
        `gate-round could not run: ${error.message}\n` +
          '  This is NOT an exhausted cap (that is exit 2). Fix the cause and run step ' +
          '0 again: a bad config, a bad cap or a detached checkout is refused before ' +
          'any round is counted, so retrying costs nothing.\n',
      );
      process.exit(1);
    }
  }

  // A missing module is NOT read as "no state". A run that could not read its
  // state would silently lose the escalation streak and the regression verdict
  // — the two conditions that exist to stop it — so this fails closed, into a
  // message the operator can act on.
  //
  // 🔴 **Loaded unconditionally, and ahead of the adapter, because the adapters
  // import it statically.** An earlier version loaded it dynamically and only
  // behind `RIG_RUN_DIR`, reasoning that a rig carrying an older
  // `.claude/scripts/` should still get a readable message. That reasoning was
  // sound and the code did not deliver it: all three adapters now
  // `import { recordEscalation } from '../run-state.mjs'`, so a rig missing the
  // module died inside `resolveAdapter` below and the operator saw a raw
  // `Cannot find module` naming an adapter. The refusal was unreachable — and
  // its test passed anyway, because the module's own filename satisfied the
  // pattern it matched on. The load lives here; the READ stays behind the
  // declaration, because a session with no run directory has no state to read
  // and must keep working exactly as before.
  let readState;
  let stopInputsOf;
  let recordTakeUp;
  try {
    ({ readState, stopInputsOf, recordTakeUp } = await import('../run-state.mjs'));
  } catch (error) {
    process.stderr.write(
      `run state: ${error.message}\n` +
        '  the run state module could not be loaded, so the escalation streak and the ' +
        'deploy verdict cannot be read. Those are stop conditions, and a run that ' +
        'cannot read them must not select work.\n',
    );
    process.exit(1);
  }

  let config;
  let state;
  let adapter;
  // Declared out here because the plan path is derived from it further down.
  let configPath;
  try {
    configPath = args.config ?? join(projectRoot, '.claude', 'queue.json');
    config = loadConfig(configPath);
    // An explicit `--config` keeps its own state beside it, verbatim: a run
    // pointed at a temp config must not pick up this checkout's real tier.
    // Without one, the state comes from the MAIN checkout, so a selection made
    // inside a worktree sees what a close made anywhere recorded.
    state = loadState(
      args.config
        ? statePathFor(configPath)
        : join(mainCheckoutRoot(projectRoot), '.claude', 'queue.state.json'),
    );
    adapter = await resolveAdapter(config.adapter ?? 'plan-md');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  // 🔴 The run-level stop is decided BEFORE the queue is read, because those
  // conditions are not about the queue. A run that has escalated twice in a row
  // has hit a systemic wall, and a run that deployed a regression must start no
  // new work on top of it — asking the tracker first would spend a network call
  // and, worse, would report `queue-unreadable` for an unreachable tracker when
  // the truthful answer is that this run was already over.
  //
  // The values come from the run's own state file rather than from the
  // session's memory, which is what three of `stopConditionOf`'s parameters
  // were waiting for: every branch was live, and nothing ever supplied them.
  //
  // The fourth, `killSwitch`, is still not passed here and that is deliberate —
  // `guard-bash` denies the merge at the tool layer and preflight reads the flag,
  // so a second answer to "is the brake on" would be the disagreement
  // `invariants.md` forbids. Selection therefore does NOT stop on the brake, and
  // the `loop` skill tells the run to keep checking it between tasks.
  //
  const runState = process.env.RIG_RUN_DIR ? readState(process.env.RIG_RUN_DIR) : {};
  let stopInputs;
  try {
    // Read through the module that owns the vocabulary, never field by field
    // here: a value the reader cannot interpret must not arrive as "no stop",
    // and deciding that at the call site is how the two halves drift.
    stopInputs = stopInputsOf(runState);
  } catch (error) {
    process.stderr.write(
      `${error.message}\n  the run declared a state file this cannot act on, so no ` +
        'item is selected. Stop conditions read from it, and an unreadable one is ' +
        'not the same as an absent one.\n',
    );
    process.exit(1);
  }
  const runStop = stopConditionOf({
    // `candidates: 1` says "not the empty-queue case" — the queue has not been
    // read yet and must not be reported on here. Only the conditions that
    // outrank it can fire from this call.
    candidates: 1,
    ...stopInputs,
  });
  if (runStop) {
    // `renderNext`, not a second copy of its format — an operator reading two
    // differently-worded stop lines has no way to know they came from one rule.
    process.stdout.write(
      args.json ? `${JSON.stringify({ stop: runStop }, null, 2)}\n` : renderNext(null, runStop),
    );
    // The exit code follows `stop.success`, exactly as the empty-queue path
    // does. A budget stop is a clean end of session — reporting it as a failure
    // would tell a wrapper that the run broke, and `--json` already says
    // `"success": true` right beside the code that contradicted it.
    process.exit(runStop.success ? 0 : 1);
  }

  let tickets;
  try {
    // Awaited so an adapter may be async (jira) or plain (plan-md, github-issues)
    // without the CLI caring which.
    tickets = await adapter.listEligible(optionsWithPlanPath(config.options, configPath));
  } catch (error) {
    // Never fall back to memory or to a stale copy for a queue.
    const stop = stopConditionOf({ queueReadable: false });
    process.stdout.write(
      args.json
        ? `${JSON.stringify({ stop, error: String(error.message ?? error) }, null, 2)}\n`
        : `queue: ${stop.kind}\n  ${stop.why}\n  ${error.message ?? error}\n`,
    );
    process.exit(1);
  }

  if (args.command === 'hygiene') {
    // The proposals on file are checked too (AR-116): a proposal names the commit
    // it was measured against, and one whose cited paths moved since is reported
    // as possibly overtaken. Git runs here, once per distinct `asOf`, against the
    // project this script belongs to; `core.mjs` only decides.
    const proposals = await adapter.listProposals(optionsWithPlanPath(config.options, configPath));
    const head = headShaOf({ cwd: projectRoot });
    const changedByAsOf = new Map();
    const overtaken = proposals
      .map((proposal) => {
        const asOf = asOfOf(proposal.body);
        if (asOf && !changedByAsOf.has(asOf)) {
          changedByAsOf.set(asOf, changedSinceOf({ cwd: projectRoot, asOf, head: head ?? 'HEAD' }));
        }
        return overtakenOf({
          id: proposal.id,
          asOf,
          citedPaths: citedPathsOf(proposal.body),
          head,
          changedSince: asOf ? changedByAsOf.get(asOf) : null,
        });
      })
      .filter(Boolean);
    const findings = [...tickets.map(hygieneOf).filter(Boolean), ...overtaken];
    process.stdout.write(
      args.json
        ? `${JSON.stringify({ findings }, null, 2)}\n`
        : findings.length === 0
          ? `queue hygiene: ${tickets.length} item(s) and ${proposals.length} proposal(s) ` +
            'checked — nothing stale.\n'
          : `${findings.map((f) => `  [${f.kind}] ${f.id} — ${f.why}`).join('\n')}\n`,
    );
    process.exit(0);
  }

  const result = selectNext(tickets, {
    // The state file wins: it is what a close actually recorded. A tier left in
    // the config is a hand-written hint at best, and it is the composed file, so
    // it cannot be the live value.
    lastCompletedTier: state.lastCompletedTier ?? config.lastCompletedTier ?? null,
    // Same precedence, for the same reason as the tier above: `queue.json` is
    // composed by the sync script and drift-checked, so declaring a trigger
    // fired there means editing a generated file — and the declaration is a
    // fact about THIS run, not about the rig's configuration.
    //
    // The config keeps working as a fallback rather than being dropped: nothing
    // in this repository or its templates ever writes the key, but a rig owner
    // who hand-added one would otherwise find their auto-trigger items silently
    // unselectable, and an item that stops being offered announces itself
    // nowhere.
    //
    // Replacement, not a merge: a per-key merge would make a stale config entry
    // impossible to retract, so "not this time" would again require editing the
    // generated file this move exists to get out of.
    triggersFired: runState.triggersFired ?? config.triggersFired ?? null,
  });
  // The skipped records travel with the count: without them "nothing left" and
  // "everything left is held back" both print as an empty queue, and only one of
  // the two means the queue needs refilling.
  const stop = result.ticket
    ? null
    : stopConditionOf({ candidates: 0, skipped: result.skipped });

  if (args.command === 'list') {
    process.stdout.write(`${JSON.stringify({ tickets, ...result }, null, 2)}\n`);
    process.exit(0);
  }

  // 🔴 A journal nothing calls records nothing. Selection is a gate — it decides
  // what the run works on and why every other item was passed over — so this is
  // the call site the run journal ships with, rather than a writer nobody
  // invokes.
  //
  // It writes only when the run DECLARED its directory. Inventing one here would
  // make this CLI a second owner of the `.claude/runs/<run-id>/` convention, and
  // a default derived from `projectRoot` would land the trace inside the very
  // template tree this repository publishes.
  const runDir = process.env.RIG_RUN_DIR;
  // Revalidation at SELECT (AR-133): the selected item against the marker this
  // run recorded at its last take-up. Computed only under a declared run —
  // there is no snapshot to compare against anywhere else — and `null` in the
  // output then, so a reader can tell "not compared" from "compared, unchanged".
  const revalidation =
    runDir && result.ticket
      ? revalidationOf({ ticket: result.ticket, snapshot: runState.takeUps?.[result.ticket.id] })
      : null;
  if (runDir) {
    let journal = null;
    try {
      journal = await import('../run-journal.mjs');
      journal.recordDecision({
        runDir,
        gate: 'item-selection',
        verdict: result.ticket ? `taken ${result.ticket.id}` : `stopped ${stop.kind}`,
        why: result.ticket ? result.ticket.title : stop.why,
        // The edge is where the clock is read: the journal itself takes `now` as
        // an argument, which is what keeps its records reproducible.
        now: new Date().toISOString(),
      });
      if (revalidation) {
        // The selection decision keeps its place as the run's first record; the
        // evidence log comes next, and only then (below, after the journal) does
        // the baseline move — a snapshot written before its event would leave a
        // crashed run with a marker and no record of what it was compared against.
        if (typeof journal.recordEvent === 'function') {
          journal.recordEvent({
            runDir,
            kind: 'revalidation',
            data: revalidation,
            now: new Date().toISOString(),
          });
        } else {
          // A rig carrying a run journal older than this CLI: the selection
          // stands, the comparison was made, only its record has nowhere to go.
          process.stderr.write(
            'run journal: this journal predates revalidation events, so the ' +
              'revalidation was not recorded.\n',
          );
        }
      }
    } catch (error) {
      // 🔴 Two failures wearing one face, and treating them alike was a defect
      // this gate caught. The journal asks the module which one this is — never
      // the message text, which would put the decision in two files and let them
      // drift the day someone improves the wording.
      // `?.` would guard a MISSING module and not a missing export. A rig can
      // carry a run journal older than this CLI — `upgrade` leaves a
      // locally-edited copy beside a new caller — and calling through to an
      // absent export crashed the CLI inside its own error handler: a raw stack
      // trace instead of the failure it was reporting.
      const classify = journal?.isTraceExhausted;
      if (typeof classify === 'function' && classify(error)) {
        // The trace is over and the work is not. This journal cannot accept
        // another record — it is append-only and every write re-reads it — so
        // exiting here would make one collision between two sessions leave the
        // queue unselectable FOREVER. Loud on stderr, and the selection still
        // goes out on stdout, because the queue was never the thing that failed.
        process.stderr.write(
          `run journal: ${error.message}\n` +
            `  the selection below was NOT recorded in ${runDir}. This run's trace ends ` +
            'here; the queue is fine, and a new run needs a new run directory.\n',
        );
      } else {
        // The other half: the declaration is empty, its directory is not there,
        // the path is not a directory, or the journal module is missing. Each is
        // the run pointing at something that was never set up — one `mkdir` or
        // one corrected variable away — and continuing would produce a run with
        // no trace at all, so this half does stop the selection. (A directory
        // deleted mid-run lands here too, and the same `mkdir` restores it.)
        process.stderr.write(`run journal: ${error.message}\n`);
        process.exit(1);
      }
    }
  }

  if (revalidation) {
    // Its own try, after the journal's: a state file that cannot be written is
    // not the journal failing, and the selection stands either way — the
    // comparison was made and recorded; only the next baseline is lost.
    try {
      recordTakeUp(runDir, { id: result.ticket.id, updatedAt: result.ticket.updatedAt });
    } catch (error) {
      process.stderr.write(
        `run state: the take-up snapshot was NOT recorded in ${runDir} — ${error.message}\n` +
          '  the selection below stands; the baseline was not moved — the next revalidation ' +
          'of this item compares against the previous one, if any, or has none.\n',
      );
    }
  }

  process.stdout.write(
    args.json
      ? `${JSON.stringify({ ticket: result.ticket, skipped: result.skipped, stop, revalidation }, null, 2)}\n`
      : renderNext(result, stop, revalidation),
  );
}
