import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const planAdapter = pathToFileURL(
  path.join(
    repoRoot,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'scripts',
    'queue',
    'plan-md.mjs',
  ),
).href;

const PLAN = '# P\n\n## Agent queue\n\n- remove me\n\n## Journal\n';

// A child owns the mutable built-in fs export, so this test cannot leak its
// readback seam into a concurrently executing template test.
const CHILD = String.raw`
  import { createRequire, syncBuiltinESMExports } from 'node:module';
  import path from 'node:path';

  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const originalReadFileSync = fs.readFileSync;
  const planPath = process.env.RP520_PLAN_PATH;
  const mode = process.env.RP520_PLAN_READBACK_MODE;
  let reads = 0;
  let before = null;

  fs.readFileSync = (...args) => {
    if (path.resolve(String(args[0])) !== path.resolve(planPath)) return originalReadFileSync(...args);
    reads += 1;
    if (reads === 1) {
      before = originalReadFileSync(...args);
      return before;
    }
    if (mode === 'stale') return before;
    throw new Error('post-write plan readback unavailable');
  };
  syncBuiltinESMExports();

  try {
    const { close } = await import(process.env.RP520_PLAN_ADAPTER + '?rp520-plan-readback=' + mode);
    const result = await close({ id: '1' }, { planPath });
    console.log(JSON.stringify({ result, persisted: originalReadFileSync(planPath, 'utf8'), reads }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, persisted: originalReadFileSync(planPath, 'utf8'), reads }));
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
`;

describe('plan-md close verifies the post-write readback', () => {
  it.each(['stale', 'throws'] as const)(
    'returns a typed failed close when its post-write readback is %s',
    async (mode) => {
      const dir = await mkdtemp(path.join(tmpdir(), `rp520-plan-${mode}-`));
      const planPath = path.join(dir, 'PLAN.md');
      try {
        await writeFile(planPath, PLAN);
        const { stdout } = await execFileAsync(
          process.execPath,
          ['--input-type=module', '--eval', CHILD],
          {
            env: {
              ...process.env,
              RP520_PLAN_ADAPTER: planAdapter,
              RP520_PLAN_PATH: planPath,
              RP520_PLAN_READBACK_MODE: mode,
            },
          },
        );
        const observed = JSON.parse(stdout) as {
          result?: { ok: boolean; transitioned: boolean; reason?: string };
          error?: string;
          persisted: string;
          reads: number;
        };

        expect(observed.error).toBeUndefined();
        expect(observed.result).toMatchObject({
          ok: false,
          transitioned: false,
          reason: expect.any(String),
        });
        expect(observed.persisted).not.toContain('- remove me');
        expect(observed.reads).toBe(2);
        expect(await readFile(planPath, 'utf8')).toBe(observed.persisted);
      } finally {
        await removeFixture(dir);
      }
    },
  );
});
