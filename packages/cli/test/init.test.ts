import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
import { readManifest, sha256 } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-'));
});

afterEach(async () => {
  await removeFixture(repo);
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
    // RP-186: AGENTS.md is the canonical rulebook, CLAUDE.md a short shim
    // that imports it — they are no longer byte-identical.
    const agentsMdInstalled = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const claudeMdInstalled = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(agentsMdInstalled).toContain('## One operating system, two harnesses');
    expect(claudeMdInstalled.trimStart().startsWith('@AGENTS.md')).toBe(true);
    expect(claudeMdInstalled).not.toContain('## One operating system, two harnesses');
    await expect(
      readFile(path.join(repo, '.agents', 'skills', 'check-premises', 'SKILL.md'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(path.join(repo, '.codex', 'agents', 'code-reviewer.toml'), 'utf8'),
    ).resolves.toBeTruthy();
    // it never brought architecture rules
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'architecture.md')),
    ).rejects.toThrow();
    // and, by default, never the opt-in workflow layer (RP-180) — see
    // "the workflow layer is opt-in (RP-180)" below for the dedicated coverage
    await expect(
      readFile(path.join(repo, '.agents', 'skills', 'pr-ship', 'SKILL.md')),
    ).rejects.toThrow();
  });

  it('refuses to clobber an existing CLAUDE.md unless forced', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# mine');
    await expect(initProject(repo, {})).rejects.toThrow(InitError);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# mine');
  });

  // PR #241 round 3 advisory: "already has an CLAUDE.md" is a grammar defect
  // ("an" before a consonant), pinned here as its own assertion so a later
  // rewrite of this message cannot silently reintroduce it.
  it('says "a CLAUDE.md", not "an CLAUDE.md"', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# mine');
    await expect(initProject(repo, {})).rejects.toThrow('already has a CLAUDE.md');
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
  // RP-186: AGENTS.md carries the rulebook text these assertions are about;
  // CLAUDE.md is a short shim and never contains any of it.
  it('claims no monorepo layout', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    for (const ghost of ['packages/core/', 'packages/db/', 'apps/web/']) {
      expect(agentsMd, ghost).not.toContain(ghost);
    }
  });

  it('links to no rule or hook that init does not install', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agentsMd).not.toContain('architecture.md');
    expect(agentsMd).not.toContain('guard-core-purity');
    expect(agentsMd).not.toContain('guard-web-boundary');
  });

  it('declares elevated paths that exist here, not in the generated shape', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const block = /```elevated-paths\n([\s\S]*?)```/.exec(agentsMd);
    expect(block, 'AGENTS.md must still declare an elevated-paths block').not.toBeNull();
    const paths = (block?.[1] ?? '').trim().split('\n');
    expect(paths).toContain('.claude/');
    expect(paths.some((p) => p.startsWith('packages/'))).toBe(false);

    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd, 'the shim must not carry its own elevated-paths block').not.toContain(
      '```elevated-paths',
    );
  });

  it('says the DoD stop gate is inert until the repo supplies its checks', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('dod-checks.json');
  });

  it('does not claim runtime ignore entries remain after the project has added them', async () => {
    await writeFile(
      path.join(repo, '.gitignore'),
      [
        '.claude/queue.state.json',
        '.claude/queue.board',
        '.claude/gate-rounds.json',
        '.claude/worktrees/',
        '.claude/runs/',
        '',
      ].join('\n'),
    );
    await initProject(repo, {});

    // RP-186: only AGENTS.md (canonical) carries this section now; the
    // CLAUDE.md shim imports it rather than repeating it.
    const content = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const finishList = content.split('## Four things this install left for you to finish')[1] ?? '';
    const ignoreSection = /\n3\. \*\*[\s\S]*?(?=\n4\. \*\*)/.exec(finishList)?.[0] ?? '';
    expect(ignoreSection, 'AGENTS.md must still explain the runtime ignore entries').toBeTruthy();
    expect(ignoreSection).toMatch(/if[^\n]{0,100}missing|add only[^\n]{0,80}missing/i);
    expect(ignoreSection).not.toMatch(/Add all five/i);

    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).not.toContain('## Four things this install left for you to finish');
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

// RP-180: the workflow layer (queue/loop/pr-ship/run-state/journal/
// revalidation/claim-records/PR-lifecycle helpers) is an experimental
// opt-in, never part of the default install.
describe('the workflow layer is opt-in (RP-180)', () => {
  it('a default init installs no workflow-layer file', async () => {
    const result = await initProject(repo, {});
    const workflowPaths = [
      '.claude/queue.json',
      '.claude/skills/loop/SKILL.md',
      '.claude/skills/pr-ship/SKILL.md',
      '.claude/scripts/queue/index.mjs',
      '.claude/scripts/decision-router.mjs',
      '.claude/scripts/lib/claim-records.mjs',
      '.rig/revalidation.json',
    ];
    for (const rel of workflowPaths) {
      expect(result.written, rel).not.toContain(rel);
      await expect(readFile(path.join(repo, ...rel.split('/')))).rejects.toThrow();
    }
    const manifest = await readManifest(repo);
    expect(manifest?.layers).toEqual(['process']);
  });

  it('`{ withWorkflow: true }` installs the workflow layer and records both layers', async () => {
    const result = await initProject(repo, { withWorkflow: true });
    expect(result.written).toContain('.claude/queue.json');
    expect(result.written).toContain('.claude/skills/loop/SKILL.md');
    expect(await readFile(path.join(repo, '.claude', 'queue.json'), 'utf8')).toContain('adapter');

    const manifest = await readManifest(repo);
    expect(manifest?.layers).toEqual(['process', 'workflow']);
  });

  it('planInit without the flag lists no workflow-layer file; with it, it does', async () => {
    const core = await planInit(repo);
    expect(core.files.map((f) => f.path)).not.toContain('.claude/queue.json');

    const withWorkflow = await planInit(repo, { withWorkflow: true });
    expect(withWorkflow.files.map((f) => f.path)).toContain('.claude/queue.json');
    expect(withWorkflow.files.map((f) => f.path)).toContain('.claude/skills/loop/SKILL.md');
  });

  it('re-running plain init on a rig that already opted in keeps the workflow layer installed', async () => {
    await initProject(repo, { withWorkflow: true });
    const result = await initProject(repo, {});
    // nothing new to write on a no-op re-run, and the layer stays recorded
    expect(result.written).toEqual([]);
    const manifest = await readManifest(repo);
    expect(manifest?.layers).toEqual(['process', 'workflow']);
  });
});

// RP-182: a pre-existing file `init` keeps used to fall out of the manifest
// entirely; it is now classified under `kept`.
describe('initProject — every skipped path gets a manifest classification (RP-182)', () => {
  it('records what it kept, with the sha256 of the bytes actually on disk — never in `files`', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM');

    const result = await initProject(repo, {});
    expect(result.skipped).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBe(sha256('CUSTOM'));
    // never claimed as Rig-written bytes
    expect(manifest?.files['.claude/rules/workflow.md']).toBeUndefined();
    // and a path it actually wrote never shows up as "kept"
    expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    expect(manifest?.files['CLAUDE.md']).toBeTruthy();
  });

  it('records a kept file by its exact raw bytes, even when those bytes are not valid UTF-8', async () => {
    const rel = '.claude/rules/workflow.md';
    const raw = Buffer.from([0xc3, 0x28, 0x0a]);
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, ...rel.split('/')), raw);

    await initProject(repo, {});

    const manifest = await readManifest(repo);
    expect(sha256(raw)).not.toBe(sha256(raw.toString('utf8')));
    expect(manifest?.kept?.[rel]).toBe(sha256(raw));
    expect(manifest?.files[rel]).toBeUndefined();
  });

  it('re-running init refreshes the hash of a path it skips again, and keeps recording it in `kept`', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM V1');
    await initProject(repo, {});

    // lift init's CLAUDE.md refusal, the only thing standing between this and
    // a second run over the same repo (mirrors the fixtures in upgrade.test.ts)
    await rm(path.join(repo, 'CLAUDE.md'));
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM V2');
    const second = await initProject(repo, {});
    expect(second.skipped).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBe(sha256('CUSTOM V2'));
    expect(manifest?.files['.claude/rules/workflow.md']).toBeUndefined();
  });

  it('never moves a path already recorded in `files` into `kept`, even when a later run skips it', async () => {
    await initProject(repo, {});
    const autonomyBefore = await readFile(
      path.join(repo, '.claude', 'rules', 'autonomy.md'),
      'utf8',
    );

    // lift init's CLAUDE.md refusal; leave every other installed file exactly
    // as the first run wrote it, so the second run skips them all
    await rm(path.join(repo, 'CLAUDE.md'));
    const second = await initProject(repo, {});
    expect(second.skipped).toContain('.claude/rules/autonomy.md');

    const manifest = await readManifest(repo);
    // it was written by the rig, twice over — it is not the user's file
    expect(manifest?.kept?.['.claude/rules/autonomy.md']).toBeUndefined();
    expect(manifest?.files['.claude/rules/autonomy.md']).toBe(sha256(autonomyBefore));
  });

  it('drops a path from `kept` once a later run writes it', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM');
    await initProject(repo, {});

    // the user deletes the kept file; the next run finds the path free and writes it
    await rm(path.join(repo, 'CLAUDE.md'));
    await rm(path.join(repo, '.claude', 'rules', 'workflow.md'));
    const second = await initProject(repo, {});
    expect(second.written).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest?.files['.claude/rules/workflow.md']).toBeTruthy();
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBeUndefined();
  });

  it('refuses a symlink at a payload path and does not hash or change its target', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      const target = path.join(outside, 'secret.txt');
      await writeFile(target, 'OUTSIDE THE REPO');
      await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
      try {
        await symlink(target, path.join(repo, '.claude', 'rules', 'workflow.md'), 'file');
      } catch {
        // Windows without the symlink privilege refuses file links.
        context.skip();
        return;
      }

      await expect(initProject(repo, {})).rejects.toThrow(InitError);
      expect(await readFile(target, 'utf8')).toBe('OUTSIDE THE REPO');
      expect(await readManifest(repo)).toBeNull();
    } finally {
      await removeFixture(outside);
    }
  });

  it('completes, and records nothing under `kept`, when a payload path is occupied by a directory', async () => {
    await mkdir(path.join(repo, '.claude', 'rules', 'workflow.md'), { recursive: true });

    const result = await initProject(repo, {});
    expect(result.skipped).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest).not.toBeNull();
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBeUndefined();
    expect(manifest?.files['.claude/rules/workflow.md']).toBeUndefined();
  });
});

// A payload path is not merely a name: a symlink at the leaf or in a parent
// component can make that name resolve outside the repository. `init` is an
// adoption command and must refuse before any such destination can be opened.
describe('initProject — symlink confinement', () => {
  it('refuses a final payload symlink without creating its dangling target outside the repo', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      const danglingTarget = path.join(outside, 'must-not-exist.md');
      await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
      try {
        await symlink(danglingTarget, path.join(repo, '.claude', 'rules', 'workflow.md'), 'file');
      } catch {
        // Windows hosts without the symlink privilege cannot exercise this;
        // Linux CI and WSL must run it.
        context.skip();
        return;
      }

      await expect(initProject(repo, {})).rejects.toThrow(InitError);
      await expect(readFile(danglingTarget, 'utf8')).rejects.toThrow();
    } finally {
      await removeFixture(outside);
    }
  });

  it('refuses a symlinked parent component without writing the payload outside the repo', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      await mkdir(path.join(repo, '.claude'), { recursive: true });
      try {
        await symlink(outside, path.join(repo, '.claude', 'rules'), 'dir');
      } catch {
        // Windows hosts without the symlink privilege cannot exercise this;
        // Linux CI and WSL must run it.
        context.skip();
        return;
      }

      await expect(initProject(repo, {})).rejects.toThrow(InitError);
      await expect(readFile(path.join(outside, 'workflow.md'), 'utf8')).rejects.toThrow();
    } finally {
      await removeFixture(outside);
    }
  });
});

describe('initProject — a rig it already owns', () => {
  it('is idempotent: a second init skips an unchanged rig-owned CLAUDE.md', async () => {
    await initProject(repo, {});

    const second = await initProject(repo, {});

    expect(second.skipped).toContain('CLAUDE.md');
    expect(second.skipped).toContain('AGENTS.md');
  });
});
