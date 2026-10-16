// probity-gate.mjs — PreToolUse hook (Claude Code and, via the Codex
// projection, Codex): the seam between this rulebook and the upstream
// `@nizos/probity` TDD-enforcement package, never a reimplementation of it.
// All test pointers in this file are generator evidence, absent in a generated rig.
//
// What this file GUARANTEES:
//
//   - It is inert when no declaration selects Probity for this harness, or
//     an edit is provably wholly foreign. Invalid declaration metadata has
//     explicit availability handling, described below. See probity-gate.test.ts
//     (absent in a generated rig), the inert and project-scope describe blocks.
//   - When it IS declared and selected, it forwards the UNMODIFIED hook
//     payload — the exact bytes this process received on stdin, not a
//     reparsed or re-serialised copy — to the project-local launcher
//     (`node_modules/@nizos/probity/dist/bin.js`) and relays whatever that
//     launcher prints on ITS stdout back to THIS hook's stdout, verbatim,
//     once it completes within the bounds. An unreliable required launcher
//     produces a local unavailable-control denial instead.
//     A reliably completed Probity decision, including a deny/block, is
//     relayed without reinterpreting or softening its content. This
//     hook does not know what Probity's rules are and must not pretend to.
//   - It NEVER uses `npx`. The launcher is resolved as a plain file path
//     under THIS project's own `node_modules`, and started with
//     `process.execPath` (the same `node` binary running this hook) — never
//     a package manager, a registry lookup, or a shell.
//   - Rig reads no transcript and no credentials here. Probity's own
//     launcher may read both, by design — that is its job, not this hook's —
//     but this file touches only: argv, its own stdin bytes (forwarded unchanged
//     and inspected for tool and edit-path scope), `.rig/integrations.json`,
//     the checkout-scoped unattended flag, path metadata needed to establish
//     scope, and the one launcher path it may spawn. Scope inspection is not
//     OS isolation: mixed, uncertain and unreadable edit targets remain
//     eligible for upstream auditing, with the original payload bytes. See
//     probity-gate.test.ts, "probity-gate: project scope — edits provably
//     outside the project are inert" and "probity-gate: opaque Windows roots
//     do not prove a local-drive path foreign".
//   - Only the tools a PreToolUse hook can usefully gate are ever forwarded —
//     see FORWARDED_TOOLS below. `Bash` is deliberately NEVER forwarded, on
//     either harness: Probity's command-based rules (a git/test-runner
//     command it expects to observe) are not enforced through Rig at all.
//     A project that wants those needs Probity wired directly into its own
//     shell-hook surface; this file does not attempt it.
//
// What this file is NOT: it carries no TDD policy of its own. Every
// behaviour pinned in `probity-gate.test.ts` (absent in a generated rig) is
// about the SEAM — when it stays silent, what it forwards and to whom, what
// it says when the dependency it was told to call is missing, and that it
// applies the optional/required availability contract below — never about
// what Probity itself decides.
//
// --- Why the exact bytes, not a reparsed payload ---------------------------
//
// Every other hook in this directory reads its payload through
// `lib/hook-input.mjs`'s `readHookInput`, which returns a PARSED object —
// exactly right for a hook that only ever INSPECTS its input. This hook also
// FORWARDS its input, to a process this rulebook does not control, so a
// reparse-and-reserialise round trip here would be a second, drifting copy
// of whatever Claude Code or Codex actually sent (key order, whitespace, a
// field a plain `JSON.parse`/`JSON.stringify` round trip does not preserve).
// `lib/hook-input.mjs` exports `readHookInputRaw` for exactly this one
// caller: it reads fd 0 ONCE and returns both the raw `Buffer` this hook
// forwards unchanged and the parsed object every other hook already gets
// from `readHookInput` — one mechanism, one implementation
// (`.claude/rules/invariants.md`), never a second direct read of fd 0 here.
//
// 🔴 LIMITS — stated because a guard's own claim about its reach is the
// first thing to go stale (`.claude/rules/invariants.md`, "State the
// limits — and test them").
//
//   - It sees only the tools named in `FORWARDED_TOOLS` below, per harness.
//     Every other tool — including every shell tool on both harnesses —
//     returns before `.rig/integrations.json` is even opened. See
//     probity-gate.test.ts (absent in a generated rig), describe block
//     "probity-gate: tool filtering — only the named tools are ever
//     forwarded".
//   - A payload this hook cannot parse as JSON reads as "no tool_name", which
//     is indistinguishable from a tool this hook does not forward — it fails
//     open the same way, silently, with no stderr line. This is the same
//     "absent is fail-open" reading `.claude/rules/invariants.md` draws for
//     every hook here.
//   - A `.rig/integrations.json` this hook cannot read or parse warns in an
//     attended session and blocks in an unattended session, so a misconfigured
//     declaration is not silently indistinguishable from "never declared" —
//     see probity-gate.test.ts (absent in a generated rig) › "malformed
//     .rig/integrations.json (not JSON): exits 0, prints nothing, never
//     spawns, and says so on stderr". A MISSING declaration file is the
//     ordinary, silent inert path instead — see the same file, describe
//     block "probity-gate: inert when nothing selected it for this harness".
//     See also "blocks an armed unattended run when the present Probity
//     declaration is malformed" and "blocks an armed unattended run when
//     the present Probity declaration cannot be read".
//   - The launcher is given a bounded window to answer —
//     `RIG_PROBITY_GATE_TIMEOUT_MS` (default 50000, comfortably under Claude
//     Code's own 60s default hook timeout) — past which its whole process
//     (process group on POSIX, process tree on win32 — the same shape
//     `check-run.mjs`'s own `killChildTree` uses) is killed and this hook
//     allows for an optional integration and denies for a required one.
//     Process-tree termination is best effort, not an OS isolation guarantee.
//     See probity-gate.test.ts (absent in a generated rig) ›
//     "returns within the configured bound, fails open, names the timeout on
//     stderr, and kills the launcher child". The answer is relayed only once
//     the launcher has exited within the bound and printed at most
//     MAX_LAUNCHER_OUTPUT_BYTES — see the same file › "relays nothing of an
//     answer the launcher had only partly printed when the bound expired" and
//     › "relays nothing when the launcher prints more than 1 MiB, and names
//     the cap on stderr". For the required counterparts see "blocks a
//     selected required Probity launcher timeout without relaying its partial
//     answer and kills it" and "blocks when a selected required Probity
//     launcher exceeds the existing output cap". Spawn errors and nonzero
//     exits also deny when required; see "probity-gate: selected Probity
//     availability". A successful empty response is still an upstream allow:
//     see "keeps a completed empty response from a selected required Probity
//     launcher as an upstream allow". Optional completed nonzero responses
//     stay verbatim; see "preserves a completed optional launcher deny response
//     even when that launcher exits nonzero".
//
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { editFragments, isKnownForeignAbsolutePath } from './lib/edit-input.mjs';
import { readHookInputRaw } from './lib/hook-input.mjs';
import { readUnattended } from '../scripts/unattended-flag.mjs';

const WIN32 = process.platform === 'win32';

/** argv `--harness=claude`/`--harness=codex` → the declaration's own harness id. */
const HARNESS_IDS = { claude: 'claude-code', codex: 'codex' };
const DECLARATION_HARNESS_IDS = new Set(Object.values(HARNESS_IDS));

// Bash is deliberately absent from both sets — see the header's "What this
// file GUARANTEES", last bullet.
const FORWARDED_TOOLS = {
  claude: new Set(['Write', 'Edit', 'NotebookEdit']),
  codex: new Set(['apply_patch', 'Edit', 'Write']),
};

const DIRECT_EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

const DEFAULT_TIMEOUT_MS = 50_000;

/** The most launcher output this hook buffers; Probity answers with one small JSON object. */
const MAX_LAUNCHER_OUTPUT_BYTES = 1024 * 1024;

const WHERE_PROBITY_BELONGS =
  'Probity (@nizos/probity) is selected for this harness in .rig/integrations.json, ' +
  'but is not installed in this project. Run `npm install -D @nizos/probity` to enable it.';

const parseHarnessArg = (argv) => {
  const flag = argv.find((entry) => entry.startsWith('--harness='));
  return flag ? flag.slice('--harness='.length) : undefined;
};

/** The `tool_name` field of the parsed payload, or `undefined` for anything this hook cannot read. */
const toolNameOf = (parsed) =>
  parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.tool_name : undefined;

const directEditIsProvablyForeign = (parsed, root) => {
  if (!DIRECT_EDIT_TOOLS.has(toolNameOf(parsed))) return false;
  const rawPath =
    parsed?.tool_name === 'NotebookEdit' ? parsed?.tool_input?.notebook_path : parsed?.tool_input?.file_path;
  let resolvedRoot;
  try {
    resolvedRoot = realpathSync.native(root);
  } catch {
    return false;
  }
  if (!isKnownForeignAbsolutePath(rawPath, resolvedRoot, root, { trimTrailingWhitespace: false })) return false;
  const fragments = editFragments(parsed);
  return (
    fragments.length > 0 &&
    fragments.every(({ filePath, inspectionRefusal }) => {
      return !inspectionRefusal && typeof filePath === 'string' && filePath !== '';
    })
  );
};

const patchIsProvablyForeign = (parsed, root) => {
  if (toolNameOf(parsed) !== 'apply_patch') return false;
  const fragments = editFragments(parsed, { projectRoot: root });
  return fragments.length > 0 && fragments.every(({ projectScope }) => projectScope === 'foreign');
};

const timeoutMsFromEnv = () => {
  const raw = Number(process.env.RIG_PROBITY_GATE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
};

/** Kill the whole process tree rooted at `child` — same shape as `check-run.mjs`'s own `killChildTree`. */
const killChildTree = (child) => {
  if (!child || !child.pid) return;
  if (WIN32) {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000 });
    } catch {
      // Best-effort: the process may already be gone.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Best-effort: the process group may already be gone.
    }
  }
};

/** The harness-shaped deny/block answer printed when enforcement was promised but the launcher is missing. */
const unavailableAnswer = (harnessArg, reason = WHERE_PROBITY_BELONGS) =>
  harnessArg === 'claude'
    ? JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })
    : JSON.stringify({ decision: 'block', reason });

const missingLauncherAnswer = (harnessArg) => unavailableAnswer(harnessArg);

const isUnattended = (root) => readUnattended({ ...process.env, CLAUDE_PROJECT_DIR: root }).on;

const selectedProbity = (declaration, harnessId) => {
  if (!Array.isArray(declaration.integrations)) return { invalid: true };
  const integrations = declaration.integrations;
  const selected = integrations.filter((candidate) => candidate && candidate.id === 'probity' && candidate.selected === true);
  const hasValidHarnesses = (candidate) =>
    Array.isArray(candidate.harnesses) &&
    candidate.harnesses.length > 0 &&
    new Set(candidate.harnesses).size === candidate.harnesses.length &&
    candidate.harnesses.every((harness) => DECLARATION_HARNESS_IDS.has(harness));
  const invalidApplicability = selected.filter((candidate) => !hasValidHarnesses(candidate));
  const malformedRequired = invalidApplicability.some((candidate) => candidate.required === true);
  const applicable = integrations.filter(
    (candidate) =>
      candidate &&
      candidate.id === 'probity' &&
      candidate.selected === true &&
      hasValidHarnesses(candidate) &&
      candidate.harnesses.includes(harnessId),
  );
  const required = applicable.filter((candidate) => candidate.required === true);
  const unknownRequired = applicable.some((candidate) => Object.hasOwn(candidate, 'required') && candidate.required !== true && candidate.required !== false);
  if (malformedRequired) return { required: true, ambiguous: true };
  if (required.length > 0) return { required: true, ambiguous: applicable.length !== 1 };
  if (invalidApplicability.length > 0) return { invalid: true };
  if (unknownRequired) return { required: false, unknown: true };
  return applicable.length === 0 ? undefined : { required: false, ambiguous: false };
};

/**
 * Spawn the Probity launcher, forward `stdinBuffer` unchanged, and relay its
 * completed stdout to this process's own stdout, or report mandatory-control
 * unavailability. Resolves `0` on every exit
 * path — a successful relay, a spawn failure, or a timeout — because this
 * hook's own exit code never carries the decision; Probity's answer (or this
 * hook's own availability answer) does, through stdout.
 */
const spawnAndRelay = (launcherPath, harnessId, root, stdinBuffer, { required, harnessArg }) =>
  new Promise((resolve) => {
    const unavailable = (reason) => unavailableAnswer(harnessArg, `Required Probity launcher ${reason}; repair the integration.`);
    let child;
    try {
      child = spawn(process.execPath, [launcherPath, '--agent', harnessId], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: !WIN32,
      });
    } catch (error) {
      process.stderr.write(`probity-gate: failed to run the Probity launcher: ${error.message}\n`);
      if (required) process.stdout.write(unavailable(`could not start: ${error.message}`));
      resolve(0);
      return;
    }

    let settled = false;
    let stdoutEnded = false;
    let childClosed = false;
    const chunks = [];
    let bufferedBytes = 0;

    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (answer !== undefined) process.stdout.write(answer);
      resolve(0);
    };

    let exitCode;
    const maybeFinish = () => {
      if (!stdoutEnded || !childClosed) return;
      if (exitCode !== 0) {
        process.stderr.write(`probity-gate: the Probity launcher exited ${exitCode}\n`);
        finish(required ? unavailable(`exited ${exitCode}`) : Buffer.concat(chunks));
        return;
      }
      finish(Buffer.concat(chunks));
    };

    const boundMs = timeoutMsFromEnv();
    const timer = setTimeout(() => {
      process.stderr.write(
        `probity-gate: the Probity launcher timed out after ${boundMs}ms; ${required ? 'blocking required control' : 'failing open'}\n`,
      );
      killChildTree(child);
      finish(required ? unavailable('timed out') : undefined);
    }, boundMs);

    // A gate that decides to stop forwarding mid-write closes the pipe under
    // the caller; the caller's own writer tolerates this (so must this one,
    // symmetrically, if the LAUNCHER ever exits before reading all of stdin).
    child.stdin.on('error', () => {});
    child.stdin.write(stdinBuffer);
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bufferedBytes += chunk.length;
      if (bufferedBytes > MAX_LAUNCHER_OUTPUT_BYTES) {
        process.stderr.write(
          `probity-gate: the Probity launcher printed more than ${MAX_LAUNCHER_OUTPUT_BYTES} bytes; ${required ? 'blocking required control' : 'failing open'}\n`,
        );
        killChildTree(child);
        finish(required ? unavailable('exceeded the output limit') : undefined);
        return;
      }
      chunks.push(chunk);
    });
    child.stdout.on('end', () => {
      stdoutEnded = true;
      maybeFinish();
    });

    child.on('error', (error) => {
      process.stderr.write(`probity-gate: failed to run the Probity launcher: ${error.message}\n`);
      stdoutEnded = true;
      childClosed = true;
      finish(required ? unavailable(`could not start: ${error.message}`) : undefined);
    });
    child.on('close', (code) => {
      exitCode = code;
      childClosed = true;
      maybeFinish();
    });
  });

async function main() {
  const harnessArg = parseHarnessArg(process.argv.slice(2));
  const harnessId = HARNESS_IDS[harnessArg];
  if (!harnessId) return 0; // not a harness this hook knows how to gate for

  const { raw: stdinBuffer, parsed } = readHookInputRaw();
  const toolName = toolNameOf(parsed);
  if (!FORWARDED_TOOLS[harnessArg].has(toolName)) return 0;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (directEditIsProvablyForeign(parsed, root)) return 0;
  if (patchIsProvablyForeign(parsed, root)) return 0;
  const declarationPath = path.join(root, '.rig', 'integrations.json');

  let raw;
  try {
    raw = readFileSync(declarationPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0; // never declared: nothing to judge
    process.stderr.write(`probity-gate: could not read ${declarationPath}: ${error.message}\n`);
    if (isUnattended(root)) process.stdout.write(unavailableAnswer(harnessArg, `Probity declaration cannot be read; repair ${declarationPath}.`));
    return 0;
  }

  let declaration;
  try {
    declaration = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`probity-gate: could not parse ${declarationPath}: ${error.message}\n`);
    if (isUnattended(root)) process.stdout.write(unavailableAnswer(harnessArg, `Probity declaration cannot be parsed; repair ${declarationPath}.`));
    return 0;
  }
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    process.stderr.write(`probity-gate: ${declarationPath} is null\n`);
    if (isUnattended(root)) process.stdout.write(unavailableAnswer(harnessArg, `Probity declaration is invalid; repair ${declarationPath}.`));
    return 0;
  }

  const selection = selectedProbity(declaration, harnessId);
  if (!selection) return 0;
  if (selection.invalid) {
    process.stderr.write('probity-gate: Probity integrations field is invalid\n');
    if (isUnattended(root)) process.stdout.write(unavailableAnswer(harnessArg, 'Probity declaration integrations field is invalid; repair .rig/integrations.json.'));
    return 0;
  }
  if (selection.ambiguous) {
    process.stdout.write(unavailableAnswer(harnessArg, 'Required Probity declaration is ambiguous; repair .rig/integrations.json.'));
    return 0;
  }
  if (selection.unknown) {
    process.stderr.write('probity-gate: Probity required flag is invalid\n');
    if (isUnattended(root)) process.stdout.write(unavailableAnswer(harnessArg, 'Probity declaration has an invalid required flag; repair .rig/integrations.json.'));
    return 0;
  }

  const launcherPath = path.join(root, 'node_modules', '@nizos', 'probity', 'dist', 'bin.js');
  if (!existsSync(launcherPath)) {
    if (selection.required || isUnattended(root)) process.stdout.write(missingLauncherAnswer(harnessArg));
    else process.stderr.write(`probity-gate: ${WHERE_PROBITY_BELONGS}\n`);
    return 0;
  }

  return spawnAndRelay(launcherPath, harnessId, root, stdinBuffer, { required: selection.required, harnessArg });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    try {
      process.stderr.write(`probity-gate: unexpected error: ${error?.message ?? error}; failing open\n`);
    } catch {
      // stderr itself may be gone; there is nothing further to report.
    }
    process.exitCode = 0;
  });
