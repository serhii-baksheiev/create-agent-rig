import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// A queue config can name several boards and switch between them per checkout,
// without editing the composed `queue.json`: the generator's own repo runs on
// one Jira board today and another tomorrow (AR → RP), and every switch was a
// sync-script PR that rewrote a literal. The selector is a runtime file beside
// the config, in the same class as `queue.state.json` — never committed.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const queueDir = path.join(universal, '.claude', 'scripts', 'queue');
const indexModule = () => import(pathToFileURL(path.join(queueDir, 'index.mjs')).href);

const runCli = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  new Promise<{ code: number; stdout: string; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(queueDir, 'index.mjs'), ...args],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          out: stdout + stderr,
        }),
    );
  });

const BOARDS = {
  adapter: 'jira',
  board: 'AR',
  boards: {
    AR: { project: 'AR', owner: 'create-agent-rig' },
    RP: { project: 'RP', owner: 'rig' },
  },
  options: { maxGateRounds: 3 },
};

const fixture = async (config: unknown = BOARDS) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'queue-board-'));
  const configPath = path.join(dir, 'queue.json');
  await writeFile(configPath, JSON.stringify(config));
  return { dir, configPath };
};

describe('boards in queue.json', () => {
  it('resolves the default board into options and keeps the shared keys', async () => {
    const { loadConfig } = await indexModule();
    const { configPath } = await fixture();
    const config = loadConfig(configPath);
    expect(config.board).toBe('AR');
    expect(config.options).toEqual({ maxGateRounds: 3, project: 'AR', owner: 'create-agent-rig' });
  });

  it('the selector file beside the config picks the active board', async () => {
    const { loadConfig, boardPathFor } = await indexModule();
    const { configPath } = await fixture();
    expect(boardPathFor(configPath)).toBe(configPath.replace(/\.json$/, '.board'));
    await writeFile(boardPathFor(configPath), 'RP\n');
    const config = loadConfig(configPath);
    expect(config.board).toBe('RP');
    expect(config.options).toEqual({ maxGateRounds: 3, project: 'RP', owner: 'rig' });
  });

  it('refuses a board nobody declared instead of falling back', async () => {
    const { loadConfig, boardPathFor } = await indexModule();
    const { configPath } = await fixture();
    await writeFile(boardPathFor(configPath), 'XX');
    expect(() => loadConfig(configPath)).toThrow(/XX.*AR, RP/s);
  });

  it('refuses a default board that the map does not carry', async () => {
    const { loadConfig } = await indexModule();
    const { configPath } = await fixture({ ...BOARDS, board: 'ZZ' });
    expect(() => loadConfig(configPath)).toThrow(/ZZ/);
  });

  it('a config without boards is returned as it was', async () => {
    const { loadConfig } = await indexModule();
    const plain = { adapter: 'jira', options: { project: 'AR' } };
    const { configPath } = await fixture(plain);
    expect(loadConfig(configPath)).toEqual(plain);
  });

  it('`board` prints the active board and the declared ones; `board <name>` writes the selector', async () => {
    const { boardPathFor } = await indexModule();
    const { dir, configPath } = await fixture();
    const before = await runCli(['board', '--config', configPath], dir);
    expect(before.code, before.out).toBe(0);
    expect(before.stdout).toMatch(/AR/);
    expect(before.stdout).toMatch(/RP/);

    const switched = await runCli(['board', 'RP', '--config', configPath], dir);
    expect(switched.code, switched.out).toBe(0);
    expect((await readFile(boardPathFor(configPath), 'utf8')).trim()).toBe('RP');

    const after = await runCli(['board', '--json', '--config', configPath], dir);
    expect(JSON.parse(after.stdout)).toEqual({
      board: 'RP',
      boards: ['AR', 'RP'],
      options: { maxGateRounds: 3, project: 'RP', owner: 'rig' },
    });
  });

  it('keeps the board report available but refuses a switch while this checkout is unattended', async () => {
    const { boardPathFor } = await indexModule();
    const { writeUnattended, clearUnattended } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const { dir, configPath } = await fixture();
    const home = await mkdtemp(path.join(tmpdir(), 'queue-board-home-'));
    const env = { HOME: home, CLAUDE_PROJECT_DIR: dir };
    writeUnattended({ item: 'AR-BOARD', runDir: '/runs/board', allow: [] }, env);

    const report = await runCli(['board', '--json', '--config', configPath], dir, env);
    expect(report.code, report.out).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ board: 'AR', boards: ['AR', 'RP'] });

    const switched = await runCli(['board', 'RP', '--config', configPath], dir, env);
    expect(switched.code, switched.out).not.toBe(0);
    expect(switched.out).toMatch(/unattended/i);
    await expect(readFile(boardPathFor(configPath), 'utf8')).rejects.toThrow();

    clearUnattended(env);
  });

  it('finds the checkout-scoped flag from cwd when CLAUDE_PROJECT_DIR is absent', async () => {
    const { writeUnattended, clearUnattended } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const { dir, configPath } = await fixture();
    const home = await mkdtemp(path.join(tmpdir(), 'queue-board-cwd-home-'));
    const scopedEnv = { HOME: home, CLAUDE_PROJECT_DIR: dir };
    writeUnattended({ item: 'AR-BOARD-CWD', runDir: '/runs/board', allow: [] }, scopedEnv);

    const switched = await runCli(['board', 'RP', '--config', configPath], dir, {
      HOME: home,
      CLAUDE_PROJECT_DIR: '',
    });
    expect(switched.code, switched.out).not.toBe(0);
    expect(switched.out).toMatch(/unattended/i);

    clearUnattended(scopedEnv);
  });

  it('refuses a cross-cwd switch when the checkout targeted by --config is unattended', async () => {
    const { writeUnattended, clearUnattended } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const caller = await mkdtemp(path.join(tmpdir(), 'queue-board-caller-'));
    const target = await mkdtemp(path.join(tmpdir(), 'queue-board-target-'));
    const targetConfigDir = path.join(target, '.claude');
    const configPath = path.join(targetConfigDir, 'queue.json');
    const home = await mkdtemp(path.join(tmpdir(), 'queue-board-cross-home-'));
    await mkdir(targetConfigDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(BOARDS));
    const targetEnv = { HOME: home, CLAUDE_PROJECT_DIR: target };
    writeUnattended({ item: 'AR-TARGET', runDir: '/runs/target', allow: [] }, targetEnv);

    const switched = await runCli(['board', 'RP', '--config', configPath], caller, {
      HOME: home,
      CLAUDE_PROJECT_DIR: '',
    });
    expect(switched.code, switched.out).not.toBe(0);
    expect(switched.out).toMatch(/unattended/i);

    clearUnattended(targetEnv);
  });

  it('refuses a cross-checkout switch when the calling checkout is unattended', async () => {
    const { writeUnattended, clearUnattended } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const caller = await mkdtemp(path.join(tmpdir(), 'queue-board-caller-'));
    const target = await mkdtemp(path.join(tmpdir(), 'queue-board-target-'));
    const targetConfigDir = path.join(target, '.claude');
    const configPath = path.join(targetConfigDir, 'queue.json');
    const home = await mkdtemp(path.join(tmpdir(), 'queue-board-cross-home-'));
    await mkdir(targetConfigDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(BOARDS));
    const callerEnv = { HOME: home, CLAUDE_PROJECT_DIR: caller };
    writeUnattended({ item: 'AR-CALLER', runDir: '/runs/caller', allow: [] }, callerEnv);

    const switched = await runCli(['board', 'RP', '--config', configPath], caller, {
      HOME: home,
      CLAUDE_PROJECT_DIR: caller,
    });
    expect(switched.code, switched.out).not.toBe(0);
    expect(switched.out).toMatch(/unattended/i);

    clearUnattended(callerEnv);
  });

  it('`board <name>` refuses an undeclared board and writes nothing', async () => {
    const { boardPathFor } = await indexModule();
    const { dir, configPath } = await fixture();
    const result = await runCli(['board', 'XX', '--config', configPath], dir);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/XX/);
    await expect(readFile(boardPathFor(configPath), 'utf8')).rejects.toThrow();
  });

  it('`board` on a config without boards says so rather than writing a selector', async () => {
    const { dir, configPath } = await fixture({ adapter: 'plan-md' });
    const result = await runCli(['board', 'RP', '--config', configPath], dir);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/no boards/i);
  });
});

describe('the generator dogfoods the switch', () => {
  it('this repo declares AR and RP, and the selector path is ignored everywhere a state file is', async () => {
    const own = JSON.parse(await readFile(path.join(repoRoot, '.claude', 'queue.json'), 'utf8'));
    expect(Object.keys(own.boards)).toEqual(['AR', 'RP']);
    expect(own.boards.RP).toEqual({ project: 'RP', owner: 'rig' });
    expect(own.options.project).toBeUndefined();
    for (const file of [
      path.join(repoRoot, '.gitignore'),
      path.join(repoRoot, 'templates', 'skeleton', 'node-service', 'gitignore'),
      path.join(repoRoot, 'templates', 'skeleton', 'aws-serverless', 'gitignore'),
      path.join(repoRoot, 'templates', 'agent-os', 'init', 'CLAUDE.md'),
    ]) {
      expect(await readFile(file, 'utf8'), file).toContain('.claude/queue.board');
    }
  });
});

describe('the selector is guarded like the config it picks from', () => {
  it('guard-rulebook lists .claude/queue.board beside .claude/queue.json', async () => {
    const { RULEBOOK_PREFIXES } = await import(
      pathToFileURL(path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    expect(RULEBOOK_PREFIXES).toContain('.claude/queue.json');
    expect(RULEBOOK_PREFIXES).toContain('.claude/queue.board');
  });

  it('`board <name>` refuses a "boards" that is not an object before writing anything', async () => {
    const { boardPathFor } = await indexModule();
    const { dir, configPath } = await fixture({ adapter: 'jira', boards: 'AR' });
    const result = await runCli(['board', '0', '--config', configPath], dir);
    expect(result.code).not.toBe(0);
    await expect(readFile(boardPathFor(configPath), 'utf8')).rejects.toThrow();
  });
});

describe('an empty selector is a refusal, not an absence', () => {
  it('refuses rather than falling back to the default board', async () => {
    const { loadConfig, boardPathFor } = await indexModule();
    const { configPath } = await fixture();
    await writeFile(boardPathFor(configPath), '\n');
    expect(() => loadConfig(configPath)).toThrow(/queue-board.*\.board.*AR, RP/s);
  });
});
