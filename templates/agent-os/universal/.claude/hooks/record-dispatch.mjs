// record-dispatch.mjs — SubagentStart/SubagentStop hook (Claude Code and, via
// the Codex projection, Codex): journals one `dispatch-start`/`dispatch-end`
// EVENT per subagent this harness actually started, into the run journal
// (`.claude/scripts/run-journal.mjs`, `events.jsonl`) — the mechanical half of
// "did this reviewer even run", read back by `lib/gate-coverage.mjs`'s
// `witness` answer.
//
// observe-only: refuses nothing and returns no decision. It exits 0 on every
// path, writes nothing to stdout, and never throws out of `main()` — a
// `SubagentStop` hook that wrote a stdout decision could block a real session,
// and this hook must never carry that power by accident.
//
// The harness is read from `--harness=claude`/`--harness=codex` on argv —
// never guessed from the payload, which carries no reliable marker of which
// harness sent it. The run directory is `RIG_RUN_DIR` when declared, else the
// armed unattended flag's own `runDir` (`../scripts/unattended-flag.mjs`),
// else this hook writes nothing at all: a run nobody declared is not a run
// this hook may invent one for.
//
// The record is bounded by ONE allowlist, `DISPATCH_FIELDS`: every key is
// filtered through it immediately before the write, so a field added to the
// payload handling but not to the list never reaches the journal. It is
// exported so this hook's own test can compare it with the independent copy it
// keeps (`.claude/rules/invariants.md`, the independent-oracle
// invariant): `schema`, `harness`, `controller`, `agentType`, `agentRef`,
// `declaredModel`, `declaredEffort`, `declaredSource`. `controller` and
// `agentRef` are never the raw `session_id`/`agent_id` — they are
// `sha256(basename(runDir) + "\0" + value).slice(0, 16)`, so the record names
// no id a reader could correlate outside this one run.
//
// LIMITS, stated because a hook's own claim about its reach is the first thing
// to go stale:
//   - **No run directory declared → nothing recorded, not zero coverage.** A
//     reader comparing a launched set against zero dispatch-start events must
//     report that as UNAVAILABLE evidence, never as "nobody was witnessed" —
//     `lib/gate-coverage.mjs`'s `witness` answer does exactly that.
//   - **A Codex project hook may be skipped until the project is trusted.**
//     Codex does not run project-level hooks for an untrusted project, so a
//     Codex run's dispatch trace may simply be absent for a reason this hook
//     cannot see or report.
//   - **`controller` is Claude-only, and unmeasured on Codex.** Codex's own
//     session-id equivalent (if any) has not been observed on this hook's
//     stdin, so `controller` is omitted rather than guessed for any harness
//     other than `claude`.
//   - **`declaredModel`/`declaredEffort` are read from a small bounded head of
//     one definition file** (`.claude/agents/<type>.md` frontmatter for
//     Claude, `.codex/agents/<type>.toml` for Codex) and are omitted, not
//     guessed, when that file is absent, unreadable, or names an effort
//     outside the accepted enum.
//
// PRIVACY: this record never carries `cwd`, a transcript path, a prompt, a
// response, a raw `session_id`/`agent_id`, or an email address — see
// dispatch-journal.test.ts (absent in a generated rig) › "never persists the
// payload fields the item forbids".
//
// Pinned in dispatch-journal.test.ts (absent in a generated rig) › "exits 0
// and prints nothing when RIG_RUN_DIR is unset and no unattended flag is
// armed", › "records a dispatch-start event on SubagentStart, keyed by
// agentRef", › "records a dispatch-end event on SubagentStop, with the same
// agentRef as the matching start", › "reports 'claude' when spawned with
// --harness=claude", › "carries controller = ref(runDir, session_id) on
// Claude, when session_id is a string", › "reads declaredModel/declaredEffort/
// declaredSource from Claude agent frontmatter", › "reads declaredModel/
// declaredEffort/declaredSource from a Codex agent profile", and › "exports
// DISPATCH_FIELDS equal to this test's own independent copy, in both
// directions".
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib/hook-input.mjs';
import { recordEvent } from '../scripts/run-journal.mjs';
import { readUnattended } from '../scripts/unattended-flag.mjs';

/** The one allowlist a record's `data` may carry — see the header. */
export const DISPATCH_FIELDS = Object.freeze([
  'schema',
  'harness',
  'controller',
  'agentType',
  'agentRef',
  'declaredModel',
  'declaredEffort',
  'declaredSource',
]);

/** A narrow, allowlisted shape for an agent type — never echoed unless it matches. */
const AGENT_TYPE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** The `effort:`/`model_reasoning_effort` values this hook will ever declare. */
const DECLARED_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** How much of a definition file this hook reads — small, and bounded. */
const MAX_DEFINITION_BYTES = 8 * 1024;

/** Open without blocking a FIFO, exactly as the sibling routing guard does. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * `ref(runDir, x) = sha256(basename(runDir) + "\0" + x).slice(0, 16)` — the
 * one hash both `controller` and `agentRef` go through, so neither carries the
 * raw id it stands in for.
 */
const ref = (runDir, value) =>
  createHash('sha256')
    .update(`${path.basename(runDir)}\0${value}`)
    .digest('hex')
    .slice(0, 16);

/** `RIG_RUN_DIR` when declared, else the armed unattended flag's own `runDir`; else `null`. */
function resolveRunDir(env) {
  const declared = env.RIG_RUN_DIR;
  if (typeof declared === 'string' && declared.trim() !== '') return declared;
  const flag = readUnattended(env);
  if (flag && flag.on === true && typeof flag.runDir === 'string' && flag.runDir.trim() !== '') {
    return flag.runDir;
  }
  return null;
}

/** `'claude'`/`'codex'` from an explicit `--harness=` flag; never guessed, and never anything else. */
function harnessOf(argv) {
  for (const arg of argv) {
    if (arg === '--harness=claude') return 'claude';
    if (arg === '--harness=codex') return 'codex';
  }
  return null;
}

/** The first `MAX_DEFINITION_BYTES` of a regular file, or `null` when it cannot be read. */
function readDefinitionHead(file) {
  let fd;
  try {
    fd = openSync(file, OPEN_FLAGS);
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_DEFINITION_BYTES);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing left to release
      }
    }
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;

/** `{ model?, effort? }` read from a Claude agent definition's frontmatter. */
function claudeDeclaredFields(text) {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = FRONTMATTER.exec(stripped);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== 'model' && key !== 'effort') continue;
    fields[key] = line.slice(separator + 1).trim();
  }
  return fields;
}

const TOML_FIELD = /^(model|model_reasoning_effort)\s*=\s*"([^"]*)"\s*$/;

/** `{ model?, effort? }` read from a Codex agent profile's `model`/`model_reasoning_effort`. */
function codexDeclaredFields(text) {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fields = {};
  for (const rawLine of stripped.split(/\r?\n/)) {
    const match = TOML_FIELD.exec(rawLine.trim());
    if (!match) continue;
    if (match[1] === 'model') fields.model = match[2];
    else fields.effort = match[2];
  }
  return fields;
}

/** `{ model?, effort? }` for `agentType`, from the definition file the harness names; `null` when unreadable. */
function definitionFields(agentType, harness, projectRoot) {
  if (harness === 'codex') {
    const text = readDefinitionHead(path.join(projectRoot, '.codex', 'agents', `${agentType}.toml`));
    return text === null ? null : codexDeclaredFields(text);
  }
  const text = readDefinitionHead(path.join(projectRoot, '.claude', 'agents', `${agentType}.md`));
  return text === null ? null : claudeDeclaredFields(text);
}

function main() {
  try {
    const input = readHookInput();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 0;

    const eventName = input.hook_event_name;
    if (eventName !== 'SubagentStart' && eventName !== 'SubagentStop') return 0;

    const agentId = input.agent_id;
    if (typeof agentId !== 'string') return 0;

    const runDir = resolveRunDir(process.env);
    if (!runDir) return 0;

    const harness = harnessOf(process.argv.slice(2));
    const kind = eventName === 'SubagentStart' ? 'dispatch-start' : 'dispatch-end';

    const data = { schema: 1 };
    if (harness) data.harness = harness;
    if (harness === 'claude' && typeof input.session_id === 'string') {
      data.controller = ref(runDir, input.session_id);
    }

    const rawAgentType = input.agent_type;
    const agentType =
      typeof rawAgentType === 'string' && AGENT_TYPE_RE.test(rawAgentType) ? rawAgentType : null;
    if (agentType) data.agentType = agentType;

    data.agentRef = ref(runDir, agentId);

    if (agentType) {
      const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const declared = definitionFields(agentType, harness, projectRoot);
      if (declared) {
        let sourced = false;
        if (typeof declared.model === 'string' && declared.model.trim() !== '') {
          data.declaredModel = declared.model.trim();
          sourced = true;
        }
        if (typeof declared.effort === 'string' && DECLARED_EFFORTS.has(declared.effort.trim())) {
          data.declaredEffort = declared.effort.trim();
          sourced = true;
        }
        if (sourced) data.declaredSource = 'agent-definition';
      }
    }

    try {
      const bounded = Object.fromEntries(
        Object.entries(data).filter(([key]) => DISPATCH_FIELDS.includes(key)),
      );
      recordEvent({ runDir, kind, data: bounded, now: new Date().toISOString() });
    } catch {
      // Every `RunJournalError` (undeclared, missing, ended, unusable, busy) is
      // swallowed here on purpose — this hook is observe-only, and a lost
      // record costs the trace, never the session.
    }
  } catch {
    // A broken observation must never make the session unusable.
  }
  return 0;
}

/**
 * Whether this file is being run as a script rather than imported — the
 * realpath on both sides, as `inject-rules.mjs` explains, so a symlinked
 * checkout still runs.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
}

if (invokedDirectly()) {
  process.exit(main());
}
