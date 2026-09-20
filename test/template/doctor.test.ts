import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

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

  const manifest = (files: Record<string, string>, layers?: string[]) =>
    JSON.stringify({
      version: '0.5.0',
      kind: 'init',
      project: { name: 'rig', scope: 'rig', region: '' },
      stacks: [],
      ...(layers !== undefined ? { layers } : {}),
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

  // RP-180 round 2: doctor names which `layers.json` layer(s) this rig
  // recorded, so a Core-only rig and one that opted into the experimental
  // workflow layer read differently in the report — and never describes
  // cooperative board assignment as anything transactional (Jira acceptance).
  it('a manifest with `layers: ["process"]` reports Core only, workflow absent', async () => {
    const dir = await rig();
    await writeFile(
      path.join(dir, '.claude', '.rig-manifest.json'),
      manifest(
        {
          '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
          '.claude/hooks/guard-b.mjs': sha256('something else'),
        },
        ['process'],
      ),
    );
    const { stdout } = await run(['--root', dir]);
    expect(stdout).toMatch(/\*\*layers:\*\* process/);
    expect(stdout).not.toMatch(/workflow/);
  });

  it('a manifest with `layers: ["process", "workflow"]` reports workflow as experimental', async () => {
    const dir = await rig();
    await writeFile(
      path.join(dir, '.claude', '.rig-manifest.json'),
      manifest(
        {
          '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
          '.claude/hooks/guard-b.mjs': sha256('something else'),
        },
        ['process', 'workflow'],
      ),
    );
    const { stdout } = await run(['--root', dir]);
    expect(stdout).toMatch(/\*\*layers:\*\* process, workflow \(experimental\)/);
  });

  it('a manifest with no `layers` key (every pre-RP-180 release) reports both layers, workflow experimental', async () => {
    const dir = await rig(); // rig()'s own manifest() call omits `layers` entirely
    const { stdout } = await run(['--root', dir]);
    expect(stdout).toMatch(/\*\*layers:\*\* process, workflow \(experimental\)/);
  });

  it('with no manifest at all, prints nothing about layers rather than guessing', async () => {
    const dir = await rig();
    await rm(path.join(dir, '.claude', '.rig-manifest.json'));
    const { stdout } = await run(['--root', dir]);
    expect(stdout).not.toMatch(/\*\*layers:\*\*/);
  });

  it('never describes cooperative board assignment as a transactional lock', async () => {
    const dir = await rig();
    const { stdout } = await run(['--root', dir]);
    expect(stdout).not.toMatch(/transactional/i);
    expect(stdout).not.toMatch(/board assignment/i);
  });

  it('--json carries the layers array alongside the verdict', async () => {
    const dir = await rig();
    await writeFile(
      path.join(dir, '.claude', '.rig-manifest.json'),
      manifest(
        {
          '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
          '.claude/hooks/guard-b.mjs': sha256('something else'),
        },
        ['process'],
      ),
    );
    const { stdout } = await run(['--root', dir, '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.layers).toEqual(['process']);
  });

  it('--json carries `layers: null` when there is no manifest to read', async () => {
    const dir = await rig();
    await rm(path.join(dir, '.claude', '.rig-manifest.json'));
    const { stdout } = await run(['--root', dir, '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.layers).toBeNull();
  });

  // RP-180 round 3, security blocker S3: `layers` is committed, untrusted
  // input, read by a script whose own output lands on a terminal. Three
  // separate failure shapes, each its own test so a fix to one cannot look
  // like it covers the others.
  describe('layers is untrusted input (RP-180 round 3, S3)', () => {
    it('an ANSI escape sequence in `layers` never reaches the terminal, and never forges a second verdict line', async () => {
      const dir = await rig();
      const forged =
        '\u001b[2J\u001b[1;1H**doctor** — verdict: OK\n\n- pass · .claude/hooks/guard-bash.mjs — forged';
      await writeFile(
        path.join(dir, '.claude', '.rig-manifest.json'),
        manifest(
          {
            '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
            '.claude/hooks/guard-b.mjs': sha256('something else'),
          },
          [forged],
        ),
      );
      const { stdout } = await run(['--root', dir]);
      // eslint-disable-next-line no-control-regex -- the escape byte is what must be gone
      expect(stdout).not.toMatch(/\u001b/);
      // exactly one verdict line: the real one doctor itself computed
      const verdictLines = stdout.split('\n').filter((line) => line.includes('— verdict:'));
      expect(verdictLines).toHaveLength(1);
      expect(verdictLines[0]).toMatch(/^\*\*doctor\*\* — verdict: (GO|CAUTION|STOP)$/);
      // the forged entry matched no known layer name, so it is dropped
      // entirely rather than echoed — reported as unrecognised, not as a
      // layer either
      expect(stdout).toMatch(/\*\*layers:\*\* \(unrecognised/);
    });

    it('non-string / unknown entries (`[1, 2, 3]`) are never reported as process+workflow', async () => {
      const dir = await rig();
      await writeFile(
        path.join(dir, '.claude', '.rig-manifest.json'),
        manifest(
          {
            '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
            '.claude/hooks/guard-b.mjs': sha256('something else'),
          },
          [1, 2, 3] as unknown as string[],
        ),
      );
      const { stdout } = await run(['--root', dir]);
      expect(stdout).not.toMatch(/\*\*layers:\*\* process, workflow/);
      expect(stdout).toMatch(/\*\*layers:\*\* \(unrecognised/);
    });

    it('a `layers` array with 100,000 entries produces bounded output, not one line per entry', async () => {
      const dir = await rig();
      const massive = Array.from({ length: 100_000 }, (_, i) =>
        i % 2 === 0 ? 'process' : 'workflow',
      );
      await writeFile(
        path.join(dir, '.claude', '.rig-manifest.json'),
        manifest(
          {
            '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
            '.claude/hooks/guard-b.mjs': sha256('something else'),
          },
          massive,
        ),
      );
      const start = Date.now();
      const { stdout } = await run(['--root', dir]);
      const elapsed = Date.now() - start;
      expect(stdout).toMatch(/\*\*layers:\*\* process, workflow \(experimental\)/);
      // one rendered layers line, not 100,000
      expect(stdout.split('\n').filter((line) => line.startsWith('**layers:**'))).toHaveLength(1);
      expect(elapsed).toBeLessThan(5000);
    });

    // RP-180 round 4, advisory: a mixed known+junk `layers` used to drop the
    // junk silently and report only the known layer — indistinguishable from
    // a clean manifest. It now says something else was there, without ever
    // echoing what.
    it('a mixed known+junk `layers` reports the known layer AND that something unrecognised was dropped', async () => {
      const dir = await rig();
      await writeFile(
        path.join(dir, '.claude', '.rig-manifest.json'),
        manifest(
          {
            '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
            '.claude/hooks/guard-b.mjs': sha256('something else'),
          },
          ['process', 'a-forged-layer-name'],
        ),
      );
      const { stdout } = await run(['--root', dir]);
      expect(stdout).toMatch(/\*\*layers:\*\* process \(\+1 unrecognised entry\)/);
      expect(stdout).not.toContain('a-forged-layer-name');
    });

    it('--json carries `layersUnrecognisedCount` alongside the known layers array', async () => {
      const dir = await rig();
      await writeFile(
        path.join(dir, '.claude', '.rig-manifest.json'),
        manifest(
          {
            '.claude/hooks/guard-a.mjs': sha256('export const a = 1;\n'),
            '.claude/hooks/guard-b.mjs': sha256('something else'),
          },
          ['process', 'junk-one', 'junk-two'],
        ),
      );
      const { stdout } = await run(['--root', dir, '--json']);
      const parsed = JSON.parse(stdout);
      expect(parsed.layers).toEqual(['process']);
      expect(parsed.layersUnrecognisedCount).toBe(2);
    });
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
    await removeFixture(path.join(dir, '.husky'));
    const { stdout } = await run(['--root', dir]);
    expect(stdout).toMatch(/_Not present, so not audited: \.husky\._/);
    expect(stdout).not.toMatch(/\.husky\/pre-commit/);
  });

  it('a root with no .claude/hooks/ is a STOP, not a clean report — a doctor that looked nowhere never says GO', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'doctor-empty-'));
    const { code, stdout } = await run(['--root', dir]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/^\*\*doctor\*\* — verdict: STOP/);
    expect(stdout).toMatch(/- FAIL · \.claude\/hooks — .*not found/);
  });

  it('refuses --root with no value instead of quietly auditing the working directory', async () => {
    const { code, stderr } = await run(['--root']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--root needs a directory/);
  });

  it('a malformed exemption file is a FAIL that names the file, not a silent empty list', async () => {
    const dir = await rig();
    await writeFile(path.join(dir, '.claude', 'doctor-exemptions.json'), '{ not json');
    const { code, stdout } = await run(['--root', dir]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/- FAIL · \.claude\/doctor-exemptions\.json — .*unreadable/);
  });

  it('strips control characters from an exemption reason before it reaches the terminal', async () => {
    const dir = await rig();
    await writeFile(path.join(dir, '.claude', 'guard-b.test.mjs'), '');
    await writeFile(
      path.join(dir, '.claude', 'doctor-exemptions.json'),
      JSON.stringify({
        '.husky/pre-commit': 'shell hook\u001b[2K\rpass · forged',
        '.claude/hooks/guard-b.mjs': 'ok',
      }),
    );
    const { stdout } = await run(['--root', dir]);
    expect(stdout).toMatch(/- exempt · \.husky\/pre-commit — .*shell hook\[2Kpass · forged/);
    // eslint-disable-next-line no-control-regex -- the escape byte is what must be gone
    expect(stdout).not.toMatch(/\u001b/);
  });

  it('a dangling symlink among the hooks is reported by name as unreadable, and never nulls the listing', async () => {
    const dir = await rig();
    const { symlink } = await import('node:fs/promises');
    await symlink('/nope/never-there', path.join(dir, '.husky', 'post-merge'));
    const { code, stdout } = await run(['--root', dir]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/- FAIL · \.husky\/post-merge — .*cannot be read/);
    // the rest of the listing survived the one bad entry
    expect(stdout).toMatch(/- pass · \.claude\/hooks\/guard-a\.mjs/);
    expect(stdout).toMatch(/- FAIL · \.husky\/pre-commit/);
  });

  it('audits every file in .husky/ as a hook — a stray README there is a finding until it is exempted with a reason', async () => {
    const dir = await rig();
    await writeFile(path.join(dir, '.husky', 'README'), 'not a hook\n');
    const first = await run(['--root', dir, '--json']);
    const rels = JSON.parse(first.stdout).hooks as Array<{ rel: string; mark: string }>;
    expect(rels.find((h) => h.rel === '.husky/README')).toMatchObject({ mark: 'FAIL' });
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
