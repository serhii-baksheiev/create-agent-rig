// PreToolUse hook: the web app is a consumer of the domain, not the backend.
// `apps/web` may import the pure core and shared utilities — never the storage
// layer (`…/db`) and never the services. Enforced at the tool layer, same as
// core purity: best-effort text scan, failing safe toward a false block.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
import { readFileSync } from 'node:fs';

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
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  if (toolName !== 'Write' && toolName !== 'Edit') return 0;

  const filePath = String(toolInput.file_path ?? '').replaceAll('\\', '/');
  if (!WEB_PATH.test(filePath) || !CODE_FILE.test(filePath)) return 0;

  const fragment = String((toolName === 'Write' ? toolInput.content : toolInput.new_string) ?? '');
  const violations = [];
  const importRe =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  for (const match of fragment.matchAll(importRe)) {
    const spec = match[1];
    if (FORBIDDEN_WORKSPACE.test(spec) || FORBIDDEN_RELATIVE.test(spec)) {
      violations.push(spec);
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
