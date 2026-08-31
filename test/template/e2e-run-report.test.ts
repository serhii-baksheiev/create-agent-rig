import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_DEBUG_LOGS,
  OUTPUT_TAIL,
  commandFailureReport,
  npmDebugLogs,
  redactUrlCredentials,
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
  it('masks a password embedded in a URL, and keeps the user', () => {
    expect(redactUrlCredentials('https://ciuser:p4ssw0rdSECRET@registry.example/pkg')).toBe(
      'https://ciuser:***@registry.example/pkg',
    );
  });

  it('masks it wherever it appears — stderr, the command line, and the logs', () => {
    const report = commandFailureReport(
      'npx --registry=https://ciuser:p4ssw0rdSECRET@registry.example x',
      { code: 1, stderr: 'http fetch GET https://ciuser:p4ssw0rdSECRET@registry.example/npm' },
      '[a.log]\nsilly packumentCache https://ciuser:p4ssw0rdSECRET@registry.example/pkg',
    );
    expect(report).not.toContain('p4ssw0rdSECRET');
    expect(report.match(/ciuser:\*\*\*@/g)).toHaveLength(3);
  });

  it('leaves an ordinary URL alone', () => {
    const plain = 'https://registry.npmjs.org/create-agent-rig';
    expect(redactUrlCredentials(plain)).toBe(plain);
  });

  // The report masks the logs itself rather than trusting whoever assembled
  // them, so the substitution runs twice on the normal path and must be safe.
  it('is idempotent, because the report masks what npmDebugLogs already masked', () => {
    const once = redactUrlCredentials('https://ciuser:p4ssw0rdSECRET@registry.example/pkg');
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
});
