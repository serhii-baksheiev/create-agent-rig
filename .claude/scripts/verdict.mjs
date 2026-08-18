#!/usr/bin/env node
/**
 * The verdict CLI — what a gate runs before it believes a reviewer.
 *
 *   node .claude/scripts/verdict.mjs check <file> [gate]   # `-` reads stdin
 *   node .claude/scripts/verdict.mjs coverage <commit>    # reads the run journal
 *
 * `check` reads a gate's report, hands it to `lib/verdict.mjs`, and either prints
 * the parsed verdict on stdout (exit 0) or refuses with a diagnosis on stderr
 * (exit 1). All the deciding lives in the module; this file is the call site.
 *
 * `coverage` answers the question one report cannot: did every reviewer this
 * round asked for actually answer, for the commit being merged? It compares the
 * three sets the run journal already holds — routed, launched, answered — through
 * `lib/gate-coverage.mjs`, and it is a READ. It never launches a reviewer and it
 * never writes.
 *
 * 🔴 **Name the gate you launched.** The module reads the report's LAST block
 * (its limit 3), so a capture holding two reviewers' answers end to end says
 * only what the second one said — a stop that vanishes behind a later pass.
 * With `[gate]`, a block claiming another gate is refused. The argument is
 * optional because a caller checking one report of a known gate does not need
 * it; a caller that fanned reviewers out does.
 *
 * 🔴 **The exit code says whether the REPORT was usable, never what the verdict
 * was.** A well-formed `HOLD` exits 0 and prints `"verdict": "HOLD"` — a gate
 * that found something is not a gate that broke, and a caller keying on the exit
 * code would read the two as one. Read the word on stdout.
 *
 * 🔴 **stdout stays empty on a refusal.** A caller redirecting it into a file
 * would otherwise capture a verdict this command has just refused, which is the
 * failure the whole schema exists to prevent, reintroduced by the reader.
 */

import { readFileSync } from 'node:fs';

import { coverageOf } from './lib/gate-coverage.mjs';
import { isCommitId, parseVerdict, safeForDiagnosis } from './lib/verdict.mjs';
import { readRun } from './run-journal.mjs';

const USAGE =
  'usage: node .claude/scripts/verdict.mjs check <file> [gate]   ' +
  '(`-` reads the report from stdin)\n' +
  '       node .claude/scripts/verdict.mjs coverage <commit>   ' +
  '(reads the run journal in $RIG_RUN_DIR)\n';

const refuse = (message) => {
  process.stderr.write(message);
  process.exit(1);
};

const readReport = (source) => {
  try {
    return readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch (error) {
    // The path, not a stack: the operator needs to know WHICH report could not
    // be read, and a node trace answers a question nobody asked.
    refuse(
      `verdict: could not read the report at ${source} (${error?.code ?? 'unknown error'}). ` +
        'Nothing was checked.\n',
    );
    return '';
  }
};

const [subcommand, source, expectedGate] = process.argv.slice(2);

// Two arms, one branch apart, and telling them apart is the whole value of
// either: an operator told the subcommand is unknown goes looking for a typo
// that is not there.
if (subcommand === undefined) refuse(USAGE);

if (subcommand === 'coverage') {
  // The four cases and the fix each one needs, said in the line that names the
  // reviewer — a single "missing" list makes the reader guess between
  // relaunching a reviewer and going to read why one stayed silent.
  const CASES = [
    ['neverLaunched', 'the route asked for it and the fan-out never launched it — launch it'],
    ['unanswered', 'launched, and it did not answer — no verdict of its own parsed'],
    ['unattributed', 'it answered, and its verdict named no commit — so it cannot say it answered for this one'],
    ['stale', 'it answered for another commit — the head moved after the verdict'],
  ];

  const commit = source;
  // The same two arms `check` keeps apart: the subcommand was right and the
  // argument was not supplied. Reporting the opposite sends the operator
  // looking for a typo that is not there.
  if (commit === undefined) {
    refuse(
      'verdict: `coverage` needs the commit the round is about; no commit was given. ' +
        'It is the head the reviewers were launched against — `git rev-parse HEAD` in the ' +
        `reviewed checkout.\n${USAGE}`,
    );
  }

  // The one commit field this command owns. Everything else that reaches
  // `sameCommit` came through the schema; this argument came off the command
  // line, and without a check `coverage <a-full-sha>garbage` prefix-matched its
  // way to "covered" — the answer that ends in a merge.
  if (!isCommitId(commit)) {
    refuse(
      `verdict: \`${safeForDiagnosis(commit)}\` is not a commit to ask about. ` +
        'It is 7 to 64 hex characters (0-9a-f), the same shape a verdict may name — ' +
        '`git rev-parse HEAD` in the reviewed checkout.\n',
    );
  }

  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    // 🔴 Exit 0 with nothing printed is indistinguishable from a clean round,
    // and an unattended session reads it as one. The skip is the honest answer —
    // this run kept no trace — and it has to be said out loud.
    process.stdout.write(
      'verdict: coverage skipped — no run directory is declared (RIG_RUN_DIR is unset), so ' +
        'this run journalled no fan-out and no verdicts. Nothing was checked, which is not ' +
        'the same as nothing being outstanding.\n',
    );
    process.exit(0);
  }

  let decisions;
  try {
    ({ decisions } = readRun({ runDir }));
  } catch (error) {
    refuse(
      `verdict: the run journal in ${runDir} could not be read, so coverage was not ` +
        `checked (${error?.message ?? 'unknown error'}).\n`,
    );
  }

  const coverage = coverageOf({ records: decisions, headSha: commit });
  if (coverage.ok) {
    process.stdout.write(
      `verdict: coverage complete for ${safeForDiagnosis(commit)} — ` +
        `${coverage.launched.length} reviewer(s) launched, every one of them answered for ` +
        'that commit.\n',
    );
    process.exit(0);
  }

  const lines = [];
  if (coverage.reason !== undefined) lines.push(`  ${coverage.reason}`);
  for (const [key, why] of CASES) {
    // Through the sanitiser like every other quoted value here: the names come
    // from the fan-out record, which `recordDecision` checks as strings and
    // nothing more, and a name carrying a cursor sequence repaints this refusal
    // as a pass for whoever is watching the scrollback.
    for (const reviewer of coverage[key]) lines.push(`  ${safeForDiagnosis(reviewer)} — ${why}`);
  }
  refuse(
    `verdict: the fan-out for ${safeForDiagnosis(commit)} is not covered.\n` +
      `${lines.join('\n')}\n`,
  );
}

if (subcommand !== 'check') {
  refuse(`verdict: \`${subcommand}\` is not a subcommand of this tool.\n${USAGE}`);
}
if (source === undefined) {
  refuse(`verdict: \`check\` needs the report to read; no file was given.\n${USAGE}`);
}

const result = parseVerdict(readReport(source));

if (!result.ok) {
  refuse(
    `verdict: the report at ${source} does not end in a verdict this gate can act on. ` +
      'Treat it as `incomplete` — the gate did not answer, which is not the same as ' +
      'answering that nothing is wrong.\n' +
      result.problems.map((problem) => `  - ${problem}\n`).join(''),
  );
}

if (expectedGate !== undefined && result.verdict.gate !== expectedGate) {
  refuse(
    `verdict: the report at ${source} was checked as ` +
      `\`${safeForDiagnosis(expectedGate)}\`, and the block it ends with answers for ` +
      `\`${safeForDiagnosis(result.verdict.gate)}\`. One capture holding two gates' ` +
      "answers says only what the second one said, so the first one's verdict — a stop, " +
      'as often as not — would go unread. Check each report on its own.\n',
  );
}

try {
  process.stdout.write(`${JSON.stringify(result.verdict, null, 2)}\n`);
} catch {
  // A verdict can parse and still be unprintable: nothing refuses an unknown
  // key inside a blocker, and one nested deeply enough defeats the printer.
  // Uncaught it is a raw stack, which this file promises never to emit — and a
  // legitimate stop then reads as `incomplete` with no way to see why.
  refuse(
    `verdict: the verdict in ${source} parsed, and could not be printed — a blocker ` +
      'nested far past anything a reader needs. Nothing was printed; flatten the ' +
      'blocker and answer again.\n',
  );
}
