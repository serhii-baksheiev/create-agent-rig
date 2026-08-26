import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-5 — the harness audits itself: every hook the project OWNS has a test
 * neighbour.
 *
 * `invariants.md` says a check without a test is a guess, and carves out one
 * exception for generator-authored hooks *while they are untouched*. Nothing
 * mechanical told a rig when that exception had lapsed: the moment a hook was
 * edited, its test became the rig's own — and nothing noticed it was absent.
 * `doctor.mjs` reads the install manifest to tell `shipped` from `owned`, and
 * reports the owned hooks that have no `<name>.test.mjs` beside them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const load = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('ownership is read from the manifest, and its absence is not a pass', () => {
  it('a hook whose bytes still match the manifest is shipped', async () => {
    const { ownershipOf } = await load('doctor.mjs');
    expect(ownershipOf({ recorded: 'abc', actual: 'abc' })).toBe('shipped');
  });

  it('a hook whose bytes differ from the manifest is owned', async () => {
    const { ownershipOf } = await load('doctor.mjs');
    expect(ownershipOf({ recorded: 'abc', actual: 'def' })).toBe('owned');
  });

  it('a hook the manifest never recorded is owned — the generator did not write it', async () => {
    const { ownershipOf } = await load('doctor.mjs');
    expect(ownershipOf({ recorded: undefined, actual: 'abc' })).toBe('owned');
  });

  it('with no manifest at all, ownership is unknown — never shipped', async () => {
    const { ownershipOf } = await load('doctor.mjs');
    expect(ownershipOf({ recorded: null, actual: 'abc' })).toBe('unknown');
  });
});

describe('the test neighbour sits beside the hook, in the new-invariant shape', () => {
  it('maps a .claude hook to <name>.test.mjs and a husky hook to <file>.test.mjs', async () => {
    const { neighbourOf } = await load('doctor.mjs');
    expect(neighbourOf('.claude/hooks/guard-x.mjs')).toBe('.claude/hooks/guard-x.test.mjs');
    expect(neighbourOf('.husky/pre-commit')).toBe('.husky/pre-commit.test.mjs');
  });
});

describe('auditHooks marks each hook and derives the verdict like preflight', () => {
  const hook = (over: Record<string, unknown>) => ({
    rel: '.claude/hooks/guard-x.mjs',
    ownership: 'owned',
    hasTest: false,
    ...over,
  });

  it('a shipped hook without a local test passes — it is tested upstream', async () => {
    const { auditHooks } = await load('doctor.mjs');
    const result = auditHooks({ hooks: [hook({ ownership: 'shipped' })], exemptions: {} });
    expect(result.verdict).toBe('GO');
    expect(result.hooks[0]).toMatchObject({ mark: 'pass', ownership: 'shipped' });
    expect(result.hooks[0].detail).toMatch(/upstream/);
  });

  it('an owned hook with a test neighbour passes', async () => {
    const { auditHooks } = await load('doctor.mjs');
    const result = auditHooks({ hooks: [hook({ hasTest: true })], exemptions: {} });
    expect(result.verdict).toBe('GO');
    expect(result.hooks[0].mark).toBe('pass');
  });

  it('an owned hook without a test is a FAIL, and the run is STOP', async () => {
    const { auditHooks } = await load('doctor.mjs');
    const result = auditHooks({ hooks: [hook({})], exemptions: {} });
    expect(result.verdict).toBe('STOP');
    expect(result.hooks[0].mark).toBe('FAIL');
  });

  it('an unknown-ownership hook with a test passes — the test is there whoever owns it', async () => {
    const { auditHooks } = await load('doctor.mjs');
    const result = auditHooks({
      hooks: [hook({ ownership: 'unknown', hasTest: true })],
      exemptions: {},
    });
    expect(result.verdict).toBe('GO');
    expect(result.hooks[0].mark).toBe('pass');
  });

  it('an unknown-ownership hook without a test is unknown, and the run is CAUTION not GO', async () => {
    const { auditHooks } = await load('doctor.mjs');
    const result = auditHooks({ hooks: [hook({ ownership: 'unknown' })], exemptions: {} });
    expect(result.verdict).toBe('CAUTION');
    expect(result.hooks[0].mark).toBe('unknown');
  });

  it('an exempt owned hook without a test is reported exempt with its reason, and does not fail', async () => {
    const { auditHooks } = await load('doctor.mjs');
    const result = auditHooks({
      hooks: [hook({})],
      exemptions: { '.claude/hooks/guard-x.mjs': 'shell hook; exercised by the CI job' },
    });
    expect(result.verdict).toBe('GO');
    expect(result.hooks[0].mark).toBe('exempt');
    expect(result.hooks[0].detail).toMatch(/exercised by the CI job/);
  });

  it('an exemption without a reason is itself a FAIL finding', async () => {
    const { auditHooks } = await load('doctor.mjs');
    for (const reason of ['', 42]) {
      const result = auditHooks({
        hooks: [hook({})],
        exemptions: { '.claude/hooks/guard-x.mjs': reason },
      });
      expect(result.verdict).toBe('STOP');
      expect(result.hooks[0].mark).toBe('FAIL');
      expect(result.hooks[0].detail).toMatch(/without a reason/);
    }
  });

  it('names what it does not check, including the two limits the reader must still own', async () => {
    const { UNCHECKED } = await load('doctor.mjs');
    expect(Array.isArray(UNCHECKED)).toBe(true);
    const text = UNCHECKED.join('\n');
    expect(text).toMatch(/neighbour test exercises the hook it sits beside/);
    expect(text).toMatch(/wired in \.claude\/settings\.json/);
  });
});

describe('the CLI audits a rig on disk', () => {
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(scriptsDir, 'doctor.mjs'), ...args],
        {},
        (e, out, err) =>
          resolve({
            code: e && typeof e.code === 'number' ? e.code : 0,
            stdout: String(out),
            stderr: String(err),
          }),
      );
    });

  const manifest = (files: Record<string, string>) =>
    JSON.stringify({
      version: '0.5.0',
      kind: 'init',
      project: { name: 'rig', scope: 'rig', region: '' },
      stacks: [],
      files,
    });

  const rig = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'doctor-cli-'));
    const hooks = path.join(dir, '.claude', 'hooks');
    await mkdir(path.join(hooks, 'lib'), { recursive: true });
    await mkdir(path.join(dir, '.husky'), { recursive: true });
    const a = 'export const a = 1;\n';
    const b = 'export const b = 1;\n';
    await writeFile(path.join(hooks, 'guard-a.mjs'), a);
    await writeFile(path.join(hooks, 'guard-b.mjs'), b);
    await writeFile(path.join(hooks, 'guard-c.mjs'), 'export const c = 1;\n');
    await writeFile(path.join(hooks, 'guard-c.test.mjs'), '// test\n');
    await writeFile(path.join(hooks, 'lib', 'helper.mjs'), 'export const h = 1;\n');
    await writeFile(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\npnpm test:unit\n');
    await writeFile(
      path.join(dir, '.claude', '.rig-manifest.json'),
      manifest({
        '.claude/hooks/guard-a.mjs': sha256(a),
        '.claude/hooks/guard-b.mjs': sha256('something else'),
      }),
    );
    return dir;
  };

  it('reports shipped, modified, unrecorded, lib-excluded and husky hooks, and exits 1 on STOP', async () => {
    const dir = await rig();
    const { code, stdout } = await run(['--root', dir]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/^\*\*doctor\*\* — verdict: STOP/);
    expect(stdout).toMatch(/- pass · \.claude\/hooks\/guard-a\.mjs/);
    expect(stdout).toMatch(/- FAIL · \.claude\/hooks\/guard-b\.mjs/);
    expect(stdout).toMatch(/- pass · \.claude\/hooks\/guard-c\.mjs/);
    expect(stdout).toMatch(/- FAIL · \.husky\/pre-commit/);
    expect(stdout).not.toMatch(/helper\.mjs/);
    expect(stdout).not.toMatch(/guard-c\.test\.mjs —/);
    expect(stdout).toMatch(/_Not checked by this script — still yours \(\d+\):_/);
  });

  it('an exemption and a new test neighbour turn the run GO, exit 0', async () => {
    const dir = await rig();
    await writeFile(
      path.join(dir, '.claude', 'doctor-exemptions.json'),
      JSON.stringify({ '.husky/pre-commit': 'shell hook; exercised by the CI job' }),
    );
    await writeFile(path.join(dir, '.claude', 'hooks', 'guard-b.test.mjs'), '// test\n');
    const { code, stdout } = await run(['--root', dir]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^\*\*doctor\*\* — verdict: GO/);
    expect(stdout).toMatch(/- exempt · \.husky\/pre-commit — .*exercised by the CI job/);
    expect(stdout).toMatch(/- pass · \.claude\/hooks\/guard-b\.mjs/);
  });

  it('with no manifest every untested hook is unknown, the verdict is CAUTION, and exit is 0', async () => {
    const dir = await rig();
    await rm(path.join(dir, '.claude', '.rig-manifest.json'));
    const { code, stdout } = await run(['--root', dir]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^\*\*doctor\*\* — verdict: CAUTION/);
    expect(stdout).toMatch(/- unknown · \.claude\/hooks\/guard-a\.mjs/);
    expect(stdout).toMatch(/- unknown · \.husky\/pre-commit/);
    expect(stdout).not.toMatch(/verdict: GO/);
  });

  it('--json carries the same verdict, the hooks array and the unchecked list', async () => {
    const dir = await rig();
    const { code, stdout } = await run(['--root', dir, '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.verdict).toBe('STOP');
    expect(Array.isArray(parsed.hooks)).toBe(true);
    expect(parsed.hooks.map((h: { rel: string }) => h.rel)).toEqual(
      expect.arrayContaining([
        '.claude/hooks/guard-a.mjs',
        '.claude/hooks/guard-b.mjs',
        '.claude/hooks/guard-c.mjs',
        '.husky/pre-commit',
      ]),
    );
    expect(
      parsed.hooks.find((h: { rel: string }) => h.rel === '.claude/hooks/guard-b.mjs'),
    ).toMatchObject({ ownership: 'owned', hasTest: false, mark: 'FAIL' });
    expect(Array.isArray(parsed.unchecked)).toBe(true);
    expect(parsed.unchecked.length).toBeGreaterThan(0);
  });

  it('names an absent .husky/ instead of staying silent about it', async () => {
    const dir = await rig();
    await rm(path.join(dir, '.husky'), { recursive: true, force: true });
    const { stdout } = await run(['--root', dir]);
    expect(stdout).toMatch(/_Not present, so not audited: \.husky\._/);
    expect(stdout).not.toMatch(/\.husky\/pre-commit/);
  });

  it('an exemption naming a file that does not exist is a stale-exemption FAIL', async () => {
    const dir = await rig();
    await writeFile(path.join(dir, '.claude', 'hooks', 'guard-b.test.mjs'), '// test\n');
    await writeFile(
      path.join(dir, '.claude', 'doctor-exemptions.json'),
      JSON.stringify({
        '.husky/pre-commit': 'shell hook; exercised by the CI job',
        '.claude/hooks/guard-gone.mjs': 'it was deleted last week',
      }),
    );
    const { code, stdout } = await run(['--root', dir]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/verdict: STOP/);
    expect(stdout).toMatch(/- FAIL · \.claude\/hooks\/guard-gone\.mjs — .*stale-exemption/);
  });
});

describe('the script is part of the process layer, and the rule points at it', () => {
  it('layers.json lists doctor.mjs under process', async () => {
    const layers = JSON.parse(await readFile(path.join(universal, 'layers.json'), 'utf8'));
    expect(layers.process).toContain('.claude/scripts/doctor.mjs');
  });

  it('"About the hooks you were given" in invariants.md names doctor.mjs', async () => {
    const text = await readFile(path.join(universal, '.claude', 'rules', 'invariants.md'), 'utf8');
    const start = text.indexOf('## About the hooks you were given');
    expect(start).toBeGreaterThan(-1);
    const rest = text.slice(start);
    const end = rest.indexOf('\n## ', 1);
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section).toMatch(/doctor\.mjs/);
  });
});
