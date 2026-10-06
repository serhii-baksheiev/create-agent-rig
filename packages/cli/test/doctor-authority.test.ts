import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { initProject } from '../src/commands/init.js';
import type { ProviderProcessResult } from '../src/integrations/spawn.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

// RP-343 slice B: doctor --json gains a top-level `authority` object reporting
// execution mode, decision authority, publication authority, whether the
// safety gates (hook wiring + guard integrity) are enforced, and the kill
// switch's own wired/armed state. The first four fields are exactly
// `authorityPosture(...)` from `.claude/scripts/lib/authority.mjs` — asserted
// here against hand-written literals, never by calling production's own
// `authorityPosture`, so this test cannot be satisfied merely by production
// checking its own work (`.claude/rules/invariants.md`, "the independent-oracle
// invariant").
//
// Fixtures plant the unattended flag and the run directory's `state.json` by
// hand, the same way `doctor-unattended.test.ts` hand-writes the kill-switch
// brake file, rather than by calling `writeUnattended` — `writeUnattended`
// mirrors into BOTH `env.HOME` and the real OS home
// (`unattended-flag.mjs`'s `homesOf`), and this file must never read or write
// the real `~/.claude`. Writing only to the `env.HOME`-derived path, under
// this test's own fixture `home`, never touches the real one.
//
// RP-343 slice B round 1 (independent-oracle invariant,
// `.claude/rules/invariants.md`): the flag path is no longer derived by
// importing the GENERATOR's own unsubstituted template copy of
// `unattended-flag.mjs` (whose basename is the literal, never-substituted
// `__PROJECT_NAME__-loop-UNATTENDED`, and whose `checkoutId` this file used
// to scope with the very same `env.CLAUDE_PROJECT_DIR` the production code
// under test also reads) — doing so made this fixture agree with production's
// bug by construction. `checkoutIdFor`/`plantedFlagPath` below are a
// deliberately separate, hand-written reimplementation of that module's own
// `checkoutId`/`scopedBasename` derivation, and the project name comes from
// the INSTALLED rig's own manifest, never from the template.

const passingGuardRunner = async (): Promise<ProviderProcessResult> => ({
  status: 'ok',
  exitCode: 0,
  stdout: '',
  stderr: '',
});

type Condition = { id: string; classification: string; outcome: string; status: string };
type Authority = {
  schemaVersion: number;
  executionMode: string;
  decisionAuthority: string;
  publicationAuthority: string;
  safetyGates: string;
  killSwitch: { wired: string; armed: string };
};
type Report = {
  status: string;
  unattended?: { status: string; conditions: Condition[] };
  authority?: Authority;
};

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-authority-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-doctor-authority-home-'));
});

afterEach(async () => {
  // Everything this file plants lives under `home` or `repo` — see the header
  // above for why `writeUnattended` itself is never called — so removing
  // these two fixture roots is the whole of cleanup.
  await removeFixture(repo);
  await removeFixture(home);
});

function authorityEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    APPDATA: home,
    CLAUDE_PROJECT_DIR: repo,
    PATH: process.env.PATH ?? '',
    ...extra,
  };
}

/**
 * Deliberately a second copy of the installed `unattended-flag.mjs`'s own
 * `checkoutId` — `sha256(realpath-or-resolve(checkout)).hex().slice(0, 16)`
 * — rather than an import of production's own function, so this fixture's
 * expected flag path can never be satisfied merely by asking production (or
 * its template copy) what path it would compute
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant").
 */
function checkoutIdFor(dir: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(dir);
  } catch {
    canonical = path.resolve(dir);
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * The real, substituted flag name the INSTALLED rig at `repo` computes for
 * itself — `<project>-<checkoutId>-loop-UNATTENDED` — never the generator's
 * own unsubstituted template copy (`__PROJECT_NAME__-loop-UNATTENDED`),
 * which is the RP-343 slice B round 1 bug this file pins. `project` always
 * comes from the INSPECTED repo's (`repo`) own manifest; `forRepo` is the
 * directory whose checkout identity is hashed — `repo` for every ordinary
 * case, and a different directory only for the scoping tests below.
 */
async function plantedFlagPath(forRepo: string = repo): Promise<string> {
  const project = await projectName();
  const id = checkoutIdFor(forRepo);
  return path.join(home, '.claude', `${project}-${id}-loop-UNATTENDED`);
}

/** Writes `body` straight to the real-name candidate path — never the real home. */
async function plantUnattendedFlag(body: string, forRepo: string = repo): Promise<string> {
  const flagPath = await plantedFlagPath(forRepo);
  await mkdir(path.dirname(flagPath), { recursive: true });
  await writeFile(flagPath, body);
  return flagPath;
}

/** A fresh run directory under this fixture's own `home`, with an optional hand-written state.json. */
async function makeRunDir(stateBody?: string): Promise<string> {
  const runDir = await mkdtemp(path.join(home, 'run-'));
  if (stateBody !== undefined) {
    await writeFile(path.join(runDir, 'state.json'), stateBody);
  }
  return runDir;
}

const flagBody = (runDir: string): string =>
  `${JSON.stringify({ item: 'rp343b-fixture', runDir, allow: [] })}\n`;

async function doctorJson(
  envExtra: NodeJS.ProcessEnv = {},
): Promise<Report & { exitCode: number }> {
  const result = await runDoctor({
    cwd: repo,
    args: ['--json'],
    env: authorityEnv(envExtra),
    guardRunner: passingGuardRunner,
  });
  return { ...(JSON.parse(result.stdout) as Report), exitCode: result.exitCode };
}

async function doctorText(envExtra: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await runDoctor({
    cwd: repo,
    args: [],
    env: authorityEnv(envExtra),
    guardRunner: passingGuardRunner,
  });
  return result.stdout;
}

const condition = (body: Report, id: string): Condition | undefined =>
  body.unattended?.conditions.find((c) => c.id === id);

async function stripHookWiring(): Promise<void> {
  const settingsPath = path.join(repo, '.claude', 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    hooks: { PreToolUse: unknown[] };
  };
  settings.hooks.PreToolUse = [];
  await writeFile(settingsPath, JSON.stringify(settings));
}

async function projectName(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
  ) as { project: { name: string } };
  return manifest.project.name;
}

/** A recursive, order-independent fingerprint of every file under `root`. */
async function snapshotTree(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update(await readFile(path.join(root, relative)));
  }
  return `${files.length} files / ${hash.digest('hex')}`;
}

describe('the planted flag path is the one the installed rig itself writes/reads (RP-343 slice B round 1, independent oracle)', () => {
  it('readUnattended, read through the INSTALLED copy of unattended-flag.mjs inside the fixture repo, reports on:true for the path this file plants', async () => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await makeRunDir(JSON.stringify({ decisionAuthority: 'delegated' }));
    await plantUnattendedFlag(flagBody(runDir));

    const installedModulePath = path.join(repo, '.claude', 'scripts', 'unattended-flag.mjs');
    const { readUnattended } = (await import(pathToFileURL(installedModulePath).href)) as {
      readUnattended: (env: NodeJS.ProcessEnv) => { on: boolean; unreadable?: true };
    };
    const state = readUnattended({ ...authorityEnv(), CLAUDE_PROJECT_DIR: repo });
    expect(state.on).toBe(true);
    expect(state.unreadable).not.toBe(true);
  });
});

describe('doctor --json gains a top-level authority object (RP-343 slice B)', () => {
  it('reports exactly schemaVersion, executionMode, decisionAuthority, publicationAuthority, safetyGates, killSwitch, in that order', async () => {
    await initProject(repo, { withWorkflow: true });
    const body = await doctorJson();
    expect(Object.keys(body.authority ?? {})).toEqual([
      'schemaVersion',
      'executionMode',
      'decisionAuthority',
      'publicationAuthority',
      'safetyGates',
      'killSwitch',
    ]);
  });

  it('builds the first four fields exactly as authorityPosture({}) would, on a rig with no armed flag', async () => {
    await initProject(repo, { withWorkflow: true });
    const body = await doctorJson();
    expect(body.authority).toMatchObject({
      schemaVersion: 1,
      executionMode: 'unknown',
      decisionAuthority: 'owner',
      publicationAuthority: 'owner',
    });
  });
});

describe('authority.executionMode (RP-343 slice B)', () => {
  it('is unknown when no unattended flag is armed for this checkout — absence says nothing about who is watching', async () => {
    await initProject(repo, { withWorkflow: true });
    expect((await doctorJson()).authority?.executionMode).toBe('unknown');
  });

  it('is unattended when an unattended flag for this checkout is armed and readable', async () => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await makeRunDir(JSON.stringify({ decisionAuthority: 'owner' }));
    await plantUnattendedFlag(flagBody(runDir));
    expect((await doctorJson()).authority?.executionMode).toBe('unattended');
  });

  it('is unknown, never attended, when the armed flag is present but unreadable (corrupt JSON)', async () => {
    await initProject(repo, { withWorkflow: true });
    await plantUnattendedFlag('{ not json');
    const authority = (await doctorJson()).authority;
    expect(authority?.executionMode).toBe('unknown');
    expect(authority?.executionMode).not.toBe('attended');
  });
});

describe('authority.decisionAuthority (RP-343 slice B)', () => {
  it('is owner when no unattended flag is armed — no run declared any authority', async () => {
    await initProject(repo, { withWorkflow: true });
    expect((await doctorJson()).authority?.decisionAuthority).toBe('owner');
  });

  it.each([
    ['delegated', 'delegated'],
    ['owner', 'owner'],
  ])('reads %s from the armed flag’s run directory state.json', async (stored, expected) => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await makeRunDir(JSON.stringify({ decisionAuthority: stored }));
    await plantUnattendedFlag(flagBody(runDir));
    expect((await doctorJson()).authority?.decisionAuthority).toBe(expected);
  });

  it('defaults to owner when state.json carries no decisionAuthority field at all — the contract default', async () => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await makeRunDir(JSON.stringify({ escalations: 0 }));
    await plantUnattendedFlag(flagBody(runDir));
    expect((await doctorJson()).authority?.decisionAuthority).toBe('owner');
  });

  it('is unknown when the armed flag’s run directory has no state.json at all', async () => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await mkdtemp(path.join(home, 'run-'));
    await plantUnattendedFlag(flagBody(runDir));
    expect((await doctorJson()).authority?.decisionAuthority).toBe('unknown');
  });

  it('is unknown when state.json is present but unreadable (corrupt JSON)', async () => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await makeRunDir('{ not json');
    await plantUnattendedFlag(flagBody(runDir));
    expect((await doctorJson()).authority?.decisionAuthority).toBe('unknown');
  });

  it.each(['Delegated', 'yes'])(
    'is unknown, never delegated, when state.json spells decisionAuthority as "%s"',
    async (stored) => {
      await initProject(repo, { withWorkflow: true });
      const runDir = await makeRunDir(JSON.stringify({ decisionAuthority: stored }));
      await plantUnattendedFlag(flagBody(runDir));
      const authority = (await doctorJson()).authority;
      expect(authority?.decisionAuthority).toBe('unknown');
      expect(authority?.decisionAuthority).not.toBe('delegated');
    },
  );

  // RP-343 slice B round 1: an armed flag that cannot be read at all is a
  // run that tried to declare something, not a run that declared nothing —
  // it must never collapse to the same `owner` default an entirely absent
  // flag reports.
  it('is unknown, never owner, when the armed flag itself is unreadable (corrupt JSON) — not just when its run directory’s state.json is', async () => {
    await initProject(repo, { withWorkflow: true });
    await plantUnattendedFlag('{ not json');
    const authority = (await doctorJson()).authority;
    expect(authority?.decisionAuthority).toBe('unknown');
    expect(authority?.decisionAuthority).not.toBe('owner');
  });

  // RP-343 slice B round 1: `runDir` is resolved as a root passed straight
  // to a bounded file read — a relative value must never be resolved
  // against whatever directory the doctor process happens to be running
  // from.
  it('is unknown when the armed flag’s runDir is a relative path — never resolved against the doctor’s own cwd', async () => {
    await initProject(repo, { withWorkflow: true });
    await plantUnattendedFlag(
      `${JSON.stringify({ item: 'rp343b-fixture', runDir: 'runs/x', allow: [] })}\n`,
    );
    expect((await doctorJson()).authority?.decisionAuthority).toBe('unknown');
  });

  // RP-343 slice B round 1: a flag with no `runDir` field at all names no
  // run to read authority from — this must read the same as a flag whose
  // run directory carries no state.json, not as the no-flag-armed default.
  it('is unknown when the armed flag carries no runDir field at all', async () => {
    await initProject(repo, { withWorkflow: true });
    await plantUnattendedFlag(`${JSON.stringify({ item: 'rp343b-fixture', allow: [] })}\n`);
    expect((await doctorJson()).authority?.decisionAuthority).toBe('unknown');
  });
});

describe('authority.publicationAuthority (RP-343 slice B)', () => {
  it('is always owner, even when a planted state.json claims publicationAuthority: delegated', async () => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await makeRunDir(
      JSON.stringify({ decisionAuthority: 'delegated', publicationAuthority: 'delegated' }),
    );
    await plantUnattendedFlag(flagBody(runDir));
    expect((await doctorJson()).authority?.publicationAuthority).toBe('owner');
  });
});

describe('authority.safetyGates (RP-343 slice B)', () => {
  it('is enforced on a clean init, consistent with hook-wiring-missing and guard-integrity-failed both passing', async () => {
    await initProject(repo, { withWorkflow: true });
    const body = await doctorJson();
    expect(condition(body, 'hook-wiring-missing')?.outcome).toBe('pass');
    expect(condition(body, 'guard-integrity-failed')?.outcome).toBe('pass');
    expect(body.authority?.safetyGates).toBe('enforced');
  });

  it('is not-enforced when a hook is stripped from .claude/settings.json, consistent with hook-wiring-missing failing', async () => {
    await initProject(repo, { withWorkflow: true });
    await stripHookWiring();
    const body = await doctorJson();
    expect(condition(body, 'hook-wiring-missing')?.outcome).toBe('fail');
    expect(body.authority?.safetyGates).toBe('not-enforced');
  });

  it('is unknown when there is no rig manifest to run the guard inspection against at all', async () => {
    const body = await doctorJson();
    expect(condition(body, 'hook-wiring-missing')?.outcome).toBe('unknown');
    expect(condition(body, 'guard-integrity-failed')?.outcome).toBe('unknown');
    expect(body.authority?.safetyGates).toBe('unknown');
  });
});

describe('authority.killSwitch (RP-343 slice B)', () => {
  it('reports wired yes and armed no on a clean, un-stopped init', async () => {
    await initProject(repo, { withWorkflow: true });
    const body = await doctorJson();
    expect(body.authority?.killSwitch).toEqual({ wired: 'yes', armed: 'no' });
  });

  it('reports wired no when hook-wiring fails', async () => {
    await initProject(repo, { withWorkflow: true });
    await stripHookWiring();
    expect((await doctorJson()).authority?.killSwitch.wired).toBe('no');
  });

  it('reports armed yes when the project loop-STOP brake file is present', async () => {
    await initProject(repo, { withWorkflow: true });
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', `${await projectName()}-loop-STOP`), '');
    expect((await doctorJson()).authority?.killSwitch.armed).toBe('yes');
  });

  it('reports wired unknown and armed unknown when there is no rig manifest at all', async () => {
    const body = await doctorJson();
    expect(body.authority?.killSwitch).toEqual({ wired: 'unknown', armed: 'unknown' });
  });

  // Round 2 (code-reviewer): without a manifest there is no project name to
  // find this checkout's flag by, so neither mode can be measured — unknown,
  // never the owner default a measured "no armed run" would give.
  it('reports execution mode and decision authority unknown when there is no rig manifest to name the flag', async () => {
    const body = await doctorJson();
    expect(body.authority?.executionMode).toBe('unknown');
    expect(body.authority?.decisionAuthority).toBe('unknown');
  });
});

describe('authority flag scoping is the inspected repo, not CLAUDE_PROJECT_DIR (RP-343 slice B round 1)', () => {
  it('finds the flag armed for the inspected repo even when CLAUDE_PROJECT_DIR names a different directory', async () => {
    await initProject(repo, { withWorkflow: true });
    const otherDir = await mkdtemp(path.join(tmpdir(), 'caf-doctor-authority-other-'));
    try {
      const runDir = await makeRunDir(JSON.stringify({ decisionAuthority: 'delegated' }));
      await plantUnattendedFlag(flagBody(runDir));
      const body = await doctorJson({ CLAUDE_PROJECT_DIR: otherDir });
      expect(body.authority?.executionMode).toBe('unattended');
      expect(body.authority?.decisionAuthority).toBe('delegated');
    } finally {
      await removeFixture(otherDir);
    }
  });

  it('reports unknown/owner when the only armed flag is scoped to a different directory than the inspected repo', async () => {
    await initProject(repo, { withWorkflow: true });
    const otherDir = await mkdtemp(path.join(tmpdir(), 'caf-doctor-authority-other-'));
    try {
      const runDir = await makeRunDir(JSON.stringify({ decisionAuthority: 'delegated' }));
      await plantUnattendedFlag(flagBody(runDir), otherDir);
      const body = await doctorJson();
      expect(body.authority?.executionMode).toBe('unknown');
      expect(body.authority?.decisionAuthority).toBe('owner');
    } finally {
      await removeFixture(otherDir);
    }
  });
});

describe('doctor text output carries the authority lines, each once, after unattended readiness (RP-343 slice B)', () => {
  it('prints execution mode, decision authority, publication authority, safety gates and kill switch', async () => {
    await initProject(repo, { withWorkflow: true });
    const stdout = await doctorText();
    const lines = stdout.split('\n');
    const unattendedIndex = lines.findIndex((line) => line.startsWith('unattended readiness:'));
    expect(unattendedIndex).toBeGreaterThan(-1);

    const expectedLines = [
      'authority: execution mode: unknown',
      'authority: decision authority: owner',
      'authority: publication authority: owner',
      'authority: safety gates: enforced',
      'authority: kill switch: wired yes, armed no',
    ];
    for (const needle of expectedLines) {
      const matches = lines.filter((line) => line.trim() === needle);
      expect(matches, `expected exactly one "${needle}"`).toHaveLength(1);
      expect(
        lines.indexOf(needle),
        `"${needle}" must come after unattended readiness`,
      ).toBeGreaterThan(unattendedIndex);
    }
  });
});

describe('doctor with the new authority section is purely observational (RP-343 slice B)', () => {
  it('writes nothing to the repository or the fixture home', async () => {
    await initProject(repo, { withWorkflow: true });
    const runDir = await makeRunDir(JSON.stringify({ decisionAuthority: 'delegated' }));
    await plantUnattendedFlag(flagBody(runDir));

    const repoBefore = await snapshotTree(repo);
    const homeBefore = await snapshotTree(home);
    await doctorJson();
    const repoAfter = await snapshotTree(repo);
    const homeAfter = await snapshotTree(home);

    expect(repoAfter).toBe(repoBefore);
    expect(homeAfter).toBe(homeBefore);
  });
});

describe('the authority section changes nothing else about the doctor run (RP-343 slice B)', () => {
  it('delegation never changes the exit code or any other field: owner and delegated state.json on otherwise-identical fixtures agree on everything but authority', async () => {
    await initProject(repo, { withWorkflow: true });

    const ownerRunDir = await makeRunDir(JSON.stringify({ decisionAuthority: 'owner' }));
    await plantUnattendedFlag(flagBody(ownerRunDir));
    const ownerResult = await doctorJson();

    const delegatedRunDir = await makeRunDir(JSON.stringify({ decisionAuthority: 'delegated' }));
    await plantUnattendedFlag(flagBody(delegatedRunDir));
    const delegatedResult = await doctorJson();

    expect(delegatedResult.exitCode).toBe(ownerResult.exitCode);
    expect(delegatedResult.status).toBe(ownerResult.status);

    const { authority: ownerAuthority, ...ownerRest } = ownerResult;
    const { authority: delegatedAuthority, ...delegatedRest } = delegatedResult;
    expect(delegatedRest).toEqual(ownerRest);
    expect(ownerAuthority?.decisionAuthority).toBe('owner');
    expect(delegatedAuthority?.decisionAuthority).toBe('delegated');
  });
});
