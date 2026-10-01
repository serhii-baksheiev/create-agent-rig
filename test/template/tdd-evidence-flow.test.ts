import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { skipUnless } from '../helpers/env.js';
import { jiraReadback } from './tdd-tracker-fixture.js';

// RP-306 must bind a structured test result to the actual check-run that
// observed it. A separate JSON file is not evidence: it could describe an
// unrelated run or be changed after the check exited.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const relevantSpecMarker =
  'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns the replacement value"}';

type Result = { code: number; stdout: string; stderr: string; out: string };

const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Result> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const git = async (args: string[], cwd: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    process.env,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

const sha256File = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

const revalidationContract = {
  schemaVersion: 1,
  detection: {
    mode: 'pull',
    sources: ['run-state', 'journal'],
    acceptedLatency: '24h',
    push: false,
  },
  pairedFacts: [],
};

const createFailedCheck = async ({ body = relevantSpecMarker }: { body?: string } = {}) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'tdd-evidence-flow-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-evidence-run-'));
  await mkdir(path.join(projectRoot, '.rig'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(projectRoot, '.rig', 'revalidation.json'),
    `${JSON.stringify(revalidationContract)}\n`,
  );
  await writeFile(
    path.join(projectRoot, 'src', 'feature.ts'),
    'export const feature = () => "old";\n',
  );
  await git(['init', '-q', '-b', 'master'], projectRoot);
  await git(['add', '.rig/revalidation.json', 'src/feature.ts'], projectRoot);
  await git(['commit', '-q', '-m', 'baseline'], projectRoot);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
  await git(['checkout', '-q', '-b', 'feat/RP-306-evidence'], projectRoot);

  const testPath = path.join(projectRoot, 'test', 'feature.test.ts');
  await mkdir(path.dirname(testPath), { recursive: true });
  await writeFile(
    testPath,
    "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n",
  );
  const vitestConfig = path.join(projectRoot, 'vitest.config.mjs');
  await writeFile(
    vitestConfig,
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );
  const testFileSha256 = await sha256File(testPath);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    recordClaimTransition: (input: Record<string, unknown>) => unknown;
  };
  const ticket = {
    id: 'RP-306',
    state: 'open' as const,
    title: 'Mechanical TDD producer',
    body,
    labels: [],
    blockedBy: [],
    blocks: [],
  };
  expect(
    claims.revalidateClaim({
      projectRoot,
      ticket,
      point: 'SELECT',
      targetSha: baselineHeadSha,
      allowCreate: true,
    }).result,
  ).toBe('BASELINE_CREATED');
  claims.recordClaimTransition({
    projectRoot,
    ticket: { ...ticket, state: 'in-progress' },
    claimedState: 'in-progress',
  });

  const trackerEnv = await jiraReadback({ projectRoot, ticket });

  const vitestJsonName = 'vitest-red.json';
  const vitestJson = path.join(runDir, vitestJsonName);
  const check = await run(
    process.execPath,
    [
      checkRun,
      '--name',
      'unit',
      '--vitest-json',
      vitestJsonName,
      '--',
      process.execPath,
      vitestCli,
      'run',
      '--root',
      projectRoot,
      '--config',
      vitestConfig,
      '--reporter=json',
      '--outputFile',
      vitestJson,
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
  expect(check.code, check.out).toBe(1);

  const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
    readRun: (input: { runDir: string }) => { events: Array<{ kind?: string; data?: unknown }> };
  };
  const observed = journal
    .readRun({ runDir })
    .events.filter((event) => event.kind === 'check-result')
    .at(-1);
  expect(observed).toMatchObject({
    data: {
      name: 'unit',
      outcome: 'fail',
      structuredResult: {
        format: 'vitest-json',
        path: vitestJsonName,
        sha256: await sha256File(vitestJson),
      },
    },
  });

  return {
    baselineHeadSha,
    projectRoot,
    runDir,
    testFileSha256,
    testPath,
    vitestConfig,
    vitestJson,
    trackerEnv,
  };
};

const recordRed = ({
  projectRoot,
  runDir,
  trackerEnv,
  check = 'unit',
}: {
  projectRoot: string;
  runDir: string;
  trackerEnv: NodeJS.ProcessEnv;
  check?: string;
}) =>
  run(
    process.execPath,
    [tddEvidence, 'record-red', '--ticket', 'RP-306', '--check', check],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

const runGreenCheck = ({
  projectRoot,
  runDir,
  vitestConfig,
  trackerEnv,
}: {
  projectRoot: string;
  runDir: string;
  vitestConfig: string;
  trackerEnv: NodeJS.ProcessEnv;
}) => {
  const vitestJsonName = 'vitest-green.json';
  return run(
    process.execPath,
    [
      checkRun,
      '--name',
      'unit-green',
      '--vitest-json',
      vitestJsonName,
      '--',
      process.execPath,
      vitestCli,
      'run',
      '--root',
      projectRoot,
      '--config',
      vitestConfig,
      '--reporter=json',
      '--outputFile',
      path.join(runDir, vitestJsonName),
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
};

const recordGreen = ({
  projectRoot,
  runDir,
  trackerEnv,
}: {
  projectRoot: string;
  runDir: string;
  trackerEnv: NodeJS.ProcessEnv;
}) =>
  run(
    process.execPath,
    [tddEvidence, 'record-green', '--ticket', 'RP-306', '--check', 'unit-green'],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

const establishRed = async () => {
  const fixture = await createFailedCheck();
  const recorded = await recordRed(fixture);
  expect(recorded.code, recorded.out).toBe(0);
  return fixture;
};

describe('RP-306 portable TDD evidence flow', () => {
  it('records an existing failing check-run test only when SELECT carried its tracker-derived relevant spec', async () => {
    const fixture = await establishRed();

    const claim = JSON.parse(
      await readFile(path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(claim).toMatchObject({
      ticket: 'RP-306',
      tddScope: {
        test: { file: 'test/feature.test.ts', fullName: 'returns the replacement value' },
        fingerprint: { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
      tddEvidence: {
        schemaVersion: 1,
        ticket: 'RP-306',
        applicability: { level: 'TDD-1' },
        baseline: { headSha: fixture.baselineHeadSha },
        red: {
          test: {
            file: 'test/feature.test.ts',
            fullName: 'returns the replacement value',
            fileSha256: fixture.testFileSha256,
          },
          observation: { outcome: 'fail' },
          source: { runId: path.basename(fixture.runDir), seq: expect.any(Number) },
          fingerprint: { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
      },
    });
  });

  it('refuses RED when the selected tracker item has no relevant-spec marker', async () => {
    const fixture = await createFailedCheck({ body: '' });
    const recorded = await recordRed(fixture);

    expect(recorded.code, recorded.out).not.toBe(0);
    const claim = JSON.parse(
      await readFile(path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    expect(claim).not.toHaveProperty('tddEvidence');
  });

  it('refuses RED when the structured Vitest full name differs from the selected relevant spec', async () => {
    const fixture = await createFailedCheck({
      body: 'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"a different specification"}',
    });
    const recorded = await recordRed(fixture);

    expect(recorded.code, recorded.out).not.toBe(0);
    const claim = JSON.parse(
      await readFile(path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    expect(claim).not.toHaveProperty('tddEvidence');
  });

  it('refuses an intermediate .rig symlink without changing the external claim', async () => {
    const fixture = await createFailedCheck();
    const claimName = 'RP-306.json';
    const originalClaim = await readFile(
      path.join(fixture.projectRoot, '.rig', 'claims', claimName),
    );
    const outside = await mkdtemp(path.join(tmpdir(), 'tdd-external-rig-'));
    const outsideRig = path.join(outside, 'rig');
    const outsideClaim = path.join(outsideRig, 'claims', claimName);
    await mkdir(path.dirname(outsideClaim), { recursive: true });
    await writeFile(outsideClaim, originalClaim);
    await rename(
      path.join(fixture.projectRoot, '.rig'),
      path.join(fixture.projectRoot, '.rig-before-symlink'),
    );
    await symlink(
      outsideRig,
      path.join(fixture.projectRoot, '.rig'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const recorded = await recordRed(fixture);

    expect(recorded.code, recorded.out).not.toBe(0);
    expect(recorded.out).toMatch(/claim|\.rig|symlink|unsafe/i);
    await expect(readFile(outsideClaim)).resolves.toEqual(originalClaim);
  });

  it('refuses a local executable named node that fabricates a valid Vitest report', async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'the local executable fixture requires POSIX execute bits',
    );
    const fixture = await createFailedCheck();
    const reportName = 'local-node.json';
    const reportPath = path.join(fixture.runDir, reportName);
    const report = JSON.stringify({
      success: false,
      numFailedTests: 1,
      testResults: [
        {
          name: fixture.testPath,
          assertionResults: [{ status: 'failed', fullName: 'returns the replacement value' }],
        },
      ],
    });
    const localNode = path.join(fixture.projectRoot, 'node');
    await writeFile(
      localNode,
      [
        '#!/usr/bin/env node',
        `require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--outputFile') + 1], ${JSON.stringify(report)});`,
        'process.exitCode = 1;',
      ].join('\n'),
    );
    await chmod(localNode, 0o700);
    const check = await run(
      process.execPath,
      [
        checkRun,
        '--name',
        'local-node',
        '--vitest-json',
        reportName,
        '--',
        localNode,
        vitestCli,
        'run',
        '--root',
        fixture.projectRoot,
        '--config',
        fixture.vitestConfig,
        '--reporter=json',
        '--outputFile',
        reportPath,
      ],
      fixture.projectRoot,
      { ...fixture.trackerEnv, RIG_RUN_DIR: fixture.runDir },
    );
    expect(check.code, check.out).toBe(1);

    const recorded = await recordRed({ ...fixture, check: 'local-node' });
    expect(recorded.code, recorded.out).not.toBe(0);
    expect(recorded.out).toMatch(/runner|Vitest|structured/i);
  });

  it('refuses a local node runner that swaps itself to the real Node binary after writing a report', async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'the self-replacing executable fixture requires POSIX symlinks',
    );
    const fixture = await createFailedCheck();
    const reportName = 'self-replaced-node.json';
    const reportPath = path.join(fixture.runDir, reportName);
    const report = JSON.stringify({
      success: false,
      numFailedTests: 1,
      testResults: [
        {
          name: fixture.testPath,
          assertionResults: [{ status: 'failed', fullName: 'returns the replacement value' }],
        },
      ],
    });
    const localNode = path.join(fixture.projectRoot, 'node');
    await writeFile(
      localNode,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `fs.writeFileSync(process.argv[process.argv.indexOf('--outputFile') + 1], ${JSON.stringify(report)});`,
        'fs.unlinkSync(process.argv[1]);',
        'fs.symlinkSync(process.execPath, process.argv[1]);',
        'process.exitCode = 1;',
      ].join('\n'),
    );
    await chmod(localNode, 0o700);
    const check = await run(
      process.execPath,
      [
        checkRun,
        '--name',
        'self-replaced-node',
        '--vitest-json',
        reportName,
        '--',
        localNode,
        vitestCli,
        'run',
        '--root',
        fixture.projectRoot,
        '--config',
        fixture.vitestConfig,
        '--reporter=json',
        '--outputFile',
        reportPath,
      ],
      fixture.projectRoot,
      { ...fixture.trackerEnv, RIG_RUN_DIR: fixture.runDir },
    );
    expect(check.code, check.out).toBe(1);

    const recorded = await recordRed({ ...fixture, check: 'self-replaced-node' });
    expect(recorded.code, recorded.out).not.toBe(0);
    expect(recorded.out).toMatch(/runner|Vitest|structured/i);
  });

  it('binds an attested Vitest module alias to the canonical installed module path', async () => {
    const fixture = await createFailedCheck();
    const moduleAlias = path.join(fixture.projectRoot, 'vitest.mjs');
    await symlink(vitestCli, moduleAlias, 'file');
    const reportName = 'module-alias.json';
    const reportPath = path.join(fixture.runDir, reportName);
    const args = [
      'run',
      '--root',
      fixture.projectRoot,
      '--config',
      fixture.vitestConfig,
      '--reporter=json',
      '--outputFile',
      reportPath,
    ];
    const check = await run(
      process.execPath,
      [
        checkRun,
        '--name',
        'module-alias',
        '--vitest-json',
        reportName,
        '--',
        process.execPath,
        moduleAlias,
        ...args,
      ],
      fixture.projectRoot,
      { ...fixture.trackerEnv, RIG_RUN_DIR: fixture.runDir },
    );
    expect(check.code, check.out).toBe(1);

    const journal = (await import(
      pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href
    )) as {
      readRun: (input: { runDir: string }) => {
        events: Array<{
          kind?: string;
          data?: { name?: string; structuredResult?: { runner?: { commandSha256?: string } } };
        }>;
      };
    };
    const observed = journal
      .readRun({ runDir: fixture.runDir })
      .events.filter(
        (event) => event.kind === 'check-result' && event.data?.name === 'module-alias',
      )
      .at(-1);
    const canonicalCommandHash = createHash('sha256')
      .update(JSON.stringify([process.execPath, realpathSync(vitestCli), ...args]))
      .digest('hex');
    expect(observed?.data?.structuredResult?.runner?.commandSha256).toBe(canonicalCommandHash);

    const recorded = await recordRed({ ...fixture, check: 'module-alias' });
    expect(recorded.code, recorded.out).toBe(0);
  });

  it('refuses a Vitest test path whose intermediate directory is a symlink outside the project', async () => {
    const fixture = await createFailedCheck({
      body: 'rig:tdd-spec/v1 {"file":"test/external/feature.test.ts","fullName":"returns the replacement value"}',
    });
    const outside = await mkdtemp(path.join(tmpdir(), 'tdd-external-test-'));
    const externalTest = path.join(outside, 'feature.test.ts');
    await writeFile(
      externalTest,
      `import { feature } from ${JSON.stringify(path.join(fixture.projectRoot, 'src', 'feature.ts'))};\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n`,
    );
    await symlink(
      outside,
      path.join(fixture.projectRoot, 'test', 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const config = path.join(fixture.projectRoot, 'vitest-symlink.config.mjs');
    await writeFile(
      config,
      "export default { test: { include: ['test/external/**/*.test.ts'], globals: true } };\n",
    );
    const reportName = 'symlinked-test.json';
    const check = await run(
      process.execPath,
      [
        checkRun,
        '--name',
        'symlinked-test',
        '--vitest-json',
        reportName,
        '--',
        process.execPath,
        vitestCli,
        'run',
        '--root',
        fixture.projectRoot,
        '--config',
        config,
        '--reporter=json',
        '--outputFile',
        path.join(fixture.runDir, reportName),
      ],
      fixture.projectRoot,
      { ...fixture.trackerEnv, RIG_RUN_DIR: fixture.runDir },
    );
    expect(check.code, check.out).toBe(1);

    const recorded = await recordRed({ ...fixture, check: 'symlinked-test' });
    expect(recorded.code, recorded.out).not.toBe(0);
    expect(recorded.out).toMatch(/test file|symlink|outside|safe/i);
  });

  it('refuses a Vitest-shaped report written by an arbitrary node runner', async () => {
    const fixture = await createFailedCheck();
    const reportName = 'fake-runner.json';
    const reportPath = path.join(fixture.runDir, reportName);
    const report = JSON.stringify({
      testResults: [
        {
          name: fixture.testPath,
          assertionResults: [{ status: 'failed', fullName: 'returns the replacement value' }],
        },
      ],
    });
    const writer = `require('node:fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(report)}); process.exitCode = 1;`;
    const check = await run(
      process.execPath,
      [
        checkRun,
        '--name',
        'fake-runner',
        '--vitest-json',
        reportName,
        '--',
        process.execPath,
        '-e',
        writer,
        reportPath,
      ],
      fixture.projectRoot,
      { ...fixture.trackerEnv, RIG_RUN_DIR: fixture.runDir },
    );
    expect(check.code, check.out).toBe(1);

    const recorded = await recordRed({ ...fixture, check: 'fake-runner' });
    expect(recorded.code, recorded.out).not.toBe(0);
    expect(recorded.out).toMatch(/runner|Vitest|structured/i);
  });

  it('refuses a Vitest result whose bytes no longer match the failed check-run record', async () => {
    const fixture = await createFailedCheck();
    await writeFile(fixture.vitestJson, '{"testResults":[]}\n');

    const recorded = await recordRed(fixture);
    expect(recorded.code).not.toBe(0);
    const claim = await readFile(
      path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json'),
      'utf8',
    );
    expect(JSON.parse(claim)).not.toHaveProperty('tddEvidence');
  });

  it('atomically upgrades portable RED to a TDD-2 boundary and same-spec GREEN chain', async () => {
    const fixture = await establishRed();
    await writeFile(
      path.join(fixture.projectRoot, 'src', 'feature.ts'),
      'export const feature = () => "new";\n',
    );
    const green = await runGreenCheck(fixture);
    expect(green.code, green.out).toBe(0);

    const recorded = await recordGreen(fixture);
    expect(recorded.code, recorded.out).toBe(0);

    const claim = JSON.parse(
      await readFile(path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    ) as {
      tddEvidence: {
        applicability: { level: string };
        red: { test: Record<string, unknown>; fingerprint: Record<string, unknown> };
        implementationBoundary: {
          implementationDeltaFingerprint: Record<string, unknown>;
          predecessorFingerprint: Record<string, unknown>;
          fingerprint: Record<string, unknown>;
        };
        green: {
          test: Record<string, unknown>;
          predecessorFingerprint: Record<string, unknown>;
          observation: Record<string, unknown>;
        };
      };
    };
    const evidence = claim.tddEvidence;
    expect(evidence.applicability).toEqual({
      level: 'TDD-2',
      authority: { kind: 'check-run', id: 'unit-green' },
    });
    expect(evidence.implementationBoundary.implementationDeltaFingerprint).toMatchObject({
      algorithm: 'sha256',
      value: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(evidence.implementationBoundary.predecessorFingerprint).toEqual(
      evidence.red.fingerprint,
    );
    expect(evidence.green.test).toEqual(evidence.red.test);
    expect(evidence.green.predecessorFingerprint).toEqual(
      evidence.implementationBoundary.fingerprint,
    );
    expect(evidence.green.observation).toMatchObject({ outcome: 'pass' });
  });

  it('replaces a stale RED with a newly observed RED for the changed test hash', async () => {
    const fixture = await establishRed();
    const claimPath = path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json');
    const before = JSON.parse(await readFile(claimPath, 'utf8')) as {
      tddEvidence: Record<string, unknown> & {
        red: { fingerprint: Record<string, unknown>; test: { fileSha256: string } };
      };
    };
    await writeFile(
      fixture.testPath,
      "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n// amended before replacement RED\n",
    );
    const redB = await runGreenCheck(fixture);
    expect(redB.code, redB.out).toBe(1);

    const recordedRedB = await recordRed({ ...fixture, check: 'unit-green' });
    expect(recordedRedB.code, recordedRedB.out).toBe(0);

    const afterRedB = JSON.parse(await readFile(claimPath, 'utf8')) as {
      tddEvidence: {
        applicability: { level: string };
        red: {
          fingerprint: Record<string, unknown>;
          test: { file: string; fullName: string; fileSha256: string };
        };
      };
      tddEvidenceHistory: Array<{
        evidence: Record<string, unknown>;
        transition: {
          priorRedFingerprint: Record<string, unknown>;
          replacementRedFingerprint: Record<string, unknown>;
          fingerprint: { algorithm: string; value: string };
        };
      }>;
    };
    expect(afterRedB.tddEvidence.applicability.level).toBe('TDD-1');
    expect(afterRedB.tddEvidence.red.test).toMatchObject({
      file: 'test/feature.test.ts',
      fullName: 'returns the replacement value',
    });
    expect(afterRedB.tddEvidence.red.test.fileSha256).not.toBe(
      before.tddEvidence.red.test.fileSha256,
    );
    expect(afterRedB.tddEvidenceHistory).toHaveLength(1);
    expect(afterRedB.tddEvidenceHistory[0]?.evidence).toEqual(before.tddEvidence);
    expect(afterRedB.tddEvidenceHistory[0]?.transition).toMatchObject({
      priorRedFingerprint: before.tddEvidence.red.fingerprint,
      replacementRedFingerprint: afterRedB.tddEvidence.red.fingerprint,
      fingerprint: { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });

    await writeFile(
      path.join(fixture.projectRoot, 'src', 'feature.ts'),
      'export const feature = () => "new";\n',
    );
    const greenB = await runGreenCheck(fixture);
    expect(greenB.code, greenB.out).toBe(0);
    const recordedGreenB = await recordGreen(fixture);
    expect(recordedGreenB.code, recordedGreenB.out).toBe(0);

    await git(
      ['add', 'src/feature.ts', 'test/feature.test.ts', '.rig/claims/RP-306.json'],
      fixture.projectRoot,
    );
    await git(
      ['commit', '-q', '-m', 'replace stale RED with new observed evidence'],
      fixture.projectRoot,
    );
    const ship = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      fixture.projectRoot,
      {
        ...fixture.trackerEnv,
        RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-recovery-ship-')),
      },
    );
    expect(ship.code, ship.out).toBe(0);

    const tampered = JSON.parse(await readFile(claimPath, 'utf8')) as {
      tddEvidenceHistory: Array<{ transition: { priorRedFingerprint: { value: string } } }>;
    };
    tampered.tddEvidenceHistory[0]!.transition.priorRedFingerprint.value = '0'.repeat(64);
    await writeFile(claimPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await git(['add', '.rig/claims/RP-306.json'], fixture.projectRoot);
    await git(['commit', '-q', '-m', 'tamper stale RED transition'], fixture.projectRoot);
    const tamperedShip = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      fixture.projectRoot,
      {
        ...fixture.trackerEnv,
        RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-recovery-tamper-')),
      },
    );
    expect(tamperedShip.code, tamperedShip.out).toBe(2);
  });

  it('replaces completed TDD-2 with a newly observed RED when the relevant test changes later', async () => {
    const fixture = await establishRed();
    await writeFile(
      path.join(fixture.projectRoot, 'src', 'feature.ts'),
      'export const feature = () => "new";\n',
    );
    const greenA = await runGreenCheck(fixture);
    expect(greenA.code, greenA.out).toBe(0);
    const recordedGreenA = await recordGreen(fixture);
    expect(recordedGreenA.code, recordedGreenA.out).toBe(0);

    const claimPath = path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json');
    const before = JSON.parse(await readFile(claimPath, 'utf8')) as {
      tddEvidence: Record<string, unknown> & {
        applicability: { level: string };
        red: { fingerprint: Record<string, unknown>; test: { fileSha256: string } };
      };
    };
    expect(before.tddEvidence.applicability.level).toBe('TDD-2');
    await writeFile(
      fixture.testPath,
      "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('newer'));\n// amended after completed TDD-2\n",
    );
    const redB = await runGreenCheck(fixture);
    expect(redB.code, redB.out).toBe(1);

    const recordedRedB = await recordRed({ ...fixture, check: 'unit-green' });
    expect(recordedRedB.code, recordedRedB.out).toBe(0);

    const afterRedB = JSON.parse(await readFile(claimPath, 'utf8')) as {
      tddEvidence: {
        applicability: { level: string };
        red: { fingerprint: Record<string, unknown>; test: { fileSha256: string } };
      };
      tddEvidenceHistory: Array<{
        evidence: Record<string, unknown>;
        transition: {
          priorRedFingerprint: Record<string, unknown>;
          replacementRedFingerprint: Record<string, unknown>;
          fingerprint: { algorithm: string; value: string };
        };
      }>;
    };
    expect(afterRedB.tddEvidence.applicability.level).toBe('TDD-1');
    expect(afterRedB.tddEvidence.red.test.fileSha256).not.toBe(
      before.tddEvidence.red.test.fileSha256,
    );
    expect(afterRedB.tddEvidenceHistory).toHaveLength(1);
    expect(afterRedB.tddEvidenceHistory[0]?.evidence).toEqual(before.tddEvidence);
    expect(afterRedB.tddEvidenceHistory[0]?.transition).toMatchObject({
      priorRedFingerprint: before.tddEvidence.red.fingerprint,
      replacementRedFingerprint: afterRedB.tddEvidence.red.fingerprint,
      fingerprint: { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });

    await writeFile(
      path.join(fixture.projectRoot, 'src', 'feature.ts'),
      'export const feature = () => "newer";\n',
    );
    const greenB = await runGreenCheck(fixture);
    expect(greenB.code, greenB.out).toBe(0);
    const recordedGreenB = await recordGreen(fixture);
    expect(recordedGreenB.code, recordedGreenB.out).toBe(0);

    await git(
      ['add', 'src/feature.ts', 'test/feature.test.ts', '.rig/claims/RP-306.json'],
      fixture.projectRoot,
    );
    await git(['commit', '-q', '-m', 'replace completed TDD evidence'], fixture.projectRoot);
    const ship = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      fixture.projectRoot,
      {
        ...fixture.trackerEnv,
        RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-completed-recovery-')),
      },
    );
    expect(ship.code, ship.out).toBe(0);
  });

  it('keeps the portable RED when the GREEN test file changed after RED', async () => {
    const fixture = await establishRed();
    await writeFile(
      path.join(fixture.projectRoot, 'src', 'feature.ts'),
      'export const feature = () => "new";\n',
    );
    await writeFile(
      fixture.testPath,
      "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n// amended after RED\n",
    );
    expect((await runGreenCheck(fixture)).code).toBe(0);

    const recorded = await recordGreen(fixture);
    expect(recorded.code).not.toBe(0);
    const claim = JSON.parse(
      await readFile(path.join(fixture.projectRoot, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    ) as {
      tddEvidence: { applicability: { level: string }; red: { test: Record<string, unknown> } };
    };
    expect(claim.tddEvidence.applicability.level).toBe('TDD-1');
    expect(claim.tddEvidence.red.test).toMatchObject({ fileSha256: fixture.testFileSha256 });
    expect(await sha256File(fixture.testPath)).not.toBe(fixture.testFileSha256);
  });
});
