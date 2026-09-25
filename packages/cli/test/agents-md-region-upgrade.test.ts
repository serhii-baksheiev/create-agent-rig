import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject, projectNameFor } from '../src/commands/init.js';
import { applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import { agentOsUniversalDir } from '../src/templates.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { REGION_BEGIN, composeRegion, sha256 } from '../../../test/helpers/agents-md-region.js';

/**
 * RP-256 slice 2 — `upgrade` splices only the AGENTS.md managed region.
 *
 * These fixtures cannot be built through `initProject` today (a pre-existing
 * AGENTS.md is still refused — see `agents-md-region-init.test.ts`'s header
 * note on the conflict this creates with two existing `init.test.ts` tests),
 * so each one is built by hand: a real `init` install for every OTHER file,
 * then the manifest's raw JSON is read back and mutated directly — `AGENTS.md`
 * dropped from `files`, a `regions` entry added — and AGENTS.md itself is
 * overwritten with a hand-composed region. `writeManifest`/`serializeManifest`
 * are deliberately NOT used for the mutation: today they would silently drop
 * an unknown `regions` field, which is exactly the gap these tests exist to
 * close, so the fixture writes the manifest's raw bytes directly instead.
 *
 * ⚠ Why every test below also asserts on the manifest's raw `regions` entry,
 * not only on AGENTS.md's own bytes: `RigManifest` has no `regions` field
 * today, and `parseManifest`/`planUpgrade` silently drop the fixture's
 * `regions` key the moment they read the manifest — `plan.manifest` (the
 * object `applyUpgrade` serialises back to disk) can never carry one
 * forward. Because of that, an ASSERTION ABOUT AGENTS.md's OWN BYTES ALONE
 * is not always a reliable Red signal here: today's code has no idea a
 * region exists at all, so it treats the whole file as one more path it does
 * not recognise (an ordinary whole-file `conflict`) and simply leaves it
 * untouched — which happens to be byte-identical to several of this slice's
 * own desired outcomes (an unedited or edited region that nothing was
 * supposed to change this run) for reasons that have nothing to do with
 * regions being understood at all. The `regions` manifest assertion is the
 * one signal that is genuinely missing under every scenario today, so it is
 * the discriminating assertion in every test in this file; the AGENTS.md
 * byte assertions are kept alongside it because they pin the actually-wanted
 * end state, not because they are independently sufficient to prove Red.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-agents-region-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');
const agentsMdPath = (): string => path.join(repo, 'AGENTS.md');
const rescuePath = (): string => path.join(repo, 'AGENTS.md.rig-new');

async function renderBody(projectName: string): Promise<string> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'AGENTS.md'), 'utf8');
  return raw.replaceAll('__PROJECT_NAME__', projectName);
}

/**
 * A full, ordinary `init` install, then rewritten in place to look like a
 * region-mode rig: AGENTS.md is `userPrefix` plus a region whose body is
 * `body` — the manifest's raw `regions` entry is set to `sha256(body)`
 * (an unedited region, as far as the manifest is concerned).
 */
async function installThenSimulateRegion(userPrefix: string, body: string): Promise<void> {
  await initProject(repo, {});
  const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
  delete raw.files['AGENTS.md'];
  raw.regions = { 'AGENTS.md': sha256(body) };
  await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(agentsMdPath(), composeRegion(userPrefix, body));
}

describe('planUpgrade / applyUpgrade — AGENTS.md managed region (RP-256 slice 2)', () => {
  const USER_PREFIX = '# Team notes\nKeep this section exactly as it is.\n';
  const OLD_BODY = '# OLD RULEBOOK BODY — a fake stand-in for a previous release\n';

  it('refreshes an unedited region when the payload has changed, preserving the user prefix exactly, and updates the regions hash', async () => {
    await installThenSimulateRegion(USER_PREFIX, OLD_BODY);
    const before = await readFile(agentsMdPath(), 'utf8');

    const plan = await planUpgrade(repo);
    await applyUpgrade(repo, plan);

    const newBody = await renderBody(projectNameFor(repo));
    const expected = composeRegion(USER_PREFIX, newBody);
    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).not.toBe(before); // the payload really did change
    expect(onDisk).toBe(expected);
    expect(onDisk.startsWith(USER_PREFIX)).toBe(true);

    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    expect(raw.regions?.['AGENTS.md']).toBe(sha256(newBody));
  });

  it('leaves an edited region completely untouched — a conflict, never written — and never writes the AGENTS.md.rig-new rescue file for it', async () => {
    await installThenSimulateRegion(USER_PREFIX, OLD_BODY);
    // The user edits INSIDE the region themselves, after the region above
    // was "installed" — so its bytes no longer match what the manifest
    // vouches for.
    const editedBody = `${OLD_BODY}EDITED BY THE USER, INSIDE THE REGION\n`;
    const beforeContent = composeRegion(USER_PREFIX, editedBody);
    await writeFile(agentsMdPath(), beforeContent);

    const plan = await planUpgrade(repo);
    await applyUpgrade(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(beforeContent);

    // The rescue file is a whole-file remedy for a whole-file layout; it has
    // no meaning once AGENTS.md is a mix of user and rig bytes, and its own
    // `mv` remedy would destroy the user's content if followed.
    await expect(access(rescuePath())).rejects.toThrow();

    // The discriminating assertion: the manifest must still know a region is
    // tracked here — an edited region is a conflict, not something the rig
    // forgets about entirely.
    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    expect(raw.regions?.['AGENTS.md']).toBeDefined();
  });

  it('an already-current, unedited region is left alone, and its regions entry survives the upgrade untouched', async () => {
    const currentBody = await renderBody(projectNameFor(repo));
    await installThenSimulateRegion(USER_PREFIX, currentBody);
    const before = await readFile(agentsMdPath(), 'utf8');

    const plan = await planUpgrade(repo);
    await applyUpgrade(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(before);

    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    expect(raw.regions?.['AGENTS.md']).toBe(sha256(currentBody));
  });
});

/**
 * Owner design requirement (RP-256 comment 20585): "upgrade splices only the
 * region, re-verified at apply time." `planAgentsMdRegion` (`upgrade.ts`)
 * decides the region's verdict and bakes the WHOLE FILE's new content —
 * including the user's prefix, read ONCE at plan time — into `plan.contents`.
 * `applyUpgrade`'s write loop then writes that plan-time content unconditionally
 * for every `update` verdict, AGENTS.md's region included, with no re-read of
 * the file immediately before the write the way `uninstall.ts`'s OWN region
 * handling already does (`applyUninstall`'s `region === true` branch re-reads
 * the file, re-locates the region and re-checks its hash against
 * `recordedHash` right before acting — see that function's own comment: "the
 * confirmation-prompt window is exactly where a hand edit could land"). That
 * gap is what this describe block is red for.
 *
 * Vocabulary pinned here, not invented: `ApplyUninstallResult` already has
 * exactly this concept, named `changedSincePlanning?: string[]` — "one
 * mechanism, one implementation... one spelling of a fact" (`invariants.md`)
 * says `UpgradeResult` should gain the SAME field, not a differently-spelled
 * one, for the same kind of fact. `UpgradeResult` has no such field today
 * (only `written`/`removedRescue`), so every access below goes through
 * `unknown` plus a narrow cast — never `any` — exactly like `agents-md-region-
 * init.test.ts`'s `readRawManifest` does for the same reason.
 */
describe('applyUpgrade — AGENTS.md region re-verified at apply time (data-loss guard, owner design)', () => {
  const USER_PREFIX = '# Team notes\nKeep this section exactly as it is.\n';
  const OLD_BODY = '# OLD RULEBOOK BODY — a fake stand-in for a previous release\n';

  it('(a) a concurrent edit OUTSIDE the region, between plan and apply, survives: the region refreshes onto the CURRENT prefix, not the stale plan-time one', async () => {
    await installThenSimulateRegion(USER_PREFIX, OLD_BODY);
    const plan = await planUpgrade(repo);

    // The confirmation-prompt window: the user edits their OWN prefix after
    // planning but before applying. The region body itself is untouched, so
    // its hash still matches what the plan (and the manifest) vouch for —
    // the preferred outcome (owner's ruling) is to refresh onto this CURRENT
    // prefix, not to silently keep the one read at plan time.
    const editedPrefix = `${USER_PREFIX}ANOTHER LINE, ADDED AFTER PLANNING\n`;
    await writeFile(agentsMdPath(), composeRegion(editedPrefix, OLD_BODY));

    await applyUpgrade(repo, plan);

    const newBody = await renderBody(projectNameFor(repo));
    const onDisk = await readFile(agentsMdPath(), 'utf8');
    // Today's implementation writes the plan-time content — the user's edit
    // is silently lost, and this is the assertion that shows it.
    expect(onDisk).toBe(composeRegion(editedPrefix, newBody));
  });

  it('(b) a concurrent edit INSIDE the region, between plan and apply, is never overwritten — nothing is written, and the result reports it changed since planning', async () => {
    await installThenSimulateRegion(USER_PREFIX, OLD_BODY);
    const plan = await planUpgrade(repo);

    const editedBody = `${OLD_BODY}EDITED BY THE USER, INSIDE THE REGION, AFTER PLANNING\n`;
    const beforeApply = composeRegion(USER_PREFIX, editedBody);
    await writeFile(agentsMdPath(), beforeApply);

    const result = await applyUpgrade(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(beforeApply);
    const changedSincePlanning =
      (result as unknown as { changedSincePlanning?: string[] }).changedSincePlanning ?? [];
    expect(changedSincePlanning).toContain('AGENTS.md');
  });

  it('(c) the end marker deleted between plan and apply — a malformed region at apply time — is never overwritten, and the result reports it changed since planning', async () => {
    await installThenSimulateRegion(USER_PREFIX, OLD_BODY);
    const plan = await planUpgrade(repo);

    // The end marker is gone: `locateRegion` (production's own bytes-only
    // matcher) can no longer find a well-formed region here at all.
    const malformed = `${USER_PREFIX}\n${REGION_BEGIN}\n${OLD_BODY}`;
    await writeFile(agentsMdPath(), malformed);

    const result = await applyUpgrade(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(malformed);
    const changedSincePlanning =
      (result as unknown as { changedSincePlanning?: string[] }).changedSincePlanning ?? [];
    expect(changedSincePlanning).toContain('AGENTS.md');
  });
});
