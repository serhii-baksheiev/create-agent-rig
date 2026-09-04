import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installEnv, runNpx } from './run.js';

/**
 * The part of RP-70's helper that actually spawns a child. The pure assertions
 * — the report's shape, the redaction, the debug-log reading — live in
 * `test/template/e2e-run-report.test.ts`, where `pnpm test:unit` reaches them;
 * this file is in the `e2e` project because it needs a real `npx` on PATH.
 */
describe('runNpx', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-runnpx-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  // Every suite here points npm at its own cache; without it these two would
  // write debug logs into the host's, and the failing case could never reach
  // the debug-log path at all. `installEnv` is named at each call site rather
  // than behind a local alias, because test/template/e2e-install-network.test.ts
  // judges the call it can see: an alias reads as an install with no helper.

  it('returns the child output when the command succeeds', async () => {
    const { stdout } = await runNpx(['--yes', '--version'], {
      cwd: work,
      env: installEnv(path.join(work, 'npx-cache')),
    });
    expect(stdout.trim()).not.toBe('');
  });

  // A local path npm cannot resolve — the failure is produced without reaching
  // the network, so this pins the reporting rather than a registry's behaviour.
  it('throws a report naming the command and the child, not Node\'s "Command failed"', async () => {
    const failure = await runNpx(['--yes', '--package=file:./rp-70-no-such-package.tgz', 'nope'], {
      cwd: work,
      env: installEnv(path.join(work, 'npx-cache')),
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(failure).toMatch(/did not complete/i);
    expect(failure).toContain('rp-70-no-such-package.tgz');
    // and the child's own account of it reached the report from SOMEWHERE —
    // a stream, or the debug logs npm writes when both streams are silent
    expect(failure).toMatch(/child stderr|child stdout|npm debug logs/);
  });
});
