import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSpecKitLifecycle } from '../src/integrations/spec-kit.js';
import {
  runProviderProcess,
  type ProviderProcessOptions,
  type ProviderProcessResult,
} from '../src/integrations/spawn.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

const SOURCE = 'git+https://github.com/github/spec-kit@v1.0.8';
const PREFIX = ['--from', SOURCE, 'specify'];
const upstreamHarness = {
  claude: ['.claude', 'skills', 'speckit-fake', 'SKILL.md'],
  codex: ['.agents', 'skills', 'speckit-fake', 'SKILL.md'],
} as const;

let repo: string;
let toolsDir: string;
let fake: string;
let stateFile: string;
let calls: ProviderProcessOptions[];
let originalPATH: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rig-spec-kit-'));
  toolsDir = await mkdtemp(path.join(tmpdir(), 'rig-spec-kit-tools-'));
  fake = path.join(toolsDir, 'fake-spec-kit.mjs');
  stateFile = path.join(toolsDir, 'state.json');
  calls = [];

  await writeFile(stateFile, JSON.stringify({ installed: [], status: 'ok', findings: [] }));
  await writeFile(fake, FAKE_SPEC_KIT);
  await installLocalUvLaunchers();
  prependToolsToPath();
  await initGitRepository();
});

afterEach(async () => {
  restorePath();
  await removeFixture(repo);
  await removeFixture(toolsDir);
});

async function installLocalUvLaunchers(): Promise<void> {
  const names = process.platform === 'win32' ? ['uv.exe', 'uvx.exe'] : ['uv', 'uvx'];
  for (const name of names) {
    const file = path.join(toolsDir, name);
    await writeFile(file, 'local fixture launcher');
    if (process.platform !== 'win32') await chmod(file, 0o755);
  }
}

function prependToolsToPath(): void {
  originalPATH = process.env.PATH;
  originalPath = process.env.Path;
  const oldPath = originalPATH ?? originalPath ?? '';
  process.env.PATH = [toolsDir, oldPath].filter(Boolean).join(path.delimiter);
  if (process.platform === 'win32') process.env.Path = process.env.PATH;
}

function restorePath(): void {
  if (originalPATH === undefined) delete process.env.PATH;
  else process.env.PATH = originalPATH;
  if (originalPath === undefined) delete process.env.Path;
  else process.env.Path = originalPath;
}

async function executableOnPath(name: string): Promise<string> {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const entries = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter);
  for (const entry of entries) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Keep looking for the real executable.
      }
    }
  }
  throw new Error(`Could not find ${name} on PATH for the fixture`);
}

async function initGitRepository(): Promise<void> {
  const result = await runProviderProcess({
    executable: await executableOnPath('git'),
    args: ['init', '--quiet'],
    repoDir: repo,
  });
  expect(result.status).toBe('ok');
}

function providerBasename(executable: string): string {
  return path.basename(executable).toLowerCase();
}

function isUv(executable: string): boolean {
  return providerBasename(executable) === (process.platform === 'win32' ? 'uvx.exe' : 'uvx');
}

function isInside(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

async function commitFixturePaths(git: string, paths: string[]): Promise<void> {
  for (const args of [
    ['add', '--', ...paths],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture launchers',
    ],
  ]) {
    expect((await runProviderProcess({ executable: git, args, repoDir: repo })).status).toBe('ok');
  }
}

const trustedRunner: typeof runProviderProcess = async (
  request: ProviderProcessOptions,
): Promise<ProviderProcessResult> => {
  calls.push({ ...request, args: [...request.args] });
  if (!isUv(request.executable)) return runProviderProcess(request);
  return runProviderProcess({
    executable: process.execPath,
    args: [fake, stateFile, ...request.args],
    repoDir: request.repoDir,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
  });
};

async function run(options: {
  operation: 'add' | 'apply' | 'remove';
  harnesses: ('claude-code' | 'codex')[];
  managed: boolean;
  adopt?: boolean;
  consent: boolean;
}) {
  return runSpecKitLifecycle({ repoDir: repo, ...options, runner: trustedRunner });
}

function upstreamCalls(): ProviderProcessOptions[] {
  return calls.filter((call) => isUv(call.executable));
}

async function fakeInvocations(): Promise<string[][]> {
  try {
    return (await readFile(`${stateFile}.calls`, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

async function configureFake(overrides: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
  await writeFile(stateFile, JSON.stringify({ ...current, ...overrides }));
}

async function writeExistingSpecKit(marker = 'foreign upstream payload'): Promise<string> {
  const payload = path.join(repo, '.specify', 'foreign.txt');
  await mkdir(path.dirname(payload), { recursive: true });
  await writeFile(payload, marker);
  return payload;
}

// Windows compiles its fixed Job supervisor (~3 seconds per cold spawn);
// the init/repeat case intentionally runs eight real subprocesses.
describe('runSpecKitLifecycle', { timeout: process.platform === 'win32' ? 60_000 : 15_000 }, () => {
  it('does not inspect git, spawn Spec Kit, or write provider files before consent', async () => {
    const foreign = await writeExistingSpecKit();

    const result = await run({
      operation: 'add',
      harnesses: ['claude-code', 'codex'],
      managed: false,
      consent: false,
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    await expect(readFile(foreign, 'utf8')).resolves.toBe('foreign upstream payload');
  });

  it('initializes a clean repository once, then adds only a missing harness on a later add', async () => {
    const first = await run({
      operation: 'add',
      harnesses: ['claude-code', 'codex'],
      managed: true,
      consent: true,
    });

    expect(first).toMatchObject({
      ok: true,
      observed: { status: 'ok', installedIntegrations: ['claude', 'codex'] },
    });
    expect(upstreamCalls().map((call) => call.args)).toEqual([
      [...PREFIX, 'init', '--here', '--force', '--non-interactive', '--integration', 'claude'],
      [...PREFIX, 'integration', 'install', 'codex'],
      [...PREFIX, 'integration', 'status', '--json'],
    ]);
    expect(await fakeInvocations()).toEqual(upstreamCalls().map((call) => call.args));
    expect(upstreamCalls().every((call) => isUv(call.executable))).toBe(true);

    calls = [];
    await configureFake({ installed: ['claude'] });
    const repeated = await run({
      operation: 'add',
      harnesses: ['claude-code', 'codex'],
      managed: true,
      consent: true,
    });

    expect(repeated).toMatchObject({
      ok: true,
      observed: { status: 'ok', installedIntegrations: ['claude', 'codex'] },
    });
    expect(upstreamCalls().map((call) => call.args)).toEqual([
      [...PREFIX, 'integration', 'status', '--json'],
      [...PREFIX, 'integration', 'install', 'codex'],
      [...PREFIX, 'integration', 'status', '--json'],
    ]);
  });

  it('keeps the uvx launcher pathname when a POSIX PATH symlink targets a differently named executable', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const uvx = path.join(toolsDir, 'uvx');
    const launcher = path.join(toolsDir, 'provider-launcher');
    await writeFile(launcher, 'local fixture launcher');
    await chmod(launcher, 0o755);
    await unlink(uvx);
    await symlink(launcher, uvx, 'file');

    const result = await run({
      operation: 'add',
      harnesses: ['claude-code'],
      managed: true,
      consent: true,
    });

    expect(result).toMatchObject({ ok: true, observed: { installedIntegrations: ['claude'] } });
    expect(upstreamCalls().map((call) => call.executable)).toEqual([uvx, uvx]);
  });

  it('refuses repository-controlled uv and uvx launchers before invoking one', async () => {
    const git = await executableOnPath('git');
    const names = process.platform === 'win32' ? ['uv.exe', 'uvx.exe'] : ['uv', 'uvx'];
    for (const name of names) {
      const launcher = path.join(repo, name);
      await writeFile(launcher, 'repository-controlled launcher');
      if (process.platform !== 'win32') await chmod(launcher, 0o755);
    }
    await commitFixturePaths(git, names);
    process.env.PATH = [repo, path.dirname(git)].join(path.delimiter);
    if (process.platform === 'win32') process.env.Path = process.env.PATH;

    const requestedExecutables: string[] = [];
    const result = await runSpecKitLifecycle({
      repoDir: repo,
      operation: 'add',
      harnesses: ['claude-code'],
      managed: true,
      consent: true,
      runner: async (request) => {
        requestedExecutables.push(await realpath(request.executable));
        return trustedRunner(request);
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'uv-uvx-and-git-required' });
    expect(requestedExecutables.some((executable) => isInside(repo, executable))).toBe(false);
  });

  it('refuses a POSIX PATH launcher symlink resolving into the repository', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const git = await executableOnPath('git');
    for (const name of ['uv', 'uvx']) {
      const target = path.join(repo, name);
      await writeFile(target, 'repository-controlled launcher');
      await chmod(target, 0o755);
      await unlink(path.join(toolsDir, name));
      await symlink(target, path.join(toolsDir, name), 'file');
    }
    await commitFixturePaths(git, ['uv', 'uvx']);
    process.env.PATH = [toolsDir, path.dirname(git)].join(path.delimiter);

    const requestedExecutables: string[] = [];
    const result = await runSpecKitLifecycle({
      repoDir: repo,
      operation: 'add',
      harnesses: ['claude-code'],
      managed: true,
      consent: true,
      runner: async (request) => {
        requestedExecutables.push(await realpath(request.executable));
        return trustedRunner(request);
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'uv-uvx-and-git-required' });
    expect(requestedExecutables.some((executable) => isInside(repo, executable))).toBe(false);
  });

  it('refuses a repository subdirectory before invoking Spec Kit', async () => {
    const nested = path.join(repo, 'nested');
    await mkdir(nested);

    const result = await runSpecKitLifecycle({
      repoDir: nested,
      operation: 'add',
      harnesses: ['claude-code'],
      managed: true,
      consent: true,
      runner: trustedRunner,
    });

    expect(result).toMatchObject({ ok: false, reason: 'repository-root-required' });
    expect(upstreamCalls()).toEqual([]);
  });

  it('requires explicit adoption before touching an external .specify payload', async () => {
    const foreign = await writeExistingSpecKit();

    const result = await run({
      operation: 'add',
      harnesses: ['claude-code', 'codex'],
      managed: false,
      consent: true,
    });

    expect(result.ok).toBe(false);
    expect(upstreamCalls()).toEqual([]);
    await expect(readFile(foreign, 'utf8')).resolves.toBe('foreign upstream payload');
  });

  it('adopts an external .specify payload by checking status, adding only what is missing, and checking status again', async () => {
    const foreign = await writeExistingSpecKit();
    await configureFake({ installed: ['claude'] });
    const git = await executableOnPath('git');
    for (const args of [
      ['add', '--', '.specify'],
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--quiet',
        '-m',
        'upstream fixture',
      ],
    ]) {
      expect((await runProviderProcess({ executable: git, args, repoDir: repo })).status).toBe(
        'ok',
      );
    }

    const result = await run({
      operation: 'add',
      harnesses: ['claude-code', 'codex'],
      managed: false,
      adopt: true,
      consent: true,
    });

    expect(result).toMatchObject({
      ok: true,
      observed: { status: 'ok', installedIntegrations: ['claude', 'codex'] },
    });
    expect(upstreamCalls().map((call) => call.args)).toEqual([
      [...PREFIX, 'integration', 'status', '--json'],
      [...PREFIX, 'integration', 'install', 'codex'],
      [...PREFIX, 'integration', 'status', '--json'],
    ]);
    await expect(readFile(foreign, 'utf8')).resolves.toBe('foreign upstream payload');
  });

  it.each([
    ['an uninitialized repository', false, undefined],
    ['an external payload being adopted', false, true],
  ])('refuses dirty %s after consent before spawning upstream', async (_name, managed, adopt) => {
    if (adopt) await writeExistingSpecKit();
    await writeFile(path.join(repo, 'uncommitted.txt'), 'dirty');

    const result = await run({
      operation: 'add',
      harnesses: ['claude-code'],
      managed,
      adopt,
      consent: true,
    });

    expect(result.ok).toBe(false);
    expect(upstreamCalls()).toEqual([]);
    expect(calls.some((call) => providerBasename(call.executable).startsWith('git'))).toBe(true);
  });

  it('applies official no-force upgrades and preserves upstream-owned payloads', async () => {
    const foreign = await writeExistingSpecKit();
    await configureFake({ installed: ['claude', 'codex'] });

    const result = await run({
      operation: 'apply',
      harnesses: ['claude-code', 'codex'],
      managed: true,
      consent: true,
    });

    expect(result).toMatchObject({ ok: true, observed: { status: 'ok' } });
    expect(upstreamCalls().map((call) => call.args)).toEqual([
      [...PREFIX, 'integration', 'upgrade', 'claude'],
      [...PREFIX, 'integration', 'upgrade', 'codex'],
      [...PREFIX, 'integration', 'status', '--json'],
    ]);
    expect(upstreamCalls().flatMap((call) => call.args)).not.toContain('--force');
    await expect(readFile(foreign, 'utf8')).resolves.toBe('foreign upstream payload');
  });

  it('removes harnesses only through official no-force uninstalls, then returns the final status', async () => {
    const foreign = await writeExistingSpecKit();
    await configureFake({ installed: ['claude', 'codex'] });
    for (const segments of Object.values(upstreamHarness)) {
      const fixture = path.join(repo, ...segments);
      await mkdir(path.dirname(fixture), { recursive: true });
      await writeFile(fixture, 'created by upstream');
    }

    const result = await run({
      operation: 'remove',
      harnesses: ['claude-code', 'codex'],
      managed: true,
      consent: true,
    });

    expect(result).toMatchObject({
      ok: true,
      observed: { status: 'ok', installedIntegrations: [] },
    });
    expect(upstreamCalls().map((call) => call.args)).toEqual([
      [...PREFIX, 'integration', 'uninstall', 'claude'],
      [...PREFIX, 'integration', 'uninstall', 'codex'],
      [...PREFIX, 'integration', 'status', '--json'],
    ]);
    expect(upstreamCalls().flatMap((call) => call.args)).not.toContain('--force');
    await expect(readFile(foreign, 'utf8')).resolves.toBe('foreign upstream payload');
    for (const segments of Object.values(upstreamHarness)) {
      await expect(access(path.join(repo, ...segments))).rejects.toThrow();
    }
  });

  it('treats the upstream missing integration state as successful after removing the final requested harness', async () => {
    await writeExistingSpecKit();
    await configureFake({
      installed: ['claude'],
      status: 'error',
      findings: [{ severity: 'error', code: 'integration-state-missing' }],
      statusExitCode: 1,
    });

    const result = await run({
      operation: 'remove',
      harnesses: ['claude-code'],
      managed: true,
      consent: true,
    });

    expect(result).toMatchObject({
      ok: true,
      observed: {
        status: 'error',
        installedIntegrations: [],
        findings: [{ severity: 'error', code: 'integration-state-missing' }],
      },
    });
    expect(upstreamCalls().map((call) => call.args)).toEqual([
      [...PREFIX, 'integration', 'uninstall', 'claude'],
      [...PREFIX, 'integration', 'status', '--json'],
    ]);
  });

  it('still refuses an unrelated final upstream error after removal', async () => {
    await writeExistingSpecKit();
    await configureFake({
      installed: ['claude'],
      status: 'error',
      findings: [{ severity: 'error', code: 'unrelated-upstream-error' }],
      statusExitCode: 1,
    });

    const result = await run({
      operation: 'remove',
      harnesses: ['claude-code'],
      managed: true,
      consent: true,
    });

    expect(result).toMatchObject({ ok: false, reason: 'upstream-incomplete-use-adopt-and-status' });
  });

  it.each([
    ['warning status', { status: 'warning' }],
    ['error status', { status: 'error' }],
    ['partial harness observation', { reportedInstalled: ['claude'] }],
    ['invalid JSON status', { invalidStatus: true }],
  ])('does not report an add as successful after a %s', async (_name, fakeState) => {
    await configureFake(fakeState);

    const result = await run({
      operation: 'add',
      harnesses: ['claude-code', 'codex'],
      managed: true,
      consent: true,
    });

    expect(result.ok).toBe(false);
    expect(upstreamCalls().at(-1)?.args).toEqual([...PREFIX, 'integration', 'status', '--json']);
  });
});

// This is an executable stand-in for the official provider. The lifecycle
// adapter must still invoke it through runProviderProcess; the runner seam
// only replaces the trusted, locally discovered uvx binary with Node.
const FAKE_SPEC_KIT = String.raw`
import { appendFile, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(await readFile(stateFile, 'utf8'));
const root = process.cwd();
const prefixEnd = args.indexOf('specify');
const command = args[prefixEnd + 1];
const rest = args.slice(prefixEnd + 2);
await appendFile(stateFile + '.calls', JSON.stringify(args) + '\n');

const save = () => writeFile(stateFile, JSON.stringify(state));
const skill = (id) =>
  id === 'claude'
    ? path.join(root, '.claude', 'skills', 'speckit-fake', 'SKILL.md')
    : path.join(root, '.agents', 'skills', 'speckit-fake', 'SKILL.md');
const install = async (id) => {
  if (!state.installed.includes(id)) state.installed.push(id);
  const file = skill(id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'fake upstream ' + id);
};
const uninstall = async (id) => {
  state.installed = state.installed.filter((item) => item !== id);
  await unlink(skill(id)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(path.dirname(skill(id))).catch((error) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  });
};

if (command === 'init') {
  await mkdir(path.join(root, '.specify'), { recursive: true });
  await writeFile(path.join(root, '.specify', 'created-by-fake'), 'upstream');
  await install(rest[rest.indexOf('--integration') + 1]);
  await save();
  process.exit(0);
}
if (command === 'integration' && rest[0] === 'install') {
  await install(rest[1]);
  await save();
  process.exit(0);
}
if (command === 'integration' && rest[0] === 'uninstall') {
  await uninstall(rest[1]);
  await save();
  process.exit(0);
}
if (command === 'integration' && rest[0] === 'upgrade') process.exit(0);
if (command === 'integration' && rest[0] === 'status' && rest[1] === '--json') {
  if (state.invalidStatus) process.stdout.write('not JSON');
  else {
    process.stdout.write(JSON.stringify({
      status: state.status,
      installed_integrations: state.reportedInstalled ?? state.installed,
      findings: state.findings,
    }));
  }
  process.exit(state.statusExitCode ?? 0);
}
process.stderr.write('unexpected fake Spec Kit invocation: ' + JSON.stringify(args));
process.exit(23);
`;
