import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fifosAvailable, modeBitsDeny, skipUnless } from '../helpers/env.js';

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

interface BoundedResult extends CliResult {
  timedOut: boolean;
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

const readInChild = (home: string, timeout = 750): Promise<BoundedResult> =>
  new Promise((resolve) => {
    const program = [
      `const { readUnattended } = await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`,
      'process.stdout.write(JSON.stringify(readUnattended(process.env)));',
    ].join('\n');
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {
        env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: '' },
        timeout,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
          timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
        });
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
const scopedFlagName = /^__PROJECT_NAME__-[0-9a-f]{16}-loop-UNATTENDED$/;
const realScopedFlags = async () => {
  const flags: string[] = [];
  for (const realHome of realHomes) {
    const configDir = path.join(realHome, '.claude');
    try {
      const entries = await readdir(configDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && scopedFlagName.test(entry.name)) {
          flags.push(path.join(configDir, entry.name));
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
  }
  return [...new Set(flags)];
};
beforeAll(() => {
  for (const home of realHomes) {
    expect(
      existsSync(path.join(home, '.claude', FLAG_NAME)),
      `the REAL home ${home} carries an unattended flag — remove it before running these tests`,
    ).toBe(false);
  }
});

let home: string;
let realScopedBaseline = new Set<string>();
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
  realScopedBaseline = new Set(await realScopedFlags());
});
afterEach(async () => {
  let created: string[];
  try {
    created = (await realScopedFlags()).filter((flag) => !realScopedBaseline.has(flag));
    await Promise.all(created.map((flag) => rm(flag, { force: true })));
  } finally {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
  expect(
    created,
    'a test left new literal __PROJECT_NAME__ checkout-scoped flags in a real password home; cleanup ran before this assertion',
  ).toEqual([]);
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

  it('fails closed when mirrored checkout-scoped candidates disagree', async (context) => {
    const checkout = path.join(home, 'mirrored-checkout');
    await mkdir(checkout, { recursive: true });
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    const { unattendedFlags, readUnattended } = await load();
    const candidates = [...new Set(unattendedFlags(scopedEnv))];
    if (candidates.length < 2) {
      context.skip();
      return;
    }

    try {
      await Promise.all(
        candidates.map((candidate) => mkdir(path.dirname(candidate), { recursive: true })),
      );
      await writeFile(
        candidates[0]!,
        JSON.stringify({ item: 'AR-FIRST', runDir: '/runs/first', allow: ['src/first/'] }),
      );
      await writeFile(
        candidates[1]!,
        JSON.stringify({ item: 'AR-SECOND', runDir: '/runs/second', allow: ['src/second/'] }),
      );

      expect(readUnattended(scopedEnv)).toMatchObject({ on: true, unreadable: true });
    } finally {
      await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
    }
  });

  it('is off when no candidate exists', async () => {
    const { readUnattended } = await load();
    expect(readUnattended(env())).toEqual({ on: false });
  });

  it('is on-but-unreadable when access to an existing flag fails at the stat boundary', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const configDir = path.dirname(flagPath());
    await arm(JSON.stringify({ item: 'AR-EACCES', runDir: '/runs/eacces', allow: [] }));

    try {
      await chmod(configDir, 0o000);
      const { readUnattended } = await load();
      expect(readUnattended(env())).toMatchObject({ on: true, unreadable: true });
    } finally {
      await chmod(configDir, 0o700);
      await rm(flagPath(), { force: true });
    }
  });

  it('returns promptly and fails closed when a candidate is a FIFO', async (ctx) => {
    skipUnless(ctx, fifosAvailable().ok, fifosAvailable().reason);
    await mkdir(path.dirname(flagPath()), { recursive: true });
    execFileSync('mkfifo', [flagPath()]);

    try {
      const result = await readInChild(home);
      expect(result.timedOut, 'readUnattended blocked on a FIFO until the child was killed').toBe(
        false,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ on: true, unreadable: true });
    } finally {
      await rm(flagPath(), { force: true });
    }
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

  it('never accepts a legacy machine-wide allow-list as scoped authorization', async () => {
    await arm(JSON.stringify({ item: 'OLD-A', runDir: '/runs/old-a', allow: ['.claude/'] }));
    const checkout = path.join(home, 'scoped-checkout');
    await mkdir(checkout, { recursive: true });
    const { readUnattended } = await load();
    const mode = readUnattended({
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: checkout,
    });
    expect(mode).toMatchObject({ on: true, unreadable: true });
    expect(mode.why).toMatch(/legacy|migrat/i);
    expect(mode.allow).toBeUndefined();
  });
});

describe('writeUnattended / clearUnattended: the file the run arms and disarms', () => {
  const env = () => ({ ...process.env, HOME: home });

  it('keeps concurrent worktrees separate and clears only the current checkout record', async () => {
    const { writeUnattended, clearUnattended, readUnattended, unattendedFlags } = await load();
    const checkoutA = path.join(home, 'checkout-a');
    const checkoutB = path.join(home, 'checkout-b');
    await mkdir(checkoutA, { recursive: true });
    await mkdir(checkoutB, { recursive: true });
    const envA = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutA };
    const envB = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutB };

    try {
      writeUnattended({ item: 'AR-A', runDir: '/runs/a', allow: [] }, envA);
      writeUnattended({ item: 'AR-B', runDir: '/runs/b', allow: [] }, envB);

      expect(readUnattended(envA)).toMatchObject({ on: true, item: 'AR-A', runDir: '/runs/a' });
      expect(readUnattended(envB)).toMatchObject({ on: true, item: 'AR-B', runDir: '/runs/b' });

      clearUnattended(envA);
      expect(readUnattended(envA)).toEqual({ on: false });
      expect(readUnattended(envB)).toMatchObject({ on: true, item: 'AR-B', runDir: '/runs/b' });
    } finally {
      const candidates = [...new Set([...unattendedFlags(envA), ...unattendedFlags(envB)])];
      await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
    }
  });

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

  it('throws instead of reporting success when access prevents removing an existing flag', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const configDir = path.dirname(flagPath());
    await arm(JSON.stringify({ item: 'AR-EACCES', runDir: '/runs/eacces', allow: [] }));

    try {
      await chmod(configDir, 0o000);
      try {
        const { clearUnattended } = await load();
        expect(() => clearUnattended(env())).toThrow(/failed|remove|EACCES/i);
      } finally {
        await chmod(configDir, 0o700);
      }
      expect(existsSync(flagPath()), 'the inaccessible flag must survive the failed cleanup').toBe(
        true,
      );
    } finally {
      await chmod(configDir, 0o700).catch(() => {});
      await rm(flagPath(), { force: true });
    }
  });

  it('safely clears a legacy flag only when its run directory belongs to this checkout', async () => {
    const { clearUnattended, readUnattended } = await load();
    const checkout = path.join(home, 'legacy-owner');
    const runDir = path.join(checkout, '.claude', 'runs', 'old');
    await mkdir(runDir, { recursive: true });
    await arm(JSON.stringify({ item: 'OLD-A', runDir, allow: [] }));
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };

    expect(clearUnattended(scopedEnv)).toEqual([flagPath()]);
    expect(readUnattended(scopedEnv)).toEqual({ on: false });
  });
});

describe('the CLI the loop skill calls', () => {
  it('exits nonzero when off --root leaves a checkout-scoped candidate behind', async () => {
    const checkout = path.join(home, 'unremovable-checkout');
    await mkdir(checkout, { recursive: true });
    const scopedEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    const { unattendedFlags } = await load();
    const candidate = unattendedFlags(scopedEnv)[0]!;
    await mkdir(candidate, { recursive: true });

    try {
      const result = await runCli(['off', '--root', checkout], home);
      expect(existsSync(candidate)).toBe(true);
      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(/remove|remain|failed/i);
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  });

  it('removes only the explicitly selected legacy record and leaves another home untouched', async () => {
    const selectedHome = await mkdtemp(path.join(tmpdir(), 'ar51-selected-home-'));
    try {
      const selected = path.join(selectedHome, '.claude', FLAG_NAME);
      await mkdir(path.dirname(selected), { recursive: true });
      await writeFile(
        selected,
        JSON.stringify({ item: 'OLD-SELECTED', runDir: '/runs/a', allow: [] }),
      );
      await arm(JSON.stringify({ item: 'OLD-UNRELATED', runDir: '/runs/b', allow: [] }));

      const legacy = await runCli(['off', '--legacy', '--path', selected], home);
      expect(legacy.code, legacy.stderr).toBe(0);
      expect(existsSync(selected)).toBe(false);
      expect(existsSync(flagPath())).toBe(true);
    } finally {
      await rm(selectedHome, { recursive: true, force: true });
    }
  });

  it('scopes on/off to --root so concurrent checkout CLIs do not share a flag', async () => {
    const { readUnattended, unattendedFlags } = await load();
    const checkoutA = path.join(home, 'cli-checkout-a');
    const checkoutB = path.join(home, 'cli-checkout-b');
    await mkdir(checkoutA, { recursive: true });
    await mkdir(checkoutB, { recursive: true });

    const envA = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutA };
    const envB = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutB };
    try {
      expect((await runCli(['on', '--root', checkoutA, '--item', 'AR-A'], home)).code).toBe(0);
      expect((await runCli(['on', '--root', checkoutB, '--item', 'AR-B'], home)).code).toBe(0);
      expect(readUnattended(envA)).toMatchObject({ item: 'AR-A' });
      expect(readUnattended(envB)).toMatchObject({ item: 'AR-B' });

      expect((await runCli(['off', '--root', checkoutA], home)).code).toBe(0);
      expect(readUnattended(envA)).toEqual({ on: false });
      expect(readUnattended(envB)).toMatchObject({ item: 'AR-B' });
    } finally {
      const candidates = [...new Set([...unattendedFlags(envA), ...unattendedFlags(envB)])];
      await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
    }
  });

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
  it('explains exact protected-prefix refusal separately from proper-prefix widening', async () => {
    const source = await readFile(scriptPath, 'utf8');
    const explanation =
      source.match(/\/\*\*\n \* Does this allow entry widen[\s\S]*?\*\//)?.[0] ?? '';
    expect(explanation).toMatch(/exact[\s-]+(?:protected[\s-]+)?prefix/i);
    expect(explanation).toMatch(/proper[\s-]+prefix/i);
    expect(explanation).toMatch(/(?:all|every)[\s\S]*\.claude\/scripts\//i);
    expect(explanation).not.toMatch(/\.claude\/scripts\/queue\/[\s\S]*exactly a rulebook prefix/i);
  });

  it('layers.json `process` lists unattended-flag.mjs and guard-rulebook.mjs', async () => {
    const layers = JSON.parse(await readFile(path.join(universal, 'layers.json'), 'utf8')) as {
      process: string[];
    };
    expect(layers.process).toContain('.claude/scripts/unattended-flag.mjs');
    expect(layers.process).toContain('.claude/hooks/guard-rulebook.mjs');
  });
});
