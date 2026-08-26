import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-139 — the test harness scrubs `RIG_RUN_DIR`, and preflight refuses one
 * already exported.
 *
 * Measured: a session that had exported the variable for its own calls ran the
 * suite; every test that spawns the queue CLI inherited it, the real run's
 * append-only trace received 38 fixture item-selection records and 22 fixture
 * revalidation events, and two tests exited 1 — misdiagnosed as load.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const load = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);

const runNode = (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) =>
    execFile(process.execPath, args, { cwd: repoRoot, env }, (e, out, err) =>
      resolve({ code: e && typeof e.code === 'number' ? e.code : 0, stdout: out, stderr: err }),
    ),
  );

describe('the harness scrubs RIG_RUN_DIR before any test runs', () => {
  it('a test sees no RIG_RUN_DIR, and neither does a child it spawns', async () => {
    expect(process.env.RIG_RUN_DIR).toBeUndefined();
    const child = await runNode(['-e', 'process.stdout.write(String(process.env.RIG_RUN_DIR))'], {
      ...process.env,
    });
    expect(child.stdout).toBe('undefined');
  });

  it('holds with the variable exported around the whole vitest process', async () => {
    // A nested vitest, filtered to the in-process test above, with the variable
    // exported the way a session's `export` leaks it. Skipped inside that child
    // so the nesting stops at one level.
    if (process.env.RIG_SCRUB_TEST_CHILD) return;
    const result = await runNode(
      [
        path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--project',
        'template',
        'test/template/rig-run-dir-scrub.test.ts',
        '-t',
        'sees no RIG_RUN_DIR',
      ],
      { ...process.env, RIG_RUN_DIR: '/leaked/from/a/session', RIG_SCRUB_TEST_CHILD: '1' },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/1 passed/);
  }, 120_000);

  it('is wired for every vitest project, so no lane inherits it', async () => {
    const config = await readFile(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
    const projects = config.match(/name: '(\w+)'/g) ?? [];
    expect(projects.length).toBeGreaterThanOrEqual(3);
    const setups = config.match(/setupFiles: \['test\/setup-env\.ts'\]/g) ?? [];
    expect(setups, 'each project names the setup file').toHaveLength(projects.length);
  });
});

describe('preflight refuses a RIG_RUN_DIR that is already exported', () => {
  it('reports it as a hard failure, naming the leak, and passes when the variable is absent', async () => {
    const { checkRunDirNotExported, verdictOf } = await load('preflight.mjs');
    const leaked = checkRunDirNotExported({ RIG_RUN_DIR: '/leaked/from/a/session' });
    expect(leaked.ok).toBe(false);
    expect(leaked.detail).toMatch(/\/leaked\/from\/a\/session/);
    expect(leaked.detail).toMatch(/unset/);
    expect(verdictOf({ runDirNotExported: leaked })).toBe('STOP');
    expect(checkRunDirNotExported({})).toMatchObject({ ok: true });
    expect(checkRunDirNotExported({ RIG_RUN_DIR: '' })).toMatchObject({ ok: true });
  });

  it('is one of the items the script walks, so the block names it', async () => {
    const result = await runNode([path.join(scriptsDir, 'preflight.mjs'), '--json'], {
      ...process.env,
      RIG_RUN_DIR: '/leaked/from/a/session',
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.checks.runDirNotExported).toMatchObject({ ok: false });
    expect(parsed.verdict).toBe('STOP');
  }, 60_000);
});
