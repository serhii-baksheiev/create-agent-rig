import { execFile } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'release-acceptance.mjs');

let fixture: string;

beforeEach(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'caf-release-acceptance-'));
  await writeFile(path.join(fixture, 'fixture.txt'), 'unchanged fixture\n');
  await exec('git', ['init', '--quiet'], { cwd: fixture });
  await exec('git', ['add', '--', 'fixture.txt'], { cwd: fixture });
  await exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: fixture },
  );
});

afterEach(async () => {
  await removeFixture(fixture);
});

async function head(): Promise<string> {
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: fixture })).stdout.trim();
}

async function run(candidate: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, '--sha', candidate], {
      cwd: fixture,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

async function fixtureList(): Promise<string[]> {
  return (await readdir(fixture)).sort();
}

describe('release acceptance candidate preflight', () => {
  it('rejects an invalid candidate SHA before packing or mutating its fixture', async () => {
    const before = await fixtureList();

    const result = await run('not-a-sha');

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'release-acceptance: invalid candidate SHA\n',
    });
    expect(await fixtureList()).toEqual(before);
  });

  it('rejects a well-formed candidate SHA that does not match the checked-out Git HEAD before packing or mutating its fixture', async () => {
    const actual = await head();
    const candidate = actual === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40);
    const before = await fixtureList();

    const result = await run(candidate);

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'release-acceptance: candidate SHA mismatch\n',
    });
    expect(await fixtureList()).toEqual(before);
  });
});
