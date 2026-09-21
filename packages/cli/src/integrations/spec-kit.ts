import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveReadableInside } from '../lib/safe-path.js';
import { isPlainObject } from '../lib/safe-text.js';
import { runProviderProcess, type ProviderProcessResult } from './spawn.js';

export const SPEC_KIT_VERSION = '1.0.8';
const SOURCE = `git+https://github.com/github/spec-kit@v${SPEC_KIT_VERSION}`;
const PREFIX = ['--from', SOURCE, 'specify'];
// v1.0.8's status vocabulary. Unknown upstream strings never reach diagnostics.
const STATUS_CODES = new Set([
  'default-integration-missing',
  'default-integration-not-installed',
  'installed-integrations-invalid',
  'integration-key-invalid',
  'integration-state-missing',
  'integration-state-unreadable',
  'managed-file-collision',
  'managed-files-missing',
  'managed-files-modified',
  'manifest-missing',
  'manifest-paths-invalid',
  'manifest-unreadable',
  'no-installed-integrations',
  'project-root-unresolved',
  'unknown-integration',
  'unsafe-multi-install',
]);
type Harness = 'claude-code' | 'codex';
type UpstreamHarness = 'claude' | 'codex';
type Observation = {
  status: 'ok' | 'warning' | 'error';
  installedIntegrations: string[];
  findings: { code: string; severity: string }[];
};
export type SpecKitResult = {
  ok: boolean;
  reason?: string;
  observed?: Observation;
  plan: string[];
};
export type SpecKitOptions = {
  repoDir: string;
  operation: 'add' | 'apply' | 'remove';
  harnesses: Harness[];
  managed: boolean;
  adopt?: boolean;
  consent: boolean;
  runner?: typeof runProviderProcess;
};

async function locate(
  name: 'uv' | 'uvx' | 'git',
  repoDir: string,
  env = process.env,
): Promise<string | undefined> {
  const root = await realpath(repoDir);
  const inside = (file: string) => {
    const relative = path.relative(root, file);
    return (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  };
  const filename = process.platform === 'win32' ? `${name}.exe` : name;
  for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const candidate = path.join(directory, filename);
      const file = await realpath(candidate);
      if (inside(candidate) || inside(file)) continue;
      if (!(await stat(file)).isFile()) continue;
      await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      /* Try the next machine PATH entry, never the repository. */
    }
  }
  return undefined;
}

export type SpecKitInspection = {
  status: 'pass' | 'warn' | 'fail';
  reason: string;
  launcher: 'observed' | 'missing';
  runtime: 'verified' | 'unverified';
  observed?: Observation;
};

/** Only the official read-only status command; network and Python downloads disabled. */
export async function inspectSpecKit(options: {
  repoDir: string;
  harnesses: Harness[];
  env?: NodeJS.ProcessEnv;
  runner?: typeof runProviderProcess;
}): Promise<SpecKitInspection> {
  const uvx = await locate('uvx', options.repoDir, options.env);
  if (!uvx)
    return {
      status: 'warn',
      reason: 'upstream-status-unavailable',
      launcher: 'missing',
      runtime: 'unverified',
    };
  const result = await (options.runner ?? runProviderProcess)({
    executable: uvx,
    args: [
      '--offline',
      '--no-config',
      '--no-python-downloads',
      ...PREFIX,
      'integration',
      'status',
      '--json',
    ],
    repoDir: options.repoDir,
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
  });
  if (result.status === 'cleanup-unconfirmed')
    return {
      status: 'fail',
      reason: 'upstream-cleanup-unconfirmed',
      launcher: 'observed',
      runtime: 'unverified',
    };
  const observed = observe(result);
  if (observed === undefined)
    return {
      status: result.status === 'failed' ? 'warn' : 'fail',
      reason: 'upstream-status-unavailable',
      launcher: 'observed',
      runtime: 'unverified',
    };
  const complete = options.harnesses.every((harness) =>
    observed.installedIntegrations.includes(harness === 'claude-code' ? 'claude' : 'codex'),
  );
  const status =
    observed.status === 'error' || result.exitCode !== 0
      ? 'fail'
      : observed.status === 'warning' || !complete
        ? 'warn'
        : 'pass';
  return {
    status,
    reason: !complete ? 'upstream-harness-status-incomplete' : `upstream-status-${observed.status}`,
    launcher: 'observed',
    runtime: 'verified',
    observed,
  };
}

function observe(result: ProviderProcessResult): Observation | undefined {
  if (result.status !== 'ok' && result.status !== 'failed') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (
    !isPlainObject(value) ||
    !['ok', 'warning', 'error'].includes(String(value.status)) ||
    !Array.isArray(value.installed_integrations) ||
    value.installed_integrations.length > 64 ||
    !value.installed_integrations.every(
      (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id),
    )
  )
    return undefined;
  // Diagnosis keeps finite codes, not upstream free text that could contain
  // credentials. Rig never persists this observed runtime state as intent.
  const findings = Array.isArray(value.findings)
    ? value.findings.flatMap((finding: unknown) =>
        isPlainObject(finding) &&
        typeof finding.code === 'string' &&
        STATUS_CODES.has(finding.code) &&
        ['info', 'warning', 'error'].includes(String(finding.severity))
          ? [{ code: finding.code, severity: String(finding.severity) }]
          : [],
      )
    : [];
  if (!Array.isArray(value.findings) || findings.length !== value.findings.length) return undefined;
  return {
    status: value.status as Observation['status'],
    installedIntegrations: value.installed_integrations.filter(
      (id) => id === 'claude' || id === 'codex',
    ),
    findings,
  };
}

export async function runSpecKitLifecycle(options: SpecKitOptions): Promise<SpecKitResult> {
  const plan = [
    `Spec Kit ${SPEC_KIT_VERSION}; requires local uv, uvx and git, invoked from the repository root. Downloads the official pinned source and dependencies into the uv cache; no global tool installation.`,
    `uvx --from ${SOURCE} specify`,
    'Configure integration files without checking whether Claude Code or Codex is installed; this does not verify harness runtime or trust.',
  ];
  const refuse = (reason: string, observed?: Observation): SpecKitResult => ({
    ok: false,
    reason,
    plan,
    ...(observed === undefined ? {} : { observed }),
  });
  if (
    !options.harnesses.length ||
    new Set(options.harnesses).size !== options.harnesses.length ||
    options.harnesses.some((harness) => harness !== 'claude-code' && harness !== 'codex')
  )
    return refuse('invalid-harness-selection');
  const harnesses: UpstreamHarness[] = options.harnesses.map((harness) =>
    harness === 'claude-code' ? 'claude' : 'codex',
  );
  const project = await resolveReadableInside(options.repoDir, '.specify', 'directory');
  if (project.status !== 'ok' && project.status !== 'absent')
    return refuse('spec-kit-project-path-unsafe');
  const initialized = project.status === 'ok';
  if (options.operation === 'add' && !initialized) {
    plan.push(
      `init --here --force --non-interactive --ignore-agent-tools --integration ${harnesses[0]}`,
      ...harnesses.slice(1).map((harness) => `integration install ${harness}`),
    );
  } else if (options.operation === 'add') {
    plan.push(
      'integration status --json',
      ...harnesses.map((harness) => `integration install ${harness} (only if absent from status)`),
    );
  } else {
    plan.push(
      ...harnesses.map(
        (harness) =>
          `integration ${options.operation === 'apply' ? 'upgrade' : 'uninstall'} ${harness}`,
      ),
    );
  }
  plan.push('integration status --json');
  if (!options.consent) return refuse('consent-required');
  if (initialized && !options.managed && !options.adopt)
    return refuse('explicit-adoption-required');
  if (options.operation !== 'add' && (!initialized || !options.managed))
    return refuse('managed-spec-kit-project-required');
  const [uv, uvx, git] = await Promise.all([
    locate('uv', options.repoDir),
    locate('uvx', options.repoDir),
    locate('git', options.repoDir),
  ]);
  if (!uv || !uvx || !git) return refuse('uv-uvx-and-git-required');
  const runner = options.runner ?? runProviderProcess;
  const invoke = (executable: string, args: string[]) =>
    runner({
      executable,
      args,
      repoDir: options.repoDir,
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });
  const upstream = (args: string[]) => invoke(uvx, [...PREFIX, ...args]);
  const succeeded = (result: ProviderProcessResult) =>
    result.status === 'ok' && result.exitCode === 0;
  const root = await invoke(git, ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel']);
  if (!succeeded(root)) return refuse('repository-root-required');
  try {
    if (path.relative(await realpath(options.repoDir), await realpath(root.stdout.trim())) !== '')
      return refuse('repository-root-required');
  } catch {
    return refuse('repository-root-required');
  }
  if (!initialized || !options.managed) {
    const dirty = await invoke(git, [
      '-c',
      'core.fsmonitor=false',
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (!succeeded(dirty)) return refuse('git-status-unavailable');
    if (dirty.stdout.trim()) return refuse('dirty-initialization-or-adoption-refused');
  }
  const commands: string[][] = [];
  if (options.operation === 'add' && !initialized) {
    commands.push(
      [
        'init',
        '--here',
        '--force',
        '--non-interactive',
        '--ignore-agent-tools',
        '--integration',
        harnesses[0]!,
      ],
      ...harnesses.slice(1).map((harness) => ['integration', 'install', harness]),
    );
  } else if (options.operation === 'add') {
    const status = await upstream(['integration', 'status', '--json']);
    const current = observe(status);
    if (!succeeded(status) || current?.status !== 'ok')
      return refuse('upstream-status-not-ready', current);
    commands.push(
      ...harnesses
        .filter((harness) => !current.installedIntegrations.includes(harness))
        .map((harness) => ['integration', 'install', harness]),
    );
  } else {
    commands.push(
      ...harnesses.map((harness) => [
        'integration',
        options.operation === 'apply' ? 'upgrade' : 'uninstall',
        harness,
      ]),
    );
  }
  let partial = false;
  for (const command of commands) {
    const result = await upstream(command);
    if (result.status === 'cleanup-unconfirmed') return refuse('upstream-cleanup-unconfirmed');
    if (!succeeded(result)) {
      partial = true;
      break;
    }
  }
  const status = await upstream(['integration', 'status', '--json']);
  const observed = observe(status);
  // v1.0.8 removes integration.json after the last successful uninstall.
  // Its authoritative status then exits 1 with this exact empty-state finding.
  if (
    options.operation === 'remove' &&
    !partial &&
    status.status === 'failed' &&
    status.exitCode === 1 &&
    observed?.status === 'error' &&
    observed.installedIntegrations.length === 0 &&
    observed.findings.length === 1 &&
    observed.findings[0]?.code === 'integration-state-missing' &&
    observed.findings[0]?.severity === 'error'
  )
    return { ok: true, observed, plan };
  if (partial || !succeeded(status) || observed?.status !== 'ok')
    return refuse('upstream-incomplete-use-adopt-and-status', observed);
  const complete = harnesses.every(
    (harness) =>
      observed.installedIntegrations.includes(harness) === (options.operation !== 'remove'),
  );
  return complete
    ? { ok: true, observed, plan }
    : refuse('upstream-harness-status-incomplete', observed);
}
