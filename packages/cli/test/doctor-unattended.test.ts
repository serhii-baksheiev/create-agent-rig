import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { initProject } from '../src/commands/init.js';
import type { ProviderProcessResult } from '../src/integrations/spawn.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

// RP-282: doctor reports unattended readiness against the RP-280 posture
// contract (`.claude/scripts/lib/posture.mjs`, read from this package's own
// copy). The section is additive: it never moves doctor's own status or exit
// code. Expected ids are written out by hand — an independent oracle, not a
// read of the production module.

const passingGuardRunner = async (): Promise<ProviderProcessResult> => ({
  status: 'ok',
  exitCode: 0,
  stdout: '',
  stderr: '',
});

type Condition = { id: string; classification: string; outcome: string; status: string };
type Report = {
  status: string;
  unattended?: { status: string; conditions: Condition[] };
};

const DOCTOR_CONDITIONS = [
  'codex-hook-trust',
  'detection-contract-invalid',
  'dod-checks-missing',
  'gitignore-runtime-entries-missing',
  'guard-integrity-failed',
  'harness-hooks-loaded',
  'hook-wiring-missing',
  'kill-switch-armed',
  'native-sandbox-mode',
  'tracker-credentials-missing',
  'workflow-layer-missing',
  'workspace-trust',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-unattended-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-doctor-unattended-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

async function doctor(env: NodeJS.ProcessEnv = {}): Promise<Report> {
  const result = await runDoctor({
    cwd: repo,
    args: ['--json'],
    env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '', ...env },
    guardRunner: passingGuardRunner,
  });
  return JSON.parse(result.stdout) as Report;
}

const condition = (body: Report, id: string): Condition | undefined =>
  body.unattended?.conditions.find((c) => c.id === id);

async function projectName(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
  ) as { project: { name: string } };
  return manifest.project.name;
}

describe('the runtime .gitignore entries doctor requires are the ones AGENTS.md prints (RP-282)', () => {
  it('names the same entries in both directions', async () => {
    const { RUNTIME_IGNORES } = await import('../src/integrations/doctor-unattended.js');
    const agents = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', 'AGENTS.md'),
      'utf8',
    );
    const start = agents.indexOf('One runtime path needs a `.gitignore` line always');
    const end = agents.indexOf('Each comment is on its own line', start);
    const printed = [...agents.slice(start, end).matchAll(/```\n([\s\S]*?)```/g)]
      .flatMap((block) => block[1]!.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(start).toBeGreaterThan(-1);
    expect([...printed].sort()).toEqual(
      [...RUNTIME_IGNORES.core, ...RUNTIME_IGNORES.workflow].sort(),
    );
  });
});

describe('doctor reports unattended readiness against the posture contract (RP-282)', () => {
  it('prints the section in the human-readable output too, one line per condition', async () => {
    await initProject(repo, { withWorkflow: true });
    const result = await runDoctor({
      cwd: repo,
      args: [],
      env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
      guardRunner: passingGuardRunner,
    });
    expect(result.stdout).toMatch(/^unattended readiness: warn$/m);
    expect(result.stdout).toMatch(/^warn: unattended:native-sandbox-mode: unknown$/m);
    expect(result.stdout).toMatch(/^ok: unattended:kill-switch-armed: pass$/m);
  });

  it('is additive: a rig not ready to run unattended still gets doctor’s own status and exit code', async () => {
    await initProject(repo, {});
    const result = await runDoctor({
      cwd: repo,
      args: ['--json'],
      env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
      guardRunner: passingGuardRunner,
    });
    const body = JSON.parse(result.stdout) as Report;
    expect(body.unattended?.status).toBe('fail');
    expect(result.exitCode).toBe(0);
    expect(body.status).not.toBe('fail');
  });

  it('names the native harness state it cannot observe, only as unknown, never as ok', async () => {
    await initProject(repo, { withWorkflow: true });
    const body = await doctor();
    for (const id of [
      'harness-hooks-loaded',
      'workspace-trust',
      'native-sandbox-mode',
      'codex-hook-trust',
    ]) {
      expect(condition(body, id), id).toMatchObject({
        classification: 'not-observable',
        outcome: 'unknown',
        status: 'warn',
      });
    }
  });

  it('reports gitignore-runtime-entries-missing from .gitignore, needing the workflow entries only on a workflow rig', async () => {
    const gitignore = path.join(repo, '.gitignore');
    await initProject(repo, {});
    await writeFile(gitignore, 'node_modules/\n.claude/worktrees/\n');
    expect(condition(await doctor(), 'gitignore-runtime-entries-missing')?.outcome).toBe('pass');
    await initProject(repo, { withWorkflow: true });
    expect(condition(await doctor(), 'gitignore-runtime-entries-missing')).toMatchObject({
      outcome: 'fail',
      status: 'warn',
    });
    await writeFile(
      gitignore,
      [
        '.claude/worktrees/',
        '.claude/queue.state.json',
        '.claude/queue.board',
        '.claude/gate-rounds.json',
        '.claude/runs/',
        '',
      ].join('\n'),
    );
    expect(condition(await doctor(), 'gitignore-runtime-entries-missing')?.outcome).toBe('pass');
  });

  it('reports dod-checks-missing from .claude/hooks/dod-checks.json: absent or empty warns, a command list passes, unparseable is unknown', async () => {
    await initProject(repo, { withWorkflow: true });
    const dod = path.join(repo, '.claude', 'hooks', 'dod-checks.json');
    const seen: Array<string | undefined> = [];
    seen.push(condition(await doctor(), 'dod-checks-missing')?.outcome);
    await writeFile(dod, '["npm test"]\n');
    seen.push(condition(await doctor(), 'dod-checks-missing')?.outcome);
    await writeFile(dod, '[]\n');
    seen.push(condition(await doctor(), 'dod-checks-missing')?.outcome);
    await writeFile(dod, '[ not json');
    seen.push(condition(await doctor(), 'dod-checks-missing')?.outcome);
    expect(seen).toEqual(['fail', 'pass', 'fail', 'unknown']);
  });

  it('reports tracker-credentials-missing from the adapter queue.json names: missing warns, present and plan-md pass, unreadable is unknown', async () => {
    await initProject(repo, { withWorkflow: true });
    const queue = path.join(repo, '.claude', 'queue.json');
    await writeFile(queue, `${JSON.stringify({ adapter: 'jira' })}\n`);
    expect(condition(await doctor(), 'tracker-credentials-missing')).toMatchObject({
      outcome: 'fail',
      status: 'warn',
    });
    const names = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
    const present = Object.fromEntries(names.map((name) => [name, 'set']));
    expect(condition(await doctor(present), 'tracker-credentials-missing')?.outcome).toBe('pass');
    await writeFile(queue, `${JSON.stringify({ adapter: 'plan-md' })}\n`);
    expect(condition(await doctor(), 'tracker-credentials-missing')?.outcome).toBe('pass');
    await writeFile(queue, '{ not json');
    expect(condition(await doctor(), 'tracker-credentials-missing')?.outcome).toBe('unknown');
  });

  it('takes hook-wiring-missing and guard-integrity-failed from the guard inspection doctor already runs', async () => {
    await initProject(repo, { withWorkflow: true });
    const verified = await doctor();
    expect(condition(verified, 'hook-wiring-missing')?.outcome).toBe('pass');
    expect(condition(verified, 'guard-integrity-failed')?.outcome).toBe('pass');
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{}\n');
    const unwired = await doctor();
    expect(condition(unwired, 'hook-wiring-missing')).toMatchObject({
      outcome: 'fail',
      status: 'fail',
    });
    // Integrity is checked only after wiring passes, so it was not observed.
    expect(condition(unwired, 'guard-integrity-failed')?.outcome).toBe('unknown');
  });

  it('answers kill-switch-armed exactly as the brake preflight reads does, including an AGENT_LOOP_STOP path', async () => {
    await initProject(repo, { withWorkflow: true });
    // The reference is the copy init installed into the rig — the one preflight
    // runs, with the project name already filled in — never the template.
    const { brakeIsOn, stopFlags } = (await import(
      pathToFileURL(path.join(repo, '.claude', 'scripts', 'stop-flag.mjs')).href
    )) as {
      brakeIsOn: (env: NodeJS.ProcessEnv) => string | null;
      stopFlags: (env: NodeJS.ProcessEnv) => string[];
    };
    const extra = path.join(home, 'extra-brake');
    const env = { HOME: home, AGENT_LOOP_STOP: extra };
    const homeBrake = stopFlags({ HOME: home })[0]!;
    const row = async (): Promise<[boolean, string | undefined]> => [
      brakeIsOn(env) !== null,
      condition(await doctor(env), 'kill-switch-armed')?.outcome,
    ];
    const seen = [await row()];
    await mkdir(path.dirname(homeBrake), { recursive: true });
    await writeFile(homeBrake, '');
    seen.push(await row());
    await rm(homeBrake);
    await writeFile(extra, '');
    seen.push(await row());
    expect(seen).toEqual([
      [false, 'pass'],
      [true, 'fail'],
      [true, 'fail'],
    ]);
  });

  it('answers detection-contract-invalid exactly as preflight does, valid, malformed and absent', async () => {
    const { checkDetectionContract } = (await import(
      pathToFileURL(
        path.join(
          repoRoot,
          'templates',
          'agent-os',
          'universal',
          '.claude',
          'scripts',
          'preflight.mjs',
        ),
      ).href
    )) as { checkDetectionContract: (root: string) => { ok: boolean } };
    await initProject(repo, { withWorkflow: true });
    const contract = path.join(repo, '.rig', 'revalidation.json');
    const seen: Array<[boolean, string | undefined]> = [];
    seen.push([
      checkDetectionContract(repo).ok,
      condition(await doctor(), 'detection-contract-invalid')?.outcome,
    ]);
    await writeFile(contract, '{ not json');
    seen.push([
      checkDetectionContract(repo).ok,
      condition(await doctor(), 'detection-contract-invalid')?.outcome,
    ]);
    await rm(contract);
    seen.push([
      checkDetectionContract(repo).ok,
      condition(await doctor(), 'detection-contract-invalid')?.outcome,
    ]);
    expect(seen).toEqual([
      [true, 'pass'],
      [false, 'fail'],
      [false, 'fail'],
    ]);
  });

  it('reports workflow-layer-missing as a failure on a rig without the workflow layer, and ok with it', async () => {
    await initProject(repo, {});
    expect(condition(await doctor(), 'workflow-layer-missing')).toMatchObject({
      outcome: 'fail',
      status: 'fail',
    });
    await initProject(repo, { withWorkflow: true });
    expect(condition(await doctor(), 'workflow-layer-missing')).toMatchObject({
      outcome: 'pass',
      status: 'ok',
    });
  });

  it('names exactly the conditions the contract puts on the doctor surface', async () => {
    await initProject(repo, { withWorkflow: true });
    const body = await doctor();
    const ids = (body.unattended?.conditions ?? []).map((c) => c.id).sort();
    expect(ids).toEqual(DOCTOR_CONDITIONS);
  });

  it('reports kill-switch-armed as a failure when the brake file is on', async () => {
    await initProject(repo, { withWorkflow: true });
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', `${await projectName()}-loop-STOP`), '');
    expect(condition(await doctor(), 'kill-switch-armed')).toMatchObject({
      outcome: 'fail',
      status: 'fail',
    });
  });
});
