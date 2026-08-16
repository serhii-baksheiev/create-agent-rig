import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../src/commands/create.js';
import { initProject, projectNameFor } from '../src/commands/init.js';
import { UpgradeError, applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import type { UpgradePlan, UpgradeVerdict } from '../src/commands/upgrade.js';
import type { HashHistory } from '../src/lib/history.js';
import { MANIFEST_REL, readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { substituteContent } from '../src/lib/substitute.js';
import { agentOsUniversalDir } from '../src/templates.js';

let repo: string;

const WORKFLOW = '.claude/rules/workflow.md';
const SETTINGS = '.claude/settings.json';
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

  it('never replaces settings.json — it hands over the wiring instead', async () => {
    await installRig();
    await pretendInstalled(SETTINGS, '{\n  "hooks": {}\n}\n');

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, SETTINGS)).toBe('wiring');
    expect(plan.wiring).toContain('hooks');

    await applyUpgrade(repo, plan);
    expect(await read(SETTINGS)).toBe('{\n  "hooks": {}\n}\n');
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

// `init` is allowed to run inside a generated project — someone refreshing the
// process layer by hand does exactly that. What it must not do is rewrite the
// manifest's *identity*: a create rig demoted to `kind: "init"` with no stacks
// still upgrades, silently, from the smaller install set — the overlays leave
// the plan without ever being reported as deleted or conflicting.
describe('`init --force` inside a rig that came from `create`', () => {
  let project: string;

  const AWS_RULE = '.claude/rules/aws-cdk.md';
  const NODE_RULE = '.claude/rules/node-ts.md';

  /** A generated project, then the process layer re-installed over it. */
  const generateThenInit = async (): Promise<void> => {
    project = path.join(repo, 'my-app');
    await createProject('my-app', { cwd: repo, target: 'aws-serverless', git: false });
    // --force is the only way in: plain `init` refuses the existing CLAUDE.md.
    await initProject(project, { force: true });
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
