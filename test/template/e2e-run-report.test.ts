import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_DEBUG_LOGS,
  OUTPUT_TAIL,
  commandFailureReport,
  npmDebugLogs,
  redactUrlCredentials,
  run,
} from '../e2e/run.js';

/**
 * RP-70: the `npx` install paths threw Node's bare `Command failed: <cmd>`, so a
 * CI failure carried no reason at all — the child's output, the one thing that
 * says whether the install step finished, was discarded.
 *
 * 🔴 **These live in the `template` project, not beside the helper in `e2e`, on
 * purpose.** `ci.yml` runs `pnpm test:unit`, which is the `unit` and `template`
 * projects; `e2e.yml`'s `pull_request` filter is `packages/cli/**` and
 * `templates/**`. A test of this helper placed under `test/e2e/` is therefore
 * run by NO pre-merge job when the only changed paths are `test/e2e/**` — which
 * is exactly the shape of the change that introduced it. These assertions are
 * pure (no spawning, no network), so they belong where a check reaches them.
 */
/**
 * 🔴 Both readers TRUNCATE before they mask, and `redactUrlCredentials` anchors
 * on the `//user:` prefix — so when the cut lands inside a URL's userinfo the
 * surviving password suffix has lost the prefix the regex needs, and is emitted
 * verbatim into a CI log. These fixtures walk the cut across a realistic npm
 * fetch line, so the assertions below state the property (no cut position
 * leaks) rather than pinning one lucky offset.
 *
 * The credential is assembled at runtime from neutral fragments rather than
 * written out — a fixture that needs a credential SHAPE builds it, so this
 * repository's own sweep does not report its test data as a leak
 * (`.claude/rules/autonomy.md`, "Never"). The fragments are long and
 * distinctive on purpose: "no leak" is only a real assertion if a surviving
 * piece of the password could not appear in the text by chance.
 */
const CUT_USER = 'ciuser';
const CUT_PASSWORD = ['p4ss', 'w0rd', 'BOUNDARY', 'X7QZV9'].join('');
const cutFetchLine = (n: number) =>
  `${n} http fetch GET 200 https://${CUT_USER}:${CUT_PASSWORD}@registry.example/create-agent-rig 45ms (cache miss)`;

/** The line the cut falls inside, and the two positions of interest within it. */
const STRADDLING = cutFetchLine(366);
const URL_AT = STRADDLING.indexOf('https://');
const PASSWORD_AT = STRADDLING.indexOf(CUT_PASSWORD);

/**
 * Text whose last `OUTPUT_TAIL` characters begin exactly `offset` characters
 * into the straddling line: the reader keeps `STRADDLING.slice(offset)`, then a
 * whole credentialed line (which must still come out masked), then filler.
 */
const straddled = (offset: number): string => {
  const whole = `${cutFetchLine(367)}\n`;
  // The line break after the straddling line is not decoration: npm writes
  // newline-terminated lines, and without it the fragment the cut leaves and
  // the following whole line would be ONE line, which no log ever contains.
  // The `- 1` keeps the cut landing exactly `offset` into the straddling line.
  const pad = OUTPUT_TAIL + offset - STRADDLING.length - whole.length - 1;
  return 'n'.repeat(OUTPUT_TAIL) + STRADDLING + '\n' + whole + 'z'.repeat(pad);
};

/**
 * The same cut, in a file that holds NO line break anywhere — so the kept
 * window is one unterminated fragment: the `//user:` the mask anchors on is
 * outside it, and there is no later whole line to fall back to. Nothing in this
 * window can be masked, which is the case `straddled` cannot reach.
 */
const unbroken = (offset: number): string => {
  const pad = OUTPUT_TAIL + offset - STRADDLING.length;
  return 'n'.repeat(OUTPUT_TAIL) + STRADDLING + 'z'.repeat(pad);
};

/** Every cut position from the start of the URL to just past the password. */
const CUTS = Array.from(
  { length: PASSWORD_AT - URL_AT + CUT_PASSWORD.length + 4 },
  (_, index) => URL_AT + index,
);

/**
 * Text leaks when a distinctive tail of the password survives it, or when any
 * `@registry.example` is reached without `***` in front of it — the second
 * catches a cut that left only two or three password characters behind.
 */
const PASSWORD_TAILS = Array.from({ length: CUT_PASSWORD.length - 3 }, (_, index) =>
  CUT_PASSWORD.slice(index),
);
const leaksCredential = (text: string): boolean =>
  PASSWORD_TAILS.some((fragment) => text.includes(fragment)) ||
  text
    .split('@registry.example')
    .slice(0, -1)
    .some((before) => !before.endsWith('***'));

describe('commandFailureReport', () => {
  const failure = (over: Record<string, unknown> = {}) =>
    Object.assign(new Error('Command failed: npx --yes create-agent-rig'), {
      code: 1,
      stderr: 'npm error code ETARGET\nnpm error notarget No matching version',
      stdout: '',
      ...over,
    });

  it('says the command did not complete, so it is not read as a bad generated project', () => {
    expect(commandFailureReport('npx --yes create-agent-rig app', failure())).toMatch(
      /did not complete/i,
    );
  });

  it('names the command that failed', () => {
    expect(commandFailureReport('npx --yes create-agent-rig app', failure())).toContain(
      'npx --yes create-agent-rig app',
    );
  });

  it("carries the child's exit code", () => {
    expect(commandFailureReport('npx x', failure({ code: 254 }))).toMatch(/exit code 254/i);
  });

  // A spawn failure carries an errno where an exited child carries a number;
  // calling `ENOENT` an exit code misreports what happened.
  it('says a command did not START when the failure is an errno, not an exit status', () => {
    const report = commandFailureReport('npx x', failure({ code: 'ENOENT' }));
    expect(report).toMatch(/did not start: ENOENT/);
    expect(report).not.toMatch(/exit code ENOENT/);
  });

  it("carries the child's stderr verbatim — the reason the next failure is self-diagnosing", () => {
    const report = commandFailureReport('npx x', failure());
    expect(report).toContain('npm error code ETARGET');
    expect(report).toContain('npm error notarget No matching version');
  });

  it("carries the child's stdout when there is one", () => {
    expect(commandFailureReport('npx x', failure({ stdout: 'wrote git-app/' }))).toContain(
      'wrote git-app/',
    );
  });

  it('reports a signal when the child was killed rather than exiting', () => {
    expect(commandFailureReport('npx x', failure({ code: undefined, signal: 'SIGKILL' }))).toMatch(
      /SIGKILL/,
    );
  });

  it('keeps the TAIL of a long stream and says how much it dropped — never megabytes of log', () => {
    const noise = 'x'.repeat(OUTPUT_TAIL * 3);
    const report = commandFailureReport('npx x', failure({ stderr: `${noise}\nTHE REAL REASON` }));
    expect(report).toContain('THE REAL REASON');
    expect(report).toMatch(/truncated/i);
    expect(report.length).toBeLessThan(OUTPUT_TAIL * 2 + 2000);
  });

  // 🔴 `tail()` runs BEFORE `redactUrlCredentials`, so the first line of a
  // truncated section is whatever the cut left behind — and a password suffix
  // no longer carries the `//user:` prefix the mask anchors on.
  it('masks a credential the stderr truncation cut through, wherever the cut lands', () => {
    // The sweep would also pass on a report that carried nothing, so first pin
    // that a cut section is still a section: masked line, truncation notice.
    const sample = commandFailureReport('npx x', failure({ stderr: straddled(PASSWORD_AT + 4) }));
    expect(sample).toContain(`${CUT_USER}:***@`);
    expect(sample).toMatch(/truncated/i);

    const leaked = CUTS.filter((offset) =>
      leaksCredential(commandFailureReport('npx x', failure({ stderr: straddled(offset) }))),
    );
    expect(leaked).toEqual([]);
  });

  it('masks a credential the stdout truncation cut through, wherever the cut lands', () => {
    const cut = (offset: number) => failure({ stderr: '', stdout: straddled(offset) });
    const sample = commandFailureReport('npx x', cut(PASSWORD_AT + 4));
    expect(sample).toContain(`${CUT_USER}:***@`);
    expect(sample).toMatch(/truncated/i);

    const leaked = CUTS.filter((offset) =>
      leaksCredential(commandFailureReport('npx x', cut(offset))),
    );
    expect(leaked).toEqual([]);
  });

  it('says so plainly when the child produced no output at all', () => {
    expect(commandFailureReport('npx x', failure({ stderr: '', stdout: '' }))).toMatch(
      /no output/i,
    );
  });

  it('survives a rejection that is not an execFile error, rather than throwing itself', () => {
    expect(() => commandFailureReport('npx x', 'not an error object')).not.toThrow();
    expect(commandFailureReport('npx x', undefined)).toMatch(/did not complete/i);
  });
});

// Measured on npm 11.3.0: a registry configured as https://user:password@host is
// written UNREDACTED into the debug log on `silly packumentCache` and
// `http fetch GET` lines. This report is printed into a CI log.
describe('redactUrlCredentials', () => {
  // Assembled at runtime rather than written out, for the same reason the
  // `run` fixtures below are: a tracked `user:password@host` literal is
  // reported as a leak by this repository's own sweep and by the registry
  // scanner, and these tests need the credential SHAPE, never a value —
  // `.claude/rules/autonomy.md`, "Never".
  const secret = ['p4ss', 'w0rd', 'SECRET'].join('');
  const credentialed = (suffix: string) => `https://ciuser:${secret}@registry.example${suffix}`;

  it('masks a password embedded in a URL, and keeps the user', () => {
    expect(redactUrlCredentials(credentialed('/pkg'))).toBe(
      'https://ciuser:***@registry.example/pkg',
    );
  });

  it('masks it wherever it appears — stderr, the command line, and the logs', () => {
    const report = commandFailureReport(
      `npx --registry=${credentialed('')} x`,
      { code: 1, stderr: `http fetch GET ${credentialed('/npm')}` },
      `[a.log]\nsilly packumentCache ${credentialed('/pkg')}`,
    );
    expect(report).not.toContain(secret);
    expect(report.match(/ciuser:\*\*\*@/g)).toHaveLength(3);
  });

  it('leaves an ordinary URL alone', () => {
    const plain = 'https://registry.npmjs.org/create-agent-rig';
    expect(redactUrlCredentials(plain)).toBe(plain);
  });

  // The report masks the logs itself rather than trusting whoever assembled
  // them, so the substitution runs twice on the normal path and must be safe.
  it('is idempotent, because the report masks what npmDebugLogs already masked', () => {
    const once = redactUrlCredentials(credentialed('/pkg'));
    expect(redactUrlCredentials(once)).toBe(once);
  });
});

describe('npmDebugLogs', () => {
  let cache: string;
  const writeLog = (name: string, body: string) => writeFile(path.join(cache, '_logs', name), body);

  beforeEach(async () => {
    cache = await mkdtemp(path.join(tmpdir(), 'rp70-cache-'));
    await mkdir(path.join(cache, '_logs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(cache, { recursive: true, force: true });
  });

  // `npx` leaves two logs, and the outer `npm exec` one is written LAST while
  // carrying nothing. Picking by recency returned the empty one.
  it('reads every log, because the one carrying the failure is not the newest', async () => {
    await writeLog('2026-08-31T19_07_27_908Z-debug-0.log', 'outer npm exec, nothing useful');
    await new Promise((r) => setTimeout(r, 20));
    await writeLog('2026-08-31T19_07_32_294Z-debug-0.log', 'PREPARE SAYS: the build failed here');
    await writeLog('2026-08-31T19_07_27_908Z-debug-0.log', 'outer npm exec, nothing useful');

    const logs = npmDebugLogs(cache);
    expect(logs).toContain('PREPARE SAYS: the build failed here');
    expect(logs).toContain('outer npm exec, nothing useful');
  });

  // 🔴 The defect a reviewer measured: the report used to tail the already-tailed
  // join, and because the logs arrive newest-first the budget was spent on the
  // OLDEST one — dropping the log this helper exists to surface. Two realistic
  // logs is the only configuration `npx` actually produces.
  it("keeps the newest log's reason even when an older log fills the budget", () => {
    const older = 'z'.repeat(OUTPUT_TAIL * 2);
    const report = commandFailureReport(
      'npx x',
      { code: 1, stderr: '', stdout: '' },
      `[2026-08-31T19_07_32Z-debug-0.log]\nPREPARE SAYS: the build failed here\n[2026-08-31T19_07_27Z-debug-0.log]\n${older}`,
    );
    expect(report).toContain('PREPARE SAYS: the build failed here');
  });

  it('names each log it read, so a reader knows which file said what', async () => {
    await writeLog('a-debug-0.log', 'first');
    expect(npmDebugLogs(cache)).toContain('[a-debug-0.log]');
  });

  it('the report carries the logs — the only place a silent failure states its reason', async () => {
    await writeLog('a-debug-0.log', 'PREPARE SAYS: the build failed here');
    const report = commandFailureReport(
      'npx --package=git+file:///repo create-agent-rig app',
      { code: 1, stderr: '', stdout: '' },
      npmDebugLogs(cache),
    );
    expect(report).toContain('PREPARE SAYS: the build failed here');
    expect(report).toMatch(/npm debug logs/i);
    expect(report).toMatch(/no output/i);
  });

  it('returns nothing rather than throwing when there is no cache, no dir, or no log', () => {
    expect(npmDebugLogs(undefined)).toBe('');
    expect(npmDebugLogs(path.join(tmpdir(), 'rp70-absent-dir'))).toBe('');
    expect(npmDebugLogs(cache)).toBe('');
  });

  // One unreadable file used to cost all four, including the reason-carrier.
  it('loses only the file it cannot read, never the log beside it', async () => {
    await writeLog('b-debug-0.log', 'PREPARE SAYS: the build failed here');
    await mkdir(path.join(cache, '_logs', 'a-debug-0.log')); // a directory: open succeeds, read fails
    const logs = npmDebugLogs(cache);
    expect(logs).toContain('PREPARE SAYS: the build failed here');
    expect(logs).toContain('a-debug-0.log');
  });

  it('reads a bounded number of logs however many the directory holds', async () => {
    for (let i = 0; i < MAX_DEBUG_LOGS + 6; i += 1) await writeLog(`log-${i}-debug-0.log`, `L${i}`);
    expect(npmDebugLogs(cache).match(/-debug-0\.log\]/g)).toHaveLength(MAX_DEBUG_LOGS);
  });

  it('reads only the tail of a large log, and says how many bytes it skipped', async () => {
    const noise = 'y'.repeat(OUTPUT_TAIL * 3);
    await writeLog('a-debug-0.log', `${noise}\nTHE REAL REASON`);
    const logs = npmDebugLogs(cache);
    expect(logs).toContain('THE REAL REASON');
    expect(logs).toMatch(/truncated/i);
    // the whole file is never carried: the tail plus a short header, not 3x
    expect(logs.length).toBeLessThan(OUTPUT_TAIL + 200);
  });

  // 🔴 Here redact-before-truncate is not even available: `readTail` reads only
  // the last OUTPUT_TAIL bytes, so when the read begins inside a URL's userinfo
  // the surviving password suffix reaches the mask with no `//user:` in front
  // of it — and npm writes these URLs into the log unredacted.
  it('masks a credential the log tail began inside, wherever the read starts', async () => {
    await writeLog('a-debug-0.log', straddled(PASSWORD_AT + 4));
    const sample = npmDebugLogs(cache);
    expect(sample).toContain(`${CUT_USER}:***@`);
    expect(sample).toMatch(/truncated/i);

    const leaked: number[] = [];
    for (const offset of CUTS) {
      await writeLog('a-debug-0.log', straddled(offset));
      if (leaksCredential(npmDebugLogs(cache))) leaked.push(offset);
    }
    expect(leaked).toEqual([]);
  });

  // 🔴 The fail-closed branch of the same reader, which every fixture above
  // walks straight past: those windows all contain a line break, so a whole
  // line always survives to be masked. A window with NO break has nothing that
  // can be masked at all, and publishing it anyway republishes the very leak
  // this file exists to refuse — so it yields a notice and no body.
  it('publishes no body when the log tail holds no whole line that could be masked', async () => {
    await writeLog('a-debug-0.log', unbroken(PASSWORD_AT + 4));
    const unmaskable = npmDebugLogs(cache);

    expect(unmaskable).toContain('[a-debug-0.log]');
    expect(unmaskable).toMatch(/truncated/i);
    expect(leaksCredential(unmaskable)).toBe(false);
    // The property, not the notice's wording: whatever it says, it is the last
    // thing said — nothing from the unmaskable window follows it.
    const lines = unmaskable.split('\n');
    const noticeAt = lines.findIndex((line) => /truncated/i.test(line));
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(
      lines
        .slice(noticeAt + 1)
        .join('')
        .trim(),
    ).toBe('');

    // The control, and the reason the emptiness above is evidence: the same
    // file with the line break restored still publishes its later lines, masked.
    // Without this, "no body" would also be satisfied by a reader that had
    // stopped returning anything at all.
    await writeLog('a-debug-0.log', straddled(PASSWORD_AT + 4));
    const maskable = npmDebugLogs(cache);
    expect(maskable).toContain(`${CUT_USER}:***@`);
    expect(maskable.split('\n').length).toBeGreaterThan(lines.length);
  });
});

/**
 * 🔴 `run` builds a redacted report and then throws it with the ORIGINAL
 * `execFile` rejection as `cause`. That rejection's own `cmd`, `stderr` and
 * `stdout` are unredacted, and both Node and vitest render a cause chain when
 * an error goes unhandled — so the masking above is printed into a CI log
 * beside the raw value it masked.
 *
 * One short child process for the whole block: `process.execPath` writing a
 * credential-shaped URL to stderr and exiting non-zero is a real `execFile`
 * rejection with no npm and no network behind it.
 */
describe('run', () => {
  // Assembled at runtime rather than written out: a fixture that needs a
  // credential SHAPE builds it from neutral fragments, so the sweep does not
  // report its own test data as a leak — `.claude/rules/autonomy.md`, "Never".
  const user = 'ciuser';
  const password = ['p4ss', 'w0rd', 'RP70'].join('');
  const credentialUrl = `https://${user}:${password}@registry.example/pkg`;

  /** Every link of the `cause` chain, the thrown error first. Bounded. */
  const causeChain = (from: unknown): unknown[] => {
    const links: unknown[] = [];
    let current = from;
    for (let depth = 0; depth < 10 && current != null; depth += 1) {
      links.push(current);
      current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
    }
    return links;
  };

  let thrown: unknown;

  beforeAll(async () => {
    const stderrLine = `http fetch GET ${credentialUrl}`;
    const script = `process.stderr.write(${JSON.stringify(stderrLine)});process.exit(3)`;
    try {
      const resolved = await run(process.execPath, ['-e', script], {});
      thrown = new Error(`run resolved instead of rejecting: ${JSON.stringify(resolved)}`);
    } catch (error) {
      thrown = error;
    }
  });

  // The precondition every assertion below rests on: the child really failed
  // and `run` really replaced the rejection with its report.
  const failure = (): Error => {
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toMatch(/did not complete/i);
    return error;
  };

  it('keeps the raw streams and command line off the thrown error, so the redaction is not bypassed', () => {
    for (const link of causeChain(failure())) {
      expect(link).not.toHaveProperty('stderr');
      expect(link).not.toHaveProperty('stdout');
      expect(link).not.toHaveProperty('cmd');
    }
  });

  it('masks the credential everywhere the rendered error chain reaches, not only in the message', () => {
    expect(inspect(failure(), { depth: null })).not.toContain(password);
  });

  it('still carries the masked report as its own message, naming the exit code', () => {
    const message = failure().message;
    expect(message).toMatch(/exit code 3/);
    expect(message).toContain(`${user}:***@`);
    expect(message).not.toContain(password);
  });

  it('exposes nothing but exit metadata when it keeps a cause at all', () => {
    // Omitting the cause entirely satisfies the contract, so the assertion is
    // over the keys of whatever cause survives — never over its presence.
    const cause = (failure() as { cause?: unknown }).cause;
    const keys = typeof cause === 'object' && cause !== null ? Object.keys(cause) : [];
    expect(keys.filter((key) => key !== 'code' && key !== 'signal')).toEqual([]);
  });
});
