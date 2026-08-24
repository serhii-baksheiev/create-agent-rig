// PreToolUse hook: the web app is a consumer of the domain, not the backend.
// `apps/web` may import the pure core and shared utilities — never the storage
// layer (`…/db`) and never the services. Enforced at the tool layer, same as
// core purity: best-effort text scan, failing safe toward a false block.
//
// Contract (Claude Code and Codex): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
// Generator-owned coverage for the neutral bounded-inspection refusal lives upstream in
// codex.test.ts › "$guard blocks with a neutral, actionable size-limit refusal"; generated
// projects do not carry that suite, and a downstream edit requires a local replacement test.
import { readFileSync } from 'node:fs';
import { editFragments } from './lib/edit-input.mjs';

const WEB_PATH = /(^|\/)apps\/web\//;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Workspace package names arrive rewritten to the project scope, so match the
// package *suffix* under any scope: @<anything>/db, @<anything>/api, …
const FORBIDDEN_WORKSPACE = /^@[^/]+\/(db|api|worker)$/;
const FORBIDDEN_RELATIVE = /(^|\/)(packages\/db|services)(\/|$)/;

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0; // unparseable payload: not ours to judge
  }
  const violations = [];
  const importRe =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
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

  for (const { filePath, fragment, inspectionRefusal } of fragments) {
    if (!WEB_PATH.test(filePath) || !CODE_FILE.test(filePath)) continue;
    if (inspectionRefusal) {
      violations.push(`cannot safely inspect this move — ${inspectionRefusal}`);
      continue;
    }
    for (const match of fragment.matchAll(importRe)) {
      const spec = match[1];
      if (FORBIDDEN_WORKSPACE.test(spec) || FORBIDDEN_RELATIVE.test(spec)) {
        violations.push(spec);
      }
    }
  }
  if (violations.length === 0) return 0;

  process.stderr.write(
    `BLOCKED — apps/web imports the domain (core, shared), never the backend:\n` +
      violations.map((v) => `  - "${v}" crosses the web boundary`).join('\n') +
      `\nThe web talks to services over HTTP only; storage stays behind the API ` +
      `(see .claude/rules/architecture.md).\n`,
  );
  return 2;
}

process.exit(main());
