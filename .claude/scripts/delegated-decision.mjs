#!/usr/bin/env node
// Durable evidence of a `delegated` authority's resolution of an owner-gated
// decision (RP-340), built on the RP-339 authority contract
// (`.claude/scripts/lib/authority.mjs`).
//
// A replacement controller — another session, another machine, days later —
// has to be able to tell an ALREADY-MADE delegated decision from an
// unresolved owner one without depending on conversational memory: the
// session that made the call may be long gone, compacted, or simply someone
// else's. This file is the one place that records that call, durably, in
// `<project root>/.rig/decisions/<ticket>.jsonl` — one append-only line per
// decision — and reads it back:
//
//   node .claude/scripts/delegated-decision.mjs record --ticket <id> \
//        --decision <kind> --summary <text> [--evidence <text>] [--post]
//   node .claude/scripts/delegated-decision.mjs list --ticket <id> [--json]
//
// `record` may resolve nothing on its own authority. It reads the run's OWN
// declared authority — `run-state.mjs`'s `decisionAuthority`, written by
// `node run-state.mjs authority owner|delegated` into the SAME run directory
// (RP-340's other half, `run-state-authority.test.ts`) — and refuses unless
// that run is exactly `delegated` AND `--decision` names an id
// `DELEGABLE_DECISIONS` lists. An absent authority reads as `owner`
// (`parseDecisionAuthority`'s own default), and every `NON_DELEGABLE_BOUNDARIES`
// id (`publication`, `kill-switch`, …) is refused regardless of authority — the
// same three-way split `mayResolve` enforces, read here rather than
// reimplemented.
//
// `list` needs no run directory and no declared authority at all: it is the
// read side a FRESH controller uses before doing anything else, and it reads
// only what is already on disk.
//
// It NEVER records a transcript, a prompt, source code, or a credential.
// `summary`/`evidence` go through the EXACT SAME whole-field redaction
// `continuation.mjs` already built — `composeCappedTextField`, imported
// rather than copied (`.claude/rules/invariants.md`: "one mechanism, one
// implementation") — so a credential-shaped value becomes `[redacted]`, an
// absolute path becomes `[path]`, an embedded line terminator is collapsed,
// and the stored value is capped at 500 characters with an explicit
// `[truncated]` marker. `ticket`/`branch`/`head` go through
// `composeTextField`, the same module's structured-field pipeline (secret
// check, path scrub, newline collapse, no free-text cap). See
// `continuation.mjs`'s own header for the redaction rules in full; this file
// never re-derives them.
//
// `--post` is the only thing that touches the network, resolved exactly the
// way `continuation.mjs --post` resolves it — `queue/index.mjs`'s
// `loadConfig` + `resolveAdapter`, then that adapter's `comment()`. Without
// it, `record` never reads `.claude/queue.json` and never resolves an
// adapter at all; a project with no such file records perfectly well.
//
// --- Limits -------------------------------------------------------------
//
// - A ticket id is accepted only by SHAPE: 1-64 characters, starting with a
//   letter or digit, the rest letters/digits/`_`/`-` (`decisionsPathFor`'s
//   own `SAFE_TICKET` pattern). This is deliberately narrower than
//   `continuation.mjs`'s own tracker-key shape — the value here becomes a
//   FILENAME, not merely an interpolated string, so a path separator or a
//   `..` segment is refused outright rather than scrubbed.
// - `list` never reads a decisions file larger than 256 KiB, and never
//   partially: the size is checked (`statSync`) BEFORE any read, so an
//   oversized file is refused whole, the same "fail closed, not truncate"
//   rule `run-state.mjs`'s own state-file bound uses.
// - `parseDecisions` validates in two passes, not one interleaved walk: every
//   line's JSON syntax is checked FIRST, in order, and the first syntactically
//   invalid line ends the scan immediately — only once every line parses does
//   a second pass check that each record carries all nine required keys, in
//   order, reporting the first one that does not. A file whose line 2 is
//   malformed JSON is reported as a line-2 problem even when line 1 would
//   separately fail the key check — the two passes never run interleaved line
//   by line.
// - Recording bypasses no mechanical gate: this module never writes to a run
//   journal's `decisions.jsonl` as a VERDICT (it uses `run-journal.mjs`'s
//   `recordEvent`-adjacent `recordDecision` only as a LOCAL trace of what this
//   run did, gated `delegated-decision`), never calls `revalidate.mjs`,
//   `queue/core.mjs`, or `verdict.mjs`, and neither of those three ever
//   references `.rig/decisions` or this file — a delegated decision is
//   evidence of what was decided and why, never a substitute input to a
//   check that reads its own inputs.
//
// See `test/template/delegated-decision.test.ts` (absent in a generated rig)
// for every case above, by name, next to the assertion that proves it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutGitLocation } from './git-env.mjs';
import { composeCappedTextField, composeTextField } from './continuation.mjs';
import { readState } from './run-state.mjs';
import { DECISION_AUTHORITIES, mayResolve, parseDecisionAuthority } from './lib/authority.mjs';
import { recordDecision } from './run-journal.mjs';

const DECISIONS_ROOT = ['.rig', 'decisions'];
const MAX_DECISIONS_BYTES = 256 * 1024;

/** 1-64 characters; starts with a letter or digit; the rest letters, digits, `_` or `-`. */
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * `<projectRoot>/.rig/decisions/<ticket>.jsonl`. Throws, naming nothing
 * beyond "unsafe", when `ticket` is not a string matching {@link SAFE_TICKET}
 * — this value becomes a filename, so a path separator or a `..` segment is
 * refused outright rather than scrubbed, unlike the free-text fields below.
 */
export const decisionsPathFor = (projectRoot, ticket) => {
  if (typeof ticket !== 'string' || !SAFE_TICKET.test(ticket)) {
    throw new Error(
      `delegated-decision: ${JSON.stringify(ticket)} is not a safe ticket id — expected 1-64 ` +
        'characters, starting with a letter or digit, and only letters, digits, "_" or "-" after that.',
    );
  }
  return join(projectRoot, ...DECISIONS_ROOT, `${ticket}.jsonl`);
};

const REQUIRED_KEYS = Object.freeze([
  'schemaVersion',
  'ticket',
  'decision',
  'authority',
  'summary',
  'evidence',
  'branch',
  'head',
  'at',
]);

/**
 * Parse a decisions file's text into records, or report exactly where it is
 * unreadable. Two passes, never interleaved — see the module header's
 * "Limits" section for why: every line's JSON syntax first, in file order;
 * only once all of them parse does a second pass check every record carries
 * every key {@link REQUIRED_KEYS} names.
 */
export const parseDecisions = (text) => {
  if (text === '') return { ok: true, records: [] };

  const rawLines = text.split('\n');
  // Exactly one trailing empty element is the artefact of the file's own
  // final newline — every record line this module writes ends with one. A
  // blank line in the MIDDLE of the file is still a real line and still
  // fails the JSON check below.
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();

  const parsed = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    try {
      parsed.push(JSON.parse(rawLines[index]));
    } catch {
      return { ok: false, line: index + 1, reason: 'invalid JSON' };
    }
  }

  for (let index = 0; index < parsed.length; index += 1) {
    const record = parsed[index];
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return { ok: false, line: index + 1, reason: 'not a JSON object' };
    }
    const missing = REQUIRED_KEYS.filter((key) => !Object.hasOwn(record, key));
    if (missing.length > 0) {
      return { ok: false, line: index + 1, reason: `missing required field(s): ${missing.join(', ')}` };
    }
  }

  return { ok: true, records: parsed };
};

// --- CLI -----------------------------------------------------------------

const gitValue = (args, cwd) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
    }).trim();
  } catch {
    return null;
  }
};

const projectRootOf = (cwd) => gitValue(['rev-parse', '--show-toplevel'], cwd) ?? cwd;

const parseRecordArgs = (argv) => {
  const args = { ticket: undefined, decision: undefined, summary: undefined, evidence: undefined, post: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--ticket') args.ticket = argv[(i += 1)];
    else if (flag === '--decision') args.decision = argv[(i += 1)];
    else if (flag === '--summary') args.summary = argv[(i += 1)];
    else if (flag === '--evidence') args.evidence = argv[(i += 1)];
    else if (flag === '--post') args.post = true;
    else return { error: `record: unknown flag ${flag}` };
  }
  return { ok: true, ...args };
};

const parseListArgs = (argv) => {
  const args = { ticket: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--ticket') args.ticket = argv[(i += 1)];
    else if (flag === '--json') args.json = true;
    else return { error: `list: unknown flag ${flag}` };
  }
  if (typeof args.ticket !== 'string' || args.ticket === '') {
    return { error: 'list: --ticket is required.' };
  }
  return { ok: true, ...args };
};

const refuse = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const runRecord = async (argv, cwd) => {
  const parsed = parseRecordArgs(argv);
  if (!parsed.ok) return refuse(parsed.error);

  const projectRoot = projectRootOf(cwd);

  let decisionsPath;
  try {
    decisionsPath = decisionsPathFor(projectRoot, parsed.ticket);
  } catch (error) {
    return refuse(error.message);
  }

  if (typeof parsed.decision !== 'string' || parsed.decision === '') {
    return refuse('record: --decision is required.');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary === '') {
    return refuse('record: --summary is required and may not be empty.');
  }

  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    return refuse(
      'RIG_RUN_DIR is not set, so there is no run whose declared authority this could check — ' +
        'a decision recorded under nobody’s authority is not durable evidence of anything.',
    );
  }

  const rawAuthority = readState(runDir).decisionAuthority;
  const authority = parseDecisionAuthority(rawAuthority);
  if (authority === 'unknown') {
    return refuse(
      `run authority ${JSON.stringify(rawAuthority)} is not something this contract recognises ` +
        `— expected one of ${DECISION_AUTHORITIES.join(', ')}.`,
    );
  }
  if (authority !== 'delegated') {
    return refuse(
      `this decision needs a delegated run authority; this run's declared authority is owner. ` +
        'Only an owner may resolve it directly.',
    );
  }

  let allowed;
  try {
    allowed = mayResolve(parsed.decision, authority);
  } catch (error) {
    return refuse(error.message);
  }
  if (!allowed) {
    return refuse(
      `"${parsed.decision}" is a boundary that stays with the owner regardless of delegation.`,
    );
  }

  const branch = gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const head = gitValue(['rev-parse', 'HEAD'], cwd);

  const record = {
    schemaVersion: 1,
    ticket: composeTextField(parsed.ticket),
    decision: parsed.decision,
    authority,
    summary: composeCappedTextField(parsed.summary),
    evidence: parsed.evidence === undefined ? null : composeCappedTextField(parsed.evidence),
    branch: composeTextField(branch),
    head: composeTextField(head),
    at: new Date().toISOString(),
  };

  mkdirSync(dirname(decisionsPath), { recursive: true });
  appendFileSync(decisionsPath, `${JSON.stringify(record)}\n`);

  // A LOCAL trace of what this run did — never a substitute input to a check
  // that reads its own inputs (see the module header's "Limits" section).
  recordDecision({
    runDir,
    gate: 'delegated-decision',
    verdict: parsed.decision,
    why: record.summary,
    now: record.at,
  });

  process.stdout.write(`recorded ${parsed.decision} for ${parsed.ticket} -> ${decisionsPath}\n`);

  // `--post` is the ONLY branch that resolves a queue adapter or touches the
  // network — exactly the way `continuation.mjs --post` resolves one.
  if (parsed.post) {
    try {
      const { loadConfig, resolveAdapter } = await import('./queue/index.mjs');
      const configPath = join(projectRoot, '.claude', 'queue.json');
      const config = loadConfig(configPath);
      const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
      const result = await adapter.comment(
        { id: parsed.ticket },
        `delegated decision — ${parsed.decision}: ${record.summary}`,
        { env: process.env },
      );
      if (!result?.ok) {
        return refuse(
          `delegated-decision: the decision above was recorded but NOT posted — ` +
            `${result?.why ?? 'the adapter refused'}`,
        );
      }
    } catch (error) {
      return refuse(`delegated-decision: the decision above was recorded but NOT posted — ${error.message}`);
    }
  }

  process.exit(0);
};

const printList = (records, json) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(records)}\n`);
    return;
  }
  for (const record of records) {
    process.stdout.write(`${record.ticket} ${record.decision} ${record.at} — ${record.summary}\n`);
  }
};

const runList = (argv, cwd) => {
  const parsed = parseListArgs(argv);
  if (!parsed.ok) return refuse(parsed.error);

  const projectRoot = projectRootOf(cwd);

  let decisionsPath;
  try {
    decisionsPath = decisionsPathFor(projectRoot, parsed.ticket);
  } catch (error) {
    return refuse(error.message);
  }

  let stat;
  try {
    stat = statSync(decisionsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      printList([], parsed.json);
      process.exit(0);
    }
    process.stderr.write(`delegated-decision: ${decisionsPath} is unreadable — ${error.message}\n`);
    process.exit(2);
  }

  // Checked BEFORE any read, never partially: see the module header's
  // "Limits" section.
  if (stat.size > MAX_DECISIONS_BYTES) {
    process.stderr.write(
      `delegated-decision: ${decisionsPath} is unreadable — it exceeds ${MAX_DECISIONS_BYTES} bytes ` +
        'and is refused whole rather than partially read.\n',
    );
    process.exit(2);
  }

  const text = readFileSync(decisionsPath, 'utf8');
  const result = parseDecisions(text);
  if (!result.ok) {
    process.stderr.write(
      `delegated-decision: ${decisionsPath} line ${result.line} is unreadable — ${result.reason}\n`,
    );
    process.exit(2);
  }

  printList(result.records, parsed.json);
  process.exit(0);
};

/**
 * Was this file invoked directly? Compared by REALPATH on both sides, the
 * same shape every CLI sibling in this directory uses.
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
  const [command, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();

  if (command === 'record') {
    await runRecord(rest, cwd);
  } else if (command === 'list') {
    runList(rest, cwd);
  } else {
    process.stderr.write(
      `unknown command: ${command ?? '(none)'}. This CLI has two: \`record\` and \`list\`.\n`,
    );
    process.exit(1);
  }
}
