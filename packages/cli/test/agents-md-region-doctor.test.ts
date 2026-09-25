import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { initProject, projectNameFor } from '../src/commands/init.js';
import { agentOsUniversalDir } from '../src/templates.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { composeRegion, sha256 } from '../../../test/helpers/agents-md-region.js';
import type { ProviderProcessResult } from '../src/integrations/spawn.js';

/**
 * RP-256 slice 2 — `doctor` judges the AGENTS.md managed region: an intact
 * region reports healthy, and a missing or edited one is a finding.
 *
 * Pinned choice (the ticket asks only for "the minimal observable signal",
 * left the exact shape to this suite): a check, `id: 'rig-managed-regions'`,
 * `status: 'ok'` when the region on disk matches what the manifest's
 * `regions` entry vouches for, `'warn'` otherwise (missing entirely, or
 * edited) — mirroring `rig-owned-files`'s own pass/warn split for the same
 * kind of evidence.
 *
 * The same by-hand fixture construction as the other slice-2 suites (see
 * `agents-md-region-upgrade.test.ts`'s header note): a real `init` install
 * for every other file, then AGENTS.md and the manifest's raw JSON
 * rewritten directly.
 */

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-agents-region-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-doctor-agents-region-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

const passingGuardRunner = async (): Promise<ProviderProcessResult> => ({
  status: 'ok',
  exitCode: 0,
  stdout: '',
  stderr: '',
});

async function doctor(): Promise<{
  checks: Array<{ id: string; status: string; reason?: string }>;
}> {
  const result = await runDoctor({
    cwd: repo,
    args: ['--json'],
    env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
    guardRunner: passingGuardRunner,
  });
  return JSON.parse(result.stdout) as {
    checks: Array<{ id: string; status: string; reason?: string }>;
  };
}

const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');
const agentsMdPath = (): string => path.join(repo, 'AGENTS.md');

async function renderBody(projectName: string): Promise<string> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'AGENTS.md'), 'utf8');
  return raw.replaceAll('__PROJECT_NAME__', projectName);
}

async function installThenSimulateRegion(
  userPrefix: string,
  body: string,
  trackedBody: string = body,
): Promise<void> {
  await initProject(repo, {});
  const raw = JSON.parse(await readFile(manifestPath(), 'utf8'));
  delete raw.files['AGENTS.md'];
  raw.regions = { 'AGENTS.md': sha256(trackedBody) };
  await writeFile(manifestPath(), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(agentsMdPath(), composeRegion(userPrefix, body));
}

describe('doctor — AGENTS.md managed region (RP-256 slice 2)', () => {
  it('reports the managed region healthy when it is intact and unedited', async () => {
    const body = await renderBody(projectNameFor(repo));
    await installThenSimulateRegion('# team notes\n', body);

    const report = await doctor();

    const check = report.checks.find((c) => c.id === 'rig-managed-regions');
    expect(check, JSON.stringify(report.checks)).toBeDefined();
    expect(check?.status).toBe('ok');
  });

  it('reports a finding when the region has been edited since it was installed', async () => {
    const body = await renderBody(projectNameFor(repo));
    const editedBody = `${body}EDITED BY THE USER\n`;
    // manifest vouches for the UNEDITED body; disk carries the edited one
    await installThenSimulateRegion('# team notes\n', editedBody, body);

    const report = await doctor();

    const check = report.checks.find((c) => c.id === 'rig-managed-regions');
    expect(check, JSON.stringify(report.checks)).toBeDefined();
    expect(check?.status).not.toBe('ok');
  });

  it('reports a finding when the region is missing entirely (the markers are gone)', async () => {
    const body = await renderBody(projectNameFor(repo));
    await installThenSimulateRegion('# team notes\n', body);
    // Now strip the region back out by hand, leaving only the user prefix —
    // the manifest still vouches for a region that is no longer there.
    await writeFile(agentsMdPath(), '# team notes\n');

    const report = await doctor();

    const check = report.checks.find((c) => c.id === 'rig-managed-regions');
    expect(check, JSON.stringify(report.checks)).toBeDefined();
    expect(check?.status).not.toBe('ok');
  });
});

/**
 * RP-256 slice 2, round 2, item 1 — decision, stated: content the user
 * appends AFTER the end marker is outside the managed region, exactly like
 * their prefix. `doctor`'s own check (`doctor.ts`) only ever hashes
 * `locateRegion(...).body` against the manifest's recorded hash — it never
 * looks at anything past the end marker — so a region whose BODY is intact
 * and unedited is legitimately healthy regardless of what the user appended
 * below it, the same way an edited prefix does not make the region
 * unhealthy. This is the doctor half of the carry-through design (round 2,
 * item 1) the coordinator asked to be decided and stated: the suffix does
 * NOT make an otherwise-intact region unhealthy.
 *
 * This test is expected to already pass: `doctor.ts`'s check never reads
 * past the end marker in the first place, so it was never wrong about this
 * case — the round-1 security-scanner advisory (A3) that flagged
 * "`rig-managed-regions` reports pristine for a region with user content
 * after the end marker" is not a doctor defect under this design; it is
 * doctor already agreeing with the answer this suite pins. It is pinned
 * here as an explicit regression guard, so a future "fix" for B1 (upgrade
 * and uninstall dropping the suffix) does not accidentally make doctor
 * start flagging a healthy suffix-carrying file too.
 */
describe('doctor — a user suffix appended after the end marker does not make an intact region unhealthy (round 2, B1/A3)', () => {
  it('still reports the region healthy when the body is intact and a suffix follows the end marker', async () => {
    const body = await renderBody(projectNameFor(repo));
    await installThenSimulateRegion('# team notes\n', body);
    const suffix = '## Added later by hand\nIMPORTANT-USER-TAIL\n';
    await writeFile(agentsMdPath(), `${await readFile(agentsMdPath(), 'utf8')}${suffix}`);

    const report = await doctor();

    const check = report.checks.find((c) => c.id === 'rig-managed-regions');
    expect(check, JSON.stringify(report.checks)).toBeDefined();
    expect(check?.status).toBe('ok');
  });
});
