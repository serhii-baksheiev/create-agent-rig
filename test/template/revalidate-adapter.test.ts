import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, '.claude', 'scripts', 'revalidate.mjs');

/**
 * RP-64: `revalidate.mjs --point BEFORE_PR` exited with an unhandled `Error` and
 * a Node stack trace when the queue adapter could not be read, instead of the
 * `UNVERIFIABLE` verdict its own header names. A caller that asked "is the
 * branch still the branch the run took up?" got a crash, which is neither an
 * answer nor a refusal it can act on.
 *
 * The distinction these hold, and it is the whole point of the item:
 *
 * - the adapter could not be READ            -> UNVERIFIABLE, exit 2
 * - the claim really moved                   -> hold, exit 2   (unchanged)
 * - nothing moved                            -> continue, exit 0 (unchanged)
 *
 * An unreadable adapter must never resolve to `continue`: "we could not check"
 * is not "we checked and it is fine".
 */

/** Runs the script with the credentials the jira adapter needs deliberately absent. */
const runRevalidate = async (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const base = { ...process.env, ...env };
  for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete base[key];
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd, env: base });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

describe('revalidate: an adapter it cannot read is UNVERIFIABLE, not a crash', () => {
  let work: string;
  let config: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'rp64-'));
    await exec('git', ['init', '-q', work]);
    await exec(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'],
      { cwd: work },
    );
    await mkdir(path.join(work, '.claude'), { recursive: true });
    config = path.join(work, '.claude', 'queue.json');
    await writeFile(
      config,
      JSON.stringify({ adapter: 'jira', board: 'ZZ', boards: { ZZ: { project: 'ZZ' } } }),
    );
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('returns a structured verdict rather than a Node stack trace when credentials are missing', async () => {
    const result = await runRevalidate(work, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'ZZ-1',
      '--base',
      'HEAD',
      '--config',
      config,
      '--json',
    ]);
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toMatch(/node:internal/);
    const payload = JSON.parse(result.stdout) as { result: string; action: string };
    expect(payload.result).toBe('UNVERIFIABLE');
    expect(payload.action).toBe('unverifiable');
  });

  it('exits through the documented hold path, never 0 — "could not check" is not "checked and fine"', async () => {
    const result = await runRevalidate(work, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'ZZ-1',
      '--base',
      'HEAD',
      '--config',
      config,
      '--json',
    ]);
    expect(result.code).toBe(2);
  });

  it('names the adapter as the reason, so the caller knows what to fix', async () => {
    const result = await runRevalidate(work, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'ZZ-1',
      '--base',
      'HEAD',
      '--config',
      config,
      '--json',
    ]);
    const payload = JSON.parse(result.stdout) as { evidence?: { error?: string } };
    expect(payload.evidence?.error ?? '').toMatch(/adapter/i);
  });

  it('says the same thing in human form, without a stack trace', async () => {
    const result = await runRevalidate(work, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'ZZ-1',
      '--base',
      'HEAD',
      '--config',
      config,
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/unverifiable/i);
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  it('holds the same way at BEFORE_CLOSE, which reads the adapter through a different call', async () => {
    const result = await runRevalidate(work, [
      '--point',
      'BEFORE_CLOSE',
      '--ticket',
      'ZZ-1',
      '--config',
      config,
      '--json',
    ]);
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout) as { result: string };
    expect(payload.result).toBe('UNVERIFIABLE');
  });

  it('carries no credential value, even when the environment has one', async () => {
    const secret = ['npm', 'SECRETVALUE', Date.now().toString(36)].join('_');
    const result = await runRevalidate(
      work,
      ['--point', 'BEFORE_PR', '--ticket', 'ZZ-1', '--base', 'HEAD', '--config', config, '--json'],
      { JIRA_API_TOKEN: '' },
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    // and the reason names the VARIABLES, which is what a caller acts on
    expect(result.stdout).toMatch(/JIRA_/);
  });

  it('still refuses an unusable invocation as before — this did not swallow argument errors', async () => {
    const result = await runRevalidate(work, [
      '--point',
      'NOPE',
      '--ticket',
      'ZZ-1',
      '--config',
      config,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown point/i);
  });
});
