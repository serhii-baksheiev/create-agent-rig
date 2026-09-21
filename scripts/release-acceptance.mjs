#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT = 120_000;
const SPEC_KIT_VERSION = '1.0.8';

export function formatRigFailure(phase, result) {
  const phases = [
    'project-init',
    'spec-kit-add',
    'spec-kit-repeat',
    'spec-kit-doctor',
    'spec-kit-remove',
    'wiring-init',
    'figma-add',
    'atlassian-add',
    'basic-memory-add',
    'basic-memory-remove',
  ];
  const statuses = ['ok', 'failed', 'timeout', 'output-limit', 'cleanup-unconfirmed'];
  const value = result && typeof result === 'object' ? result : {};
  const exit =
    value.exitCode === null
      ? 'none'
      : Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff
        ? String(value.exitCode)
        : 'unknown';
  return `packed-rig-command-failed:${phases.includes(phase) ? phase : 'unknown'}:${statuses.includes(value.status) ? value.status : 'unknown'}:${exit}`;
}

class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const abort = (code) => {
  throw new AcceptanceError(code);
};

function fail(message) {
  process.stderr.write(`release-acceptance: ${message}\n`);
  process.exitCode = 1;
}

async function command(file, args, options = {}) {
  try {
    return await exec(file, args, {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      timeout: TIMEOUT,
      ...options,
    });
  } catch {
    abort('child-command-failed');
  }
}

function npmInvocation() {
  if (process.platform !== 'win32') return { file: 'npm', prefix: [] };
  const cli = process.env.npm_execpath;
  if (cli && path.basename(cli).toLowerCase() === 'npm-cli.js')
    return { file: process.execPath, prefix: [cli] };
  const fallback = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  return { file: process.execPath, prefix: [fallback] };
}

async function npm(args, options) {
  const invocation = npmInvocation();
  return command(invocation.file, [...invocation.prefix, ...args], options);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    abort('invalid-json-response');
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function isSha(value) {
  return /^[0-9a-f]{40}$/i.test(value);
}

async function executablePresent(name) {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extension = process.platform === 'win32' ? '.exe' : '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      await access(path.join(directory, `${name}${extension}`));
      return true;
    } catch {
      // Continue through the machine PATH without executing anything.
    }
  }
  return false;
}

function safeDoctor(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    !['ok', 'warn', 'fail'].includes(value.status) ||
    !Array.isArray(value.checks) ||
    value.checks.length > 128
  )
    abort('doctor-summary-invalid');
  return value.checks.map((check) => {
    if (
      typeof check !== 'object' ||
      check === null ||
      typeof check.id !== 'string' ||
      !['ok', 'warn', 'fail'].includes(check.status)
    )
      abort('doctor-check-invalid');
    return { id: check.id, status: check.status };
  });
}

async function firstSpecKitSkill(root) {
  const skills = path.join(root, '.claude', 'skills');
  const names = await readdir(skills);
  const name = names.find((candidate) => candidate.startsWith('speckit-'));
  if (!name) abort('spec-kit-skill-missing');
  const skill = path.join(skills, name, 'SKILL.md');
  try {
    if (!(await stat(skill)).isFile()) abort('spec-kit-skill-invalid');
  } catch {
    abort('spec-kit-skill-invalid');
  }
  return skill;
}

async function withPackedEnvironment(environment, action) {
  const keys = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'SystemRoot',
    'ProgramFiles',
    'PROGRAMFILES',
    'LANG',
    'LC_ALL',
    'UV_CACHE_DIR',
    'XDG_CACHE_HOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    return await action();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function isolatedEnvironment(scratch) {
  const keep = [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'ComSpec',
    'COMSPEC',
    'ProgramFiles',
    'PROGRAMFILES',
    'LANG',
    'LC_ALL',
  ];
  const environment = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    HOME: path.join(scratch, 'home'),
    USERPROFILE: path.join(scratch, 'home'),
    APPDATA: path.join(scratch, 'appdata'),
    LOCALAPPDATA: path.join(scratch, 'localappdata'),
    TEMP: path.join(scratch, 'tmp'),
    TMP: path.join(scratch, 'tmp'),
    UV_CACHE_DIR: path.join(scratch, 'uv-cache'),
    npm_config_cache: path.join(scratch, 'npm-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--sha' || !isSha(args[1]))
    return fail('invalid candidate SHA');
  const candidate = args[1].toLowerCase();
  const checkout = process.cwd();
  let actual;
  try {
    actual = (await command('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout
      .trim()
      .toLowerCase();
  } catch {
    return fail('checked-out Git HEAD is unavailable');
  }
  if (candidate !== actual) return fail('candidate SHA mismatch');
  try {
    const dirty = await command('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
      cwd: checkout,
    });
    if (dirty.stdout !== '') return fail('tracked checkout is not clean');
  } catch {
    return fail('tracked checkout cannot be inspected');
  }
  if (process.env.CI !== 'true' || process.env.RELEASE_ACCEPTANCE !== '1')
    return fail('real acceptance requires an opted-in CI dispatch');
  if (!(await executablePresent('uv')) || !(await executablePresent('uvx')))
    return fail('uv and uvx are required');

  const scratch = await mkdtemp(path.join(tmpdir(), 'create-agent-rig-release-acceptance-'));
  try {
    const environment = isolatedEnvironment(scratch);
    await Promise.all(
      [
        environment.HOME,
        environment.APPDATA,
        environment.LOCALAPPDATA,
        environment.TEMP,
        environment.UV_CACHE_DIR,
        environment.npm_config_cache,
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    const packed = parseJson(
      (
        await npm(['pack', '--json', '--pack-destination', scratch], {
          cwd: checkout,
          env: environment,
        })
      ).stdout,
    );
    const item = Array.isArray(packed) ? packed[0] : undefined;
    if (
      !item ||
      typeof item.filename !== 'string' ||
      path.basename(item.filename) !== item.filename ||
      !item.filename.endsWith('.tgz') ||
      !Array.isArray(item.files)
    )
      abort('pack-report-invalid');
    if (
      item.files.some(
        (file) =>
          typeof file?.path !== 'string' ||
          /(^|\/)(node_modules|\.specify)(\/|$)|speckit-/i.test(file.path),
      )
    )
      abort('pack-third-party-payload');
    const tarball = path.join(scratch, item.filename);
    const packageHash = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex');
    const prefix = path.join(scratch, 'installed');
    await npm(['install', '--ignore-scripts', '--prefix', prefix, tarball], {
      cwd: scratch,
      env: environment,
    });
    const cli = path.join(
      prefix,
      'node_modules',
      'create-agent-rig',
      'packages',
      'cli',
      'dist',
      'index.js',
    );
    await access(cli);
    const { runProviderProcess } = await import(
      pathToFileURL(
        path.join(
          prefix,
          'node_modules',
          'create-agent-rig',
          'packages',
          'cli',
          'dist',
          'integrations',
          'spawn.js',
        ),
      ).href
    );
    const packedRig = async (cwd, argv) =>
      withPackedEnvironment(environment, async () =>
        runProviderProcess({
          executable: process.execPath,
          // The outer supervisor deliberately strips ProgramFiles from child
          // environments. Restore this machine path for Rig's own nested
          // Windows supervisor; the bootstrap code is fixed, never repo input.
          args: [
            '--input-type=module',
            '-e',
            'import { pathToFileURL } from "node:url"; const [cli, programFiles, ...args] = process.argv.slice(1); if (programFiles) process.env.ProgramFiles = programFiles; process.argv = [process.execPath, cli, ...args]; await import(pathToFileURL(cli).href);',
            cli,
            environment.ProgramFiles ?? environment.PROGRAMFILES ?? '',
            ...argv,
          ],
          repoDir: cwd,
          timeoutMs: 300_000,
          maxOutputBytes: MAX_OUTPUT,
        }),
      );
    const rigCommand = async (phase, cwd, argv) => {
      const result = await packedRig(cwd, argv);
      if (result.status !== 'ok' || result.exitCode !== 0) abort(formatRigFailure(phase, result));
      return result.stdout;
    };
    const rigJson = async (phase, cwd, argv) => parseJson(await rigCommand(phase, cwd, argv));
    const project = path.join(scratch, 'project');
    await command('git', ['init', '--quiet', project], { env: environment });
    await command('git', ['config', 'user.name', 'Release acceptance'], {
      cwd: project,
      env: environment,
    });
    await command('git', ['config', 'user.email', 'release-acceptance@example.test'], {
      cwd: project,
      env: environment,
    });
    const rig = async (phase, ...argv) => rigJson(phase, project, argv);
    await rigCommand('project-init', project, ['init']);
    await command('git', ['-c', 'core.fsmonitor=false', 'add', '-A'], {
      cwd: project,
      env: environment,
    });
    await command('git', ['commit', '--quiet', '-m', 'rig fixture'], {
      cwd: project,
      env: environment,
    });
    const add = await rig(
      'spec-kit-add',
      'setup',
      'add',
      'spec-kit',
      '--harness',
      'claude-code',
      '--harness',
      'codex',
      '--yes',
      '--json',
    );
    if (
      add.outcome !== 'written' ||
      add.observed?.status !== 'ok' ||
      !Array.isArray(add.observed.installedIntegrations) ||
      !add.observed.installedIntegrations.includes('claude') ||
      !add.observed.installedIntegrations.includes('codex')
    )
      abort('spec-kit-authoritative-status-missing');
    const intent = parseJson(
      await readFile(path.join(project, '.rig', 'integrations.json'), 'utf8'),
    );
    const selected =
      Array.isArray(intent.integrations) &&
      intent.integrations.find((entry) => entry.id === 'spec-kit');
    if (
      selected?.version !== SPEC_KIT_VERSION ||
      !selected.harnesses?.includes('claude-code') ||
      !selected.harnesses?.includes('codex')
    )
      abort('spec-kit-intent-missing');
    const marker = await firstSpecKitSkill(project);
    await writeFile(marker, `${await readFile(marker, 'utf8')}\nrelease-acceptance-marker\n`);
    const repeated = await rig(
      'spec-kit-repeat',
      'setup',
      'add',
      'spec-kit',
      '--harness',
      'claude-code',
      '--harness',
      'codex',
      '--yes',
      '--json',
    );
    if (
      repeated.outcome !== 'written' ||
      !repeated.observed?.installedIntegrations?.includes('claude') ||
      !repeated.observed?.installedIntegrations?.includes('codex') ||
      !(await readFile(marker, 'utf8')).includes('release-acceptance-marker')
    )
      abort('spec-kit-repeat-reinitialized');
    const doctor = await rig('spec-kit-doctor', 'doctor', '--json');
    const checks = safeDoctor(doctor);
    if (doctor.specKit?.connectivity !== 'not-observed' || doctor.specKit?.trust !== 'not-observed')
      abort('doctor-trust-or-connectivity-inferred');
    const removeSpecKit = await rig(
      'spec-kit-remove',
      'setup',
      'remove',
      'spec-kit',
      '--yes',
      '--json',
    );
    if (removeSpecKit.outcome !== 'removed') abort('spec-kit-remove-failed');
    const retiredIntent = parseJson(
      await readFile(path.join(project, '.rig', 'integrations.json'), 'utf8'),
    );
    if (
      !Array.isArray(retiredIntent.integrations) ||
      retiredIntent.integrations.some((entry) => entry.id === 'spec-kit') ||
      !(await readFile(marker, 'utf8')).includes('release-acceptance-marker')
    )
      abort('spec-kit-remove-preservation-failed');

    const wiringProject = path.join(scratch, 'wiring-project');
    await command('git', ['init', '--quiet', wiringProject], { env: environment });
    const wiringRig = async (phase, ...argv) => rigJson(phase, wiringProject, argv);
    await rigCommand('wiring-init', wiringProject, ['init']);
    const foreign =
      '{\n  "mcpServers": { "foreign": { "url": "https://example.test/foreign" } }\n}\n';
    await writeFile(path.join(wiringProject, '.mcp.json'), foreign);
    const figma = await wiringRig(
      'figma-add',
      'setup',
      'add',
      'figma-mcp',
      '--harness',
      'claude-code',
      '--harness',
      'codex',
      '--yes',
      '--json',
    );
    if (
      figma.outcome !== 'written' ||
      !(await readFile(path.join(wiringProject, '.mcp.json'), 'utf8')).includes(
        '"foreign": { "url": "https://example.test/foreign" }',
      )
    )
      abort('figma-foreign-preservation-failed');
    const atlassian = await wiringRig(
      'atlassian-add',
      'setup',
      'add',
      'atlassian-mcp',
      '--harness',
      'codex',
      '--yes',
      '--json',
    );
    if (atlassian.outcome !== 'written') abort('atlassian-sequential-wiring-failed');
    const wiringIntent = parseJson(
      await readFile(path.join(wiringProject, '.rig', 'integrations.json'), 'utf8'),
    );
    const codexBytes = await readFile(path.join(wiringProject, '.codex', 'config.toml'));
    if (wiringIntent.targets?.codex?.fileHash !== sha256(codexBytes))
      abort('codex-file-hash-not-rolled');

    const basicData = path.join(environment.HOME, 'basic-memory', 'release-data-sentinel');
    await mkdir(path.dirname(basicData), { recursive: true });
    await writeFile(basicData, 'must-survive-remove\n');
    const basicAdd = await wiringRig(
      'basic-memory-add',
      'setup',
      'add',
      'basic-memory',
      '--harness',
      'claude-code',
      '--harness',
      'codex',
      '--yes',
      '--json',
    );
    if (basicAdd.outcome !== 'written') abort('basic-memory-add-failed');
    const basicRemove = await wiringRig(
      'basic-memory-remove',
      'setup',
      'remove',
      'basic-memory',
      '--yes',
      '--json',
    );
    if (
      basicRemove.outcome !== 'removed' ||
      (await readFile(basicData, 'utf8')) !== 'must-survive-remove\n'
    )
      abort('basic-memory-data-not-preserved');

    const codexPath = path.join(wiringProject, '.codex', 'config.toml');
    const editedCodex = `${await readFile(codexPath, 'utf8')}\n# release acceptance manual edit\n`;
    const beforeConflictIntent = await readFile(
      path.join(wiringProject, '.rig', 'integrations.json'),
    );
    await writeFile(codexPath, editedCodex);
    const conflict = await packedRig(wiringProject, [
      'setup',
      'remove',
      'figma-mcp',
      '--yes',
      '--json',
    ]);
    if (
      conflict.status !== 'failed' ||
      conflict.exitCode === null ||
      (await readFile(codexPath, 'utf8')) !== editedCodex ||
      !Buffer.from(await readFile(path.join(wiringProject, '.rig', 'integrations.json'))).equals(
        beforeConflictIntent,
      )
    )
      abort('codex-manual-edit-not-refused');
    const conflictReport = parseJson(conflict.stdout);
    if (
      conflictReport.outcome !== 'refused' ||
      conflictReport.reason !==
        'codex-config-conflict; managed provider fragment:\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\n'
    )
      abort('codex-manual-fragment-invalid');
    const report = {
      sha: candidate,
      version: item.version,
      providerVersion: SPEC_KIT_VERSION,
      runner: process.env.RUNNER_NAME ?? 'unknown',
      os: `${process.platform}-${process.arch}`,
      packageHash,
      checks,
      doctor: {
        status: doctor.status,
        specKit: { connectivity: 'not-observed', trust: 'not-observed' },
      },
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    fail(error instanceof AcceptanceError ? error.code : 'acceptance-failed');
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
