import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-554 protocol negative controls. These faults exercise the Node CLI
// boundary only; they do not stand in for native/provider acceptance.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, '.claude', 'scripts', 'git-env.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const load = (file: string) =>
  import(
    `${pathToFileURL(path.join(queueDir, file)).href}?rp554protocol=${Date.now()}-${Math.random()}`
  );
const T0 = '2026-11-28T00:00:00.000Z';
const ticket = {
  id: 'RP-554',
  title: 'native invocation failure fixture',
  state: 'open',
  labels: [],
  blockedBy: [],
  blocks: [],
  priority: 1,
  createdAt: T0,
  updatedAt: T0,
};

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    env: withoutGitLocation(),
    timeout: 30_000,
  }).trim();

const selectedNativeFixture = async (roots: string[]) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rp554-admission-protocol-'));
  roots.push(root);
  git(['init', '-q', '-b', 'master'], root);
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await writeFile(
    path.join(root, '.rig', 'revalidation.json'),
    JSON.stringify({
      schemaVersion: 1,
      detection: {
        mode: 'pull',
        sources: ['run-state', 'journal'],
        acceptedLatency: '24h',
        push: false,
      },
      pairedFacts: [],
    }),
  );
  git(['add', '.rig/revalidation.json'], root);
  git(['commit', '-q', '-m', 'seed'], root);
  const claims = await import(
    `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554protocol=${Date.now()}-${Math.random()}`
  );
  const selected = claims.revalidateClaim({
    projectRoot: root,
    ticket,
    point: 'SELECT',
    claimedState: 'in-progress',
    targetSha: claims.targetShaOf(root),
    allowCreate: true,
    isResume: false,
  });
  expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
  git(['add', '.rig/claims/RP-554.json'], root);
  git(['commit', '-q', '-m', 'record selected baseline'], root);
  const runDir = path.join(root, '.claude', 'runs', 'rp554-protocol');
  await mkdir(runDir, { recursive: true });
  const journal = await import(
    `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554protocol=${Date.now()}-${Math.random()}`
  );
  journal.recordDecision({
    runDir,
    gate: 'item-selection',
    verdict: 'taken RP-554',
    why: ticket.title,
    now: T0,
  });
  journal.recordEvent({
    runDir,
    kind: 'revalidation',
    data: { ...selected, task: { from: null, to: ticket.updatedAt } },
    now: T0,
  });
  return { root, runDir };
};

const claimWithNegativeOnlyNativeFault = async ({
  roots,
  exitCode,
  stdout,
}: {
  roots: string[];
  exitCode: number;
  stdout: string;
}) => {
  const { root, runDir } = await selectedNativeFixture(roots);
  const preloadDir = await mkdtemp(path.join(tmpdir(), 'rp554-negative-only-native-fault-'));
  roots.push(preloadDir);
  const preload = path.join(preloadDir, 'native-fault.mjs');
  const marker = path.join(root, 'native-fault-marker');
  const bait = `RP554-NATIVE-CHILD-BAIT:${preloadDir}`;
  await writeFile(
    preload,
    [
      "import { writeFileSync } from 'node:fs';",
      '// NEGATIVE-ONLY: alter no process except the native duplicate-work child.',
      "if (process.argv[1]?.endsWith('duplicate-work.mjs')) {",
      `  writeFileSync(${JSON.stringify(marker)}, 'fault injected\\n');`,
      `  process.stdout.write(${JSON.stringify(stdout)});`,
      `  process.stderr.write(${JSON.stringify(bait)});`,
      `  process.exit(${exitCode});`,
      '}',
    ].join('\n'),
  );
  let trackerWrites = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
    if (
      String(init.method ?? 'GET') === 'POST' &&
      new URL(String(input)).pathname.endsWith('/transitions')
    ) {
      trackerWrites += 1;
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: '',
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          fields: {
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            updated: T0,
            assignee: null,
          },
        }),
      text: () => Promise.resolve('{}'),
    });
  }) as unknown as typeof globalThis.fetch;
  try {
    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      projectRoot: root,
      env: {
        ...process.env,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'fixture@example.invalid',
        JIRA_API_TOKEN: 'fixture-token',
        RIG_RUN_DIR: runDir,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
    });
    return { bait, marker, preloadDir, result, trackerWrites };
  } finally {
    globalThis.fetch = fetchBefore;
  }
};

describe('claim admission native protocol (RP-554)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it('refuses an exit-1 native duplicate-work invocation with a closed diagnostic and no tracker write', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-admission-protocol-'));
    roots.push(root);
    git(['init', '-q', '-b', 'master'], root);
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      JSON.stringify({
        schemaVersion: 1,
        detection: {
          mode: 'pull',
          sources: ['run-state', 'journal'],
          acceptedLatency: '24h',
          push: false,
        },
        pairedFacts: [],
      }),
    );
    git(['add', '.rig/revalidation.json'], root);
    git(['commit', '-q', '-m', 'seed'], root);

    const claims = await import(
      `${pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href}?rp554protocol=${Date.now()}-${Math.random()}`
    );
    const selected = claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: claims.targetShaOf(root),
      allowCreate: true,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('BASELINE_CREATED');
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record selected baseline'], root);

    const runDir = path.join(root, '.claude', 'runs', 'rp554-protocol');
    await mkdir(runDir, { recursive: true });
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?rp554protocol=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-554',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: ticket.updatedAt } },
      now: T0,
    });

    const preloadDir = await mkdtemp(path.join(tmpdir(), 'rp554-negative-only-native-fault-'));
    roots.push(preloadDir);
    const preload = path.join(preloadDir, 'exit-1.mjs');
    const marker = path.join(root, 'native-fault-marker');
    const bait = `RP554-NATIVE-CHILD-BAIT:${preloadDir}`;
    await writeFile(
      preload,
      [
        "import { writeFileSync } from 'node:fs';",
        '// NEGATIVE-ONLY: alter no process except the native duplicate-work child.',
        "if (process.argv[1]?.endsWith('duplicate-work.mjs')) {",
        `  writeFileSync(${JSON.stringify(marker)}, 'exit-1 injected\\n');`,
        `  process.stderr.write(${JSON.stringify(bait)});`,
        '  process.exit(1);',
        '}',
      ].join('\n'),
    );

    let trackerWrites = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      if (
        String(init.method ?? 'GET') === 'POST' &&
        new URL(String(input)).pathname.endsWith('/transitions')
      ) {
        trackerWrites += 1;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            fields: {
              status: { name: 'To Do', statusCategory: { key: 'new' } },
              updated: T0,
              assignee: null,
            },
          }),
        text: () => Promise.resolve('{}'),
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        projectRoot: root,
        env: {
          ...process.env,
          JIRA_BASE_URL: 'https://example.invalid',
          JIRA_EMAIL: 'fixture@example.invalid',
          JIRA_API_TOKEN: 'fixture-token',
          RIG_RUN_DIR: runDir,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
      });

      expect(existsSync(marker)).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        claimed: false,
        reason: 'claim-unverifiable',
        admission: 'unverifiable',
        diagnostic: 'native-invocation-failed',
      });
      expect(JSON.stringify(result)).not.toContain(bait);
      expect(JSON.stringify(result)).not.toContain(preloadDir);
      expect(trackerWrites).toBe(0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it('refuses an exit-3 native response whose stdout is truncated JSON as a protocol failure', async () => {
    const stdout = '{"ticket":"RP-554"';
    const { bait, marker, preloadDir, result, trackerWrites } =
      await claimWithNegativeOnlyNativeFault({
        roots,
        exitCode: 3,
        stdout,
      });

    expect(existsSync(marker)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-protocol-invalid',
    });
    expect(JSON.stringify(result)).not.toContain(stdout);
    expect(JSON.stringify(result)).not.toContain(bait);
    expect(JSON.stringify(result)).not.toContain(preloadDir);
    expect(trackerWrites).toBe(0);
  });

  it('refuses an exit-3 native response whose otherwise valid ticket belongs to another item', async () => {
    const stdout = JSON.stringify({
      ticket: 'RP-555',
      verdict: 'unverifiable',
      matches: [],
      sources: [
        { name: 'branch', status: 'unavailable' },
        { name: 'pr', status: 'read' },
      ],
    });
    const { bait, marker, preloadDir, result, trackerWrites } =
      await claimWithNegativeOnlyNativeFault({
        roots,
        exitCode: 3,
        stdout,
      });

    expect(existsSync(marker)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-protocol-invalid',
    });
    expect(JSON.stringify(result)).not.toContain(stdout);
    expect(JSON.stringify(result)).not.toContain(bait);
    expect(JSON.stringify(result)).not.toContain(preloadDir);
    expect(trackerWrites).toBe(0);
  });

  it('refuses an exit-3 native response whose otherwise valid ticket has the wrong verdict', async () => {
    const stdout = JSON.stringify({
      ticket: 'RP-554',
      verdict: 'clean',
      matches: [],
      sources: [
        { name: 'branch', status: 'unavailable' },
        { name: 'pr', status: 'read' },
      ],
    });
    const { bait, marker, preloadDir, result, trackerWrites } =
      await claimWithNegativeOnlyNativeFault({
        roots,
        exitCode: 3,
        stdout,
      });

    expect(existsSync(marker)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-protocol-invalid',
    });
    expect(JSON.stringify(result)).not.toContain(stdout);
    expect(JSON.stringify(result)).not.toContain(bait);
    expect(JSON.stringify(result)).not.toContain(preloadDir);
    expect(trackerWrites).toBe(0);
  });

  it('refuses an exit-3 native response whose otherwise valid source list names an unknown source', async () => {
    const stdout = JSON.stringify({
      ticket: 'RP-554',
      verdict: 'unverifiable',
      matches: [],
      sources: [
        { name: 'branch', status: 'unavailable' },
        { name: 'unknown-source', status: 'read' },
      ],
    });
    const { bait, marker, preloadDir, result, trackerWrites } =
      await claimWithNegativeOnlyNativeFault({
        roots,
        exitCode: 3,
        stdout,
      });

    expect(existsSync(marker)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      admission: 'unverifiable',
      diagnostic: 'native-protocol-invalid',
    });
    expect(JSON.stringify(result)).not.toContain(stdout);
    expect(JSON.stringify(result)).not.toContain(bait);
    expect(JSON.stringify(result)).not.toContain(preloadDir);
    expect(trackerWrites).toBe(0);
  });
});
