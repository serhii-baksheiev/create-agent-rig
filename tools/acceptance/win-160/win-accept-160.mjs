// Independent native-Windows acceptance of the frozen create-agent-rig 1.6.0
// candidate. Run on a REAL Windows host (not WSL, not a container):
//
//   node win-accept-160.mjs [--work <empty dir>] [--skip-suites] [--live-claude]
//
// Needs node >= 22, git, pnpm (corepack is fine) and network access to GitHub
// and the npm registry. Everything is created under one fresh work directory;
// nothing outside it is written except: a temporary `subst` drive letter
// (removed at the end) and npm's own cache. It never publishes, never pushes,
// never edits the release ref. The report lands in <work>/report.json and
// <work>/report.md; every check is classified LIVE OBSERVED, DETERMINISTIC
// PATH TESTED, NOT OBSERVABLE, NOT TESTED or FAILED. A skipped check is never
// a pass.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir, release, version as osVersion, arch, hostname, cpus, totalmem } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = '40e6eff7e0000150489de3c47abe72184c748c07';
const REF = 'refs/heads/release/1.6.0-rc';
const REPO = 'https://github.com/serhii-baksheiev/create-agent-rig.git';
const EXPECTED_SHA1 = 'fdbdf91fbda24894f8acbc3823df604fea046154';
const EXPECTED_FILES = 181;
const MANIFEST_URL = new URL('./manifest-160.json', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));
const MANIFEST_DIGEST = '0c47275ebb313eeb46c599e34a2870001274f8382d85ef92b73f798231f260fc';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WIN = process.platform === 'win32';
const WORK = opt('--work') ?? mkdtempSync(join(tmpdir(), 'rig160-win-'));
mkdirSync(WORK, { recursive: true });
if (readdirSync(WORK).length) throw new Error(`--work ${WORK} is not empty`);

const results = [];
const LIVE = 'LIVE OBSERVED',
  DET = 'DETERMINISTIC PATH TESTED',
  NOBS = 'NOT OBSERVABLE',
  NT = 'NOT TESTED',
  FAIL = 'FAILED';
const log = join(WORK, 'commands.log');
const record = (id, cls, detail) => {
  results.push({ id, class: cls, detail });
  process.stdout.write(`[${cls}] ${id} — ${detail}\n`);
};
const check = (id, cls, ok, detail) => record(id, ok ? cls : FAIL, detail);

const q = (a) => (/[\s"&|<>^()%!]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);
const run = (cmd, args = [], { cwd = WORK, input, env, timeout = 600000 } = {}) => {
  const line = [cmd, ...args].map(q).join(' ');
  const r = WIN
    ? spawnSync(line, {
        cwd,
        input,
        env: { ...process.env, ...env },
        shell: true,
        encoding: 'utf8',
        timeout,
        windowsHide: true,
      })
    : spawnSync(cmd, args, {
        cwd,
        input,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout,
      });
  const out = {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.message,
  };
  appendFileSync(
    log,
    `\n$ (${cwd}) ${line}\nexit=${out.code}${out.error ? ` error=${out.error}` : ''}\n${out.stdout.slice(-4000)}${out.stderr.slice(-4000)}\n`,
  );
  return out;
};
const nodeRun = (args, opts) => run(process.execPath, args, opts);
const sha = (algo, buf, enc = 'hex') => createHash(algo).update(buf).digest(enc);
const git = (args, cwd) => run('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0' } });
const gitInit = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'acceptance@example.invalid'], dir);
  git(['config', 'user.name', 'acceptance'], dir);
  git(['config', 'core.autocrlf', 'false'], dir);
};
const commitAll = (dir, msg) => {
  git(['add', '-A'], dir);
  return git(['commit', '-q', '-m', msg], dir);
};
const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const safe = (id, fn) => {
  try {
    fn();
  } catch (e) {
    record(id, FAIL, `threw: ${e?.stack?.split('\n').slice(0, 3).join(' | ')}`);
  }
};

// ---------------------------------------------------------------- 1. host
const host = {
  platform: process.platform,
  arch: arch(),
  release: release(),
  osVersion: osVersion(),
  hostname: hostname(),
  cpu: cpus()[0]?.model,
  cpus: cpus().length,
  memGiB: Math.round(totalmem() / 2 ** 30),
  node: process.version,
  wslEnv: process.env.WSL_DISTRO_NAME ?? null,
  work: WORK,
};
for (const [k, c, a] of [
  ['git', 'git', ['--version']],
  ['pnpm', 'pnpm', ['--version']],
  ['npm', 'npm', ['--version']],
  ['claude', 'claude', ['--version']],
  ['codex', 'codex', ['--version']],
]) {
  const r = run(c, a);
  host[k] = r.code === 0 ? r.stdout.trim().split('\n')[0] : null;
}
if (WIN) {
  const r = run('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | ConvertTo-Json -Compress); (Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,HypervisorPresent | ConvertTo-Json -Compress)',
  ]);
  host.windows = r.stdout.trim();
}
check(
  'host.native-windows',
  LIVE,
  WIN && !host.wslEnv,
  `platform=${process.platform} release=${host.release} ${host.osVersion}; WSL_DISTRO_NAME=${host.wslEnv}; ${host.windows ?? ''}`,
);

// ---------------------------------------------------------------- 2. source + ref
const SRC = join(WORK, 'src');
safe('source', () => {
  const c = git(['clone', '-q', '--no-checkout', REPO, SRC], WORK);
  check('source.clone', LIVE, c.code === 0, `git clone ${REPO} exit ${c.code}`);
  git(['fetch', '-q', 'origin', SHA], SRC);
  const co = git(['-c', 'core.autocrlf=false', 'checkout', '-q', '--detach', SHA], SRC);
  const head = git(['rev-parse', 'HEAD'], SRC).stdout.trim();
  check('source.exact-sha', LIVE, co.code === 0 && head === SHA, `HEAD=${head}`);
  const ls = git(['ls-remote', 'origin', REF], SRC).stdout.trim().split(/\s+/)[0];
  check('source.release-ref', LIVE, ls === SHA, `${REF} -> ${ls}`);
});

// ---------------------------------------------------------------- 3. package identity
let TGZ = null;
safe('package', () => {
  const md = sha('sha256', readFileSync(MANIFEST_URL));
  check('package.manifest-file', DET, md === MANIFEST_DIGEST, `manifest-160.json sha256 ${md}`);
  const i = run('pnpm', ['install', '--frozen-lockfile'], { cwd: SRC, timeout: 1200000 });
  check('package.install', LIVE, i.code === 0, `pnpm install --frozen-lockfile exit ${i.code}`);
  const p = run('npm', ['pack', '--silent'], { cwd: SRC, timeout: 1200000 });
  const name = p.stdout.trim().split('\n').pop();
  TGZ = join(SRC, name);
  check('package.pack', LIVE, p.code === 0 && existsSync(TGZ), `npm pack -> ${name}`);
  const buf = readFileSync(TGZ);
  const s1 = sha('sha1', buf);
  host.tarball = {
    file: name,
    sha1: s1,
    sha512: `sha512-${sha('sha512', buf, 'base64')}`,
    bytes: buf.length,
  };
  record(
    'package.sha1',
    s1 === EXPECTED_SHA1 ? LIVE : NOBS,
    s1 === EXPECTED_SHA1
      ? `sha1 ${s1} equals the recorded candidate pack`
      : `sha1 ${s1} differs from the macOS pack ${EXPECTED_SHA1}; byte identity is judged per file below (tar metadata may differ by host)`,
  );
  const X = join(WORK, 'pkg');
  mkdirSync(X);
  const t = run('tar', ['-xzf', TGZ, '-C', X]);
  const got = {};
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else got[relative(X, f).split(sep).join('/')] = sha('sha256', readFileSync(f));
    }
  })(X);
  const keys = new Set([...Object.keys(got), ...Object.keys(MANIFEST)]);
  const diff = [...keys].filter((k) => got[k] !== MANIFEST[k]);
  check(
    'package.content-identity',
    LIVE,
    t.code === 0 && diff.length === 0 && Object.keys(got).length === EXPECTED_FILES,
    `${Object.keys(got).length} files; ${diff.length} differ from the frozen manifest${diff.length ? `: ${diff.slice(0, 10).join(', ')}` : ''}`,
  );
});
if (!TGZ || !existsSync(TGZ)) {
  finish();
  process.exit(1);
}

// ---------------------------------------------------------------- 4/5. CLI install from the packed artifact
const TOOLS = join(WORK, 'tools');
const CLI = join(TOOLS, 'node_modules', 'create-agent-rig', 'packages', 'cli', 'dist', 'index.js');
safe('cli', () => {
  mkdirSync(TOOLS);
  const r = run('npm', ['install', '--no-audit', '--no-fund', '--prefix', TOOLS, TGZ], {
    timeout: 1200000,
  });
  const shim = join(
    TOOLS,
    'node_modules',
    '.bin',
    WIN ? 'create-agent-rig.cmd' : 'create-agent-rig',
  );
  check(
    'cli.npm-install',
    LIVE,
    r.code === 0 && existsSync(CLI) && existsSync(shim),
    `npm install --prefix tools <tgz> exit ${r.code}; bin shim ${existsSync(shim)}`,
  );
  const v = run(shim, ['--version']);
  check(
    'cli.version-via-shim',
    LIVE,
    v.code === 0 && v.stdout.trim().endsWith('1.6.0'),
    `create-agent-rig --version -> ${v.stdout.trim()}`,
  );
  const vj = json(nodeRun([CLI, '--version', '--json']).stdout);
  check(
    'cli.version-json',
    LIVE,
    vj?.version === '1.6.0',
    `--version --json -> ${JSON.stringify(vj)}`,
  );
});
const cli = (args, cwd) => nodeRun([CLI, ...args], { cwd, timeout: 900000 });
const doctor = (cwd) => json(cli(['doctor', '--json'], cwd).stdout);
const doctorSummary = (d) =>
  d
    ? `${d.status}: ${
        d.checks
          .filter((c) => c.status !== 'ok')
          .map((c) => `${c.id}=${c.status}(${c.reason})`)
          .join(', ') || 'all ok'
      }`
    : 'no JSON';
// A warn on codex-hook-trust alone is expected: Codex hook trust is reviewed in Codex's own /hooks view.
const doctorOk = (d) =>
  !!d &&
  d.checks.every((c) => c.status === 'ok' || (c.id === 'codex-hook-trust' && c.status === 'warn'));

// owner-owned content that must survive
const OWNER_FILES = {
  'README.md': '# owner readme\n',
  '.gitignore': 'node_modules/\n.env\n',
  'src/app.js': 'console.log("owner code");\n',
  '.claude/settings.local.json': '{ "permissions": { "allow": ["Bash(ls:*)"] } }\n',
  'CLAUDE.md': '# owner CLAUDE.md\nkeep me\n',
  'AGENTS.md': '# owner AGENTS.md\nkeep me\n',
};
const seedOwner = (dir) => {
  for (const [f, c] of Object.entries(OWNER_FILES)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
};
const ownerIntact = (dir) => {
  const bad = [];
  for (const [f, c] of Object.entries(OWNER_FILES)) {
    const now = existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null;
    if (f === 'AGENTS.md' ? !now?.startsWith(c) : now !== c) bad.push(f);
  }
  return bad;
};

const INIT = join(WORK, 'init-core');
safe('init', () => {
  gitInit(INIT);
  seedOwner(INIT);
  commitAll(INIT, 'owner baseline');
  const r = cli(['init'], INIT);
  check('init.core', LIVE, r.code === 0, `init exit ${r.code}`);
  const bad = ownerIntact(INIT);
  check(
    'init.owner-files-kept',
    LIVE,
    bad.length === 0,
    bad.length
      ? `changed: ${bad.join(', ')}`
      : `${Object.keys(OWNER_FILES).length} owner files byte-identical (AGENTS.md: owner text kept as prefix)`,
  );
  check(
    'init.claude-shim-nested',
    LIVE,
    existsSync(join(INIT, '.claude', 'CLAUDE.md')),
    'pre-existing CLAUDE.md kept; shim at .claude/CLAUDE.md',
  );
  const d = doctor(INIT);
  check('init.doctor', LIVE, doctorOk(d), doctorSummary(d));
  commitAll(INIT, 'rig');
  const w = cli(['init', '--layer', 'workflow'], INIT);
  const bad2 = ownerIntact(INIT);
  check(
    'init.workflow-layer',
    LIVE,
    w.code === 0 && bad2.length === 0,
    `init --layer workflow exit ${w.code}; owner files changed: ${bad2.join(', ') || 'none'}`,
  );
  commitAll(INIT, 'workflow');
  // RP-495 (pre-existing, also in published 1.5.2): adding the layer keeps the wiring files, so doctor
  // reports guards=fail until `upgrade` rewrites them. Recorded as a known failure, then repaired.
  const dl = doctor(INIT);
  const gl = dl?.checks.find((c) => c.id === 'guards');
  results.push({
    id: 'init.layer-add-wiring',
    class: gl?.status === 'ok' ? LIVE : FAIL,
    known: gl?.status === 'ok' ? undefined : 'RP-495',
    detail: `doctor right after init --layer workflow: guards=${gl?.status}(${gl?.reason})`,
  });
  process.stdout.write(
    `[${gl?.status === 'ok' ? LIVE : `${FAIL} (known RP-495)`}] init.layer-add-wiring — guards=${gl?.status}(${gl?.reason})\n`,
  );
  const up = cli(['upgrade', '--yes'], INIT);
  const du = doctor(INIT);
  check(
    'init.layer-add-upgrade-repairs',
    LIVE,
    up.code === 0 && doctorOk(du) && ownerIntact(INIT).length === 0,
    `upgrade --yes exit ${up.code}; ${doctorSummary(du)}; owner files changed: ${ownerIntact(INIT).join(', ') || 'none'}`,
  );
  commitAll(INIT, 'upgrade wiring');
  const pj = json(
    nodeRun([join(INIT, '.claude', 'scripts', 'preflight.mjs'), '--json'], { cwd: INIT }).stdout,
  );
  check(
    'init.preflight',
    LIVE,
    !!pj && pj.verdict !== 'STOP',
    `preflight verdict ${pj?.verdict}; unknown: ${
      pj
        ? Object.values(pj.checks)
            .filter((c) => c.outcome === 'unknown')
            .map((c) => c.id)
            .join(', ')
        : '-'
    }; providers ${JSON.stringify(pj?.providers ?? null)}`,
  );
  const dry = cli(['upgrade', '--dry-run'], INIT);
  check(
    'init.upgrade-noop',
    LIVE,
    dry.code === 0,
    `upgrade --dry-run on a fresh 1.6.0 rig exit ${dry.code}`,
  );
});

// ---------------------------------------------------------------- upgrade 1.5.2 -> 1.6.0
const UPG = join(WORK, 'upgrade-152');
safe('upgrade', () => {
  gitInit(UPG);
  seedOwner(UPG);
  commitAll(UPG, 'owner baseline');
  const old = run('npx', ['--yes', 'create-agent-rig@1.5.2', 'init'], {
    cwd: UPG,
    timeout: 1200000,
  });
  if (old.code !== 0) {
    record(
      'upgrade.from-1.5.2',
      NOBS,
      `could not install published 1.5.2 from the registry (exit ${old.code})`,
    );
    return;
  }
  commitAll(UPG, 'rig 1.5.2');
  const edited = '.claude/rules/workflow.md';
  appendFileSync(join(UPG, edited), '\n<!-- owner edit -->\n');
  commitAll(UPG, 'owner edits a rig file');
  const before = sha('sha256', readFileSync(join(UPG, edited)));
  const u = cli(['upgrade', '--yes'], UPG);
  check('upgrade.from-1.5.2', LIVE, u.code === 0, `upgrade --yes exit ${u.code}`);
  const kept = sha('sha256', readFileSync(join(UPG, edited))) === before;
  check(
    'upgrade.owner-edit-kept',
    LIVE,
    kept,
    `${edited} with an owner edit was ${kept ? 'left as is' : 'OVERWRITTEN'}`,
  );
  const bad = ownerIntact(UPG);
  check(
    'upgrade.owner-files-kept',
    LIVE,
    bad.length === 0,
    bad.length ? `changed: ${bad.join(', ')}` : 'owner files byte-identical',
  );
  const d = doctor(UPG);
  const ver = d?.checks.find((c) => c.id === 'rig-version');
  check(
    'upgrade.doctor-version',
    LIVE,
    ver?.status === 'ok',
    `${ver?.detail}; ${doctorSummary(d)}`,
  );
});

// ---------------------------------------------------------------- 9. presets
const presetRig = {};
for (const p of ['minimal', 'sdd']) {
  safe(`preset.${p}`, () => {
    const dir = join(WORK, `preset-${p}`);
    const r = cli([dir, '--preset', p], WORK);
    presetRig[p] = dir;
    const d = doctor(dir);
    const wf = d?.checks.find((c) => c.id === 'workflow');
    check(
      `preset.${p}`,
      LIVE,
      r.code === 0 && doctorOk(d),
      `create --preset ${p} exit ${r.code}; workflow=${wf?.reason}; ${doctorSummary(d)}`,
    );
    if (p === 'sdd') {
      const pj = json(
        nodeRun([join(dir, '.claude', 'scripts', 'preflight.mjs'), '--json'], { cwd: dir }).stdout,
      );
      check(
        'preset.sdd-preflight',
        LIVE,
        !!pj && pj.verdict !== 'STOP' && 'providers' in pj,
        `verdict ${pj?.verdict}; providers field ${!!pj && 'providers' in pj}`,
      );
    }
  });
}

// ---------------------------------------------------------------- 6/8. hooks (Claude + Codex wiring)
// A cloud-access-key SHAPE, assembled at runtime so no credential is ever written out.
const KEY = ['AK', 'IA', 'QWERTYUIOPASDFGH'].join('');
const leak = () => ['cloud', 'credential', KEY].join(' ');
const payloads = (root) => [
  ['no-verify', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } }, 2],
  ['force-push', { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }, 2],
  ['benign-bash', { tool_name: 'Bash', tool_input: { command: 'git status' } }, 0],
  [
    'leak-write',
    { tool_name: 'Write', tool_input: { file_path: join(root, 'cfg.txt'), content: leak() } },
    2,
  ],
  [
    'benign-write',
    { tool_name: 'Write', tool_input: { file_path: join(root, 'notes.txt'), content: 'hello' } },
    0,
  ],
  [
    'patch-unreadable',
    { tool_name: 'apply_patch', tool_input: { command: { not: 'a string' } } },
    2,
  ],
];
const HOOK_FOR = {
  'no-verify': 'block-no-verify',
  'force-push': 'guard-bash',
  'benign-bash': 'guard-bash',
  'leak-write': 'guard-secret-file',
  'benign-write': 'guard-secret-file',
  'patch-unreadable': 'guard-secret-file',
};
const hookDirect = (root, cwd, label) => {
  const fails = [];
  for (const [name, payload, want] of payloads(root)) {
    const r = nodeRun([join(root, '.claude', 'hooks', `${HOOK_FOR[name]}.mjs`)], {
      cwd,
      input: JSON.stringify(payload),
      env: { CLAUDE_PROJECT_DIR: root },
    });
    if (r.code !== want) fails.push(`${name}: exit ${r.code} want ${want}`);
    if (name === 'leak-write' && (r.stdout + r.stderr).includes(KEY))
      fails.push('the credential shape was echoed');
  }
  const m = nodeRun([join(root, '.claude', 'hooks', 'guard-secret-file.mjs')], {
    cwd,
    input: 'not json',
    env: { CLAUDE_PROJECT_DIR: root },
  });
  if (m.code !== 0) fails.push(`malformed stdin: exit ${m.code} want 0 (fail open)`);
  check(
    `hooks.direct.${label}`,
    DET,
    fails.length === 0,
    fails.length
      ? fails.join('; ')
      : `${payloads(root).length + 1} payloads: blocks exit 2, allows exit 0, malformed input fails open, the credential shape is never echoed`,
  );
};
const runsHook = (command, hook) => {
  const enc = command.match(/-EncodedCommand\s+(\S+)/)?.[1];
  const text = enc ? Buffer.from(enc, 'base64').toString('utf16le') : command;
  return text.includes(`${hook}.mjs`);
};
safe('hooks', () => {
  const root = presetRig.sdd ?? INIT;
  hookDirect(root, root, 'rig-root');
  // Claude Code wiring: the settings.json commands, run through the platform shell with CLAUDE_PROJECT_DIR set
  const settings = json(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  const cmds =
    settings?.hooks?.PreToolUse?.flatMap((g) =>
      g.hooks.map((h) => ({ matcher: g.matcher, command: h.command })),
    ) ?? [];
  const fails = [];
  let ran = 0;
  for (const [name, payload, want] of payloads(root)) {
    for (const c of cmds.filter(
      (c) =>
        new RegExp(`^(${c.matcher})$`).test(payload.tool_name) &&
        runsHook(c.command, HOOK_FOR[name]),
    )) {
      const line = WIN
        ? c.command.replace(/\$CLAUDE_PROJECT_DIR/g, '%CLAUDE_PROJECT_DIR%')
        : c.command;
      const r = spawnSync(line, {
        cwd: root,
        input: JSON.stringify(payload),
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        windowsHide: true,
      });
      ran += 1;
      if (r.status !== want)
        fails.push(`${name} via "${c.command}": exit ${r.status} want ${want}`);
    }
  }
  check(
    'hooks.claude-settings-wiring',
    DET,
    ran > 0 && fails.length === 0,
    fails.join('; ') ||
      `${ran} payload×command runs of .claude/settings.json PreToolUse commands through the platform shell`,
  );
  record(
    'hooks.claude-harness',
    host.claude ? DET : NOBS,
    host.claude ? `claude ${host.claude} present` : 'claude not installed on this host',
  );
  // Codex wiring: hooks.json, commandWindows on Windows
  const hj = json(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
  const ccmds =
    hj?.hooks?.PreToolUse?.flatMap((g) =>
      g.hooks.map((h) => ({
        matcher: g.matcher,
        command: WIN ? (h.commandWindows ?? h.command) : h.command,
      })),
    ) ?? [];
  const cf = [];
  let cran = 0;
  for (const [name, payload, want] of payloads(root)) {
    for (const c of ccmds.filter(
      (c) =>
        new RegExp(`^(${c.matcher})$`).test(payload.tool_name) &&
        runsHook(c.command, HOOK_FOR[name]),
    )) {
      const r = spawnSync(c.command, {
        cwd: root,
        input: JSON.stringify(payload),
        shell: true,
        encoding: 'utf8',
        windowsHide: true,
      });
      cran += 1;
      if (r.status !== want)
        cf.push(`${name}: exit ${r.status} want ${want} ${(r.stderr ?? '').slice(0, 200)}`);
    }
  }
  check(
    'hooks.codex-hooks-json-wiring',
    DET,
    cran > 0 && cf.length === 0,
    cf.join('; ') ||
      `${cran} payload×command runs of .codex/hooks.json PreToolUse ${WIN ? 'commandWindows' : 'command'} entries`,
  );
  record(
    'hooks.codex-harness',
    host.codex ? DET : NOBS,
    host.codex
      ? `codex ${host.codex} present; hook trust needs Codex's own /hooks review (not automatable)`
      : 'codex not installed on this host',
  );
  if (flag('--live-claude') && host.claude) {
    const before = git(['rev-parse', 'HEAD'], root).stdout.trim();
    const r = run(
      'claude',
      [
        '-p',
        'Run exactly this shell command and nothing else: git commit --allow-empty --no-verify -m probe. Then reply with the word DONE.',
        '--allowedTools',
        'Bash',
      ],
      { cwd: root, timeout: 300000 },
    );
    const after = git(['rev-parse', 'HEAD'], root).stdout.trim();
    check(
      'hooks.claude-live',
      LIVE,
      r.code === 0 && before === after,
      `claude -p exit ${r.code}; HEAD unchanged (commit blocked) ${before === after}`,
    );
  } else
    record(
      'hooks.claude-live',
      NT,
      'live Claude Code session not run (pass --live-claude; costs a model call)',
    );
});

// ---------------------------------------------------------------- 7. Windows path boundaries
const NA = join(WORK, 'рїг тест ü');
safe('paths', () => {
  gitInit(NA);
  writeFileSync(join(NA, 'README.md'), 'x\n');
  commitAll(NA, 'base');
  const r = cli(['init'], NA);
  const d = doctor(NA);
  check(
    'paths.non-ascii-root',
    LIVE,
    r.code === 0 && doctorOk(d),
    `init in "${NA}" exit ${r.code}; ${doctorSummary(d)}`,
  );
  hookDirect(NA, NA, 'non-ascii-root');
  if (!WIN) {
    for (const id of ['drive-subst', 'unc', 'junction', 'symlink'])
      record(`paths.${id}`, NOBS, 'Windows-only boundary; host is not win32');
    return;
  }
  const letter = ['R', 'S', 'T', 'U', 'V', 'W', 'Y', 'Z'].find((l) => !existsSync(`${l}:\\`));
  if (letter) {
    const s = run('subst', [`${letter}:`, NA]);
    try {
      const droot = `${letter}:\\`;
      const dd = doctor(droot);
      check(
        'paths.drive-subst',
        LIVE,
        s.code === 0 && doctorOk(dd),
        `subst ${letter}: -> rig; doctor from ${droot}: ${doctorSummary(dd)}`,
      );
      hookDirect(droot, droot, 'subst-drive');
    } finally {
      run('subst', [`${letter}:`, '/d']);
    }
  } else record('paths.drive-subst', NOBS, 'no free drive letter');
  const unc = `\\\\localhost\\${NA[0]}$${NA.slice(2)}`;
  if (existsSync(unc)) {
    const du = doctor(unc);
    check('paths.unc', LIVE, doctorOk(du), `doctor from ${unc}: ${doctorSummary(du)}`);
    hookDirect(unc, unc, 'unc');
  } else
    record(
      'paths.unc',
      NOBS,
      `${unc} not reachable (administrative share disabled or not permitted)`,
    );
  const J = join(WORK, 'junction-to-rig');
  try {
    symlinkSync(NA, J, 'junction');
    const dj = doctor(J);
    check('paths.junction', LIVE, doctorOk(dj), `doctor through junction: ${doctorSummary(dj)}`);
    hookDirect(J, J, 'junction');
  } catch (e) {
    record('paths.junction', NOBS, `junction not creatable: ${e.code}`);
  }
  try {
    writeFileSync(join(NA, 'target.txt'), 'x');
    const L = join(NA, 'link.txt');
    symlinkSync(join(NA, 'target.txt'), L, 'file');
    const p = { tool_name: 'Write', tool_input: { file_path: L, content: leak() } };
    const g = nodeRun([join(NA, '.claude', 'hooks', 'guard-secret-file.mjs')], {
      cwd: NA,
      input: JSON.stringify(p),
      env: { CLAUDE_PROJECT_DIR: NA },
    });
    check(
      'paths.symlink',
      DET,
      g.code === 2,
      `credential shape written through a file symlink: exit ${g.code}`,
    );
  } catch (e) {
    record(
      'paths.symlink',
      NOBS,
      `symlink not creatable (needs Developer Mode or elevation): ${e.code}`,
    );
  }
});

safe('worktree', () => {
  const wt = join(WORK, 'wt-1');
  const a = git(['worktree', 'add', '-q', '-b', 'task/one', wt], INIT);
  const d = doctor(wt);
  check(
    'paths.git-worktree',
    LIVE,
    a.code === 0 && doctorOk(d),
    `git worktree add exit ${a.code}; doctor in worktree: ${doctorSummary(d)}`,
  );
  hookDirect(wt, wt, 'git-worktree');
});

// ---------------------------------------------------------------- 10. evidence contract
const evidence = async () => {
  const root = presetRig.sdd;
  if (!root) {
    record('evidence.round-trip', NT, 'sdd rig missing');
    return;
  }
  writeFileSync(join(root, 'page.html'), '<p>one</p>\n');
  commitAll(root, 'page');
  const runDir = join(WORK, 'run-evidence');
  mkdirSync(runDir);
  const { recordEvent } = await import(
    pathToFileURL(join(root, '.claude', 'scripts', 'run-journal.mjs')).href
  );
  // A SELECT for a local ticket id: the documented precondition of attach. No provider result is invented.
  recordEvent({
    runDir,
    kind: 'revalidation',
    data: { point: 'SELECT', ticket: 'WIN-1', result: 'proceed', sourcePointer: 'acceptance' },
    now: new Date().toISOString(),
  });
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts', 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const attach = () =>
    nodeRun(
      [
        join(root, '.claude', 'scripts', 'evidence-attach.mjs'),
        'attach',
        '--ticket',
        'WIN-1',
        '--kind',
        'screenshot',
        '--producer',
        'playwright-mcp',
        '--subject-kind',
        'page',
        '--subject-id',
        'page.html',
        '--authority-class',
        'observed',
        '--file',
        join(root, 'artifacts', 'shot.png'),
      ],
      { cwd: root, env: { RIG_RUN_DIR: runDir } },
    );
  // The provider version comes from a declared exact pin, as `setup add playwright-mcp` writes it; nothing is invented.
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.83'] } },
    }),
  );
  commitAll(root, 'declare playwright pin');
  const a = attach();
  const evFile = join(root, '.rig', 'evidence', 'WIN-1.jsonl');
  const stamped = json(
    (existsSync(evFile) ? readFileSync(evFile, 'utf8') : '').trim().split('\n').pop() || 'null',
  );
  check(
    'evidence.version-declared',
    DET,
    stamped?.producerVersion === '0.0.83' && stamped?.producerVersionSource === 'declared',
    `producerVersion ${stamped?.producerVersion} source ${stamped?.producerVersionSource}`,
  );
  commitAll(root, 'evidence');
  const cov = () =>
    nodeRun(
      [
        join(root, '.claude', 'scripts', 'verdict.mjs'),
        'coverage',
        git(['rev-parse', 'HEAD'], root).stdout.trim(),
      ],
      { cwd: root, env: { RIG_RUN_DIR: runDir } },
    );
  const ev = (o) => (o.stdout + o.stderr).match(/evidence: \d+ current, \d+ stale/)?.[0];
  const c1 = ev(cov());
  writeFileSync(join(root, 'page.html'), '<p>two</p>\n');
  commitAll(root, 'page changes');
  const c2 = ev(cov());
  check(
    'evidence.round-trip',
    DET,
    a.code === 0 && /1 current, 0 stale/.test(c1 ?? '') && /0 current, 1 stale/.test(c2 ?? ''),
    `attach exit ${a.code}; coverage at the evidence commit: ${c1}; after a page commit: ${c2}`,
  );
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: [`@playwright/mcp@${KEY}`] } },
    }),
  );
  const r = attach();
  const echoed = (r.stdout + r.stderr).includes(KEY);
  check(
    'evidence.credential-pin-refused',
    DET,
    r.code !== 0 && !echoed,
    `credential-shaped pin: exit ${r.code}; value echoed ${echoed}`,
  );
};
await evidence().catch((e) => record('evidence', FAIL, `threw: ${e?.message}`));

// ---------------------------------------------------------------- 12. native suites
if (flag('--skip-suites')) record('suites', NT, 'skipped by --skip-suites');
else {
  for (const [id, args] of [
    ['suites.smoke', ['test:smoke']],
    ['suites.unit+template', ['test:unit']],
    ['suites.e2e', ['test:e2e']],
  ]) {
    const r = run('pnpm', args, { cwd: SRC, timeout: 3600000 });
    const t = (r.stdout + r.stderr).match(/Tests\s+([^\n]+)/)?.[1]?.trim();
    const f = (r.stdout + r.stderr).match(/Test Files\s+([^\n]+)/)?.[1]?.trim();
    check(
      id,
      LIVE,
      r.code === 0,
      `pnpm ${args.join(' ')} exit ${r.code}; files: ${f}; tests: ${t}`,
    );
  }
}

finish();
function finish() {
  const by = (c) => results.filter((r) => r.class === c).length;
  const summary = {
    [LIVE]: by(LIVE),
    [DET]: by(DET),
    [NOBS]: by(NOBS),
    [NT]: by(NT),
    [FAIL]: by(FAIL),
  };
  const unknownFails = results.filter((r) => r.class === FAIL && !r.known).length;
  const verdict = unknownFails
    ? `${unknownFails} check(s) FAILED`
    : by(FAIL)
      ? 'only known pre-existing failures (see "known")'
      : 'no check FAILED';
  const report = {
    sha: SHA,
    ref: REF,
    host,
    summary,
    verdict,
    results,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    `# 1.6.0 Windows acceptance — ${verdict}`,
    '',
    `- SHA ${SHA}`,
    `- host ${JSON.stringify(host)}`,
    `- summary ${JSON.stringify(summary)}`,
    '',
    ...results.map(
      (r) => `- **${r.class}**${r.known ? ` (known ${r.known})` : ''} \`${r.id}\` — ${r.detail}`,
    ),
  ].join('\n');
  writeFileSync(join(WORK, 'report.md'), `${md}\n`);
  process.stdout.write(
    `\n${verdict}\n${JSON.stringify(summary)}\nreport: ${join(WORK, 'report.md')}\n`,
  );
}
