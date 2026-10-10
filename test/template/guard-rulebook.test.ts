import { execFile, execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { runNodeTimed } from '../helpers/child-timing.js';
import {
  deepCwdSpawnAvailable,
  gitStubAvailable,
  needsGitRoot,
  onlyOnWindows,
  skipUnless,
  symlinksAvailable,
} from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * AR-51 — "the rulebook is editable by the run it governs".
 *
 * An unattended `loop` run declares itself through the file
 * `unattended-flag.mjs` writes; while that file is armed, `guard-rulebook`
 * refuses an edit to the rulebook — the hooks, the rules, the queue adapter,
 * the routers, `CLAUDE.md` — unless the queue item's allow-list names the path.
 * Attended sessions (no flag) are untouched.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const hookPath = path.join(universal, '.claude', 'hooks', 'guard-rulebook.mjs');
const hooksDir = path.dirname(hookPath);
const FLAG_NAME = '__PROJECT_NAME__-loop-UNATTENDED';

interface HookResult {
  code: number;
  stderr: string;
  stdout: string;
}

/** Feed a payload to the hook exactly as the harness does — JSON on stdin, env only. */
function runHookFull(
  payload: object | string,
  env?: Record<string, string>,
  script = 'guard-rulebook.mjs',
  cwd?: string,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      { env: { ...process.env, ...env }, cwd },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr, stdout });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

const write = (filePath: string, content = 'x') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content },
});

const edit = (filePath: string, newString = 'x') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'x', new_string: newString },
});

const realHomes = new Set([homedir()]);
try {
  realHomes.add(userInfo().homedir);
} catch {
  // no password entry
}
beforeAll(() => {
  for (const home of realHomes) {
    expect(
      existsSync(path.join(home, '.claude', FLAG_NAME)),
      `the REAL home ${home} carries an unattended flag — remove it before running these tests`,
    ).toBe(false);
  }
});

let home: string;
let root: string;
const env = () => ({ HOME: home, CLAUDE_PROJECT_DIR: root });
const armed = async (allow: string[], raw?: string) => {
  const { unattendedFlags } = await import(
    pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
  );
  const flag = unattendedFlags(env())[0];
  await mkdir(path.dirname(flag), { recursive: true });
  await writeFile(
    flag,
    raw ?? JSON.stringify({ item: 'AR-51', runDir: path.join(root, '.rig-run'), allow }),
  );
};
const run = (payload: object | string) => runHookFull(payload, env());
const plainAdminSharePath = String.raw`\\srv\share\x\.claude\settings.json`;
const verbatimAdminSharePath = String.raw`\\?\UNC\srv\share\x\.claude\settings.json`;
const controlledAdminSharePaths = [
  plainAdminSharePath,
  '//srv/share/x/.claude/settings.json',
  String.raw`\\srv\share\x\.claude`,
  '//srv/share/x/.claude',
  String.raw`\\srv\share\x`,
  '//srv/share/x',
  '\\\\srv\\share\\',
  '//srv/share/',
  String.raw`\\srv\share`,
  '//srv/share',
  String.raw`\\srv`,
  '//srv',
  verbatimAdminSharePath,
  String.raw`\\?\UNC\srv\share\x\.claude`,
  String.raw`\\?\UNC\srv\share\x`,
  '\\\\?\\UNC\\srv\\share\\',
  String.raw`\\?\UNC\srv\share`,
  String.raw`\\?\UNC\srv`,
];
const controlledAdminShareFixturePaths = new Set([plainAdminSharePath, verbatimAdminSharePath]);
const ADMIN_SHARE_PRELOAD = `
import { appendFileSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const controlled = new Set(JSON.parse(process.env.RP361_ADMIN_SHARE_PATHS || '[]'));
const trace = process.env.RP361_ADMIN_SHARE_TRACE;
const native = realpathSync.native;
realpathSync.native = (candidate, ...args) => {
  if (controlled.has(candidate)) {
    appendFileSync(trace, JSON.stringify({ kind: 'controlled', candidate }) + '\\n');
    const error = new Error('ENOENT: controlled absent UNC fixture');
    error.code = 'ENOENT';
    throw error;
  }
  appendFileSync(trace, JSON.stringify({ kind: 'delegated-start', candidate }) + '\\n');
  return native(candidate, ...args);
};
syncBuiltinESMExports();
`;
const runControlledAdminShare = async (payload: object) => {
  const preload = path.join(home, 'controlled-admin-share-preload.mjs');
  const trace = path.join(home, 'controlled-admin-share-trace.jsonl');
  await writeFile(preload, ADMIN_SHARE_PRELOAD);
  const result = await runHookFull(payload, {
    ...env(),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
      .filter(Boolean)
      .join(' '),
    RP361_ADMIN_SHARE_PATHS: JSON.stringify(controlledAdminSharePaths),
    RP361_ADMIN_SHARE_TRACE: trace,
  });
  const entries = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; candidate: string });
  return { ...result, entries };
};
// RP-365: the guard's canonicalisation hands `realpathSync.native` the
// `path.resolve` reading of the fixture's `//`-prefixed path.
// `path.win32.resolve` keeps a UNC or verbatim-UNC spelling, so on win32 the
// lookup reaches the controlled admin-share candidates; `path.posix.resolve`
// collapses the leading `//` to `/`, which no controlled candidate can equal.
// The evidence required below therefore depends on `process.platform`.
const posixAdminShareCandidateOf = (filePath: string) =>
  path.posix.resolve(
    '//' +
      filePath
        .replace(/^\\\\\?\\UNC\\/, '')
        .replace(/^\\\\/, '')
        .replaceAll('\\', '/'),
  );

const expectControlledAdminShareTrace = (
  entries: Array<{ kind: string; candidate: string }>,
  filePath: string,
) => {
  expect(entries.length).toBeGreaterThan(0);
  const uncEntries = entries.filter(
    (entry) => entry.candidate.startsWith('\\\\') || entry.candidate.startsWith('//'),
  );
  for (const entry of uncEntries) expect(controlledAdminSharePaths).toContain(entry.candidate);
  // The two checks above hold for a trace made only of unrelated module-load
  // candidates — neither one requires the walk to have ever reached this
  // fixture's own admin-share path at all. Require that it did, on whichever
  // delegation path this platform actually takes (see the rationale above).
  if (process.platform === 'win32') {
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'controlled' && controlledAdminSharePaths.includes(entry.candidate),
      ),
    ).toBe(true);
  } else {
    const expected = posixAdminShareCandidateOf(filePath);
    expect(
      entries.some((entry) => entry.kind === 'delegated-start' && entry.candidate === expected),
    ).toBe(true);
  }
};
const aliasedRoot = async () => {
  const alias = path.join(home, 'checkout-alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return alias;
};
const hookHeader = async () =>
  (await readFile(path.join(hooksDir, 'guard-rulebook.mjs'), 'utf8'))
    .split('\n')
    .slice(0, 70)
    .join('\n');

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ar51-home-'));
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'ar51-root-')));
});
afterEach(async () => {
  await removeFixture(home);
  await removeFixture(root);
});

describe('guard-rulebook: its stated limits hold, each one measured', () => {
  it('a Bash redirect into the rulebook is not an edit tool call and passes — guard-bash does not cover it either', async () => {
    await armed([]);
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo [] > .claude/hooks/dod-checks.json' },
    };
    const here = await run(payload);
    expect(here.code, here.stderr).toBe(0);
    const bash = await runHookFull(payload, env(), 'guard-bash.mjs');
    expect(bash.code, bash.stderr).toBe(0);
  });

  it('only a flag arms it — an exported RIG_UNATTENDED=1 with no flag changes nothing', async () => {
    const result = await runHookFull(write(`${root}/.claude/hooks/guard-bash.mjs`), {
      ...env(),
      RIG_UNATTENDED: '1',
      RIG_ALLOWED_PATHS: '',
    });
    expect(result.code, result.stderr).toBe(0);
  });

  it('canonicalizes a differently spelled checkout root before guarding a canonical payload path', async () => {
    await armed([]);
    const alias = await aliasedRoot();
    const canonicalRoot = await realpath(root);
    const result = await runHookFull(write(`${canonicalRoot}/.claude/hooks/guard-bash.mjs`), {
      HOME: home,
      CLAUDE_PROJECT_DIR: alias,
    });
    expect(result.code, result.stderr).toBe(2);
    expect(await hookHeader()).toMatch(/canonical|realpath/i);
  });

  it('blocks when the checkout root and payload use the same symlink spelling', async () => {
    await armed([]);
    const alias = await aliasedRoot();
    const result = await runHookFull(write(`${alias}/.claude/hooks/guard-bash.mjs`), {
      HOME: home,
      CLAUDE_PROJECT_DIR: alias,
    });
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks an existing rulebook file when only the payload path uses a symlink spelling', async () => {
    const protectedFile = path.join(root, '.claude', 'hooks', 'guard-bash.mjs');
    await mkdir(path.dirname(protectedFile), { recursive: true });
    await writeFile(protectedFile, '// protected\n');
    await armed([]);
    const alias = await aliasedRoot();
    const canonicalRoot = await realpath(root);
    const result = await runHookFull(write(`${alias}/.claude/hooks/guard-bash.mjs`), {
      HOME: home,
      CLAUDE_PROJECT_DIR: canonicalRoot,
    });
    expect(result.code, result.stderr).toBe(2);
    const header = await hookHeader();
    expect(header).toContain(
      'blocks an existing rulebook file when only the payload path uses a symlink spelling',
    );
    expect(header).toMatch(
      /existing[\s\S]{0,160}(?:payload|file path)[\s\S]{0,160}(?:symlink|alias)|(?:symlink|alias)[\s\S]{0,160}(?:payload|file path)[\s\S]{0,160}existing/i,
    );
  });

  it('blocks a missing rulebook file through a payload-only symlink alias with an existing protected parent', async () => {
    const protectedParent = path.join(root, '.claude', 'hooks');
    const missingTarget = path.join(protectedParent, 'new-hook.mjs');
    await mkdir(protectedParent, { recursive: true });
    expect(existsSync(missingTarget), 'the final protected target is a missing-file case').toBe(
      false,
    );
    await armed([]);
    const alias = await aliasedRoot();
    const canonicalRoot = await realpath(root);

    // On origin/master the guard compared this alias spelling only as text: it
    // could not strip the canonical checkout root and returned 0. The security
    // gate reproduced that prior behaviour; nearest-existing-parent
    // canonicalisation is what lets the missing tail remain guarded now.
    const aliasedTarget = `${alias}/.claude/hooks/new-hook.mjs`;
    const result = await runHookFull(write(aliasedTarget), {
      HOME: home,
      CLAUDE_PROJECT_DIR: canonicalRoot,
    });

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks/new-hook.mjs');
    expect(existsSync(missingTarget), 'the PreToolUse guard must not create the target').toBe(
      false,
    );
    expect(existsSync(aliasedTarget), 'the alias spelling must still resolve to no file').toBe(
      false,
    );
  });

  it('does not universally claim that every path outside the rulebook is never judged', async () => {
    const prose = (await hookHeader()).replace(/^\/\/?\s?/gm, '').replace(/\s+/g, ' ');
    expect(prose).not.toMatch(/paths outside the rulebook are never judged/i);
    expect(prose).toMatch(/known path[\s\S]{0,120}outside the rulebook/i);
  });

  it('states the pathless global-refusal limit for oversized and unsupported apply_patch payloads', async () => {
    const prose = (await hookHeader()).replace(/^\/\/?\s?/gm, '').replace(/\s+/g, ' ');
    expect(prose).toMatch(/pathless[\s\S]{0,80}global refusal/i);
    expect(prose).toMatch(/oversized[\s\S]{0,100}apply_patch|apply_patch[\s\S]{0,100}oversized/i);
    expect(prose).toMatch(
      /unsupported[\s\S]{0,100}apply_patch|apply_patch[\s\S]{0,100}unsupported/i,
    );
  });

  it.each(['.', '.claude/', '.claude/scripts/', '.codex/', 'AGENTS', '.claude/.rig-'])(
    'a flag whose allow-list entry %s widens the rulebook is unreadable',
    async (entry) => {
      await armed([entry]);
      const result = await run(write(`${root}/.claude/hooks/guard-bash.mjs`));
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/unreadable/);
      expect(result.stderr).toMatch(/allow/);
    },
  );
});

describe('guard-rulebook: attended sessions are untouched', () => {
  it('allows a hook edit when no unattended flag exists', async () => {
    const result = await run(write(`${root}/.claude/hooks/guard-bash.mjs`));
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('guard-rulebook: an unattended run edits the rulebook only where its item allows', () => {
  it('never treats a legacy machine-wide allow-list as this checkout authorization', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude', FLAG_NAME),
      JSON.stringify({ item: 'OLD-A', runDir: '/runs/old-a', allow: ['.claude/skills/'] }),
    );
    const result = await run(edit(`${root}/.claude/skills/loop/SKILL.md`));
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/legacy|migrat|unreadable/i);
  });

  // RP-258 — functional review 2026-09-24: this exact scenario (an
  // unscoped/mis-scoped flag) was reported to the operator as "legacy
  // machine-wide unattended flag cannot authorize a scoped checkout" even
  // when the flag was written moments earlier by this same tool, just
  // without `--root`. The refusal itself was correct (fail closed); the
  // story it told was not. This pins that the wording names the actual
  // root-scope problem instead, while the block above pins that the refusal
  // itself never weakens.
  it('names the actual root-scope problem instead of the "legacy machine-wide" story, while still failing closed (RP-258)', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude', FLAG_NAME),
      JSON.stringify({ item: 'OLD-A', runDir: '/runs/old-a', allow: ['.claude/skills/'] }),
    );
    const result = await run(edit(`${root}/.claude/skills/loop/SKILL.md`));
    expect(result.code, result.stderr).toBe(2); // still fails closed — never weakened
    expect(result.stderr).not.toMatch(/legacy machine-wide/i);
    // code-reviewer round 1 advisory: `toMatch(/root/i)` is vacuous here —
    // the guard's own static remedy text already contains `--root "$PWD"`,
    // so it matched the OLD "legacy machine-wide" wording just as well and
    // discriminated nothing beyond the `not.toMatch` line above. Matching the
    // reason's actual distinctive wording (`unattended-flag.mjs`'s
    // `readUnattended`, the unscoped-legacy branch) is what proves the new
    // story, not just the absence of the old one.
    expect(result.stderr).toMatch(/carries no checkout root/i);
  });

  it('finds the checkout-scoped flag from cwd when the harness omits CLAUDE_PROJECT_DIR', async () => {
    const { unattendedFlags, writeUnattended } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: root };
    try {
      writeUnattended({ item: 'AR-CWD', runDir: '/runs/cwd', allow: [] }, scopedEnv);
      const canonicalRoot = await realpath(root);
      const result = await runHookFull(
        write(`${canonicalRoot}/.claude/hooks/guard-bash.mjs`),
        { HOME: home, CLAUDE_PROJECT_DIR: '' },
        'guard-rulebook.mjs',
        root,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await Promise.all(
        [...new Set<string>(unattendedFlags(scopedEnv) as string[])].map((candidate) =>
          rm(candidate, { force: true }),
        ),
      );
    }
  });

  it.each([
    '.claude/hooks/guard-bash.mjs',
    '.claude/doctor-exemptions.json',
    '.claude/settings.json',
    '.claude/queue.json',
    '.claude/queue.board',
    '.claude/scripts/queue/index.mjs',
    '.claude/scripts/decision-router.mjs',
    '.claude/scripts/detect-missed-gate.mjs',
    '.claude/scripts/unattended-flag.mjs',
    '.claude/scripts/stop-flag.mjs',
    '.claude/rules/autonomy.md',
    '.claude/agents/prose-reviewer.md',
    '.claude/skills/loop/SKILL.md',
    '.agents/skills/loop/SKILL.md',
    '.codex/hooks.json',
    '.claude/.rig-manifest.json',
    'CLAUDE.md',
    // RP-256 slice 1: the nested Rig shim a CLAUDE.md-coexistence install
    // (`init.test.ts`, `packages/cli`) writes at `.claude/CLAUDE.md` decides
    // which rulebook Claude Code reads exactly as root CLAUDE.md does, so an
    // unattended run must not be able to rewrite it either.
    '.claude/CLAUDE.md',
    'AGENTS.md',
    // RP-61: the revalidation detection contract preflight.mjs and
    // claim-records.mjs both read — rewriting it silently changes what a
    // claim's scope fingerprint watches, so it belongs in the closure too.
    '.rig/revalidation.json',
  ])('blocks the complete rulebook closure at %s', async (rel) => {
    await armed([]);
    const result = await run(write(`${root}/${rel}`));
    expect(result.code, result.stderr).toBe(2);
  });

  // RP-61: a SELECT creates its own baseline at `.rig/claims/<id>.json`, and
  // every queue merge writes one — the directory must stay writable even
  // though its sibling contract file above is now part of the closure.
  it('leaves .rig/claims/ writable — a SELECT creates its own baseline there', async () => {
    await armed([]);
    const result = await run(write(`${root}/.rig/claims/RP-61.json`));
    expect(result.code, result.stderr).toBe(0);
  });

  // RP-61: `.rig/` itself must refuse as an allow entry — it is a proper
  // prefix of the now-protected `.rig/revalidation.json` and would admit the
  // whole directory, claims included.
  it('a flag whose allow-list entry .rig/ widens the rulebook is unreadable', async () => {
    await armed(['.rig/']);
    const result = await run(write(`${root}/.claude/hooks/guard-bash.mjs`));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unreadable/);
    expect(result.stderr).toMatch(/allow/);
  });

  it('blocks a hook-config edit with an empty allow-list, naming path, item and the rule', async () => {
    await armed([]);
    const result = await run(write(`${root}/.claude/hooks/dod-checks.json`));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('.claude/hooks/dod-checks.json');
    expect(result.stderr).toContain('AR-51');
    expect(result.stderr).toMatch(/unattended/i);
    expect(result.stderr).toMatch(/allow/i);
  });

  it('never allows the checkout board selector, even when an item names it', async () => {
    await armed(['.claude/queue.board']);
    const result = await run(write(`${root}/.claude/queue.board`, 'RP'));
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/board|selector/i);
  });

  it('allows an edit under an allowed prefix', async () => {
    await armed(['.claude/scripts/queue/']);
    const result = await run(edit(`${root}/.claude/scripts/queue/core.mjs`));
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows doctor exemptions only when the item names that exact rulebook file', async () => {
    await armed(['.claude/doctor-exemptions.json']);
    const result = await run(edit(`${root}/.claude/doctor-exemptions.json`));
    expect(result.code, result.stderr).toBe(0);
  });

  it('blocks an edit to a rulebook path the allow-list does not name', async () => {
    await armed(['.claude/scripts/queue/']);
    const result = await run(edit(`${root}/.claude/scripts/decision-router.mjs`));
    expect(result.code).toBe(2);
  });

  it('allows an edit outside the rulebook', async () => {
    await armed([]);
    const result = await run(write(`${root}/packages/core/src/x.ts`));
    expect(result.code, result.stderr).toBe(0);
  });

  it('guards the path, not prose that mentions a guarded path', async () => {
    await armed([]);
    const result = await run(
      write(`${root}/README.md`, 'see .claude/hooks/guard-bash.mjs for the brake'),
    );
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('guard-rulebook: every edit surface reaches it', () => {
  it('refuses a MultiEdit beyond the fragment cap when its known path is in the rulebook', async () => {
    await armed([]);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: `${root}/.claude/queue.json`,
        edits: [
          ...Array.from({ length: 256 }, () => ({ old_string: 'a', new_string: 'b' })),
          { old_string: 'a', new_string: 'b' },
        ],
      },
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/cannot safely inspect|inspection limit|more than 256/i);
  });

  it('allows a MultiEdit beyond the fragment cap when its known path is outside the rulebook', async () => {
    await armed([]);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: `${root}/README.md`,
        edits: [
          ...Array.from({ length: 256 }, () => ({ old_string: 'a', new_string: 'b' })),
          { old_string: 'a', new_string: 'b' },
        ],
      },
    });
    expect(result.code, result.stderr).toBe(0);
  });

  it('does not ignore queue.board as the 65th guarded path behind 64 allowed paths', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const allowed = Array.from({ length: 64 }, (_, index) => `.claude/rules/allowed-${index}.md`);
    const scopedEnv = { HOME: home, CLAUDE_PROJECT_DIR: repoRoot };
    const { unattendedFlags } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const flag = unattendedFlags(scopedEnv)[0];
    await mkdir(path.dirname(flag), { recursive: true });
    await writeFile(
      flag,
      JSON.stringify({ item: 'AR-TAIL', runDir: path.join(repoRoot, '.rig-run'), allow: allowed }),
    );
    const sections = [...allowed, '.claude/queue.board']
      .map((rel) => `*** Update File: ${rel}\n@@\n+x`)
      .join('\n');
    const result = await runHookFull(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        cwd: repoRoot,
        tool_input: { command: `*** Begin Patch\n${sections}\n*** End Patch\n` },
      },
      scopedEnv,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/queue\.board|board selector/i);
  });

  it('blocks a MultiEdit to queue.json', async () => {
    await armed([]);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: `${root}/.claude/queue.json`,
        edits: [{ old_string: 'a', new_string: 'b' }],
      },
    });
    expect(result.code).toBe(2);
  });

  it('blocks a NotebookEdit under the rules directory', async () => {
    await armed([]);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: `${root}/.claude/rules/x.ipynb`, new_source: 'y' },
    });
    expect(result.code).toBe(2);
  });

  it('blocks a Codex apply_patch that updates settings.json', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    await armed([]);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Update File: .claude/settings.json\n@@\n+x\n*** End Patch\n',
      },
    });
    expect(result.code).toBe(2);
  });
});

// RP-60. `repositoryPatchPath` (`edit-input.mjs`) resolves an `apply_patch`
// destination through the nearest existing ancestor and returns the
// REALPATH-RESOLVED repo-relative spelling, discarding the lexical one it
// computes one line earlier. When a guarded prefix such as `.claude/hooks` is
// itself a symlink/junction to a directory inside the same checkout, the
// fragment guard-rulebook receives names the junction's TARGET
// (`vendor/real-hooks/guard-bash.mjs`), never the rulebook spelling
// (`.claude/hooks/guard-bash.mjs`) the patch actually named — so the edit is
// allowed while the unattended flag is armed. `Write`/`Edit`/`MultiEdit`/
// `NotebookEdit` go through `normalisePath`, which resolves nothing, and are
// unaffected; a junction whose target sits OUTSIDE the checkout fails closed
// through the global-refusal branch either way. RP-60.
//
// `apply_patch` resolves its repository root with `git rev-parse`, so this
// needs its own scratch git repository rather than reusing the aliased-ROOT
// fixture above (`aliasedRoot()` only ever aliases the checkout root, never a
// prefix beneath it — that is exactly the gap this pins).
describe('guard-rulebook: apply_patch does not lose the lexical path when a guarded prefix is a junction (RP-60)', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q', root], { env: withoutGitLocation() });
  });

  const applyPatch = (rel: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    cwd: root,
    tool_input: {
      command: `*** Begin Patch\n*** Update File: ${rel}\n@@\n+x\n*** End Patch\n`,
    },
  });

  it('control: still refuses an apply_patch to a real .claude/hooks directory', async () => {
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'hooks', 'guard-bash.mjs'), '// real\n');
    await armed([]);
    const result = await run(applyPatch('.claude/hooks/guard-bash.mjs'));
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an apply_patch through a guarded prefix junctioned to a target inside the checkout', async () => {
    await mkdir(path.join(root, 'vendor', 'real-hooks'), { recursive: true });
    await writeFile(path.join(root, 'vendor', 'real-hooks', 'guard-bash.mjs'), '// vendored\n');
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await symlink(
      path.join(root, 'vendor', 'real-hooks'),
      path.join(root, '.claude', 'hooks'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed([]);
    const result = await run(applyPatch('.claude/hooks/guard-bash.mjs'));
    // On origin/master this exits 0: repositoryPatchPath resolves the
    // junction and hands guard-rulebook "vendor/real-hooks/guard-bash.mjs",
    // so the raw ".claude/hooks/…" spelling never reaches the guard.
    expect(result.code, result.stderr).toBe(2);
  });

  it('control: still refuses a Write through the same inside-checkout prefix junction', async () => {
    await mkdir(path.join(root, 'vendor', 'real-hooks'), { recursive: true });
    await writeFile(path.join(root, 'vendor', 'real-hooks', 'guard-bash.mjs'), '// vendored\n');
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await symlink(
      path.join(root, 'vendor', 'real-hooks'),
      path.join(root, '.claude', 'hooks'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed([]);
    const result = await run(write(`${root}/.claude/hooks/guard-bash.mjs`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('control: still fails closed through a guarded prefix junctioned to a target outside the checkout', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'rp60-outside-')));
    try {
      await mkdir(path.join(root, '.claude'), { recursive: true });
      await symlink(
        outside,
        path.join(root, '.claude', 'hooks'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await armed([]);
      const result = await run(applyPatch('.claude/hooks/guard-bash.mjs'));
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(outside);
    }
  });
});

// RP-246 (Jira 21605, security-scanner on PR #350, pre-existing on the base
// commit `protectedRelative` resolves against): it tries the LITERAL
// spellings (`filePath`, `rawFilePath`) before the resolved one
// (`canonicalPath`), and returns the FIRST candidate that names ANY
// rulebook path — so when a symlinked directory sits INSIDE one allowed
// rulebook prefix (`.claude/rules/`) and points at a DIFFERENT, non-allowed
// rulebook prefix (`.claude/hooks/`), the literal spelling
// `.claude/rules/junc/evil.mjs` already names an allowed rulebook path and
// is returned — and accepted — before the resolved, REAL target
// (`.claude/hooks/evil.mjs`) is ever tried.
describe('guard-rulebook: a literal spelling under an allowed prefix must not authorize the different rulebook prefix it resolves to (RP-246)', () => {
  it('blocks a Write through .claude/rules/junc/evil.mjs when the junction resolves to the non-allowed .claude/hooks/', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await symlink(
      path.join(root, '.claude', 'hooks'),
      path.join(root, '.claude', 'rules', 'junc'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed(['.claude/rules/']);

    // On origin/master this exits 0: the literal spelling names the
    // ALLOWED ".claude/rules/junc/evil.mjs" and protectedRelative returns
    // it without ever consulting the resolved, non-allowed
    // ".claude/hooks/evil.mjs" the junction actually names.
    const result = await run(write(path.join(root, '.claude', 'rules', 'junc', 'evil.mjs')));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks');
  });

  it('control: still allows a plain Write to an allowed .claude/rules/x.md with no symlink involved', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await armed(['.claude/rules/']);

    const result = await run(write(path.join(root, '.claude', 'rules', 'x.md')));

    expect(result.code, result.stderr).toBe(0);
  });

  it('control: still allows a Write through a symlinked directory whose target is itself inside the allowed prefix', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules', 'other'), { recursive: true });
    await symlink(
      path.join(root, '.claude', 'rules', 'other'),
      path.join(root, '.claude', 'rules', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed(['.claude/rules/']);

    const result = await run(write(path.join(root, '.claude', 'rules', 'link', 'y.md')));

    expect(result.code, result.stderr).toBe(0);
  });
});

// RP-246 round 2 (code-reviewer on PR #359, head 58f9635 refuses/exit 2, head
// e7e098e allows/exit 0): round 1 made the RESOLVED spelling win over a
// literal spelling that only LOOKED harmless — but `protectedRelative` still
// returns that resolved spelling immediately once it names ANY rulebook
// path, allowed or not, and never goes on to try the literal spelling at
// all. So the mirror case slips through: a literal path that sits under a
// NON-allowed rulebook prefix (`.claude/hooks/`) but resolves, through a
// symlink, to a path that happens to be ALLOWED (`.claude/rules/…`) is read
// as fully authorized — the guard never notices that the spelling actually
// named on the edit is the non-allowed one. Every spelling a fragment
// carries has to be collected and judged; the edit is refused if ANY of them
// names a rulebook path the item's allow-list does not cover.
describe('guard-rulebook: a literal spelling outside an allowed prefix is not hidden by a resolved match inside it (RP-246 round 2)', () => {
  it('blocks a Write to .claude/hooks/x.mjs when it is a file symlink into the allowed .claude/rules/', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'rules', 'x.mjs'), 'protected\n');
    await symlink(
      path.join(root, '.claude', 'rules', 'x.mjs'),
      path.join(root, '.claude', 'hooks', 'x.mjs'),
    );
    await armed(['.claude/rules/']);

    // On origin/master (base 58f9635) this exits 2. On this head (e7e098e)
    // it exits 0: the RESOLVED spelling ".claude/rules/x.mjs" is allowed and
    // protectedRelative returns it first, so the literal, non-allowed
    // ".claude/hooks/x.mjs" the edit actually names is never consulted.
    const result = await run(write(path.join(root, '.claude', 'hooks', 'x.mjs')));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks');
  });

  it('blocks an Edit to .claude/hooks/x.mjs when it is a file symlink into the allowed .claude/rules/', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'rules', 'x.mjs'), 'protected\n');
    await symlink(
      path.join(root, '.claude', 'rules', 'x.mjs'),
      path.join(root, '.claude', 'hooks', 'x.mjs'),
    );
    await armed(['.claude/rules/']);

    const result = await run(edit(path.join(root, '.claude', 'hooks', 'x.mjs')));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks');
  });

  it('blocks a Write to .claude/hooks/sub/y.mjs when .claude/hooks/sub is a directory symlink into the allowed .claude/rules/', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules', 'sub'), { recursive: true });
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await symlink(
      path.join(root, '.claude', 'rules', 'sub'),
      path.join(root, '.claude', 'hooks', 'sub'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed(['.claude/rules/']);

    // The resolved leaf ".claude/rules/sub/y.mjs" is allowed; the literal
    // leaf ".claude/hooks/sub/y.mjs" the edit actually names is not.
    const result = await run(write(path.join(root, '.claude', 'hooks', 'sub', 'y.mjs')));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks');
  });

  it('blocks an Edit to .claude/hooks/sub/y.mjs when .claude/hooks/sub is a directory symlink into the allowed .claude/rules/', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules', 'sub'), { recursive: true });
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await symlink(
      path.join(root, '.claude', 'rules', 'sub'),
      path.join(root, '.claude', 'hooks', 'sub'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed(['.claude/rules/']);

    const result = await run(edit(path.join(root, '.claude', 'hooks', 'sub', 'y.mjs')));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks');
  });

  it('control: still allows a plain Write to an allowed .claude/rules/x.md with no symlink involved', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await armed(['.claude/rules/']);

    const result = await run(write(path.join(root, '.claude', 'rules', 'x.md')));

    expect(result.code, result.stderr).toBe(0);
  });

  it('control: still allows a Write through a symlinked directory whose target is itself inside the allowed prefix', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules', 'other'), { recursive: true });
    await symlink(
      path.join(root, '.claude', 'rules', 'other'),
      path.join(root, '.claude', 'rules', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed(['.claude/rules/']);

    const result = await run(write(path.join(root, '.claude', 'rules', 'link', 'y.md')));

    expect(result.code, result.stderr).toBe(0);
  });

  it('control: the round-1 case (.claude/rules/junc/evil.mjs resolving to the non-allowed .claude/hooks/) is still refused', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await symlink(
      path.join(root, '.claude', 'hooks'),
      path.join(root, '.claude', 'rules', 'junc'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await armed(['.claude/rules/']);

    const result = await run(write(path.join(root, '.claude', 'rules', 'junc', 'evil.mjs')));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks');
  });
});

/**
 * RP-215 — the realpath rescue in `canonicalPath` only re-cases a spelling
 * through the nearest EXISTING ancestor. Below the guard entirely, if
 * `.codex/` or `.agents/` have never been created in this checkout, a
 * miscased Write (`.Codex/config.toml`, `.AGENTS/x.md`) is judged purely by
 * `isRulebookPath`, with no on-disk rescue to fall back on — reproducible on
 * every platform, not just a case-insensitive one. `root` is a fresh
 * `mkdtemp()` for every case in this file, so `.codex/` and `.agents/` are
 * absent from it by construction; the explicit checks below only make that
 * precondition visible rather than assumed.
 */
describe('guard-rulebook: blocks a miscased rulebook path even when the guarded directory does not exist on disk yet (RP-215)', () => {
  it('blocks a Write to .Codex/config.toml when .codex/ is absent from the checkout', async () => {
    expect(existsSync(path.join(root, '.codex'))).toBe(false);
    await armed(['src/']);
    const result = await run(write(`${root}/.Codex/config.toml`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Write to .AGENTS/x.md when .agents/ is absent from the checkout', async () => {
    expect(existsSync(path.join(root, '.agents'))).toBe(false);
    await armed(['src/']);
    const result = await run(write(`${root}/.AGENTS/x.md`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('still allows an ordinary path under the armed allow-list', async () => {
    await armed(['src/']);
    const result = await run(write(`${root}/src/a.txt`));
    expect(result.code, result.stderr).toBe(0);
  });
});

/**
 * RP-215 review round 2 — `isRulebookPath` now folds case before comparing
 * (see the block above), but `protectedRelative` still hands `isAllowed` and
 * the `.claude/queue.board` carve-out the CALLER's miscased spelling, and
 * both of those comparisons stayed case-sensitive. A flag whose `allow`
 * entry is spelled in a different case than the rulebook prefix it targets
 * therefore authorizes a path `isRulebookPath` folds to the very prefix the
 * entry was supposed to be a narrow slice of — including the one entry that
 * is never supposed to be an allow root at all (`.claude/scripts/`, deliberately
 * withheld, `isWidening`) and the board selector, which is refused "even
 * through an item allow-list" regardless of case.
 *
 * Every fixture below runs against a fresh `mkdtemp()` root, so the guarded
 * directories are absent from disk by construction — identical on Linux CI,
 * a case-sensitive filesystem, and a case-insensitive one: there is no
 * on-disk rescue to fall back on either way, and no case-insensitive
 * filesystem is required to reproduce this.
 */
describe('guard-rulebook: an allow-list entry is judged by its literal spelling, not the one the payload folds to (RP-215 round 2)', () => {
  it('refuses a Write to .claude/Scripts/queue-index.mjs though the allow-list names the miscased .claude/Scripts/ — .claude/scripts/ is a deliberately withheld allow root', async () => {
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    await armed(['.claude/Scripts/']);
    const result = await run(write(`${root}/.claude/Scripts/queue-index.mjs`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a Write to .Claude/settings.json though the allow-list names the miscased .Claude/', async () => {
    expect(existsSync(path.join(root, '.Claude'))).toBe(false);
    await armed(['.Claude/']);
    const result = await run(write(`${root}/.Claude/settings.json`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('never allows the checkout board selector under a miscased spelling, even when the allow-list names that exact miscased spelling', async () => {
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    await armed(['.claude/Queue.board']);
    const result = await run(write(`${root}/.claude/Queue.board`, 'RP'));
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/board|selector/i);
  });

  // The honest direction: an allow-list entry that spells an ALLOWED prefix
  // (`.claude/hooks/`, an ordinary allow root — unlike `.claude/scripts/`
  // above) should still authorize a payload path that only differs from it
  // by case, the same way `isRulebookPath` now treats the two spellings as
  // one path. Today `isAllowed`'s case-sensitive `startsWith` refuses this
  // one too — the same defect, on the side that currently over-blocks rather
  // than under-blocks.
  it('allows a miscased spelling of an allowed prefix — .claude/Hooks/x.mjs under an armed .claude/hooks/', async () => {
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    await armed(['.claude/hooks/']);
    const result = await run(write(`${root}/.claude/Hooks/x.mjs`));
    expect(result.code, result.stderr).toBe(0);
  });
});

/**
 * RP-243 — Win32 path normalisation strips a TRAILING dot or space from each
 * path component when the file is actually created (`cmd /c "echo x >
 * .codex.\config.toml"` lands as `.codex\config.toml` on disk), while
 * `canonicalRulebookPath`/`isRulebookPath` compare the literal spelling. A
 * payload naming `.codex./config.toml`, `.claude/hooks /x.mjs` and the like is
 * therefore, on Windows, the exact guarded file — and today it is not judged
 * as a rulebook path at all, so it passes with the unattended flag armed.
 * Every fixture below runs against a fresh `mkdtemp()` root; the two paths
 * that name a guarded directory that already exists on disk are called out
 * explicitly, so the fix is proven with and without an on-disk rescue.
 */
describe('guard-rulebook: a trailing dot or space on a rulebook path component does not bypass the guard (RP-243)', () => {
  it('blocks a Write to .codex./config.toml when .codex/ is absent from the checkout', async () => {
    expect(existsSync(path.join(root, '.codex'))).toBe(false);
    await armed(['src/']);
    const result = await run(write(`${root}/.codex./config.toml`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Write to .claude/hooks /x.mjs when .claude/hooks/ already exists on disk', async () => {
    await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await armed(['src/']);
    const result = await run(write(`${root}/.claude/hooks /x.mjs`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('still allows an ordinary trailing-dot path outside the rulebook under the armed allow-list', async () => {
    await armed(['src/']);
    const result = await run(write(`${root}/src/a.txt.`));
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows .claude/hooks./x.mjs under an allow-list naming the canonical .claude/hooks/ — it folds to the same allowed path', async () => {
    await armed(['.claude/hooks/']);
    const result = await run(write(`${root}/.claude/hooks./x.mjs`));
    expect(result.code, result.stderr).toBe(0);
  });

  // The allow-list side is never canonicalised (RP-215 round 2's rule: only
  // the PATH folds, never the entry) — so an allow entry that itself carries
  // a trailing dot, `.claude/hooks./`, is not a widening of `.claude/hooks/`
  // in `isWidening`'s literal string comparison (it is not a proper prefix of
  // the folded rulebook entry, nor equal to one of the three hard-coded
  // protected roots) and the writer accepts it. Accepting it must not turn
  // into AUTHORIZING anything: the canonical payload path
  // `.claude/hooks/x.mjs` does not literally start with the dotted entry, so
  // it stays blocked exactly as it would with no allow-list at all.
  it('does not let an allow-list entry spelled with a trailing dot (.claude/hooks./) authorize the canonical .claude/hooks/x.mjs', async () => {
    await armed(['.claude/hooks./']);
    const result = await run(write(`${root}/.claude/hooks/x.mjs`));
    expect(result.code, result.stderr).toBe(2);
  });

  /**
   * code-reviewer round 2 (8c27054), advisory B — the RP-243 normalisation
   * strips a trailing dot/space from EVERY `/`-separated component of the
   * payload path, not only the component(s) the matched rulebook prefix
   * itself spans. `.claude/hooks/a./b.mjs` names a component ("a.") that
   * sits INSIDE the already-matched `.claude/hooks/` prefix — on POSIX,
   * where no filesystem strips a trailing dot at create time, "a." and "a"
   * are two different, unrelated directories. An allow-list naming
   * `.claude/hooks/a/` must not reach into the sibling "a." at all: doing so
   * widens what the allow-list authorizes beyond the literal prefix it was
   * written for.
   */
  it('does not fold a component beyond the matched prefix: an allow-list naming .claude/hooks/a/ must not authorize the POSIX sibling .claude/hooks/a./b.mjs', async () => {
    await armed(['.claude/hooks/a/']);
    const result = await run(write(`${root}/.claude/hooks/a./b.mjs`));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Codex apply_patch that adds .codex./config.toml', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    await armed(['src/']);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Add File: .codex./config.toml\n+x\n*** End Patch\n',
      },
    });
    expect(result.code, result.stderr).toBe(2);
  });
});

// RP-479. `edit-input.mjs`'s section-header regexes are anchored at column 0
// (`^\*\*\* …`), but Codex's real parser (`codex-rs/apply-patch/src/
// streaming_parser.rs`, `process_line`) recognises a header OUTSIDE an
// `*** Update File:` section after Rust `str::trim()` — leading AND trailing
// whitespace stripped. An indented header such as `  *** Add File:
// .claude/rules/x.md` matches none of today's regexes, so `editFragments`
// reports no fragment at all for that section — the same empty-fragment gap
// `guard-secret-file.test.ts` pins — and an unattended edit to the rulebook
// through an indented header is never judged against the item's allow-list.
describe('guard-rulebook: an indented apply_patch section header still names the rulebook path it targets (RP-479)', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q', root], { env: withoutGitLocation() });
  });

  it('refuses a two-space-indented Add File header naming a rulebook path, with no allow-list entry covering it', async () => {
    await armed(['src/']);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      cwd: root,
      tool_input: {
        command: '*** Begin Patch\n  *** Add File: .claude/rules/x.md\n+# x\n*** End Patch\n',
      },
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/rules/x.md');
    expect(result.stderr).toContain('AR-51');
  });

  it('refuses a tab-indented Delete File header naming a rulebook path, with no allow-list entry covering it', async () => {
    const target = path.join(root, 'AGENTS.md');
    await writeFile(target, '# rulebook\n');
    await armed(['src/']);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      cwd: root,
      tool_input: {
        command: '*** Begin Patch\n\t*** Delete File: AGENTS.md\n*** End Patch\n',
      },
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('AGENTS.md');
    expect(result.stderr).toContain('AR-51');
  });
});

// RP-214. `edit-input.mjs`'s `patchFragments` only ever `flush()`es the
// SECTION BEFORE a `*** Delete File:` or `*** Move to:` line — the removed
// path itself never becomes a fragment, so guard-rulebook's fragment loop
// never sees it and the rulebook path being removed is never judged. Two
// shapes hide it: a standalone Delete File section (no fragment at all), and
// an Update section carrying `*** Move to:` (a fragment naming only the
// destination — `current.moveTo ?? current.sourcePath` at `edit-input.mjs`
// discards the source once a destination exists).
describe('guard-rulebook: apply_patch never hides a rulebook removal (RP-214)', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q', root], { env: withoutGitLocation() });
  });

  const deletePatch = (rel: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    cwd: root,
    tool_input: {
      command: `*** Begin Patch\n*** Delete File: ${rel}\n*** End Patch\n`,
    },
  });

  const updateMovePatch = (fromRel: string, toRel: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    cwd: root,
    tool_input: {
      command: `*** Begin Patch\n*** Update File: ${fromRel}\n*** Move to: ${toRel}\n@@\n+// moved\n*** End Patch\n`,
    },
  });

  it.each(['.claude/hooks/guard-bash.mjs', '.claude/hooks/guard-rulebook.mjs', 'CLAUDE.md'])(
    'a standalone Delete File of a rulebook path (%s) is refused while unattended, not hidden',
    async (rel) => {
      const target = path.join(root, ...rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '// real file, deleted by the patch under test\n');
      await armed(['src/']);
      const result = await run(deletePatch(rel));
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain(rel);
      expect(result.stderr).toContain('AR-51');
    },
  );

  it('a Delete File of a rulebook path is not hidden by a later allowed Add File in the same patch', async () => {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{}\n');
    await armed(['src/']);
    const result = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      cwd: root,
      tool_input: {
        command:
          '*** Begin Patch\n*** Delete File: .claude/settings.json\n*** Add File: src/b.txt\n+hello\n*** End Patch\n',
      },
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/settings.json');
  });

  it('an Update+Move of a rulebook path is refused by its SOURCE path, not only its destination', async () => {
    const sourcePath = path.join(root, '.claude', 'hooks', 'guard-bash.mjs');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// real hook file, moved out of the rulebook by the patch\n');
    await armed(['src/']);
    const result = await run(updateMovePatch('.claude/hooks/guard-bash.mjs', 'src/moved.mjs'));
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.claude/hooks/guard-bash.mjs');
  });

  it('control: a Delete File outside the rulebook stays allowed', async () => {
    const target = path.join(root, 'src', 'a.txt');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'ordinary file\n');
    await armed(['src/']);
    const result = await run(deletePatch('src/a.txt'));
    expect(result.code, result.stderr).toBe(0);
  });

  it('control: an Update+Move between two non-rulebook paths stays allowed', async () => {
    const sourcePath = path.join(root, 'src', 'a.txt');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'ordinary file\n');
    await armed(['src/']);
    const result = await run(updateMovePatch('src/a.txt', 'src/c.txt'));
    expect(result.code, result.stderr).toBe(0);
  });

  it('a Delete File of a rulebook path is allowed when the allow-list names that exact prefix', async () => {
    const target = path.join(root, '.claude', 'hooks', 'guard-bash.mjs');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '// real hook file\n');
    await armed(['.claude/hooks/']);
    const result = await run(deletePatch('.claude/hooks/guard-bash.mjs'));
    expect(result.code, result.stderr).toBe(0);
  });

  it('an attended session (no unattended flag) still allows a Delete File of a rulebook path', async () => {
    const target = path.join(root, '.claude', 'hooks', 'guard-bash.mjs');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '// real hook file\n');
    const result = await run(deletePatch('.claude/hooks/guard-bash.mjs'));
    expect(result.code, result.stderr).toBe(0);
  });

  // RP-322 — a failure-diagnostician traced a flake back to this same
  // repository-root resolution: `edit-input.mjs`'s `patchFragments` runs
  // `git rev-parse --show-toplevel` with a bare 1-second timeout
  // (`edit-input.mjs`, just above where `patchFragments` builds its budget),
  // and the catch a few lines below leaves `budget.repoRoot` null on ANY
  // failure, including a timeout under host load or a cold process start.
  // From that point every fragment in the patch — however ordinary its
  // destination — resolves to the pathless global refusal "patch destination
  // is outside the repository or cannot be resolved safely" instead of the
  // destination-specific judgment the RP-214 tests above exercise.
  // `unattended-flag.mjs` runs the very same command with a 10-second bound
  // (its own `GIT_ROOT_TIMEOUT_MS`, inside `gitCheckoutToplevel`). These
  // tests make `git` itself slow with a real stub script on PATH — never a
  // mock of the guard's own code — so what they measure is the guard's
  // actual behaviour under load, not an assumption about its internals.
  describe('a slow git must not turn an ordinary destination into an unresolvable one (RP-322)', () => {
    let stubDir: string;
    let realGitPath: string;

    beforeEach(async (ctx) => {
      skipUnless(ctx, gitStubAvailable().ok, gitStubAvailable().reason);
      realGitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      stubDir = await mkdtemp(path.join(tmpdir(), 'rp322-git-stub-'));
    });

    afterEach(async () => {
      if (stubDir) await removeFixture(stubDir);
    });

    /** Installs a `git` on PATH that sleeps `delaySeconds` before exec'ing the real binary. */
    const installSlowGit = async (delaySeconds: number) => {
      const stubPath = path.join(stubDir, 'git');
      await writeFile(stubPath, `#!/bin/sh\nsleep ${delaySeconds}\nexec "${realGitPath}" "$@"\n`);
      await chmod(stubPath, 0o755);
    };

    const runWithSlowGit = (payload: object) =>
      runHookFull(payload, {
        ...env(),
        PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      });

    it('allows an ordinary allowed Delete File destination even when git itself takes 1.5s to answer', async () => {
      await installSlowGit(1.5);
      const target = path.join(root, 'src', 'a.txt');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'ordinary file\n');
      await armed(['src/']);
      const result = await runWithSlowGit(deletePatch('src/a.txt'));
      expect(result.code, result.stderr).toBe(0);
    }, 15_000);

    it('still refuses a Delete File of a rulebook path BY NAME under a slow git, not by the generic unresolvable-destination refusal', async () => {
      await installSlowGit(1.5);
      const settingsPath = path.join(root, '.claude', 'settings.json');
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, '{}\n');
      await armed(['src/']);
      const result = await runWithSlowGit({
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        cwd: root,
        tool_input: {
          command:
            '*** Begin Patch\n*** Delete File: .claude/settings.json\n*** Add File: src/b.txt\n+hello\n*** End Patch\n',
        },
      });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain('.claude/settings.json');
      expect(result.stderr).not.toMatch(/cannot be resolved safely/);
    }, 15_000);

    it('still refuses when cwd is not a git repository at all, flag armed — the fix must not weaken this control', async () => {
      const nonGitDir = await mkdtemp(path.join(tmpdir(), 'rp322-nogit-'));
      try {
        await armed(['src/']);
        const result = await run({
          hook_event_name: 'PreToolUse',
          tool_name: 'apply_patch',
          cwd: nonGitDir,
          tool_input: { command: '*** Begin Patch\n*** Delete File: src/a.txt\n*** End Patch\n' },
        });
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr).toMatch(/cannot be resolved safely/);
      } finally {
        await removeFixture(nonGitDir);
      }
    });

    it('tolerates the same order-of-magnitude git delay unattended-flag.mjs already tolerates, checked behaviourally rather than by importing either bound', async () => {
      await installSlowGit(3);
      await armed(['src/']);
      // Independent oracle (`.claude/rules/invariants.md`, "the
      // independent-oracle invariant"): unattended-flag.mjs's own
      // `git rev-parse --show-toplevel` call (`gitCheckoutToplevel`, run by
      // `requireRoot` inside its `verify` subcommand) is a second,
      // differently-coded resolver of "this checkout's git root" — probed
      // here as a black box, by spawning its CLI and reading whether it
      // succeeds, never by importing `GIT_ROOT_TIMEOUT_MS` or any constant
      // out of edit-input.mjs. `verify` is a pure read (unlike `on`, it never
      // calls `writeUnattended`, which mirrors into the real password-database
      // home no fixture `HOME` can redirect — RP-271/RP-263) — reading the
      // flag `armed()` above already wrote directly into this fixture's own
      // home. If both edit-input.mjs and unattended-flag.mjs survive the same
      // real delay, edit-input.mjs's own bound is at least the same order of
      // magnitude — this does not pin the exact figure, only the class.
      const slowGitEnv = {
        ...process.env,
        HOME: home,
        PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      };
      const verifyOutput = execFileSync(
        process.execPath,
        [
          path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs'),
          'verify',
          '--item',
          'AR-51',
          '--root',
          root,
        ],
        { env: slowGitEnv, encoding: 'utf8', timeout: 8000 },
      );
      expect(verifyOutput).toMatch(/armed|loop-UNATTENDED/);

      const target = path.join(root, 'src', 'a.txt');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'ordinary file\n');
      const result = await runWithSlowGit(deletePatch('src/a.txt'));
      expect(result.code, result.stderr).toBe(0);
    }, 15_000);
  });
});

/**
 * RP-244 — failure-diagnostician, measured on NTFS at 1221613 (this
 * branch's base). `normalisePath` (`edit-input.mjs`) converts every
 * backslash to a forward slash and then runs `path.posix.normalize`, which
 * collapses the leading `//` a Win32 verbatim (`\\?\`) prefix depends on:
 * `\\?\C:\<root>\.claude\settings.json` reaches this guard as
 * `/?/C:/<root>/.claude/settings.json`, which `canonicalRulebookPath` never
 * matches against any rulebook prefix — so `protectedRelative` finds
 * nothing and this hook exits 0 (ALLOW) — while Node's own `fs` writes
 * through that verbatim spelling to the real, guarded file. The plain
 * spelling of every path below already exits 2, proven throughout the rest
 * of this file.
 *
 * Win32-only: a verbatim spelling only resolves to a real file on a Windows
 * filesystem, so these run in the windows-e2e lane. The
 * platform-independent pin on the normaliser itself is
 * `edit-fragments.test.ts` (absent in a generated rig) › "editFragments:
 * normalisePath resolves a Win32 verbatim/device path the way the OS does
 * (RP-244)".
 *
 * RP-244 round 2 — security-scanner HOLD on PR #302, measured on NTFS at
 * this branch's base 1221613. Three more spellings measured directly against
 * the real, armed `root` fixture: a doubled separator after the `?` (blocker
 * 2), a verbatim UNC admin-share form (`\\?\UNC\localhost\<drive>$\…`, the
 * verbatim spelling of blocker 1's plain-UNC bypass), and an NTFS ADS on the
 * `.claude` directory component reached through the verbatim prefix. The
 * platform-independent pin for blockers 1–4 as a class — that a `//`-prefixed
 * normalised path is refused rather than silently allowed while armed,
 * because `guard-rulebook` cannot judge it against the repository root — is
 * `guard-rulebook: an unjudgeable UNC/device-namespace path is refused, not
 * silently allowed (RP-244 round 2)` further down this file; it needs no real
 * filesystem, so it runs on every platform.
 */
// RP-463: a Codex patch may spell a path absolutely. The same root resolver
// serves every patch verb, so these public-hook cases cover a safe absolute
// destination, a removal, and both sides of a move without importing the
// resolver the hooks use.
describe('guard-rulebook: applies the same unattended allow-list to contained absolute apply_patch paths (RP-463)', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q', root], { env: withoutGitLocation() });
  });

  const absolute = (relative: string) => path.join(root, ...relative.split('/'));
  const applyPatch = (command: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    cwd: root,
    tool_input: { command },
  });

  it.each(['Add', 'Update', 'Delete'] as const)(
    'allows an absolute %s path that resolves inside an allowed src/ prefix',
    async (verb) => {
      const source = absolute('src/original.ts');
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, 'export const original = true;\n');
      await armed(['src/']);

      const command =
        verb === 'Add'
          ? `*** Begin Patch\n*** Add File: ${absolute('src/caf\u00e9-\u6771\u4eac.ts')}\n+export const added = true;\n*** End Patch\n`
          : verb === 'Update'
            ? `*** Begin Patch\n*** Update File: ${source}\n@@\n+export const updated = true;\n*** End Patch\n`
            : `*** Begin Patch\n*** Delete File: ${source}\n*** End Patch\n`;
      const result = await run(applyPatch(command));
      expect(result.code, result.stderr).toBe(0);
    },
  );

  it('allows an absolute move only when both its source and destination resolve in the allowed prefix', async () => {
    const source = absolute('src/original.ts');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'export const original = true;\n');
    await armed(['src/']);
    const result = await run(
      applyPatch(
        `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${absolute('src/moved.ts')}\n@@\n+export const moved = true;\n*** End Patch\n`,
      ),
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it('does not let an absolute rulebook destination bypass the canonical relative allow-list', async () => {
    await armed(['src/']);
    const result = await run(
      applyPatch(
        `*** Begin Patch\n*** Add File: ${absolute('.claude/settings.json')}\n+{}\n*** End Patch\n`,
      ),
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/rulebook|allow-list|AR-51/i);
    expect(result.stderr).not.toMatch(/cannot be resolved safely|split/i);
  });

  it('does not let an absolute rulebook MOVE SOURCE bypass the canonical relative allow-list', async () => {
    const source = absolute('.claude/hooks/guard-bash.mjs');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, '// real hook\n');
    await armed(['src/']);
    const result = await run(
      applyPatch(
        `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${absolute('src/moved.mjs')}\n@@\n+// moved\n*** End Patch\n`,
      ),
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/rulebook|allow-list|AR-51/i);
    expect(result.stderr).not.toMatch(/cannot be resolved safely|split/i);
  });

  it('refuses an absolute path that escapes through a symlink or junction, even when its lexical prefix is allowed', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-outside-')));
    try {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await symlink(
        outside,
        path.join(root, 'src', 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await armed(['src/']);
      const result = await run(
        applyPatch(
          `*** Begin Patch\n*** Add File: ${absolute('src/escape/untrusted.ts')}\n+export const untrusted = true;\n*** End Patch\n`,
        ),
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
      expect(result.stderr).not.toMatch(/split/i);
    } finally {
      await removeFixture(outside);
    }
  });

  it('refuses an absolute path in the distinct NTFS sibling whose Unicode casing path.relative folds while unattended', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-unicode-parent-')));
    const repositoryLexical = path.join(parent, 'repo\u0130');
    const outsideLexical = path.join(parent, 'repoi\u0307');
    try {
      await mkdir(repositoryLexical);
      await mkdir(outsideLexical);
      const repository = realpathSync.native(repositoryLexical);
      const outside = realpathSync.native(outsideLexical);
      expect(repository).not.toBe(outside);
      execFileSync('git', ['init', '-q', repository], { env: withoutGitLocation() });

      const fixtureEnv = { HOME: home, CLAUDE_PROJECT_DIR: repository };
      const { unattendedFlags } = await import(
        pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
      );
      const flag = unattendedFlags(fixtureEnv)[0];
      await mkdir(path.dirname(flag), { recursive: true });
      await writeFile(
        flag,
        JSON.stringify({
          item: 'RP-463',
          runDir: path.join(repository, '.rig-run'),
          allow: ['src/'],
        }),
      );
      const applyPatchAt = (filePath: string) => ({
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        cwd: repository,
        tool_input: {
          command: `*** Begin Patch\n*** Add File: ${filePath}\n+export const safe = true;\n*** End Patch\n`,
        },
      });

      const relativeControl = await runHookFull(
        applyPatchAt('src/relative-control.ts'),
        fixtureEnv,
      );
      expect(relativeControl.code, relativeControl.stderr).toBe(0);
      const absoluteControl = await runHookFull(
        applyPatchAt(path.join(repository, 'src', 'absolute-control.ts')),
        fixtureEnv,
      );
      expect(absoluteControl.code, absoluteControl.stderr).toBe(0);

      const result = await runHookFull(applyPatchAt(path.join(outside, 'payload.ts')), fixtureEnv);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
      expect(result.stderr).not.toMatch(/split/i);
    } finally {
      await removeFixture(parent);
    }
  });
});

describe('guard-rulebook: a Win32 verbatim path does not bypass the guard (RP-244)', () => {
  const verbatimOf = (rel: string) => `\\\\?\\${root}\\${rel.replaceAll('/', '\\')}`;

  // RP-244 round 2, blocker 2: two separators after the `?` instead of one.
  const doubledSeparatorOf = (rel: string) => `\\\\?\\\\${root}\\${rel.replaceAll('/', '\\')}`;

  // RP-244 round 2, blocker 1 (verbatim spelling): the admin-share UNC form
  // of the real root, e.g. `\\?\UNC\localhost\C$\Users\…\<root>\…`.
  const uncAdminShareOf = (rel: string) => {
    const match = /^([A-Za-z]):(.*)$/.exec(root);
    if (!match)
      throw new Error(
        `root is not a drive-letter path, cannot build a UNC admin share from it: ${root}`,
      );
    const [, drive, rest] = match;
    return `\\\\?\\UNC\\localhost\\${drive}$${rest}\\${rel.replaceAll('/', '\\')}`;
  };

  it('blocks a Write to the verbatim spelling of .claude/settings.json', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await run(write(verbatimOf('.claude/settings.json')));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Write to the doubled-separator verbatim spelling of .claude/settings.json (RP-244 round 2)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await run(write(doubledSeparatorOf('.claude/settings.json')));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Write to the verbatim UNC admin-share spelling of .claude/settings.json (RP-244 round 2)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await run(write(uncAdminShareOf('.claude/settings.json')));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Write to the verbatim spelling of an NTFS ADS on the .claude directory component (RP-244 round 2)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    // The ADS spelling only folds to the real `.claude` directory through
    // `canonicalPath`'s `realpathSync.native`, which needs `<root>/.claude`
    // to already exist on disk — the same protection is absent without it.
    // This is the real-world case: an existing checkout already has a
    // `.claude` directory.
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await armed(['src/']);
    const result = await run(write(verbatimOf('.claude::$INDEX_ALLOCATION/settings.json')));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Write to the verbatim spelling of CLAUDE.md', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await run(write(verbatimOf('CLAUDE.md')));
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks a Write to the verbatim spelling of .claude/hooks/guard-bash.mjs', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await run(write(verbatimOf('.claude/hooks/guard-bash.mjs')));
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows a Write to the verbatim spelling of src/x.ts under the armed allow-list', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await run(write(verbatimOf('src/x.ts')));
    expect(result.code, result.stderr).toBe(0);
  });

  it('an attended session (no unattended flag) allows the verbatim spelling of .claude/settings.json', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const result = await run(write(verbatimOf('.claude/settings.json')));
    expect(result.code, result.stderr).toBe(0);
  });

  // RP-244 round 3, security-scanner finding A: `normalisePath`'s DRIVE
  // branch (and its plain fallback) normalise `C:` and the remainder
  // TOGETHER, relatively, so a `..` immediately after the drive root walks
  // past it instead of clamping there the way Win32 itself does. Built from
  // the fixture's own real root rather than a literal drive letter, because
  // the escaped spelling has to land back on THIS checkout for `fs` to
  // write through it the way the diagnosis describes.
  const driveRootEscapeOf = (rel: string) => {
    const match = /^([A-Za-z]):(.*)$/.exec(root);
    if (!match)
      throw new Error(
        `root is not a drive-letter path, cannot build a drive-root escape from it: ${root}`,
      );
    const [, drive, rootTail] = match;
    return `${drive}:\\..${rootTail}\\${rel.replaceAll('/', '\\')}`;
  };

  it('blocks a Write to a `..`-escaped drive-root spelling of .claude/settings.json (RP-244 round 3)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await run(write(driveRootEscapeOf('.claude/settings.json')));
    expect(result.code, result.stderr).toBe(2);
  });

  // RP-244 round 4, security-scanner finding on PR #302, round 3's fix
  // measured on NTFS. A DRIVE-RELATIVE spelling — `<drive>:` with NO
  // separator immediately after the colon, followed by two (or more) `..`
  // segments — is left to plain `path.posix.normalize` over the drive
  // marker and remainder together, and `path.posix.normalize` treats the
  // segment `C:..` as an ordinary filename, not the literal `..`: the
  // SECOND `..` segment cancels it exactly as it would cancel any other
  // segment, and the drive marker disappears from `normalisePath`'s output
  // entirely, leaving `guard-rulebook` a bare, driveless relative path with
  // no signal that it ever named a drive-relative spelling.
  //
  // Win32 itself resolves a drive-relative path against the CURRENT
  // DIRECTORY OF THAT DRIVE — the process's own cwd, when the path's drive
  // letter matches it — which is why this fixture spawns the hook with
  // `cwd: root` explicitly (`run()` above does not set one; a coding
  // agent's hook invocation ordinarily does run with cwd = the checkout
  // root, which is the alignment this reproduces). The crafted `..\..`
  // walks up from `root` to its grandparent, and the two path segments that
  // follow walk back down through `root`'s own trailing components,
  // landing on the real, guarded file — the same way Win32 would resolve
  // the untouched original string.
  //
  // Platform-independent pin on `normalisePath` itself:
  // `edit-fragments.test.ts` (absent in a generated rig) › "a drive-relative
  // spelling never lets a `..` cancel the drive marker itself (RP-244
  // round 4)".
  const driveRelativeEscapeOf = (rel: string) => {
    const match = /^([A-Za-z]):(.*)$/.exec(root);
    if (!match)
      throw new Error(
        `root is not a drive-letter path, cannot build a drive-relative escape from it: ${root}`,
      );
    const [, drive] = match;
    const grandparent = path.dirname(path.dirname(root));
    const segments = path.relative(grandparent, root).split(path.sep);
    const up = segments.map(() => '..').join('\\');
    return `${drive}:${up}\\${segments.join('\\')}\\${rel.replaceAll('/', '\\')}`;
  };

  it('blocks a Write to a drive-relative `..\\..` escape of .claude/settings.json, run with the checkout root as cwd (RP-244 round 4)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const result = await runHookFull(
      write(driveRelativeEscapeOf('.claude/settings.json')),
      env(),
      'guard-rulebook.mjs',
      root,
    );
    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks the verbatim-prefixed form of the same drive-relative escape (RP-244 round 4)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed(['src/']);
    const verbatim = `\\\\?\\${driveRelativeEscapeOf('.claude/settings.json')}`;
    const result = await runHookFull(write(verbatim), env(), 'guard-rulebook.mjs', root);
    expect(result.code, result.stderr).toBe(2);
  });
});

/**
 * RP-244 round 2 — security-scanner HOLD on PR #302, measured on NTFS at
 * this branch's base 1221613, generalised: `normalisePath` (`edit-input.mjs`)
 * maps every UNC and other device-namespace spelling to a `//`-prefixed
 * result (`//server/share/…`, `//?/Volume{…}/…`) — round 1 fixed
 * `\\?\C:\…`/`\\.\C:\…` but left this whole family alone. `relativeTo`
 * (above, in this file) can only strip a path that starts with the literal
 * repository root; a `//`-prefixed path never does, on any platform and
 * against any root, so `protectedRelative` finds nothing and this hook exits
 * 0 — while a UNC or device-namespace spelling reaches a REAL file on a
 * Windows filesystem underneath. The refusal itself is a string-comparison
 * decision, but production canonicalises each spelling before reaching it.
 * The finite absent-share preload below controls that native lookup for the
 * invented-share fixtures; it does not stand in for the real Windows
 * canonicalisation cases elsewhere in this file.
 *
 * The fix: while armed, a fragment whose normalised path begins with `//`
 * cannot be resolved against the repository root at all, so it is refused
 * (exit 2) rather than silently falling through "nothing under the
 * rulebook: never judged" — the same "refusing to inspect is not allowing"
 * shape this file already uses for an unreadable flag and for a pathless
 * global refusal. Attended sessions are untouched, exactly as for every
 * other rulebook path.
 */
describe('guard-rulebook: an unjudgeable UNC/device-namespace path is refused, not silently allowed (RP-244 round 2)', () => {
  const unjudgeablePaths: Array<[string, string]> = [
    ['a plain (non-verbatim) UNC admin share', plainAdminSharePath],
    ['a verbatim UNC admin share', verbatimAdminSharePath],
    [
      'a verbatim device path with no drive letter (a volume GUID path)',
      String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\x\.claude\settings.json`,
    ],
  ];

  it.each(unjudgeablePaths)(
    'blocks a Write to %s while armed, because it cannot be resolved against the repository root',
    async (_label, filePath) => {
      await armed(['src/']);
      if (controlledAdminShareFixturePaths.has(filePath)) {
        const result = await runControlledAdminShare(write(filePath));
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr).toMatch(/resolved against the repository root/i);
        expectControlledAdminShareTrace(result.entries, filePath);
        return;
      }
      const result = await run(write(filePath));
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/resolved against the repository root/i);
    },
  );

  it.each(unjudgeablePaths)(
    'an attended session (no unattended flag) still allows a Write to %s',
    async (_label, filePath) => {
      if (controlledAdminShareFixturePaths.has(filePath)) {
        const result = await runControlledAdminShare(write(filePath));
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('');
        expectControlledAdminShareTrace(result.entries, filePath);
        return;
      }
      const result = await run(write(filePath));
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
    },
  );
});

/**
 * RP-244 round 3 — code-reviewer BLOCKER on PR #302. The `//`-prefix refusal
 * above lives only in the ordinary per-fragment loop; the GLOBAL refusal
 * branch a few lines earlier in `guard-rulebook.mjs` (an `appliesToAll`
 * inspection refusal that carries a `filePath` — an oversized MultiEdit is
 * the one editFragments produces with a path attached: `edit-input.mjs`'s
 * `MAX_MULTI_EDITS` cap) takes a different, older path: it calls
 * `protectedRelative` directly and reads `rel === undefined` as "outside the
 * rulebook, never judged" — exactly the reading blocker 1-3 above already
 * proved wrong for a `//`-prefixed path, because `relativeTo` can never strip
 * a literal repository root from one. So a MultiEdit past the fragment cap,
 * aimed at a `//`-prefixed spelling of a rulebook file, exits 0 while armed:
 * `protectedRelative` finds nothing, `rel === undefined`, and the branch
 * returns 0 before the `unjudgeable` check below it is ever computed.
 * Measured on this Linux checkout at this branch's head `b0114ac`: a
 * MultiEdit with 257 edits to `\\?\UNC\srv\share\x\.claude\settings.json`
 * exits 0 while armed (a `Write` to the same path exits 2 — the ordinary
 * per-fragment path already fixed in round 2). This needs no real
 * filesystem, so it runs on every platform, including Linux.
 */
describe('guard-rulebook: a MultiEdit global refusal is not exempt from the `//`-prefix refusal (RP-244 round 3)', () => {
  const multiEdit257 = (filePath: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: filePath,
      edits: Array.from({ length: 257 }, () => ({ old_string: 'a', new_string: 'b' })),
    },
  });

  // The same three unjudgeable spellings the per-fragment block above pins,
  // duplicated here rather than shared: they belong to two different
  // describe blocks and the array above is local to its own callback.
  const unjudgeablePaths: Array<[string, string]> = [
    ['a plain (non-verbatim) UNC admin share', plainAdminSharePath],
    ['a verbatim UNC admin share', verbatimAdminSharePath],
    [
      'a verbatim device path with no drive letter (a volume GUID path)',
      String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\x\.claude\settings.json`,
    ],
  ];

  it.each(unjudgeablePaths)(
    'blocks a MultiEdit beyond the fragment cap to %s while armed',
    async (_label, filePath) => {
      await armed(['src/']);
      if (controlledAdminShareFixturePaths.has(filePath)) {
        const result = await runControlledAdminShare(multiEdit257(filePath));
        expect(result.code, result.stderr).toBe(2);
        expectControlledAdminShareTrace(result.entries, filePath);
        return;
      }
      const result = await run(multiEdit257(filePath));
      expect(result.code, result.stderr).toBe(2);
    },
  );

  it.each(unjudgeablePaths)(
    'an attended session (no unattended flag) still allows a MultiEdit beyond the fragment cap to %s',
    async (_label, filePath) => {
      if (controlledAdminShareFixturePaths.has(filePath)) {
        const result = await runControlledAdminShare(multiEdit257(filePath));
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('');
        expectControlledAdminShareTrace(result.entries, filePath);
        return;
      }
      const result = await run(multiEdit257(filePath));
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
    },
  );

  // Control: an ordinary relative, non-rulebook path is untouched by this
  // fix either way — its known path is outside the rulebook, the same
  // "allows a MultiEdit beyond the fragment cap when its known path is
  // outside the rulebook" shape pinned above with an absolute path. Pinned
  // here so a future change to the `//`-prefix handling cannot silently
  // start refusing an ordinary MultiEdit too.
  it('control: still allows a MultiEdit beyond the fragment cap to an ordinary relative, non-rulebook path (src/x.ts)', async () => {
    await armed(['src/']);
    const result = await run(multiEdit257('src/x.ts'));
    expect(result.code, result.stderr).toBe(0);
  });
});

/**
 * RP-244 round 3 — code-reviewer REFINEMENT on PR #302. The `//`-prefix
 * refusal (round 2, two blocks above) is right that `relativeTo` can never
 * strip a repository root spelled as a PLAIN path from a `//`-prefixed
 * payload path — but the repository root is not always plain. A checkout
 * opened through a UNC share (`\\server\share\repo`, e.g. a WSL distro
 * reached from Windows as `\\wsl$\Ubuntu\home\u\repo`) has a UNC-spelled
 * root itself, and `toPosix` (this file's guard, above `relativeTo`) maps
 * that root to the same `//`-prefixed shape a payload path under it
 * normalises to — so the two CAN be compared, and a path genuinely under
 * that root should be judged normally: allowed when it is outside the
 * rulebook, refused with the ordinary "is part of the rulebook" reason when
 * it is inside it. Only a `//`-prefixed path that resolves under NO
 * comparison root is genuinely undecidable and earns the "could not be
 * resolved against the repository root" reason.
 *
 * `canonicalRoot` (`guard-rulebook.mjs`) falls back to the RAW root string
 * on `realpathSync.native`'s ENOENT — it does not need the root to exist to
 * compare it lexically, the same fallback `canonicalPath` uses for a payload
 * path (see this file's own header comment, "Limits", the UNC/device bullet).
 * The behaviour oracle remains the literal path comparison, but production
 * deliberately canonicalises every spelling first. This fixture supplies
 * ENOENT only for the enumerated invented-share names below, preserving that
 * production canonicalisation while avoiding an SMB lookup; all other paths
 * still use the native resolver. Hand-written literal expectations only, per
 * this project's independent-oracle invariant.
 */
describe('guard-rulebook: a `//`-prefixed path is refused only when it resolves under no repository root (RP-244 round 3)', () => {
  const uncRoot = String.raw`\\server\share\repo`;
  const uncRulebookPath = String.raw`\\server\share\repo\.claude\settings.json`;
  const uncOutsidePath = String.raw`\\srv\share\x\.claude\settings.json`;
  // These are the only invented network locations that the test child may
  // turn into controlled ENOENT. The resolver still reaches each missing
  // ancestor while canonicalPath walks upward, so those names are explicit
  // too; no prefix or general network-path mock is involved.
  const controlledUncPaths = [
    uncRoot,
    String.raw`\\server\share\repo\src\x.ts`,
    String.raw`\\server\share\repo\src`,
    uncRulebookPath,
    String.raw`\\server\share\repo\.claude`,
    String.raw`\\server\share`,
    '\\\\server\\share\\',
    String.raw`\\server`,
    uncOutsidePath,
    String.raw`\\srv\share\x\.claude`,
    String.raw`\\srv\share\x`,
    String.raw`\\srv\share`,
    '\\\\srv\\share\\',
    String.raw`\\srv`,
  ];
  const CONTROLLED_UNC_REALPATH_PRELOAD = `
import { appendFileSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const controlled = new Set(JSON.parse(process.env.RP360_CONTROLLED_UNC_PATHS || '[]'));
const trace = process.env.RP360_CONTROLLED_UNC_TRACE;
const localProbe = process.env.RP360_LOCAL_REALPATH_PROBE;
const native = realpathSync.native;
const record = (entry) => appendFileSync(trace, JSON.stringify(entry) + '\\n');

realpathSync.native = (candidate, ...args) => {
  if (controlled.has(candidate)) {
    record({ kind: 'controlled', candidate });
    const error = new Error('ENOENT: controlled absent UNC fixture');
    error.code = 'ENOENT';
    throw error;
  }
  record({ kind: 'delegated-start', candidate });
  const resolved = native(candidate, ...args);
  record({ kind: 'delegated', candidate, resolved });
  return resolved;
};
syncBuiltinESMExports();

if (localProbe) realpathSync.native(localProbe);
`;
  const uncEnv = () => ({ HOME: home, CLAUDE_PROJECT_DIR: uncRoot });
  const controlledUncFixture = async () => {
    const preload = path.join(home, 'controlled-unc-realpath-preload.mjs');
    const flagPathHelper = path.join(home, 'controlled-unc-flag-path.mjs');
    const traceRoot = process.env.RP360_UNC_TRACE_ROOT
      ? path.join(process.env.RP360_UNC_TRACE_ROOT, 'rp360-unc-fixture-traces')
      : home;
    const trace = path.join(
      traceRoot,
      `${path.basename(home)}-controlled-unc-realpath-trace.jsonl`,
    );
    await mkdir(traceRoot, { recursive: true });
    await writeFile(preload, CONTROLLED_UNC_REALPATH_PRELOAD);
    await writeFile(
      flagPathHelper,
      `import { unattendedFlags } from ${JSON.stringify(
        pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href,
      )};\nprocess.stdout.write(unattendedFlags(process.env)[0]);\n`,
    );
    const localTarget = path.join(home, 'canonical-local-target');
    const localProbe = path.join(home, 'canonical-local-alias');
    await mkdir(localTarget, { recursive: true });
    await symlink(localTarget, localProbe, process.platform === 'win32' ? 'junction' : 'dir');
    const localResolved = await realpath(localTarget);
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
      .filter(Boolean)
      .join(' ');
    const fixtureEnv = {
      ...uncEnv(),
      NODE_OPTIONS: nodeOptions,
      RP360_CONTROLLED_UNC_PATHS: JSON.stringify(controlledUncPaths),
      RP360_CONTROLLED_UNC_TRACE: trace,
      RP360_LOCAL_REALPATH_PROBE: localProbe,
    };
    return { fixtureEnv, flagPathHelper, localProbe, localResolved, trace };
  };
  const armedUnc = async (
    allow: string[],
    { fixtureEnv, flagPathHelper }: Awaited<ReturnType<typeof controlledUncFixture>>,
  ) => {
    const flag = execFileSync(process.execPath, [flagPathHelper], {
      encoding: 'utf8',
      env: { ...process.env, ...fixtureEnv },
    }).trim();
    await mkdir(path.dirname(flag), { recursive: true });
    await writeFile(
      flag,
      JSON.stringify({ item: 'RP-244', runDir: path.join(uncRoot, '.rig-run'), allow }),
    );
  };
  const runUnc = async (
    payload: object,
    {
      fixtureEnv,
      localProbe,
      localResolved,
      trace,
    }: Awaited<ReturnType<typeof controlledUncFixture>>,
  ) => {
    const result = await runHookFull(payload, fixtureEnv);
    const entries = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; candidate: string; resolved?: string });
    return { ...result, entries, localProbe, localResolved };
  };

  it('uses only declared absent-share paths and delegates the local canonical probe', async () => {
    const fixture = await controlledUncFixture();
    await armedUnc(['src/'], fixture);
    const result = await runUnc(write(uncRulebookPath), fixture);

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/is part of the rulebook/i);
    const controlled = result.entries.filter((entry) => entry.kind === 'controlled');
    expect(controlled.length).toBeGreaterThan(0);
    for (const entry of controlled) expect(controlledUncPaths).toContain(entry.candidate);
    const uncEntries = result.entries.filter(
      (entry) => entry.candidate.startsWith('\\\\') || entry.candidate.startsWith('//'),
    );
    for (const entry of uncEntries) expect(controlledUncPaths).toContain(entry.candidate);
    expect(result.entries).toContainEqual({
      kind: 'delegated',
      candidate: result.localProbe,
      resolved: result.localResolved,
    });
    expect(result.localResolved).not.toBe(result.localProbe);
  });

  it('allows a Write under the UNC repository root when the target is outside the rulebook', async () => {
    const fixture = await controlledUncFixture();
    await armedUnc(['src/'], fixture);
    const result = await runUnc(write(String.raw`\\server\share\repo\src\x.ts`), fixture);
    expect(result.code, result.stderr).toBe(0);
  });

  it('blocks a Write under the UNC repository root to a rulebook path, with the ordinary rulebook reason', async () => {
    const fixture = await controlledUncFixture();
    await armedUnc(['src/'], fixture);
    const result = await runUnc(write(uncRulebookPath), fixture);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/is part of the rulebook/i);
    expect(result.stderr).not.toMatch(/resolved against the repository root/i);
  });

  it('blocks a Write to a `//`-prefixed path outside the UNC repository root, with the "could not be resolved" reason', async () => {
    const fixture = await controlledUncFixture();
    await armedUnc(['src/'], fixture);
    const result = await runUnc(write(uncOutsidePath), fixture);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/resolved against the repository root/i);
  });
});

/**
 * RP-247 round 2 — security-scanner HOLD on PR #350, head `3a7379c`, and the
 * decision that followed it.
 *
 * Round 1 gave `canonicalPath` its own defensive bound check
 * (`exceedsPathComponentBound(resolved)`, reusing `edit-input.mjs`'s own
 * budget) so the realpath walk itself can no longer grow with the crafted
 * path's component count. But past the bound, `canonicalPath` returned
 * `filePath` — the RAW, UNRESOLVED string — instead of refusing.
 * `protectedRelative` reads that unresolved string as "not under the
 * rulebook": the lexical spelling never starts with a rulebook prefix, only
 * the REAL, resolved location might. Two reproductions of the same gap, both
 * found on PR #350's head rather than guessed:
 *
 *  1. Native Windows, a real junction: `root/alias` made to alias
 *     `root/.claude`, then a Write to `alias/rules/` + 520 nested components
 *     + `evil.md` exits 0 armed — blocked at base (slow, but blocked by the
 *     rulebook match), ALLOWED at this head (fast, but silently wrong).
 *     Security's exact repro used a lowercased-drive spelling of `root`
 *     directly under `.claude/rules/`, no alias needed — pinned below,
 *     win32-only, alongside the alias variant.
 *  2. `canonicalPath` calls plain `resolve(filePath)`, which — for a
 *     RELATIVE `file_path` — resolves against `process.cwd()`, a value
 *     `edit-input.mjs`'s OWN bound check never sees (it only counts
 *     separators in the raw string the payload sent). So a `file_path` that
 *     is SHORT — never refused on the way in — can still push `resolve()`
 *     past the component bound once combined with a deep `cwd`, reproducing
 *     the same gap with no symlink and no Windows dependency at all: an
 *     ordinary, real, 520-level-deep directory on any filesystem gets the
 *     same silent "not under the rulebook" answer while armed. Pinned below
 *     first, since it is Linux-runnable.
 *
 * A companion diagnosis proposed capping `normalisePath`'s remaining absolute
 * branches (`DRIVE_ROOT_PREFIX`, the verbatim-drive branch, the UNC branch)
 * the same way its relative branches already are — that cap broke three
 * RP-244 tests pinning those branches clamping a 200,000-segment `../` run
 * cleanly, and security then measured all three as LINEAR (159–331 ms at
 * 200k components), so nothing there needed a bound. That cap is NOT part of
 * the fix; `edit-fragments.test.ts` records the decision where the rejected
 * design would otherwise have been pinned. The fix here — the only one
 * needed — is `canonicalPath` failing CLOSED once `resolve()` crosses the
 * bound: a sentinel `main()` reads and refuses, while armed, with the same
 * limit-plus-remedy shape `edit-input.mjs` already uses. That closes both
 * reproductions above without normalisePath needing to know about the
 * component bound at all for an absolute spelling.
 */
describe('guard-rulebook: canonicalPath fails closed when resolve() crosses the component bound, even for a short relative file_path (RP-247 round 2)', () => {
  const buildDeepCwd = async () => {
    // 520 levels: past MAX_PATCH_PATH_COMPONENTS (512, edit-input.mjs) on
    // its own, so `resolve('x.md')` against this cwd crosses the bound
    // regardless of `root`'s own path length.
    const segments = Array.from({ length: 520 }, (_, index) => `d${index}`);
    const dir = path.join(root, ...segments);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  it('refuses a Write of a short relative file_path once the deep cwd pushes resolve() past the bound', async (ctx) => {
    skipUnless(ctx, deepCwdSpawnAvailable().ok, deepCwdSpawnAvailable().reason);
    await armed([]);
    const cwd = await buildDeepCwd();

    // In-child measurement (RP-158): bound the GUARD's own work, not the
    // parent's wall clock around spawning it. See child-timing.test.ts.
    const result = await runNodeTimed(hookPath, {
      input: JSON.stringify(write('x.md')),
      env: { ...process.env, ...env() },
      cwd,
    });

    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/component/i);
    expect(result.stderr).toMatch(/limit/i);
    expect(result.stderr).toMatch(/split|smaller/i);
  });

  // The refusal above is conditioned on the unattended flag, the same way
  // every other guard-rulebook refusal is (`describe('guard-rulebook:
  // attended sessions are untouched', …)` elsewhere in this file) — this
  // hook does not newly become an access-control layer for attended
  // sessions just because RP-247 gives it a bound. Pinned explicitly rather
  // than assumed, because the planned fix could in principle have chosen
  // otherwise.
  it('an unarmed session still allows it — the refusal above applies only while the flag is armed', async (ctx) => {
    skipUnless(ctx, deepCwdSpawnAvailable().ok, deepCwdSpawnAvailable().reason);
    const cwd = await buildDeepCwd();

    const result = await runNodeTimed(hookPath, {
      input: JSON.stringify(write('x.md')),
      env: { ...process.env, ...env() },
      cwd,
    });

    expect(result.code, result.stderr).toBe(0);
  });

  it('still resolves an ordinary, shallow path normally — unchanged from today', async () => {
    await armed([]);
    const target = path.join(root, 'src', 'a', 'b', 'x.ts');
    const result = await run(write(target));
    expect(result.code, result.stderr).toBe(0);
  });

  // security-scanner's exact repro on PR #350, native Win32: a Write, armed,
  // to the LOWERCASED-drive spelling of `root` + `.claude\rules\` + 520
  // nested `x\` components + `evil.md`. Win32-only because `root` is a real
  // drive-letter path only there — the point being tested is `canonicalPath`
  // failing closed on an ABSOLUTE, drive-shaped spelling, not the
  // relative+deep-cwd form already pinned above.
  it('blocks a Write past the component bound through the lowercased-drive spelling of .claude/rules (security-scanner repro)', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed([]);
    const match = /^([A-Za-z]):(.*)$/.exec(root);
    const [, drive, rest] = match ?? [];
    if (drive === undefined || rest === undefined) {
      throw new Error(`root is not a drive-letter path, cannot build the repro: ${root}`);
    }
    const lowercasedRoot = `${drive.toLowerCase()}:${rest}`;
    const target = `${lowercasedRoot}\\.claude\\rules\\` + 'x\\'.repeat(520) + 'evil.md';

    const result = await run(write(target));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/component/i);
    expect(result.stderr).toMatch(/limit/i);
    expect(result.stderr).toMatch(/split|smaller/i);
  });

  // The junction-alias variant of the same repro (`aliasedRoot()`, defined
  // above): the LEXICAL spelling never starts with the rulebook prefix — it
  // goes through `home/checkout-alias`, not `root/.claude` — so only a real
  // symlink resolution would show this path lands in the rulebook, and that
  // resolution is exactly what crossing the component bound must not
  // silently skip past.
  it('blocks a Write through a symlink/junction alias into the rulebook, past the component bound', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    await armed([]);
    const alias = await aliasedRoot();
    const target = `${alias}\\.claude\\rules\\` + 'x\\'.repeat(520) + 'evil.md';

    const result = await run(write(target));

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/component/i);
    expect(result.stderr).toMatch(/limit/i);
    expect(result.stderr).toMatch(/split|smaller/i);
  });

  // RP-247 round 3 — a THIRD gap in `canonicalPath`, found while fixing the
  // round-2 bound: a variant of the extracted walk that skipped the
  // `realpath` attempt on the full resolved path (leaf included) was
  // rejected, because a `file_path` whose own LEAF is a symlink is never
  // resolved by a walk that never tries the leaf itself: `canonicalPath('src/link.md')`
  // would return the lexical `src/link.md` unchanged even when that symlink
  // points at `.claude/rules/x.md`, so a Write through such a link never
  // matches the rulebook prefix. No huge component count is needed. The case
  // runs wherever `symlinksAvailable` says a symlink can be created.
  it('blocks a Write to a symlink file whose target is inside the rulebook', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'rules', 'x.md'), 'protected\n');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await symlink(path.join(root, '.claude', 'rules', 'x.md'), path.join(root, 'src', 'link.md'));
    await armed([]);

    const result = await run(write(path.join(root, 'src', 'link.md')));

    expect(result.code, result.stderr).toBe(2);
  });
});

// RP-246 part 1: `realpathSync.native` keeps an admin-share UNC spelling of
// the repository root (`\\<host>\<drive>$\…`) rather than folding it to the
// local drive spelling of the same directory, so `comparisonRoots` (seeded
// from `canonicalRoot`/`selectedRoot`) ends up holding only UNC spellings.
// A payload path spelled with the LOCAL drive (`C:\…`, the spelling most
// tools actually use) then relativises under neither comparison root and is
// not `//`-prefixed either, so `protectedRelative` returns `undefined` for
// every candidate and `isUnjudgeablePath` never flags it either: the
// fragment is silently read as "outside the rulebook, never judged" instead
// of being refused as unjudgeable, the same way an unresolvable
// UNC/device-namespace payload path already is.
describe('guard-rulebook: an admin-share-spelled repository root must also recognise the local-drive spelling of the same payload path (RP-246)', () => {
  const armedFor = async (customEnv: Record<string, string>, allow: string[]): Promise<void> => {
    const { unattendedFlags } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const flag = unattendedFlags(customEnv)[0];
    await mkdir(path.dirname(flag), { recursive: true });
    await writeFile(
      flag,
      JSON.stringify({ item: 'RP-246', runDir: path.join(root, '.rig-run'), allow }),
    );
  };

  const adminShareRootOrThrow = (): string => {
    const match = /^([A-Za-z]):(.*)$/.exec(root);
    const [, drive, rest] = match ?? [];
    if (drive === undefined || rest === undefined) {
      throw new Error(`root is not a drive-letter path, cannot build the repro: ${root}`);
    }
    return `\\\\${hostname()}\\${drive}$${rest}`;
  };

  it('blocks a Write to the local-drive spelling of .claude/settings.json when CLAUDE_PROJECT_DIR is the admin-share UNC spelling of the same root', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const uncRoot = adminShareRootOrThrow();
    const customEnv = { HOME: home, CLAUDE_PROJECT_DIR: uncRoot };
    await armedFor(customEnv, []);

    // On origin/master this exits 0: neither the local-drive-spelled
    // literal filePath nor its own realpath-resolved canonical spelling
    // relativises under the UNC-only comparisonRoots, so the fragment is
    // treated as never judged.
    const result = await runHookFull(write(`${root}\\.claude\\settings.json`), customEnv);

    expect(result.code, result.stderr).toBe(2);
  });

  it('blocks the same local-drive target through a `..`-carrying spelling of it', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const uncRoot = adminShareRootOrThrow();
    const customEnv = { HOME: home, CLAUDE_PROJECT_DIR: uncRoot };
    await armedFor(customEnv, []);

    const target = `${root}\\.claude\\hooks\\..\\settings.json`;
    const result = await runHookFull(write(target), customEnv);

    expect(result.code, result.stderr).toBe(2);
  });

  it('control: the UNC admin-share spelling of the same payload path is already blocked', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const uncRoot = adminShareRootOrThrow();
    const customEnv = { HOME: home, CLAUDE_PROJECT_DIR: uncRoot };
    await armedFor(customEnv, []);

    const result = await runHookFull(write(`${uncRoot}\\.claude\\settings.json`), customEnv);

    expect(result.code, result.stderr).toBe(2);
  });
});

describe('guard-rulebook: refusing to inspect is not allowing', () => {
  it('blocks a rulebook edit when the flag exists but cannot be read, and names the file', async () => {
    await armed([], '{ not json');
    const { unattendedFlags } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const result = await run(write(`${root}/.claude/rules/x.md`));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unreadable/i);
    expect(result.stderr).toContain(unattendedFlags(env())[0]);
  });

  it('still allows an edit outside the rulebook when the flag is unreadable', async () => {
    await armed([], '{ not json');
    const result = await run(write(`${root}/src/x.ts`));
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('guard-rulebook: fails open on a payload it cannot understand', () => {
  it('allows an empty payload object', async () => {
    await armed([]);
    const result = await run({});
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows non-JSON stdin', async () => {
    await armed([]);
    const result = await run('this is not json');
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('guard-rulebook: wired, bounded in its own words, and written into the rules', () => {
  it('names every protected rulebook family in its header', async () => {
    const source = await readFile(hookPath, 'utf8');
    const header = source.split(/^import /m)[0] ?? '';
    const { RULEBOOK_PREFIXES } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    // Per entry, the token is the entry's own name: the last SLASH segment,
    // with one trailing extension stripped — never the first segment, and
    // never a bare top-level directory name shared by unrelated prose. The
    // slash and the dot are split separately on purpose: a combined split
    // picks the PARENT for a two-segment directory entry, so `.rig/claims/`
    // would derive "rig" again and re-open the very hole below.
    // A first-segment derivation once picked "rig" for
    // `.rig/revalidation.json`, and the header's unrelated disclosure
    // "(absent in a generated rig)" satisfied it by accident: rewording
    // that phrase alone flipped a real omission invisible. "manifest" is
    // the one entry the header names by concept rather than by its literal
    // last segment (`.rig-manifest.json`'s own segment is "rig-manifest",
    // never spelled out) and keeps its explicit override for that reason.
    const familyOf = (prefix: string) => {
      if (prefix.includes('manifest')) return 'manifest';
      const segments = prefix
        .replace(/^\.claude\//, '')
        .split('/')
        .filter(Boolean);
      const own = segments[segments.length - 1] ?? prefix;
      return own.replace(/^\./, '').replace(/\.[^.]+$/, '');
    };
    const families = [...new Set((RULEBOOK_PREFIXES as readonly string[]).map(familyOf))];
    const missing = families.filter((family) => !header.includes(family));
    expect(missing, 'guard-rulebook header omits protected families').toEqual([]);
  });

  it('is wired into settings.json on a matcher covering every edit surface', async () => {
    const settings = JSON.parse(
      await readFile(path.join(universal, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } };
    const editBlock = settings.hooks.PreToolUse.find(
      (h) => h.matcher?.includes('Write') && h.matcher.includes('Edit'),
    );
    expect(editBlock).toBeDefined();
    expect(editBlock!.matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|apply_patch');
    expect(editBlock!.hooks.some((x) => x.command.endsWith('guard-rulebook.mjs"'))).toBe(true);
  });

  it('states its limits in its header: one edit at a time, either home arms it, no Bash redirect', async () => {
    const header = (await readFile(hookPath, 'utf8')).split('\n').slice(0, 60).join('\n');
    expect(header).toMatch(/one edit at a time/i);
    expect(header).toMatch(/either home/i);
    expect(header).toMatch(/Bash/);
    expect(header).toMatch(/redirect/i);
  });

  it('is named in the Never tier of autonomy.md, with the word "unattended"', async () => {
    const autonomy = await readFile(
      path.join(universal, '.claude', 'rules', 'autonomy.md'),
      'utf8',
    );
    const never = autonomy.split(/^### Never/m)[1]?.split(/^## /m)[0] ?? '';
    const bullet = never
      .split('\n')
      .find((line) => /^- /.test(line) && line.includes('guard-rulebook'));
    expect(bullet, 'no Never bullet mentions guard-rulebook').toBeDefined();
    expect(bullet).toMatch(/unattended/i);
  });

  // RP-98. The Never bullet used to define the protected set by listing it, and
  // the list went stale the day `.claude/doctor-exemptions.json` was added to
  // RULEBOOK_PREFIXES (`0be11cfd`, 0.6.2) and the prose was not touched. A rule
  // that says a governance file is outside the rulebook, while the guard treats
  // it as inside, is worse than a rule that declines to enumerate: an unattended
  // run reads the prose, believes the file is ordinary project input, and then
  // meets a refusal the rule gave it no reason to expect.
  //
  // So the fix was subtraction, and this pins the shape rather than the list —
  // per `invariants.md`, "one mechanism, one implementation ... and one spelling
  // of a fact". Asserting the prose names all 14 entries would have re-created
  // the second copy one level up, where it would go stale the same way.
  //
  // ⚠ Two things this does NOT catch, measured rather than guessed.
  //
  // A DESCRIPTIVE paraphrase. Before the fix the bullet named ten prefixes
  // literally and three more only in words — "the integrity manifest"
  // (`.claude/.rig-manifest.json`), "the queue config" (`.claude/queue.json`),
  // "its always-refused board selector" (`.claude/queue.board`). Those three are
  // invisible here, and that is exactly how the fourth,
  // `doctor-exemptions.json`, went missing without a check noticing.
  //
  // A list somewhere ELSE. This reads one bullet of one file, so a competing
  // enumeration in another paragraph of `autonomy.md`, or in another rulebook
  // document, passes. One such gloss did exist in
  // `.claude/skills/loop/SKILL.md`; RP-102 replaced it with a pointer and gave
  // it its own check below. That is one document, not a sweep — a check that
  // walked every rulebook file would be a different mechanism than this one,
  // and it is RP-69's.
  it('points the Never bullet at RULEBOOK_PREFIXES instead of re-listing the protected set', async () => {
    const { RULEBOOK_PREFIXES } = (await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    )) as { RULEBOOK_PREFIXES: readonly string[] };

    const autonomy = await readFile(
      path.join(universal, '.claude', 'rules', 'autonomy.md'),
      'utf8',
    );
    const never = autonomy.split(/^### Never/m)[1]?.split(/^## /m)[0] ?? '';
    // The WHOLE bullet, continuation lines included — the list this guards
    // against lived on the lines after the one naming the hook, so a
    // first-line-only read would have found nothing to object to.
    const lines = never.split('\n');
    const start = lines.findIndex((line) => /^- /.test(line) && line.includes('guard-rulebook'));
    expect(start, 'no Never bullet names guard-rulebook').toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^- /.test(line));
    const bullet = [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
    expect(bullet.length, 'the bullet read back empty').toBeGreaterThan(0);

    // The pointer has to be live: a renamed export leaves the prose aiming at
    // nothing, which is the dead-reference half of the same defect.
    expect(bullet, 'the bullet must name the authoritative export').toContain('RULEBOOK_PREFIXES');

    // `.claude/{agents,hooks,...}` is one mention of five prefixes, so expand
    // before matching. Measured against the stale bullet this replaced, under
    // the `.claude/scripts/` exclusion below: expanded reports 9, unexpanded
    // reports 5 — four of the paths it re-listed would have slipped past.
    const expanded = bullet.replace(/([\w./-]*)\{([^}]*)\}/g, (_m, prefix: string, inner: string) =>
      inner
        .split(',')
        .map((part) => prefix + part.trim())
        .join(' '),
    );
    // Naming the directory that HOLDS the source is how you point at it, so
    // `.claude/scripts/` is allowed — via `.claude/scripts/unattended-flag.mjs`.
    // Every other protected path in the bullet is a second spelling of the set.
    const relisted = RULEBOOK_PREFIXES.filter(
      (prefix) => prefix !== '.claude/scripts/' && expanded.includes(prefix.replace(/\/$/, '')),
    );
    expect(relisted, 'the Never bullet re-lists protected paths instead of pointing').toEqual([]);
  });

  // RP-102, and it is RP-98's defect one document downstream. `autonomy.md`
  // STATES the rule; the `loop` skill is where a run WRITES the allow-list, at
  // claim time, with `--allow <prefix>`. A gloss that is short of the protected
  // set therefore misleads at the point of use rather than at the point of
  // statement. `.claude/doctor-exemptions.json` had no covering noun in the
  // replaced gloss at all; several others — the settings file, `CLAUDE.md`,
  // `.codex/` — were reachable only by reading a category generously ("hook
  // wiring" may just as well be taken as the hooks directory alone). Which of
  // those a given reader would have got right is not measurable, and is not
  // claimed here.
  //
  // Three exclusions below, each named rather than pattern-matched, because a
  // rule shaped to the text it checks is a rule that stops checking:
  //
  //  - `.claude/scripts/` — naming the directory that HOLDS the source is how
  //    you point at it, exactly as in the `autonomy.md` check above.
  //  - `.claude/queue.board` — refused EVEN WHEN an item's allow-list names it
  //    (`guard-rulebook.mjs` tests that path before consulting the allow-list).
  //    That does not follow from membership in RULEBOOK_PREFIXES — its sibling
  //    `.claude/queue.json` is allow-listable — so a run composing an allow-list
  //    has to be told, and telling it means naming the path.
  //  - the one citation the block makes, `.claude/rules/autonomy.md`, is cut
  //    from the text before matching. 🔴 It is cut by NAME. An earlier draft
  //    excluded any prefix followed by a filename, which read as the same rule
  //    and was not: `code-reviewer` measured that it let all six
  //    directory-shaped entries through whenever a file was named under them —
  //    "the hooks in `.claude/hooks/x.mjs`, the rules in …" is how a re-listing
  //    actually gets written, and it was green. Cutting one known citation
  //    keeps the assertion narrow, and a new citation OUTSIDE the two prefixes
  //    above goes red — which is intended: a document that names a protected
  //    path should say why.
  //
  // ⚠ Three things this does NOT catch. Each was run through the assertion
  // below rather than reasoned about, and none of them is theoretical:
  //
  //  1. A DESCRIPTIVE paraphrase — the same blind spot the `autonomy.md` check
  //     documents, and the one that matters here. On the stale text this
  //     replaced the assertion was GREEN: outside its citation of
  //     `autonomy.md` that block named no protected prefix at all. The POINTER
  //     assertion is what was red. So this check did not catch the defect it
  //     was written for, and says so rather than implying it did.
  //  2. A list somewhere ELSE. This reads one blank-line-delimited paragraph,
  //     so the full enumeration placed in the paragraph immediately after the
  //     block, with the block untouched, is GREEN.
  //  3. `.claude/rules/` re-listed in the exact spelling of the cut citation.
  //     That is the price of cutting by name, it costs one prefix in one
  //     spelling, and it is textually indistinguishable from the citation.
  it('points the loop skill at RULEBOOK_PREFIXES rather than glossing the protected set', async () => {
    const { RULEBOOK_PREFIXES } = (await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    )) as { RULEBOOK_PREFIXES: readonly string[] };

    const skill = await readFile(
      path.join(universal, '.claude', 'skills', 'loop', 'SKILL.md'),
      'utf8',
    );
    const blocks = skill.split(/\n\s*\n/).filter((block) => /is refused unless/.test(block));
    expect(blocks, 'no block in the loop skill describes what the guard refuses').toHaveLength(1);
    const block = blocks[0]!;

    expect(block, 'the block must name the authoritative export').toContain('RULEBOOK_PREFIXES');

    const expanded = block.replace(/([\w./-]*)\{([^}]*)\}/g, (_m, prefix: string, inner: string) =>
      inner
        .split(',')
        .map((part) => prefix + part.trim())
        .join(' '),
    );
    // The block's one citation, removed by name before matching — see the
    // comment above for why this is not a "prefix followed by a filename" rule.
    const withoutCitations = expanded.split('.claude/rules/autonomy.md').join('');
    const relisted = RULEBOOK_PREFIXES.filter(
      (prefix) =>
        prefix !== '.claude/scripts/' &&
        prefix !== '.claude/queue.board' &&
        withoutCitations.includes(prefix.replace(/\/$/, '')),
    );
    expect(relisted, 'the loop skill re-lists protected paths instead of pointing').toEqual([]);
  });

  it('the loop skill arms the flag in §1 and disarms it in §7', async () => {
    const skill = await readFile(
      path.join(universal, '.claude', 'skills', 'loop', 'SKILL.md'),
      'utf8',
    );
    const section = (n: number) =>
      skill.split(new RegExp(`^## ${n}\\. `, 'm'))[1]?.split(/^## \d+\. /m)[0] ?? '';
    expect(section(1)).toContain('unattended-flag.mjs on');
    expect(section(7)).toContain('unattended-flag.mjs off');
  });
});
