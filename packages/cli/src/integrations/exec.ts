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
 * repo root), using the operating system's own realpath
 * (`fs.realpathSync.native`, falling back to the plain JS implementation only
 * if the native call itself throws) — the JS implementation does not expand
 * an 8.3 short-name component (`MYCHEC~1`) or canonicalise case on win32, so
 * a PATH entry spelled through its short name used to defeat this check
 * entirely (gate cycle 1, blocker 3). `isInside` is platform-parameterised so
 * a win32/darwin comparison folds case the way those filesystems do, and
 * treats an EMPTY `path.relative` result (a trailing-slash or case-only
 * respelling of the repo root itself) as "inside", not as a mismatch.
 *
 * `boundedRun` never shells out (`child_process.exec` is never called and
 * `shell: true` is never passed — see `integrations-exec.test.ts` › "no file
 * under src/integrations/ sets shell: true or calls a bare exec("): it uses
 * `execFile` with an absolute file and an argv array only, and refuses a
 * non-absolute file before it ever reaches `execFile`. The `execFile` call
 * itself is wrapped in `try`/`catch` — a synchronous spawn failure (a NUL
 * byte in an argv element, an invalid option, a win32 `.cmd` spawned with
 * `shell: false`, measured to throw `EINVAL` on Node 24 rather than deliver
 * an async error — gate cycle 1, blocker 1) used to reject the returned
 * promise instead of resolving the closed union below. It filters the
 * environment down to {@link ALLOWED_ENV_VARS} before spawning — a caller
 * that hands it its own `process.env` still only leaks that fixed set to the
 * child — and refuses a `cwd` that resolves inside `repoDir` (gate cycle 1,
 * blocker 4): omitted, the child's `cwd` defaults to `os.tmpdir()`, never the
 * inherited `process.cwd()`, which during this project's own tests (and
 * plausibly during a real run) IS the untrusted repository being acted on.
 *
 * The result is a closed union: `ok`, `nonzero-exit`, `timeout`,
 * `killed-by-signal`, `output-exceeded`, or `spawn-error`.
 * `killed-by-signal` is distinct from `timeout`: `execFile` sets `.killed`
 * to `true` only when IT killed the process (the deadline or `maxBuffer`);
 * a child terminated by a signal from anywhere else (a test harness, an
 * operator, another process) arrives with `.killed === false` and a
 * `.signal` set, and used to be misclassified as `spawn-error` with its
 * captured output silently dropped (gate cycle 1, blocker 2) — the branch
 * comment claiming "the process never ran" was simply wrong for this case.
 * Output is sanitized (control characters, Unicode format/bidi characters,
 * and the two Unicode line separators are stripped — see
 * {@link stripControlCharacters}) and stderr's tail is capped to
 * {@link MAX_STDERR_TAIL_CHARS} so a maintainer-facing report never carries a
 * terminal escape sequence, a bidi override, or an unbounded blob. A
 * `spawn-error`'s `message` is always a fixed string, never the raw error
 * Node produced — that raw text carries the absolute path this module just
 * finished refusing to leak (gate cycle 1 advisory).
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
 *    "LIMIT (measured on this platform): a detached grandchild survives the
 *    timeout kill because it writes its marker only AFTER the parent's own
 *    deadline has already fired (skipped on win32: a separate, weaker claim
 *    holds there — see this module's header comment)") — the grandchild's
 *    marker file appears after the parent has already been reported
 *    `timeout`. On win32 this is not measured here (no CI runner in this
 *    suite exercises it): Node's `ChildProcess.kill()` on Windows calls
 *    `TerminateProcess` on the named PID only, so the same failure mode is
 *    *expected* to hold, but that is a claim, not a measurement, until a
 *    win32 run proves it.
 * 4. {@link ALLOWED_ENV_VARS} is a floor for what THIS MODULE deliberately
 *    forwards, not a ceiling the operating system enforces beneath it. On
 *    win32, a spawned child's `process.env` carries additional user-profile
 *    variables this module never put in the filtered block it passed to
 *    `execFile` — at minimum `HOMEDRIVE`, `HOMEPATH`, and, measured on
 *    windows-smoke, `LOGONSERVER` too — and that IS now measured on this
 *    platform rather than merely observed on CI and reported in prose: see
 *    "on win32, HOMEDRIVE/HOMEPATH reach the child even though this module
 *    never allow-listed them for THIS call — but the OS adds strictly more
 *    than those two (measured on windows-smoke: LOGONSERVER also arrives),
 *    so this asserts presence/absence, never a closed set (this test runs
 *    only on win32 — gate cycle 1, blocker 8: the prior wording claimed this
 *    was "observed" on CI with nothing in-tree asserting it; gate cycle 2
 *    fallout: an earlier version of this very test wrongly asserted the
 *    child env was EXACTLY ALLOWED_ENV_VARS plus those two keys, and
 *    LOGONSERVER promptly falsified it)". The property this module actually
 *    guarantees, and the one its own test asserts on every platform, is
 *    negative: nothing this module was HANDED and did not allow-list (a
 *    secret, a stray variable, `NODE_OPTIONS`) is ever forwarded. The
 *    positive "the child's environment is exactly this set" check only
 *    holds where the platform adds nothing of its own — measured true on
 *    Linux, measured false (by an UNENUMERATED, not merely two-key, margin)
 *    on win32.
 * 5. Captured `stdout`/`stderr` are sanitized for control/format characters
 *    but NOT redacted for secrets — a token or credential a spawned tool
 *    prints is returned as-is. No caller of this module may persist a
 *    `BoundedRunResult`'s captured output into a receipt or any other
 *    committed record: `contracts/integrations/v1/receipt.schema.json` has
 *    no field shaped to hold free-form text at all — see "the receipt schema
 *    has no property that could hold raw captured stdout/stderr text — every
 *    string property is pattern-, const-, or enum-bounded" — so there is
 *    deliberately nowhere for it to go today.
 * 6. `boundedRun`'s `cwd` validation only checks whether the value resolves
 *    inside `repoDir` — the same "inside this one directory" realpath check
 *    `resolveTool` applies to a `PATH` entry. A caller-supplied `cwd` outside
 *    the repository is trusted as given; this module does not itself
 *    re-walk it for a symlink chain the way `resolveTool` does for a `PATH`
 *    entry's candidate file.
 * 7. A detached grandchild that inherits the child's stdout file descriptor
 *    and outlives the direct child does not truncate or corrupt what the
 *    direct child already wrote — measured on Linux (see "LIMIT (measured
 *    on this platform): a detached grandchild inheriting the stdout file
 *    descriptor delays, but does not truncate, output the direct child
 *    already wrote before exiting (skipped on win32: not measured there)"):
 *    the result still reports `ok` with the direct child's full output, but
 *    only once the pipe's last holder closes it — a grandchild that
 *    outlives `timeoutMs` by enough can turn an otherwise-`ok` run into a
 *    slow one, or, if it outlives the deadline itself, contribute to the
 *    same `timeout` class limit 3 already names.
 */
import { execFile } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isFormatOrLineSeparatorCharacter } from '../lib/safe-text.js';

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
 * `HOMEDRIVE`/`HOMEPATH` are here for a measured reason, not a guessed one —
 * see this module's header, limit 4, and "on win32, the child process env is
 * exactly ALLOWED_ENV_VARS intersected with the parent env, including
 * HOMEDRIVE/HOMEPATH the OS adds regardless of the filtered block this
 * module builds".
 */
const ALLOWED_ENV_VARS_LIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
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
 * Strip ASCII control characters, the C1 range, Unicode format/bidi
 * characters, and the two Unicode line separators (U+2028, U+2029) — keeping
 * `\n`/`\t`, which are ordinary in captured process output. The format/bidi
 * and line-separator classes are the SAME ones `../lib/safe-text.js`'s
 * `hasControlCharacter` refuses in a committed JSON field
 * (`isFormatOrLineSeparatorCharacter` is the one shared predicate —
 * `.claude/rules/invariants.md`, "One mechanism, one implementation"); the
 * ASCII/C1 control-character handling here is NOT shared with that module,
 * because this function deliberately keeps `\n`/`\t` and that module does
 * not — a live process's byte stream and an untrusted JSON string field have
 * different ideas of "ordinary whitespace", so this stays a second,
 * deliberate implementation for that part only.
 */
function stripControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    // `for...of` over a string yields one code point per iteration (a
    // surrogate pair together), so `char` is never empty and `codePointAt(0)`
    // is always defined — the `!` only tells the type checker what the
    // iteration protocol already guarantees.
    const code = char.codePointAt(0)!;
    if (code === 0x0a || code === 0x09) {
      out += char;
      continue;
    }
    if (code <= 0x1f) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    if (isFormatOrLineSeparatorCharacter(char)) continue;
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
 * The win32 extensions this module recognises as a REAL, non-`.exe` match
 * for a declared tool name — the shape `PATHEXT` carries for a shell-run
 * command, restricted to the members that would plausibly be
 * `npm install -g`'d alongside an `.exe` (gate cycle 1 advisory: the prior
 * version matched `<name>.<anything>`, so an unrelated `claude.txt` sitting
 * next to a real tool was wrongly reported `not-spawnable` instead of the
 * correct `absent`).
 */
const WIN32_NOT_SPAWNABLE_EXTENSIONS = ['.cmd', '.bat', '.com', '.ps1'] as const;

/**
 * Pure, platform-parameterised: given the file names present in ONE
 * directory, decide whether `name` is present and spawnable there. No
 * filesystem access — {@link resolveTool} is the only caller that touches
 * disk, so this half is testable for win32 behaviour from any host.
 *
 * On win32 only a literal `<name>.exe` is spawnable — a match against
 * {@link WIN32_NOT_SPAWNABLE_EXTENSIONS} sharing the base name is a REAL
 * match (the directory does carry the tool) that this module refuses to
 * spawn without a shell, so it is reported `not-spawnable` rather than
 * silently treated as absent (which would let a later, wrong `PATH` entry
 * decide instead). Any OTHER extension sharing the base name (`claude.txt`)
 * is `absent` — it is not a plausible executable shape at all. On a POSIX
 * platform, filenames are case-sensitive, so only an EXACT-case match counts
 * — comparing case-insensitively there (the prior bug: gate cycle 1
 * advisory) could report `spawnable` for a directory that in fact has no
 * exact-case match, which is exactly the case {@link resolveTool}'s own
 * `matchedName` lookup below assumes cannot happen.
 */
export function classifyCandidates(
  fileNames: readonly string[],
  name: string,
  platform: NodeJS.Platform,
): CandidateOutcome {
  if (platform === 'win32') {
    const lowerName = name.toLowerCase();
    const lowerFiles = fileNames.map((file) => file.toLowerCase());
    if (lowerFiles.includes(`${lowerName}.exe`)) return 'spawnable';
    if (WIN32_NOT_SPAWNABLE_EXTENSIONS.some((ext) => lowerFiles.includes(`${lowerName}${ext}`))) {
      return 'not-spawnable';
    }
    return 'absent';
  }
  // POSIX filesystems are case-sensitive: an exact match only.
  return fileNames.includes(name) ? 'spawnable' : 'absent';
}

/**
 * The path module for the DECLARED platform — the same pattern
 * `../lib/subsystems.ts`'s own `pathFor` uses. `PATH`-string syntax (the
 * delimiter, what counts as absolute, how two paths relate) is a property of
 * the platform being modeled, not of the host actually running this process
 * — {@link isInside} below uses it for exactly that reason, measured on
 * windows-smoke: a pure comparison built from `path.relative`/`isAbsolute`
 * (the host-bound module) gave the HOST's answer regardless of the
 * `platform` argument, so declaring `platform: 'linux'` on a win32 CI
 * runner silently ran win32 path semantics instead (gate cycle 2 fallout of
 * blocker 3's own fix). The real filesystem calls elsewhere in this module
 * (`readdirSync`, `realpathSync`, the final `path.join` building a candidate
 * file) stay host-native regardless, because they touch the actual
 * filesystem this process runs on, never a simulated one — there is no way
 * to make those anything else.
 */
function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * `candidate` is `root` itself, or nested under it — compared as two
 * REALPATHS by the caller. Case-folds on win32/darwin (both have
 * case-insensitive-by-default filesystems), stays case-sensitive elsewhere.
 * An EMPTY `path.relative` result means `candidate` and `root` name the same
 * directory once path syntax is normalised (a trailing-slash or, after
 * case-folding, a case-only respelling of the root) — that is "inside", not
 * a mismatch (gate cycle 1, blocker 3: the previous `rel !== ''` condition
 * returned `false` for exactly this case). Uses {@link pathFor} for the
 * relative/absolute computation itself — see that function's own comment —
 * so the `platform` argument governs the answer on every host, not only the
 * case-folding decision.
 */
export function isInside(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const caseFold = platform === 'win32' || platform === 'darwin';
  const c = caseFold ? candidate.toLowerCase() : candidate;
  const r = caseFold ? root.toLowerCase() : root;
  if (c === r) return true;
  const rel = p.relative(r, c);
  if (rel === '') return true;
  return !rel.startsWith('..') && !p.isAbsolute(rel);
}

/**
 * The real filesystem's own realpath (`fs.realpathSync.native`), falling
 * back to the plain JS implementation only if the native call itself throws
 * (gate cycle 1, blocker 3). The JS implementation does not expand an 8.3
 * short-name path component or canonicalise case on win32, which let a
 * `PATH` entry spelled through its short name defeat {@link isInside}
 * entirely; the native call resolves through the OS.
 */
function realpathOrNull(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  }
}

/**
 * Pure: split a `PATH`-shaped string on the DECLARED platform's delimiter
 * (`;` for win32, `:` elsewhere) — never the host's own. An empty string
 * yields no entries; an empty ENTRY (`::` or a leading/trailing delimiter)
 * is kept here and skipped later by {@link resolveTool} as "search cwd" (see
 * this module's header).
 */
export function splitPathVar(pathVar: string, platform: NodeJS.Platform): string[] {
  if (pathVar.length === 0) return [];
  return pathVar.split(pathFor(platform).delimiter);
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
  const entries = splitPathVar(pathVar, options.platform);

  for (const rawEntry of entries) {
    // A single check does both jobs: an empty entry (which conventionally
    // means "search the current working directory") and any other relative
    // entry both fail the DECLARED platform's `isAbsolute`, so both are
    // skipped here — the current directory is not a trusted search root in
    // this module.
    if (!pathFor(options.platform).isAbsolute(rawEntry)) continue;

    const dirReal = realpathOrNull(rawEntry);
    if (dirReal === null) continue; // does not exist / unreadable
    if (isInside(dirReal, repoReal, options.platform)) continue; // never resolve from inside the repo

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
    if (isInside(candidateReal, repoReal, options.platform)) continue; // a symlinked file resolving into the repo

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
  | { status: 'killed-by-signal'; signal: NodeJS.Signals; stdout: string; stderr: string }
  | { status: 'output-exceeded' }
  | { status: 'spawn-error'; code: string | undefined; message: string };

export type BoundedRunOptions = {
  timeoutMs: number;
  maxBuffer: number;
  /**
   * The repository whose working tree the child's `cwd` must never resolve
   * inside — required, not optional: `boundedRun` has no other way to know
   * what "the repository" means for this call, and an unvalidated `cwd`
   * defaulting to `process.cwd()` used to hand a hostile checkout to every
   * child that omitted one (gate cycle 1, blocker 4).
   */
  repoDir: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type ExecFileError = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

const SPAWN_ERROR_MESSAGE = 'boundedRun: the process could not be spawned';

function spawnErrorFrom(err: NodeJS.ErrnoException): BoundedRunResult {
  // Never forward `err.message` — Node's own text for ENOENT/EACCES/EINVAL
  // etc. embeds the absolute file path this module exists to keep out of a
  // maintainer-facing report (gate cycle 1 advisory). `code` alone is
  // diagnostic enough, and it is never a path.
  return {
    status: 'spawn-error',
    code: typeof err.code === 'string' ? err.code : undefined,
    message: SPAWN_ERROR_MESSAGE,
  };
}

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

  // Never the inherited `process.cwd()` — during this project's own tests
  // (and plausibly during a real run) that IS the untrusted repository being
  // acted on. `os.tmpdir()` is outside any repository this module could be
  // asked to protect.
  const cwd = options.cwd ?? tmpdir();
  const cwdReal = realpathOrNull(cwd) ?? path.resolve(cwd);
  const repoReal = realpathOrNull(options.repoDir) ?? path.resolve(options.repoDir);
  if (isInside(cwdReal, repoReal, process.platform)) {
    return Promise.resolve({
      status: 'spawn-error',
      code: undefined,
      message: 'boundedRun refuses a cwd inside the repository',
    });
  }

  const childEnv = filterAllowedEnv(options.env ?? {});

  return new Promise((resolve) => {
    try {
      execFile(
        absFile,
        [...argv],
        {
          cwd,
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
          // either the deadline or (handled above, first) maxBuffer.
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

          // A signal this module's own deadline/maxBuffer handling did NOT
          // send (`.killed` is false) — an external kill from a test
          // harness, an operator, or another process. The child DID run and
          // may have produced output before it died, so — unlike the
          // spawn-level failure below, where nothing ever ran — that output
          // is kept (gate cycle 1, blocker 2: this case used to fall through
          // to `spawn-error` with its output silently dropped).
          if (err.signal) {
            resolve({
              status: 'killed-by-signal',
              signal: err.signal,
              stdout: sanitizeStdout(stdout),
              stderr: sanitizeStderr(stderr),
            });
            return;
          }

          // A spawn-level failure (ENOENT, EACCES, …): the process never ran,
          // so there is no output to report.
          resolve(spawnErrorFrom(err));
        },
      );
    } catch (error) {
      // A SYNCHRONOUS spawn failure — `execFile` itself throws for some
      // inputs (a NUL byte in an argv element, an invalid option, and,
      // measured on Node 24.18.0 win32, a `.cmd` file spawned with
      // `shell: false`, which throws `EINVAL` rather than delivering an
      // async error) instead of ever invoking the callback above. Without
      // this `try`/`catch` the throw propagated out of the `new Promise`
      // executor and rejected the promise this function promises to always
      // RESOLVE (gate cycle 1, blocker 1).
      resolve(spawnErrorFrom(error as NodeJS.ErrnoException));
    }
  });
}
