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
// tail on failure, and the path to a bounded full log on disk:
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
//     recognizable failure-shaped line".
//
// --- Redaction and normalisation -------------------------------------------
//
// Every line is processed once, in this order, before it ever reaches the
// tail, the log, or a `failedTests` entry: ANSI escape codes are stripped (›
// "strips ANSI escape codes from the identity and the tail"); an absolute
// path under this process's own cwd is rewritten repo-relative (› "converts
// an absolute path to the repo root inside a test identity into a
// repo-relative one"); a PER-STREAM state machine tracks whether the line
// sits inside a PEM private-key block — a line matching
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
// moment an operator hits Ctrl-C on a required check. So, for the duration of
// the child's run only, this process installs its own handler for those
// three signals on POSIX (`SIGINT`/`SIGBREAK` on win32, which has no
// SIGTERM/SIGHUP to catch) that does exactly what a timeout does — kill the
// child's whole tree — plus closes and removes this run's own capture files,
// removes the handlers, and exits with the POSIX `128 + signal number`
// convention. See › "kills the checked command and removes its own capture
// files, rather than dying immediately and leaking both" (POSIX-only — there
// is no Windows equivalent of a signal delivered to a single pid rather than
// its process group to measure).
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

// eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const stripAnsi = (text) => text.replace(ANSI_PATTERN, '');

const FAIL_PATTERN = /^\s*FAIL\s+(.+?)\s*$/;
const BULLET_PATTERN = /^\s*[×✗]\s+(.+?)\s*$/;
const TAP_PATTERN = /^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/;

// The BEGIN-line shape a private-key block starts with — reused from
// `lib/secrets.mjs`'s own vocabulary, never a hand-copied second pattern.
const PRIVATE_KEY_HEADER_PATTERN = SECRET_VALUE_PATTERNS.find(
  (entry) => entry.id === 'private-key-block',
).pattern;
// The matching END line. Not part of `lib/secrets.mjs`'s credential
// vocabulary — it names no secret by itself — so it stays local to the one
// state machine that needs it.
const PRIVATE_KEY_END_PATTERN = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** A failing test identity from one already-processed line, or `null`. */
const extractFailedTestId = (line) => {
  const fail = FAIL_PATTERN.exec(line);
  if (fail) return fail[1];
  const bullet = BULLET_PATTERN.exec(line);
  if (bullet) return bullet[1];
  const tap = TAP_PATTERN.exec(line);
  if (tap) return tap[1];
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
// already gone over it. It is what lets a BEGIN header sitting at the very
// END of an over-long line still be seen once the line closes — see
// `check-run.test.ts` (absent in a generated rig) › "still redacts the body
// and END line that follow it, while a line after END survives" — without
// holding the whole discarded line: `tail` is re-sliced to this many
// characters on every append, so its own cost is O(1) per chunk, not O(line
// length).
const OVERFLOW_TAIL_CHARS = 256;

/**
 * A streaming line splitter: feed chunks, get complete lines as they close.
 * Bounded per the module header — at most `LINE_MAX_BYTES` of a PENDING
 * (not-yet-terminated) line is ever held; a chunk is scanned once with
 * `indexOf`, never by re-splitting the whole accumulated buffer, so the cost
 * is linear in the input rather than quadratic. `onLine` is called with the
 * finalized line text and a `{ overLimit, tail }` record — `tail` is the last
 * `OVERFLOW_TAIL_CHARS` characters of the line'S OWN RAW CONTENT, kept even
 * when `overLimit` is true and the line text itself has already been replaced
 * by the fixed marker, precisely so a caller can still check what the
 * discarded END of an over-long line looked like (see `OVERFLOW_TAIL_CHARS`
 * above) without this feeder knowing anything about PEM blocks or secrets
 * itself.
 */
const makeLineFeeder = (onLine, lineMaxBytes = LINE_MAX_BYTES) => {
  let pending = '';
  let pendingBytes = 0;
  let overLimit = false;
  let tail = '';

  const resetLine = () => {
    pending = '';
    pendingBytes = 0;
    overLimit = false;
    tail = '';
  };

  const appendSegment = (segment) => {
    if (segment.length > 0) tail = (tail + segment).slice(-OVERFLOW_TAIL_CHARS);
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
      onLine(`[redacted: line over ${lineMaxBytes} bytes]`, { overLimit: true, tail });
    } else {
      onLine(pending, { overLimit: false, tail });
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
 * is captured through a file rather than read live from a pipe.
 */
const passThroughAndProcess = (filePath, dest, onLine) =>
  new Promise((resolve, reject) => {
    const feeder = makeLineFeeder(onLine);
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
// that step. `\t`/` ` are added to the metacharacter class below because,
// unlike an argument, this token is never wrapped in quotes: see
// `escapeCmdBatchPath`'s own comment for why.
const CMD_PATH_META_CHARS = /([()%!^"<>&|\t ])/g;

/**
 * Caret-escape every cmd.exe metacharacter, plus space and tab, in the batch
 * file's own resolved PATH — no surrounding quotes.
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
 */
const escapeCmdBatchPath = (value) => String(value).replace(CMD_PATH_META_CHARS, '^$1');

/** Spawn `command` — routed through `cmd.exe` when it is a win32 batch shim, plain argv spawn otherwise. */
const spawnForCommand = (command, cwd, stdoutFd, stderrFd) => {
  const stdio = ['inherit', stdoutFd, stderrFd];
  const batchFile = resolveBatchFile(command[0]);
  if (batchFile) {
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

const runCheck = async ({ name, timeoutSeconds, command }) => {
  const cwd = process.cwd();
  const repoPrefix = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
  const relativize = (value) => (value.includes(repoPrefix) ? value.split(repoPrefix).join('') : value);

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
      if (overLimit) {
        // The line text itself is already the fixed `[redacted: line over …
        // bytes]` marker — `LINE_MAX_BYTES` applies ahead of and independent
        // from this PEM/credential logic (module header's "Bounds"), so there
        // is no raw body left to scan here. Only the feeder's small rolling
        // `tail` (the line's own last `OVERFLOW_TAIL_CHARS` characters, kept
        // even though the line overflowed) is inspected, so a BEGIN or END
        // header sitting at the very end of an over-long line still updates
        // the state machine — see › "still redacts the body and END line
        // that follow it, while a line after END survives".
        finalLine = rawLine;
        const tailText = stripAnsi(meta.tail ?? '');
        if (inPemBlock) {
          if (PRIVATE_KEY_END_PATTERN.test(tailText)) inPemBlock = false;
        } else if (PRIVATE_KEY_HEADER_PATTERN.test(tailText)) {
          inPemBlock = !PRIVATE_KEY_END_PATTERN.test(tailText);
        }
      } else {
        const relativized = relativize(stripAnsi(rawLine));
        if (inPemBlock) {
          finalLine = REDACTED_LINE;
          if (PRIVATE_KEY_END_PATTERN.test(relativized)) inPemBlock = false;
        } else if (PRIVATE_KEY_HEADER_PATTERN.test(relativized)) {
          finalLine = REDACTED_LINE;
          // A line whose BEGIN and END markers both sit on the SAME line
          // must not leave the block armed for the lines that follow — see ›
          // "redacts the one-line key, and does not swallow the FAIL
          // identity on the line that follows it".
          inPemBlock = !PRIVATE_KEY_END_PATTERN.test(relativized);
        } else {
          finalLine = findSecretValues(relativized).length > 0 ? REDACTED_LINE : relativized;
        }
      }

      logBuffer.push(`${finalLine}\n`);
      tailLines.push(finalLine);
      if (tailLines.length > TAIL_MAX_LINES) tailLines.shift();

      if (failedTests.length < FAILED_TESTS_MAX) {
        const id = extractFailedTestId(finalLine);
        if (id !== null) {
          failedTests.push(id.length > FAILED_TEST_MAX_CHARS ? id.slice(0, FAILED_TEST_MAX_CHARS) : id);
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

      // Install for the duration of the child's run only, and removed on
      // every exit from it (below, and inside the handler itself) — never
      // left registered once there is nothing left to interrupt.
      let interruptHandlers = [];
      const removeInterruptHandlers = () => {
        for (const [signalName, handler] of interruptHandlers) {
          process.removeListener(signalName, handler);
        }
        interruptHandlers = [];
      };
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
        child.on('error', (error) => resolve([null, null, error]));
        child.on('close', (code, sig) => resolve([code, sig, null]));
      });
      if (timer) clearTimeout(timer);
      removeInterruptHandlers();
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
      await passThroughAndProcess(stdoutCapturePath, process.stdout, makeProcessLine());
      await passThroughAndProcess(stderrCapturePath, process.stderr, makeProcessLine());
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
  }

  if (spawnError) {
    const code = spawnError.code === 'ENOENT' ? 127 : 1;
    // A refused cmd.exe argument already carries its own full explanation
    // (and the word "cmd.exe" a fresh reader can search for) — the generic
    // "spawn failed … — <code>" line would only repeat it as a bare code.
    process.stderr.write(
      spawnError.code === 'CMD_ARG_REFUSED'
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
