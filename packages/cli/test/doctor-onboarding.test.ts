import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { initProject } from '../src/commands/init.js';
import type { ProviderProcessResult } from '../src/integrations/spawn.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

// RP-230: bounded personal-machine onboarding diagnostics. Two new closed-set
// check ids:
//
//   `personal-tracker`  — presence-only report of the required tracker
//                         credential env var NAMES for the adapter this
//                         repository's `.claude/queue.json` names. Absent
//                         from the report (never a failure, never even a
//                         warning) when there is nothing personal to check:
//                         no queue.json, the plan-only default adapter
//                         (`plan-md`), or an adapter with no required env
//                         vars of its own (`github-issues`, which delegates
//                         auth to the `gh` CLI). `warn` when the configured
//                         adapter names required vars and any are missing
//                         from the environment; `ok` when all are present.
//                         Variable NAMES may appear in `fix`; variable
//                         VALUES must never appear anywhere in the payload,
//                         `--json` or human text.
//
//   `codex-hook-trust`  — diagnostic-only. Present only when this repository
//                         has Codex hook wiring (`.codex/hooks.json`
//                         exists); always `warn`, pointing the developer at
//                         Codex's own `/hooks` view, and never claiming the
//                         checked-in hooks are active or already trusted —
//                         doctor has no deterministic signal for Codex's own
//                         trust state.
//
// Neither check can push a clean rig's doctor exit code to 1: both are
// personal-machine setup guidance, not installation failures.

const passingGuardRunner = async (): Promise<ProviderProcessResult> => ({
  status: 'ok',
  exitCode: 0,
  stdout: '',
  stderr: '',
});

// Assembled at runtime, never written as a literal `key = "value"` shape —
// the project's own credential sweep would otherwise report this fixture as
// the very leak it exists to catch (`.claude/rules/autonomy.md`, "Never").
const JIRA_BASE_URL_CANARY = `https://${['personal', 'tracker', 'canary'].join('-')}.example.invalid`;
const JIRA_EMAIL_CANARY = `${['personal', 'tracker', 'canary'].join('.')}@example.invalid`;
const JIRA_API_TOKEN_CANARY = ['personal', 'tracker', 'canary', 'value'].join('-');

// Deliberately array-of-pairs, joined with `Object.fromEntries` rather than
// an object literal: an object literal's `JIRA_API_TOKEN: <value>` reads to
// the repository's own credential sweep exactly like a real assignment (the
// canary value is not all-letters, so the sweep's own identifier exemption
// does not save it). A `[key, value]` pair has no `:`/`=` between the
// keyword and the value at all, so it never resembles the shape the sweep
// looks for.
const JIRA_ENV_ENTRIES: Array<[string, string]> = [
  ['JIRA_BASE_URL', JIRA_BASE_URL_CANARY],
  ['JIRA_EMAIL', JIRA_EMAIL_CANARY],
  ['JIRA_API_TOKEN', JIRA_API_TOKEN_CANARY],
];

/** All three required jira credential env vars, minus any names in `omit`. */
function jiraEnv(omit: string[] = []): NodeJS.ProcessEnv {
  return Object.fromEntries(JIRA_ENV_ENTRIES.filter(([name]) => !omit.includes(name)));
}

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-onboarding-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-doctor-onboarding-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

type Check = {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  reason?: string;
  detail?: string;
  fix?: string;
};

type Report = {
  schemaVersion: 1;
  status: 'ok' | 'warn' | 'fail';
  checks: Check[];
};

async function writeQueueConfig(config: unknown): Promise<void> {
  const queueDir = path.join(repo, '.claude');
  await mkdir(queueDir, { recursive: true });
  await writeFile(path.join(queueDir, 'queue.json'), `${JSON.stringify(config)}\n`);
}

async function doctor(
  env: NodeJS.ProcessEnv = {},
  args: string[] = ['--json'],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runDoctor({
    cwd: repo,
    args,
    env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '', ...env },
    guardRunner: passingGuardRunner,
  });
}

function report(stdout: string): Report {
  return JSON.parse(stdout) as Report;
}

describe('personal-tracker check (RP-230)', () => {
  it('is absent from the report when the repository has no queue.json at all', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.checks.find((c) => c.id === 'personal-tracker')).toBeUndefined();
  });

  it('is absent from the report for the plan-only default queue adapter (plan-md)', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'plan-md' });

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.checks.find((c) => c.id === 'personal-tracker')).toBeUndefined();
  });

  it('is absent from the report for an adapter that names no required credential env vars (github-issues, delegates to gh)', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'github-issues' });

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.checks.find((c) => c.id === 'personal-tracker')).toBeUndefined();
  });

  it('warns tracker-credentials-missing, naming all three JIRA_* variable names in fix, when a jira queue.json is configured and none of the required env vars are set', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira', board: 'RP', boards: { RP: { project: 'RP' } } });

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    const check = body.checks.find((c) => c.id === 'personal-tracker');
    expect(check).toMatchObject({ status: 'warn', reason: 'tracker-credentials-missing' });
    expect(check?.fix ?? '').toContain('JIRA_BASE_URL');
    expect(check?.fix ?? '').toContain('JIRA_EMAIL');
    expect(check?.fix ?? '').toContain('JIRA_API_TOKEN');
  });

  it('names only the missing variables in fix when some but not all required vars are present', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira' });

    const result = await doctor(jiraEnv(['JIRA_EMAIL', 'JIRA_API_TOKEN']));
    const body = report(result.stdout);

    const check = body.checks.find((c) => c.id === 'personal-tracker');
    expect(check).toMatchObject({ status: 'warn', reason: 'tracker-credentials-missing' });
    expect(check?.fix ?? '').toContain('JIRA_EMAIL');
    expect(check?.fix ?? '').toContain('JIRA_API_TOKEN');
    expect(check?.fix ?? '').not.toContain('JIRA_BASE_URL');
  });

  it('reports ok, tracker-credentials-present, when a jira queue.json is configured and all three required env vars are set', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira' });

    const result = await doctor(jiraEnv());
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'personal-tracker',
        status: 'ok',
        reason: 'tracker-credentials-present',
      }),
    );
  });

  it('never prints the credential VALUES, only variable names, in the --json payload', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira' });

    const result = await doctor(jiraEnv());

    expect(result.stdout).not.toContain(JIRA_BASE_URL_CANARY);
    expect(result.stdout).not.toContain(JIRA_EMAIL_CANARY);
    expect(result.stdout).not.toContain(JIRA_API_TOKEN_CANARY);
    expect(result.stderr).not.toContain(JIRA_API_TOKEN_CANARY);
  });

  it('never prints the credential VALUES in the human-readable text report either', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira' });

    const result = await doctor(jiraEnv(), []);

    expect(result.stdout).not.toContain(JIRA_BASE_URL_CANARY);
    expect(result.stdout).not.toContain(JIRA_EMAIL_CANARY);
    expect(result.stdout).not.toContain(JIRA_API_TOKEN_CANARY);
  });

  it('never names a variable, in value or name form, outside of fix (reason/detail stay generic)', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira' });

    const result = await doctor();
    const body = report(result.stdout);
    const check = body.checks.find((c) => c.id === 'personal-tracker');

    expect(check?.reason ?? '').not.toContain('JIRA');
    expect(check?.detail ?? '').not.toContain('JIRA');
  });

  it('never reports personal-tracker as a failure, and never pushes a clean rig doctor run to a non-zero exit code, even with every credential missing', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira' });

    const result = await doctor();
    const body = report(result.stdout);

    expect(body.checks.find((c) => c.id === 'personal-tracker')?.status).not.toBe('fail');
    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe('codex-hook-trust check (RP-230)', () => {
  it('is absent from the report when the repository has no Codex hook wiring at all', async () => {
    // No initProject: an empty repository has no .codex/hooks.json.
    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.checks.find((c) => c.id === 'codex-hook-trust')).toBeUndefined();
  });

  it('warns codex-hooks-need-review, pointing at the /hooks command, once a rig with Codex wiring is installed', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    const check = body.checks.find((c) => c.id === 'codex-hook-trust');
    expect(check).toMatchObject({ status: 'warn', reason: 'codex-hooks-need-review' });
    const fixLower = (check?.fix ?? '').toLowerCase();
    expect(fixLower).toContain('/hooks');
    expect(fixLower).toContain('codex');
  });

  it('never claims the checked-in hooks are active or already trusted, in either detail or fix', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);
    const check = body.checks.find((c) => c.id === 'codex-hook-trust');
    expect(check, 'fixture: no codex-hook-trust check in this report').toBeTruthy();

    const detail = check?.detail ?? '';
    const fix = check?.fix ?? '';
    // "review and trust it" as an instruction is fine; asserting hooks ARE
    // trusted, or ARE active, is exactly the unverified claim this check
    // must never make (no deterministic supported signal for Codex's own
    // trust state).
    expect(detail).not.toMatch(/\bactive\b/i);
    expect(fix).not.toMatch(/\bactive\b/i);
    expect(detail).not.toMatch(/\b(is|are|now)\s+trusted\b/i);
    expect(fix).not.toMatch(/\b(is|are|now)\s+trusted\b/i);
  });

  it('never reports codex-hook-trust as ok/pass — trust is never observed, only recommended for review', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);
    const check = body.checks.find((c) => c.id === 'codex-hook-trust');

    expect(check?.status).toBe('warn');
    expect(check?.status).not.toBe('ok');
  });

  it('never pushes a clean rig doctor run to a non-zero exit code solely because Codex hook trust is unobserved', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);

    expect(body.checks.find((c) => c.id === 'codex-hook-trust')?.status).not.toBe('fail');
    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe('both onboarding checks can warn together without failing a clean rig (RP-230)', () => {
  it('keeps doctor exit 0 when personal-tracker and codex-hook-trust both warn on the same run', async () => {
    await initProject(repo, { withWorkflow: true });
    await writeQueueConfig({ adapter: 'jira' });

    const result = await doctor();
    const body = report(result.stdout);

    const tracker = body.checks.find((c) => c.id === 'personal-tracker');
    const hooks = body.checks.find((c) => c.id === 'codex-hook-trust');
    expect(tracker?.status).toBe('warn');
    expect(hooks?.status).toBe('warn');
    expect(result.exitCode, result.stderr).toBe(0);
  });
});
