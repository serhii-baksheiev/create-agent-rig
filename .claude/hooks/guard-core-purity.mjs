// PreToolUse hook: the domain core stays pure — no I/O, no clock, no randomness,
// no environment. This is enforced here, at the tool layer, not requested in prose:
// an agent (or a human using the agent) cannot write an impure line into
// packages/core/src/ even if it wants to.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
import { readFileSync } from 'node:fs';

/** The only non-relative import the core may use: its schema/validation library. */
const ALLOWED_PACKAGES = ['zod'];

const CORE_PATH = /(^|\/)packages\/core\/src\//;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const BANNED = [
  [/\bprocess\.env\b/, 'reads the environment — pass values in through the usecase layer'],
  [/\bprocess\.\w+/, 'touches the process — the core must not know it runs in one'],
  [/\bDate\.now\s*\(/, 'reads the clock — take a timestamp as an argument'],
  [/\bnew\s+Date\s*\(/, 'reads the clock — take a timestamp as an argument'],
  [/\bMath\.random\s*\(/, 'uses randomness — take generated values as arguments'],
  [/\bcrypto\.randomUUID\s*\(/, 'uses randomness — take generated ids as arguments'],
  [/\bset(?:Timeout|Interval)\s*\(/, 'schedules work — the core is synchronous and pure'],
  [/\bfetch\s*\(/, 'performs network I/O — that belongs to an adapter'],
];

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0; // unparseable payload: not ours to judge
  }
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  if (toolName !== 'Write' && toolName !== 'Edit') return 0;

  const filePath = String(toolInput.file_path ?? '').replaceAll('\\', '/');
  if (!CORE_PATH.test(filePath) || !CODE_FILE.test(filePath)) return 0;

  const fragment = String(
    (toolName === 'Write' ? toolInput.content : toolInput.new_string) ?? '',
  );
  const violations = findViolations(fragment);
  if (violations.length === 0) return 0;

  process.stderr.write(
    `BLOCKED — packages/core is a pure module and this change breaks its purity:\n` +
      violations.map((v) => `  - ${v}`).join('\n') +
      `\nMove the impure part behind the usecase layer or into an adapter ` +
      `(see .claude/rules/architecture.md).\n`,
  );
  return 2;
}

export function findViolations(source) {
  // `import type …` disappears at compile time — purity is untouched.
  const withoutTypeImports = source.replace(/^\s*import\s+type\s[^\n]*$/gm, '');
  const violations = [];

  const importRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  for (const match of withoutTypeImports.matchAll(importRe)) {
    const spec = match[1];
    if (spec.startsWith('.')) continue;
    const allowed = ALLOWED_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
    if (!allowed) {
      violations.push(
        `imports "${spec}" — the core may import only its own modules and: ${ALLOWED_PACKAGES.join(', ')}`,
      );
    }
  }

  for (const [pattern, reason] of BANNED) {
    if (pattern.test(withoutTypeImports)) violations.push(reason);
  }
  return violations;
}

process.exit(main());
