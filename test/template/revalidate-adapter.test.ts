import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error - the rulebook scripts are .mjs without type declarations
import { safeReason } from '../../.claude/scripts/revalidate.mjs';
// @ts-expect-error - see above
import { DEFAULT_SCAN_LIMIT } from '../../.claude/scripts/lib/secrets.mjs';

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
  const base = { ...process.env };
  // strip FIRST, then apply the caller's override — the other order deleted the
  // very variables a caller was trying to set, which made a test unfalsifiable
  for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete base[key];
  Object.assign(base, env);
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

  it('names the environment variables in the published reason — that is what a caller acts on', async () => {
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
    expect(result.stdout).toMatch(/JIRA_/);
  });

  // 🔴 The control that justifies publishing adapter text at all, tested where it
  // lives rather than only through a subprocess. The previous version of this
  // suite asserted on a value it never gave the child, and a reviewer proved the
  // point by replacing the guard with `true` — every test stayed green while
  // every adapter message was published raw.
  describe('safeReason — the only net on text that reaches stdout and the run journal', () => {
    it('publishes a message that names only environment variables', () => {
      const message =
        'the jira adapter needs JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in the environment.';
      expect(safeReason(message)).toBe(message);
    });

    it('withholds a message carrying a credential-shaped value', () => {
      // assembled at runtime so this file never carries a credential shape —
      // the repo's own sweep would otherwise report its test data as a leak
      const token = `ATATT3x${'A1b2C3d4E5'.repeat(6)}`;
      const withheld = safeReason(`jira GET /rest/api/3/issue failed: 401 (${token})`);
      expect(withheld).not.toContain(token);
      expect(withheld).toMatch(/withheld/i);
    });

    it('withholds rather than redacting in place — no part of the message survives', () => {
      const token = `ATATT3x${'A1b2C3d4E5'.repeat(6)}`;
      const withheld = safeReason(`base=https://jira.example.com token=${token}`);
      expect(withheld).not.toContain('jira.example.com');
    });

    it('never publishes more than it scanned', () => {
      const token = `ATATT3x${'A1b2C3d4E5'.repeat(6)}`;
      const published = safeReason(`${'x'.repeat(DEFAULT_SCAN_LIMIT + 10)}${token}`);
      expect(published).not.toContain(token);
    });

    it('is total on a non-string, rather than throwing inside a catch block', () => {
      expect(safeReason(undefined)).toBe('');
      expect(safeReason(null)).toBe('');
    });
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
