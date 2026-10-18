#!/usr/bin/env node
/**
 * The verdict CLI — what a gate runs before it believes a reviewer.
 *
 *   node .claude/scripts/verdict.mjs check <file> [gate]   # `-` reads stdin
 *   node .claude/scripts/verdict.mjs coverage <commit>    # reads the run journal
 *   node .claude/scripts/verdict.mjs findings <before-seq> <after-seq>
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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { coverageOf } from './lib/gate-coverage.mjs';
import { GATE_VOCABULARY, isCommitId, parseVerdict, safeForDiagnosis } from './lib/verdict.mjs';
import { readRun } from './run-journal.mjs';
import { withoutGitLocation } from './git-env.mjs';

/** The one path a record-only commit may touch: the item's evidence record (RP-437). */
const EVIDENCE_PREFIX = '.rig/evidence/';
const MAX_RECORD_WALK = 32;

/**
 * The heads evidence may be bound to and still be current at `commit`: the
 * commit itself, and — walking first parents — every commit reached through
 * commits that change only `.rig/evidence/`, up to and
 * including the first commit that changes anything else. Committing an
 * evidence record moves HEAD without changing the code under review, so it
 * must not make that evidence stale. Bounded; any git failure answers the
 * commit alone, which can only make evidence read MORE stale, never less.
 */
const currentHeadsAt = (commit) => {
  const git = (args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: withoutGitLocation(),
    });
  try {
    const chain = git(['rev-list', '--first-parent', `--max-count=${MAX_RECORD_WALK}`, commit])
      .split('\n')
      .filter(Boolean);
    const heads = [];
    for (const sha of chain) {
      heads.push(sha);
      const changed = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha])
        .split('\n')
        .filter(Boolean);
      const recordOnly =
        changed.length > 0 &&
        changed.every((file) => file.startsWith(EVIDENCE_PREFIX));
      if (!recordOnly) break;
    }
    return heads.length > 0 ? heads : [commit];
  } catch {
    return [commit];
  }
};

const USAGE =
  'usage: node .claude/scripts/verdict.mjs check <file> [gate]   ' +
  '(`-` reads the report from stdin)\n' +
  '       node .claude/scripts/verdict.mjs coverage <commit>   ' +
  '(reads the run journal in $RIG_RUN_DIR)\n' +
  '       node .claude/scripts/verdict.mjs findings <before-seq> <after-seq>   ' +
  '(compares two journaled reviewer decisions)\n';

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

const args = process.argv.slice(2);
const [subcommand, source, expectedGate] = args;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

// The reviewing roles derive from the shared gate vocabulary. pr-ship makes a
// SHIP/HOLD decision too, but it consumes reviewer verdicts rather than being
// a reviewer whose findings can be compared.
const isReviewerGate = (gate) => {
  if (typeof gate !== 'string' || gate === 'pr-ship' || !Object.hasOwn(GATE_VOCABULARY, gate)) {
    return false;
  }
  const words = GATE_VOCABULARY[gate];
  return words.includes('SHIP') && words.includes('HOLD');
};

const sequence = (value, position) => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    refuse(
      `verdict: the ${position} sequence must be a positive integer identifying an already-journaled ` +
        'review decision.\n',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    refuse(`verdict: the ${position} sequence is outside the journal's safe integer range.\n`);
  }
  return parsed;
};

const findingIdentity = (blocker, position) => {
  if (!isPlainObject(blocker)) {
    refuse(`verdict: ${position} has a blocker that is not an object, so its identity is ambiguous.\n`);
  }
  if (Object.hasOwn(blocker, 'id')) {
    if (!isText(blocker.id)) {
      refuse(`verdict: ${position} has a blocker id that is not a non-blank string.\n`);
    }
    return `id:${JSON.stringify(blocker.id)}`;
  }
  if (!isText(blocker.rule) || !isText(blocker.note)) {
    refuse(
        `verdict: ${position} has a legacy blocker without a usable rule and note tuple, ` +
        'so its identity is ambiguous.\n',
    );
  }
  // parseVerdict already validated location pairs. A finding may legitimately
  // have no location, so retain that absence as explicit null tuple entries.
  return `legacy:${JSON.stringify([
    blocker.file ?? null,
    blocker.line ?? null,
    blocker.rule,
    blocker.note,
  ])}`;
};

const reviewedDecision = (record, position) => {
  if (!isPlainObject(record)) refuse(`verdict: the ${position} record is malformed.\n`);
  if (!Object.hasOwn(record, 'blockers') || !Array.isArray(record.blockers)) {
    refuse(`verdict: the ${position} reviewer decision needs an explicit blockers array.\n`);
  }
  if (!Object.hasOwn(record, 'headSha')) {
    refuse(`verdict: the ${position} reviewer decision names no explicit headSha for the reviewed head.\n`);
  }

  // Journal records predate this command and recordDecision deliberately accepts
  // a permissive shape. Project the fields this command consumes through the
  // verdict parser instead of introducing a second schema for review evidence.
  const parsed = parseVerdict(
    `\`\`\`json\n${JSON.stringify({
      gate: record.gate,
      verdict: record.verdict,
      blockers: record.blockers,
      headSha: record.headSha,
    })}\n\`\`\``,
  );
  if (!parsed.ok) {
    refuse(`verdict: the ${position} reviewer decision is malformed: ${parsed.problems.join(' ')}\n`);
  }
  if (!isReviewerGate(parsed.verdict.gate)) {
    refuse(`verdict: the ${position} record is not a reviewer decision in the verdict vocabulary.\n`);
  }
  if (parsed.verdict.verdict !== 'SHIP' && parsed.verdict.verdict !== 'HOLD') {
    refuse(`verdict: the ${position} reviewer decision may use only SHIP or HOLD.\n`);
  }

  const identities = new Set();
  for (const blocker of parsed.verdict.blockers) {
    const identity = findingIdentity(blocker, position);
    if (identities.has(identity)) {
      refuse(`verdict: the ${position} record has a duplicate finding identity, so the comparison is ambiguous.\n`);
    }
    identities.add(identity);
  }
  return { verdict: parsed.verdict, identities };
};

const decisionAt = (decisions, sequenceNumber, position) => {
  const record = decisions.find((candidate) => candidate?.seq === sequenceNumber);
  if (record === undefined) {
    refuse(`verdict: the ${position} record with sequence ${sequenceNumber} is not in this run journal.\n`);
  }
  return record;
};

const findings = (beforeArgument, afterArgument) => {
  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    refuse('verdict: `findings` needs RIG_RUN_DIR declared to read already-journaled decisions.\n');
  }
  const beforeSequence = sequence(beforeArgument, 'before');
  const afterSequence = sequence(afterArgument, 'after');

  let decisions;
  try {
    ({ decisions } = readRun({ runDir }));
  } catch (error) {
    refuse(
      `verdict: the run journal in ${runDir} could not be read, so findings were not checked ` +
        `(${error?.message ?? 'unknown error'}).\n`,
    );
  }

  const beforeRecord = decisionAt(decisions, beforeSequence, 'before');
  const afterRecord = decisionAt(decisions, afterSequence, 'after');
  if (afterSequence <= beforeSequence) {
    refuse('verdict: the after sequence must be greater than the before sequence.\n');
  }
  const before = reviewedDecision(beforeRecord, 'before');
  const after = reviewedDecision(afterRecord, 'after');
  if (before.verdict.gate !== after.verdict.gate) {
    refuse('verdict: findings may compare only the same reviewer role; the reviewer roles differ.\n');
  }

  const resolved = before.verdict.blockers.filter(
    (blocker) => !after.identities.has(findingIdentity(blocker, 'before')),
  );
  const unresolved = after.verdict.blockers.filter((blocker) =>
    before.identities.has(findingIdentity(blocker, 'after')),
  );
  const discovered = after.verdict.blockers.filter(
    (blocker) => !before.identities.has(findingIdentity(blocker, 'after')),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        before: {
          seq: beforeSequence,
          gate: before.verdict.gate,
          headSha: before.verdict.headSha,
        },
        after: {
          seq: afterSequence,
          gate: after.verdict.gate,
          headSha: after.verdict.headSha,
        },
        resolved,
        unresolved,
        new: discovered,
      },
      null,
      2,
    )}\n`,
  );
};

// Missing and unknown subcommands have different repairs: an operator told the
// subcommand is unknown goes looking for a typo that is not there.
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

  // The one commit field this command owns, and the only one shaped before it is
  // compared: the journal is the other way in and `recordDecision` takes any
  // non-blank string, which is why `sameCommit` enforces its own floor and
  // ceiling rather than trusting an upstream check. Without this arm
  // `coverage <a-full-sha>garbage` prefix-matched its way to "covered" — the
  // answer that ends in a merge.
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
  let events;
  try {
    ({ decisions, events } = readRun({ runDir }));
  } catch (error) {
    refuse(
      `verdict: the run journal in ${runDir} could not be read, so coverage was not ` +
        `checked (${error?.message ?? 'unknown error'}).\n`,
    );
  }

  const coverage = coverageOf({
    records: decisions,
    headSha: commit,
    events,
    currentHeads: currentHeadsAt(commit),
  });

  // RP-225 slice 2, advisory only — never affects the exit code or `coverage.ok`.
  // Named per reviewer so an operator sees exactly which launched name has no
  // corresponding `dispatch-start` in the run journal, not just a count.
  const witnessLine =
    coverage.witness && Object.keys(coverage.witness).length > 0
      ? `  witness: ${Object.entries(coverage.witness)
          .map(([name, status]) => `${safeForDiagnosis(name)}=${status}`)
          .join(', ')}\n`
      : '';
  // Advisory, like the witness line: printed only when the run journaled any
  // artifact evidence, and it never changes the exit code (RP-312).
  const evidence = coverage.evidence ?? { current: [], stale: [] };
  const evidenceLine =
    evidence.current.length + evidence.stale.length > 0
      ? `  evidence: ${evidence.current.length} current, ${evidence.stale.length} stale\n`
      : '';

  if (coverage.ok) {
    process.stdout.write(
      `verdict: coverage complete for ${safeForDiagnosis(commit)} — ` +
        `${coverage.launched.length} reviewer(s) launched, every one of them answered for ` +
        'that commit.\n' +
        witnessLine +
        evidenceLine,
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
      `${lines.join('\n')}\n` +
      witnessLine +
      evidenceLine,
  );
}

if (subcommand === 'findings') {
  if (args.length !== 3) {
    refuse(`verdict: \`findings\` needs exactly a before and an after sequence.\n${USAGE}`);
  }
  findings(source, expectedGate);
  process.exit(0);
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
