// PreToolUse hook: a credential never enters the repository through an edit.
//
// Two arms, because a credential arrives two ways and only one of them has a
// telltale name:
//
//   - the PATH is a credential file   (`jira.env`, `id_rsa`, `secrets/prod.txt`)
//   - the CONTENT carries a credential VALUE, in a file named nothing special
//
// The second is the likelier path and the one nothing in this rulebook refused
// before: an ignore rule can only ever answer the first.
//
// The vocabulary and both matchers come from `../scripts/lib/secrets.mjs`. This
// file holds no list of its own on purpose — `.claude/rules/invariants.md`, "one
// mechanism, one implementation": the same invariant written in two places will
// disagree, and the copy nobody is looking at is the one that is wrong.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
//
// 🔴 LIMITS, stated because a guard's own claim about its reach is the first
// thing to go stale. Each one names the test that pins it — a limits comment
// nothing checks drifts into overstatement, which is the direction that gets a
// reader hurt:
//
//   - It sees ONE edit fragment, not the resulting file. A credential assembled
//     across two edits is not seen — see guard-secret-file.test.ts › "does not
//     see a credential split across two edits, because it is shown one fragment
//     at a time". This is the same limit every guard in this directory has,
//     stated in full in `.claude/rules/invariants.md`, "What the enforcement
//     actually is — stated exactly".
//   - It sees only what the AGENT writes, and only through two tools — see
//     guard-secret-file.test.ts › "allows a %s call carrying the same credential
//     payload — the matcher is Write|Edit". A human editing the file, or a
//     `git commit` of something already on disk, never reaches a PreToolUse hook
//     at all, and no test here can show that: it is a property of the harness,
//     not of this file. That is precisely why AR-49(b) is two layers — the
//     `.husky/pre-commit` check covers the author this one cannot see.
//   - It FAILS OPEN — see guard-secret-file.test.ts › "allows a payload that is
//     not JSON at all" and its neighbours. An unparseable payload, a missing
//     field, an internal throw — all allow the edit. A crashed guard that blocks everything gets deleted
//     within the hour, and the layers behind it (the pre-commit check, the CI
//     validator, review) are what catch the rest.
//
// Failing open is also why every line here does provably bounded work: the scan
// is capped inside `findSecretValues`, there is no recursion, and nothing
// rescans. Any unbounded work in a fail-open guard is a total bypass of every
// rule at once, not just of this one.
import { readFileSync } from 'node:fs';

import { findSecretValues, isCredentialPath } from '../scripts/lib/secrets.mjs';

/** Where a refusal points the agent, so the block is actionable rather than a wall. */
const WHERE_CREDENTIALS_BELONG =
  'Credentials live outside the repo (an env file in your home config, a secret manager) ' +
  'and reach the process through the environment — see .claude/rules/autonomy.md, "Never".';

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0; // unparseable payload: not ours to judge
  }

  const toolName = input?.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit') return 0;

  const toolInput = input?.tool_input ?? {};
  const filePath = String(toolInput.file_path ?? '').replaceAll('\\', '/');
  if (filePath === '') return 0; // nothing to judge; fail open

  // The tool sends an absolute path. Judge the repo-relative tail so a checkout
  // living under a directory literally called `secrets` does not make every edit
  // in the project a credential.
  const projectDir = String(process.env.CLAUDE_PROJECT_DIR ?? '').replaceAll('\\', '/');
  const relativePath =
    projectDir !== '' && filePath.startsWith(`${projectDir}/`)
      ? filePath.slice(projectDir.length + 1)
      : filePath;

  if (isCredentialPath(relativePath)) {
    process.stderr.write(
      `BLOCKED — "${relativePath}" is a credential file, and this repository never carries one.\n` +
        `${WHERE_CREDENTIALS_BELONG}\n` +
        `If this file is a documented placeholder, name it .env.example — that form stays committable.\n`,
    );
    return 2;
  }

  const fragment = String((toolName === 'Write' ? toolInput.content : toolInput.new_string) ?? '');
  const findings = findSecretValues(fragment);
  if (findings.length === 0) return 0;

  process.stderr.write(
    `BLOCKED — this edit writes a credential value into "${relativePath}":\n` +
      findings
        .map((finding) => `  - ${finding.id} on line ${finding.line} of the text being written`)
        .join('\n') +
      `\n${WHERE_CREDENTIALS_BELONG}\n` +
      // Deliberately NOT the matched text. A guard that prints what it found has
      // copied the credential into a hook transcript and a terminal scrollback —
      // it has leaked the secret in the act of refusing it.
      `The matched value is deliberately not shown; open the line above to see it.\n`,
  );
  return 2;
}

let status;
try {
  status = main();
} catch {
  status = 0; // fail open — see the LIMITS block above
}
process.exit(status);
