import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-554 — the baseline accepted after native duplicate-work is the complete
// claim record selected before that work began.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const recordsPath = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'lib',
  'claim-records.mjs',
);
const T0 = '2026-11-28T00:00:00.000Z';
const TARGET_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const roots: string[] = [];
const ticket = {
  id: 'RP-554',
  title: 'selected claim fixture',
  state: 'open',
  labels: [],
  blockedBy: [],
  blocks: [],
  priority: 1,
  createdAt: T0,
  updatedAt: T0,
  commentary: { count: 0, ids: [], complete: true },
};

const git = (args: string[], cwd: string, input?: Buffer) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    input,
  }).trim();

const readerOf = (records: Record<string, unknown>) =>
  records.readSelectedClaimBaseline as
    | ((options: {
        projectRoot: string;
        ticket: { id: string };
        expectedObject: string;
      }) => Record<string, unknown> | null)
    | undefined;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
});

describe('selected claim baseline reader (RP-554)', () => {
  it('reads the unchanged first untracked SELECT baseline and its baseline-only checkpoint', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-selected-baseline-'));
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
    git(['commit', '-q', '-m', 'seed selected baseline fixture'], root);
    const records = (await import(
      `${pathToFileURL(recordsPath).href}?rp554-selected=${Date.now()}-${Math.random()}`
    )) as Record<string, unknown> & {
      revalidateClaim: (options: Record<string, unknown>) => { result: string };
      claimPathFor: (projectRoot: string, ticket: { id: string }) => string;
    };
    const created = records.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: TARGET_SHA,
      allowCreate: true,
      isResume: false,
    });
    expect(created.result, JSON.stringify(created)).toBe('BASELINE_CREATED');
    const claimPath = records.claimPathFor(root, ticket);
    const pointer = path.relative(root, claimPath).replaceAll(path.sep, '/');
    const raw = await readFile(claimPath);
    const expectedClaim = JSON.parse(raw.toString('utf8'));
    const expectedObject = git(['hash-object', '--path', pointer, '--stdin'], root, raw);
    const readSelectedClaimBaseline = readerOf(records);

    expect(readSelectedClaimBaseline?.({ projectRoot: root, ticket, expectedObject })).toEqual(
      expectedClaim,
    );
    git(['add', '.rig/claims/RP-554.json'], root);
    git(['commit', '-q', '-m', 'record unchanged SELECT baseline'], root);
    expect(readSelectedClaimBaseline?.({ projectRoot: root, ticket, expectedObject })).toEqual(
      expectedClaim,
    );
  });

  it('refuses a valid-shaped stored commentary edit after SELECT when it no longer matches the selected object', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-selected-baseline-'));
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
    git(['commit', '-q', '-m', 'seed selected baseline fixture'], root);
    const records = (await import(
      `${pathToFileURL(recordsPath).href}?rp554-commentary=${Date.now()}-${Math.random()}`
    )) as Record<string, unknown> & {
      revalidateClaim: (options: Record<string, unknown>) => { result: string };
      claimPathFor: (projectRoot: string, ticket: { id: string }) => string;
    };
    const created = records.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: TARGET_SHA,
      allowCreate: true,
      isResume: false,
    });
    expect(created.result, JSON.stringify(created)).toBe('BASELINE_CREATED');
    const claimPath = records.claimPathFor(root, ticket);
    const pointer = path.relative(root, claimPath).replaceAll(path.sep, '/');
    const original = await readFile(claimPath);
    const expectedObject = git(['hash-object', '--path', pointer, '--stdin'], root, original);
    const tampered = JSON.parse(original.toString('utf8'));
    tampered.fingerprints.commentary.value = 'a'.repeat(64);
    await writeFile(claimPath, `${JSON.stringify(tampered, null, 2)}\n`);

    expect(readerOf(records)?.({ projectRoot: root, ticket, expectedObject })).toBeNull();
  });

  it('refuses a tracked target edit even when the caller supplies the edited object identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp554-selected-baseline-'));
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
    git(['commit', '-q', '-m', 'seed selected baseline fixture'], root);
    const records = (await import(
      `${pathToFileURL(recordsPath).href}?rp554-tracked=${Date.now()}-${Math.random()}`
    )) as Record<string, unknown> & {
      revalidateClaim: (options: Record<string, unknown>) => { result: string };
      claimPathFor: (projectRoot: string, ticket: { id: string }) => string;
    };
    const created = records.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: TARGET_SHA,
      allowCreate: true,
      isResume: false,
    });
    expect(created.result, JSON.stringify(created)).toBe('BASELINE_CREATED');
    const claimPath = records.claimPathFor(root, ticket);
    const pointer = path.relative(root, claimPath).replaceAll(path.sep, '/');
    git(['add', pointer], root);
    git(['commit', '-q', '-m', 'record selected baseline'], root);
    const tampered = JSON.parse(await readFile(claimPath, 'utf8'));
    tampered.fingerprints.scope.targetSha = 'f'.repeat(40);
    const edited = Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`);
    await writeFile(claimPath, edited);
    const editedObject = git(['hash-object', '--path', pointer, '--stdin'], root, edited);

    expect(
      readerOf(records)?.({ projectRoot: root, ticket, expectedObject: editedObject }),
    ).toBeNull();
  });
});
