import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-288 — test/setup-env.ts scrubs RIG_RUN_DIR (AR-139) but not
 * CLAUDE_PROJECT_DIR. A session that exports CLAUDE_PROJECT_DIR for its own
 * calls (the loop skill, a manual `unattended-flag.mjs on --root` probe)
 * leaks it into every test that builds its own env() from process.env —
 * test/template/unattended-flag.test.ts's `env()`/`scopedEnv` helpers being
 * the measured case: 8 of its tests fail when CLAUDE_PROJECT_DIR is exported
 * in the invoking shell, because the checkout-scoped flag those tests expect
 * to be scoped only to a fixture HOME is instead ALSO written/read against
 * whatever checkout CLAUDE_PROJECT_DIR names.
 *
 * Same shape as test/template/rig-run-dir-scrub.test.ts (AR-139): a nested
 * vitest process, filtered to the single in-process assertion below, with the
 * variable exported the way a session's own `export` leaks it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const runNode = (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) =>
    execFile(process.execPath, args, { cwd: repoRoot, env }, (e, out, err) =>
      resolve({ code: e && typeof e.code === 'number' ? e.code : 0, stdout: out, stderr: err }),
    ),
  );

describe('the harness scrubs CLAUDE_PROJECT_DIR before any test runs', () => {
  it('a test sees no CLAUDE_PROJECT_DIR, and neither does a child it spawns', async () => {
    expect(process.env.CLAUDE_PROJECT_DIR).toBeUndefined();
    const child = await runNode(
      ['-e', 'process.stdout.write(String(process.env.CLAUDE_PROJECT_DIR))'],
      { ...process.env },
    );
    expect(child.stdout).toBe('undefined');
  });

  it('holds with the variable exported around the whole vitest process', async () => {
    // A nested vitest, filtered to the in-process test above, with the
    // variable exported the way a session's `export` leaks it. Skipped
    // inside that child so the nesting stops at one level — same guard
    // rig-run-dir-scrub.test.ts uses, and the same reason
    // unattended-flag-leak-audit.ts's own auditFor() skips the RP-271 audit
    // for this marker.
    if (process.env.RIG_SCRUB_TEST_CHILD) return;
    const result = await runNode(
      [
        path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--project',
        'template',
        'test/template/claude-project-dir-scrub.test.ts',
        '-t',
        'sees no CLAUDE_PROJECT_DIR',
      ],
      {
        ...process.env,
        CLAUDE_PROJECT_DIR: '/leaked/from/a/session',
        RIG_SCRUB_TEST_CHILD: '1',
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/1 passed/);
  }, 120_000);
});
