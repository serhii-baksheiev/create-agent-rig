#!/usr/bin/env node
/**
 * The verdict CLI — what a gate runs before it believes a reviewer.
 *
 *   node .claude/scripts/verdict.mjs check <file> [gate]   # `-` reads stdin
 *
 * It reads a gate's report, hands it to `lib/verdict.mjs`, and either prints the
 * parsed verdict on stdout (exit 0) or refuses with a diagnosis on stderr
 * (exit 1). All the deciding lives in the module; this file is the call site.
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

import { parseVerdict, safeForDiagnosis } from './lib/verdict.mjs';

const USAGE =
  'usage: node .claude/scripts/verdict.mjs check <file> [gate]   ' +
  '(`-` reads the report from stdin)\n';

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
