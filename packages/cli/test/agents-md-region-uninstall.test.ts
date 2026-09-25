import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject, projectNameFor } from '../src/commands/init.js';
import { applyUninstall, planUninstall } from '../src/commands/uninstall.js';
import { agentOsUniversalDir } from '../src/templates.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import {
  REGION_BEGIN,
  REGION_END,
  composeRegion,
  sha256,
} from '../../../test/helpers/agents-md-region.js';

/**
 * RP-256 slice 2 — `uninstall` strips only the managed region and leaves the
 * user's original AGENTS.md bytes exactly as they were before `init` ever
 * ran.
 *
 * The fixture is built by hand exactly the way `agents-md-region-upgrade.
 * test.ts` builds its own: a real `init` install for every other file, then
 * AGENTS.md and the manifest's raw JSON are rewritten directly to look like
 * an unedited region-mode rig.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-agents-region-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');
const agentsMdPath = (): string => path.join(repo, 'AGENTS.md');

async function renderBody(projectName: string): Promise<string> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'AGENTS.md'), 'utf8');
  return raw.replaceAll('__PROJECT_NAME__', projectName);
}

/**
 * A full, ordinary `init` install, then rewritten in place to look like an
 * unedited region-mode rig: AGENTS.md is `userPrefix` plus a region whose
 * body is this release's real current rendering, and the manifest's raw
 * `regions` entry vouches for exactly that body.
 */
async function installThenSimulateRegion(userPrefix: string): Promise<void> {
  await initProject(repo, {});
  const body = await renderBody(projectNameFor(repo));
  const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
  delete raw.files['AGENTS.md'];
  raw.regions = { 'AGENTS.md': sha256(body) };
  await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(agentsMdPath(), composeRegion(userPrefix, body));
}

describe('planUninstall / applyUninstall — AGENTS.md managed region (RP-256 slice 2)', () => {
  it('produces an action for a region-tracked AGENTS.md, rather than silently ignoring it', async () => {
    await installThenSimulateRegion('# team notes\n');

    const plan = await planUninstall(repo);

    expect(plan.actions.some((a) => a.rel === 'AGENTS.md')).toBe(true);
  });

  it('strips exactly the region and leaves the user prefix byte-identical when the prefix has no trailing newline', async () => {
    const userPrefix = '# team notes, no trailing newline';
    await installThenSimulateRegion(userPrefix);

    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(userPrefix);
  });

  it('strips exactly the region and leaves the user prefix byte-identical when the prefix uses CRLF line endings', async () => {
    const userPrefix = '# team notes\r\nCRLF throughout\r\n';
    await installThenSimulateRegion(userPrefix);

    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(userPrefix);
  });

  it('strips exactly the region and leaves the user prefix byte-identical when the prefix already ends in a newline', async () => {
    const userPrefix = '# team notes\nAlready ends in a newline.\n';
    await installThenSimulateRegion(userPrefix);

    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(userPrefix);
  });
});

/**
 * The slice-1 precedent this mirrors:
 * `packages/cli/test/uninstall.test.ts`'s describe block "planUninstall — a
 * nested rig preserves the kept CLAUDE.md, without a false pair note
 * (RP-256 slice 1)", test "emits no \"only rulebook copy\" pair note for the
 * kept user CLAUDE.md when AGENTS.md is removed". There, BOTH the nested
 * shim and AGENTS.md get an ordinary `verdict: 'remove'`, and both really
 * are fully deleted — so suppressing the pairing note is correct: nothing
 * false is being said by staying silent.
 *
 * Here, AGENTS.md's `verdict: 'remove'` means STRIP THE REGION, not delete
 * the file — `uninstall.ts`'s own per-file loop marks it `region: true` for
 * exactly this reason. `notACleanRemoval` (the function that decides whether
 * the pairing note fires) does not know about that distinction: it treats
 * ANY `'remove'` verdict as a clean one, so removing the nested shim in the
 * SAME run as stripping AGENTS.md's region stays silent — even though
 * afterwards neither file carries a readable rulebook (the shim, the only
 * thing that imported AGENTS.md, is gone; AGENTS.md itself keeps existing,
 * with only the user's own prefix, region stripped). The note the coordinator
 * asked to pin: it must not claim AGENTS.md was cleanly removed (the file
 * survives) and must not claim it still holds the rulebook (the region does
 * not survive) — both of which the CURRENT silence effectively implies by
 * saying nothing at all.
 */
describe('planUninstall — a nested rig with a region-tracked AGENTS.md, without a false pair note (RP-256 slice 2)', () => {
  const NESTED_CLAUDE = '.claude/CLAUDE.md';

  async function installNestedRigWithRegion(userClaude: string, userPrefix: string): Promise<void> {
    await initProject(repo, {});
    const body = await renderBody(projectNameFor(repo));
    const shimBytes = await readFile(path.join(agentOsUniversalDir(), NESTED_CLAUDE), 'utf8');
    await writeFile(path.join(repo, '.claude', 'CLAUDE.md'), shimBytes);
    await writeFile(path.join(repo, 'CLAUDE.md'), userClaude);
    await writeFile(agentsMdPath(), composeRegion(userPrefix, body));

    const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
    delete raw.files['CLAUDE.md'];
    raw.files[NESTED_CLAUDE] = sha256(shimBytes);
    raw.kept = { ...raw.kept, 'CLAUDE.md': sha256(userClaude) };
    delete raw.files['AGENTS.md'];
    raw.regions = { 'AGENTS.md': sha256(body) };
    await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
  }

  it('does not claim AGENTS.md was cleanly removed, or that it still holds the rulebook, once the nested shim is removed too', async () => {
    await installNestedRigWithRegion('# host rules\n', '# team notes\n');

    const plan = await planUninstall(repo);

    const claudeAction = plan.actions.find((a) => a.rel === NESTED_CLAUDE);
    const agentsAction = plan.actions.find((a) => a.rel === 'AGENTS.md');
    expect(claudeAction?.verdict).toBe('remove');
    expect(agentsAction?.verdict).toBe('remove');

    // The discriminating assertion: `notACleanRemoval` reads a `'remove'`
    // verdict as always clean — so with BOTH the shim and the region-strip
    // marked `remove`, no note fires on either side, even though afterwards
    // neither file carries a readable rulebook.
    const note = claudeAction?.note ?? agentsAction?.note;
    expect(
      note,
      'expected a pairing note once removing the shim leaves no readable rulebook anywhere',
    ).toBeTruthy();
    // The two false claims the coordinator named: AGENTS.md is not "already
    // gone" (the file survives, region stripped) and does not "exist and is
    // yours" in the sense that phrase carries elsewhere (untouched, still
    // holding whatever it always held) — the region, i.e. the rulebook, is
    // gone from it too.
    expect(note).not.toMatch(/AGENTS\.md,? which is already gone/);
    expect(note).not.toMatch(/AGENTS\.md,? which exists and is yours/);
  });
});

/**
 * RP-256 slice 2, round 2 — code-reviewer B1 / security-scanner B1:
 * `locateRegion` drops everything after the end marker without saying so,
 * and `uninstall.ts` writes back `located.userBytes` alone — so content the
 * user appended below the region (the natural place to add a new section to
 * a file that already has one) is silently discarded on every uninstall.
 * Pinned design choice (the coordinator's ruling): keep the suffix — the
 * final file is the prefix followed directly by the suffix, with the region
 * gone and nothing else inserted between them.
 */
describe('applyUninstall — a user suffix appended after the end marker survives the strip (round 2, B1)', () => {
  it('keeps the suffix: prefix + suffix restored exactly, with no region left behind', async () => {
    const userPrefix = '# My project rules\nkeep me\n';
    const suffix = '## Added later by hand\nIMPORTANT-USER-TAIL\n';
    await installThenSimulateRegion(userPrefix);
    const withSuffix = `${await readFile(agentsMdPath(), 'utf8')}${suffix}`;
    await writeFile(agentsMdPath(), withSuffix);

    const plan = await planUninstall(repo);
    await applyUninstall(repo, plan);

    const onDisk = await readFile(agentsMdPath(), 'utf8');
    expect(onDisk).toBe(`${userPrefix}${suffix}`);
    expect(onDisk).not.toContain(REGION_BEGIN);
    expect(onDisk).not.toContain(REGION_END);
  });
});
