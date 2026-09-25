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
 * Fixtures are built by hand rather than through two `initProject` calls: a
 * real `init` install for every OTHER file, then the manifest's raw JSON is
 * read back and mutated directly — `AGENTS.md` dropped from `files`, a
 * `regions` entry added — and AGENTS.md itself is overwritten with a
 * hand-composed region. The mutation writes the manifest's raw bytes
 * directly rather than going through `writeManifest`/`serializeManifest`,
 * so a fixture never depends on those functions already round-tripping the
 * `regions` field the way `manifest.test.ts` pins independently.
 *
 * Every test below also asserts on the manifest's raw `regions` entry, not
 * only on AGENTS.md's own bytes: an assertion about AGENTS.md's bytes alone
 * can be satisfied by a mechanism that never looked at `regions` at all (an
 * ordinary whole-file `conflict` that simply leaves the file untouched
 * happens to be byte-identical to several of this slice's own desired
 * outcomes — an unedited or edited region nothing was supposed to change
 * this run). The `regions` manifest assertion is the one signal specific to
 * region-awareness in every scenario here, so it is the discriminating
 * assertion in every test in this file; the AGENTS.md byte assertions are
 * kept alongside it because they pin the actually-wanted end state, not
 * because they are independently sufficient on their own.
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
 * The write this describe block pins against is `applyUpgrade`'s write loop
 * for AGENTS.md's region, re-reading the file immediately before the write
 * the way `uninstall.ts`'s OWN region handling already does
 * (`applyUninstall`'s `region === true` branch re-reads the file, re-locates
 * the region and re-checks its hash against `recordedHash` right before
 * acting — see that function's own comment: "the confirmation-prompt window
 * is exactly where a hand edit could land").
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
    // A write from stale plan-time content would silently lose the user's
    // edit; this is the assertion that catches it.
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

/**
 * RP-256 slice 2, round 2 — code-reviewer B1 / security-scanner B1: content
 * the user appends AFTER the end marker's own line — the natural place to
 * add a new section to a file that already has one — is outside the managed
 * region and must survive an upgrade byte-for-byte, exactly like the user's
 * own prefix already does. `locateRegion` (`agents-md-region.ts`) drops
 * everything after the end marker without saying so, and `applyUpgrade`
 * writes `composeRegion(located.userBytes, newBody)` — no suffix parameter —
 * so a suffix is silently discarded on every refresh. Pinned design choice
 * (the coordinator's ruling, not left open): carry the suffix through,
 * never treat it as a conflict.
 */
describe('applyUpgrade — a user suffix appended after the end marker survives a refresh (round 2, B1)', () => {
  const USER_PREFIX = '# Team notes\nKeep this section exactly as it is.\n';
  const OLD_BODY = '# OLD RULEBOOK BODY — a fake stand-in for a previous release\n';
  const SUFFIX = '## Added later by hand\nIMPORTANT-USER-TAIL\n';

  it('carries the suffix through byte-for-byte while refreshing the region', async () => {
    await installThenSimulateRegion(USER_PREFIX, OLD_BODY);
    await writeFile(agentsMdPath(), composeRegion(USER_PREFIX, OLD_BODY, SUFFIX));

    const plan = await planUpgrade(repo);
    await applyUpgrade(repo, plan);

    const newBody = await renderBody(projectNameFor(repo));
    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(composeRegion(USER_PREFIX, newBody, SUFFIX));
    expect(onDisk.endsWith(SUFFIX)).toBe(true);
  });
});
