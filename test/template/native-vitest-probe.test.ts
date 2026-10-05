import { execFile } from 'node:child_process';
import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { auditFor } from '../helpers/unattended-flag-leak-audit.js';
// RP-395: this module does not exist yet. The two seams it is expected to
// export — `probeEnv` and `describeProbeFailure` — are the ones
// vitest-worker-concurrency.test.ts's `runNativeVitest`/`resolveNativeVitestProjects`
// need: an env builder that always sets RIG_SCRUB_TEST_CHILD='1' (RP-296), and
// a failure formatter that names the child's actual exit identity (timeout
// kill, signal, exit code, maxBuffer) instead of only stdout+stderr.
import { describeProbeFailure, probeEnv } from '../helpers/native-vitest-probe.js';

/**
 * Runs a real child process and resolves with whatever execFile's own
 * callback received — including a non-null `error` — rather than rejecting.
 * Every case below is a REAL node child, not a hand-built Error: the
 * independent-oracle rule (`.claude/rules/invariants.md`) requires the
 * expected message content to be pinned against Node's own observed error
 * shape, never derived by calling into the helper under test.
 */
function runChild(
  args: string[],
  options: ExecFileOptions,
): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

describe('describeProbeFailure', () => {
  it('names that the probe was killed and the configured timeout in ms when execFile times it out', async () => {
    const timeoutMs = 200;
    const { error, stdout, stderr } = await runChild(['-e', 'setTimeout(() => {}, 10_000)'], {
      timeout: timeoutMs,
    });

    // Measured directly against a real execFile timeout kill (node docs):
    // `error.killed === true`, `error.signal === 'SIGTERM'`, `error.code === null`.
    expect(error).not.toBeNull();
    expect(error?.killed).toBe(true);

    const message = describeProbeFailure(error, stdout, stderr, timeoutMs);
    expect(message).toContain('killed');
    expect(message).toContain(String(timeoutMs));
  });

  it('names the exit code when the child process exits non-zero without being killed', async () => {
    const { error, stdout, stderr } = await runChild(['-e', 'process.exit(3)'], {});

    // Measured directly: `error.killed === false`, `error.signal === null`,
    // `error.code === 3` — the literal exit code, not a timeout/signal kill.
    expect(error).not.toBeNull();
    expect(error?.killed).toBe(false);
    expect(error?.code).toBe(3);

    const message = describeProbeFailure(error, stdout, stderr, 12_000);
    expect(message).toContain('exit code 3');
  });

  it("names ERR_CHILD_PROCESS_STDIO_MAXBUFFER when the child's output exceeds maxBuffer", async () => {
    const { error, stdout, stderr } = await runChild(
      ['-e', 'process.stdout.write("x".repeat(1_000_000))'],
      { maxBuffer: 10 },
    );

    // Measured directly: execFile reports this as `error.code ===
    // 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`, a string code, not a process exit
    // code or a signal.
    expect(error).not.toBeNull();
    expect(error?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');

    const message = describeProbeFailure(error, stdout, stderr, 12_000);
    expect(message).toContain('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });
});

describe('probeEnv', () => {
  it("sets RIG_SCRUB_TEST_CHILD='1' so a nested vitest run skips the RP-271 leak audit", () => {
    const env = probeEnv({ ...process.env });
    expect(env.RIG_SCRUB_TEST_CHILD).toBe('1');
  });

  it('still deletes VITEST_MAX_WORKERS the way the existing worker probe already does', () => {
    const base = { ...process.env, VITEST_MAX_WORKERS: '4' };
    const env = probeEnv(base);
    expect(env.VITEST_MAX_WORKERS).toBeUndefined();
  });

  it('keeps unrelated base env entries untouched', () => {
    const base = { ...process.env, RP395_PROBE_ENV_MARKER: 'keep-me' };
    const env = probeEnv(base);
    expect(env.RP395_PROBE_ENV_MARKER).toBe('keep-me');
  });
});

describe("a peer flag appearing during the probe cannot stall the probe's teardown", () => {
  const homes: string[] = [];
  const tempHome = async (): Promise<string> => {
    const home = await mkdtemp(path.join(tmpdir(), 'native-vitest-probe-'));
    homes.push(home);
    return home;
  };

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => removeFixture(home)));
  });

  async function plantFlag(home: string, name: string): Promise<string> {
    const dir = path.join(home, '.claude');
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    await writeFile(target, '{}\n');
    return target;
  }

  it('completes without ever calling sleep, because probeEnv already carries the RIG_SCRUB_TEST_CHILD marker', async () => {
    const home = await tempHome();
    const sleep = async (): Promise<void> => {
      throw new Error(
        'RP-395: the leak-audit teardown must not reach its recheck-window sleep when ' +
          'RIG_SCRUB_TEST_CHILD is set — that is exactly the 35 s stall diagnosed on ' +
          'vitest-worker-concurrency.test.ts',
      );
    };

    const teardown = await auditFor({ env: probeEnv({ ...process.env }), homes: [home], sleep });

    // A peer run's real, unrelated flag appears AFTER setup, mirroring the
    // diagnosed race: a sibling test arms the shared flag while this probe's
    // own child is still running.
    await plantFlag(home, '__PROJECT_NAME__-d4d4d4d4d4d4d4d4-loop-UNATTENDED');

    await expect(teardown()).resolves.toBeUndefined();
  });
});
