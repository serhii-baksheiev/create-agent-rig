#!/usr/bin/env node
/**
 * The verdict CLI — what a gate runs before it believes a reviewer.
 *
 *   node .claude/scripts/verdict.mjs check <file>   # or `-` for stdin
 *
 * It reads a gate's report, hands it to `lib/verdict.mjs`, and either prints the
 * parsed verdict on stdout (exit 0) or refuses with a diagnosis on stderr
 * (exit 1). All the deciding lives in the module; this file is the call site.
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

import { parseVerdict } from './lib/verdict.mjs';

const USAGE =
  'usage: node .claude/scripts/verdict.mjs check <file>   (`-` reads the report from stdin)\n';

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

const [subcommand, source] = process.argv.slice(2);

if (subcommand !== 'check' || source === undefined) {
  // A guessed subcommand is a check nobody ran reported as one that passed.
  refuse(
    subcommand === undefined
      ? USAGE
      : `verdict: \`${subcommand}\` is not a subcommand of this tool.\n${USAGE}`,
  );
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

process.stdout.write(`${JSON.stringify(result.verdict, null, 2)}\n`);
