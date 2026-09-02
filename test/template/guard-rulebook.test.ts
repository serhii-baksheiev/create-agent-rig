import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { needsGitRoot, skipUnless } from '../helpers/env.js';

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
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
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
  ])('blocks the complete rulebook closure at %s', async (rel) => {
    await armed([]);
    const result = await run(write(`${root}/${rel}`));
    expect(result.code, result.stderr).toBe(2);
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
    const familyOf = (prefix: string) => {
      if (prefix.includes('manifest')) return 'manifest';
      return prefix
        .replace(/^\.claude\//, '')
        .replace(/^\./, '')
        .split(/[/.]/)[0]!;
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
  // statement. The entry the replaced gloss covered in neither literal nor
  // descriptive form was `.claude/doctor-exemptions.json`; the settings file it
  // left to be inferred from "hook wiring", which a reader may just as well take
  // as the hooks directory alone.
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
  //    keeps the assertion narrow; a NEW citation goes red and is meant to.
  //
  // ⚠ What this does NOT catch, measured rather than guessed, and it is the
  // same blind spot the `autonomy.md` check documents: a DESCRIPTIVE paraphrase.
  // The stale text this replaced said "rules, skills, agents and hook wiring,
  // plus their scripts, queue config and integrity manifest" and named only
  // three prefixes literally, so the assertion below was GREEN on it. The
  // pointer assertion is what was red — this check did not catch the defect it
  // was written for, and says so rather than implying it did.
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
