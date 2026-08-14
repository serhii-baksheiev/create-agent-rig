#!/usr/bin/env node
// The queue CLI — one command over whichever adapter this project uses.
//
//   node .claude/scripts/queue/index.mjs next            # the item to take, and why
//   node .claude/scripts/queue/index.mjs next --json
//   node .claude/scripts/queue/index.mjs list            # every item, with skip reasons
//   node .claude/scripts/queue/index.mjs hygiene         # stale labels and link anomalies
//
// The adapter comes from `.claude/queue.json` (`{"adapter": "plan-md"}`) and
// defaults to `plan-md`, which is the only adapter that works in a freshly
// generated project. An unknown adapter is a hard error, never a fallback: a loop
// that silently reads the wrong queue is worse than one that refuses to start.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hygieneOf, selectNext, stopConditionOf } from './core.mjs';
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

export const COMMANDS = ['next', 'list', 'hygiene'];

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
  // parse, and `core.mjs` compares with `===` — so every one of them missed and
  // handed out a second elevated item while looking like a working state file.
  // A top-level `null` was worse: it parsed, then threw a raw TypeError from the
  // dereference, past the message that tells you the file is safe to delete.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${statePath} is valid JSON but not a state object, so the last completed tier ` +
        'cannot be read. Expected `{ "lastCompletedTier": "elevated" | "normal" }`. ' +
        'Delete the file if you are unsure — an absent state means "nothing has ' +
        'closed yet", which is safe.',
    );
  }

  // `null` is allowed and means exactly what an absent file means: nothing has
  // closed yet. It is the honest spelling of an absence, and refusing it would
  // protect nothing — deleting the file has the identical effect.
  const tier = parsed.lastCompletedTier;
  if (tier !== undefined && tier !== null && tier !== 'elevated' && tier !== 'normal') {
    throw new Error(
      `${statePath} carries lastCompletedTier: ${JSON.stringify(tier)}, which is not ` +
        'one of "elevated" | "normal". A tier outside the vocabulary matches nothing ' +
        'and rations nothing, so it would disable the elevated spacing while looking ' +
        'like a working state file. Delete the file if you are unsure.',
    );
  }

  return parsed;
};

const parseArgs = (argv) => {
  const args = { command: argv[0] ?? 'next', json: false, config: null };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--config') args.config = argv[++i];
  }
  return args;
};

const renderNext = (result, stop) => {
  if (stop) {
    const label = stop.kind.replaceAll('-', ' ');
    return `queue: ${label}${stop.success ? '' : ' (needs attention)'}\n  ${stop.why}\n`;
  }
  const lines = [`next: ${result.ticket.id} — ${result.ticket.title} [${result.ticket.tier}]`];
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

  let config;
  let state;
  let adapter;
  try {
    const configPath = args.config ?? join(projectRoot, '.claude', 'queue.json');
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

  let tickets;
  try {
    // Awaited so an adapter may be async (jira) or plain (plan-md, github-issues)
    // without the CLI caring which.
    tickets = await adapter.listEligible(config.options ?? {});
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
    const findings = tickets.map(hygieneOf).filter(Boolean);
    process.stdout.write(
      args.json
        ? `${JSON.stringify({ findings }, null, 2)}\n`
        : findings.length === 0
          ? `queue hygiene: ${tickets.length} item(s) checked — nothing stale.\n`
          : `${findings.map((f) => `  [${f.kind}] ${f.id} — ${f.why}`).join('\n')}\n`,
    );
    process.exit(0);
  }

  const result = selectNext(tickets, {
    // The state file wins: it is what a close actually recorded. A tier left in
    // the config is a hand-written hint at best, and it is the composed file, so
    // it cannot be the live value.
    lastCompletedTier: state.lastCompletedTier ?? config.lastCompletedTier ?? null,
    triggersFired: config.triggersFired ?? null,
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

  process.stdout.write(
    args.json
      ? `${JSON.stringify({ ticket: result.ticket, skipped: result.skipped, stop }, null, 2)}\n`
      : renderNext(result, stop),
  );
}
