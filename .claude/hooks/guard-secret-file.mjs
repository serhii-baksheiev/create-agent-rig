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
// of this hook's own tests. A manifest-backed generator upgrade remains inherited
// while `.claude/.rig-manifest.json` matches; once the hash differs, the local test
// is yours.
//
// There are FIVE:
//
//   - It sees ONE edit fragment, not the resulting file. A credential assembled
//     across two edits is not seen — see guard-secret-file.test.ts (absent in a generated rig) › "does not
//     see a credential split across two edits, because it is shown one fragment
//     at a time". This is the same limit every guard in this directory has,
//     stated in full in `.claude/rules/invariants.md`, "What the enforcement
//     actually is — stated exactly".
//   - A `MultiEdit` is capped at 256 fragments and REFUSES before mapping a
//     longer list, so the tail is never silently dropped — see
//     guard-secret-file.test.ts (absent in a generated rig) › "refuses a
//     MultiEdit beyond the fragment cap instead of silently dropping the tail".
//   - It sees only what the AGENT writes. The `toolName` branch in `main` below
//     names the complete surface: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`,
//     and `apply_patch`; every other
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
//     secrets-lib.test.ts (absent in a generated rig) › "has a limit even when the caller names none". The CI sweep lifts the
//     cap; this hook cannot, and that asymmetry is the point.
//   - It FAILS OPEN on what it cannot understand — see guard-secret-file.test.ts
//     (absent in a generated rig)
//     › "allows a payload that is not JSON at all" and its neighbours. An
//     unparseable payload, a missing field, or an internal throw all allow the
//     edit; a crashed guard that blocks everything gets deleted within the hour.
//
//     ⚠ **An `apply_patch` command that is PRESENT and is not a shape this guard
//     reads is the other case, and it now REFUSES** — see codex.test.ts (absent in a generated rig) ›
//     "refuses, rather than failing open, when apply_patch command is supplied
//     as %s". The line between them is whether the guard can tell: an absent
//     field is a payload it does not understand, a container it detects and
//     cannot read is a decision it can report. That reversed a contract this
//     file previously pinned the other way, so it is stated rather than
//     assumed. What catches the rest is whatever this project has put
//     behind it: review always, a commit-time check once one exists.
//
// Failing open is also why every line here does provably bounded work: the scan
// is capped inside `findSecretValues`, there is no recursion, and the one arm
// that revisits offsets — the one that judges a candidate's value — is bounded
// by an explicit per-line candidate cap rather than running to exhaustion. Any
// unbounded work in a fail-open guard is a total bypass of every rule at once,
// not just of this one.

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { findSecretValues, isCredentialPath } from '../scripts/lib/secrets.mjs';
import { editFragments } from './lib/edit-input.mjs';
import { readHookInput } from './lib/hook-input.mjs';

/** Where a refusal points the agent, so the block is actionable rather than a wall. */
const WHERE_CREDENTIALS_BELONG =
  'Credentials live outside the repo (an env file in your home config, a secret manager) ' +
  'and reach the process through the environment — see .claude/rules/autonomy.md, "Never".';

const DOS_SHORT_COMPONENT = /(?:^|[\\/:])[^\\/:]{1,6}~\d+(?:\.[^\\/:]*)?(?=$|[\\/:])/i;
const WINDOWS_UNSAFE_PREFIX = /^(?:[\\/]{2}|[\\/](?![\\/])|[A-Za-z]:(?![\\/]))/;

const strictlyWithin = (root, candidate) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/**
 * A literal 8.3 name can refer to a credential file whose short spelling does
 * not match the credential vocabulary. Resolve a missing target through its
 * deepest existing local ancestor; UNC/device and reparse-point inputs are
 * refused before native resolution.
 */
function canonicalWindowsAlias(filePath, projectDir, directEditCwd) {
  if (process.platform !== 'win32' || projectDir === '') {
    return { kind: 'not-applicable' };
  }
  if (!DOS_SHORT_COMPONENT.test(filePath)) return { kind: 'not-applicable' };
  if (
    WINDOWS_UNSAFE_PREFIX.test(filePath) ||
    WINDOWS_UNSAFE_PREFIX.test(projectDir) ||
    (!path.isAbsolute(filePath) && WINDOWS_UNSAFE_PREFIX.test(directEditCwd))
  ) {
    return { kind: 'unsafe' };
  }

  // `name:stream` resolves through the existing base file even when the named
  // stream has not been created yet. Credential classification remains in
  // `isCredentialPath`; this only finds the local filesystem identity to inspect.
  const finalSeparator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const streamSeparator = filePath.indexOf(':', finalSeparator + 1);
  const basePath = streamSeparator < 0 ? filePath : filePath.slice(0, streamSeparator);
  const root = path.resolve(projectDir);
  const resolutionDir = path.isAbsolute(basePath) ? root : directEditCwd;
  const candidate = path.resolve(resolutionDir, basePath);
  if (
    !path.isAbsolute(root) ||
    !path.isAbsolute(resolutionDir) ||
    !path.isAbsolute(candidate)
  ) {
    return { kind: 'unsafe' };
  }

  const inspectExistingLocalPath = (value) => {
    const parsed = path.parse(value);
    let cursor = parsed.root;
    const components = path.relative(parsed.root, value).split(path.sep).filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (component === '') continue;
      cursor = path.join(cursor, component);
      try {
        const entry = lstatSync(cursor);
        if (!entry.isSymbolicLink()) continue;
        readlinkSync(cursor);
        return { kind: 'unsafe' };
      } catch (error) {
        return error?.code === 'ENOENT'
          ? { kind: 'missing', ancestor: path.dirname(cursor), suffix: components.slice(index) }
          : { kind: 'unsafe' };
      }
    }
    return { kind: 'existing' };
  };

  const rootState = inspectExistingLocalPath(root);
  const resolutionDirState = inspectExistingLocalPath(resolutionDir);
  if (rootState.kind === 'missing') return { kind: 'not-applicable' };
  if (rootState.kind !== 'existing' || resolutionDirState.kind !== 'existing') {
    return { kind: 'unsafe' };
  }

  try {
    const canonicalRoot = realpathSync.native(root);
    const canonicalResolutionDir = realpathSync.native(resolutionDir);
    if (!strictlyWithin(canonicalRoot, canonicalResolutionDir)) return { kind: 'unsafe' };
    const candidateState = inspectExistingLocalPath(candidate);
    let canonicalCandidate;
    if (candidateState.kind === 'missing') {
      const canonicalAncestor = realpathSync.native(candidateState.ancestor);
      if (!strictlyWithin(canonicalRoot, canonicalAncestor)) return { kind: 'unsafe' };
      canonicalCandidate = path.join(canonicalAncestor, ...candidateState.suffix);
    } else if (candidateState.kind === 'existing') {
      canonicalCandidate = realpathSync.native(candidate);
    } else {
      return { kind: 'unsafe' };
    }
    if (!strictlyWithin(canonicalRoot, canonicalCandidate)) return { kind: 'unsafe' };
    return {
      kind: 'resolved',
      relativePath: path.relative(canonicalRoot, canonicalCandidate).split(path.sep).join('/'),
    };
  } catch {
    return { kind: 'unsafe' };
  }
}

function directLiteralPath(input) {
  const toolInput = input.tool_input;
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return undefined;
  }
  if (input.tool_name === 'Write' || input.tool_name === 'Edit' || input.tool_name === 'MultiEdit') {
    return typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
  }
  if (input.tool_name === 'NotebookEdit') {
    return typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : undefined;
  }
  return undefined;
}

function main() {
  const input = readHookInput();
  if (input === null) return 0; // unparseable payload: not ours to judge

  const editTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
  if (!editTools.has(input?.tool_name)) return 0;

  // RP-214: `editFragments` also reports a removal (a Delete File section, or
  // the source half of a Move) as its own fragment, `removes: true` — deleting
  // a credential file is not writing one, so this guard excludes their content
  // after it has applied a path-safety refusal to every fragment.
  const allFragments = editFragments(input);
  const globalRefusal = allFragments.find(
    ({ inspectionRefusal, appliesToAll }) => appliesToAll && inspectionRefusal,
  );
  if (globalRefusal) {
    const fallbackRemedy = input?.tool_name === 'apply_patch'
      ? 'Split it into a smaller patch and retry.'
      : 'Split it into a smaller edit and retry.';
    process.stderr.write(
      `BLOCKED — cannot safely inspect this edit: ${globalRefusal.inspectionRefusal}\n` +
        `${globalRefusal.remedy ?? fallbackRemedy}\n`,
    );
    return 2;
  }

  const fragments = allFragments.filter(({ removes }) => !removes);

  if (fragments.length === 0 || fragments.every(({ filePath }) => filePath === '')) {
    return 0; // nothing to judge; fail open
  }

  // apply_patch fragments are repository-relative; direct edit tools can carry
  // absolute or effective-cwd-relative paths. Judge the repo-relative tail so a
  // checkout living under a directory literally called `secrets` does not make
  // every edit in the project a credential.
  // Trailing slashes stripped: with `CLAUDE_PROJECT_DIR=/repo/` the prefix test
  // below never matches, every path stays absolute, and a checkout that happens
  // to live under a directory called `secrets` has EVERY edit refused. That is
  // the "deleted within the hour" outcome `.claude/rules/invariants.md` warns
  // about — see guard-secret-file.test.ts (absent in a generated rig) ›
  // "judges the repo-relative path even when the project directory is given %s".
  const projectDir = String(process.env.CLAUDE_PROJECT_DIR ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  const literalPath = directLiteralPath(input);
  const directEditCwd =
    input.tool_name === 'apply_patch'
      ? projectDir
      : typeof input.cwd === 'string' && input.cwd.trim() !== ''
        ? input.cwd
        : process.cwd();
  let refused = false;
  for (const { filePath, rawFilePath, fragment, inspectionRefusal, possibleContent } of fragments) {
    const relativePath =
      projectDir !== '' && filePath.startsWith(`${projectDir}/`)
        ? filePath.slice(projectDir.length + 1)
        : filePath;
    if (relativePath === '') continue;

    if (inspectionRefusal) {
      refused = true;
      process.stderr.write(
        `BLOCKED — cannot safely inspect this edit to "${relativePath}": ${inspectionRefusal}\n` +
          'Split it into a smaller edit and retry.\n',
      );
      continue;
    }
    const canonicalAlias = canonicalWindowsAlias(
      rawFilePath ?? literalPath ?? filePath,
      projectDir,
      directEditCwd,
    );
    if (canonicalAlias.kind === 'unsafe') {
      refused = true;
      process.stderr.write(
        `BLOCKED - cannot safely inspect the Windows 8.3 path "${relativePath}". ` +
          'Use a contained local repository path without a reparse point.\n',
      );
      continue;
    }
    if (
      isCredentialPath(relativePath) ||
      (canonicalAlias.kind === 'resolved' && isCredentialPath(canonicalAlias.relativePath))
    ) {
      refused = true;
      process.stderr.write(
        `BLOCKED — "${relativePath}" is a credential file, and this repository never carries one.\n` +
          `${WHERE_CREDENTIALS_BELONG}\n` +
          `If this file is a documented placeholder, name it .env.example — that form stays committable.\n`,
      );
      continue;
    }

    let findings = findSecretValues(fragment);
    // A Move's possibleContent over-approximates what Codex writes, so it also
    // refuses a Move whose patch removes the source's credential — see
    // guard-secret-file.test.ts (absent in a generated rig) › "refuses a Move
    // that removes the source credential (fail-closed: Codex writes none)".
    if (findings.length === 0 && typeof possibleContent === 'string') {
      findings = findSecretValues(possibleContent);
    }
    if (findings.length === 0) continue;
    refused = true;
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
  }
  return refused ? 2 : 0;
}

let status;
try {
  status = main();
} catch {
  status = 0; // fail open — see the LIMITS block above
}
process.exit(status);
