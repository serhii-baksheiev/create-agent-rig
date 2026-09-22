#!/usr/bin/env node
/**
 * release-evidence.mjs — read-only, deterministic. Turns existing run-journal
 * evidence (gate-blocker patterns, filed triage proposals) into a
 * REPEATED_PAIN or GATHER_MORE_EVIDENCE verdict, for the `release-propose`
 * skill to read (RP-203). It files nothing itself — see
 * test/template/release-evidence.test.ts (absent in a generated rig).
 *
 *   node .claude/scripts/release-evidence.mjs --since <ISO> [--runs <dir>] [--json]
 *
 * Reads `<runs>/<run-id>/` the same way `revalidation-report.mjs` does — this
 * script reuses that script's `readRuns` (default `--runs` also resolves
 * through `queue/checkout.mjs`'s `mainCheckoutRoot`, the same main-checkout
 * rule) and `run-journal.mjs`'s `readRun`. A run `readRun` refuses is counted
 * under `runs.skipped`, with why, never dropped silently.
 *
 * Grouping keys: `gate-blocker|<gate>|<norm(rule)>` for each blocker on a
 * `decisions.jsonl` record; `proposal|<data.id>` for each `events.jsonl`
 * record with `kind === 'proposal'` and `data.ok === true`. A group is
 * `repeated` only when its records come from at least `REPEATED_MIN_RUNS`
 * distinct run directories — any number of records inside one run is one
 * anecdote.
 *
 * Limits: grouping is lexical (exact gate plus a normalised blocker rule, or
 * a proposal fingerprint) — merging rules that mean the same thing but read
 * differently is inference this script does not attempt. Run independence is
 * assumed, not proven: one PR can span more than one run directory, which
 * this script has no way to detect and would then double-count as two.
 */

import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from './queue/checkout.mjs';
import { readRuns } from './revalidation-report.mjs';

export const REPEATED_MIN_RUNS = 2;

const norm = (rule) => rule.trim().toLowerCase().replace(/\s+/g, ' ');

/** The report over already-read runs — pure, so the grouping is testable alone. */
export const evidenceOf = ({ runs, since }) => {
  const sinceMs = Date.parse(since);
  const read = [];
  const skipped = [];
  const groups = new Map();

  const addRecord = (key, source, gate, label, run, at, pointer) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, source, gate, label, records: 0, runsSeen: new Set(), firstAt: at, lastAt: at, pointers: [] };
      groups.set(key, group);
    }
    group.records += 1;
    group.runsSeen.add(run);
    if (Date.parse(at) < Date.parse(group.firstAt)) group.firstAt = at;
    if (Date.parse(at) > Date.parse(group.lastAt)) group.lastAt = at;
    group.pointers.push(pointer);
  };

  for (const entry of runs) {
    if (entry.error) {
      skipped.push({ run: entry.run, why: entry.error });
      continue;
    }
    read.push(entry.run);

    for (const record of entry.decisions ?? []) {
      if (!(Date.parse(record.at) >= sinceMs)) continue;
      for (const blockerItem of record.blockers ?? []) {
        const rule = blockerItem?.rule;
        if (typeof rule !== 'string' || rule.trim() === '') continue;
        const gate = record.gate ?? 'unknown';
        const label = norm(rule);
        addRecord(`gate-blocker|${gate}|${label}`, 'gate-blocker', gate, label, entry.run, record.at, {
          run: entry.run,
          file: 'decisions.jsonl',
          seq: record.seq,
        });
      }
    }

    for (const event of entry.events ?? []) {
      if (event.kind !== 'proposal') continue;
      if (event.data?.ok !== true) continue;
      const id = event.data?.id;
      if (id === undefined || id === null) continue;
      if (!(Date.parse(event.at) >= sinceMs)) continue;
      addRecord(`proposal|${id}`, 'proposal', null, String(id), entry.run, event.at, {
        run: entry.run,
        file: 'events.jsonl',
        seq: event.seq,
      });
    }
  }

  const groupList = [...groups.values()].map((group) => ({
    key: group.key,
    source: group.source,
    gate: group.gate,
    label: group.label,
    records: group.records,
    runs: group.runsSeen.size,
    repeated: group.runsSeen.size >= REPEATED_MIN_RUNS,
    firstAt: group.firstAt,
    lastAt: group.lastAt,
    pointers: group.pointers,
  }));

  groupList.sort((a, b) => {
    if (a.repeated !== b.repeated) return a.repeated ? -1 : 1;
    if (a.runs !== b.runs) return b.runs - a.runs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const verdict = groupList.some((group) => group.repeated) ? 'REPEATED_PAIN' : 'GATHER_MORE_EVIDENCE';
  const why =
    verdict === 'REPEATED_PAIN'
      ? `at least one group recurred across ${REPEATED_MIN_RUNS}+ distinct run directories`
      : 'no group recurred across distinct run directories since the window opened; an anecdote is not evidence';

  return {
    schemaVersion: 1,
    since,
    rule: {
      repeatedMinRuns: REPEATED_MIN_RUNS,
      unit: 'distinct run directory',
      grouping: 'exact gate + normalised blocker rule; proposal fingerprint',
    },
    runs: { read: read.length, skipped },
    groups: groupList,
    verdict,
    why,
    limits: [
      'grouping is lexical; merging similar rules is inference',
      'run independence is assumed, not proven (one PR can span runs)',
    ],
  };
};

const parseArgs = (argv) => {
  const args = { since: null, runs: null, json: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--since') args.since = argv[++i] ?? null;
    else if (arg === '--runs') args.runs = argv[++i] ?? null;
    else if (args.bad === null) args.bad = arg;
  }
  return args;
};

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
  const refuse = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };
  if (args.bad !== null) refuse(`unrecognised argument: ${args.bad}`);
  if (!args.since || Number.isNaN(Date.parse(args.since))) {
    refuse(`--since needs an ISO date (got ${args.since ?? '(none)'}); a report with no window reports nothing honest.`);
  }
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const runsDir = args.runs ?? join(mainCheckoutRoot(join(scriptsDir, '..', '..')), '.claude', 'runs');
  let runs;
  try {
    runs = readRuns(runsDir);
  } catch (error) {
    refuse(error.message);
  }
  const evidence = evidenceOf({ runs, since: new Date(args.since).toISOString() });
  // Always JSON: the one output shape `release-propose` reads. `--json` is
  // accepted (every call site may pass it) but does not change the shape —
  // there is no separate human-summary mode to opt out of.
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
