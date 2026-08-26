import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * AR-51 — the unattended signal is a FILE, not an env variable.
 *
 * Measured: a shell `export` never reaches a PreToolUse hook — hooks get the
 * harness's environment only. So the mode a `loop` run declares has to live
 * where the kill switch lives: `~/.claude/__PROJECT_NAME__-loop-UNATTENDED`,
 * under both homes `stop-flag.mjs` checks. The token stays literal in the
 * template; every test below points `HOME` at a temp dir.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptPath = path.join(universal, '.claude', 'scripts', 'unattended-flag.mjs');
const FLAG_NAME = '__PROJECT_NAME__-loop-UNATTENDED';

const load = () =>
  import(pathToFileURL(scriptPath).href) as Promise<{
    unattendedFlags: (env?: NodeJS.ProcessEnv) => string[];
    readUnattended: (env?: NodeJS.ProcessEnv) => {
      on: boolean;
      item?: string;
      runDir?: string;
      allow?: string[];
      unreadable?: boolean;
      why?: string;
    };
    writeUnattended: (
      flag: { item: string; runDir: string; allow: string[] },
      env?: NodeJS.ProcessEnv,
    ) => string[];
    clearUnattended: (env?: NodeJS.ProcessEnv) => string[];
  }>;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = (args: string[], home: string): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { env: { ...process.env, HOME: home } },
      (error, stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });

// 🔴 Precondition, not a cleanup: a flag in EITHER home arms the mode, and the
// real home is one of them. These tests never write there — and if something
// already has, every "flag absent" case below is meaningless.
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
// `homedir()` honours $HOME, and the module reads the flag through it — so the
// test process's own HOME is redirected for the duration of each case.
const originalHome = process.env.HOME;
const flagPath = () => path.join(home, '.claude', FLAG_NAME);
const arm = async (content: string) => {
  await mkdir(path.dirname(flagPath()), { recursive: true });
  await writeFile(flagPath(), content);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ar51-flag-'));
  process.env.HOME = home;
});
afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe('unattendedFlags: the same two-home rule as the kill switch', () => {
  it('names a -loop-UNATTENDED file under .claude in the env-derived home', async () => {
    const { unattendedFlags } = await load();
    const flags = unattendedFlags({ ...process.env, HOME: home });
    expect(flags).toContain(flagPath());
    for (const flag of flags) expect(flag.endsWith(`-loop-${'UNATTENDED'}`)).toBe(true);
  });

  it('also names the password-database home, so $HOME alone cannot hide the flag', async () => {
    const { unattendedFlags } = await load();
    const flags = unattendedFlags({ ...process.env, HOME: home });
    expect(flags).toContain(path.join(userInfo().homedir, '.claude', FLAG_NAME));
  });
});

describe('readUnattended: what the flag file says, or that it cannot be read', () => {
  const env = () => ({ ...process.env, HOME: home });

  it('is off when no candidate exists', async () => {
    const { readUnattended } = await load();
    expect(readUnattended(env())).toEqual({ on: false });
  });

  it('reads item, runDir and allow from a well-formed flag', async () => {
    await arm(
      JSON.stringify({ item: 'AR-51', runDir: '/runs/1', allow: ['.claude/scripts/queue/'] }),
    );
    const { readUnattended } = await load();
    expect(readUnattended(env())).toEqual({
      on: true,
      item: 'AR-51',
      runDir: '/runs/1',
      allow: ['.claude/scripts/queue/'],
    });
  });

  it('an allow entry that widens the rulebook — a prefix of a rulebook prefix such as `.` — makes the flag unreadable', async () => {
    await arm(JSON.stringify({ item: 'AR-51', runDir: '/runs/1', allow: ['.'] }));
    const { readUnattended } = await load();
    const mode = readUnattended(env());
    expect(mode).toMatchObject({ on: true, unreadable: true });
    expect(mode.why).toMatch(/allow/);
    expect(mode.why).toMatch(/rulebook/);
  });

  it('writeUnattended refuses an allow entry that widens the rulebook, keeps one outside it, and the CLI exits 1 on the wide one', async () => {
    const { writeUnattended, readUnattended, clearUnattended } = await load();
    expect(() =>
      writeUnattended({ item: 'AR-51', runDir: '/runs/1', allow: ['.claude/'] }, env()),
    ).toThrow(/rulebook/);
    expect(() =>
      writeUnattended({ item: 'AR-51', runDir: '/runs/1', allow: ['.claude/scripts/'] }, env()),
    ).toThrow(/rulebook/);
    // outside the rulebook is harmless — items name such paths all the time
    writeUnattended(
      { item: 'AR-51', runDir: '/runs/1', allow: ['src/', '.claude/scripts/queue/'] },
      env(),
    );
    expect(readUnattended(env())).toMatchObject({
      on: true,
      allow: ['src/', '.claude/scripts/queue/'],
    });
    clearUnattended(env());
    expect(readUnattended(env())).toEqual({ on: false });
    const result = await runCli(['on', '--item', 'AR-51', '--allow', '.'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/rulebook/);
    expect(readUnattended(env())).toEqual({ on: false });
  });

  it('trims whitespace around allow entries', async () => {
    await arm(
      JSON.stringify({
        item: 'AR-51',
        runDir: '/r',
        allow: ['  .claude/rules/ ', '\tCLAUDE.md\n'],
      }),
    );
    const { readUnattended } = await load();
    expect(readUnattended(env()).allow).toEqual(['.claude/rules/', 'CLAUDE.md']);
  });

  it('is on-but-unreadable when the file is not JSON', async () => {
    await arm('{ not json');
    const { readUnattended } = await load();
    const result = readUnattended(env());
    expect(result.on).toBe(true);
    expect(result.unreadable).toBe(true);
    expect(typeof result.why).toBe('string');
    expect(result.why!.length).toBeGreaterThan(0);
  });

  it('is unreadable when the JSON is not an object', async () => {
    await arm('["AR-51"]');
    const { readUnattended } = await load();
    expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
  });

  it('is unreadable when allow is not an array of strings', async () => {
    const { readUnattended } = await load();
    for (const allow of ['.claude/', [1, 2], [{ p: '.claude/' }], null]) {
      await arm(JSON.stringify({ item: 'AR-51', runDir: '/r', allow }));
      expect(readUnattended(env()), JSON.stringify(allow)).toMatchObject({
        on: true,
        unreadable: true,
      });
    }
  });

  it('is unreadable when allow carries more than 64 entries (bounded work)', async () => {
    const allow = Array.from({ length: 65 }, (_, i) => `.claude/p${i}/`);
    await arm(JSON.stringify({ item: 'AR-51', runDir: '/r', allow }));
    const { readUnattended } = await load();
    expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
  });

  it('is unreadable when the file is larger than 64 KiB (it reads at most that much)', async () => {
    const padding = ' '.repeat(70 * 1024);
    await arm(`{"item":"AR-51","runDir":"/r","allow":[]${padding}}`);
    const { readUnattended } = await load();
    expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
  });
});

describe('writeUnattended / clearUnattended: the file the run arms and disarms', () => {
  const env = () => ({ ...process.env, HOME: home });

  it('writes the first candidate, creating <home>/.claude/, and returns the path', async () => {
    const { writeUnattended, readUnattended } = await load();
    const touched = writeUnattended({ item: 'AR-51', runDir: '/r', allow: ['CLAUDE.md'] }, env());
    expect(touched).toEqual([flagPath()]);
    expect(JSON.parse(await readFile(flagPath(), 'utf8'))).toEqual({
      item: 'AR-51',
      runDir: '/r',
      allow: ['CLAUDE.md'],
    });
    expect(readUnattended(env()).on).toBe(true);
  });

  it('clears every candidate that exists and returns the paths removed', async () => {
    const { writeUnattended, clearUnattended, readUnattended } = await load();
    writeUnattended({ item: 'AR-51', runDir: '/r', allow: [] }, env());
    expect(clearUnattended(env())).toEqual([flagPath()]);
    expect(existsSync(flagPath())).toBe(false);
    expect(readUnattended(env())).toEqual({ on: false });
    // idempotent: nothing left to remove
    expect(clearUnattended(env())).toEqual([]);
  });
});

describe('the CLI the loop skill calls', () => {
  it('`on --item … --run-dir … --allow …` writes the flag and prints its path', async () => {
    const result = await runCli(
      [
        'on',
        '--item',
        'AR-51',
        '--run-dir',
        '/runs/1',
        '--allow',
        '.claude/scripts/queue/',
        '.claude/skills/loop/',
      ],
      home,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(flagPath());
    expect(JSON.parse(await readFile(flagPath(), 'utf8'))).toEqual({
      item: 'AR-51',
      runDir: '/runs/1',
      allow: ['.claude/scripts/queue/', '.claude/skills/loop/'],
    });
  });

  it('`off` removes the flag', async () => {
    await arm(JSON.stringify({ item: 'AR-51', runDir: '/r', allow: [] }));
    const result = await runCli(['off'], home);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(flagPath())).toBe(false);
  });

  it('`on` without --item exits 1 with a message and writes nothing', async () => {
    const result = await runCli(['on', '--run-dir', '/r'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--item/);
    expect(existsSync(flagPath())).toBe(false);
  });

  it('an unknown word exits 1', async () => {
    const result = await runCli(['sideways'], home);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('the process layer declares the new files', () => {
  it('layers.json `process` lists unattended-flag.mjs and guard-rulebook.mjs', async () => {
    const layers = JSON.parse(await readFile(path.join(universal, 'layers.json'), 'utf8')) as {
      process: string[];
    };
    expect(layers.process).toContain('.claude/scripts/unattended-flag.mjs');
    expect(layers.process).toContain('.claude/hooks/guard-rulebook.mjs');
  });
});
