// PreToolUse hook: the domain core stays pure — no I/O, no clock, no randomness,
// no environment. This is enforced here, at the tool layer, not requested in prose:
// an agent (or a human using the agent) cannot write an impure line into
// packages/core/src/ even if it wants to.
//
// Contract (Claude Code and Codex): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
// Generator-owned coverage for the neutral bounded-inspection refusal lives upstream in
// codex.test.ts › "$guard blocks with a neutral, actionable size-limit refusal"; generated
// projects do not carry that suite, and a downstream edit requires a local replacement test.
import { readFileSync } from 'node:fs';
import { editFragments } from './lib/edit-input.mjs';

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
  const fragments = editFragments(input);
  const blocked = fragments.find(
    ({ inspectionRefusal, appliesToAll }) => appliesToAll && inspectionRefusal,
  );
  const globalRefusal = blocked?.inspectionRefusal;
  if (globalRefusal) {
    process.stderr.write(
      `BLOCKED — cannot safely inspect this edit: ${globalRefusal}\n` +
        // The remedy has to match the refusal: splitting cannot change a
        // container shape, and a fixed line sent the agent into a retry loop
        // on the one path it could not retry out of.
        `${blocked.remedy ?? 'Split it into a smaller patch and retry.'}\n`,
    );
    return 2;
  }

  const violations = fragments.flatMap(({ filePath, fragment, inspectionRefusal }) => {
    if (!CORE_PATH.test(filePath) || !CODE_FILE.test(filePath)) return [];
    if (inspectionRefusal) return [`cannot safely inspect this move — ${inspectionRefusal}`];
    return findViolations(fragment);
  });
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
