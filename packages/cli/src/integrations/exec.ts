/**
 * The bounded tool resolver and process runner behind a future integrations
 * route (RP-22, S3 — no route consumes this module yet, no provider ships
 * with one, no CLI verb spawns it). It supplies two things every future
 * `external-executable` / `external-installer` route will need: finding an
 * absolute path for a declared tool name without trusting the repository's
 * own working tree, and running it with a deadline, an output cap, and a
 * closed environment.
 *
 * `resolveTool` NEVER returns a path inside the repository, even when a
 * `PATH` entry (or a symlink a `PATH` entry resolves through) points there —
 * a hostile PR can commit a `claude`/`claude.exe` at the repo root and a CI
 * runner can plausibly have the checkout on `PATH` ahead of the real tool;
 * this module refuses to be the thing that resolves to it. It does this by
 * comparing REALPATHS on both sides (the candidate directory/file and the
 * repo root), so neither an in-repo symlink pointing out, nor an outside
 * symlink pointing in, changes the answer.
 *
 * `boundedRun` never shells out (`child_process.exec` is never called and
 * `shell: true` is never passed — see `integrations-exec.test.ts` › "no file
 * under src/integrations/ sets shell: true or calls a bare exec("): it uses
 * `execFile` with an absolute file and an argv array only, and refuses a
 * non-absolute file before it ever reaches `execFile`. It filters the
 * environment down to {@link ALLOWED_ENV_VARS} before spawning — a caller
 * that hands it its own `process.env` still only leaks that fixed set to the
 * child — and classifies the result into a closed union: `ok`,
 * `nonzero-exit`, `timeout`, `output-exceeded`, or `spawn-error`. Output is
 * sanitized (control characters stripped) and stderr's tail is capped to
 * {@link MAX_STDERR_TAIL_CHARS} so a maintainer-facing report never carries a
 * terminal escape sequence or an unbounded blob.
 *
 * Stated limits (`.claude/rules/invariants.md`, "State the limits — and test
 * them"):
 *
 * 1. TOCTOU between resolve and spawn: `resolveTool` returns a path, and
 *    nothing stops the file at that path from being replaced before a later
 *    `boundedRun` call opens it. This module offers no atomic
 *    resolve-and-exec primitive; a caller needing that guarantee has to build
 *    it itself (e.g. re-checking the realpath immediately before spawning,
 *    which narrows but does not close the window).
 * 2. A `PATH` entry OUTSIDE the repository that is attacker-writable (a
 *    world-writable directory earlier in `PATH`, a compromised global
 *    install location) is not detected at all — the one thing this module
 *    checks for is "inside this repository's working tree", not "writable by
 *    someone other than the operator".
 * 3. Killing the direct child does not kill its descendants. `boundedRun`
 *    sends `killSignal` (`SIGKILL`) to the child `execFile` itself spawned;
 *    a DETACHED grandchild process is not part of that signal's target and
 *    can outlive the kill. Measured on Linux (see
 *    "LIMIT (measured on this platform): a detached grandchild can survive
 *    the timeout kill") — the grandchild's marker file appears after the
 *    parent has already been reported `timeout`. On win32 this is not
 *    measured here (no CI runner in this suite exercises it): Node's
 *    `ChildProcess.kill()` on Windows calls `TerminateProcess` on the named
 *    PID only, so the same failure mode is *expected* to hold, but that is a
 *    claim, not a measurement, until a win32 run proves it.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** A tool name is a single path segment — no separator, no traversal, no drive letter. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/**
 * The fixed environment allow-list every child spawned through
 * {@link boundedRun} may see. Frozen ARRAY, not a `Set` — the same reasoning
 * as `declaration.ts`'s `ROOT_KEYS` (`Object.freeze` on a `Set` still leaves
 * `add`/`delete` open).
 *
 * `HOMEDRIVE` is here for a measured reason, not a guessed one: the
 * windows-smoke CI job observed it present in a spawned child's
 * `process.env` even though it is absent from the filtered block this
 * module builds — Windows populates it for a child process regardless of
 * what this module passes, the same way `SystemRoot` is needed for system
 * DLL loading. Refusing to allow-list an entry the platform adds anyway
 * would only make this module's own accounting wrong, not the child's
 * actual environment smaller.
 */
const ALLOWED_ENV_VARS_LIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'LANG',
  'LC_ALL',
] as const;
export const ALLOWED_ENV_VARS: readonly string[] = Object.freeze([...ALLOWED_ENV_VARS_LIST]);
const ALLOWED_ENV_VARS_SET = new Set(ALLOWED_ENV_VARS);

/** The bound a sanitized stderr tail is capped to, keeping the END of the stream. */
export const MAX_STDERR_TAIL_CHARS = 4096;

function filterAllowedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_VARS_SET) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Strip ASCII control characters and the C1 range (keeping `\n`/`\t`, which
 * are ordinary in captured process output). A narrower job than
 * `../lib/safe-text.js`'s `hasControlCharacter` — that predicate DETECTS a
 * control character in untrusted JSON string fields; this one REMOVES them
 * from a live process's byte stream, and keeps two whitespace characters
 * that predicate would flag. The two are not interchangeable, so this is a
 * deliberate second implementation, not a drift from "one mechanism, one
 * implementation".
 */
function stripControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a || code === 0x09) {
      out += char;
      continue;
    }
    if (code <= 0x1f) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    out += char;
  }
  return out;
}

function capTail(value: string, max: number): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

function sanitizeStdout(value: string): string {
  return stripControlCharacters(value);
}

function sanitizeStderr(value: string): string {
  return capTail(stripControlCharacters(value), MAX_STDERR_TAIL_CHARS);
}

// ---------------------------------------------------------------------------
// resolveTool
// ---------------------------------------------------------------------------

export type ResolveToolResult =
  | { status: 'ok'; absFile: string }
  | { status: 'tool-not-found' }
  | { status: 'tool-not-spawnable' };

type CandidateOutcome = 'spawnable' | 'not-spawnable' | 'absent';

/**
 * Pure, platform-parameterised: given the file names present in ONE
 * directory, decide whether `name` is present and spawnable there. No
 * filesystem access — {@link resolveTool} is the only caller that touches
 * disk, so this half is testable for win32 behaviour from any host.
 *
 * On win32 only a literal `<name>.exe` is spawnable — a `.cmd`/`.bat`/other
 * extension sharing the base name is a REAL match (the directory does carry
 * the tool) that this module refuses to spawn without a shell, so it is
 * reported `not-spawnable` rather than silently treated as absent (which
 * would let a later, wrong `PATH` entry decide instead). On a POSIX
 * platform, only an exact-name file counts — POSIX has no extension
 * convention to apply, so any other file sharing the base name is `absent`,
 * never `not-spawnable`.
 */
export function classifyCandidates(
  fileNames: readonly string[],
  name: string,
  platform: NodeJS.Platform,
): CandidateOutcome {
  const lowerName = name.toLowerCase();
  const lowerFiles = fileNames.map((file) => file.toLowerCase());
  if (platform === 'win32') {
    if (lowerFiles.includes(`${lowerName}.exe`)) return 'spawnable';
    if (lowerFiles.some((file) => file === lowerName || file.startsWith(`${lowerName}.`))) {
      return 'not-spawnable';
    }
    return 'absent';
  }
  return lowerFiles.includes(lowerName) ? 'spawnable' : 'absent';
}

/** `candidate` is `root` itself, or nested under it — compared as two REALPATHS by the caller. */
function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Resolve `name` to an absolute, spawnable file by walking `env.PATH` —
 * never returning a path inside `repoDir` (see this module's header) — and
 * never treating a relative or empty `PATH` entry as a search location (an
 * empty entry conventionally means "search the current working directory",
 * which this module refuses to do: the current directory is not a trusted
 * search root here).
 */
export function resolveTool(
  name: string,
  options: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; repoDir: string },
): ResolveToolResult {
  if (!isValidToolName(name)) return { status: 'tool-not-found' };

  const repoReal = realpathOrNull(options.repoDir) ?? path.resolve(options.repoDir);

  const pathVar = options.env.PATH ?? options.env.Path ?? '';
  const entries = pathVar.length === 0 ? [] : pathVar.split(path.delimiter);

  for (const rawEntry of entries) {
    // A single check does both jobs: an empty entry (which conventionally
    // means "search the current working directory") and any other relative
    // entry both fail `path.isAbsolute`, so both are skipped here — the
    // current directory is not a trusted search root in this module.
    if (!path.isAbsolute(rawEntry)) continue;

    const dirReal = realpathOrNull(rawEntry);
    if (dirReal === null) continue; // does not exist / unreadable
    if (isInside(dirReal, repoReal)) continue; // never resolve from inside the repo

    let fileNames: string[];
    try {
      fileNames = readdirSync(dirReal);
    } catch {
      continue;
    }

    const outcome = classifyCandidates(fileNames, name, options.platform);
    if (outcome === 'absent') continue;
    if (outcome === 'not-spawnable') return { status: 'tool-not-spawnable' };

    const lowerName = name.toLowerCase();
    const matchedName =
      options.platform === 'win32'
        ? fileNames.find((file) => file.toLowerCase() === `${lowerName}.exe`)
        : fileNames.find((file) => file === name);
    if (matchedName === undefined) continue; // unreachable given `outcome === 'spawnable'`, kept total

    const candidate = path.join(dirReal, matchedName);
    const candidateReal = realpathOrNull(candidate);
    if (candidateReal === null) continue; // dangling symlink etc.
    if (isInside(candidateReal, repoReal)) continue; // a symlinked file resolving into the repo
    if (!existsSync(candidateReal)) continue;

    return { status: 'ok', absFile: candidateReal };
  }

  return { status: 'tool-not-found' };
}

// ---------------------------------------------------------------------------
// boundedRun
// ---------------------------------------------------------------------------

export type BoundedRunResult =
  | { status: 'ok'; code: 0; stdout: string; stderr: string }
  | { status: 'nonzero-exit'; code: number; stdout: string; stderr: string }
  | { status: 'timeout'; stdout: string; stderr: string }
  | { status: 'output-exceeded' }
  | { status: 'spawn-error'; code: string | undefined; message: string };

export type BoundedRunOptions = {
  timeoutMs: number;
  maxBuffer: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type ExecFileError = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

/**
 * Run `absFile argv…` with a deadline and an output cap, never through a
 * shell. `absFile` must already be an absolute path — the caller (typically
 * {@link resolveTool}'s own result) is what makes it trustworthy; this
 * function refuses anything else outright rather than resolving it itself,
 * so it never re-implements (or drifts from) `resolveTool`'s own repo-escape
 * check.
 */
export function boundedRun(
  absFile: string,
  argv: readonly string[],
  options: BoundedRunOptions,
): Promise<BoundedRunResult> {
  if (!path.isAbsolute(absFile)) {
    return Promise.resolve({
      status: 'spawn-error',
      code: undefined,
      message: 'boundedRun requires an absolute file path',
    });
  }

  const childEnv = filterAllowedEnv(options.env ?? {});

  return new Promise((resolve) => {
    execFile(
      absFile,
      [...argv],
      {
        cwd: options.cwd,
        env: childEnv,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: options.maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({
            status: 'ok',
            code: 0,
            stdout: sanitizeStdout(stdout),
            stderr: sanitizeStderr(stderr),
          });
          return;
        }

        const err = error as ExecFileError;

        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ status: 'output-exceeded' });
          return;
        }

        // execFile sets `.killed` true exactly when IT killed the process —
        // either the deadline or (handled above, first) maxBuffer. Anything
        // else killed is not a case this module's callers produce today, so
        // it is classified the same way: the deadline is the only KNOWN
        // reason a signal shows up here.
        if (err.killed === true && err.signal) {
          resolve({
            status: 'timeout',
            stdout: sanitizeStdout(stdout),
            stderr: sanitizeStderr(stderr),
          });
          return;
        }

        if (typeof err.code === 'number') {
          resolve({
            status: 'nonzero-exit',
            code: err.code,
            stdout: sanitizeStdout(stdout),
            stderr: sanitizeStderr(stderr),
          });
          return;
        }

        // A spawn-level failure (ENOENT, EACCES, …): the process never ran,
        // so there is no output to report.
        resolve({
          status: 'spawn-error',
          code: typeof err.code === 'string' ? err.code : undefined,
          message: err.message,
        });
      },
    );
  });
}
