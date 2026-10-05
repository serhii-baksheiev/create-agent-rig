#!/usr/bin/env node
// RP-290 — persist required-check failure identity so a fresh diagnostician
// can answer it without the original process output.
//
// A required check going red is durable evidence today only while the
// terminal/CI log survives — a fresh controller reading only the run journal
// afterward gets nothing. This script wraps ONE check invocation, passes the
// child's own stdout/stderr through unmodified (nothing about the live run
// changes), and — only when `RIG_RUN_DIR` is declared — appends ONE
// `check-result` event (`run-journal.mjs`'s `recordEvent`) carrying the
// check's name, exit identity, up to 50 failing test identities, a bounded
// tail on failure, and the path to a bounded full log on disk. Journalling a
// check-result here does not by itself wire the check into the
// `gate-stop-dod` Definition-of-Done gate (RP-295, RP-290 review) — that gate
// only runs the commands listed in `dod-checks.json`, a separate,
// config-driven step this script neither reads nor writes.
//
//   node .claude/scripts/check-run.mjs --name <check> [--timeout <seconds>]
//        -- <command> [args...]
//
// `<command> [args...]` is spawned by argv, never through a shell — nothing
// here interpolates or re-parses it, so a shell-metacharacter-shaped argument
// reaches the child literally (win32 `.cmd`/`.bat` shims are the one
// exception the OS itself forces — see "Windows batch shims" below). With
// `RIG_RUN_DIR` undeclared, the check still runs and exits the same way;
// nothing is written, and exactly one stderr line says why. Without
// `--timeout`, the child runs to completion; with it, a hung child's WHOLE
// PROCESS TREE is killed and the record still reports `timedOut: true`.
//
// The child's stdout/stderr are captured through a real FILE, not a pipe:
// Node writes to a pipe asynchronously on POSIX, and a check that calls
// `process.exit()` right after a burst of writes (an ordinary shape for a
// test runner's own summary line) can lose the still-queued tail of its own
// output before this process would ever see it — a real file is written
// synchronously instead, so nothing is lost to that race. This process reads
// the file back ONLY AFTER the child has closed and streams it — to the
// caller's own stdout/stderr, and through the pipeline below — a bounded
// chunk at a time, never loading the whole thing into memory at once: replay
// is not live, and nothing here promises interleaved passthrough while the
// child still runs.
//
// --- A command that never starts at all ------------------------------------
//
// A missing/unrunnable command (ENOENT, EACCES, EINVAL — including a
// synchronous throw from `spawn` itself, or from this process's own
// pre-spawn refusal of an unsafe cmd.exe argument — "Windows batch shims"
// below) is recorded as outcome `'spawn-error'`, never `'fail'`: a fresh
// reader must be able to tell "the command was misconfigured" from "the
// command ran and its test failed", which is a different fix in a different
// place. `spawn-error` carries no `tail` and no `failedTests` — nothing ran
// to produce either — and exits 127 for an ENOENT-shaped failure, 1
// otherwise. Exactly one stderr line names the failure's `code` only (or, for
// the cmd.exe refusal, its own self-contained reason), never a dump of the
// environment or the full error object. See `check-run.test.ts` (absent in a generated rig)
// › "exits non-zero and prints a stderr line naming the spawn failure" and
// › "records outcome 'spawn-error' in the journal — never 'fail' — with no
// failedTests and no tail".
//
// --- Windows batch shims ----------------------------------------------------
//
// A `.cmd`/`.bat` command cannot be started directly by `CreateProcess` — the
// OS itself routes it through `cmd.exe` — so on win32, when `command[0]` is
// (or PATH+PATHEXT resolves it to) a `.cmd`/`.bat` file, this spawns
// `cmd.exe /d /s /c "<quoted command line>"` with `windowsVerbatimArguments:
// true` instead. The batch file's own resolved PATH and every argument that
// follows it are escaped by two DIFFERENT functions, because a quoted token
// and an unquoted one need different treatment: an argument is quote-wrapped
// (backslash-doubling ahead of an embedded quote) and then caret-escaped the
// cmd metacharacters `()%!^"<>&|` TWICE, matching `cross-spawn`'s own shape
// for a `%*`-forwarding shim (the ordinary form of an npm/pnpm-installed
// `.cmd`) — see `escapeCmdArgument`'s own comment for why it needs the
// second pass the PATH does not. The PATH is never quoted at all — it is
// caret-escaped ONCE, over the same metacharacters plus SPACE and TAB — see
// `escapeCmdBatchPath`'s own comment for why a quoted PATH is unsafe here.
// Zero new dependencies — the escaping is the handful of lines below, not a
// package. An argument containing a double quote, CR or LF is refused BEFORE
// cmd.exe is ever spawned instead — no escaping makes such an argument safe
// on a cmd.exe command line — see `CmdArgumentRefusedError` and ›
// "refuses `x"&<marker.cmd>` without ever running marker.cmd" and its two
// siblings (skipped off Windows). A `.exe`/`.com` command is never routed
// through `cmd.exe`. See › "Windows .cmd shims are run without shell
// interpolation of the argument", › "a cmd.exe-routed argument with no
// quote/CR/LF still arrives literally through the %* shim" and › "a
// cmd.exe-routed batch file whose own resolved PATH contains a space" (all
// three skipped off Windows — `onlyOnWindows()` — there is nothing to
// measure elsewhere).
//
// --- Bounds ---------------------------------------------------------------
//
// Every one of these is a cap, never a hope, per `.claude/rules/
// invariants.md`'s bounded-work rule ("can any input make it do unbounded
// work at all" — not "is it fast enough on realistic input"):
//
//   - a single line of output is bounded to 64 KiB (`LINE_MAX_BYTES`) while it
//     is still pending (no trailing newline seen yet): a streaming line
//     feeder tracks only the bytes of the CURRENT pending line, never
//     re-splits or rescans what came before it, and a line that crosses the
//     cap is replaced WHOLE by `[redacted: line over 65536 bytes]` once its
//     terminating newline arrives — never a partial write of what was seen
//     before the cap. This is a bound independent of, and ahead of, the
//     credential scan below, because `findSecretValues` itself reads at most
//     `DEFAULT_SCAN_LIMIT` (2 MiB, `lib/secrets.mjs`) and a single line past
//     that is otherwise invisible to it; see › "replaces an over-long line
//     ending in a credential with a marker, never the credential, and
//     finishes quickly";
//   - the full log kept on disk is capped at 5 MiB, KEEPING THE END — a
//     `CappedBuffer` that tracks a RUNNING byte count (updated only by each
//     newly pushed chunk, never by re-measuring the whole accumulated
//     buffer) and only re-slices to the cap once that count has grown to
//     twice the cap, so the cost is amortised over the input rather than paid
//     per line; see `check-run.test.ts` (absent in a generated rig) ›
//     "bounds the tail to at most 60 lines and 8192 bytes, and the log file
//     to at most 5 MiB, keeping the END of the output";
//   - the failure `tail` (present only when the check fails) is capped at 60
//     lines and 8192 bytes, built from a fixed-size window of the last 60
//     processed lines — never a rescan of the whole output — same test. When
//     the single remaining line is ITSELF over the byte cap (dropping whole
//     lines would empty the tail and discard the one line a reader needed
//     most — the assertion), that last line is trimmed to its OWN end
//     instead of being dropped: see › "keeps the tail non-empty, within the
//     byte cap, and ending with the tail of the long assertion line";
//   - `failedTests` stops growing past 50 entries, and each entry is cut to
//     300 characters — › "bounds failedTests to at most 50 entries, even when
//     the output names more" and › "bounds each failedTests entry to at most
//     300 characters";
//   - a failing test identity is extracted ONLY from a line shaped like a
//     vitest failure summary (` FAIL  <id>`), a bullet (`× <id>`/`✗ <id>`), or
//     TAP (`not ok N - <id>`) — never invented from other output; ›
//     "never invents a failedTests entry when the output carries no
//     recognizable failure-shaped line";
//   - each of those three patterns is a single, unambiguous linear scan of
//     the line, with no split it needs to try more than one way — see the
//     patterns' own comment, above their definition, for why the earlier
//     shape was quadratic in a long run of whitespace; › "finishes quickly
//     for 20 FAIL-, ×- and not-ok-shaped lines each carrying a
//     60,000-character whitespace run".
//
// --- Redaction and normalisation -------------------------------------------
//
// Every line is processed once, in this order, before it ever reaches the
// tail, the log, or a `failedTests` entry: ANSI escape codes are stripped (›
// "strips ANSI escape codes from the identity and the tail"); an absolute
// path under this process's own cwd, or a verified alias of it (its own
// realpath, a `PWD` whose realpath agrees, or — on macOS — the same realpath
// with its leading `/private` removed, matching the OS's own `/var`/`/tmp`/
// `/etc` symlink convention — `buildPrefixCandidates`, above `runCheck`), is
// rewritten repo-relative (› "converts an absolute path to the repo root
// inside a test identity into a repo-relative one" and › "strips the prefix
// when the runner prints the identity anchored to the REALPATH"). Every
// candidate here is computed ONCE per check, from this process's OWN cwd and
// environment — never from anything the checked command prints — so this
// whole pass stays pure string work, never a filesystem probe driven by
// runner output. A `failedTests` entry ALONE gets one more pass a plain line
// does not: backslashes in its path portion (before the first ` > `) are
// turned to forward slashes, unconditionally, in `normalizeFailedTestId`,
// above `runCheck` (› "a backslash-separated identity under cwd is
// normalized to forward slashes"). RP-290 review round 2 removed the
// fs-based ancestor walk this same function used to fall back to for an
// alias `buildPrefixCandidates` had no way to predict: security-scanner,
// reproduced on win32, found it drove `existsSync`/`realpathSync.native`
// calls off the checked command's own (untrusted) output — a UNC-looking
// alias meant a real SMB/NTLM connection attempt (measured 21s per id), and
// a very deep path walked one ancestor per path segment, unbounded by
// anything this process controls. Such an alias now stays absolute, exactly
// as printed, as a STATED LIMIT rather than a best-effort resolution: see ›
// "keeps an identity printed under an arbitrary symlink alias of cwd
// absolute — resolving it would take filesystem probes driven by runner
// output", › "does not touch the filesystem for a UNC-looking failing-test
// path in runner output" and its win32 sibling, and › "finishes quickly and
// records at most 50 entries, each at most 300 characters, for 50 lines each
// carrying a ~20 KB deep path". A PER-STREAM state machine tracks whether the line sits
// inside a PEM private-key block — a line matching
// `lib/secrets.mjs`'s own `private-key-block` shape (reused verbatim, never
// hand-copied) starts redaction of every line through the matching END line
// INCLUSIVE, or to the end of that stream's output when no END line ever
// arrives — the same whole-unit rule `continuation.mjs` applies to a single
// field, because a per-line credential scan only ever sees the BEGIN line's
// shape and lets the base64 key body and the END line straight through: see
// › "redacts the body and END line of a terminated PEM block, while a line
// after END survives" and › "redacts everything after an UNTERMINATED BEGIN
// block, to the end of the output". Outside a PEM block, the line is checked
// for a credential shape with `lib/secrets.mjs`'s `findSecretValues` — reused
// verbatim, never a second copy of the vocabulary (`invariants.md`: "one
// mechanism, one implementation") — and a line that matches is replaced WHOLE
// by `[redacted]`, never partially, for the same reason. The recorded
// `command` field goes through the same path-relativise-then-redact pass.
// See › "redacts a credential-shaped value out of the tail, while the
// assertion and identity survive", › "redacts a credential-shaped value out
// of the recorded command field", › "never leaves a credential-shaped value
// in the log file on disk", and › "redacts a credential-shaped value
// embedded inside a failing test identity" — the last of these loses the
// whole identity along with the credential, because the line that carried it
// no longer reads as a failure-summary line once redacted; this is the
// accepted, safe-direction cost.
//
// --- Timeout kills the whole process tree -----------------------------------
//
// The direct child is spawned `detached: true` on POSIX (its own process
// group), so a timeout kill targets `-child.pid` with `SIGKILL` rather than
// only the direct child — a check command that itself spawns a worker
// process (an ordinary shape for a test runner) is killed along with it,
// rather than orphaned. On win32, where there is no process-group signal,
// the same kill is `taskkill /pid <pid> /T /F`, resolved by its ABSOLUTE
// path under `%SystemRoot%\System32` rather than a bare PATH lookup of the
// name (bounded by its own timeout). See › "a grandchild process spawned by
// the checked command is no longer alive after check-run returns".
//
// --- An interrupt sent to check-run itself, not its process group ----------
//
// The checked command sits in its OWN process group (`detached: true` on
// POSIX, above) precisely so a `--timeout` kill can target its whole tree —
// which also means Node's default `SIGINT`/`SIGTERM`/`SIGHUP` handling
// (immediate teardown of THIS process, `finally` never runs) would leave the
// checked command running unattended, and its capture temp files behind, the
// moment an operator hits Ctrl-C on a required check. So this process
// installs its own handler for those three signals on POSIX (`SIGINT`/
// `SIGBREAK` on win32, which has no SIGTERM/SIGHUP to catch), kept installed
// through the direct child's own run AND the read-back that follows it (RP-295
// item B — a signal landing after the direct child has already closed, while
// the two capture files still exist, must still reach this handler) — that
// does exactly what a timeout does — kill the child's whole tree,
// unconditionally, every time this handler runs — plus closes and removes
// this run's own capture files, removes the handlers, and exits with the
// POSIX `128 + signal number` convention. RP-295 gate round 3 (controller,
// blocker C) — an earlier revision skipped the tree kill once the direct
// child had already closed, reasoning there was "no process (tree) left to
// kill"; that missed that `killChildTree` on POSIX signals the whole PROCESS
// GROUP, not the direct child's own pid alone, and a group persists — with no
// pid-reuse risk — for as long as any member of it (a backgrounded worker the
// checked command spawned and left running) is still alive, even after the
// direct child itself has exited. The kill is unconditional again. See ›
// "kills the checked command and removes its own capture files, rather than
// dying immediately and leaking both" and › "kills a still-alive backgrounded
// process from the checked command's own process group, even though the
// direct child already closed" (both POSIX-only — there is no Windows
// equivalent of a signal delivered to a single pid rather than its process
// group to measure).
//
// --- Temp capture files ------------------------------------------------------
//
// The two per-run capture files are created exclusively (`openSync(path,
// 'wx', 0o600)` — this process's own name, refused if it already exists,
// owner-only permissions) and removed in a `finally` that covers every exit
// path out of the spawn-and-capture section: a spawn throw, a stream error
// while reading a capture file back, and an ordinary timeout kill all still
// reach the same cleanup. See › "leaves no check-run capture temp file
// behind after a spawn-error run" and › "leaves no check-run capture temp
// file behind after a normal failing run".
//
// --- What this does not do -------------------------------------------------
//
// It never re-orders stdout and stderr into one faithful interleaving — each
// is read back and passed through in full only after the child has closed,
// stdout before stderr, so live/interleaved passthrough while the child is
// still running is not something a caller watching this process can rely on.
// It is not a general log redacter: it inherits every limit `lib/secrets.mjs`
// states for `findSecretValues` (a text scan capped per line, not an entropy
// analyser) rather than restating them here.
// It does not honour backpressure on the DESTINATION side of the pass-through
// (RP-295, item D, declined with this stated limit — RP-290 review): the
// bounded, chunk-at-a-time SOURCE read above is what "never loading the whole
// thing into memory at once" promises, but `passThroughAndProcess` calls
// `dest.write(chunk)` without checking its return value or pausing the source
// read on it, so a stalled destination reader (the caller's own stdout/stderr)
// still lets unflushed data queue in memory without bound.
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { recordEvent } from './run-journal.mjs';
import { findSecretValues, SECRET_VALUE_PATTERNS } from './lib/secrets.mjs';

const REDACTED_LINE = '[redacted]';
const TAIL_MAX_LINES = 60;
const TAIL_MAX_BYTES = 8192;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const FAILED_TESTS_MAX = 50;
const FAILED_TEST_MAX_CHARS = 300;
const LINE_MAX_BYTES = 64 * 1024;

const WIN32 = process.platform === 'win32';
// Read from `process.platform` directly, not injectable (RP-295, RP-290
// review) — `buildPrefixCandidates`'s `/private`-stripping rule below is
// gated on this constant, and it has no non-darwin test coverage: there is
// no seam to make this process believe it is running on macOS while it is
// not, so the rule can only ever be exercised on a real macOS host.
const DARWIN = process.platform === 'darwin';

// eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
// RP-323 (security-scanner battery, shapes s28/s29) — `ANSI_PATTERN` above
// matches only a CSI sequence (`ESC [ … letter`); an OSC sequence (a
// terminal TITLE, `ESC ] 0 ; text BEL`, or HYPERLINK, `ESC ] 8 ; ; url ST`
// where ST is `ESC \`) starts with `ESC ]` instead and was left untouched,
// so its own bytes could sit inside a PEM BEGIN header and break the
// `private-key-block` pattern's match. `[^\x07\x1b]*` followed by the
// literal terminator alternation cannot backtrack catastrophically (the
// negated class excludes both terminator bytes, so there is exactly one way
// to split it from what follows) — see check-run.test.ts
// (absent in a generated rig) › "finishes within a bounded time" (many UNTERMINATED
// `ESC ]` openers). An unterminated `ESC ]` (no BEL, no ST ever arrives) is
// left exactly as it is — a stated limit, not a gap this pattern tries to
// close.
// eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (text) => text.replace(ANSI_PATTERN, '').replace(OSC_PATTERN, '');

// RP-290 review round 3 (security-scanner, reproduced on Linux/WSL) — these
// three used to be `/^\s*FAIL\s+(.+?)\s*$/`-shaped: a non-greedy capture
// followed by a trailing `\s*$`, where the capture, the preceding `\s+`(/`\s*`)
// and the trailing `\s*` all accept the SAME character (space) with no fixed
// boundary between them. A line carrying a long run of spaces that the regex
// ultimately fails to match in full (this project's own fixture: `FAIL a` +
// 60,000 spaces + a bare `\r` + `y`, where `y` is not whitespace and `.`
// does not match `\r` without `s`) makes the engine retry every split of that
// run between the three quantifiers before giving up — quadratic in the run's
// length, measured at 26–56s for a single 60,000-space line (module header's
// "Bounds"). Each pattern below removes the ambiguity instead of budgeting
// around it: `\S` (a single, non-quantified character) marks where the
// captured identity starts, so there is exactly one way to split `\s+`
// (or the TAP pattern's `\s*-\s*`) from the capture — no run of whitespace is
// ever tried more than one way — and the capture itself is `\S.*` with the
// `s` flag, a single greedy scan straight to end-of-string with nothing left
// to backtrack into. The TAP pattern's `not ok N` + no dash at all (the
// fixture's own `not ok 1 - a` + 60,000 spaces case, minus the dash) still
// costs only a single linear scan of the run — `\s*-\s*` has only ONE
// variable-length group active at a time (the second is never reached until
// the literal `-` is found), never two overlapping ones. Trailing whitespace
// that used to be excluded by the old pattern's own trailing `\s*$` is
// trimmed instead in `extractFailedTestId`, below. See `check-run.test.ts`
// (absent in a generated rig) › "finishes quickly for 20 FAIL-, ×- and
// not-ok-shaped lines each carrying a 60,000-character whitespace run" and ›
// "keeps extracting a failing-test identity with trailing whitespace".
const FAIL_PATTERN = /^\s*FAIL\s+(\S.*)$/s;
const BULLET_PATTERN = /^\s*[×✗]\s+(\S.*)$/s;
const TAP_PATTERN = /^\s*not ok\s+\d+\s*-\s*(\S.*)$/s;

// The BEGIN-line shape a private-key block starts with — reused from
// `lib/secrets.mjs`'s own vocabulary, never a hand-copied second pattern.
const PRIVATE_KEY_HEADER_PATTERN = SECRET_VALUE_PATTERNS.find(
  (entry) => entry.id === 'private-key-block',
).pattern;
// The matching END line. Not part of `lib/secrets.mjs`'s credential
// vocabulary — it names no secret by itself — so it stays local to the one
// state machine that needs it.
const PRIVATE_KEY_END_PATTERN = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

// Global variants of the two patterns above, used ONLY by `lastMatchIndex`
// below to find where the LAST BEGIN/END marker sits on a line — never for
// testing (`.test()` on a stateful global pattern is its own footgun; the
// non-global originals above stay the ones every `.test()` call uses).
const PRIVATE_KEY_HEADER_PATTERN_GLOBAL = new RegExp(PRIVATE_KEY_HEADER_PATTERN.source, 'g');
const PRIVATE_KEY_END_PATTERN_GLOBAL = new RegExp(PRIVATE_KEY_END_PATTERN.source, 'g');

// RP-295 (RP-290 review follow-up, item A) — the PEM state machine used to
// unconditionally disarm on any END match: `if (PRIVATE_KEY_END_PATTERN.test
// (line)) inPemBlock = false;`, with no regard for a NEW BEGIN also present
// on the SAME line, after that END (two keys concatenated with no newline
// between the first key's END and the second key's BEGIN). The rule this
// pins: armed after the line iff the LAST BEGIN marker's index is greater
// than the LAST END marker's index (a line with a marker but no counterpart
// of the other kind reads as if the missing one were at index -1). Bounded
// the same way the rest of this module's per-line work is: `text` is always
// one already-bounded unit — a single line (at most `LINE_MAX_BYTES`) or, per
// `makeLineFeeder`'s own comment below, the bounded `tail + segment` window
// each incoming chunk is evaluated against as it streams in — so this single
// forward scan costs the same as one `.test()` call. See `check-run.test.ts`
// (absent in a generated rig) › "keeps the block armed for the second key
// body when END and a new BEGIN sit on the SAME line".
const lastMatchIndex = (text, globalPattern) => {
  globalPattern.lastIndex = 0;
  let last = -1;
  let match = globalPattern.exec(text);
  while (match !== null) {
    last = match.index;
    if (match[0].length === 0) globalPattern.lastIndex += 1;
    match = globalPattern.exec(text);
  }
  return last;
};

// RP-295 (RP-290 review follow-up, item E, second half) — each pattern's
// capture is `\S.*` with the `s` flag, so `.` matches an embedded `\r` too: a
// carriage-return redraw INSIDE a single logical line (`makeLineFeeder` only
// splits on `\n`) used to stay part of the captured identity, swallowing
// whatever redraw junk the runner wrote after its own `\r`. The identity
// stops at the first embedded `\r` instead — see `check-run.test.ts`
// (absent in a generated rig) › "stops a failing-test identity at an
// embedded \\r rather than swallowing what follows it".
const stopAtCarriageReturn = (text) => {
  const index = text.indexOf('\r');
  return index === -1 ? text : text.slice(0, index);
};

/**
 * A failing test identity from one already-processed line, or `null`. Each
 * pattern's capture is a greedy `\S.*` (see the patterns' own comment) that
 * no longer excludes trailing whitespace the way the old trailing `\s*$` did.
 * Trailing whitespace is trimmed by the CALLER (`runCheck`), not here — RP-295
 * (RP-290 review follow-up, item E, first half) found that trimming the FULL
 * capture here, ahead of the later 300-character cut in `runCheck`, could
 * leave the STORED (cut) entry ending in whitespace anyway, whenever the cut
 * landed on interior whitespace `trimEnd()` never touched at capture time.
 * See › "trims trailing whitespace exposed by the 300-character cut, not
 * only the identity’s own true end".
 */
const extractFailedTestId = (line) => {
  const fail = FAIL_PATTERN.exec(line);
  if (fail) return stopAtCarriageReturn(fail[1]);
  const bullet = BULLET_PATTERN.exec(line);
  if (bullet) return stopAtCarriageReturn(bullet[1]);
  const tap = TAP_PATTERN.exec(line);
  if (tap) return stopAtCarriageReturn(tap[1]);
  return null;
};

/**
 * A byte buffer bounded to `byteCap`, keeping the END — see the module
 * header's "Bounds". `approxBytes` is a RUNNING total, incremented only by
 * the byte length of each newly pushed (small) chunk — never by re-measuring
 * the whole accumulated buffer, which would turn every push into an O(current
 * size) scan and the whole stream into O(n²).
 */
class CappedBuffer {
  constructor(byteCap) {
    this.byteCap = byteCap;
    this.buf = '';
    this.approxBytes = 0;
  }

  push(text) {
    this.buf += text;
    this.approxBytes += Buffer.byteLength(text, 'utf8');
    if (this.approxBytes > this.byteCap * 2) {
      this.buf = trimToLastBytes(this.buf, this.byteCap);
      this.approxBytes = Buffer.byteLength(this.buf, 'utf8');
    }
  }

  finalize() {
    return trimToLastBytes(this.buf, this.byteCap);
  }
}

/** Cut `text` to at most `byteCap` UTF-8 bytes, keeping the end and never splitting a multi-byte character. */
const trimToLastBytes = (text, byteCap) => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= byteCap) return text;
  let start = buf.length - byteCap;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
};

/**
 * Last-60-lines window, then trimmed to `TAIL_MAX_BYTES`, keeping the END.
 * Whole lines are shifted off the FRONT first; if a single line remains and
 * is itself still over the cap, that line is trimmed to its own end rather
 * than dropped — see the module header's "Bounds".
 */
const buildTail = (lines) => {
  const kept = lines.slice();
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n'), 'utf8') > TAIL_MAX_BYTES) {
    kept.shift();
  }
  let joined = kept.join('\n');
  if (Buffer.byteLength(joined, 'utf8') > TAIL_MAX_BYTES) {
    joined = trimToLastBytes(joined, TAIL_MAX_BYTES);
  }
  return joined;
};

const parseArgs = (argv) => {
  let name = null;
  let timeoutSeconds = null;
  let i = 0;
  for (; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--name') name = argv[(i += 1)] ?? null;
    else if (flag === '--timeout') timeoutSeconds = Number(argv[(i += 1)]);
    else if (flag === '--') {
      i += 1;
      break;
    } else return { error: `unknown flag ${flag}` };
  }
  const command = argv.slice(i);
  if (!name) {
    return {
      error:
        'usage: node check-run.mjs --name <check> [--timeout <seconds>] -- <command> [args...]\n' +
        '--name is required.',
    };
  }
  if (command.length === 0) {
    return { error: '-- <command> [args...] is required: nothing to run.' };
  }
  return {
    ok: true,
    name,
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : null,
    command,
  };
};

// A small, FIXED-size rolling window (characters, not bytes — the header it
// exists to catch is short ASCII) kept for the CURRENT pending line only,
// regardless of whether that line is still under `LINE_MAX_BYTES` or has
// already gone over it. Carried across `appendSegment` calls so a marker
// whose own bytes straddle two incoming chunks — a disk-read chunk boundary,
// not only a line boundary — is still seen whole once BOTH halves have
// arrived (see `appendSegment`'s own comment): `tail` is re-sliced to this
// many characters on every append, so its own cost is O(1) per chunk, not
// O(line length).
const OVERFLOW_TAIL_CHARS = 256;

// RP-323 (security-scanner battery, shape s27) — `private-key-block`'s own
// padding class (`[A-Z0-9 ]*`, between `-----BEGIN ` and `PRIVATE KEY-----`)
// is unbounded, so no FIXED-size `tail` can contain every header: a header
// long enough to straddle a read-chunk boundary more than `OVERFLOW_TAIL_CHARS`
// characters from either end pushes its own `-----BEGIN ` prefix out of that
// small window before the rest of the header ever arrives.
//
// `appendSegment` below decides the open/closed carry on `evalText` —
// `normalize(context + segment)`, the SAME normalized text already computed
// for the marker scan just above it — never on the raw bytes: a CSI sequence
// sitting entirely inside one segment (so `normalize` resolves it
// immediately) still breaks a literal, RAW `-----BEGIN ` substring search
// even though the marker is already whole once stripped. An escape sequence
// `normalize` cannot yet resolve — split mid-OSC by the read-chunk boundary
// itself — is instead carried forward raw (together with up to
// `OPEN_HEADER_START`'s own length of marker-prefix characters ahead of it)
// so the next segment's `normalize` call completes it exactly as if both had
// arrived together. A header closes at its OWN closing dashes (`-----`), not
// at the key-specific `PRIVATE KEY-----`, so a header that is never a
// private key (`CERTIFICATE`, `PUBLIC KEY`) closes there instead of reading
// as open for the rest of the run.
//
// RP-323 round 4 (owner-authorised, reviewer-validated) — an exhaustive sweep
// across EVERY read-chunk split offset, not just the hand-picked ones above,
// found four further gaps `decideOpenHeaderCarry` below now closes:
//   - a header's own `-----` sitting INSIDE a still-unresolved escape (an
//     OSC title's own payload, say) no longer counts as the header's closing
//     dashes — the escape must resolve (BEL/ST) before any `-----` inside it
//     is read as a close;
//   - the escape rule is now evaluated BEFORE the marker-prefix rule below,
//     and carries from the FIRST unresolved escape, not the last — carrying
//     from a LATER, already-irrelevant escape (an OSC hyperlink's own split
//     `ESC \` terminator, say) could drop the marker's own leading dashes
//     that sat ahead of an earlier one;
//   - a marker prefix (`-----BEG`, say) immediately followed by a run of
//     characters that is itself a proper (not yet complete) prefix of one of
//     `runCheck`'s own relativize candidates — the check's cwd, its
//     realpath, ... — is carried forward too, and ARMED outright once that
//     candidate's own full text arrives without the separator `relativize`
//     needs to ever strip it, so the check's own cwd sitting inside the
//     marker, past a long OSC title, is never silently read as harmless
//     padding; `relativizeCandidates` carries this in from `runCheck` via
//     `makeLineFeeder`'s own options, alongside `normalize`, so this
//     otherwise harness-neutral feeder never hard-codes cwd/relativize
//     knowledge of its own; and
//   - the SAME open-marker carry now also covers `-----END `, whichever of
//     `-----BEGIN `/`-----END ` starts LATEST in `evalText`, so an END
//     marker's own closing dashes straddling the boundary are carried
//     forward too — without it, the marker-prefix rule's own dash-prefix
//     ambiguity (an END's closing `-----` reads exactly like a NEW BEGIN's
//     opening one) throws away everything carried so far, and the block
//     never closes.
//
// See `check-run.test.ts` (absent in a generated rig) › "still arms the
// block, even though the CSI sequence splits BEGIN itself and the padding is
// split across the boundary", › "still arms the block, even though the CSI
// sequence splits the opening dashes and the padding is split across the
// boundary", › "still arms the block, even though the hyperlink wrapping
// BEGIN itself is split across the boundary", › "still arms the block, even
// though the title sits inside the dashes and is split across the boundary",
// › "still records the later FAIL line and after-ok, for a CERTIFICATE
// header", its `PUBLIC KEY` sibling, › "RP-323 round 4 — an edge sweep
// across EVERY read-chunk split offset inside a BEGIN header, one run per
// shape", › "RP-323 round 4 — a BEGIN marker split by a >256-character OSC
// title with the check’s own cwd after it, swept at every offset", and ›
// "RP-323 round 4 — a split END marker still closes the block, swept at
// every offset".
const OPEN_HEADER_START = '-----BEGIN ';
// RP-323 round 4 — the END marker's own opening literal, read by
// `decideOpenHeaderCarry` the same way `OPEN_HEADER_START` is: whichever of
// the two starts LATEST in `evalText` is the one the carry tracks.
const OPEN_END_START = '-----END ';
// A cap on how large that carried-forward open suffix may grow across
// segments before this feeder fails CLOSED instead of growing it without
// bound (`invariants.md`'s bounded-work rule): past this many characters of
// padding with no closing dashes seen, an unresolved BEGIN is armed outright
// (`lastLineMarker = 'begin'`) and the carry is dropped, falling back to the
// ordinary `OVERFLOW_TAIL_CHARS` tail for whatever follows. An unresolved
// END past the same cap is never armed this way (RP-323 round 4) — the safe
// direction for an END this module cannot finish reading is to leave
// `lastLineMarker` exactly as it already was, never to disarm on a guess.
// See `check-run.test.ts` (absent in a generated rig) › "still arms the block
// once the carried-forward header text crosses the cap".
const OPEN_HEADER_MAX_CHARS = 4096;

/**
 * The length of the longest proper (1..`marker.length - 1` characters)
 * prefix of `marker` that `text` ends with, or 0 when none does. `marker`'s
 * length is fixed (`OPEN_HEADER_START`), so this is a handful of `endsWith`
 * checks, never a scan sized by `text`.
 */
const properPrefixSuffixLength = (text, marker) => {
  for (let length = marker.length - 1; length >= 1; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
};

/**
 * Whether `evalText`, from `markerStart` onward (the index right after a
 * found marker's own literal text — `-----BEGIN ` or `-----END `), has
 * already closed with its own `-----`. A `-----` sitting INSIDE a
 * still-unresolved escape (an OSC title's own payload, say) does not count —
 * the escape must resolve (BEL/ST) first, or its own `-----` is never read
 * as the header's close (RP-323 round 4, the reviewer-validated fix for
 * `decideOpenHeaderCarry`'s own case 1, below).
 */
const hasOwnClosingDashes = (evalText, markerStart) => {
  const after = evalText.slice(markerStart);
  const escapeIndex = after.indexOf('\x1b');
  const dashIndex = after.indexOf('-----');
  return dashIndex !== -1 && (escapeIndex === -1 || dashIndex < escapeIndex);
};

/**
 * Whether `remainder` — the text right after a `-----BEGIN ` prefix found at
 * the END of `evalText` (RP-323 round 4) — is itself a not-yet-complete
 * arrival of one of `relativizeCandidates` (`runCheck`'s own cwd/cwdReal/PWD
 * spellings, each with its own trailing separator — see
 * `buildPrefixCandidates`): `'growing'` while `remainder` is still a proper
 * prefix of some candidate (too short to say either way yet); `'complete'`
 * once `remainder` contains a candidate's own text IN FULL but not followed
 * by the separator `normalize`'s own `relativize` step needs to ever strip
 * it — the check's own cwd sitting inside the marker, with no separator ever
 * following it, is exactly this shape, and must never be read as ordinary
 * (harmless) padding; or `null` when `remainder` matches no candidate at
 * all. Bounded by `relativizeCandidates`' own size (a handful of entries)
 * and by `remainder`'s own length — never by anything the checked command
 * prints beyond this one marker's own trailing text.
 */
const pendingCandidateStatus = (remainder, relativizeCandidates) => {
  for (const candidate of relativizeCandidates) {
    if (remainder.length < candidate.length && candidate.startsWith(remainder)) return 'growing';
  }
  for (const candidate of relativizeCandidates) {
    const base = candidate.slice(0, -1);
    if (remainder.length > base.length && remainder.startsWith(base)) return 'complete';
  }
  return null;
};

/**
 * The open-marker carry for the NEXT `appendSegment` call, decided on
 * `evalText` (never on raw bytes — see `OPEN_HEADER_START`'s own comment,
 * above). `arm` is `'begin'` only for a fail-CLOSED case — an unresolved
 * BEGIN (or a marker-prefix-plus-candidate) this module cannot finish
 * reading before `OPEN_HEADER_MAX_CHARS`, or a relativize candidate that
 * arrives in full but without its own separator; the caller ORs it into
 * `lastLineMarker` rather than overwriting, exactly as the marker-scan
 * branch above it does. An unresolved END never arms this way — see
 * `OPEN_HEADER_MAX_CHARS`'s own comment.
 */
const decideOpenHeaderCarry = (evalText, relativizeCandidates) => {
  const beginIndex = evalText.lastIndexOf(OPEN_HEADER_START);
  const endIndex = evalText.lastIndexOf(OPEN_END_START);
  const isEnd = endIndex > beginIndex;
  const markerIndex = isEnd ? endIndex : beginIndex;
  const markerLength = isEnd ? OPEN_END_START.length : OPEN_HEADER_START.length;

  if (markerIndex !== -1 && !hasOwnClosingDashes(evalText, markerIndex + markerLength)) {
    if (evalText.length - markerIndex <= OPEN_HEADER_MAX_CHARS) {
      return { carry: evalText.slice(markerIndex), arm: null };
    }
    // Fail CLOSED rather than growing the carry without bound
    // (`OPEN_HEADER_MAX_CHARS`'s own comment) — only an unresolved BEGIN
    // arms outright; the safe direction for an END past the cap is to leave
    // `lastLineMarker` untouched.
    return { carry: null, arm: isEnd ? null : 'begin' };
  }

  // Evaluate the escape rule BEFORE the marker-prefix rule below (RP-323
  // round 4, the reviewer-validated fix): carries from the FIRST
  // unresolved escape in `evalText`, not the last.
  const escapeIndex = evalText.indexOf('\x1b');
  if (escapeIndex !== -1) {
    if (evalText.length - escapeIndex <= OPEN_HEADER_MAX_CHARS) {
      return {
        carry: evalText.slice(Math.max(0, escapeIndex - OPEN_HEADER_START.length)),
        arm: null,
      };
    }
    const before = evalText.slice(
      Math.max(0, escapeIndex - OPEN_HEADER_START.length),
      escapeIndex,
    );
    return {
      carry: null,
      arm: properPrefixSuffixLength(before, OPEN_HEADER_START) > 0 ? 'begin' : null,
    };
  }

  // The marker-prefix rule: `evalText` ends with a proper prefix of
  // `-----BEGIN ` directly, OR that prefix sits in `evalText` immediately
  // followed by a not-yet-resolved relativize candidate (RP-323 round 4,
  // `pendingCandidateStatus` above) — tried longest marker-prefix first, so
  // a more specific match wins.
  for (let length = OPEN_HEADER_START.length - 1; length >= 1; length -= 1) {
    const prefix = OPEN_HEADER_START.slice(0, length);
    const idx = evalText.lastIndexOf(prefix);
    if (idx === -1) continue;
    const remainder = evalText.slice(idx + length);
    if (remainder.length === 0) {
      return { carry: evalText.slice(idx), arm: null };
    }
    const status = pendingCandidateStatus(remainder, relativizeCandidates);
    if (status === 'growing') {
      if (evalText.length - idx <= OPEN_HEADER_MAX_CHARS) {
        return { carry: evalText.slice(idx), arm: null };
      }
      return { carry: null, arm: 'begin' };
    }
    if (status === 'complete') {
      return { carry: null, arm: 'begin' };
    }
  }

  return { carry: null, arm: null };
};

/**
 * A streaming line splitter: feed chunks, get complete lines as they close.
 * Bounded per the module header — at most `LINE_MAX_BYTES` of a PENDING
 * (not-yet-terminated) line is ever held; a chunk is scanned once with
 * `indexOf`, never by re-splitting the whole accumulated buffer, so the cost
 * is linear in the input rather than quadratic. `onLine` is called with the
 * finalized line text and a `{ overLimit, lastLineMarker }` record.
 *
 * `lastLineMarker` (`'begin' | 'end' | null`) is the one piece of PEM
 * knowledge this otherwise-agnostic feeder carries, and it is what the
 * PEM state machine in `runCheck` (below) arms/disarms from for an
 * OVER-LIMIT line only; a normal-length line takes its transition from one
 * scan of the whole line instead (RP-295 gate round 3) — RP-295 gate
 * round 2 (reviewer, reproduced on head a861085): the round-1 shape
 * (`sawBeginHeader`, a per-line bool set from testing each RAW segment
 * against `PRIVATE_KEY_HEADER_PATTERN` alone) had three independent gaps —
 * a header whose own bytes straddle a disk-read chunk boundary matched
 * NEITHER half on its own; an ANSI escape code embedded inside the header
 * broke the raw (unstripped) match even though the header, once stripped,
 * was the exact shape `findSecretValues` would flag; and a COMPLETE
 * BEGIN..END pair sitting early in one over-limit line, followed by enough
 * filler to push both markers out of a small fixed-size tail, left the
 * state machine blind to the END that had already closed the block on that
 * SAME line. `lastLineMarker` closes all three at once: on every
 * `appendSegment` call, BOTH patterns are matched — via `lastMatchIndex`,
 * above — against `stripAnsi(tail + segment)`, where `tail` is this line's
 * rolling window as it stood BEFORE this segment was appended (so a marker
 * split across the boundary is reassembled) and `segment` is the WHOLE new
 * chunk, however large (not the bounded `tail` alone — a complete BEGIN..END
 * pair sitting together within ONE chunk is seen in full here, even when
 * later filler on the same line would otherwise push both out of `tail`).
 * Whichever marker's LAST match index in that scan is greater becomes this
 * line's `lastLineMarker` so far; when NEITHER matches in a given segment,
 * the value already recorded from an earlier segment of the same line is
 * left untouched — never reset to "no marker" just because the current
 * segment's own bounded view no longer contains it. Reset to `null` only at
 * `resetLine`, once per line. Bounded the same way the rest of this feeder's
 * per-chunk work is: one linear scan per segment (`lastMatchIndex` costs the
 * same as a single `.test()` call), no re-scan of what came before it. See
 * `check-run.test.ts` (absent in a generated rig) › "still arms the block,
 * even though the small rolling tail no longer contains the header once the
 * line closes", › "still arms the block, even though neither disk-read
 * chunk contains the whole header on its own", › "still arms the block —
 * the header shape must be checked after stripping ANSI, not on the raw
 * segment", and › "closes the block on that same line, so a normal FAIL
 * line and the line after it are not swallowed".
 *
 * `normalize` (RP-323) is the same text transform the non-overLimit path in
 * `runCheck` applies before matching — `relativize(stripAnsi(...))` — passed
 * in rather than hard-coded, so this incremental scan sees a header shaped
 * only after cwd is stripped out of it exactly like the whole-line path
 * does; it defaults to `stripAnsi` alone so a caller that never relativizes
 * (none in this module) still gets ANSI/OSC stripped. See ›
 * "still arms the block — the over-limit incremental marker scan must
 * relativize before matching, the same as the per-line scan already does".
 * `relativizeCandidates` (RP-323 round 4) is forwarded the same way, to the
 * SAME `decideOpenHeaderCarry` call the `OPEN_HEADER_START` carry below
 * drives — see `pendingCandidateStatus`'s own comment, above — and defaults
 * to `[]` so a caller with no relativize step of its own (none in this
 * module) never needs to pass it. `OPEN_HEADER_START` (RP-323) additionally
 * carries an open (unterminated) BEGIN — or, since round 4, END — header's
 * own suffix forward across segments — see its own comment, above — in
 * place of the plain `OVERFLOW_TAIL_CHARS` tail, for exactly the case the
 * normal-length straddle tests above already cover for a line that never
 * goes over the per-line cap at all: see ›
 * "still arms the block, even though the line itself is over the 64 KiB
 * per-line cap".
 */
const makeLineFeeder = (
  onLine,
  { lineMaxBytes = LINE_MAX_BYTES, normalize = stripAnsi, relativizeCandidates = [] } = {},
) => {
  let pending = '';
  let pendingBytes = 0;
  let overLimit = false;
  let tail = '';
  let lastLineMarker = null;
  // RP-323 — the open (unterminated) BEGIN/END header's own NORMALIZED
  // suffix (`normalize(context + segment)`, never the raw bytes — see
  // `OPEN_HEADER_START`'s own comment) carried forward in place of `tail`,
  // once this line's evaluated text ends mid-header; `null` when this line
  // is not currently inside one.
  let openHeaderCarry = null;

  const resetLine = () => {
    pending = '';
    pendingBytes = 0;
    overLimit = false;
    tail = '';
    lastLineMarker = null;
    openHeaderCarry = null;
  };

  const appendSegment = (segment) => {
    if (segment.length > 0) {
      const context = openHeaderCarry !== null ? openHeaderCarry : tail;
      const evalText = normalize(context + segment);
      const beginIndex = lastMatchIndex(evalText, PRIVATE_KEY_HEADER_PATTERN_GLOBAL);
      const endIndex = lastMatchIndex(evalText, PRIVATE_KEY_END_PATTERN_GLOBAL);
      if (beginIndex !== -1 || endIndex !== -1) {
        lastLineMarker = beginIndex > endIndex ? 'begin' : 'end';
      }

      const decision = decideOpenHeaderCarry(evalText, relativizeCandidates);
      openHeaderCarry = decision.carry;
      if (decision.arm === 'begin') lastLineMarker = 'begin';

      tail = (tail + segment).slice(-OVERFLOW_TAIL_CHARS);
    }
    if (overLimit) return;
    pending += segment;
    pendingBytes += Buffer.byteLength(segment, 'utf8');
    if (pendingBytes > lineMaxBytes) {
      overLimit = true;
      pending = '';
      pendingBytes = 0;
    }
  };

  const closeLine = () => {
    if (overLimit) {
      onLine(`[redacted: line over ${lineMaxBytes} bytes]`, { overLimit: true, lastLineMarker });
    } else {
      onLine(pending, { overLimit: false, lastLineMarker });
    }
    resetLine();
  };

  return {
    feed(chunkText) {
      let start = 0;
      for (;;) {
        const newlineIndex = chunkText.indexOf('\n', start);
        if (newlineIndex === -1) {
          appendSegment(chunkText.slice(start));
          return;
        }
        appendSegment(chunkText.slice(start, newlineIndex));
        closeLine();
        start = newlineIndex + 1;
      }
    },
    flush() {
      if (overLimit || pending.length > 0) closeLine();
    },
  };
};

/**
 * Stream one capture file to `dest` (raw bytes, unmodified) and through
 * `onLine` (decoded, line by line) — a bounded chunk at a time, never the
 * whole file at once. See the module header for why the child's own output
 * is captured through a file rather than read live from a pipe. `normalize`
 * (RP-323) and `relativizeCandidates` (RP-323 round 4) are forwarded to
 * `makeLineFeeder` unchanged — see its own comment.
 */
const passThroughAndProcess = (filePath, dest, onLine, normalize, relativizeCandidates) =>
  new Promise((resolve, reject) => {
    const feeder = makeLineFeeder(onLine, { normalize, relativizeCandidates });
    const readStream = createReadStream(filePath);
    readStream.on('data', (chunk) => {
      dest.write(chunk);
      feeder.feed(chunk.toString('utf8'));
    });
    readStream.on('end', () => {
      feeder.flush();
      resolve();
    });
    readStream.on('error', reject);
  });

// --- win32 .cmd/.bat shims ---------------------------------------------------

/** `command` resolved through PATH using PATHEXT (win32 lookup rules), or `null`. */
const findOnPath = (command) => {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null;
  }
  const pathEnv = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const dirs = pathEnv.split(path.delimiter).filter((entry) => entry !== '');
  const hasExtension = path.extname(command) !== '';
  if (hasExtension) {
    for (const dir of dirs) {
      const candidate = path.join(dir, command);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
};

/** Whether `command` is, or PATH+PATHEXT resolves it to, a `.cmd`/`.bat` batch file — win32 only, else `null`. */
const resolveBatchFile = (command) => {
  if (!WIN32) return null;
  const directExtension = path.extname(command).toLowerCase();
  if (directExtension === '.exe' || directExtension === '.com') return null;
  if (directExtension === '.cmd' || directExtension === '.bat') {
    if (existsSync(command)) return command;
    return findOnPath(command);
  }
  if (directExtension !== '') return null;
  const resolved = findOnPath(command);
  if (!resolved) return null;
  const resolvedExtension = path.extname(resolved).toLowerCase();
  return resolvedExtension === '.cmd' || resolvedExtension === '.bat' ? resolved : null;
};

// The cmd.exe metacharacters this project escapes — see the module header's
// "Windows batch shims". `^` is itself in this class: cmd.exe reads it as
// its own escape character, so a caret that reaches the command line
// unescaped would swallow whatever follows it.
const CMD_META_CHARS = /([()%!^"<>&|])/g;

// A double quote, CR or LF embedded in an argument is exactly the shape a
// `cmd.exe /c "<command line>"` command line cannot be made unconditionally
// safe against by escaping alone: an embedded quote can terminate the
// caret-escaped token early regardless of how many caret passes precede it,
// and a raw CR/LF is cmd.exe's own command separator — no quoting survives
// it, because cmd.exe splits the command line into separate commands on a
// literal line break before caret-escaping is ever considered. Such an
// argument is refused BEFORE cmd.exe is ever spawned, rather than trusting
// an escape to hold — see `check-run.test.ts` (absent in a generated rig) ›
// "refuses `x"&<marker.cmd>` without ever running marker.cmd" and its two
// siblings.
const CMD_UNSAFE_ARG_PATTERN = /["\r\n]/;

/** Thrown by `spawnForCommand` to refuse an argument `escapeCmdArgument` cannot make safe — never actually spawns cmd.exe. */
class CmdArgumentRefusedError extends Error {
  constructor() {
    super(
      'check-run: refusing to spawn cmd.exe — an argument to this Windows .cmd/.bat command ' +
        'contains a double quote, CR or LF, which cannot be passed safely through cmd.exe',
    );
    this.code = 'CMD_ARG_REFUSED';
  }
}

/**
 * Quote-wrap an argument for a cmd.exe command line, then caret-escape cmd's
 * metacharacters TWICE. This is `cross-spawn`'s own shape for a
 * `%*`-forwarding batch shim (the ordinary form of an npm/pnpm-installed
 * `.cmd`): the shim's `%*` re-exposes the argument to a SECOND round of
 * cmd.exe parsing when it forwards it on to the program it wraps, and only
 * an argument escaped twice survives that second round unchanged — verified
 * against a real `.cmd` shim built exactly that way, plus a direct win32
 * probe this change was verified against, including `pnpm --version`
 * through a real `%*`-forwarding shim. See `check-run.test.ts` (absent in a generated rig)
 * › "a cmd.exe-routed argument with no quote/CR/LF still arrives literally
 * through the %* shim". The batch file's own resolved PATH is never an
 * argument and is never forwarded through `%*` a second time — it is
 * escaped by `escapeCmdBatchPath` below instead, which needs no quoting at
 * all (see its own comment for why a quoted PATH is unsafe here).
 */
const escapeCmdArgument = (value, doubleEscapeMetaChars = false) => {
  let arg = String(value);
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  arg = arg.replace(/(\\*)$/, '$1$1');
  arg = `"${arg}"`;
  arg = arg.replace(CMD_META_CHARS, '^$1');
  if (doubleEscapeMetaChars) arg = arg.replace(CMD_META_CHARS, '^$1');
  return arg;
};

// A double quote, CR or LF cannot appear in a Windows path at all — unlike an
// argument, which can carry one and needs `escapeCmdArgument`'s own
// quote-doubling step — so the batch file's own resolved PATH never needs
// that step. Besides cmd's bracket/percent/caret/quote/angle/amp/pipe set,
// this class also carries every OTHER character cmd.exe splits a command
// line's tokens on: `;`, `,`, `=`, and whitespace — ordinary ASCII space/tab
// alongside every character JS's `\s` matches — the `u` flag on
// `CMD_PATH_META_CHARS` changes nothing about what `\s` itself matches, with
// or without it: the Space_Separator set (U+00A0, U+1680, U+2000–U+200A,
// U+202F, U+205F, U+3000), the line terminators U+2028 and U+2029, and
// U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM) — plus `\u0085` (NEL), which `\s`
// does NOT cover and is listed separately below. Unlike an argument, this
// token is never wrapped in quotes: see `escapeCmdBatchPath`'s own comment
// for why.
const CMD_PATH_META_CHARS = /([()%!^"<>&|;,=\s\u0085])/gu;

/**
 * Caret-escape every cmd.exe metacharacter, plus every cmd.exe token
 * separator, in the batch file's own resolved, ABSOLUTE PATH — no
 * surrounding quotes.
 *
 * code-reviewer, reproduced on win32 (RP-290) — the PATH used to be quote-wrapped exactly like an
 * argument (`escapeCmdArgument`) and then have those very quotes
 * caret-escaped along with every other metacharacter (`^"…^"`, because `"`
 * is itself in `CMD_META_CHARS`); a caret-escaped quote is not a real quote
 * delimiter to cmd.exe, so it never suppressed cmd.exe's own word-splitting
 * on a SPACE, and a resolved PATH such as `C:\Program Files\nodejs\npm.cmd`
 * split into two command-line tokens — cmd.exe reported the first fragment
 * "is not recognized", and the checked command never ran, journalled `fail`
 * regardless of what it would have reported. A bare space is not one of
 * `CMD_META_CHARS`, so no amount of caret-escaping that set alone touches
 * it. Caret-escaping the space (and tab) directly removes the need for a
 * delimiter-suppressing quote in the first place: a caret suppresses
 * cmd.exe's special reading of the ONE character that follows it, whatever
 * that character is, independent of quoting — which is exactly what a real
 * quote delimiter stops being able to do once its own quote character is
 * itself caret-escaped. `%` and `!` are caret-escaped the same way an
 * argument's are, so a PATH segment such as `50%x` or `a!b` is not read as
 * an environment-variable or delayed-expansion reference either — proved
 * together with the space case on a real win32 host: see
 * `check-run.test.ts` (absent in a generated rig) › "a cmd.exe-routed batch
 * file whose own resolved PATH contains a space".
 *
 * security-scanner, reproduced on win32 (RP-290 post-cap) — `;`, `,`, `=`
 * and Unicode whitespace (e.g. U+00A0) are ALSO cmd.exe token separators,
 * exactly like the ASCII space above, and were not in this escape set: a
 * directory such as `tools,v2` split at the `,` into two tokens, cmd.exe ran
 * whatever the truncated first token happened to name (a planted sibling
 * `tools.cmd`), and the checked `lint.cmd` never ran at all — journalled
 * `pass` regardless. Caret alone cannot fix this for a RELATIVE token: cmd.exe
 * still receives the raw literal path with no case that widens it to the
 * caller's own `cwd`, so `spawnForCommand` resolves the batch file to an
 * absolute path with `path.resolve` before this function ever escapes it —
 * a relative token split at a separator is a truncated fragment of the wrong
 * base directory regardless of escaping, while an absolute path has no `cwd`
 * left to resolve against. See
 * `check-run.test.ts` (absent in a generated rig) › "a cmd.exe-routed batch
 * path containing a cmd token separator runs only the named file".
 */
const escapeCmdBatchPath = (value) => String(value).replace(CMD_PATH_META_CHARS, '^$1');

// security-scanner, reproduced on win32 at 585465a (RP-290) — U+180E
// (MONGOLIAN VOWEL SEPARATOR) is one of cmd.exe's own token separators
// (cmd.exe follows the C runtime's `iswspace`, whose Unicode "space"
// category is a moving target the win32 CRT decides, not something JS can
// enumerate reliably from ECMAScript's own `\s` — U+180E in particular WAS
// Unicode-whitespace and lost that property in Unicode 6.3, yet cmd.exe kept
// splitting on it) but is NOT matched by `CMD_PATH_META_CHARS`'s `\s`, so a
// batch path under `tools<U+180E>v2` still split into two cmd.exe tokens the
// same way the comma/semicolon/equals/NBSP cases above already did, and a
// planted sibling `tools.cmd` ran in the named file's place. Chasing this one
// character with another deny-list entry repeats the exact defect shape
// already fixed twice above, so the batch path is ALLOWLISTED instead
// (fail-closed): every character of the resolved, absolute path must be
// printable ASCII, a Unicode letter/mark/number, JS `\s`, or U+0085 (NEL) —
// anything else is refused BEFORE cmd.exe is ever spawned, journalled
// `spawn-error` with no `tail`, and neither the named file nor any decoy
// sibling ever runs. See `check-run.test.ts` (absent in a generated rig) ›
// "a cmd.exe-routed batch path containing a character outside the allowlist
// is refused before spawning" and, for the allowlist's own lower bound — an
// accented Latin letter or a Cyrillic letter must still reach the named file
// — › "a cmd.exe-routed batch path containing ordinary non-English letters
// is not refused by the allowlist". Documented trade-off (RP-295, RP-290
// review): this same allowlist also refuses ordinary, SAFE non-ASCII
// punctuation, not only an unsafe shape — a typographic apostrophe (as in
// "O’Brien") or full-width brackets (（）) are punctuation, not a letter, mark,
// number or whitespace, so a resolved batch PATH containing one is refused
// even though it poses no risk to cmd.exe.
const CMD_PATH_ALLOWED_CHAR = /^[ -~\p{L}\p{M}\p{N}\s\u0085]$/u;

/** The code point of the first character in `value` outside `CMD_PATH_ALLOWED_CHAR`, or `null` if every character is allowed. */
const findDisallowedCodePoint = (value) => {
  for (const character of String(value)) {
    if (!CMD_PATH_ALLOWED_CHAR.test(character)) return character.codePointAt(0);
  }
  return null;
};

/** Thrown by `spawnForCommand` to refuse a batch path `CMD_PATH_ALLOWED_CHAR` does not allow — never actually spawns cmd.exe. */
class CmdPathRefusedError extends Error {
  constructor(codePoint) {
    const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
    super(
      `check-run: refusing to spawn cmd.exe — this Windows .cmd/.bat command's own resolved ` +
        `path contains a character (U+${hex}) that cannot be passed safely through cmd.exe`,
    );
    this.code = 'CMD_PATH_REFUSED';
  }
}

/** Spawn `command` — routed through `cmd.exe` when it is a win32 batch shim, plain argv spawn otherwise. */
const spawnForCommand = (command, cwd, stdoutFd, stderrFd) => {
  const stdio = ['inherit', stdoutFd, stderrFd];
  const resolvedBatchFile = resolveBatchFile(command[0]);
  const batchFile = resolvedBatchFile ? path.resolve(cwd, resolvedBatchFile) : null;
  if (batchFile) {
    const disallowedCodePoint = findDisallowedCodePoint(batchFile);
    if (disallowedCodePoint !== null) {
      throw new CmdPathRefusedError(disallowedCodePoint);
    }
    const argv = [batchFile, ...command.slice(1)];
    if (argv.some((arg) => CMD_UNSAFE_ARG_PATTERN.test(String(arg)))) {
      throw new CmdArgumentRefusedError();
    }
    const shellCommand = argv
      .map((arg, index) => (index === 0 ? escapeCmdBatchPath(arg) : escapeCmdArgument(arg, true)))
      .join(' ');
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return spawn(comspec, ['/d', '/s', '/c', `"${shellCommand}"`], {
      cwd,
      stdio,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command[0], command.slice(1), {
    cwd,
    stdio,
    detached: !WIN32,
  });
};

// Resolved by ABSOLUTE path, not by PATH lookup of the bare `taskkill` name —
// a PATH that has been tampered with (an attacker-controlled directory ahead
// of `System32`) could otherwise substitute a different program for the one
// this process means to run with elevated intent (killing a whole process
// tree). `SystemRoot` is the OS's own environment variable for its install
// directory; `C:\Windows` is the fallback only an environment with that
// variable stripped would ever need.
const TASKKILL_PATH = WIN32
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  : null;

/** Kill the WHOLE process tree rooted at `child`, not only the direct child — see the module header. */
const killChildTree = (child) => {
  if (!child || !child.pid) return;
  if (WIN32) {
    try {
      spawnSync(TASKKILL_PATH, ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000 });
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

// Signals this process treats as "stop the check now" instead of Node's
// default action, which would tear THIS process down immediately — the
// `finally` cleanup below would never run, and the checked command (spawned
// `detached: true` on POSIX, its OWN process group, exactly so a `--timeout`
// kill can target its whole tree) would never see the signal at all, since a
// signal aimed only at this process's own pid does not propagate to a
// different process group on its own. See `check-run.test.ts` (absent in a generated rig)
// › "kills the checked command and removes its own capture files, rather
// than dying immediately and leaking both".
const POSIX_INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// SIGBREAK is win32's console-close/Ctrl-Break analogue to POSIX SIGINT;
// win32 has no SIGTERM/SIGHUP to catch.
const WIN32_INTERRUPT_SIGNALS = ['SIGINT', 'SIGBREAK'];
const INTERRUPT_SIGNALS = WIN32 ? WIN32_INTERRUPT_SIGNALS : POSIX_INTERRUPT_SIGNALS;

// The POSIX `128 + signal number` exit-code convention. SIGBREAK carries no
// POSIX number of its own; Node's own `os.constants.signals.SIGBREAK` (21) is
// reused so win32 follows the same formula rather than a second one.
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 };

const NOT_RECORDED_NOTICE =
  'check-run: the result was not recorded — no run directory (RIG_RUN_DIR) is declared\n';

/** Records one `check-result` event when `RIG_RUN_DIR` is declared, or prints the one-line notice explaining why not. */
const recordOrNotify = (data) => {
  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    process.stderr.write(NOT_RECORDED_NOTICE);
    return;
  }
  try {
    recordEvent({ runDir, kind: 'check-result', data, now: new Date().toISOString() });
  } catch (error) {
    process.stderr.write(`check-run: the result was NOT recorded — ${error.message}\n`);
  }
};

/** `realpathSync.native(cwd)`, or `null` when it cannot be resolved. */
const computeCwdReal = (cwd) => {
  try {
    return realpathSync.native(cwd);
  } catch {
    return null;
  }
};

// The macOS convention this project's own candidate list special-cases:
// `/var`, `/tmp` and `/etc` are themselves symlinks to `/private/var`,
// `/private/tmp` and `/private/etc` — so a cwd realpath already anchored
// under `/private/...` (what `computeCwdReal` returns there) may still be
// printed by a checked command using the OS's own short alias instead. This
// is a STRING rule over this process's own, already-computed `cwdReal` —
// never a new filesystem probe.
//
// security-scanner, reproduced on Linux (RP-290 round 3) — this used to be
// applied unconditionally, on any platform whose cwdReal happened to start
// with one of these prefixes. On Linux `/private/var` is an ordinary,
// unrelated directory — nothing makes it a symlink alias of `/var` the way
// macOS's own convention does — so stripping `/private` there manufactures a
// prefix candidate for a DIFFERENT directory, and a value genuinely anchored
// under a real `/private/var/...` tree would be misrelativized against
// `/var/...` instead. `buildPrefixCandidates` now only adds the stripped
// spelling when `DARWIN` is true, where the convention this block encodes
// actually holds.
const MACOS_PRIVATE_PREFIXES = ['/private/var/', '/private/tmp/', '/private/etc/'];

/**
 * The prefixes a recorded value's cwd-anchored portion may be spelled with —
 * built ONCE per check, from this process's OWN cwd and environment only,
 * never re-derived per line (module header's "Bounds") and never driven by
 * anything the checked command prints. `cwd` itself is always a candidate;
 * `cwdReal` (`realpathSync.native(cwd)`) adds a second spelling for the case
 * where cwd and its realpath are two on-disk names for the same directory
 * (see `check-run.test.ts`, absent in a generated rig, › "strips the prefix
 * when the runner prints the identity anchored to the REALPATH");
 * `process.env.PWD` is added only when ITS OWN realpath agrees with
 * `cwdReal` — an unrelated inherited PWD (the ordinary case for a process
 * that never `cd`-ed) must never leak in as a candidate, while a shell that
 * DID `cd` through a symlinked alias before invoking this script leaves
 * exactly that agreement, and only that agreement, behind; and, ONLY on
 * macOS (`DARWIN`) and only when `cwdReal` sits under its own `/private/var`,
 * `/private/tmp` or `/private/etc`, the same path with the leading
 * `/private` removed is added too (`MACOS_PRIVATE_PREFIXES` above — a string
 * rule, not a probe, and its own comment states why the platform gate
 * matters: the identical prefix names an unrelated, ordinary directory on
 * Linux). Every candidate is added with BOTH a `/` and a `\` trailing separator, because a
 * runner may print `<cwd>\...` even when cwd itself has no backslash in it at
 * all — see › "a backslash-separated identity under cwd is normalized to
 * forward slashes". Sorted longest first, so a more specific (often longer)
 * candidate is tried before a shorter one that could otherwise match as a
 * false partial prefix.
 *
 * This still misses an alias `process.cwd()`/`PWD`/the macOS convention
 * never carried — e.g. a checked command that reports a *different*
 * symlinked name for the same directory than any of the above. RP-290
 * review round 2 removed the fs-based ancestor walk this module used to fall
 * back to for that case (`resolveAliasedPath`, now deleted): it drove
 * `existsSync`/`realpathSync.native` calls off the checked command's own
 * output, which a UNC-looking alias turned into a real SMB/NTLM connection
 * attempt on Windows and a very deep path turned into unbounded per-segment
 * work. Such an alias now stays absolute, exactly as printed, as a stated
 * limit — see › "keeps an identity printed under an arbitrary symlink alias
 * of cwd absolute — resolving it would take filesystem probes driven by
 * runner output".
 */
const buildPrefixCandidates = (cwd, cwdReal) => {
  const bases = new Set([cwd]);
  if (cwdReal !== null) {
    bases.add(cwdReal);
    if (DARWIN) {
      for (const privatePrefix of MACOS_PRIVATE_PREFIXES) {
        if (cwdReal.startsWith(privatePrefix)) {
          bases.add(cwdReal.slice('/private'.length));
        }
      }
    }
  }
  const pwd = process.env.PWD;
  if (pwd && cwdReal !== null) {
    try {
      if (realpathSync.native(pwd) === cwdReal) bases.add(pwd);
    } catch {
      // an unresolvable PWD is never trusted as a candidate
    }
  }
  const prefixes = new Set();
  for (const base of bases) {
    prefixes.add(base.endsWith('/') ? base : `${base}/`);
    prefixes.add(base.endsWith('\\') ? base : `${base}\\`);
  }
  return [...prefixes].sort((a, b) => b.length - a.length);
};

/**
 * Converts backslashes to forward slashes in the PATH portion only (before
 * the first ` > `) of an already-relativized failing-test identity —
 * unconditionally, whether or not `relativize` (above, in `runCheck`)
 * actually stripped a candidate prefix from this particular id — never
 * applied to the tail or log text, which stay exactly what the runner
 * printed. See `check-run.test.ts` (absent in a generated rig) › "a
 * backslash-separated identity under cwd is normalized to forward slashes"
 * and, for the unconditional case — an id that is neither stripped nor
 * otherwise resolved — › "does not touch the filesystem for a
 * backslash-form UNC-looking failing-test path (win32)".
 */
const normalizeFailedTestId = (id) => {
  const sepIndex = id.indexOf(' > ');
  const pathPart = sepIndex === -1 ? id : id.slice(0, sepIndex);
  const rest = sepIndex === -1 ? '' : id.slice(sepIndex);
  return `${pathPart.split('\\').join('/')}${rest}`;
};

const runCheck = async ({ name, timeoutSeconds, command }) => {
  const cwd = process.cwd();
  const cwdReal = computeCwdReal(cwd);
  const prefixCandidates = buildPrefixCandidates(cwd, cwdReal);
  // Stops at the first matching prefix candidate, not every one of them
  // (RP-295, RP-290 review): a value carrying TWO differently-spelled
  // absolute forms of cwd on the same line (e.g. the raw cwd and its
  // realpath, both prefix candidates) has only the FIRST form found
  // stripped — the other survives absolute in the recorded value.
  const relativize = (value) => {
    for (const prefix of prefixCandidates) {
      if (value.includes(prefix)) return value.split(prefix).join('');
    }
    return value;
  };

  const commandRaw = relativize(command.join(' '));
  const commandField = findSecretValues(commandRaw).length > 0 ? REDACTED_LINE : commandRaw;

  const logBuffer = new CappedBuffer(LOG_MAX_BYTES);
  const tailLines = [];
  const failedTests = [];

  /** One `processLine` per stream, each with its OWN "inside a PEM block" state. */
  const makeProcessLine = () => {
    let inPemBlock = false;
    return (rawLine, meta) => {
      const overLimit = Boolean(meta && meta.overLimit);
      let finalLine;
      let lineMarker;
      if (overLimit) {
        // The line text itself is already the fixed `[redacted: line over …
        // bytes]` marker — `LINE_MAX_BYTES` applies ahead of and independent
        // from this PEM/credential logic (module header's "Bounds"), so there
        // is no raw body left to scan here; only the state-machine transition
        // below still applies to this line — taken from `makeLineFeeder`'s own
        // incremental, chunk-bounded `lastLineMarker` (RP-295 gate round 3,
        // security-scanner): re-scanning an over-limit line's full raw text
        // here would be exactly the unbounded-per-line work `invariants.md`'s
        // bounded-work rule refuses, which is why the incremental, small-tail
        // tracking below exists in the first place.
        finalLine = rawLine;
        lineMarker = meta && meta.lastLineMarker;
      } else {
        // A BEGIN header appearing anywhere in this line is caught by
        // `findSecretValues` on its own (the header IS a credential shape,
        // `lib/secrets.mjs`'s `private-key-block` pattern) — this line does
        // not need its own separate "does it contain a BEGIN" check the way
        // the state-machine transition below does.
        const relativized = relativize(stripAnsi(rawLine));
        finalLine = inPemBlock
          ? REDACTED_LINE
          : findSecretValues(relativized).length > 0
            ? REDACTED_LINE
            : relativized;
        // RP-295 gate round 3 (security-scanner, regression vs base a4d55a8)
        // — a line under `LINE_MAX_BYTES` is already held WHOLE, in
        // `rawLine`/`relativized` above, so the marker transition for such a
        // line is taken from ONE scan of the WHOLE line — exactly what base
        // a4d55a8 did — never from `makeLineFeeder`'s incremental,
        // `OVERFLOW_TAIL_CHARS`-bounded `lastLineMarker`. That incremental
        // tracking exists to bound an OVER-LIMIT line's per-chunk cost (kept
        // for the `overLimit` branch above); applied here too, its small
        // rolling tail could push a long-padded header's own `-----BEGIN `
        // prefix out of view before the segment carrying the rest of the
        // padding (and `PRIVATE KEY-----`) ever arrived, on a line that never
        // comes anywhere near the 64 KiB cap that incremental tracking is
        // for. Bounded exactly like `findSecretValues` just above it: one
        // scan of at most `LINE_MAX_BYTES` characters. See
        // `check-run.test.ts` (absent in a generated rig) › "a long-padded
        // BEGIN header straddles the 64 KiB read-chunk boundary on a
        // NORMAL-length line".
        const beginIndex = lastMatchIndex(relativized, PRIVATE_KEY_HEADER_PATTERN_GLOBAL);
        const endIndex = lastMatchIndex(relativized, PRIVATE_KEY_END_PATTERN_GLOBAL);
        lineMarker =
          beginIndex === -1 && endIndex === -1 ? null : beginIndex > endIndex ? 'begin' : 'end';
      }

      // RP-295 gate round 2 (reviewer, reproduced on head a861085) — armed
      // after this line iff the LAST marker found for it (whole-line for a
      // normal-length line, above; `makeLineFeeder`'s incremental,
      // chunk-boundary- and ANSI-safe tracking for an over-limit one, per its
      // own comment above `makeLineFeeder`) was a BEGIN; a line with no
      // marker at all leaves `inPemBlock` exactly as it was entering the
      // line. This single check replaces what used to be two separate,
      // narrower ones — a whole-line scan for the non-overLimit branch, and a
      // small-rolling-`tail`-plus-`sawBeginHeader` fallback for the overLimit
      // one — neither of which saw a marker split across a chunk boundary, an
      // ANSI-interleaved header, or a complete BEGIN..END pair pushed out of
      // a small tail by later filler on the same over-limit line. See
      // `check-run.test.ts` (absent in a generated rig) › "keeps the block
      // armed for the second key body when END and a new BEGIN sit on the
      // SAME line", its over-limit variant, "still arms the block, even
      // though neither disk-read chunk contains the whole header on its
      // own", "still arms the block — the header shape must be checked after
      // stripping ANSI, not on the raw segment", and "closes the block on
      // that same line, so a normal FAIL line and the line after it are not
      // swallowed".
      if (lineMarker === 'begin') inPemBlock = true;
      else if (lineMarker === 'end') inPemBlock = false;

      logBuffer.push(`${finalLine}\n`);
      tailLines.push(finalLine);
      if (tailLines.length > TAIL_MAX_LINES) tailLines.shift();

      if (failedTests.length < FAILED_TESTS_MAX) {
        const id = extractFailedTestId(finalLine);
        if (id !== null) {
          const normalizedId = normalizeFailedTestId(id);
          // RP-295, item E (first half) — cut to the 300-character cap FIRST,
          // then trim: trimming the full identity before this cut (the old
          // order) can leave the STORED entry ending in whitespace whenever
          // the cut itself lands on interior whitespace the earlier trim
          // never touched.
          const cut =
            normalizedId.length > FAILED_TEST_MAX_CHARS
              ? normalizedId.slice(0, FAILED_TEST_MAX_CHARS)
              : normalizedId;
          failedTests.push(cut.trimEnd());
        }
      }
    };
  };

  const captureId = `check-run-${process.pid}-${randomBytes(6).toString('hex')}`;
  const stdoutCapturePath = path.join(tmpdir(), `${captureId}-stdout.tmp`);
  const stderrCapturePath = path.join(tmpdir(), `${captureId}-stderr.tmp`);

  let stdoutFd = null;
  let stderrFd = null;
  let exitCode = null;
  let signal = null;
  let spawnError = null;
  let timedOut = false;

  // RP-295 (RP-290 review follow-up, item B) — hoisted out of the `if
  // (child)` block below so the OUTER `finally` can remove these handlers
  // only once the capture files are actually gone. Installed for the
  // duration of the child's run AND the read-back that follows it (below,
  // and inside `onInterrupt` itself) — never removed while there is still
  // an unlinked capture file a SIGINT/SIGTERM could leave behind.
  let interruptHandlers = [];
  const removeInterruptHandlers = () => {
    for (const [signalName, handler] of interruptHandlers) {
      process.removeListener(signalName, handler);
    }
    interruptHandlers = [];
  };

  try {
    stdoutFd = openSync(stdoutCapturePath, 'wx', 0o600);
    stderrFd = openSync(stderrCapturePath, 'wx', 0o600);

    let child = null;
    try {
      child = spawnForCommand(command, cwd, stdoutFd, stderrFd);
    } catch (error) {
      spawnError = error;
    }

    if (child) {
      let timer = null;
      if (timeoutSeconds !== null) {
        timer = setTimeout(() => {
          timedOut = true;
          killChildTree(child);
        }, timeoutSeconds * 1000);
      }

      const onInterrupt = (signalName) => {
        removeInterruptHandlers();
        if (timer) clearTimeout(timer);
        killChildTree(child);
        for (const fd of [stdoutFd, stderrFd]) {
          if (fd !== null) {
            try {
              closeSync(fd);
            } catch {
              // Already closed or never opened.
            }
          }
        }
        stdoutFd = null;
        stderrFd = null;
        for (const capturePath of [stdoutCapturePath, stderrCapturePath]) {
          try {
            unlinkSync(capturePath);
          } catch {
            // Best-effort: a leftover temp file here is harmless — its name
            // is unique and nothing else ever reads it.
          }
        }
        process.exit(SIGNAL_EXIT_CODES[signalName] ?? 1);
      };
      interruptHandlers = INTERRUPT_SIGNALS.map((signalName) => {
        const handler = () => onInterrupt(signalName);
        process.on(signalName, handler);
        return [signalName, handler];
      });

      [exitCode, signal, spawnError] = await new Promise((resolve) => {
        child.on('error', (error) => {
          resolve([null, null, error]);
        });
        child.on('close', (code, sig) => {
          resolve([code, sig, null]);
        });
      });
      if (timer) clearTimeout(timer);
      // RP-295, item B — NOT removed here. The child has closed, but the two
      // capture files still exist and are read back below; a signal landing
      // in that window must still hit `onInterrupt` so it removes them. See
      // the outer `finally`, where these handlers are actually torn down.
    }

    if (stdoutFd !== null) {
      closeSync(stdoutFd);
      stdoutFd = null;
    }
    if (stderrFd !== null) {
      closeSync(stderrFd);
      stderrFd = null;
    }

    if (!spawnError) {
      // RP-323 — the SAME normalisation the non-overLimit branch below
      // applies (`relativize(stripAnsi(...))`) is handed to the over-limit
      // incremental scan too, so a header shaped only after cwd is
      // relativized out of it is not missed on that path either.
      const normalizeForLineFeeder = (text) => relativize(stripAnsi(text));
      // RP-323 round 4 — the SAME candidates `relativize` itself tries
      // (above) are handed to the incremental scan too, so a marker prefix
      // immediately followed by one of them, still arriving, is recognised
      // by `decideOpenHeaderCarry` the same way `relativize` would resolve
      // it once it is complete. See `pendingCandidateStatus`'s own comment.
      await passThroughAndProcess(
        stdoutCapturePath,
        process.stdout,
        makeProcessLine(),
        normalizeForLineFeeder,
        prefixCandidates,
      );
      await passThroughAndProcess(
        stderrCapturePath,
        process.stderr,
        makeProcessLine(),
        normalizeForLineFeeder,
        prefixCandidates,
      );
    }
  } finally {
    if (stdoutFd !== null) {
      try {
        closeSync(stdoutFd);
      } catch {
        // Already closed or never opened.
      }
    }
    if (stderrFd !== null) {
      try {
        closeSync(stderrFd);
      } catch {
        // Already closed or never opened.
      }
    }
    for (const capturePath of [stdoutCapturePath, stderrCapturePath]) {
      try {
        unlinkSync(capturePath);
      } catch {
        // Best-effort: a leftover temp file here is harmless — its name is
        // unique and nothing else ever reads it.
      }
    }
    // RP-295, item B — torn down LAST, once both capture files are actually
    // gone: a signal delivered any time before this line still reaches
    // `onInterrupt` and removes them itself; nothing after this point still
    // needs interrupting.
    removeInterruptHandlers();
  }

  if (spawnError) {
    const code = spawnError.code === 'ENOENT' ? 127 : 1;
    // A refused cmd.exe argument or batch path already carries its own full
    // explanation (and the word "cmd.exe" a fresh reader can search for) —
    // the generic "spawn failed … — <code>" line would only repeat it as a
    // bare code.
    process.stderr.write(
      spawnError.code === 'CMD_ARG_REFUSED' || spawnError.code === 'CMD_PATH_REFUSED'
        ? `${spawnError.message}\n`
        : `check-run: spawn failed for check "${name}" — ${spawnError.code ?? 'unknown error'}\n`,
    );
    recordOrNotify({
      schema: 1,
      name,
      command: commandField,
      outcome: 'spawn-error',
      exitCode: code,
      signal: null,
      timedOut: false,
      failedTests: [],
    });
    return code;
  }

  const outcome = exitCode === 0 && signal === null && !timedOut ? 'pass' : 'fail';

  const data = {
    schema: 1,
    name,
    command: commandField,
    outcome,
    exitCode,
    signal,
    timedOut,
    failedTests,
  };

  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    process.stderr.write(NOT_RECORDED_NOTICE);
    return exitCode !== null ? exitCode : 1;
  }

  try {
    const safeName = name.replace(/[^A-Za-z0-9_.-]+/g, '-');
    const logFileName = `${safeName}-${Date.now()}-${randomBytes(3).toString('hex')}.log`;
    mkdirSync(path.join(runDir, 'checks'), { recursive: true });
    writeFileSync(path.join(runDir, 'checks', logFileName), logBuffer.finalize());
    data.log = `checks/${logFileName}`;
    if (outcome === 'fail') data.tail = buildTail(tailLines);
    recordOrNotify(data);
  } catch (error) {
    process.stderr.write(`check-run: the result was NOT recorded — ${error.message}\n`);
  }

  return exitCode !== null ? exitCode : 1;
};

/** Was this file invoked directly? Compared by REALPATH on both sides — same shape every CLI sibling uses. */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  process.exitCode = await runCheck(parsed);
}
