import type { ExecFileException } from 'node:child_process';

/**
 * The env every native, nested vitest probe in this suite spawns its child
 * with: VITEST_MAX_WORKERS is still stripped (RP-371) so the child resolves
 * vitest's own default worker count, and RIG_SCRUB_TEST_CHILD='1' is always
 * set (RP-296) so the child's own RP-271 leak-audit global teardown takes
 * the nested-child branch instead of its recheck-window sleep — see
 * `test/template/native-vitest-probe.test.ts` › "completes without ever
 * calling sleep, because probeEnv already carries the RIG_SCRUB_TEST_CHILD
 * marker" for the race this closes.
 */
export function probeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.VITEST_MAX_WORKERS;
  env.RIG_SCRUB_TEST_CHILD = '1';
  return env;
}

/**
 * Names the real exit identity execFile reported for a failed native vitest
 * probe, instead of only the child's stdout/stderr — see
 * `test/template/native-vitest-probe.test.ts` › "names that the probe was
 * killed and the configured timeout in ms when execFile times it out".
 */
export function describeProbeFailure(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
  timeoutMs: number,
): string {
  const identity = describeExitIdentity(error, timeoutMs);
  return `native Vitest worker probe failed (${identity}): ${stdout}${stderr}`;
}

function describeExitIdentity(error: ExecFileException | null, timeoutMs: number): string {
  if (error?.killed) {
    return `killed after the configured ${timeoutMs}ms timeout`;
  }

  const exitIdentity =
    typeof error?.code === 'number'
      ? `exit code ${error.code}`
      : `error code ${error?.code ?? 'unknown'}`;
  return error?.signal ? `${exitIdentity}, signal ${error.signal}` : exitIdentity;
}
