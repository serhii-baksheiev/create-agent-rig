import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InitError,
  initManifest,
  initProject,
  planInit,
  projectNameFor,
} from '../src/commands/init.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('planInit — the dry-run plan (never writes)', () => {
  it('lists only the PROCESS layer, never architecture rules', async () => {
    const plan = await planInit(repo);
    const files = plan.files.map((f) => f.path);
    expect(files).toContain('.claude/rules/workflow.md');
    expect(files).toContain('.claude/rules/autonomy.md');
    // architecture assumes packages/core etc. — must NOT be installed into an
    // arbitrary existing repo
    expect(files).not.toContain('.claude/rules/architecture.md');
    expect(files.some((f) => f.includes('guard-core-purity'))).toBe(false);
    expect(files.some((f) => f.includes('guard-web-boundary'))).toBe(false);
    // process hooks travel fine
    expect(files.some((f) => f.includes('gate-stop-dod'))).toBe(true);
  });

  it('writes nothing', async () => {
    await planInit(repo);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
  });

  it('flags an existing CLAUDE.md as a conflict, not a silent overwrite', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# my rules');
    const plan = await planInit(repo);
    expect(plan.conflicts).toContain('CLAUDE.md');
  });
});

describe('initProject — the install', () => {
  it('installs the process layer into an existing repo', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"existing"}');
    const result = await initProject(repo, {});
    expect(result.written.length).toBeGreaterThan(0);
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toContain(
      'TDD',
    );
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(
      await readFile(path.join(repo, 'CLAUDE.md'), 'utf8'),
    );
    await expect(
      readFile(path.join(repo, '.agents', 'skills', 'pr-ship', 'SKILL.md'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(path.join(repo, '.codex', 'agents', 'code-reviewer.toml'), 'utf8'),
    ).resolves.toBeTruthy();
    // it never brought architecture rules
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'architecture.md')),
    ).rejects.toThrow();
  });

  it('refuses to clobber an existing CLAUDE.md unless forced', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# mine');
    await expect(initProject(repo, {})).rejects.toThrow(InitError);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# mine');
  });

  it('refuses to clobber an existing AGENTS.md', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), '# mine');
    await expect(initProject(repo, {})).rejects.toThrow(InitError);
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe('# mine');
  });

  it('never overwrites a pre-existing process file it did not write', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM');
    const result = await initProject(repo, {});
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toBe(
      'CUSTOM',
    );
    expect(result.skipped).toContain('.claude/rules/workflow.md');
  });

  it('a dry run writes nothing but reports the plan', async () => {
    const result = await initProject(repo, { dryRun: true });
    expect(result.written).toEqual([]);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
    expect(result.plannedCount).toBeGreaterThan(0);
  });
});

// A hook nothing calls is not enforcement. `init` used to lay the hook files
// down and stop there: no settings.json meant guard-bash, block-no-verify,
// gate-stop-dod and inject-rules were never invoked, while CLAUDE.md claimed
// they were.
describe('initProject — the hooks are actually wired', () => {
  it('writes a settings.json naming every process hook it installed', async () => {
    await initProject(repo, {});
    const settings = await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8');
    for (const hook of [
      'block-no-verify.mjs',
      'guard-bash.mjs',
      'gate-stop-dod.mjs',
      'inject-rules.mjs',
    ]) {
      expect(settings, hook).toContain(hook);
    }
    expect(JSON.parse(settings)).toBeTypeOf('object');
  });

  it('names no hook it did not install — a wired-but-absent hook errors on every call', async () => {
    await initProject(repo, {});
    const settings = await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8');
    expect(settings).not.toContain('guard-core-purity');
    expect(settings).not.toContain('guard-web-boundary');
    const codexHooks = await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8');
    expect(codexHooks).toContain('guard-bash');
    expect(codexHooks).not.toContain('guard-core-purity');
  });

  it('keeps a settings.json the repo already had, and reports it as kept', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{"mine":true}');
    const result = await initProject(repo, {});
    expect(await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe(
      '{"mine":true}',
    );
    expect(result.skipped).toContain('.claude/settings.json');
  });

  it('keeps Codex hook wiring the repo already had, and reports it as kept', async () => {
    await mkdir(path.join(repo, '.codex'), { recursive: true });
    await writeFile(path.join(repo, '.codex', 'hooks.json'), '{"mine":true}');
    const result = await initProject(repo, {});
    expect(await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8')).toBe('{"mine":true}');
    expect(result.skipped).toContain('.codex/hooks.json');
  });

  it('lists the wiring in the plan, so a dry run shows it too', async () => {
    const plan = await planInit(repo);
    expect(plan.files.map((f) => f.path)).toContain('.claude/settings.json');
  });
});

// The kill switch is a filename. An unsubstituted token means the operator
// creates `~/.claude/<repo>-loop-STOP` and the brake looks for
// `~/.claude/__PROJECT_NAME__-loop-STOP` — silently, with no error.
describe('initProject — token substitution', () => {
  it('leaves no __PROJECT_NAME__ token in any installed file', async () => {
    const result = await initProject(repo, {});
    for (const rel of result.written) {
      const content = await readFile(path.join(repo, rel), 'utf8');
      expect(content, rel).not.toContain('__PROJECT_NAME__');
    }
  });

  it('points the kill switch at this repo', async () => {
    await initProject(repo, {});
    const stopFlag = await readFile(path.join(repo, '.claude', 'scripts', 'stop-flag.mjs'), 'utf8');
    expect(stopFlag).toContain(`${projectNameFor(repo)}-loop-STOP`);
    expect(projectNameFor(repo)).toMatch(/^caf-init-/); // and that name is the directory's
  });

  it('derives a filename-safe project name from the directory', () => {
    expect(projectNameFor('/tmp/lambda-puppeteer')).toBe('lambda-puppeteer');
    expect(projectNameFor('/tmp/My Repo!')).toBe('my-repo');
    expect(projectNameFor('/')).toBe('project');
  });
});

// The installed CLAUDE.md is the map an agent reads first. Shipping the
// generated monorepo's map into an arbitrary repo describes directories that
// do not exist and links to rules that were deliberately not installed.
describe('initProject — the map describes THIS repo, not the generated shape', () => {
  it('claims no monorepo layout', async () => {
    await initProject(repo, {});
    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    for (const ghost of ['packages/core/', 'packages/db/', 'apps/web/']) {
      expect(claudeMd, ghost).not.toContain(ghost);
    }
  });

  it('links to no rule or hook that init does not install', async () => {
    await initProject(repo, {});
    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).not.toContain('architecture.md');
    expect(claudeMd).not.toContain('guard-core-purity');
    expect(claudeMd).not.toContain('guard-web-boundary');
  });

  it('declares elevated paths that exist here, not in the generated shape', async () => {
    await initProject(repo, {});
    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    const block = /```elevated-paths\n([\s\S]*?)```/.exec(claudeMd);
    expect(block, 'CLAUDE.md must still declare an elevated-paths block').not.toBeNull();
    const paths = (block?.[1] ?? '').trim().split('\n');
    expect(paths).toContain('.claude/');
    expect(paths.some((p) => p.startsWith('packages/'))).toBe(false);
  });

  it('says the DoD stop gate is inert until the repo supplies its checks', async () => {
    await initProject(repo, {});
    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('dod-checks.json');
  });
});

// `--force` never meant what it read as. It replaced `CLAUDE.md` and nothing
// else — every other pre-existing file was kept regardless of the flag — so a
// run that looked like "re-install the rig over this repo" refreshed one
// document and left the rules, the hooks and the wiring at whatever version
// they were. `upgrade` is the command that refreshes a rig, and this release
// says so instead. (Removing the flag is a later release; refusing it is this
// one.)
//
// Refusal is an `InitError`, which is what makes the two halves of the ruling
// the CLI is responsible for true: `index.ts` prints an `InitError`'s message
// as-is and exits 1.
describe('initProject — `--force` is deprecated, not a smaller upgrade', () => {
  const DEPRECATION =
    'deprecated — init --force replaced only CLAUDE.md; run create-agent-rig upgrade instead';

  it('refuses the run before it installs anything', async () => {
    await expect(initProject(repo, { force: true })).rejects.toThrow(InitError);
    expect(await readdir(repo)).toEqual([]);
  });

  it('leaves alone the CLAUDE.md it used to be the only way to replace', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# mine');
    await expect(initProject(repo, { force: true })).rejects.toThrow(InitError);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# mine');
    // nothing else appeared either — not the rules, not the wiring, not the manifest
    expect(await readdir(repo)).toEqual(['CLAUDE.md']);
  });

  it('names the command that does refresh a rig', async () => {
    await expect(initProject(repo, { force: true })).rejects.toThrow(DEPRECATION);
  });
});

describe('initManifest — one list, used by the plan and the install alike', () => {
  it('carries the process layer, the map and the wiring', async () => {
    const rels = (await initManifest()).map((f) => f.rel);
    expect(rels).toContain('.claude/rules/workflow.md');
    expect(rels).toContain('CLAUDE.md');
    expect(rels).toContain('AGENTS.md');
    expect(rels).toContain('.claude/settings.json');
    expect(rels).toContain('.codex/hooks.json');
    expect(rels).not.toContain('.claude/rules/architecture.md');
  });
});
