import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { inspectWorkflow } from '../src/integrations/doctor-workflow.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-workflow-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const revalidate = () => path.join(repo, '.claude', 'scripts', 'revalidate.mjs');
const claimRecords = () => path.join(repo, '.claude', 'scripts', 'lib', 'claim-records.mjs');

describe('doctor workflow inspection', () => {
  it('passes a core-only rig as an intentionally unselected optional workflow layer', async () => {
    await initProject(repo, {});

    const result = await inspectWorkflow({ repoDir: repo });

    expect(result).toEqual({ status: 'pass', reason: 'not-selected' });
  });

  it('passes an intact selected workflow layer and preserves its frozen mechanism bytes', async () => {
    await initProject(repo, { withWorkflow: true });
    const revalidateBefore = await readFile(revalidate(), 'utf8');
    const claimsBefore = await readFile(claimRecords(), 'utf8');

    const result = await inspectWorkflow({ repoDir: repo });

    expect(result).toEqual({ status: 'pass', reason: 'workflow-verified' });
    expect(await readFile(revalidate(), 'utf8')).toBe(revalidateBefore);
    expect(await readFile(claimRecords(), 'utf8')).toBe(claimsBefore);
  });

  it('fails a changed workflow revalidation mechanism without replacing its bytes', async () => {
    await initProject(repo, { withWorkflow: true });
    const edited = `${await readFile(revalidate(), 'utf8')}\n// local edit\n`;
    await writeFile(revalidate(), edited);

    const result = await inspectWorkflow({ repoDir: repo });

    expect(result).toEqual({ status: 'fail', reason: 'workflow-integrity-invalid' });
    expect(await readFile(revalidate(), 'utf8')).toBe(edited);
  });

  it('fails when the selected workflow layer is missing claim-records', async () => {
    await initProject(repo, { withWorkflow: true });
    const revalidateBefore = await readFile(revalidate(), 'utf8');
    await rm(claimRecords());

    const result = await inspectWorkflow({ repoDir: repo });

    expect(result).toEqual({ status: 'fail', reason: 'workflow-integrity-invalid' });
    expect(await readFile(revalidate(), 'utf8')).toBe(revalidateBefore);
  });
});
