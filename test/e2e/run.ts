import { execFile } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * RP-70: the two e2e suites that install through `npx` let `execFile`'s
 * rejection reach vitest untouched, and Node's message for that is only
 * `Command failed: <the whole command line>`. The child's own output — the one
 * thing that says *why* — rides along on the error object and was thrown away.
 *
 * That is what made the `e2e` failure on PR #162 head `6bccbb17` undiagnosable:
 * the log carried the command and nothing else, so telling an install-step
 * failure apart from a real generation defect took a local reproduction plus a
 * duration comparison plus checking the sibling pack path by hand.
 *
 * ⚠ These helpers make a failure *readable*. They do not make it pass, retry
 * it, or soften it: a command that did not complete is still a failed test —
 * `test/template/e2e-run-report.test.ts` › "says the command did not complete,
 * so it is not read as a bad generated project".
 */

/** Node's `execFile` rejection. Every field is optional — it is not a contract. */
type ExecFailure = {
  code?: number | string;
  signal?: NodeJS.Signals | string;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
};

/**
 * How much of each stream, and of each debug log, the report keeps. A failing
 * install can emit far more than anyone reads, and the reason is at the END of
 * it — so the tail is what survives, and the report says how much it dropped.
 */
export const OUTPUT_TAIL = 4000;

/** How many of an `_logs` directory's files the report will read. Bounded on purpose. */
export const MAX_DEBUG_LOGS = 4;

const asText = (value: string | Buffer | undefined): string =>
  typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';

/**
 * Credentials embedded in a URL, masked.
 *
 * Measured on npm 11.3.0 by `security-scanner` on this change: a registry
 * configured as `https://user:password@host` is written **unredacted** into the
 * debug log on its `silly packumentCache` and `http fetch GET` lines — npm
 * masks it only on `verbose stack` and `error network`. Since this report is
 * printed into a CI log, it closes that gap itself rather than trusting npm's.
 *
 * Not reachable on this repository's CI (no secrets, no `registry-url`, no
 * tracked `.npmrc`); it is reachable on a developer machine or self-hosted
 * runner whose npmrc embeds credentials in a registry URL, which is the whole
 * reason it is here. `.claude/scripts/lib/secrets.mjs` names this exact shape
 * as one its vocabulary cannot see.
 *
 * One pass, no backtracking: both character classes are negated and bounded.
 */
export const redactUrlCredentials = (text: string): string =>
  text.replace(/(\/\/[^\s/:@]+):[^\s/@]+@/g, '$1:***@');

const tail = (stream: string): string => {
  if (stream.length <= OUTPUT_TAIL) return stream;
  const dropped = stream.length - OUTPUT_TAIL;
  return `… [${dropped} earlier characters truncated] …\n${stream.slice(-OUTPUT_TAIL)}`;
};

/**
 * A labelled block, verbatim.
 *
 * 🔴 It does **not** truncate. An earlier version did, and because the debug
 * logs arrive already tailed and joined newest-first, that second tail spent
 * the whole budget on the oldest log and dropped the newest — the one this
 * file documents as carrying the failure. Truncation happens once, at the
 * source of each piece of text. `test/template/e2e-run-report.test.ts` ›
 * "keeps the newest log's reason even when an older log fills the budget".
 */
const section = (label: string, text: string): string =>
  text.trim() === '' ? '' : `\n--- ${label} ---\n${text}`;

/**
 * The message thrown in place of `Command failed: …`.
 *
 * Deliberately total: it is called from a catch block, so anything it throws
 * would replace the failure it was meant to explain. A rejection that is not an
 * `execFile` error still produces a report.
 */
export const commandFailureReport = (command: string, error: unknown, npmDebugLog = ''): string => {
  const failure: ExecFailure = typeof error === 'object' && error !== null ? error : {};
  const stderr = asText(failure.stderr);
  const stdout = asText(failure.stdout);

  // A spawn failure carries an errno string (`ENOENT`) where an exited child
  // carries a number. Calling the first one an "exit code" misreports it.
  const how =
    failure.signal != null
      ? `killed by signal ${String(failure.signal)}`
      : typeof failure.code === 'number'
        ? `exit code ${failure.code}`
        : typeof failure.code === 'string'
          ? `did not start: ${failure.code}`
          : 'no exit code reported';

  // 🔴 Mask BEFORE truncating, never after. `tail` cuts at an offset, and a cut
  // landing inside a URL's userinfo leaves the password's suffix with no
  // `//user:` in front of it — the prefix the regex anchors on — so the
  // fragment was emitted verbatim while every later line came out masked.
  // Reverting this order makes the sweep in
  // `test/template/e2e-run-report.test.ts` › "masks a credential the stderr
  // truncation cut through, wherever the cut lands" report the offsets that
  // leak — most of the positions it walks, and the test names them rather than
  // a count here going quietly stale. The truncation count now reports the
  // masked length, which is the honest figure for what is printed.
  const streams =
    section('child stderr', tail(redactUrlCredentials(stderr))) +
    section('child stdout', tail(redactUrlCredentials(stdout)));
  const silent = streams === '' ? '\nthe child produced no output on either stream.' : streams;

  return (
    `the install/generate command did not complete (${how}) — ` +
    `this is the command failing, not an assertion about the generated project.\n` +
    `command: ${redactUrlCredentials(command)}` +
    silent +
    // redacted here as well as in `npmDebugLogs`: the masking must not depend
    // on which caller assembled the text. The substitution is idempotent.
    section('npm debug logs', redactUrlCredentials(npmDebugLog))
  );
};

/** The last `OUTPUT_TAIL` bytes of a file, without reading the rest of it. */
const readTail = (file: string): string => {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const want = Math.min(size, OUTPUT_TAIL);
    const buffer = Buffer.alloc(want);
    readSync(fd, buffer, 0, want, Math.max(0, size - want));
    const text = buffer.toString('utf8');
    if (size <= want) return text;
    // 🔴 Reordering is not available here: only the last `OUTPUT_TAIL` bytes are
    // ever read, so the `//user:` the mask anchors on may never be in memory.
    // The tail usually begins mid-line, and that fragment is the one thing
    // nothing downstream can mask — so the first line is dropped whether or not
    // it turned out to be complete. It is not always partial: when the window
    // happens to start exactly at a line boundary the dropped line is whole,
    // measured by constructing that case. Deciding it would take reading one
    // byte before the window; the cost of not deciding is one line off an
    // already-truncated log, never a leak, so it is dropped unconditionally.
    // A tail holding no line break at all is unmaskable by the same argument
    // and yields no body — the fail-closed answer for text that cannot be
    // masked, at the cost of a diagnostic npm does not emit (its log lines are
    // far shorter than the window).
    // `test/template/e2e-run-report.test.ts` › "masks a credential the log tail
    // began inside, wherever the read starts" pins the drop, and
    // › "publishes no body when the log tail holds no whole line that could be masked"
    // pins the fail-closed branch.
    const firstBreak = text.indexOf('\n');
    const whole = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    return `… [${size - want} earlier bytes truncated] …\n${whole}`;
  } finally {
    closeSync(fd);
  }
};

/**
 * The `_logs/*.log` files under an npm cache directory, newest name first.
 *
 * ⚠ This is not belt-and-braces: for the install failure that matters here it is
 * the ONLY place the reason exists. Measured against npm 10.9.4 — a `prepare`
 * lifecycle that fails inside the cloned package exits the whole `npx` with
 * **zero bytes on both streams**, and the script's own message appears only in
 * one of these files. (A git URL that cannot be cloned exits 128 with zero
 * bytes on both streams and states no reason anywhere, at any `loglevel`; there
 * the exit code is the whole of the signal.)
 *
 * 🔴 **Every log, not the newest one** — `npx` leaves two, and the one carrying
 * the failure is not the last written: the outer `npm exec` process appends to
 * its own log after the inner install has already failed, so picking by mtime
 * returns the file with nothing in it. That was measured, after a first version
 * of this function did exactly that and reported an empty section.
 * `test/template/e2e-run-report.test.ts` › "reads every log, because the one
 * carrying the failure is not the newest" pins it.
 *
 * The suites set `npm_config_cache` into their own temp directory and delete it
 * afterwards, so these have to be read here, while the failure is being
 * reported, or they are gone.
 *
 * Total by construction: called from a catch block, every failure to read
 * resolves to "no log", never to a throw that would replace the real one. The
 * file count is capped before any file is opened, only the tail of each is
 * read, and one unreadable file costs that file rather than the others.
 */
export const npmDebugLogs = (cacheDir: string | undefined): string => {
  if (!cacheDir) return '';
  let names: string[];
  const logsDir = path.join(cacheDir, '_logs');
  try {
    names = readdirSync(logsDir)
      .filter((name) => name.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, MAX_DEBUG_LOGS);
  } catch {
    return '';
  }
  return names
    .map((name) => {
      let body: string;
      try {
        body = readTail(path.join(logsDir, name));
      } catch (error) {
        body = `[unreadable: ${error instanceof Error ? error.message : 'unknown'}]`;
      }
      return `[${name}]\n${redactUrlCredentials(body)}`;
    })
    .join('\n');
};

/**
 * `execFile`, with the child's own output preserved on failure.
 *
 * A drop-in for the bare `exec(…)` calls the install suites used to make.
 */
export const run = async (
  command: string,
  args: string[],
  options: Parameters<typeof exec>[2],
): Promise<{ stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await exec(command, args, options);
    return { stdout: asText(stdout), stderr: asText(stderr) };
  } catch (error) {
    const cache = options?.env?.npm_config_cache;
    const failure: ExecFailure = typeof error === 'object' && error !== null ? error : {};
    throw new Error(
      commandFailureReport(`${command} ${args.join(' ')}`, error, npmDebugLogs(cache)),
      // 🔴 Deliberately NOT `{ cause: error }`. The report above is redacted;
      // the original `execFile` rejection is not — it carries the raw `cmd`,
      // `stdout` and `stderr` as properties AND repeats the command line inside
      // its own `message`. Node and Vitest render the whole cause chain, so
      // retaining it printed verbatim, a few lines under the masked copy,
      // exactly what this helper exists to mask. Only the exit metadata
      // survives, and neither field can carry a credential.
      // `test/template/e2e-run-report.test.ts` › "keeps the raw streams and
      // command line off the thrown error, so the redaction is not bypassed"
      // and › "masks the credential everywhere the rendered error chain
      // reaches, not only in the message" pin both halves.
      // The rule wants the caught error preserved as the cause; withholding it is
      // the whole fix, and the reason it protects survives in the message above.
      // eslint-disable-next-line preserve-caught-error -- see the paragraph above
      { cause: { code: failure.code, signal: failure.signal } },
    );
  }
};

/** `run`, for the install path RP-70 was filed about. */
export const runNpx = (
  args: string[],
  options: Parameters<typeof exec>[2],
): Promise<{ stdout: string; stderr: string }> => run('npx', args, options);
