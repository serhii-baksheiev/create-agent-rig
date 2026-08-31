import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_DEBUG_LOGS, OUTPUT_TAIL, commandFailureReport, npmDebugLogs, runNpx } from './run.js';

// RP-70: the `npx` install paths threw Node's bare `Command failed: <cmd>`, so a
// CI failure carried no reason at all — the child's stderr, the one thing that
// says whether the install step finished, was discarded. These pin the report
// that replaces it.
describe('commandFailureReport', () => {
  const failure = (over: Record<string, unknown> = {}) =>
    Object.assign(new Error('Command failed: npx --yes create-agent-rig'), {
      code: 1,
      stderr: 'npm error code ETARGET\nnpm error notarget No matching version',
      stdout: '',
      ...over,
    });

  it('says the command did not complete, so it is not read as a bad generated project', () => {
    const report = commandFailureReport('npx --yes create-agent-rig app', failure());
    expect(report).toMatch(/did not complete/i);
  });

  it('names the command that failed', () => {
    const report = commandFailureReport('npx --yes create-agent-rig app', failure());
    expect(report).toContain('npx --yes create-agent-rig app');
  });

  it("carries the child's exit code", () => {
    const report = commandFailureReport('npx x', failure({ code: 254 }));
    expect(report).toMatch(/exit code 254/i);
  });

  it("carries the child's stderr verbatim — the reason the next failure is self-diagnosing", () => {
    const report = commandFailureReport('npx x', failure());
    expect(report).toContain('npm error code ETARGET');
    expect(report).toContain('npm error notarget No matching version');
  });

  it("carries the child's stdout when there is one", () => {
    const report = commandFailureReport('npx x', failure({ stdout: 'wrote git-app/' }));
    expect(report).toContain('wrote git-app/');
  });

  it('reports a signal when the child was killed rather than exiting', () => {
    const report = commandFailureReport('npx x', failure({ code: undefined, signal: 'SIGKILL' }));
    expect(report).toMatch(/SIGKILL/);
  });

  it('keeps the TAIL of a long stream and says how much it dropped — never megabytes of log', () => {
    const noise = 'x'.repeat(OUTPUT_TAIL * 3);
    const report = commandFailureReport('npx x', failure({ stderr: `${noise}\nTHE REAL REASON` }));
    expect(report).toContain('THE REAL REASON');
    expect(report).toMatch(/truncated/i);
    expect(report.length).toBeLessThan(OUTPUT_TAIL * 2 + 2000);
  });

  it('says so plainly when the child produced no output at all', () => {
    const report = commandFailureReport('npx x', failure({ stderr: '', stdout: '' }));
    expect(report).toMatch(/no output/i);
  });

  it('survives a rejection that is not an execFile error, rather than throwing itself', () => {
    expect(() => commandFailureReport('npx x', 'not an error object')).not.toThrow();
    expect(commandFailureReport('npx x', undefined)).toMatch(/did not complete/i);
  });
});

// The measurement RP-70 turned on: an install failure inside the cloned package
// — the `prepare` lifecycle that builds the CLI — exits `npx` with nothing on
// either stream, and npm writes the reason ONLY into its debug log, inside the
// cache the suite points at its own temp directory and then deletes.
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

  // The defect this function was rewritten for: `npx` leaves two logs, and the
  // outer `npm exec` one is written LAST while carrying nothing. Picking by
  // recency returned the empty one and reported an empty section.
  it('reads every log, because the one carrying the failure is not the newest', async () => {
    await writeLog('2026-08-31T19_07_27_908Z-debug-0.log', 'outer npm exec, nothing useful');
    await new Promise((r) => setTimeout(r, 20));
    await writeLog('2026-08-31T19_07_32_294Z-debug-0.log', 'PREPARE SAYS: the build failed here');
    // the one with the reason is touched FIRST, exactly as npx leaves them
    await writeLog('2026-08-31T19_07_27_908Z-debug-0.log', 'outer npm exec, nothing useful');

    const logs = npmDebugLogs(cache);
    expect(logs).toContain('PREPARE SAYS: the build failed here');
    expect(logs).toContain('outer npm exec, nothing useful');
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
    // and it still says the streams were silent — that is its own signal
    expect(report).toMatch(/no output/i);
  });

  it('returns nothing rather than throwing when there is no cache, no dir, or no log', () => {
    expect(npmDebugLogs(undefined)).toBe('');
    expect(npmDebugLogs(path.join(tmpdir(), 'rp70-absent-dir'))).toBe('');
    expect(npmDebugLogs(cache)).toBe('');
  });

  it('reads a bounded number of logs however many the directory holds', async () => {
    for (let i = 0; i < MAX_DEBUG_LOGS + 6; i += 1) await writeLog(`log-${i}-debug-0.log`, `L${i}`);
    const logs = npmDebugLogs(cache);
    expect(logs.match(/-debug-0\.log\]/g)).toHaveLength(MAX_DEBUG_LOGS);
  });

  it('truncates a long log the same way the streams are truncated', async () => {
    const noise = 'y'.repeat(OUTPUT_TAIL * 3);
    await writeLog('a-debug-0.log', `${noise}\nTHE REAL REASON`);
    const report = commandFailureReport('npx x', { code: 1 }, npmDebugLogs(cache));
    expect(report).toContain('THE REAL REASON');
    expect(report).toMatch(/truncated/i);
  });
});

describe('runNpx', () => {
  it('returns the child output when the command succeeds', async () => {
    const { stdout } = await runNpx(['--yes', '--version'], {});
    expect(stdout.trim()).not.toBe('');
  });

  // A local path npm cannot resolve — the failure is produced without reaching
  // the network, so this pins the reporting rather than a registry's behaviour.
  it('throws the report rather than Node\'s bare "Command failed"', async () => {
    await expect(
      runNpx(['--yes', '--package=file:./rp-70-no-such-package.tgz', 'nope'], {}),
    ).rejects.toThrow(/did not complete/i);
  });
});
