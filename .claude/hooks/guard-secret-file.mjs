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
// thing to go stale. Each names the test that pins it where one exists, and says
// so plainly where none does — a limits comment nothing checks drifts into
// overstatement, which is the direction that gets a reader hurt. ⚠ Those tests live in the GENERATOR this rig came from, not here;
// `.claude/rules/invariants.md` ("About the hooks you were given") says the same
// of this hook's own tests, and the moment you edit it they are yours.
//
// There are FOUR:
//
//   - It sees ONE edit fragment, not the resulting file. A credential assembled
//     across two edits is not seen — see guard-secret-file.test.ts › "does not
//     see a credential split across two edits, because it is shown one fragment
//     at a time". This is the same limit every guard in this directory has,
//     stated in full in `.claude/rules/invariants.md`, "What the enforcement
//     actually is — stated exactly".
//   - It sees only what the AGENT writes. The `toolName` branch in `main` below
//     names the complete surface: `Write`, `Edit`, and `apply_patch`; every other
//     tool returns before inspection. A human editing the file, or a
//     `git commit` of something already on disk, never reaches a PreToolUse hook
//     at all, and no test here can show that: it is a property of the harness,
//     not of this file.
//
//     🔴 WHETHER ANYTHING ELSE CATCHES THAT IS NOT A QUESTION THIS FILE CAN
//     ANSWER, and it is the one worth asking before relying on the rule. The
//     layer that covers a human's edit is a COMMIT-TIME check — a git hook, a CI
//     sweep — and this hook cannot see whether one is installed. Look at
//     `.husky/` and the CI workflow rather than assuming: the generator this
//     rulebook came from has both, running the same vocabulary; a freshly
//     generated rig ships neither, and adding one is a decision for the project.
//
//   - It reads at most the first 2 MB of the text being written, the cap
//     `findSecretValues` applies by default so a fail-open guard cannot be made
//     to hang. A credential past that point is not seen. ⚠ No test here pins
//     this one: the case is pinned one layer down, on the module, by
//     secrets-lib.test.ts › "has a limit even when the caller names none". The CI sweep lifts the
//     cap; this hook cannot, and that asymmetry is the point.
//   - It FAILS OPEN — see guard-secret-file.test.ts › "allows a payload that is
//     not JSON at all" and its neighbours. An unparseable payload, a missing
//     field, an unsupported `apply_patch` command shape, or an internal throw
//     all allow the edit. The command-shape case is pinned upstream by
//     codex.test.ts › "fails open with a diagnostic when apply_patch command is
//     supplied as %s". A crashed guard that blocks everything gets deleted
//     within the hour. What catches the rest is whatever this project has put
//     behind it: review always, a commit-time check once one exists.
//
// Failing open is also why every line here does provably bounded work: the scan
// is capped inside `findSecretValues`, there is no recursion, and the one arm
// that revisits offsets — the one that judges a candidate's value — is bounded
// by an explicit per-line candidate cap rather than running to exhaustion. Any
// unbounded work in a fail-open guard is a total bypass of every rule at once,
// not just of this one.
import { readFileSync } from 'node:fs';

import { findSecretValues, isCredentialPath } from '../scripts/lib/secrets.mjs';
import { editFragments } from './lib/edit-input.mjs';

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
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'apply_patch') return 0;

  if (toolName === 'apply_patch') {
    let refused = false;
    for (const { filePath, fragment, inspectionRefusal, appliesToAll } of editFragments(input)) {
      if (inspectionRefusal) {
        refused = true;
        process.stderr.write(`BLOCKED — cannot safely inspect this edit: ${inspectionRefusal}\n`);
        continue;
      }
      if (isCredentialPath(filePath)) {
        refused = true;
        process.stderr.write(`BLOCKED — "${filePath}" is a credential file, and this repository never carries one.\n${WHERE_CREDENTIALS_BELONG}\n`);
        continue;
      }
      const findings = findSecretValues(fragment);
      if (findings.length > 0 || appliesToAll) {
        refused = true;
        if (findings.length > 0) process.stderr.write(`BLOCKED — this edit writes a credential value into "${filePath}".\n${WHERE_CREDENTIALS_BELONG}\n`);
      }
    }
    return refused ? 2 : 0;
  }

  const toolInput = input?.tool_input ?? {};
  const filePath = String(toolInput.file_path ?? '').replaceAll('\\', '/');
  if (filePath === '') return 0; // nothing to judge; fail open

  // The tool sends an absolute path. Judge the repo-relative tail so a checkout
  // living under a directory literally called `secrets` does not make every edit
  // in the project a credential.
  // Trailing slashes stripped: with `CLAUDE_PROJECT_DIR=/repo/` the prefix test
  // below never matches, every path stays absolute, and a checkout that happens
  // to live under a directory called `secrets` has EVERY edit refused. That is
  // the "deleted within the hour" outcome `.claude/rules/invariants.md` warns
  // about — see guard-secret-file.test.ts › "judges the repo-relative path even
  // when the project directory is given with a trailing slash".
  const projectDir = String(process.env.CLAUDE_PROJECT_DIR ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
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
