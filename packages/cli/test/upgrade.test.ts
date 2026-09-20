import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initInstallSet, initProject, projectNameFor } from '../src/commands/init.js';
import { UpgradeError, applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import type { UpgradePlan, UpgradeVerdict } from '../src/commands/upgrade.js';
import type { HashHistory } from '../src/lib/history.js';
import { MANIFEST_REL, readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { substituteContent } from '../src/lib/substitute.js';
import { agentOsUniversalDir } from '../src/templates.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

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
  await removeFixture(repo);
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

// RP-177 retired the create/init distinction entirely: there is exactly one
// payload, and `create` is a thin wrapper that installs it the same way
// `init` does. What used to be "a rig that came from `create`" is now
// indistinguishable from one `init` produced directly — both write
// `kind: 'init'`, both compose no stack overlays. What survives from that
// era is a rig an OLDER release actually generated, which is a fixture
// planted by hand below rather than something `createProject` can still
// produce (there is no lever left in this codebase to produce a `kind:
// 'create'` manifest, or a manifest naming stacks, on purpose — that is the
// point of the change, not a gap in its test coverage).
describe('a legacy rig from before RP-177 (kind: "create", stack overlays)', () => {
  const STACK_RULE = '.claude/rules/node-ts.md';

  /** A manifest shaped like a pre-0.10 `create --target node-service` rig. */
  const plantLegacyManifest = async (files: Record<string, string>): Promise<void> => {
    await write(
      MANIFEST_REL,
      `${JSON.stringify(
        {
          version: '0.9.1',
          kind: 'create',
          project: { name: 'legacy-app', scope: 'legacy-app', region: '' },
          stacks: ['node-ts'],
          files,
        },
        null,
        2,
      )}\n`,
    );
  };

  it('retires a stack-overlay path this release no longer ships — never written, never deleted', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');

    // A file the CURRENT install set does not contain at all — exactly what a
    // pre-0.10 stack overlay looks like today: nothing to update it against,
    // nothing to delete it as.
    const stackRuleContent = '# the old node-ts rules, from a release this one is not\n';
    await write(STACK_RULE, stackRuleContent);
    await plantLegacyManifest({ ...manifest.files, [STACK_RULE]: sha256(stackRuleContent) });

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.kind).toBe('create');
    expect(verdictFor(plan, STACK_RULE)).toBe('retired');
    const action = plan.actions.find((a) => a.rel === STACK_RULE);
    expect(action?.reason).toMatch(/no longer shipped/i);

    await applyUpgrade(repo, plan);
    // untouched — neither written (no template exists to write) nor deleted
    expect(await read(STACK_RULE)).toBe(stackRuleContent);

    const next = await readManifest(repo);
    // the rig drops its claim: the path is gone from `files`
    expect(next?.files[STACK_RULE]).toBeUndefined();
    // and `stacks` is written empty — there are no overlays left to record
    expect(next?.stacks).toEqual([]);
  });

  it('never reports `retired` for a manifest-less (bootstrapped) rig — there is no `files` list to diff', async () => {
    await installRig();
    await write(STACK_RULE, '# a file with no manifest behind it\n');
    await rm(abs(MANIFEST_REL));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.bootstrapped).toBe(true);
    expect(plan.actions.some((a) => a.verdict === 'retired')).toBe(false);
    // it is simply not part of this release's install set, so it is not
    // planned at all — not retired, not a conflict, not anything
    expect(plan.actions.some((a) => a.rel === STACK_RULE)).toBe(false);

    await applyUpgrade(repo, plan);
    await expect(read(STACK_RULE)).resolves.toBeTruthy(); // still exactly what it was
  });

  it('preserves `kind` from the old manifest rather than re-describing how the rig was installed', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await plantLegacyManifest(manifest.files);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.kind).toBe('create');
    await applyUpgrade(repo, plan);
    expect((await readManifest(repo))?.kind).toBe('create');
  });

  it('leaves the project code alone — an application file is never in any install set', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await write('packages/core/src/note.ts', '// legacy application code\n');
    await plantLegacyManifest(manifest.files);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.actions.some((a) => a.rel.startsWith('packages/'))).toBe(false);

    await applyUpgrade(repo, plan);
    expect(await read('packages/core/src/note.ts')).toBe('// legacy application code\n');
  });

  it('still replaces a still-shipped process file the release changed and the user did not touch', async () => {
    await installRig();
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await plantLegacyManifest(manifest.files);
    await pretendInstalled(WORKFLOW, '# the 0.9.1 text\n');

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, WORKFLOW)).toBe('update');
    await applyUpgrade(repo, plan);
    expect(await read(WORKFLOW)).toContain('TDD');
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

  // RP-177 removed the lookup this test used to pin altogether: `stacks`
  // never resolves to a directory any more (there is exactly one payload, and
  // `initInstallSet` does not take a stack list), so a hostile or unknown
  // entry has nothing left to steer. What's left worth proving is only that
  // `planUpgrade` still reads such a manifest without crashing, and writes
  // the field back empty. A path-traversal entry is covered separately, above
  // — `isSafeSubstitutionValue` voids the whole manifest for one, which is a
  // different (and already-tested) outcome than "an unknown but safely-shaped
  // stack name".
  it('reads an old manifest naming a stack this version does not ship, without crashing on it', async () => {
    await installRig();
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
    expect(plan.manifest.stacks).toEqual([]);
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
    await write(STOP_FLAG, substituteContent(olderTemplate, { projectName: name }));
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

  it('preserves a valid trailing-hyphen create identity when bootstrapping a manifest-less legacy rig', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-legacy-'));
    const legacyRepo = path.join(parent, 'legacy-app-');
    try {
      await mkdir(legacyRepo);
      // A pre-0.10 `create` accepted this identity and substituted it into
      // payload files. Its manifest can be absent in real upgrades, so the
      // bootstrap path must derive the same identity from the directory.
      await initProject(legacyRepo, {
        project: { name: 'legacy-app-', scope: 'legacy-app-', region: '' },
      });
      await writeFile(
        path.join(legacyRepo, '.claude', 'rules', 'architecture.md'),
        '# retired create-only marker\n',
      );
      await rm(path.join(legacyRepo, MANIFEST_REL));

      const plan = await planUpgrade(legacyRepo, { history: emptyHistory });

      expect(plan.bootstrapped).toBe(true);
      expect(plan.manifest.project).toEqual({
        name: 'legacy-app-',
        scope: 'legacy-app-',
        region: '',
      });
      expect(verdictFor(plan, STOP_FLAG)).toBe('unchanged');
      expect(plan.actions.some((action) => action.verdict === 'conflict')).toBe(false);
    } finally {
      await removeFixture(parent);
    }
  });
});

describe('applyUpgrade — symlink confinement', () => {
  const oldWorkflow = '# obsolete workflow bytes\n';

  const updateWorkflowPlan = async (): Promise<UpgradePlan> => {
    await installRig();
    await pretendInstalled(WORKFLOW, oldWorkflow);
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, WORKFLOW)).toBe('update');
    return plan;
  };

  it('refuses a final target symlink and never overwrites its outside bytes', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-outside-'));
    try {
      const target = path.join(outside, 'workflow.md');
      await writeFile(target, 'OUTSIDE BYTES\n');
      const plan = await updateWorkflowPlan();
      await rm(abs(WORKFLOW));
      try {
        await symlink(target, abs(WORKFLOW), 'file');
      } catch {
        context.skip();
        return;
      }

      await expect(applyUpgrade(repo, plan)).rejects.toThrow(UpgradeError);
      expect(await readFile(target, 'utf8')).toBe('OUTSIDE BYTES\n');
    } finally {
      await removeFixture(outside);
    }
  });

  it('refuses a symlinked parent component and never creates the outside payload', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-outside-'));
    try {
      const plan = await updateWorkflowPlan();
      await removeFixture(path.join(repo, '.claude', 'rules'));
      try {
        await symlink(outside, path.join(repo, '.claude', 'rules'), 'dir');
      } catch {
        context.skip();
        return;
      }

      await expect(applyUpgrade(repo, plan)).rejects.toThrow(UpgradeError);
      await expect(readFile(path.join(outside, 'workflow.md'), 'utf8')).rejects.toThrow();
    } finally {
      await removeFixture(outside);
    }
  });
});

// RP-182: a path `init` keeps rather than writes used to fall out of the
// manifest entirely — no `files` entry, and (before this ticket) no `kept`
// entry either. Released bytes were still recognised through the hash
// history; anything else reached `conflict` with nothing saying the rig had
// found the file there and left it.
describe('planUpgrade — a path `kept` by init, not written (RP-182)', () => {
  /** Removes `rel` from `files` and records it in `kept` at `hash` instead. */
  const moveToKept = async (rel: string, hash: string): Promise<void> => {
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    delete manifest.files[rel];
    manifest.kept = { ...manifest.kept, [rel]: hash };
    await writeManifest(repo, manifest);
  };

  it('stays a conflict for bytes no release ever shipped, and the reason says "kept by init" and "unchanged since"', async () => {
    await installRig();
    const content = 'MY OWN VERSION OF WORKFLOW\n';
    await write(WORKFLOW, content);
    await moveToKept(WORKFLOW, sha256(content));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    const action = plan.actions.find((a) => a.rel === WORKFLOW);
    expect(action?.verdict).toBe('conflict');
    expect(action?.reason).toMatch(/kept by init/);
    expect(action?.reason).toMatch(/unchanged since/);
  });

  it('does not name the manifest version as the init that kept the file — every upgrade rewrites that field', async () => {
    await installRig();
    const content = 'MY OWN VERSION OF WORKFLOW\n';
    await write(WORKFLOW, content);
    await moveToKept(WORKFLOW, sha256(content));
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    await writeManifest(repo, { ...manifest, version: '7.7.7' });

    const plan = await planUpgrade(repo, { history: emptyHistory });
    const action = plan.actions.find((a) => a.rel === WORKFLOW);
    expect(action?.reason).toMatch(/kept by init/);
    expect(action?.reason).not.toMatch(/7\.7\.7/);
  });

  it('says "edited since" instead, once the disk sha no longer matches what init recorded', async () => {
    await installRig();
    const foundByInit = 'MY OWN VERSION OF WORKFLOW\n';
    const editedAfterwards = 'MY OWN VERSION OF WORKFLOW, EDITED LATER\n';
    await write(WORKFLOW, editedAfterwards);
    await moveToKept(WORKFLOW, sha256(foundByInit));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    const action = plan.actions.find((a) => a.rel === WORKFLOW);
    expect(action?.verdict).toBe('conflict');
    expect(action?.reason).toMatch(/kept by init/);
    expect(action?.reason).toMatch(/edited since/);
    expect(action?.reason).not.toMatch(/unchanged since/);
  });

  it('becomes `update` once the kept bytes turn out to match a released version — the obsolete fork gets managed', async () => {
    await installRig();
    const obsolete = 'the 0.3.2 text, kept from before init ever ran\n';
    await write(WORKFLOW, obsolete);
    await moveToKept(WORKFLOW, sha256(obsolete));

    const history: HashHistory = {
      versions: ['0.3.2'],
      files: { [WORKFLOW]: { since: '0.3.2', hashes: [sha256(obsolete)] } },
    };
    const plan = await planUpgrade(repo, { history });
    expect(verdictFor(plan, WORKFLOW)).toBe('update');
  });

  it('keeps the `kept` provenance in the next manifest, unchanged, while the path stays a conflict', async () => {
    await installRig();
    const content = 'MY OWN VERSION OF WORKFLOW\n';
    await write(WORKFLOW, content);
    await moveToKept(WORKFLOW, sha256(content));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    const nextManifest = plan.manifest;
    expect(nextManifest.kept?.[WORKFLOW]).toBe(sha256(content));
    expect(nextManifest.files[WORKFLOW]).toBeUndefined();

    await applyUpgrade(repo, plan);
    const onDisk = await readManifest(repo);
    expect(onDisk?.kept?.[WORKFLOW]).toBe(sha256(content));
    expect(onDisk?.files[WORKFLOW]).toBeUndefined();
  });

  it('moves the path out of `kept` and into `files` once it stops being a conflict (verdict: unchanged)', async () => {
    await installRig();
    // exactly what `init` already wrote — nothing for this fixture to edit
    const installed = await read(WORKFLOW);
    await moveToKept(WORKFLOW, sha256(installed));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, WORKFLOW)).toBe('unchanged');
    const nextManifest = plan.manifest;
    expect(nextManifest.kept?.[WORKFLOW]).toBeUndefined();
    expect(nextManifest.files[WORKFLOW]).toBe(sha256(installed));

    await applyUpgrade(repo, plan);
    const onDisk = await readManifest(repo);
    expect(onDisk?.kept?.[WORKFLOW]).toBeUndefined();
    expect(onDisk?.files[WORKFLOW]).toBe(sha256(installed));
  });

  it('moves the path out of `kept` and into `files` once a released match makes it an update', async () => {
    await installRig();
    const obsolete = 'the 0.3.2 text, kept from before init ever ran\n';
    await write(WORKFLOW, obsolete);
    await moveToKept(WORKFLOW, sha256(obsolete));

    const history: HashHistory = {
      versions: ['0.3.2'],
      files: { [WORKFLOW]: { since: '0.3.2', hashes: [sha256(obsolete)] } },
    };
    const plan = await planUpgrade(repo, { history });
    expect(verdictFor(plan, WORKFLOW)).toBe('update');
    const nextManifest = plan.manifest;
    expect(nextManifest.kept?.[WORKFLOW]).toBeUndefined();
    expect(nextManifest.files[WORKFLOW]).toBe(sha256(plan.contents.get(WORKFLOW) ?? ''));

    await applyUpgrade(repo, plan);
    expect(await read(WORKFLOW)).not.toBe(obsolete);
    const onDisk = await readManifest(repo);
    expect(onDisk?.kept?.[WORKFLOW]).toBeUndefined();
  });
});

// RP-180: the workflow layer (queue/loop/pr-ship/run-state/journal/
// revalidation/claim-records/PR-lifecycle helpers) is an opt-in layer.
// `upgrade` must refresh only the layers a rig's manifest recorded — and an
// OLD manifest (written before `layers` existed) recorded no such field
// because every release before RP-180 shipped one payload. Treating that
// absence as "core only" would make the very next upgrade report every
// workflow file a dogfood repo already has as `retired` and stop managing
// it — the exact data-loss direction the acceptance forbids. Both directions
// are pinned here before `upgrade.ts` reads `layers` at all.
describe('upgrade and the opt-in workflow layer (RP-180)', () => {
  const QUEUE_CONFIG = '.claude/queue.json';
  const LOOP_SKILL = '.claude/skills/loop/SKILL.md';

  /** Add the workflow layer's files to `repo` and its manifest, by hand — the
   * shape a pre-RP-180 `create`/`init` left behind, before `layers` existed. */
  async function addWorkflowLayerLikeAPreRp180Install(): Promise<void> {
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    const workflowFiles = await initInstallSet(repo, manifest.project, ['workflow']);
    for (const file of workflowFiles) {
      await write(file.rel, file.content);
      manifest.files[file.rel] = sha256(file.content);
    }
    // The pre-RP-180 shape: no `layers` key at all — simulated by deleting it
    // after `readManifest`/`writeManifest` round-tripped it in (every manifest
    // this rig's own `init` writes now includes one).
    const raw = JSON.parse(await read(MANIFEST_REL)) as Record<string, unknown>;
    delete raw.layers;
    await write(MANIFEST_REL, `${JSON.stringify(raw, null, 2)}\n`);
  }

  it('a freshly installed core-only rig never gains the workflow layer on upgrade', async () => {
    await installRig();
    expect((await readManifest(repo))?.layers).toEqual(['process']);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(plan.actions.find((a) => a.rel === QUEUE_CONFIG)).toBeUndefined();
    expect(plan.actions.find((a) => a.rel === LOOP_SKILL)).toBeUndefined();

    await applyUpgrade(repo, plan);
    await expect(read(QUEUE_CONFIG)).rejects.toThrow();
    expect((await readManifest(repo))?.layers).toEqual(['process']);
  });

  it('a pre-RP-180 manifest with no `layers` field keeps every workflow file it already has', async () => {
    await installRig();
    await addWorkflowLayerLikeAPreRp180Install();
    // the fixture really does reproduce the pre-RP-180 shape
    const raw = JSON.parse(await read(MANIFEST_REL)) as Record<string, unknown>;
    expect(raw.layers).toBeUndefined();

    const dryRunPlan = await planUpgrade(repo, { history: emptyHistory });
    expect(dryRunPlan.actions.find((a) => a.rel === QUEUE_CONFIG)?.verdict).not.toBe('retired');
    expect(dryRunPlan.actions.find((a) => a.rel === LOOP_SKILL)?.verdict).not.toBe('retired');

    await applyUpgrade(repo, dryRunPlan);
    // still on disk — an old dogfood repo's workflow layer survives without
    // being told to opt back in
    expect(await read(QUEUE_CONFIG)).toContain('adapter');
    expect(await read(LOOP_SKILL)).toBeTruthy();
    const manifest = await readManifest(repo);
    expect(manifest?.layers).toEqual(['process', 'workflow']);
    expect(manifest?.files[QUEUE_CONFIG]).toBe(sha256(await read(QUEUE_CONFIG)));
  });

  it('a rig that explicitly recorded `layers: ["process"]` stays core-only across an upgrade even if workflow files are found on disk', async () => {
    await installRig();
    // a file placed by hand, never through `init --layer workflow` — the
    // manifest's own `layers` says this rig never opted in
    await write(QUEUE_CONFIG, '{"adapter":"plan-md"}\n');
    expect((await readManifest(repo))?.layers).toEqual(['process']);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    // not a file this plan's install set even considers — the rig does not
    // manage it, exactly like any other file it never installed
    expect(plan.actions.find((a) => a.rel === QUEUE_CONFIG)).toBeUndefined();
  });
});
