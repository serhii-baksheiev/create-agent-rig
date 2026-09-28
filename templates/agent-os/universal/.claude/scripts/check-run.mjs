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
// reaches the child literally. With `RIG_RUN_DIR` undeclared, the check still
// runs and exits the same way; nothing is written, and exactly one stderr
// line says why. Without `--timeout`, the child runs to completion; with it,
// a hung child is killed and the record still reports `timedOut: true`.
//
// The child's stdout/stderr are captured through a real FILE, not a pipe:
// Node writes to a pipe asynchronously on POSIX, and a check that calls
// `process.exit()` right after a burst of writes (an ordinary shape for a
// test runner's own summary line) can lose the still-queued tail of its own
// output before this process would ever see it — a real file is written
// synchronously instead, so nothing is lost to that race. This process reads
// the file back once the child has closed and streams it — to the caller's
// own stdout/stderr, and through the pipeline below — a bounded chunk at a
// time, never loading the whole thing into memory at once.
//
// --- Bounds ---------------------------------------------------------------
//
// Every one of these is a cap, never a hope, per `.claude/rules/
// invariants.md`'s bounded-work rule ("can any input make it do unbounded
// work at all" — not "is it fast enough on realistic input"):
//
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
//     processed lines — never a rescan of the whole output — same test;
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
// repo-relative one"); then the line is checked for a credential shape with
// `lib/secrets.mjs`'s `findSecretValues` — reused verbatim, never a second
// copy of the vocabulary (`invariants.md`: "one mechanism, one
// implementation") — and a line that matches is replaced WHOLE by
// `[redacted]`, never partially, the same whole-unit rule `continuation.mjs`
// uses and for the same reason (a per-pattern partial replace is where a
// redacter leaks). The recorded `command` field goes through the same
// path-relativise-then-redact pass. See › "redacts a credential-shaped value
// out of the tail, while the assertion and identity survive", › "redacts a
// credential-shaped value out of the recorded command field", › "never
// leaves a credential-shaped value in the log file on disk", and › "redacts
// a credential-shaped value embedded inside a failing test identity" — the
// last of these loses the whole identity along with the credential, because
// the line that carried it no longer reads as a failure-summary line once
// redacted; this is the accepted, safe-direction cost.
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
import { spawn } from 'node:child_process';
import {
  closeSync,
  createReadStream,
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
import { findSecretValues } from './lib/secrets.mjs';

const REDACTED_LINE = '[redacted]';
const TAIL_MAX_LINES = 60;
const TAIL_MAX_BYTES = 8192;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const FAILED_TESTS_MAX = 50;
const FAILED_TEST_MAX_CHARS = 300;

// eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const stripAnsi = (text) => text.replace(ANSI_PATTERN, '');

const FAIL_PATTERN = /^\s*FAIL\s+(.+?)\s*$/;
const BULLET_PATTERN = /^\s*[×✗]\s+(.+?)\s*$/;
const TAP_PATTERN = /^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/;

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

/** Last-60-lines window, then trimmed to `TAIL_MAX_BYTES`, keeping the END. */
const buildTail = (lines) => {
  const kept = lines.slice();
  let joined = kept.join('\n');
  while (kept.length > 0 && Buffer.byteLength(joined, 'utf8') > TAIL_MAX_BYTES) {
    kept.shift();
    joined = kept.join('\n');
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

/** A streaming line splitter: feed chunks, get complete lines as they close. */
const makeLineFeeder = (onLine) => {
  let pending = '';
  return {
    feed(chunkText) {
      pending += chunkText;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (pending.length > 0) {
        onLine(pending);
        pending = '';
      }
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

const runCheck = async ({ name, timeoutSeconds, command }) => {
  const cwd = process.cwd();
  const repoPrefix = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
  const relativize = (value) => (value.includes(repoPrefix) ? value.split(repoPrefix).join('') : value);

  const logBuffer = new CappedBuffer(LOG_MAX_BYTES);
  const tailLines = [];
  const failedTests = [];

  const processLine = (rawLine) => {
    const relativized = relativize(stripAnsi(rawLine));
    const finalLine = findSecretValues(relativized).length > 0 ? REDACTED_LINE : relativized;

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

  const captureId = `check-run-${process.pid}-${randomBytes(6).toString('hex')}`;
  const stdoutCapturePath = path.join(tmpdir(), `${captureId}-stdout.tmp`);
  const stderrCapturePath = path.join(tmpdir(), `${captureId}-stderr.tmp`);
  const stdoutFd = openSync(stdoutCapturePath, 'w');
  const stderrFd = openSync(stderrCapturePath, 'w');

  const child = spawn(command[0], command.slice(1), {
    cwd,
    stdio: ['inherit', stdoutFd, stderrFd],
  });

  let timedOut = false;
  let timer = null;
  if (timeoutSeconds !== null) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
  }

  const [exitCode, signal] = await new Promise((resolve) => {
    child.on('close', (code, sig) => resolve([code, sig]));
    child.on('error', () => resolve([1, null]));
  });
  if (timer) clearTimeout(timer);

  closeSync(stdoutFd);
  closeSync(stderrFd);

  await passThroughAndProcess(stdoutCapturePath, process.stdout, processLine);
  await passThroughAndProcess(stderrCapturePath, process.stderr, processLine);

  for (const capturePath of [stdoutCapturePath, stderrCapturePath]) {
    try {
      unlinkSync(capturePath);
    } catch {
      // Best-effort: a leftover temp file here is harmless — its name is
      // unique and nothing else ever reads it.
    }
  }

  const outcome = exitCode === 0 && signal === null && !timedOut ? 'pass' : 'fail';
  const commandRaw = relativize(command.join(' '));
  const commandField = findSecretValues(commandRaw).length > 0 ? REDACTED_LINE : commandRaw;

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
  if (runDir) {
    try {
      const safeName = name.replace(/[^A-Za-z0-9_.-]+/g, '-');
      const logFileName = `${safeName}-${Date.now()}-${randomBytes(3).toString('hex')}.log`;
      mkdirSync(path.join(runDir, 'checks'), { recursive: true });
      writeFileSync(path.join(runDir, 'checks', logFileName), logBuffer.finalize());
      data.log = `checks/${logFileName}`;
      if (outcome === 'fail') data.tail = buildTail(tailLines);
      recordEvent({ runDir, kind: 'check-result', data, now: new Date().toISOString() });
    } catch (error) {
      process.stderr.write(`check-run: the result was NOT recorded — ${error.message}\n`);
    }
  } else {
    process.stderr.write(
      'check-run: the result was not recorded — no run directory (RIG_RUN_DIR) is declared\n',
    );
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
