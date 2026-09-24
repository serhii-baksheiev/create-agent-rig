import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

/**
 * RP-255 code-reviewer round 1, blocker B1
 * (.claude/runs/20260924-171159-rp-255/reports/code-reviewer-r1.md):
 *
 * `ghText` (queue/github-issues.mjs) and `run()` (preflight.mjs) both decide
 * "the child timed out" from `error?.signal || error?.killed`. `spawnSync`
 * (what `execFileSync` runs on) also sets `error.signal` — with NO
 * `error.code === 'ETIMEDOUT'` — in two other cases neither call site's
 * `timeout:` option caused:
 *
 *   - stdout over the default 1 MiB `maxBuffer`: `error.code === 'ENOBUFS'`,
 *     `error.signal === 'SIGTERM'` (`spawnSync`'s own kill).
 *   - the child dying on ANY external signal (crash, OOM killer, an outside
 *     `kill`): `error.signal` is whatever signal it died on, `error.code` is
 *     not `'ETIMEDOUT'`.
 *
 * Both are currently reported as "did not complete within 10000ms and was
 * killed", which is false and points an operator at the wrong fix. Only
 * `error.code === 'ETIMEDOUT'` is a genuine timeout; everything else must be
 * rethrown UNCHANGED — the original node error, message and `.code`/`.signal`
 * intact — exactly as the `else` branch already does for a non-signal error.
 *
 * `execFileSync`'s ENOBUFS behaviour (code, signal, no `.killed`) is measured
 * directly, independent of this suite's own helpers:
 *
 *   $ node -e "const {execFileSync}=require('node:child_process');
 *     try{execFileSync('node',['-e','process.stdout.write(\"x\".repeat(2*1024*1024))'],
 *     {encoding:'utf8'})}catch(e){console.log(e.code,e.signal,e.killed)}"
 *   ENOBUFS SIGTERM undefined
 *
 *   $ node -e "const {execFileSync}=require('node:child_process');
 *     try{execFileSync('node',['-e','process.kill(process.pid,\"SIGKILL\")'],
 *     {encoding:'utf8'})}catch(e){console.log(e.code,e.signal,e.killed)}"
 *   undefined SIGKILL undefined
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');

// Comfortably over execFileSync's default 1 MiB (1_048_576 byte) maxBuffer.
const OVERSIZED_STDOUT_CHARS = 1_600_000;

/**
 * `stubCommand`'s handler returns `{ stdout }` for the preload to hand to
 * ONE `process.stdout.write(...)` call, immediately followed by
 * `process.exit(...)`. `process.exit()` "will force the process to exit as
 * quickly as possible even if there are still asynchronous operations
 * pending that have not yet completed fully, including I/O operations to
 * process.stdout" (Node docs) — measured here: a single ~1.6 MB
 * `process.stdout.write` followed by that `process.exit()` reaches the
 * parent truncated below the 1 MiB `maxBuffer` threshold, so `execFileSync`
 * never sees ENOBUFS at all and the truncated (still non-JSON) text reaches
 * `JSON.parse` instead. Writing the same bytes through `fs.writeSync` in a
 * loop blocks until each chunk is actually flushed to the pipe, so nothing
 * is left pending when the handler returns and `process.exit()` runs —
 * confirmed against a standalone script with no test helper involved,
 * `code= ENOBUFS signal= SIGTERM killed= undefined`.
 */
const OVERSIZED_STDOUT_HANDLER = `
  const fs = require('node:fs');
  const chunk = 'x'.repeat(65536);
  let total = 0;
  while (total < ${OVERSIZED_STDOUT_CHARS}) { fs.writeSync(1, chunk); total += chunk.length; }
  return {};
`;

let stubs: StubHandle[] = [];
afterEach(() => {
  for (const stub of stubs.reverse()) stub.restore();
  stubs = [];
});

// No real POSIX signal delivery on win32 — CreateProcess has no analogue to
// `process.kill(pid, 'SIGKILL')`, so only a platform that actually has
// signals can demonstrate an external-signal death as opposed to a timeout
// kill. Computed once, by name, rather than written inline into a
// `skipIf(...)` call — see platform-skips.test.ts, which refuses a bare
// `process.platform` check inside `skipIf`/`runIf` and is satisfied by the
// same shape `run-journal.test.ts`'s `rootless` already uses.
const canSendRealSignals = process.platform !== 'win32';

describe('github-issues.mjs ghText: a killed child is not always a timeout (RP-255 code-reviewer B1)', () => {
  it('does not report an oversized gh response (ENOBUFS) as a timeout', async () => {
    const stub = await stubCommand('gh', OVERSIZED_STDOUT_HANDLER);
    stubs.push(stub);

    const { listEligible } = await import(
      `${pathToFileURL(path.join(queueDir, 'github-issues.mjs')).href}?rp255-enobufs=${Date.now()}`
    );

    let thrown: (Error & { code?: string }) | undefined;
    try {
      listEligible();
    } catch (error) {
      thrown = error as Error & { code?: string };
    }

    expect(thrown, 'listEligible() must throw on an oversized gh response').toBeDefined();
    expect(thrown?.message, `must not be reported as a timeout: ${thrown?.message}`).not.toMatch(
      /did not complete within/i,
    );
    expect(
      thrown?.code,
      `the original ENOBUFS error must be rethrown unchanged, not wrapped: ${thrown?.message}`,
    ).toBe('ENOBUFS');
  });

  it.skipIf(!canSendRealSignals)(
    'does not report a gh child that dies on its own external signal as a timeout',
    async () => {
      const stub = await stubCommand('gh', "process.kill(process.pid, 'SIGKILL'); return {};");
      stubs.push(stub);

      const { listEligible } = await import(
        `${pathToFileURL(path.join(queueDir, 'github-issues.mjs')).href}?rp255-signal=${Date.now()}`
      );

      let thrown: (Error & { signal?: string; code?: string }) | undefined;
      try {
        listEligible();
      } catch (error) {
        thrown = error as Error & { signal?: string; code?: string };
      }

      expect(
        thrown,
        'listEligible() must throw when the child dies on its own signal',
      ).toBeDefined();
      expect(thrown?.message, `must not be reported as a timeout: ${thrown?.message}`).not.toMatch(
        /did not complete within/i,
      );
      expect(
        thrown?.signal,
        `the original signal must be rethrown unchanged, not wrapped: ${thrown?.message}`,
      ).toBe('SIGKILL');
    },
  );
});

describe('preflight.mjs run(): a killed gh child is not always a timeout (RP-255 code-reviewer B1)', () => {
  it("checkLastDeploy()'s detail does not claim a timeout when gh's stdout overflows maxBuffer", async () => {
    const stub = await stubCommand('gh', OVERSIZED_STDOUT_HANDLER);
    stubs.push(stub);

    const { checkLastDeploy } = await import(
      `${pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href}?rp255-enobufs=${Date.now()}`
    );

    const result = checkLastDeploy() as { ok: boolean | string; detail: string };

    expect(result.ok, `checkLastDeploy() must not read this as a pass: ${result.detail}`).not.toBe(
      true,
    );
    expect(result.detail, `must not be reported as a timeout: ${result.detail}`).not.toMatch(
      /did not complete within/i,
    );
    expect(result.detail, `the original ENOBUFS failure must survive: ${result.detail}`).toMatch(
      /enobufs/i,
    );
  });

  it.skipIf(!canSendRealSignals)(
    "checkLastDeploy()'s detail does not claim a timeout when gh dies on its own external signal",
    async () => {
      const stub = await stubCommand('gh', "process.kill(process.pid, 'SIGKILL'); return {};");
      stubs.push(stub);

      const { checkLastDeploy } = await import(
        `${pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href}?rp255-signal=${Date.now()}`
      );

      const result = checkLastDeploy() as { ok: boolean | string; detail: string };

      expect(
        result.ok,
        `checkLastDeploy() must not read this as a pass: ${result.detail}`,
      ).not.toBe(true);
      expect(result.detail, `must not be reported as a timeout: ${result.detail}`).not.toMatch(
        /did not complete within/i,
      );
    },
  );
});
