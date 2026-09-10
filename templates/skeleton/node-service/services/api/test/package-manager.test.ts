import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runPackageManager } from './package-manager.js';

const literalArgs = ['space value', '&|<>^%!()', 'single "double"', ''];

describe('package-manager transport for the artifact fallback', () => {
  let work: string | undefined;

  afterEach(async () => {
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  });

  it('honors the trusted current pnpm CLI on every platform with literal argv and preserves a failing child output', async () => {
    work = await mkdtemp(path.join(tmpdir(), 'artifact-package-manager-'));
    const cli = path.join(work, 'pnpm-cli.cjs');
    await writeFile(
      cli,
      [
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
        "process.stderr.write('artifact transport stderr');",
        'process.exit(7);',
      ].join(''),
    );

    const failure = await runPackageManager(literalArgs, {
      cwd: work,
      env: { ...process.env, npm_execpath: cli },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 7,
      stdout: JSON.stringify(literalArgs),
      stderr: 'artifact transport stderr',
    });
  });
});
