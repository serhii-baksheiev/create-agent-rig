import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { jiraReadback } from './tdd-tracker-fixture.js';

// A RED record must carry a bounded, portable account of the state that was
// already present before it. A later controller must not need an ignored run
// directory, and an unrelated sibling run cannot stand in for this item.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const runJournal = path.join(scriptsDir, 'run-journal.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

const relevantSpec =
  'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns the replacement value"}';

type Result = { code: number; out: string };

const run = (file: string, args: string[], cwd: string, env = process.env): Promise<Result> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });

const git = async (args: string[], cwd: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.out.trim();
};

const writeSelection = async ({ runDir, ticket }: { runDir: string; ticket: string }) => {
  await mkdir(runDir, { recursive: true });
  const journal = (await import(pathToFileURL(runJournal).href)) as {
    recordDecision: (input: Record<string, unknown>) => unknown;
  };
  journal.recordDecision({
    runDir,
    gate: 'item-selection',
    verdict: `taken ${ticket}`,
    now: '2026-10-03T00:00:00.000Z',
  });
};

const writeDispatch = async ({
  runDir,
  ticket,
  agentRef,
  payloadTicket = ticket,
}: {
  runDir: string;
  ticket: string;
  agentRef: string;
  payloadTicket?: string;
}) => {
  await writeSelection({ runDir, ticket });
  const journal = (await import(pathToFileURL(runJournal).href)) as {
    recordEvent: (input: Record<string, unknown>) => unknown;
  };
  journal.recordEvent({
    runDir,
    kind: 'dispatch-start',
    data: { schema: 1, agentType: 'implementation-agent', agentRef, ticket: payloadTicket },
    now: '2026-10-03T00:00:01.000Z',
  });
};

const writeImplementationDispatch = async ({
  runDir,
  agentRef,
  payloadTicket,
  at,
}: {
  runDir: string;
  agentRef: string;
  payloadTicket: string;
  at: string;
}) => {
  const journal = (await import(pathToFileURL(runJournal).href)) as {
    recordEvent: (input: Record<string, unknown>) => unknown;
  };
  journal.recordEvent({
    runDir,
    kind: 'dispatch-start',
    data: { schema: 1, agentType: 'implementation-agent', agentRef, ticket: payloadTicket },
    now: at,
  });
};

const fixture = async ({
  predecessor = true,
  predecessorDispatches = 1,
  forgedPayloadTicket = false,
  unrelatedSibling = false,
}: {
  predecessor?: boolean;
  predecessorDispatches?: number;
  forgedPayloadTicket?: boolean;
  unrelatedSibling?: boolean;
} = {}) => {
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-producer-')));
  const runDir = path.join(projectRoot, '.claude', 'runs', '20261003-rp334');
  await mkdir(path.join(projectRoot, '.rig'), { recursive: true });
  await mkdir(path.join(projectRoot, '.claude'), { recursive: true });
  await mkdir(path.join(projectRoot, '.claude', 'scripts'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(projectRoot, '.rig', 'revalidation.json'),
    `${JSON.stringify({ schemaVersion: 1, detection: { mode: 'pull', sources: ['run-state', 'journal'], acceptedLatency: '24h', push: false }, pairedFacts: [] })}\n`,
  );
  await writeFile(
    path.join(projectRoot, 'src', 'feature.ts'),
    'export const feature = () => "old";\n',
  );
  await writeFile(path.join(projectRoot, 'src', 'tracked.ts'), 'export const tracked = "old";\n');
  await writeFile(
    path.join(projectRoot, '.claude', 'scripts', 'rig-production.mjs'),
    'export const rig = "old";\n',
  );
  await writeFile(
    path.join(projectRoot, '.claude', 'queue.json'),
    '{"adapter":"jira","options":{"project":"RP"}}\n',
  );
  await writeFile(
    path.join(projectRoot, 'vitest.config.mjs'),
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );
  await writeFile(path.join(projectRoot, '.gitignore'), '.claude/runs/\n');
  await git(['init', '-q', '-b', 'master'], projectRoot);
  await git(
    [
      'add',
      '.rig/revalidation.json',
      '.claude/queue.json',
      '.claude/scripts/rig-production.mjs',
      'src/feature.ts',
      'src/tracked.ts',
      'vitest.config.mjs',
      '.gitignore',
    ],
    projectRoot,
  );
  await git(['commit', '-q', '-m', 'baseline'], projectRoot);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
  await git(['checkout', '-q', '-b', 'feat/RP-334'], projectRoot);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
  };
  const ticket = {
    id: 'RP-334',
    state: 'open' as const,
    title: 'portable pre-RED producer',
    body: relevantSpec,
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
  const trackerEnv = await jiraReadback({ projectRoot, ticket });
  const predecessorRunId = '20261003-predecessor';

  await writeFile(
    path.join(projectRoot, 'src', 'committed.ts'),
    'export const committed = true;\n',
  );
  await git(['add', 'src/committed.ts'], projectRoot);
  await git(['commit', '-q', '-m', 'existing production commit'], projectRoot);
  await writeFile(path.join(projectRoot, 'src', 'staged.ts'), 'export const staged = true;\n');
  await git(['add', 'src/staged.ts'], projectRoot);
  await writeFile(
    path.join(projectRoot, 'src', 'untracked.ts'),
    'export const untracked = true;\n',
  );
  await writeFile(path.join(projectRoot, 'src', 'tracked.ts'), 'export const tracked = "new";\n');
  await writeFile(
    path.join(projectRoot, '.claude', 'scripts', 'rig-production.mjs'),
    'export const rig = "new";\n',
  );
  await mkdir(path.join(projectRoot, 'test'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n",
  );
  const predecessorRunDir = path.join(projectRoot, '.claude', 'runs', predecessorRunId);
  if (predecessor) {
    // This run worked other items before and after RP-334. Their forged
    // payload tickets must not override the native selection at each event.
    await writeSelection({ runDir: predecessorRunDir, ticket: 'RP-OTHER' });
    await writeImplementationDispatch({
      runDir: predecessorRunDir,
      agentRef: 'implementation-agent-before-rp334-selection',
      payloadTicket: 'RP-334',
      at: '2026-10-03T00:00:01.000Z',
    });
    await writeSelection({ runDir: predecessorRunDir, ticket: 'RP-334' });
    for (let index = 0; index < predecessorDispatches; index += 1) {
      await writeImplementationDispatch({
        runDir: predecessorRunDir,
        agentRef: `implementation-agent-before-red-${index}`,
        payloadTicket: forgedPayloadTicket ? 'RP-FORGED' : 'RP-334',
        at: `2026-10-03T00:00:0${index + 1}.000Z`,
      });
    }
    await writeSelection({ runDir: predecessorRunDir, ticket: 'RP-OTHER' });
    await writeImplementationDispatch({
      runDir: predecessorRunDir,
      agentRef: 'implementation-agent-after-rp334-selection',
      payloadTicket: 'RP-334',
      at: '2026-10-03T00:00:09.000Z',
    });
  }
  if (unrelatedSibling) {
    await writeDispatch({
      runDir: path.join(projectRoot, '.claude', 'runs', '20261003-unrelated'),
      ticket: 'RP-OTHER',
      agentRef: 'implementation-agent-for-other-ticket',
    });
  }

  const redJson = path.join(runDir, 'red.json');
  const check = await run(
    process.execPath,
    [
      checkRun,
      '--name',
      'unit-red',
      '--vitest-json',
      'red.json',
      '--',
      process.execPath,
      vitestCli,
      'run',
      '--root',
      projectRoot,
      '--config',
      path.join(projectRoot, 'vitest.config.mjs'),
      '--reporter=json',
      '--outputFile',
      redJson,
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
  expect(check.code, check.out).toBe(1);
  return { projectRoot, runDir, trackerEnv, baselineHeadSha, predecessorRunDir, predecessorRunId };
};

const recordRed = ({
  projectRoot,
  runDir,
  trackerEnv,
  predecessorRunIds = [],
}: {
  projectRoot: string;
  runDir: string;
  trackerEnv: NodeJS.ProcessEnv;
  predecessorRunIds?: string[];
}) =>
  run(
    process.execPath,
    [
      tddEvidence,
      'record-red',
      '--ticket',
      'RP-334',
      '--check',
      'unit-red',
      ...predecessorRunIds.flatMap((runId) => ['--predecessor-run', runId]),
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

it('records a bounded portable pre-RED production and dispatch boundary', async () => {
  const state = await fixture({
    predecessor: true,
    forgedPayloadTicket: true,
    unrelatedSibling: true,
  });
  const recorded = await recordRed({ ...state, predecessorRunIds: [state.predecessorRunId] });
  expect(recorded.code, recorded.out).toBe(0);
  const claim = JSON.parse(
    await readFile(path.join(state.projectRoot, '.rig', 'claims', 'RP-334.json'), 'utf8'),
  ) as {
    tddEvidence: {
      red?: { fingerprint?: unknown };
      preRed?: {
        baseline?: { headSha?: string };
        origin?: unknown;
        production?: { pathCount?: number; fingerprint?: { value?: string } };
        implementationAgentDispatch?: { count?: number; fingerprint?: { value?: string } };
        fingerprint?: { value?: string };
      };
    };
  };
  expect(claim.tddEvidence.preRed).toMatchObject({
    baseline: { headSha: state.baselineHeadSha },
    production: { pathCount: 5, fingerprint: { value: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    implementationAgentDispatch: {
      count: 1,
      fingerprint: { value: expect.stringMatching(/^[a-f0-9]{64}$/) },
    },
    fingerprint: { value: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  const portableProduction = JSON.stringify(claim.tddEvidence.preRed?.production);
  for (const rawPath of [
    'src/committed.ts',
    'src/staged.ts',
    'src/untracked.ts',
    'src/tracked.ts',
    '.claude/scripts/rig-production.mjs',
  ]) {
    expect(portableProduction).not.toContain(rawPath);
  }
  expect(claim.tddEvidence.preRed?.origin).toEqual({
    ticket: 'RP-334',
    baselineHeadSha: state.baselineHeadSha,
    redFingerprint: claim.tddEvidence.red?.fingerprint,
  });
}, 15_000);

it('fails closed on an in-flight mode change or an incomplete named predecessor journal', async () => {
  const [modeRace, incompleteDecisions, incompleteEvents] = await Promise.all([
    fixture({ predecessor: true, forgedPayloadTicket: true }),
    fixture({ predecessor: true }),
    fixture({ predecessor: true }),
  ]);
  const claimPath = path.join(modeRace.projectRoot, '.rig', 'claims', 'RP-334.json');
  const before = await readFile(claimPath);
  const preloadDir = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-mode-race-'));
  const preload = path.join(preloadDir, 'mode-race.cjs');
  const observed = path.join(preloadDir, 'observed.json');
  const target = path.join(modeRace.projectRoot, 'src', 'tracked.ts');
  await writeFile(
    preload,
    `const fs = require('node:fs');
const target = process.env.RP334_MODE_RACE_TARGET;
const observed = process.env.RP334_MODE_RACE_OBSERVED;
const originalLstat = fs.lstatSync;
const originalRealpath = fs.realpathSync;
const originalChmod = fs.chmodSync;
const originalWrite = fs.writeFileSync;
let changed = false;
fs.lstatSync = (file, ...args) => {
  const stat = originalLstat(file, ...args);
  if (!changed && originalRealpath(file) === originalRealpath(target)) {
    changed = true;
    const before = stat.mode & 0o777;
    originalChmod(target, before & ~0o222);
    const after = originalLstat(target).mode & 0o777;
    originalWrite(observed, JSON.stringify({ before, after }));
  }
  return stat;
};
require('node:module').syncBuiltinESMExports();
`,
  );
  let raced;
  try {
    raced = await recordRed({
      ...modeRace,
      predecessorRunIds: [modeRace.predecessorRunId],
      trackerEnv: {
        ...modeRace.trackerEnv,
        NODE_OPTIONS:
          `${modeRace.trackerEnv.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim(),
        RP334_MODE_RACE_TARGET: target,
        RP334_MODE_RACE_OBSERVED: observed,
      },
    });
  } finally {
    await chmod(target, 0o644);
  }
  expect(JSON.parse(await readFile(observed, 'utf8'))).toMatchObject({
    before: expect.any(Number),
    after: expect.any(Number),
  });
  const observedMode = JSON.parse(await readFile(observed, 'utf8')) as {
    before: number;
    after: number;
  };
  expect(observedMode.before).not.toBe(observedMode.after);
  expect(observedMode.after & 0o222).toBe(0);
  expect(raced?.code, raced?.out).toBe(2);
  expect(await readFile(claimPath)).toEqual(before);

  for (const [missingJournal, incomplete] of [
    ['decisions.jsonl', incompleteDecisions],
    ['events.jsonl', incompleteEvents],
  ] as const) {
    const isolatedPredecessorRunId = `20261003-isolated-${missingJournal}`;
    const isolatedPredecessorRunDir = path.join(
      incomplete.projectRoot,
      '.claude',
      'runs',
      isolatedPredecessorRunId,
    );
    await writeDispatch({
      runDir: isolatedPredecessorRunDir,
      ticket: 'RP-334',
      agentRef: 'implementation-agent-isolated-predecessor',
    });
    const incompleteClaimPath = path.join(incomplete.projectRoot, '.rig', 'claims', 'RP-334.json');
    const incompleteBefore = await readFile(incompleteClaimPath);
    const decisionRecords = (
      await readFile(path.join(isolatedPredecessorRunDir, 'decisions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const eventRecords = (
      await readFile(path.join(isolatedPredecessorRunDir, 'events.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(decisionRecords).toHaveLength(1);
    expect(decisionRecords[0]).toMatchObject({
      seq: 1,
      gate: 'item-selection',
      verdict: 'taken RP-334',
    });
    expect(eventRecords).toHaveLength(1);
    expect(eventRecords[0]).toMatchObject({ seq: 2, kind: 'dispatch-start' });
    await removeFixture(path.join(isolatedPredecessorRunDir, missingJournal));
    if (missingJournal === 'events.jsonl') {
      const remainingDecisions = (
        await readFile(path.join(isolatedPredecessorRunDir, 'decisions.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(remainingDecisions).toHaveLength(1);
      expect(remainingDecisions[0]).toMatchObject({
        seq: 1,
        gate: 'item-selection',
        verdict: 'taken RP-334',
      });
    }
    const incompleteRecorded = await recordRed({
      ...incomplete,
      predecessorRunIds: [isolatedPredecessorRunId],
    });
    expect(incompleteRecorded.code, incompleteRecorded.out).toBe(2);
    expect(await readFile(incompleteClaimPath)).toEqual(incompleteBefore);
  }
}, 15_000);

it('bounds named predecessor journal enumeration and allocation before writing the claim', async () => {
  const aggregate = await fixture({ predecessor: true });
  const aggregateRunIds = ['20261003-aggregate-first', '20261003-aggregate-second'];
  for (const runId of aggregateRunIds) {
    const runDir = path.join(aggregate.projectRoot, '.claude', 'runs', runId);
    await writeDispatch({
      runDir,
      ticket: 'RP-334',
      agentRef: `implementation-agent-${runId}`,
    });
    const decisionsJournal = await readFile(path.join(runDir, 'decisions.jsonl'), 'utf8');
    const eventsJournal = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    const decisions = decisionsJournal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const [nativeDispatch] = eventsJournal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(Buffer.byteLength(decisionsJournal)).toBeLessThan(5 * 1024 * 1024);
    expect(Buffer.byteLength(eventsJournal)).toBeLessThan(5 * 1024 * 1024);
    expect(decisions).toEqual([
      expect.objectContaining({ seq: 1, gate: 'item-selection', verdict: 'taken RP-334' }),
    ]);
    expect(nativeDispatch).toMatchObject({
      seq: 2,
      kind: 'dispatch-start',
      data: { schema: 1, agentType: 'implementation-agent' },
    });
    await writeFile(
      path.join(runDir, 'events.jsonl'),
      Array.from({ length: 599 }, (_, index) =>
        JSON.stringify({ ...nativeDispatch, seq: index + 3 }),
      ).join('\n') + '\n',
      { flag: 'a' },
    );
    const boundedEventsJournal = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    const boundedEvents = boundedEventsJournal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(Buffer.byteLength(boundedEventsJournal)).toBeLessThan(5 * 1024 * 1024);
    expect(boundedEvents).toHaveLength(600);
    expect(
      boundedEvents.every(
        (event, index) =>
          event?.seq === index + 2 &&
          event?.kind === 'dispatch-start' &&
          event?.data?.schema === 1 &&
          event?.data?.agentType === 'implementation-agent',
      ),
    ).toBe(true);
  }
  const aggregateClaimPath = path.join(aggregate.projectRoot, '.rig', 'claims', 'RP-334.json');
  const aggregateBefore = await readFile(aggregateClaimPath);
  const aggregatePreloadDir = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-aggregate-'));
  const aggregatePreload = path.join(aggregatePreloadDir, 'aggregate.cjs');
  const aggregateObserved = path.join(aggregatePreloadDir, 'observed.json');
  await writeFile(
    aggregatePreload,
    `const fs = require('node:fs');
const runIds = new Set(JSON.parse(process.env.RP334_AGGREGATE_RUN_IDS));
const observed = process.env.RP334_AGGREGATE_OBSERVED;
const originalPush = Array.prototype.push;
const originalWrite = fs.writeFileSync;
let allocations = 0;
Array.prototype.push = function (...items) {
  for (const value of items) {
    if (
      value &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).length === 2 &&
      typeof value.runId === 'string' &&
      runIds.has(value.runId) &&
      Number.isSafeInteger(value.seq)
    ) allocations += 1;
  }
  return originalPush.apply(this, items);
};
process.on('exit', () => originalWrite(observed, JSON.stringify({ allocations })));
`,
  );
  const aggregateRecorded = await recordRed({
    ...aggregate,
    predecessorRunIds: aggregateRunIds,
    trackerEnv: {
      ...aggregate.trackerEnv,
      NODE_OPTIONS:
        `${aggregate.trackerEnv.NODE_OPTIONS ?? ''} --require ${JSON.stringify(aggregatePreload)}`.trim(),
      RP334_AGGREGATE_RUN_IDS: JSON.stringify(aggregateRunIds),
      RP334_AGGREGATE_OBSERVED: aggregateObserved,
    },
  });
  expect(JSON.parse(await readFile(aggregateObserved, 'utf8')).allocations).toBeLessThanOrEqual(
    1024,
  );
  expect(aggregateRecorded.code, aggregateRecorded.out).toBe(2);
  expect(await readFile(aggregateClaimPath)).toEqual(aggregateBefore);
}, 15_000);

it('binds staged index bytes and rejects origin, ancestry, and predecessor-directory substitution', async () => {
  // Both copies share one selected baseline. Their working trees are byte-for-byte
  // equal; only the staged blob for a Windows-valid bracketed path differs, so a
  // production packet must distinguish them without treating that path as a glob.
  const [stagedFirst, ancestorState, swappedState] = await Promise.all([
    fixture({ predecessor: true, forgedPayloadTicket: true }),
    fixture({ predecessor: true, forgedPayloadTicket: true }),
    fixture({ predecessor: true, forgedPayloadTicket: true }),
  ]);
  const stagedCloneParent = await realpath(
    await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-staged-clone-')),
  );
  const stagedSecondRoot = path.join(stagedCloneParent, 'project');
  await cp(stagedFirst.projectRoot, stagedSecondRoot, { recursive: true });
  const stagedSecond = {
    ...stagedFirst,
    projectRoot: stagedSecondRoot,
    runDir: path.join(stagedSecondRoot, '.claude', 'runs', '20261003-rp334'),
    predecessorRunDir: path.join(stagedSecondRoot, '.claude', 'runs', stagedFirst.predecessorRunId),
  };
  const stagedWorkingBytes = 'export const staged = "same working tree";\n';
  await writeFile(path.join(stagedFirst.projectRoot, 'src', 'staged.ts'), stagedWorkingBytes);
  const bracketedStagedPath = path.join('src', '[ab].ts');
  await writeFile(path.join(stagedFirst.projectRoot, bracketedStagedPath), stagedWorkingBytes);
  await git(['add', bracketedStagedPath], stagedFirst.projectRoot);
  await writeFile(path.join(stagedSecond.projectRoot, 'src', 'staged.ts'), stagedWorkingBytes);
  await writeFile(
    path.join(stagedSecond.projectRoot, bracketedStagedPath),
    'export const staged = "other bracketed index blob";\n',
  );
  await git(['add', bracketedStagedPath], stagedSecond.projectRoot);
  await writeFile(path.join(stagedSecond.projectRoot, bracketedStagedPath), stagedWorkingBytes);
  const stagedSecondRedJson = path.join(stagedSecond.runDir, 'red.json');
  const stagedSecondCheck = await run(
    process.execPath,
    [
      checkRun,
      '--name',
      'unit-red',
      '--vitest-json',
      'red.json',
      '--',
      process.execPath,
      vitestCli,
      'run',
      '--root',
      stagedSecond.projectRoot,
      '--config',
      path.join(stagedSecond.projectRoot, 'vitest.config.mjs'),
      '--reporter=json',
      '--outputFile',
      stagedSecondRedJson,
    ],
    stagedSecond.projectRoot,
    { ...stagedSecond.trackerEnv, RIG_RUN_DIR: stagedSecond.runDir },
  );
  expect(stagedSecondCheck.code, stagedSecondCheck.out).toBe(1);
  const stagedFirstRecorded = await recordRed({
    ...stagedFirst,
    predecessorRunIds: [stagedFirst.predecessorRunId],
  });
  const stagedSecondRecorded = await recordRed({
    ...stagedSecond,
    predecessorRunIds: [stagedSecond.predecessorRunId],
  });
  expect(stagedFirstRecorded.code, stagedFirstRecorded.out).toBe(0);
  expect(stagedSecondRecorded.code, stagedSecondRecorded.out).toBe(0);
  const stagedFirstClaim = JSON.parse(
    await readFile(path.join(stagedFirst.projectRoot, '.rig', 'claims', 'RP-334.json'), 'utf8'),
  ) as {
    tddEvidence: {
      preRed: {
        baseline: unknown;
        origin: unknown;
        production: { fingerprint: { value: string } };
        implementationAgentDispatch: unknown;
        fingerprint: unknown;
      };
    };
  };
  const stagedSecondClaim = JSON.parse(
    await readFile(path.join(stagedSecond.projectRoot, '.rig', 'claims', 'RP-334.json'), 'utf8'),
  ) as { tddEvidence: { preRed: { production: { fingerprint: { value: string } } } } };

  const evidenceLibrary = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'tdd-evidence.mjs')).href
  )) as {
    fingerprintEvidence: (input: unknown) => { algorithm: 'sha256'; value: string };
    validatePortableEvidence: (record: unknown) => { ok: boolean };
  };
  const originlessPreRed = {
    baseline: stagedFirstClaim.tddEvidence.preRed.baseline,
    production: stagedFirstClaim.tddEvidence.preRed.production,
    implementationAgentDispatch: stagedFirstClaim.tddEvidence.preRed.implementationAgentDispatch,
  };
  const rehashedOriginlessPreRed = {
    ...originlessPreRed,
    fingerprint: evidenceLibrary.fingerprintEvidence({
      baseline: originlessPreRed.baseline,
      production: originlessPreRed.production,
      implementationAgentDispatch: originlessPreRed.implementationAgentDispatch,
    }),
  };
  const originlessValidation = evidenceLibrary.validatePortableEvidence({
    ...stagedFirstClaim.tddEvidence,
    preRed: rehashedOriginlessPreRed,
  });
  const legacyTdd0 = {
    schemaVersion: 1,
    ticket: 'RP-334',
    applicability: { level: 'TDD-0', authority: { kind: 'path-contract', id: 'RP-334' } },
    baseline: { headSha: stagedFirst.baselineHeadSha },
  };
  const legacyTdd0Validation = evidenceLibrary.validatePortableEvidence(legacyTdd0);
  const tdd0PacketValidation = evidenceLibrary.validatePortableEvidence({
    ...legacyTdd0,
    preRed: stagedFirstClaim.tddEvidence.preRed,
  });

  const ancestorClaimPath = path.join(ancestorState.projectRoot, '.rig', 'claims', 'RP-334.json');
  const ancestorBefore = await readFile(ancestorClaimPath);
  const sourceDirectory = path.join(ancestorState.projectRoot, 'src');
  const externalSourceParent = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-external-source-'));
  const externalSource = path.join(externalSourceParent, 'src');
  await rename(sourceDirectory, externalSource);
  await symlink(externalSource, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await lstat(sourceDirectory)).isSymbolicLink()).toBe(true);
  let ancestorRecorded: Result | undefined;
  try {
    ancestorRecorded = await recordRed({
      ...ancestorState,
      predecessorRunIds: [ancestorState.predecessorRunId],
    });
  } finally {
    await removeFixture(sourceDirectory);
    await rename(externalSource, sourceDirectory);
  }
  const ancestorRejected =
    ancestorRecorded?.code === 2 && (await readFile(ancestorClaimPath)).equals(ancestorBefore);

  const swapClaimPath = path.join(swappedState.projectRoot, '.rig', 'claims', 'RP-334.json');
  const swapBefore = await readFile(swapClaimPath);
  const externalRunDir = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-external-run-'));
  await writeDispatch({
    runDir: externalRunDir,
    ticket: 'RP-334',
    agentRef: 'implementation-agent-external-run',
  });
  const swappedBackup = path.join(
    swappedState.projectRoot,
    '.claude',
    'runs',
    '20261003-predecessor-before-swap',
  );
  const swapPreloadDir = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-run-swap-'));
  const swapPreload = path.join(swapPreloadDir, 'run-swap.cjs');
  const swapObserved = path.join(swapPreloadDir, 'observed.json');
  await writeFile(
    swapPreload,
    `const fs = require('node:fs');
const target = process.env.RP334_SWAP_TARGET;
const external = process.env.RP334_SWAP_EXTERNAL;
const backup = process.env.RP334_SWAP_BACKUP;
const observed = process.env.RP334_SWAP_OBSERVED;
const linkType = process.env.RP334_SWAP_LINK_TYPE;
const originalLstat = fs.lstatSync;
const originalRename = fs.renameSync;
const originalSymlink = fs.symlinkSync;
const originalWrite = fs.writeFileSync;
const originalRealpath = fs.realpathSync;
let swapped = false;
fs.lstatSync = (file, ...args) => {
  const stat = originalLstat(file, ...args);
  if (!swapped && originalRealpath(file) === originalRealpath(target)) {
    originalRename(target, backup);
    originalSymlink(external, target, linkType);
    swapped = true;
    originalWrite(observed, JSON.stringify({ swapped }));
  }
  return stat;
};
require('node:module').syncBuiltinESMExports();
`,
  );
  let swappedRecorded: Result | undefined;
  let swapObservation: { swapped?: boolean } | undefined;
  try {
    swappedRecorded = await recordRed({
      ...swappedState,
      predecessorRunIds: [swappedState.predecessorRunId],
      trackerEnv: {
        ...swappedState.trackerEnv,
        NODE_OPTIONS:
          `${swappedState.trackerEnv.NODE_OPTIONS ?? ''} --require ${JSON.stringify(swapPreload)}`.trim(),
        RP334_SWAP_TARGET: swappedState.predecessorRunDir,
        RP334_SWAP_EXTERNAL: externalRunDir,
        RP334_SWAP_BACKUP: swappedBackup,
        RP334_SWAP_OBSERVED: swapObserved,
        RP334_SWAP_LINK_TYPE: process.platform === 'win32' ? 'junction' : 'dir',
      },
    });
    swapObservation = JSON.parse(await readFile(swapObserved, 'utf8')) as { swapped?: boolean };
  } finally {
    if (swapObservation?.swapped) {
      await removeFixture(swappedState.predecessorRunDir);
      await rename(swappedBackup, swappedState.predecessorRunDir);
    }
  }
  expect(swapObservation).toEqual({ swapped: true });
  const swappedRunRejected =
    swappedRecorded?.code === 2 && (await readFile(swapClaimPath)).equals(swapBefore);
  expect({
    stagedIndexFingerprintBound:
      stagedFirstClaim.tddEvidence.preRed.production.fingerprint.value !==
      stagedSecondClaim.tddEvidence.preRed.production.fingerprint.value,
    originlessPacketRejected: !originlessValidation.ok,
    ordinaryTdd0WithoutPacketValid: legacyTdd0Validation.ok,
    tdd0PacketRejected: !tdd0PacketValidation.ok,
    symlinkAncestorRejected: ancestorRejected,
    predecessorDirectorySwapRejected: swappedRunRejected,
  }).toEqual({
    stagedIndexFingerprintBound: true,
    originlessPacketRejected: true,
    ordinaryTdd0WithoutPacketValid: true,
    tdd0PacketRejected: true,
    symlinkAncestorRejected: true,
    predecessorDirectorySwapRejected: true,
  });
}, 15_000);

it('rejects forged or malformed native selection and dispatch records before claim replacement', async () => {
  const [forgedSelectionState, forgedDispatchState] = await Promise.all([
    fixture({ predecessor: true }),
    fixture({ predecessor: true }),
  ]);
  const forgedSelectionRunId = '20261003-forged-event-selection';
  const forgedSelectionRunDir = path.join(
    forgedSelectionState.projectRoot,
    '.claude',
    'runs',
    forgedSelectionRunId,
  );
  await writeSelection({ runDir: forgedSelectionRunDir, ticket: 'RP-OTHER' });
  await writeFile(
    path.join(forgedSelectionRunDir, 'events.jsonl'),
    `${JSON.stringify({
      seq: 2,
      at: '2026-10-03T00:00:01.000Z',
      gate: 'item-selection',
      verdict: 'taken RP-334',
      why: null,
    })}\n`,
  );
  await writeImplementationDispatch({
    runDir: forgedSelectionRunDir,
    agentRef: 'implementation-agent-after-forged-event-selection',
    payloadTicket: 'RP-OTHER',
    at: '2026-10-03T00:00:02.000Z',
  });
  const forgedSelectionClaimPath = path.join(
    forgedSelectionState.projectRoot,
    '.rig',
    'claims',
    'RP-334.json',
  );
  const forgedSelectionBefore = await readFile(forgedSelectionClaimPath);
  const forgedSelectionRecorded = await recordRed({
    ...forgedSelectionState,
    predecessorRunIds: [forgedSelectionRunId],
  });
  const forgedSelectionRejected =
    forgedSelectionRecorded.code === 2 &&
    (await readFile(forgedSelectionClaimPath)).equals(forgedSelectionBefore);

  const forgedDispatchRunId = '20261003-forged-decision-dispatch';
  const forgedDispatchRunDir = path.join(
    forgedDispatchState.projectRoot,
    '.claude',
    'runs',
    forgedDispatchRunId,
  );
  await writeSelection({ runDir: forgedDispatchRunDir, ticket: 'RP-334' });
  await writeFile(
    path.join(forgedDispatchRunDir, 'decisions.jsonl'),
    `${JSON.stringify({
      seq: 2,
      at: '2026-10-03T00:00:01.000Z',
      kind: 'dispatch-start',
      data: {
        schema: 1,
        agentType: 'implementation-agent',
        agentRef: 'implementation-agent-forged-decision-dispatch',
        ticket: 'RP-334',
      },
    })}\n`,
    { flag: 'a' },
  );
  await writeFile(path.join(forgedDispatchRunDir, 'events.jsonl'), '');
  const forgedDispatchClaimPath = path.join(
    forgedDispatchState.projectRoot,
    '.rig',
    'claims',
    'RP-334.json',
  );
  const forgedDispatchBefore = await readFile(forgedDispatchClaimPath);
  const forgedDispatchRecorded = await recordRed({
    ...forgedDispatchState,
    predecessorRunIds: [forgedDispatchRunId],
  });
  const forgedDispatchRejected =
    forgedDispatchRecorded.code === 2 &&
    (await readFile(forgedDispatchClaimPath)).equals(forgedDispatchBefore);

  const malformedDispatchState = await fixture({ predecessor: true });
  const malformedDispatchRunId = '20261003-malformed-event-dispatch';
  const malformedDispatchRunDir = path.join(
    malformedDispatchState.projectRoot,
    '.claude',
    'runs',
    malformedDispatchRunId,
  );
  await writeSelection({ runDir: malformedDispatchRunDir, ticket: 'RP-334' });
  await writeFile(
    path.join(malformedDispatchRunDir, 'events.jsonl'),
    `${JSON.stringify({
      seq: 2,
      at: '2026-10-03T00:00:01.000Z',
      kind: 'dispatch-start',
      data: { schema: 2, agentType: 'implementation-agent' },
    })}\n`,
  );
  const malformedDispatchClaimPath = path.join(
    malformedDispatchState.projectRoot,
    '.rig',
    'claims',
    'RP-334.json',
  );
  const malformedDispatchBefore = await readFile(malformedDispatchClaimPath);
  const malformedDispatchRecorded = await recordRed({
    ...malformedDispatchState,
    predecessorRunIds: [malformedDispatchRunId],
  });
  const malformedEventDispatchRejected =
    malformedDispatchRecorded.code === 2 &&
    (await readFile(malformedDispatchClaimPath)).equals(malformedDispatchBefore);

  expect({
    eventFileSelectionRejectedBeforeClaimReplace: forgedSelectionRejected,
    decisionFileDispatchRejectedBeforeClaimReplace: forgedDispatchRejected,
    malformedEventDispatchRejectedBeforeClaimReplace: malformedEventDispatchRejected,
  }).toEqual({
    eventFileSelectionRejectedBeforeClaimReplace: true,
    decisionFileDispatchRejectedBeforeClaimReplace: true,
    malformedEventDispatchRejectedBeforeClaimReplace: true,
  });
}, 15_000);

it('fails closed when the selected item has no readable prior dispatch history', async () => {
  const state = await fixture({ predecessor: false });
  const recorded = await recordRed({ ...state, predecessorRunIds: [state.predecessorRunId] });
  expect(recorded.code, recorded.out).toBe(2);
  const claim = JSON.parse(
    await readFile(path.join(state.projectRoot, '.rig', 'claims', 'RP-334.json'), 'utf8'),
  ) as { tddEvidence?: unknown };
  expect(claim.tddEvidence).toBeUndefined();
});

it('fails closed without changing the claim when the selected predecessor journal grows while it is read', async () => {
  const state = await fixture({ predecessor: true });
  const claimPath = path.join(state.projectRoot, '.rig', 'claims', 'RP-334.json');
  const before = await readFile(claimPath);
  const preloadDir = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-growth-'));
  const preload = path.join(preloadDir, 'grow-journal.cjs');
  const observed = path.join(preloadDir, 'observed');
  await writeFile(
    preload,
    `const fs = require('node:fs');
const target = process.env.RP334_GROWING_JOURNAL;
const observed = process.env.RP334_GROWTH_OBSERVED;
const originalOpen = fs.openSync;
const originalFstat = fs.fstatSync;
const originalAppend = fs.appendFileSync;
const originalWrite = fs.writeFileSync;
const originalRealpath = fs.realpathSync;
let targetFd = null;
let grew = false;
fs.openSync = (file, ...args) => {
  const fd = originalOpen(file, ...args);
  if (originalRealpath(file) === originalRealpath(target)) targetFd = fd;
  return fd;
};
fs.fstatSync = (fd, ...args) => {
  const stat = originalFstat(fd, ...args);
  if (!grew && fd === targetFd) {
    grew = true;
    originalAppend(target, 'x');
    originalWrite(observed, 'grew');
  }
  return stat;
};
require('node:module').syncBuiltinESMExports();
`,
  );
  const recorded = await recordRed({
    ...state,
    predecessorRunIds: [state.predecessorRunId],
    trackerEnv: {
      ...state.trackerEnv,
      NODE_OPTIONS:
        `${state.trackerEnv.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim(),
      RP334_GROWING_JOURNAL: path.join(state.predecessorRunDir, 'events.jsonl'),
      RP334_GROWTH_OBSERVED: observed,
    },
  });
  expect(recorded.code, recorded.out).toBe(2);
  expect(await readFile(observed, 'utf8')).toBe('grew');
  expect(await readFile(claimPath)).toEqual(before);
});

it('fails closed before changing the claim when a named predecessor journal exceeds the admission byte bound', async () => {
  const state = await fixture({ predecessor: true });
  const claimPath = path.join(state.projectRoot, '.rig', 'claims', 'RP-334.json');
  const before = await readFile(claimPath);
  await writeFile(path.join(state.predecessorRunDir, 'events.jsonl'), 'x'.repeat(6 * 1024 * 1024), {
    flag: 'a',
  });
  const recorded = await recordRed({ ...state, predecessorRunIds: [state.predecessorRunId] });
  expect(recorded.code, recorded.out).toBe(2);
  expect(await readFile(claimPath)).toEqual(before);
});

it('records zero or multiple selected implementation dispatches without treating evidence capture as enforcement', async () => {
  for (const predecessorDispatches of [0, 2]) {
    const state = await fixture({ predecessor: true, predecessorDispatches });
    const recorded = await recordRed({
      ...state,
      predecessorRunIds: [state.predecessorRunId],
    });
    expect(recorded.code, recorded.out).toBe(0);
    const claim = JSON.parse(
      await readFile(path.join(state.projectRoot, '.rig', 'claims', 'RP-334.json'), 'utf8'),
    ) as { tddEvidence: { preRed: { implementationAgentDispatch: { count: number } } } };
    expect(claim.tddEvidence.preRed.implementationAgentDispatch.count).toBe(predecessorDispatches);
  }
});

it('changes the portable production state fingerprint when content or mode changes under the same paths', async () => {
  const contentState = await fixture({ predecessor: true, forgedPayloadTicket: true });
  const contentRecorded = await recordRed({
    ...contentState,
    predecessorRunIds: [contentState.predecessorRunId],
  });
  expect(contentRecorded.code, contentRecorded.out).toBe(0);
  const contentClaim = JSON.parse(
    await readFile(path.join(contentState.projectRoot, '.rig', 'claims', 'RP-334.json'), 'utf8'),
  ) as { tddEvidence: { preRed: { production: { fingerprint: { value: string } } } } };

  const modeState = await fixture({ predecessor: true, forgedPayloadTicket: true });
  await writeFile(
    path.join(modeState.projectRoot, 'src', 'untracked.ts'),
    'export const untracked = false;\n',
  );
  await chmod(path.join(modeState.projectRoot, '.claude', 'scripts', 'rig-production.mjs'), 0o755);
  const modeRecorded = await recordRed({
    ...modeState,
    predecessorRunIds: [modeState.predecessorRunId],
  });
  expect(modeRecorded.code, modeRecorded.out).toBe(0);
  const modeClaim = JSON.parse(
    await readFile(path.join(modeState.projectRoot, '.rig', 'claims', 'RP-334.json'), 'utf8'),
  ) as { tddEvidence: { preRed: { production: { fingerprint: { value: string } } } } };

  expect(modeClaim.tddEvidence.preRed.production.fingerprint.value).not.toBe(
    contentClaim.tddEvidence.preRed.production.fingerprint.value,
  );
});

it('continues from a validated portable predecessor packet after the origin journal is gone', async () => {
  const state = await fixture({ predecessor: true, forgedPayloadTicket: true });
  const first = await recordRed({ ...state, predecessorRunIds: [state.predecessorRunId] });
  expect(first.code, first.out).toBe(0);
  const claimPath = path.join(state.projectRoot, '.rig', 'claims', 'RP-334.json');
  const firstClaim = JSON.parse(await readFile(claimPath, 'utf8')) as {
    tddEvidence: { red: { fingerprint: unknown }; preRed: { origin: unknown } };
  };

  await removeFixture(state.predecessorRunDir);
  await writeFile(
    path.join(state.projectRoot, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n// fresh continuation test bytes\n",
  );
  const continuation = await recordRed(state);
  expect(continuation.code, continuation.out).toBe(0);
  const continuationClaim = JSON.parse(await readFile(claimPath, 'utf8')) as {
    tddEvidence: { preRed: { origin: unknown } };
    tddEvidenceHistory?: Array<{ evidence?: { red?: { fingerprint?: unknown } } }>;
  };
  expect(continuationClaim.tddEvidence.preRed.origin).toEqual(firstClaim.tddEvidence.preRed.origin);
  expect(continuationClaim.tddEvidenceHistory).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        evidence: expect.objectContaining({
          red: expect.objectContaining({ fingerprint: firstClaim.tddEvidence.red.fingerprint }),
        }),
      }),
    ]),
  );
});

it('HOLDs an otherwise valid selected claim whose portable predecessor origin was transplanted from another ticket', async () => {
  const state = await fixture({ predecessor: true, forgedPayloadTicket: true });
  const first = await recordRed({ ...state, predecessorRunIds: [state.predecessorRunId] });
  expect(first.code, first.out).toBe(0);
  const claimPath = path.join(state.projectRoot, '.rig', 'claims', 'RP-334.json');
  const transplanted = JSON.parse(await readFile(claimPath, 'utf8')) as {
    tddEvidence: { preRed: { origin: { ticket: string } } };
  };
  transplanted.tddEvidence.preRed.origin.ticket = 'RP-OTHER';
  await writeFile(claimPath, `${JSON.stringify(transplanted, null, 2)}\n`);
  const before = await readFile(claimPath);
  await writeFile(
    path.join(state.projectRoot, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n// cross-ticket transplant probe\n",
  );
  const rejected = await recordRed(state);
  expect(rejected.code, rejected.out).toBe(2);
  expect(await readFile(claimPath)).toEqual(before);
});
