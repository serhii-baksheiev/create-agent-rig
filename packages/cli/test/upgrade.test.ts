import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../src/commands/create.js';
import { initProject, projectNameFor } from '../src/commands/init.js';
import { UpgradeError, applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import type { UpgradePlan, UpgradeVerdict } from '../src/commands/upgrade.js';
import type { HashHistory } from '../src/lib/history.js';
import { MANIFEST_REL, readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { isSafeSubstitutionValue } from '../src/lib/safe-path.js';
import { substituteContent } from '../src/lib/substitute.js';
import { agentOsUniversalDir } from '../src/templates.js';

let repo: string;

const WORKFLOW = '.claude/rules/workflow.md';
const SETTINGS = '.claude/settings.json';
const CODEX_HOOKS = '.codex/hooks.json';
const STOP_FLAG = '.claude/scripts/stop-flag.mjs';

const abs = (rel: string): string => path.join(repo, ...rel.split('/'));
const read = (rel: string): Promise<string> => readFile(abs(rel), 'utf8');
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), content);
};

const verdictFor = (plan: UpgradePlan, rel: string): UpgradeVerdict | undefined =>
  plan.actions.find((a) => a.rel === rel)?.verdict;

/** The rig as `init` leaves it: files installed, manifest written. */
async function installRig(): Promise<void> {
  await initProject(repo, {});
}

/** Rewrite one installed file AND the manifest entry — "the release changed it". */
async function pretendInstalled(rel: string, content: string): Promise<void> {
  await write(rel, content);
  const manifest = await readManifest(repo);
  if (manifest === null) throw new Error('fixture: no manifest');
  manifest.files[rel] = sha256(content);
  await writeManifest(repo, manifest);
}

const emptyHistory: HashHistory = { versions: [], files: {} };

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('init writes the manifest that makes an upgrade possible', () => {
  it('records the version, the kind and a hash per installed file', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    expect(manifest?.kind).toBe('init');
    expect(manifest?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest?.files[WORKFLOW]).toBe(sha256(await read(WORKFLOW)));
    expect(manifest?.project.name).toBe(projectNameFor(repo));
  });

  it('a dry run writes no manifest either', async () => {
    await initProject(repo, { dryRun: true });
    expect(await readManifest(repo)).toBeNull();
  });

  it('never claims a file it kept rather than wrote', async () => {
    // A pre-existing file is the user's; recording it as installed would let a
    // later upgrade replace someone's own document with the rig's.
    await write(SETTINGS, '{"hooks":{}}');
    await installRig();
    const manifest = await readManifest(repo);
    expect(manifest?.files[SETTINGS]).toBeUndefined();
    expect(await read(SETTINGS)).toBe('{"hooks":{}}');
  });
});

describe('planUpgrade — what it would do, before it does anything', () => {
  it('a freshly installed rig has nothing to update and nothing to resolve', async () => {
    await installRig();
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.kind).toBe('init');
    expect(plan.bootstrapped).toBe(false);
    expect(plan.actions.every((a) => a.verdict === 'unchanged' || a.verdict === 'wiring')).toBe(
      true,
    );
    expect(verdictFor(plan, WORKFLOW)).toBe('unchanged');
  });

  it('replaces a file the release changed and the user did not touch', async () => {
    await installRig();
    await pretendInstalled(WORKFLOW, '# the 0.3.2 text\n');
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, WORKFLOW)).toBe('update');

    await applyUpgrade(repo, plan);
    expect(await read(WORKFLOW)).toContain('TDD');
    expect((await readManifest(repo))?.files[WORKFLOW]).toBe(sha256(await read(WORKFLOW)));
  });

  it('never overwrites a file the user edited — one byte is enough', async () => {
    await installRig();
    const edited = `${await read(WORKFLOW)} `;
    await write(WORKFLOW, edited);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    const action = plan.actions.find((a) => a.rel === WORKFLOW);
    expect(action?.verdict).toBe('conflict');
    // the report has to be actionable: what, why, and where the new one is
    expect(action?.reason).toBeTruthy();
    expect(action?.templatePath).toContain(path.join('rules', 'workflow.md'));

    await applyUpgrade(repo, plan);
    expect(await read(WORKFLOW)).toBe(edited);
    // a file we do not own stays out of the manifest — it is still the user's
    expect((await readManifest(repo))?.files[WORKFLOW]).toBeUndefined();
  });

  it('installs a file this release added, and does not resurrect one the user deleted', async () => {
    await installRig();

    // added by the release: absent from disk AND from the manifest
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    delete manifest.files[WORKFLOW];
    await writeManifest(repo, manifest);
    await rm(abs(WORKFLOW));

    // deleted by the user: absent from disk, still named by the manifest
    await rm(abs(STOP_FLAG));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, WORKFLOW)).toBe('new');
    expect(verdictFor(plan, STOP_FLAG)).toBe('deleted');

    await applyUpgrade(repo, plan);
    expect(await read(WORKFLOW)).toContain('TDD');
    await expect(read(STOP_FLAG)).rejects.toThrow();
  });

  // `settings.json` is a merge target rather than a payload — but only while
  // the bytes on disk are somebody's own. When the manifest's recorded hash
  // matches them they are provably the rig's, and handing the wiring over by
  // hand for a file nobody touched leaves every unmodified rig's hooks a
  // release behind. So the exemption is the hash, not the filename: same rule
  // and same code path as every other manifest-tracked file.
  it('replaces a settings.json the user never touched', async () => {
    await installRig();
    const released = await read(SETTINGS); // the wiring this version installs
    await pretendInstalled(SETTINGS, '{\n  "hooks": {}\n}\n');

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, SETTINGS)).toBe('update');
    // replaced *instead of* being handed over, not as well as: the report's
    // hand-over block would contradict the write
    expect(plan.wiring).toBeNull();

    await applyUpgrade(repo, plan);
    expect(await read(SETTINGS)).toBe(released);
    expect(await read(SETTINGS)).toContain('guard-bash.mjs');
    expect((await readManifest(repo))?.files[SETTINGS]).toBe(sha256(released));
  });

  it('hands over the wiring for a settings.json the user edited, and writes none of it', async () => {
    await installRig();
    // the manifest still holds the hash `init` recorded, so these bytes are
    // provably not the rig's — the user's own hooks may be among them
    const mine = '{\n  "hooks": {}\n}\n';
    await write(SETTINGS, mine);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, SETTINGS)).toBe('wiring');
    expect(plan.wiring).toContain('hooks');

    await applyUpgrade(repo, plan);
    expect(await read(SETTINGS)).toBe(mine);
  });

  it('hands over Codex hook wiring the user edited, and writes none of it', async () => {
    await installRig();
    const mine = '{\n  "hooks": {"PreToolUse": []}\n}\n';
    await write(CODEX_HOOKS, mine);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, CODEX_HOOKS)).toBe('wiring');

    await applyUpgrade(repo, plan);
    expect(await read(CODEX_HOOKS)).toBe(mine);
  });

  it('does not tell the user their own settings.json was edited since it was installed', async () => {
    // `init` keeps a pre-existing settings.json and deliberately does not record
    // it, so there is no recorded hash — the same state the conflict arm already
    // distinguishes. Handing the wiring over is right either way; saying it was
    // "edited since it was installed" is a claim about an install that never
    // happened, made to the user about their own file.
    await write(SETTINGS, '{"hooks":{}}');
    await installRig();
    expect((await readManifest(repo))?.files[SETTINGS]).toBeUndefined();

    const plan = await planUpgrade(repo, { history: emptyHistory });
    const action = plan.actions.find((a) => a.rel === SETTINGS);
    expect(action?.verdict).toBe('wiring');
    expect(action?.reason).not.toMatch(/edited since/i);
    expect(action?.reason).toMatch(/never released|treated as yours/i);
  });

  it('a dry run writes nothing at all', async () => {
    await installRig();
    await pretendInstalled(WORKFLOW, '# the 0.3.2 text\n');
    const plan = await planUpgrade(repo, { history: emptyHistory });
    await applyUpgrade(repo, plan, { dryRun: true });
    expect(await read(WORKFLOW)).toBe('# the 0.3.2 text\n');
  });

  it('refuses a directory that holds no rig, as a message not a trace', async () => {
    await expect(planUpgrade(repo, { history: emptyHistory })).rejects.toBeInstanceOf(UpgradeError);
  });
});

// `create` installs the whole agent-os layer plus its stack overlays, and it is
// the arm that writes into a full monorepo — the expensive one to be wrong in.
describe('a rig that came from `create`, not from `init`', () => {
  let project: string;

  const generate = async (): Promise<void> => {
    project = path.join(repo, 'my-app');
    await createProject('my-app', { cwd: repo, target: 'node-service', git: false });
  };
  const readIn = (rel: string): Promise<string> =>
    readFile(path.join(project, ...rel.split('/')), 'utf8');

  it('records the stack overlays it composed, and refreshes them', async () => {
    await generate();
    const manifest = await readManifest(project);
    expect(manifest?.kind).toBe('create');
    expect(manifest?.stacks).toEqual(['node-ts']);
    // a stack-layer file the `init` set does not contain at all
    expect(manifest?.files['.claude/rules/node-ts.md']).toBeTruthy();

    // the release changed a stack rule the user never touched
    const stackRule = '.claude/rules/node-ts.md';
    manifest!.files[stackRule] = sha256('# the old node-ts rules\n');
    await writeFile(path.join(project, ...stackRule.split('/')), '# the old node-ts rules\n');
    await writeManifest(project, manifest!);

    const plan = await planUpgrade(project, { history: emptyHistory });
    expect(plan.kind).toBe('create');
    expect(verdictFor(plan, stackRule)).toBe('update');
    await applyUpgrade(project, plan);
    expect(await readIn(stackRule)).toContain('TypeScript');
  });

  it('is recognised as create-shaped with no manifest, and keeps its own map', async () => {
    await generate();
    await rm(path.join(project, ...MANIFEST_REL.split('/')));
    const claudeMd = await readIn('CLAUDE.md');

    const plan = await planUpgrade(project, { history: emptyHistory });
    expect(plan.kind).toBe('create');
    // the generated map is current, so it is never swapped for init's variant
    expect(verdictFor(plan, 'CLAUDE.md')).toBe('unchanged');
    await applyUpgrade(project, plan);
    expect(await readIn('CLAUDE.md')).toBe(claudeMd);
    expect(await readIn('.claude/rules/architecture.md')).toContain('core');
  });

  it('leaves the project code alone — the skeleton is not the rig', async () => {
    await generate();
    const plan = await planUpgrade(project, { history: emptyHistory });
    expect(plan.actions.some((a) => a.rel.startsWith('packages/'))).toBe(false);
    expect(plan.actions.some((a) => a.rel.startsWith('services/'))).toBe(false);
  });
});

// A `create` rig's directory name is only a legal project name until someone
// renames the directory or clones it under another name. The manifest an
// upgrade bootstraps from that basename is then written and immediately voided:
// its own reader refuses the value, so every later run falls back to matching
// against released versions — the release's whole point, lost silently. This is
// the third population the plan header has to be true for: the file is on disk
// and unreadable, which is why that line says "no READABLE manifest".
describe('a `create` rig upgraded from a directory name that is not a project name', () => {
  let project: string;

  /** Generated as `my-app`, then renamed — and the manifest gone, as 0.3.x left it. */
  const generateThenRenameAndForget = async (): Promise<void> => {
    await createProject('my-app', { cwd: repo, target: 'node-service', git: false });
    project = path.join(repo, 'My App');
    await rename(path.join(repo, 'my-app'), project);
    await rm(path.join(project, ...MANIFEST_REL.split('/')));
  };

  const readIn = (rel: string): Promise<string> =>
    readFile(path.join(project, ...rel.split('/')), 'utf8');

  it('writes a manifest its own reader can read back', async () => {
    await generateThenRenameAndForget();
    const plan = await planUpgrade(project, { history: emptyHistory });
    await applyUpgrade(project, plan);

    const manifest = await readManifest(project);
    expect(manifest).not.toBeNull();
    // the literal value, not `projectNameFor(project)` — asserting against the
    // function under test would hold just as well if it were broken.
    expect(manifest?.project.name).toBe('my-app');
    expect(manifest?.project.scope).toBe('my-app');
  });

  it('substitutes the slugged name, so the installed files are not all conflicts', async () => {
    await generateThenRenameAndForget();
    const plan = await planUpgrade(project, { history: emptyHistory });
    // stop-flag.mjs carries __PROJECT_NAME__: substituting the raw basename
    // makes the kill switch differ from the bytes on disk for no reason, and
    // an unslugged value there is what reaches the hook's string literal.
    expect(verdictFor(plan, STOP_FLAG)).toBe('unchanged');

    await applyUpgrade(project, plan);
    expect(await readIn(STOP_FLAG)).toContain('my-app-loop-STOP');
  });
});

// The other half of the same rule, and the one slugging everything gives up:
// `create`'s name pattern accepts a **trailing** dash or dot (`my-app-`), the
// manifest reader accepts it too, and the generated files are substituted with
// it — but `projectNameFor` strips it. Bootstrapping from the slug then names a
// project this rig never was: every file carrying `__PROJECT_NAME__` stops
// matching what is on disk, so the rig's own generated bytes come back as the
// user's edits. Slug only where the raw name is unreadable.
describe('a `create` rig whose own name is legal for the manifest but is not its slug', () => {
  let project: string;

  /** The name `create` accepted and wrote everywhere — and the slug drops the tail. */
  const NAME = 'my-app-';

  /** Generated as `my-app-`, and the manifest gone, as 0.3.x left it. */
  const generateThenForget = async (): Promise<void> => {
    project = path.join(repo, NAME);
    await createProject(NAME, { cwd: repo, target: 'node-service', git: false });
    await rm(path.join(project, ...MANIFEST_REL.split('/')));
  };

  const readIn = (rel: string): Promise<string> =>
    readFile(path.join(project, ...rel.split('/')), 'utf8');

  it('bootstraps the name the rig was generated with, not a slug of it', async () => {
    await generateThenForget();
    // the premise: nothing forces a slug here — this value is already safe to
    // substitute, and it is not what `projectNameFor` would emit.
    expect(isSafeSubstitutionValue(NAME)).toBe(true);
    expect(projectNameFor(project)).not.toBe(NAME);

    const plan = await planUpgrade(project, { history: emptyHistory });
    await applyUpgrade(project, plan);

    const manifest = await readManifest(project);
    // still round-trips: the reader that refused `My App` accepts this one
    expect(manifest).not.toBeNull();
    expect(manifest?.project.name).toBe(NAME);
    expect(manifest?.project.scope).toBe(NAME);
  });

  it('leaves the kill switch it generated alone instead of calling it an edit', async () => {
    await generateThenForget();
    // what `create` wrote: the raw name, trailing dash and all
    expect(await readIn(STOP_FLAG)).toContain(`${NAME}-loop-STOP`);

    const plan = await planUpgrade(project, { history: emptyHistory });
    expect(verdictFor(plan, STOP_FLAG)).toBe('unchanged');

    await applyUpgrade(project, plan);
    expect(await readIn(STOP_FLAG)).toContain(`${NAME}-loop-STOP`);
  });

  it('reports no conflict at all in a rig nobody has edited', async () => {
    await generateThenForget();
    const plan = await planUpgrade(project, { history: emptyHistory });
    const conflicts = plan.actions.filter((a) => a.verdict === 'conflict').map((a) => a.rel);
    expect(conflicts).toEqual([]);
  });
});

// The third case, and the one that decides the rule rather than restating it:
// `init` never keeps the raw directory name. It derives the name it substitutes
// into the files *and* the name it records in the manifest from
// `projectNameFor`, so for a directory the manifest reader happens to accept
// (`my-repo.`) the raw name and the installed bytes disagree. Bootstrapping the
// raw name there names a rig `init` never wrote, and every file carrying
// `__PROJECT_NAME__` comes back as the user's edit.
//
// Read next to the two blocks above, the three are one rule: `init` always
// follows the slug; `create` keeps its raw name whenever the reader accepts it.
describe('an `init` rig whose directory name is legal for the manifest but is not its slug', () => {
  let project: string;

  /** The directory name — safe to substitute, and not what `init` substituted. */
  const NAME = 'my-repo.';
  /** The name `init` actually wrote into the files and the manifest. */
  const SLUG = 'my-repo';

  const readIn = (rel: string): Promise<string> =>
    readFile(path.join(project, ...rel.split('/')), 'utf8');

  /** Installed by `init` into `my-repo.`, and the manifest gone, as 0.3.x left it. */
  const initThenForget = async (): Promise<void> => {
    project = path.join(repo, NAME);
    await mkdir(project, { recursive: true });
    await initProject(project, {});

    // The premise, asserted so a broken fixture fails as a fixture: nothing
    // forces a slug on this directory name, and `init` slugged it anyway —
    // both in the bytes it wrote and in the manifest it recorded.
    expect(isSafeSubstitutionValue(NAME)).toBe(true);
    expect(projectNameFor(project)).toBe(SLUG);
    expect(await readIn(STOP_FLAG)).toContain(`${SLUG}-loop-STOP`);
    expect(await readIn(STOP_FLAG)).not.toContain(`${NAME}-loop-STOP`);
    expect((await readManifest(project))?.project.name).toBe(SLUG);

    await rm(path.join(project, ...MANIFEST_REL.split('/')));
  };

  it('bootstraps the name `init` substituted, not the directory it sits in', async () => {
    await initThenForget();
    const plan = await planUpgrade(project, { history: emptyHistory });
    await applyUpgrade(project, plan);

    const manifest = await readManifest(project);
    // still round-trips: the reader accepts this value either way, so reading
    // it back is not what distinguishes the two names — which one is on disk is
    expect(manifest).not.toBeNull();
    expect(manifest?.project.name).toBe(SLUG);
    expect(manifest?.project.scope).toBe(SLUG);
  });

  it('leaves the kill switch `init` generated alone instead of calling it an edit', async () => {
    await initThenForget();
    const plan = await planUpgrade(project, { history: emptyHistory });
    expect(verdictFor(plan, STOP_FLAG)).toBe('unchanged');

    await applyUpgrade(project, plan);
    expect(await readIn(STOP_FLAG)).toContain(`${SLUG}-loop-STOP`);
  });

  it('reports no conflict at all in a rig nobody has edited', async () => {
    await initThenForget();
    const plan = await planUpgrade(project, { history: emptyHistory });
    const conflicts = plan.actions.filter((a) => a.verdict === 'conflict').map((a) => a.rel);
    expect(conflicts).toEqual([]);
  });
});

// `init` is allowed to run inside a generated project — someone refreshing the
// process layer by hand does exactly that. What it must not do is rewrite the
// manifest's *identity*: a create rig demoted to `kind: "init"` with no stacks
// still upgrades, silently, from the smaller install set — the overlays leave
// the plan without ever being reported as deleted or conflicting.
describe('`init` inside a rig that came from `create`, reached by a deleted CLAUDE.md', () => {
  let project: string;

  const AWS_RULE = '.claude/rules/aws-cdk.md';
  const NODE_RULE = '.claude/rules/node-ts.md';

  /** A generated project, then the process layer re-installed over it. */
  const generateThenInit = async (): Promise<void> => {
    project = path.join(repo, 'my-app');
    await createProject('my-app', { cwd: repo, target: 'aws-serverless', git: false });
    // The way in is a deleted CLAUDE.md, which is what lifts `init`'s refusal —
    // and it is the case `recordInstall`'s own docstring names as the gap it
    // exists to make safe. `--force` used to be the other way in and is now
    // refused outright, but what these tests pin is unchanged by that: whatever
    // route reaches `recordInstall`, it must not re-describe how the rig was
    // installed.
    await rm(path.join(project, 'CLAUDE.md'));
    await initProject(project, {});
  };

  it('leaves the manifest still saying the rig came from `create`', async () => {
    await generateThenInit();
    expect((await readManifest(project))?.kind).toBe('create');
  });

  it('keeps the stack overlays the project was composed from', async () => {
    await generateThenInit();
    expect((await readManifest(project))?.stacks).toEqual(['node-ts', 'aws-cdk']);
  });

  it('keeps the substitution values the generated files were written with', async () => {
    await generateThenInit();
    // region is what `init` has no way to know and every overlay file is
    // substituted with — blanking it makes the whole rig a conflict.
    expect((await readManifest(project))?.project).toEqual({
      name: 'my-app',
      scope: 'my-app',
      region: 'eu-central-1',
    });
  });

  it('still records the process files it wrote', async () => {
    await generateThenInit();
    const manifest = await readManifest(project);
    expect(manifest?.files['CLAUDE.md']).toBe(
      sha256(await readFile(path.join(project, 'CLAUDE.md'), 'utf8')),
    );
    // and it did not forget what `create` installed
    expect(manifest?.files[AWS_RULE]).toBeTruthy();
  });

  it('leaves the next upgrade still refreshing the stack overlays', async () => {
    await generateThenInit();
    const plan = await planUpgrade(project, { history: emptyHistory });
    const planned = plan.actions.map((a) => a.rel);
    expect(planned).toContain(AWS_RULE);
    expect(planned).toContain(NODE_RULE);
  });
});

// The recorded hash proves the rig wrote these bytes. It does not prove the
// install set this run computed is the same one that wrote them — `kind` does,
// and `kind` is a field in a committed file that any earlier version, any merge
// or any hand-edit can have demoted. A `create` rig whose manifest says `init`
// therefore reaches the recorded-hash arm with the *narrowed* wiring in hand:
// replacing settings.json there deletes the entries for two hooks that are
// still sitting on disk, which is the exact harm `init-settings.ts` names —
// "the hooks sit on disk, the rules claim they are enforced, and nothing ever
// calls them". A replacement that would unwire an installed hook is not an
// upgrade, whatever the manifest says.
describe('a rig running wiring wider than the flavour its manifest claims', () => {
  let project: string;

  const GUARD = '.claude/hooks/guard-core-purity.mjs';

  const readIn = (rel: string): Promise<string> =>
    readFile(path.join(project, ...rel.split('/')), 'utf8');

  /** A generated project whose manifest has been demoted to `kind: "init"`. */
  const generateThenDemoteTheKind = async (): Promise<void> => {
    project = path.join(repo, 'my-app');
    await createProject('my-app', { cwd: repo, target: 'aws-serverless', git: false });

    // The premise, asserted so a broken fixture fails as a fixture: `create`
    // wired the architecture hooks, installed them, and the manifest vouches
    // for exactly the bytes on disk. Only `kind` changes below.
    const manifest = await readManifest(project);
    if (manifest === null) throw new Error('fixture: no manifest');
    expect(await readIn(SETTINGS)).toContain('guard-core-purity.mjs');
    expect(manifest.files[SETTINGS]).toBe(sha256(await readIn(SETTINGS)));
    expect(manifest.kind).toBe('create');

    manifest.kind = 'init';
    await writeManifest(project, manifest);
  };

  it('hands the wiring over rather than replacing it with the narrower flavour', async () => {
    await generateThenDemoteTheKind();
    const plan = await planUpgrade(project, { history: emptyHistory });
    expect(verdictFor(plan, SETTINGS)).toBe('wiring');
    expect(plan.wiring).not.toBeNull();
  });

  it('leaves a hook still on disk wired after the upgrade', async () => {
    await generateThenDemoteTheKind();
    const plan = await planUpgrade(project, { history: emptyHistory });
    await applyUpgrade(project, plan);

    // The verdict above is the mechanism; this is the harm. Read the file:
    // the hook is on disk, so settings.json must still call it.
    await expect(readIn(GUARD)).resolves.toBeTruthy();
    expect(await readIn(SETTINGS)).toContain('guard-core-purity.mjs');
  });

  it('replaces the wiring once every hook it would stop calling is gone', async () => {
    // The other side of the guard, and the whole of what its filesystem probe
    // buys: a hook the user deleted is not being silenced by this write, so
    // there is nothing to hand over and the replacement is ordinary again.
    // Without the probe this case would hand over a wiring block listing hooks
    // that no longer exist.
    //
    // BOTH architecture hooks go: the narrower flavour drops the pair, and one
    // surviving on disk is enough to keep the hand-over — which is the guard
    // working, and is why this fixture deletes them together.
    await generateThenDemoteTheKind();
    await rm(path.join(project, ...GUARD.split('/')));
    await rm(path.join(project, '.claude', 'hooks', 'guard-web-boundary.mjs'));

    const plan = await planUpgrade(project, { history: emptyHistory });
    expect(verdictFor(plan, SETTINGS)).toBe('update');

    await applyUpgrade(project, plan);
    expect(await readIn(SETTINGS)).not.toContain('guard-core-purity.mjs');
  });
});

// The manifest is meant to be committed, so it travels in pull requests: it is
// input from whoever wrote it, not from the rig. Its values reach `path.join`.
describe('a manifest is evidence, not an instruction to write anywhere', () => {
  const plant = async (manifest: unknown): Promise<void> => {
    await write(MANIFEST_REL, JSON.stringify(manifest, null, 2));
  };

  it('ignores a project name that would write outside the repo', async () => {
    await installRig();
    await plant({
      version: '0.3.2',
      kind: 'create',
      project: { name: '../pwned', scope: '../pwned', region: '' },
      stacks: [],
      files: {},
    });
    // unreadable manifest → no evidence → bootstrap, never a path to obey
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.bootstrapped).toBe(true);
    expect(plan.actions.every((a) => !a.rel.includes('..'))).toBe(true);

    await applyUpgrade(repo, plan);
    await expect(readFile(path.join(path.dirname(repo), 'pwned'), 'utf8')).rejects.toThrow();
  });

  it('reads no template directory a stack name points at', async () => {
    await installRig();
    await write('.claude/rules/architecture.md', '# create-shaped\n');
    await plant({
      version: '0.3.2',
      kind: 'create',
      project: { name: 'host', scope: 'host', region: '' },
      stacks: ['../../../../../../etc'],
      files: {},
    });
    // rejected outright as a manifest; and even named as a plain unknown
    // stack it resolves to no layer, so nothing outside `templates/` is read
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.actions.some((a) => a.rel.includes('passwd'))).toBe(false);
  });

  it('drops a stack this version does not ship, instead of crashing on it', async () => {
    await installRig();
    await write('.claude/rules/architecture.md', '# create-shaped\n');
    await plant({
      version: '0.3.2',
      kind: 'create',
      project: { name: 'host', scope: 'host', region: '' },
      stacks: ['node-ts', 'not-a-stack'],
      files: {},
    });
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.kind).toBe('create');
    expect(plan.actions.length).toBeGreaterThan(0);
  });
});

// The 0.3.1/0.3.2 rigs in the wild have no manifest. The package carries the
// hashes of every released version instead, so "did the user touch this file"
// still has an honest answer.
describe('bootstrap — a rig installed before the manifest existed', () => {
  const historyFor = (rel: string, ...contents: string[]): HashHistory => ({
    versions: ['0.3.2'],
    files: { [rel]: { since: '0.3.2', hashes: contents.map((c) => sha256(c)) } },
  });

  it('replaces a file that matches a released version, and reports the rest', async () => {
    await installRig();
    const untouched = '# the 0.3.2 text\n';
    await write(WORKFLOW, untouched);
    const edited = `${await read('.claude/rules/autonomy.md')}// mine\n`;
    await write('.claude/rules/autonomy.md', edited);
    await rm(abs(MANIFEST_REL));

    const plan = await planUpgrade(repo, { history: historyFor(WORKFLOW, untouched) });
    expect(plan.bootstrapped).toBe(true);
    expect(plan.fromVersion).toBeNull();
    expect(verdictFor(plan, WORKFLOW)).toBe('update');
    expect(verdictFor(plan, '.claude/rules/autonomy.md')).toBe('conflict');

    await applyUpgrade(repo, plan);
    expect(await read(WORKFLOW)).toContain('TDD');
    expect(await read('.claude/rules/autonomy.md')).toBe(edited);
    // after the first upgrade the rig is no longer blind
    expect((await readManifest(repo))?.files[WORKFLOW]).toBeTruthy();
  });

  it('recognises a released version through token substitution', async () => {
    // stop-flag.mjs carries __PROJECT_NAME__, so the released *template* bytes
    // never equal the bytes on disk. Recognition has to see through that, or
    // every rig's kill switch is a permanent conflict.
    await installRig();
    const releasedTemplate = await readFile(
      path.join(agentOsUniversalDir(), ...STOP_FLAG.split('/')),
      'utf8',
    );
    const olderTemplate = releasedTemplate.replace('const paths', 'const olderPaths');
    expect(olderTemplate).not.toBe(releasedTemplate);
    const name = projectNameFor(repo);
    await write(
      STOP_FLAG,
      substituteContent(olderTemplate, { projectName: name, projectScope: name, region: '' }),
    );
    await rm(abs(MANIFEST_REL));

    const plan = await planUpgrade(repo, { history: historyFor(STOP_FLAG, olderTemplate) });
    expect(verdictFor(plan, STOP_FLAG)).toBe('update');

    await applyUpgrade(repo, plan);
    expect(await read(STOP_FLAG)).toContain(`${name}-loop-STOP`);
    expect(await read(STOP_FLAG)).not.toContain('olderPaths');
  });

  it('hands over the wiring for a settings.json only the released hashes recognise', async () => {
    // The manifest's recorded hash is the one arm that vouches for *these*
    // bytes in *this* rig. The released-hash table is weaker evidence: it says
    // some release wrote these bytes, not which flavour of the wiring this rig
    // is entitled to — and a rig with no manifest is exactly the one whose
    // flavour cannot be established. Recognition there is grounds to report,
    // never to overwrite; the file this command must not get wrong is the one
    // that decides which hooks run at all.
    await installRig();
    const released = await read(SETTINGS);
    const older = released.replace('guard-bash.mjs', 'older-guard-bash.mjs');
    expect(older).not.toBe(released);
    await write(SETTINGS, older);
    await rm(abs(MANIFEST_REL));

    const plan = await planUpgrade(repo, { history: historyFor(SETTINGS, older) });
    expect(plan.bootstrapped).toBe(true);
    expect(verdictFor(plan, SETTINGS)).toBe('wiring');
    expect(plan.wiring).toContain('hooks');

    await applyUpgrade(repo, plan);
    expect(await read(SETTINGS)).toBe(older);
  });

  it('keeps a deletion it has no manifest for, and still delivers what is new', async () => {
    // Without a manifest the table answers instead: a path that shipped in
    // every release the rig could be was there to be removed, so its absence
    // is a decision — `.claude/rules/invariants.md` tells owners to delete the
    // rules they do not have, and the first upgrade must not undo that. A path
    // this release introduced is a different case and is installed.
    await installRig();
    await rm(abs(STOP_FLAG));
    await rm(abs(WORKFLOW));
    await rm(abs(MANIFEST_REL));

    const history: HashHistory = {
      versions: ['0.3.0', '0.3.2'],
      files: {
        [STOP_FLAG]: { since: '0.3.0', hashes: [sha256('whatever')] },
        [WORKFLOW]: { since: '0.3.2', hashes: [sha256('whatever')] },
        // one recognisable file, or there is no rig here at all
        ['.claude/rules/autonomy.md']: {
          since: '0.3.0',
          hashes: [sha256(await read('.claude/rules/autonomy.md'))],
        },
      },
    };
    const plan = await planUpgrade(repo, { history });
    expect(verdictFor(plan, STOP_FLAG)).toBe('deleted');
    expect(verdictFor(plan, WORKFLOW)).toBe('new');

    await applyUpgrade(repo, plan);
    await expect(read(STOP_FLAG)).rejects.toThrow();
    expect(await read(WORKFLOW)).toContain('TDD');
  });

  it('refuses a repo that merely happens to have a CLAUDE.md', async () => {
    // The install set contains CLAUDE.md and settings.json, which nearly every
    // repository an agent has touched already has. Without recognisable bytes
    // this command would perform an `init` nobody asked for.
    await write('CLAUDE.md', '# some other project\n');
    await write('.claude/settings.json', '{}\n');
    await expect(planUpgrade(repo, { history: emptyHistory })).rejects.toBeInstanceOf(UpgradeError);
    await expect(read('.claude/rules/workflow.md')).rejects.toThrow();
  });

  it('a hand-upgraded file is current, not a conflict', async () => {
    // 0.3.2 told users to copy six files across by hand. Those files match no
    // manifest and no *older* release — they match this one, and calling that
    // a conflict would make the honest user the one who gets the noise.
    await installRig();
    await rm(abs(MANIFEST_REL));
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, WORKFLOW)).toBe('unchanged');
  });
});
