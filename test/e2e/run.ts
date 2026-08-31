import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * RP-70: the two e2e suites that install through `npx` let `execFile`'s
 * rejection reach vitest untouched, and Node's message for that is only
 * `Command failed: <the whole command line>`. The child's stderr — the single
 * thing that says *why* — rides along on the error object and was thrown away.
 *
 * That is what made the `e2e` failure on PR #162 head `6bccbb17` undiagnosable:
 * the log carried the command and nothing else, so telling an install-step
 * failure apart from a real generation defect took a local reproduction plus a
 * duration comparison plus checking the sibling pack path by hand.
 *
 * ⚠ These helpers make a failure *readable*. They do not make it pass, retry
 * it, or soften it: a command that did not complete is still a failed test —
 * `test/e2e/run.test.ts` › "says the command did not complete, so it is not read
 * as a bad generated project".
 */

/** Node's `execFile` rejection. Every field is optional — it is not a contract. */
type ExecFailure = {
  code?: number | string;
  signal?: NodeJS.Signals | string;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
};

/**
 * How much of each stream the report keeps. A failing `npm install` can emit
 * far more than anyone reads, and the reason is at the END of it — so the tail
 * is what survives, and the report says how much it dropped.
 */
export const OUTPUT_TAIL = 4000;

const asText = (value: string | Buffer | undefined): string =>
  typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';

const tail = (stream: string): string => {
  if (stream.length <= OUTPUT_TAIL) return stream;
  const dropped = stream.length - OUTPUT_TAIL;
  return `… [${dropped} earlier characters truncated] …\n${stream.slice(-OUTPUT_TAIL)}`;
};

const section = (label: string, stream: string): string =>
  stream.trim() === '' ? '' : `\n--- ${label} ---\n${tail(stream)}`;

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

  const how =
    failure.signal != null
      ? `killed by signal ${String(failure.signal)}`
      : failure.code != null
        ? `exit code ${String(failure.code)}`
        : 'no exit code reported';

  const streams = `${section('child stderr', stderr)}${section('child stdout', stdout)}`;
  const silent = streams === '' ? '\nthe child produced no output on either stream.' : streams;

  return (
    `the install/generate command did not complete (${how}) — ` +
    `this is the command failing, not an assertion about the generated project.\n` +
    `command: ${command}` +
    silent +
    section('npm debug logs', npmDebugLog)
  );
};

/** How many of an `_logs` directory's files the report will read. Bounded on purpose. */
export const MAX_DEBUG_LOGS = 4;

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
 * `test/e2e/run.test.ts` › "reads every log, because the one carrying the
 * failure is not the newest" pins it.
 *
 * The suites set `npm_config_cache` into their own temp directory and delete it
 * afterwards, so these have to be read here, while the failure is being
 * reported, or they are gone.
 *
 * Total by construction: called from a catch block, every failure to read
 * resolves to "no log", never to a throw that would replace the real one. The
 * file count is capped before anything is read.
 */
export const npmDebugLogs = (cacheDir: string | undefined): string => {
  if (!cacheDir) return '';
  try {
    const logsDir = path.join(cacheDir, '_logs');
    const names = readdirSync(logsDir)
      .filter((name) => name.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, MAX_DEBUG_LOGS);
    return names
      .map((name) => `[${name}]\n${tail(readFileSync(path.join(logsDir, name), 'utf8'))}`)
      .join('\n');
  } catch {
    return '';
  }
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
    throw new Error(
      commandFailureReport(`${command} ${args.join(' ')}`, error, npmDebugLogs(cache)),
      { cause: error },
    );
  }
};

/** `run`, for the install path RP-70 was filed about. */
export const runNpx = (
  args: string[],
  options: Parameters<typeof exec>[2],
): Promise<{ stdout: string; stderr: string }> => run('npx', args, options);
