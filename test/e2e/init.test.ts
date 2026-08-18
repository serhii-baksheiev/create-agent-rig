import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-e2e-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function runInit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, 'init', ...args], {
      cwd: repo,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('create-agent-rig init (into an existing repo)', () => {
  it('installs the process layer and leaves architecture rules out', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit([]);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toContain(
      'TDD',
    );
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'architecture.md')),
    ).rejects.toThrow();
  });

  it('a dry run writes nothing', async () => {
    const result = await runInit(['--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/dry run/i);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
  });

  it('leaves a rig whose hooks are wired and whose scripts parse', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runInit([])).code).toBe(0);

    const settings = JSON.parse(
      await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);

    const hooks = await readdir(path.join(repo, '.claude', 'hooks'));
    expect(hooks.sort()).toEqual(
      ['block-no-verify.mjs', 'gate-stop-dod.mjs', 'guard-bash.mjs', 'inject-rules.mjs'].sort(),
    );
    for (const hook of hooks) {
      await exec(process.execPath, ['--check', path.join(repo, '.claude', 'hooks', hook)]);
    }

    // the kill switch is a filename: an unsubstituted token means the brake
    // looks for a file the operator will never create
    const stopFlag = await readFile(path.join(repo, '.claude', 'scripts', 'stop-flag.mjs'), 'utf8');
    expect(stopFlag).toContain(`${path.basename(repo).toLowerCase()}-loop-STOP`);
    expect(stopFlag).not.toContain('__PROJECT_NAME__');
  });

  it('tells the operator when it could not wire the hooks itself', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{}');
    const result = await runInit([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/settings\.json/);
    expect(result.stdout).toMatch(/not wired|merge/i);
    expect(await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{}');
  });

  it('refuses to clobber an existing CLAUDE.md, as a message not a trace', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# host rules');
    const result = await runInit([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/CLAUDE\.md/);
    expect(result.stderr).not.toMatch(/at .*init\.js/);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# host rules');
  });
});

// Running `init` inside a rig `create` produced is legitimate — someone
// refreshing the process layer by hand does exactly that — but `init` is not
// the command that maintains that rig: it installs the process layer only and
// keeps every file it did not write, so the stack overlays and the
// architecture rules are untouched by design. A run that reports nothing but
// "Installed N files" reads as a full refresh, and the operator walks away
// believing their rig is current when only part of it is. `upgrade` is the
// command that brings the whole install set forward.
describe('create-agent-rig init (inside a rig that came from `create`)', () => {
  const runCliIn = async (
    cwd: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  /** Every output line that carries the advisory — it is meant to be one. */
  const advisoryLines = (stdout: string): string[] =>
    stdout.split('\n').filter((line) => /created by create-agent-rig/i.test(line));

  /** A generated project, as `create` leaves it. */
  const generate = async (): Promise<string> => {
    const result = await runCliIn(repo, ['my-app', '--target', 'node-service', '--no-git']);
    expect(result.code, result.stderr).toBe(0);
    return path.join(repo, 'my-app');
  };

  // `--force` used to be the way into a created rig. It is refused now, and
  // this is the only level that can see both halves of that: the message a
  // human reads, and the exit code a script branches on.
  it('refuses `--force` with the command that does refresh a rig, and exits non-zero', async () => {
    const project = await generate();
    const claudeMd = await readFile(path.join(project, 'CLAUDE.md'), 'utf8');

    const forced = await runCliIn(project, ['init', '--force']);

    expect(forced.code).not.toBe(0);
    expect(`${forced.stdout}${forced.stderr}`).toContain(
      'deprecated — init --force replaced only CLAUDE.md; run create-agent-rig upgrade instead',
    );
    // and it wrote nothing — starting with the one file it used to replace
    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf8')).toBe(claudeMd);
  });

  it('points the operator at `upgrade` when it re-installs over a created rig', async () => {
    const project = await generate();
    // The way in is a deleted CLAUDE.md: that is what lifts `init`'s refusal now
    // that `--force` is refused outright.
    await rm(path.join(project, 'CLAUDE.md'));
    const forced = await runCliIn(project, ['init']);
    expect(forced.code, forced.stderr).toBe(0);

    // the fixture really is a create rig that init has just run inside
    const manifest = JSON.parse(
      await readFile(path.join(project, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { kind: string };
    expect(manifest.kind).toBe('create');
    expect(forced.stdout).toMatch(/Installed \d+ files/);

    const advisory = advisoryLines(forced.stdout);
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toMatch(/only fills gaps/i);
    expect(advisory[0]).toMatch(/upgrade/);
  });

  it('says nothing of the sort in a repo that has no rig at all', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runCliIn(repo, ['init']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Installed \d+ files/);
    expect(advisoryLines(result.stdout)).toEqual([]);
    expect(result.stdout).not.toMatch(/use `?upgrade`? to refresh/i);
  });

  // The two tests above pin "never" and "over a create rig", which a condition
  // of merely `manifest !== null` also satisfies — and that condition would tell
  // every re-`init`ed rig it came from `create`. This is the case that separates
  // them.
  it('stays quiet when it re-installs over a rig `init` itself put there', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const first = await runCliIn(repo, ['init']);
    expect(first.code, first.stderr).toBe(0);

    // The re-install needs a way past the CLAUDE.md refusal, and `--force` is no
    // longer one. Deleting it is what the refusal is actually about — the file,
    // not the flag — and it leaves the manifest this test reads untouched.
    await rm(path.join(repo, 'CLAUDE.md'));
    const second = await runCliIn(repo, ['init']);
    expect(second.code, second.stderr).toBe(0);

    // the fixture is what the test claims: a manifest exists, and it says `init`
    const manifest = JSON.parse(
      await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { kind: string };
    expect(manifest.kind).toBe('init');
    expect(advisoryLines(second.stdout)).toEqual([]);
  });
});
