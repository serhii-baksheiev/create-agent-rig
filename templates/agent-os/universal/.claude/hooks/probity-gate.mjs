// probity-gate.mjs — PreToolUse hook (Claude Code and, via the Codex
// projection, Codex): the seam between this rulebook and the upstream
// `@nizos/probity` TDD-enforcement package, never a reimplementation of it.
//
// What this file GUARANTEES:
//
//   - It is INERT — exits 0, prints nothing, never even opens the project's
//     `node_modules` — unless `.rig/integrations.json` carries an entry
//     `{ id: 'probity', selected: true, harnesses: [...] }` naming THIS
//     harness.
//   - When it IS declared and selected, it forwards the UNMODIFIED hook
//     payload — the exact bytes this process received on stdin, not a
//     reparsed or re-serialised copy — to the project-local launcher
//     (`node_modules/@nizos/probity/dist/bin.js`) and relays whatever that
//     launcher prints on ITS stdout back to THIS hook's stdout, verbatim.
//     Probity's own decision — including a fail-CLOSED deny/block — is
//     RELAYED, never reinterpreted, softened, or second-guessed here. This
//     hook does not know what Probity's rules are and must not pretend to.
//   - It NEVER uses `npx`. The launcher is resolved as a plain file path
//     under THIS project's own `node_modules`, and started with
//     `process.execPath` (the same `node` binary running this hook) — never
//     a package manager, a registry lookup, or a shell.
//   - Rig reads no transcript and no credentials here. Probity's own
//     launcher may read both, by design — that is its job, not this hook's —
//     but this file touches only: argv, its own stdin bytes (forwarded, not
//     interpreted, beyond the one `tool_name` field read below),
//     `.rig/integrations.json`, and the one launcher path it may spawn.
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
// fails open exactly like every other hook `.claude/rules/invariants.md`
// names — never about what Probity itself decides.
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
// limits — and test them"). There are FOUR:
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
//   - A `.rig/integrations.json` this hook cannot read or parse fails open
//     (never spawns the launcher) WITH a stderr line, so a misconfigured
//     declaration is not silently indistinguishable from "never declared" —
//     see probity-gate.test.ts (absent in a generated rig) › "malformed
//     .rig/integrations.json (not JSON): exits 0, prints nothing, never
//     spawns, and says so on stderr". A MISSING declaration file is the
//     ordinary, silent inert path instead — see the same file, describe
//     block "probity-gate: inert when nothing selected it for this harness".
//   - The launcher is given a bounded window to answer —
//     `RIG_PROBITY_GATE_TIMEOUT_MS` (default 50000, comfortably under Claude
//     Code's own 60s default hook timeout) — past which its whole process
//     (process group on POSIX, process tree on win32 — the same shape
//     `check-run.mjs`'s own `killChildTree` uses) is killed and this hook
//     fails open. See probity-gate.test.ts (absent in a generated rig) ›
//     "returns within the configured bound, fails open, names the timeout on
//     stderr, and kills the launcher child". The answer is relayed only once
//     the launcher has exited within the bound and printed at most
//     MAX_LAUNCHER_OUTPUT_BYTES — see the same file › "relays nothing of an
//     answer the launcher had only partly printed when the bound expired" and
//     › "relays nothing when the launcher prints more than 1 MiB, and names
//     the cap on stderr".
//
// Bounded work, per `.claude/rules/invariants.md`'s fail-open rule: one
// synchronous stdin read, one JSON parse of it, one file read and one JSON
// parse of the declaration, one spawn, one timer, launcher output capped. No recursion, no loop over
// anything sized by untrusted input.

import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { readHookInputRaw } from './lib/hook-input.mjs';

const WIN32 = process.platform === 'win32';

/** argv `--harness=claude`/`--harness=codex` → the declaration's own harness id. */
const HARNESS_IDS = { claude: 'claude-code', codex: 'codex' };

// Bash is deliberately absent from both sets — see the header's "What this
// file GUARANTEES", last bullet.
const FORWARDED_TOOLS = {
  claude: new Set(['Write', 'Edit', 'NotebookEdit']),
  codex: new Set(['apply_patch', 'Edit', 'Write']),
};

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
const missingLauncherAnswer = (harnessArg) =>
  harnessArg === 'claude'
    ? JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: WHERE_PROBITY_BELONGS,
        },
      })
    : JSON.stringify({ decision: 'block', reason: WHERE_PROBITY_BELONGS });

/**
 * Spawn the Probity launcher, forward `stdinBuffer` unchanged, and relay its
 * stdout verbatim to this process's own stdout. Resolves `0` on every exit
 * path — a successful relay, a spawn failure, or a timeout — because this
 * hook's own exit code never carries the decision; Probity's answer (or this
 * hook's own fail-open silence) does, through stdout.
 */
const spawnAndRelay = (launcherPath, harnessId, root, stdinBuffer) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [launcherPath, '--agent', harnessId], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: !WIN32,
    });

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

    const maybeFinish = () => {
      if (stdoutEnded && childClosed) finish(Buffer.concat(chunks));
    };

    const boundMs = timeoutMsFromEnv();
    const timer = setTimeout(() => {
      process.stderr.write(
        `probity-gate: the Probity launcher timed out after ${boundMs}ms; failing open\n`,
      );
      killChildTree(child);
      finish();
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
          `probity-gate: the Probity launcher printed more than ${MAX_LAUNCHER_OUTPUT_BYTES} bytes; failing open\n`,
        );
        killChildTree(child);
        finish();
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
      finish();
    });
    child.on('close', () => {
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
  const declarationPath = path.join(root, '.rig', 'integrations.json');

  let raw;
  try {
    raw = readFileSync(declarationPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0; // never declared: nothing to judge
    process.stderr.write(
      `probity-gate: could not read ${declarationPath}: ${error.message}; failing open\n`,
    );
    return 0;
  }

  let declaration;
  try {
    declaration = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `probity-gate: could not parse ${declarationPath}: ${error.message}; failing open\n`,
    );
    return 0;
  }

  const integrations = Array.isArray(declaration?.integrations) ? declaration.integrations : [];
  const entry = integrations.find((candidate) => candidate && candidate.id === 'probity');
  if (!entry || entry.selected !== true) return 0;
  const harnesses = Array.isArray(entry.harnesses) ? entry.harnesses : [];
  if (!harnesses.includes(harnessId)) return 0;

  const launcherPath = path.join(root, 'node_modules', '@nizos', 'probity', 'dist', 'bin.js');
  if (!existsSync(launcherPath)) {
    process.stdout.write(missingLauncherAnswer(harnessArg));
    return 0;
  }

  return spawnAndRelay(launcherPath, harnessId, root, stdinBuffer);
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
