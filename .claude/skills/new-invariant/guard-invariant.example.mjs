// TEMPLATE — copy to .claude/hooks/guard-<invariant-name>.mjs and edit the three
// marked parts. It is real, working code, not a sketch: the `new-invariant` skill
// tests it, so what you copy is known to work before you change anything.
//
// The invariant it encodes as the example:
//
//   Service code logs through the shared structured logger, never `console.log`.
//
// That one is a genuine candidate — the stack rules state it and nothing enforces
// it — but it is here to show the SHAPE. Replace it with your project's invariant.
//
// Contract (Claude Code): JSON payload on stdin; exit 0 = allow, exit 2 = block,
// and stderr is shown to the agent as the reason. Zero dependencies.
import { readFileSync } from 'node:fs';

// ── PART 1: the scope ────────────────────────────────────────────────────────
// Which files the invariant covers. Scope FIRST, match second: a guard that
// polices the whole repo fires on honest work and gets switched off by lunchtime.
const inScope = (filePath) => /^services\/[^/]+\/src\//.test(filePath);

// ── PART 2: the violation ────────────────────────────────────────────────────
// What the invariant forbids, decided from the text of THIS edit alone.
// Return a reason string, or null to allow.
const violation = (text) => {
  // Strip line comments and string literals before matching: a doc line or a
  // fixture that merely MENTIONS the forbidden form is prose, not a violation.
  // Skipping this step is the single most common way a guard earns false
  // positives — and false positives are how guards get disabled.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

  const match = /\bconsole\.(log|info|warn|error|debug)\s*\(/.exec(code);
  if (!match) return null;
  return (
    `BLOCKED — service code logs through the shared structured logger, never ` +
    `console.${match[1]}(). Structured JSON lines are what makes a production ` +
    `incident searchable; a bare console call is invisible the moment it matters. ` +
    `Import the logger from the shared package instead. See .claude/rules/ for the rule.`
  );
};

// ── PART 3: nothing below here normally changes ──────────────────────────────

/** The text an edit is about to introduce, across the tool shapes that carry one. */
const incomingText = (toolInput) =>
  [toolInput?.content, toolInput?.new_string, toolInput?.new_str]
    .filter((value) => typeof value === 'string')
    .join('\n');

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0; // malformed payload → fail open, never make the session unusable
  }

  const filePath = String(input?.tool_input?.file_path ?? '').replaceAll('\\', '/');
  if (!filePath || !inScope(filePath)) return 0;

  const text = incomingText(input?.tool_input);
  if (!text) return 0;

  try {
    const reason = violation(text);
    if (reason) {
      process.stderr.write(`${reason}\n`);
      return 2;
    }
  } catch {
    return 0; // a guard that crashes must not block the work
  }
  return 0;
}

process.exit(main());
