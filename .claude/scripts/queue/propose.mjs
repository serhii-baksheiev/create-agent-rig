#!/usr/bin/env node
// The one repo-root-safe entry point for filing an improvement-triage
// proposal (RP-209). It resolves its config, and through it the active
// board's adapter and plan path, from its OWN location — exactly like
// `index.mjs`'s `projectRoot` — so a session standing in a subdirectory
// files into the project's real PLAN.md rather than a cwd-relative one
// that happens not to exist there.
//
//   node .claude/scripts/queue/propose.mjs --file <proposal.json>
//   node .claude/scripts/queue/propose.mjs --file -                # stdin
//   node .claude/scripts/queue/propose.mjs --file <path> --config <queue.json>
//
// The proposal object is whatever the active adapter's `proposeTriage`
// already accepts. The result prints as one JSON line on stdout; the
// process exits 0 only when `ok === true`. When `RIG_RUN_DIR` is declared,
// one `proposal` event is recorded in the run journal either way, so a
// failed filing is journalled as a failure rather than going nowhere
// silently.
//
// See the generator's test/template/queue-propose.test.ts (absent in a
// generated rig).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, optionsWithPlanPath, resolveAdapter } from './index.mjs';

const parseArgs = (argv) => {
  const args = { file: null, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
  }
  return args;
};

const readStdin = () =>
  new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });

const readProposalRaw = (file) => (file === '-' ? readStdin() : Promise.resolve(readFileSync(file, 'utf8')));

/**
 * Small, deliberately: the journal is a trace of the filing decision, not a
 * second copy of the proposal or of the adapter's whole response.
 */
const journalDataFor = (result, reason) => {
  const data = { ok: result?.ok === true };
  if (result?.item?.fingerprint !== undefined) data.id = result.item.fingerprint;
  if (result?.filed !== undefined) data.filed = result.filed;
  if (result?.incremented !== undefined) data.incremented = result.incremented;
  if (reason !== undefined) data.reason = reason;
  return data;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    process.stderr.write('propose: --file <proposal.json> is required (or --file - for stdin).\n');
    process.exit(1);
  }

  let raw;
  try {
    raw = await readProposalRaw(args.file);
  } catch (error) {
    process.stderr.write(`propose: could not read ${args.file}: ${error.message}\n`);
    process.exit(1);
  }

  let proposal;
  try {
    proposal = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`propose: ${args.file} is not valid JSON: ${error.message}\n`);
    process.exit(1);
  }

  // Resolved against this file's own URL, not the cwd — the same rule
  // `index.mjs` follows, for the same reason: the CLI runs from the project
  // root, from a worktree, and from a subdirectory the session happens to be
  // standing in.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(scriptDir, '..', '..', '..');
  const configPath = args.config ?? join(projectRoot, '.claude', 'queue.json');

  let result;
  let reason;
  try {
    const config = loadConfig(configPath);
    const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
    const options = optionsWithPlanPath(config.options, configPath);
    result = await adapter.proposeTriage(proposal, options);
    if (result?.ok !== true) reason = result?.why ?? 'proposeTriage returned ok: false';
  } catch (error) {
    reason = error.message ?? String(error);
    result = { ok: false, reason };
  }

  const exitCode = result?.ok === true ? 0 : 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (exitCode !== 0) process.stderr.write(`propose: ${reason}\n`);

  const runDir = process.env.RIG_RUN_DIR;
  if (runDir) {
    let journal = null;
    try {
      journal = await import('../run-journal.mjs');
      journal.recordEvent({
        runDir,
        kind: 'proposal',
        data: journalDataFor(result, reason),
        now: new Date().toISOString(),
      });
    } catch (error) {
      const classify = journal?.isTraceExhausted;
      if (typeof classify === 'function' && classify(error)) {
        // The trace is over; the filing already happened and stands. Loud on
        // stderr, exit code stays whatever the filing decided — mirrors the
        // pattern in `index.mjs` and the `loop` skill's own journal section.
        process.stderr.write(
          `run journal: ${error.message}\n` +
            `  the proposal result above was NOT recorded in ${runDir}. This run's ` +
            "trace ends here; the filing above stands.\n",
        );
      } else {
        process.stderr.write(`run journal: ${error.message}\n`);
        process.exit(1);
      }
    }
  }

  process.exit(exitCode);
};

main();
