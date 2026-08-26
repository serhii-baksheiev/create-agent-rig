import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      { env: { ...process.env, ...env } },
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
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(
    path.join(home, '.claude', FLAG_NAME),
    raw ?? JSON.stringify({ item: 'AR-51', runDir: path.join(root, '.rig-run'), allow }),
  );
};
const run = (payload: object | string) => runHookFull(payload, env());

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ar51-home-'));
  root = await mkdtemp(path.join(tmpdir(), 'ar51-root-'));
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

  it('compares paths as text: a root spelled differently from the file path is not judged (documented, fails open)', async () => {
    await armed([]);
    const result = await runHookFull(write(`/private${root}/.claude/hooks/guard-bash.mjs`), {
      HOME: home,
      CLAUDE_PROJECT_DIR: root,
    });
    expect(result.code, result.stderr).toBe(0);
    const header = (await readFile(path.join(hooksDir, 'guard-rulebook.mjs'), 'utf8'))
      .split('\n')
      .slice(0, 70)
      .join('\n');
    expect(header).toMatch(/symlink|spelled/i);
    expect(header).toMatch(/CLAUDE_PROJECT_DIR/);
  });

  it('a flag whose allow-list reaches outside the rulebook is unreadable, so `--allow .` cannot disarm it', async () => {
    await armed(['.']);
    const result = await run(write(`${root}/.claude/hooks/guard-bash.mjs`));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unreadable/);
    expect(result.stderr).toMatch(/allow/);
  });
});

describe('guard-rulebook: attended sessions are untouched', () => {
  it('allows a hook edit when no unattended flag exists', async () => {
    const result = await run(write(`${root}/.claude/hooks/guard-bash.mjs`));
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('guard-rulebook: an unattended run edits the rulebook only where its item allows', () => {
  it('blocks a hook-config edit with an empty allow-list, naming path, item and the rule', async () => {
    await armed([]);
    const result = await run(write(`${root}/.claude/hooks/dod-checks.json`));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('.claude/hooks/dod-checks.json');
    expect(result.stderr).toContain('AR-51');
    expect(result.stderr).toMatch(/unattended/i);
    expect(result.stderr).toMatch(/allow/i);
  });

  it('allows an edit under an allowed prefix', async () => {
    await armed(['.claude/scripts/queue/']);
    const result = await run(edit(`${root}/.claude/scripts/queue/core.mjs`));
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

  it('blocks a Codex apply_patch that updates settings.json', async () => {
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
    const result = await run(write(`${root}/.claude/rules/x.md`));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unreadable/i);
    expect(result.stderr).toContain(path.join(home, '.claude', FLAG_NAME));
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
