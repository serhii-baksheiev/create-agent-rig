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
  let adapter;
  try {
    config = loadConfig(args.config ?? join(projectRoot, '.claude', 'queue.json'));
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
    lastCompletedTier: config.lastCompletedTier ?? null,
    triggersFired: config.triggersFired ?? null,
  });
  const stop = result.ticket ? null : stopConditionOf({ candidates: 0 });

  if (args.command === 'list') {
    process.stdout.write(`${JSON.stringify({ tickets, ...result }, null, 2)}\n`);
    process.exit(0);
  }

  process.stdout.write(
    args.json
      ? `${JSON.stringify({ ticket: result.ticket, skipped: result.skipped, stop }, null, 2)}\n`
      : renderNext(result, stop),
  );
}
