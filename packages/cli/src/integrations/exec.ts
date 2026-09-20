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
 * entirely (gate cycle 1, blocker 3). The containment check itself always
 * compares against `process.platform` — the HOST actually running this
 * process — never `options.platform`: `options.platform` still governs
 * `PATH`-string syntax (the delimiter, what counts as absolute) and the
 * win32 extension policy, because those genuinely describe the platform
 * being modeled, but two REALPATHS are host filesystem facts, and comparing
 * them with a declared-but-wrong platform's path module fails OPEN (gate
 * cycle 2, blocker 1 — a regression introduced when blocker 3 above was
 * fixed): on win32, real paths are backslash-separated, and
 * `path.posix.relative` cannot find a shared prefix between two such strings
 * at all, so declaring any non-win32 platform made an in-repo `PATH` entry
 * look "outside" on that host.
 *
 * `boundedRun` never shells out (`child_process.exec` is never called and
 * `shell: true` is never passed — see `integrations-exec.test.ts` › "no file
 * under src/integrations/ sets shell: true or calls a bare exec("): it uses
 * `execFile` with an absolute file and an argv array only, and refuses a
 * non-absolute file before it ever reaches `execFile`. It refuses a
 * non-positive or non-finite `timeoutMs`/`maxBuffer` outright, before any
 * spawn attempt — an unvalidated `0` or `NaN` would otherwise silently
 * disarm the very bound this module exists to enforce. The `execFile` call
 * itself is wrapped in `try`/`catch` — a synchronous spawn failure (a NUL
 * byte in an argv element, an invalid option, a win32 `.cmd` spawned with
 * `shell: false`, measured to throw `EINVAL` on Node 24 rather than deliver
 * an async error — gate cycle 1, blocker 1) used to reject the returned
 * promise instead of resolving the closed union below. It filters the
 * environment down to {@link ALLOWED_ENV_VARS} before spawning — a caller
 * that hands it its own `process.env` still only leaks that fixed set to the
 * child, and the child always receives the result under the key `PATH`
 * (case-EXACT) regardless of whether the caller's own `env` spelled it
 * `Path` — win32's own environment block is case-insensitive, but a JS
 * object's keys are not (gate cycle 2, blocker 6) — and refuses a `cwd` that
 * resolves inside `repoDir` (gate cycle 1, blocker 4). Omitted, the child's
 * `cwd` defaults to a FRESH, PER-RUN temporary directory created under
 * `os.tmpdir()` (mode `0700`, removed once the run ends, on every exit path)
 * rather than `os.tmpdir()` itself — that shared, world-writable directory
 * is not a safe default cwd on its own (gate cycle 2 advisory: a spawned
 * tool that consults `cwd`-relative configuration, e.g. an `.npmrc` beside a
 * `package.json`, would read whatever another process left sitting in the
 * shared temp root) — and never the inherited `process.cwd()`, which during
 * this project's own tests (and plausibly during a real run) IS the
 * untrusted repository being acted on.
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
 *    resolve-and-exec primitive — see "LIMIT (TOCTOU, whole-name pointer for
 *    limit 1): a file replaced after resolveTool answers but before
 *    boundedRun opens it is what actually runs — no atomic resolve-and-exec
 *    primitive exists here" (gate cycle 2, blocker 7).
 * 2. A `PATH` entry OUTSIDE the repository that is attacker-writable (a
 *    world-writable directory earlier in `PATH`, a compromised global
 *    install location) is not detected at all — the one thing this module
 *    checks for is "inside this repository's working tree", not "writable by
 *    someone other than the operator" — see "LIMIT (whole-name pointer for
 *    limit 2): a PATH entry outside the repository that is world-writable
 *    resolves ok — this module checks only "inside the repository", never
 *    "writable by someone else"" (gate cycle 2, blocker 7).
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
 *    so this asserts presence/absence, never a closed set (gate cycle 1,
 *    blocker 8: the prior wording claimed this was "observed" on CI with
 *    nothing in-tree asserting it; gate cycle 2 fallout: an earlier version
 *    of this very test wrongly asserted the child env was EXACTLY
 *    ALLOWED_ENV_VARS plus those two keys, and LOGONSERVER promptly
 *    falsified it)". The property this module actually
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
 * 6. `boundedRun`'s `cwd` — whether caller-supplied or this module's own
 *    per-run temporary directory — IS realpath-resolved (through any
 *    symlink chain) before the containment check, the same way `resolveTool`
 *    resolves a `PATH` entry: see "a cwd that is a symlink pointing INTO the
 *    repository is refused — this module realpaths the cwd (through any
 *    symlink) before the containment check, so a symlink chain is not a gap
 *    here (gate cycle 2, blocker 7: an earlier version of this limit claimed
 *    the opposite, that a symlink chain was not walked — that was never true
 *    of the realpath-based check already here, and the claim is corrected
 *    rather than repeated)". What remains unresolved is the ordinary TOCTOU
 *    already named as limit 1: a cwd the check accepted can still be
 *    replaced (e.g. by a symlink retargeted after the check) before
 *    `execFile` itself opens it.
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
 * 8. `realpathOrNull`'s fallback to the plain JS `realpathSync` (when the
 *    native call itself throws — a platform or filesystem that does not
 *    support it) is short-name- and case-blind on win32, the exact gap
 *    blocker 3 (gate cycle 1) closed by preferring `.native`. The fallback
 *    exists only so a native-realpath failure fails toward "treat the path
 *    as unresolved" rather than crashing; it is not itself tested, because
 *    provoking `.native` to throw while the plain implementation succeeds
 *    is not a condition this suite can construct on a real filesystem.
 * 9. `boundedRun` applies NO containment check to `absFile` itself — only to
 *    `cwd`. A caller that resolves a tool via {@link resolveTool} gets that
 *    guarantee from `resolveTool`'s own return value; a caller that builds
 *    `absFile` some other way gets no repo-escape protection from this
 *    function at all — see "LIMIT (whole-name pointer for limit 9):
 *    boundedRun applies no containment check to absFile itself, only to
 *    cwd — an absolute file path genuinely INSIDE repoDir runs anyway when
 *    handed directly to boundedRun (bypassing resolveTool, which is what
 *    actually provides that guarantee)". `resolveTool`'s own check is what
 *    this function deliberately does not re-implement (see this module's
 *    own comment on `boundedRun` above) — but that means the property is
 *    `resolveTool`'s, never `boundedRun`'s, and a future caller passing an
 *    unvalidated `absFile` straight to `boundedRun` would get none of it.
 */
import { execFile } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
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
 * see this module's header, limit 4, for the full explanation and the whole
 * test name that backs it (gate cycle 2, blocker 3: this comment used to
 * cite a test name that no longer existed, one gate cycle after it was
 * deleted for the exact reason limit 4 states).
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

/**
 * Reads a `PATH`-shaped variable off `env`. On win32 the search is
 * case-INSENSITIVE (`PATH`, `Path`, `path` are the same OS-level variable —
 * `Path` is the conventional spelling Windows itself uses) and the FIRST
 * matching key (in the object's own enumeration order) wins if more than one
 * case-variant is somehow present — an unusual, self-contradicting input
 * this function does not try to reconcile further than picking one. On every
 * other platform only the exact `PATH` key is read: POSIX environment
 * variable names are genuinely case-sensitive, so `Path` there names a
 * different, unrelated variable, not an alternate spelling (gate cycle 2,
 * blocker 6: `resolveTool` used to special-case `env.Path` for every
 * platform, while {@link filterAllowedEnv} looked up `PATH` only, so a win32
 * caller passing `{...process.env}` (which carries `Path`) could resolve a
 * tool but hand the child no `PATH` at all).
 */
function readPathVar(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env.PATH;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') return env[key];
  }
  return undefined;
}

/**
 * The one shared reader {@link readPathVar} is — both `resolveTool` (finding
 * the variable to walk) and this function (deciding what to forward) call
 * it, so the two can never drift into disagreeing about which key spells
 * `PATH` on a given platform (`.claude/rules/invariants.md`, "One mechanism,
 * one implementation"). Regardless of which case the caller's own `env` used
 * (`PATH`, `Path`, …), the child always receives it under the EXACT key
 * `PATH` — the one spelling every consumer of this module can rely on.
 */
function filterAllowedEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_VARS_SET) {
    if (key === 'PATH') continue; // handled below, case-insensitively on win32
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  const pathValue = readPathVar(env, platform);
  if (pathValue !== undefined) out.PATH = pathValue;
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
 * delimiter, what counts as absolute) is a property of the platform being
 * modeled, not of the host actually running this process, so
 * {@link resolveTool} uses this for the `PATH`-entry filter and
 * {@link splitPathVar} uses it for the delimiter. It is deliberately NOT
 * used for the repo-containment comparison — see this module's header and
 * {@link isInside}'s own callers, which compare against `process.platform`
 * instead (gate cycle 2, blocker 1). The real filesystem calls elsewhere in
 * this module (`readdirSync`, `realpathSync`, the final `path.join` building
 * a candidate file) stay host-native regardless, because they touch the
 * actual filesystem this process runs on, never a simulated one — there is
 * no way to make those anything else.
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
 * returned `false` for exactly this case). Takes `platform` purely to decide
 * `path.win32` vs `path.posix` and whether to case-fold — every CALLER of
 * this function is responsible for deciding WHICH platform that should be:
 * `resolveTool`'s own containment checks always pass `process.platform` (see
 * this module's header), never `options.platform`, precisely because this
 * function faithfully does what it is told and cannot itself tell a
 * declared platform from the host's own reality.
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
 * (gate cycle 1, blocker 3; the fallback's own remaining gap is limit 8).
 * The JS implementation does not expand an 8.3 short-name path component or
 * canonicalise case on win32, which let a `PATH` entry spelled through its
 * short name defeat {@link isInside} entirely; the native call resolves
 * through the OS. This is {@link resolveTool}'s DEFAULT canonicaliser — its
 * `realpath` option can override it, e.g. for a test that verifies both call
 * sites (the directory and the candidate file) genuinely consult whichever
 * function is handed to them (gate cycle 2, blocker 2's host-independent
 * pin).
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
 * Resolve `name` to an absolute, spawnable file by walking `env`'s `PATH`
 * (read via {@link readPathVar}, so a win32 `Path` is found the same way
 * {@link filterAllowedEnv} forwards it) — never returning a path inside
 * `repoDir` (see this module's header) — and never treating a relative or
 * empty `PATH` entry as a search location (an empty entry conventionally
 * means "search the current working directory", which this module refuses
 * to do: the current directory is not a trusted search root here).
 */
export function resolveTool(
  name: string,
  options: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    repoDir: string;
    /**
     * The canonicaliser used for EVERY containment check this function makes
     * — `repoDir` itself, each `PATH` entry's directory, and the final
     * candidate file. Defaults to this module's own {@link realpathOrNull}.
     * Injectable so a test can prove both call sites genuinely consult it
     * (gate cycle 2, blocker 2: a host-independent pin standing in for a
     * win32 runner this suite does not have) rather than each silently
     * falling back to some OTHER, uninjected realpath internally.
     */
    realpath?: (target: string) => string | null;
  },
): ResolveToolResult {
  if (!isValidToolName(name)) return { status: 'tool-not-found' };
  const realpath = options.realpath ?? realpathOrNull;

  const repoReal = realpath(options.repoDir) ?? path.resolve(options.repoDir);

  const pathVar = readPathVar(options.env, options.platform) ?? '';
  const entries = splitPathVar(pathVar, options.platform);

  for (const rawEntry of entries) {
    // A single check does both jobs: an empty entry (which conventionally
    // means "search the current working directory") and any other relative
    // entry both fail the DECLARED platform's `isAbsolute`, so both are
    // skipped here — the current directory is not a trusted search root in
    // this module.
    if (!pathFor(options.platform).isAbsolute(rawEntry)) continue;

    const dirReal = realpath(rawEntry);
    if (dirReal === null) continue; // does not exist / unreadable
    // ALWAYS `process.platform` here, never `options.platform` — see this
    // module's header and `isInside`'s own comment. `dirReal`/`repoReal` are
    // HOST realpaths; comparing them with a declared-but-wrong platform's
    // path module is exactly gate cycle 2's blocker 1.
    if (isInside(dirReal, repoReal, process.platform)) continue; // never resolve from inside the repo

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
    const candidateReal = realpath(candidate);
    if (candidateReal === null) continue; // dangling symlink etc.
    if (isInside(candidateReal, repoReal, process.platform)) continue; // a symlinked file resolving into the repo

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
const INVALID_BOUND_MESSAGE = 'boundedRun requires a positive, finite timeoutMs and maxBuffer';
const INVALID_BOUND_CODE = 'ERR_INVALID_ARG_VALUE';

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

/** A bound this module enforces (a deadline, an output cap) must be a positive, finite number — `0`, `NaN` and `Infinity` would silently disarm it. */
function isInvalidBound(value: number): boolean {
  return !Number.isFinite(value) || value <= 0;
}

/**
 * Run `absFile argv…` with a deadline and an output cap, never through a
 * shell. `absFile` must already be an absolute path — the caller (typically
 * {@link resolveTool}'s own result) is what makes it trustworthy; this
 * function refuses anything else outright rather than resolving it itself,
 * so it never re-implements (or drifts from) `resolveTool`'s own repo-escape
 * check — see this module's header, limit 9: that means `boundedRun` itself
 * applies NO containment check to `absFile`, only to `cwd`.
 */
export async function boundedRun(
  absFile: string,
  argv: readonly string[],
  options: BoundedRunOptions,
): Promise<BoundedRunResult> {
  if (!path.isAbsolute(absFile)) {
    return {
      status: 'spawn-error',
      code: undefined,
      message: 'boundedRun requires an absolute file path',
    };
  }

  if (isInvalidBound(options.timeoutMs) || isInvalidBound(options.maxBuffer)) {
    return { status: 'spawn-error', code: INVALID_BOUND_CODE, message: INVALID_BOUND_MESSAGE };
  }

  // Never the inherited `process.cwd()` — during this project's own tests
  // (and plausibly during a real run) that IS the untrusted repository being
  // acted on. When the caller omits `cwd`, this module owns a FRESH per-run
  // directory under `os.tmpdir()` rather than handing out the shared,
  // world-writable temp root itself (gate cycle 2 advisory: a spawned tool
  // that reads `cwd`-relative configuration would otherwise see whatever
  // another process left there) — created with mode `0700` and removed on
  // every exit path, including a timeout or an unexpected throw.
  let cwd: string;
  let ownedCwd: string | null = null;
  if (options.cwd !== undefined) {
    cwd = options.cwd;
  } else {
    ownedCwd = await mkdtemp(path.join(tmpdir(), 'rig-run-'));
    try {
      await chmod(ownedCwd, 0o700);
    } catch {
      // Best effort: win32 has no POSIX mode bits for a directory, and a
      // chmod failure here does not make the directory any less "just
      // created, for this run alone" — it only means the OS-level
      // permission narrowing did not apply.
    }
    cwd = ownedCwd;
  }

  try {
    // Realpath-resolved BEFORE the containment check — through any symlink
    // chain, the same way `resolveTool` resolves a `PATH` entry — so a `cwd`
    // reaching into the repository only via a symlink is caught too (see
    // this module's header, limit 6). `process.platform`, never a caller
    // option: there is no `options.platform` here, and there must not be one
    // for the same reason `resolveTool`'s own containment checks never take
    // one either (gate cycle 2, blocker 1).
    const cwdReal = realpathOrNull(cwd) ?? path.resolve(cwd);
    const repoReal = realpathOrNull(options.repoDir) ?? path.resolve(options.repoDir);
    if (isInside(cwdReal, repoReal, process.platform)) {
      return {
        status: 'spawn-error',
        code: undefined,
        message: 'boundedRun refuses a cwd inside the repository',
      };
    }

    const childEnv = filterAllowedEnv(options.env ?? {}, process.platform);

    return await new Promise<BoundedRunResult>((resolve) => {
      try {
        execFile(
          absFile,
          [...argv],
          {
            cwd: cwdReal, // the REAL path, not the possibly-symlinked one the caller gave
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

            // execFile sets `.killed` true exactly when IT killed the
            // process — either the deadline or (handled above, first)
            // maxBuffer.
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
            // harness, an operator, or another process. The child DID run
            // and may have produced output before it died, so — unlike the
            // spawn-level failure below, where nothing ever ran — that
            // output is kept (gate cycle 1, blocker 2: this case used to
            // fall through to `spawn-error` with its output silently
            // dropped).
            if (err.signal) {
              resolve({
                status: 'killed-by-signal',
                signal: err.signal,
                stdout: sanitizeStdout(stdout),
                stderr: sanitizeStderr(stderr),
              });
              return;
            }

            // A spawn-level failure (ENOENT, EACCES, …): the process never
            // ran, so there is no output to report.
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
  } finally {
    if (ownedCwd !== null) {
      await rm(ownedCwd, { recursive: true, force: true });
    }
  }
}
