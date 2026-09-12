// PreToolUse hook (Claude Code's Agent tool): a subagent whose project
// definition pins its model is never dispatched with a call-site `model`.
//
// Why it exists. Claude Code takes a subagent's model from the per-invocation
// `model` parameter FIRST, and only then from the definition's `model:` line
// (Claude Code's sub-agents documentation, "model resolution"). A pin is
// therefore only as strong as every call site: the generator's
// docs/capability-evidence.json (absent in a generated rig) records a pinned
// agent that ran the call-site model instead — mechanism `subagent-model-pin`,
// surface `Agent tool call-site model, without guard-subagent-model`. Which
// model a role reads with is the routing policy's decision
// (docs/decisions/subagent-routing.md), not one dispatch's.
//
// What "pinned" means here: `<project>/.claude/agents/<subagent_type>.md` is a
// regular file whose leading frontmatter carries a `model:` line with a value
// other than `inherit`. The project root is CLAUDE_PROJECT_DIR, else the working
// directory. One leading byte-order mark is not content and is skipped.
//
// The three outcomes (.claude/rules/invariants.md):
// - allow — nothing it can read, another event, no call-site model, or an
//   ad-hoc subagent: no `subagent_type`, a built-in, a name that is not a plain
//   file name (`plugin:agent`, `../x`), no such file, a path that is not a
//   regular file (a directory, a FIFO — opened without waiting, never read), or
//   no pin in it;
// - block — a call-site model for a pinned agent;
// - refuse to inspect — `model` or `subagent_type` PRESENT in a shape other
//   than a string (resend it as one), or a frontmatter that does not close
//   within MAX_HEAD_BYTES (a bound crossed).
// An error opening or reading the agent file fails open, like every guard here.
//
// Bounded work: one non-blocking open, one fstat, one read of at most
// MAX_HEAD_BYTES + 1 bytes, one frontmatter match, and one pass over its lines
// with a prefix test per line. Nothing recurses or rescans.
//
// Limits, stated so nobody relies on cover that is not here:
// - project agents only. A user-level or plugin agent that pins a model is not
//   a role of this project, and its call-site model is allowed;
// - the file is found by the dispatched name, so a project agent whose
//   frontmatter `name` differs from its file name is not matched;
// - `model:` is read as a frontmatter line, not through a YAML parser, so a pin
//   spelled another YAML way (a quoted key) is not seen.
// Pinned in the generator's test/template/subagent-routing-hooks.test.ts
// (absent in a generated rig) › "blocks a call-site model on a project agent
// that pins one, and says to re-dispatch without it", › "never resolves %s to a
// project agent file, so the call is allowed", › "refuses an agent file whose
// frontmatter does not close within the read bound, and names the bound", ›
// "allows a call-site model without waiting when the agent path is not a regular
// file", › "reads a pin in an agent file that starts with a byte-order mark" and
// › "echoes a model pinned in the agent file bounded and escaped".
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib/hook-input.mjs';

/** How much of an agent file is read to find its frontmatter. */
export const MAX_HEAD_BYTES = 64 * 1024;

/** How much of a model name a refusal repeats, from either side of the comparison. */
const MAX_ECHOED_MODEL = 64;

/** A name that can only ever be a file directly under `.claude/agents/`. */
const AGENT_FILE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Open without blocking: a FIFO at the agent path would otherwise hold the open
 * until a writer appears. Windows has no such flag and no such file there.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const ALLOW = Object.freeze({ outcome: 'allow' });

/** The shape word for a value, bounded: never the value itself. */
const shapeOf = (value) => {
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
};

/** A model name as a refusal may print it: bounded, and escaped so it cannot carry control bytes. */
const echoed = (model) => JSON.stringify(model.slice(0, MAX_ECHOED_MODEL));

const unreadable = (field, value, expected) => ({
  outcome: 'refuse',
  message:
    `BLOCKED — ${field} is present as ${shapeOf(value)}, and this guard reads ${expected}. ` +
    'An input it cannot read is refused, never allowed: whether this dispatch overrides a ' +
    'pinned model is decided by reading it (.claude/rules/invariants.md, "Refusing to ' +
    `inspect is a third outcome"). Resend the Agent call with ${field} as ${expected}.`,
});

/**
 * The first MAX_HEAD_BYTES of a regular file, and whether it went on past them;
 * null when the path is absent, is not a regular file, or cannot be read.
 */
function readHead(file) {
  let fd;
  try {
    fd = openSync(file, OPEN_FLAGS);
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_HEAD_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return {
      text: buffer.subarray(0, Math.min(filled, MAX_HEAD_BYTES)).toString('utf8'),
      cut: filled > MAX_HEAD_BYTES,
    };
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

/**
 * `{ kind: 'pinned', model }`, `{ kind: 'none' }`, or `{ kind: 'unbounded' }`
 * when a frontmatter opens and does not close inside the bytes that were read.
 */
function pinOf({ text: raw, cut }) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!/^---\r?\n/.test(text)) return { kind: 'none' };
  // A head that was cut may end in the middle of a line, so only a closer
  // followed by a newline counts there; an uncut head may end at the closer.
  const closed = (
    cut
      ? /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/
      : /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
  ).exec(text);
  if (!closed) return cut ? { kind: 'unbounded' } : { kind: 'none' };
  for (const line of closed[1].split(/\r?\n/)) {
    if (!line.startsWith('model:')) continue;
    const value = line.slice('model:'.length).trim();
    const quoted =
      value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    const model = quoted ? value.slice(1, -1) : value;
    return model !== '' && model !== 'inherit' ? { kind: 'pinned', model } : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** The verdict for one hook payload, judged against the project at `root`. */
export function judge(input, root) {
  if (input === null || typeof input !== 'object' || input.hook_event_name !== 'PreToolUse') {
    return ALLOW;
  }
  const toolInput = input.tool_input;
  if (toolInput === undefined || toolInput === null) return ALLOW;
  if (typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return unreadable('tool_input', toolInput, 'an object');
  }

  const model = toolInput.model;
  if (model === undefined || model === null) return ALLOW;
  if (typeof model !== 'string') return unreadable('tool_input.model', model, 'a string');
  if (model.trim() === '') return ALLOW;

  const name = toolInput.subagent_type;
  if (name === undefined || name === null) return ALLOW;
  if (typeof name !== 'string') return unreadable('tool_input.subagent_type', name, 'a string');
  if (!AGENT_FILE_NAME.test(name)) return ALLOW;

  const relative = `.claude/agents/${name}.md`;
  const head = readHead(path.join(root, '.claude', 'agents', `${name}.md`));
  if (head === null) return ALLOW;
  const pin = pinOf(head);
  if (pin.kind === 'unbounded') {
    return {
      outcome: 'refuse',
      message:
        `BLOCKED — ${relative} opens a frontmatter that does not close within the first ` +
        `${MAX_HEAD_BYTES} bytes, the limit this guard reads, so it cannot tell whether ` +
        `\`${name}\` pins its model. Close the frontmatter near the top of the file, or ` +
        're-dispatch without `model`.',
    };
  }
  if (pin.kind !== 'pinned') return ALLOW;
  return {
    outcome: 'block',
    message:
      `BLOCKED — \`${name}\` pins its model in ${relative} (${echoed(pin.model)}), and this ` +
      `dispatch passes model ${echoed(model)}, which Claude Code would run instead.\n` +
      'Re-dispatch without `model`: the agent definition decides which model a role runs on. ' +
      "Changing a role's model is a policy change — make it in the agent definition, in a " +
      'reviewed change, never in one call (docs/decisions/subagent-routing.md).',
  };
}

/**
 * Whether this file is being run as a script rather than imported — the realpath
 * on both sides, as `inject-rules.mjs` explains, so a symlinked checkout still runs.
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

function main() {
  let verdict;
  try {
    const input = readHookInput();
    if (input === null) return 0;
    verdict = judge(input, process.env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch {
    return 0;
  }
  if (verdict.outcome === 'allow') return 0;
  process.stderr.write(`${verdict.message}\n`);
  return 2;
}

if (invokedDirectly()) {
  process.exit(main());
}
