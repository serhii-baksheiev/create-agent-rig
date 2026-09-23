import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { needsGitRoot, onlyOnWindows, skipUnless } from '../helpers/env.js';
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
 * Windows filesystem underneath. This is a pure string-comparison defect in
 * the guard itself, not a filesystem one, so — unlike the Win32-only block
 * above it, which has to reach a real file to prove the bypass — every input
 * here is a plain string with no filesystem dependency and this block runs on
 * every platform, including Linux.
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
    ['a plain (non-verbatim) UNC admin share', String.raw`\\srv\share\x\.claude\settings.json`],
    ['a verbatim UNC admin share', String.raw`\\?\UNC\srv\share\x\.claude\settings.json`],
    [
      'a verbatim device path with no drive letter (a volume GUID path)',
      String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\x\.claude\settings.json`,
    ],
  ];

  it.each(unjudgeablePaths)(
    'blocks a Write to %s while armed, because it cannot be resolved against the repository root',
    async (_label, filePath) => {
      await armed(['src/']);
      const result = await run(write(filePath));
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/resolved against the repository root/i);
    },
  );

  it.each(unjudgeablePaths)(
    'an attended session (no unattended flag) still allows a Write to %s',
    async (_label, filePath) => {
      const result = await run(write(filePath));
      expect(result.code, result.stderr).toBe(0);
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
    ['a plain (non-verbatim) UNC admin share', String.raw`\\srv\share\x\.claude\settings.json`],
    ['a verbatim UNC admin share', String.raw`\\?\UNC\srv\share\x\.claude\settings.json`],
    [
      'a verbatim device path with no drive letter (a volume GUID path)',
      String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\x\.claude\settings.json`,
    ],
  ];

  it.each(unjudgeablePaths)(
    'blocks a MultiEdit beyond the fragment cap to %s while armed',
    async (_label, filePath) => {
      await armed(['src/']);
      const result = await run(multiEdit257(filePath));
      expect(result.code, result.stderr).toBe(2);
    },
  );

  it.each(unjudgeablePaths)(
    'an attended session (no unattended flag) still allows a MultiEdit beyond the fragment cap to %s',
    async (_label, filePath) => {
      const result = await run(multiEdit257(filePath));
      expect(result.code, result.stderr).toBe(0);
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
 * So a UNC-spelled root that does not exist on this filesystem still drives
 * the guard through a pure string comparison, and this needs no real UNC
 * filesystem to be meaningful: it runs on every platform, including Linux.
 * Hand-written literal expectations only, per this project's independent-
 * oracle invariant.
 */
describe('guard-rulebook: a `//`-prefixed path is refused only when it resolves under no repository root (RP-244 round 3)', () => {
  const uncRoot = String.raw`\\server\share\repo`;
  const uncEnv = () => ({ HOME: home, CLAUDE_PROJECT_DIR: uncRoot });
  const armedUnc = async (allow: string[]) => {
    const { unattendedFlags } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const flag = unattendedFlags(uncEnv())[0];
    await mkdir(path.dirname(flag), { recursive: true });
    await writeFile(
      flag,
      JSON.stringify({ item: 'RP-244', runDir: path.join(uncRoot, '.rig-run'), allow }),
    );
  };
  const runUnc = (payload: object) => runHookFull(payload, uncEnv());

  it('allows a Write under the UNC repository root when the target is outside the rulebook', async () => {
    await armedUnc(['src/']);
    const result = await runUnc(write(String.raw`\\server\share\repo\src\x.ts`));
    expect(result.code, result.stderr).toBe(0);
  });

  it('blocks a Write under the UNC repository root to a rulebook path, with the ordinary rulebook reason', async () => {
    await armedUnc(['src/']);
    const result = await runUnc(write(String.raw`\\server\share\repo\.claude\settings.json`));
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/is part of the rulebook/i);
    expect(result.stderr).not.toMatch(/resolved against the repository root/i);
  });

  it('blocks a Write to a `//`-prefixed path outside the UNC repository root, with the "could not be resolved" reason', async () => {
    await armedUnc(['src/']);
    const result = await runUnc(write(String.raw`\\srv\share\x\.claude\settings.json`));
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/resolved against the repository root/i);
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
