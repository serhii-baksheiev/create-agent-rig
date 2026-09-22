import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const execFileAsync = promisify(execFile);

// The documented propose.mjs line is a bash snippet — `$(git rev-parse
// --show-toplevel)` and `$RIG_RUN_DIR` are bash syntax, not something cmd.exe
// expands. Run it under a real bash on every platform, matching the
// convention `test/template/release-acceptance.test.ts` already uses for the
// same reason (its own `bashExecutable`).
function bashExecutable(): string {
  return process.platform === 'win32'
    ? path.join(
        process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? 'C:\\Program Files',
        'Git',
        'bin',
        'bash.exe',
      )
    : 'bash';
}

/**
 * AR-117 — the loop skill names a `<report>` file it never said how to produce,
 * and its `proposeTriage` snippet, called exactly as written, throws on jira.
 *
 * Measured: both premise passes of one run were checked with `verdict.mjs`, and
 * the first check exited 1 — the harness artifact is a JSONL transcript whose
 * last fenced block does not parse. The report is a file the session writes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const skill = (name: string) =>
  readFile(
    path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'skills',
      name,
      'SKILL.md',
    ),
    'utf8',
  );

describe('the loop skill says how the <report> it checks comes to exist', () => {
  it('states that the report is a file the session writes from the subagent answer, before the first check', async () => {
    const text = await skill('loop');
    const firstCheck = text.indexOf('verdict.mjs check <report>');
    expect(firstCheck).toBeGreaterThan(0);
    const explained = text.indexOf('`<report>` is a file you write');
    expect(
      explained,
      'the explanation must sit beside the first check, not after it',
    ).toBeGreaterThan(0);
    expect(explained).toBeLessThan(firstCheck + 1500);
    // The reason, so nobody "fixes" it by pointing at the transcript.
    expect(text).toMatch(/transcript[^.]*JSONL[^.]*last fenced block does not parse/);
    // Where to put it, so two reviewers' answers cannot overwrite each other.
    expect(text).toMatch(/\$RIG_RUN_DIR\/[\w-]+\.md/);
  });

  it('names the same convention pr-ship already uses, so the two skills agree', async () => {
    const [loop, prShip] = await Promise.all([skill('loop'), skill('pr-ship')]);
    expect(prShip).toMatch(/save what each subagent returned/);
    expect(loop).toMatch(/as `pr-ship` (?:does|already does)/);
  });
});

describe('the propose.mjs snippet files on every adapter when called as written', () => {
  let scratchDir: string | undefined;
  let runDir: string | undefined;

  afterEach(async () => {
    if (scratchDir) await removeFixture(scratchDir);
    if (runDir) await removeFixture(runDir);
    scratchDir = undefined;
    runDir = undefined;
  });

  it('no longer tells the reader to hand-pass a jira project, and the old "does not file" warning stays gone', async () => {
    const text = await skill('loop');
    // The documented call names the script and the proposal file, whatever
    // path prefix reaches the script — the exact prefix (relative or
    // repo-root-anchored) is pinned by the subdirectory-execution test
    // below, not here.
    expect(text).toMatch(/\.claude\/scripts\/queue\/propose\.mjs/);
    expect(text).toMatch(/--file "\$RIG_RUN_DIR\/proposal\.json"/);
    // jira's required `options.project` is still enforced by the adapter.
    expect(text).toMatch(/`jira` still requires `options\.project`/);
    expect(text).toMatch(/no\s*\n?second argument left to hand-copy/);
    // The old hand-typed project argument is gone with it.
    expect(text).not.toMatch(/\{ project: "<KEY>" \}/);
    // The old warning — "called exactly as written, it does not file" — is gone
    // with its cause, rather than left describing a snippet that now files.
    expect(text).not.toMatch(/called exactly as written, it does not file/);
  });

  it('files when the documented command line runs, unmodified, from a project subdirectory', async () => {
    // Extract the actual line the skill tells a session to run — not a
    // hard-coded copy of either the buggy or the fixed form, so this test
    // keeps testing the DOCUMENTED command even after the snippet changes.
    // The line is matched by invocation shape (starts with `node `, reaches
    // propose.mjs), not by a fixed path prefix — a root-anchored
    // `node "$(git rev-parse --show-toplevel)/.claude/scripts/queue/propose.mjs"`
    // is exactly as valid a documented form as a cwd-relative one.
    const text = await skill('loop');
    const commandMatch = text.match(/^node .*\.claude\/scripts\/queue\/propose\.mjs.*$/m);
    expect(
      commandMatch,
      'could not find the documented propose.mjs invocation line in the loop skill',
    ).toBeTruthy();
    const documentedCommand = (commandMatch as RegExpMatchArray)[0];

    // A real git repository, so a fixed snippet that resolves the script
    // through `git rev-parse --show-toplevel` also has something to resolve.
    scratchDir = await mkdtemp(path.join(tmpdir(), 'propose-skill-'));
    await execFileAsync('git', ['init', '--quiet'], { cwd: scratchDir });
    await cp(
      path.join(universal, '.claude', 'scripts'),
      path.join(scratchDir, '.claude', 'scripts'),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(scratchDir, 'PLAN.md'),
      ['# P — plan', '', '## Operator queue', '', '## Journal', ''].join('\n'),
    );
    const subdir = path.join(scratchDir, 'src', 'deep');
    await mkdir(subdir, { recursive: true });

    runDir = await mkdtemp(path.join(tmpdir(), 'propose-skill-run-'));
    const proposal = {
      finding: 'journal 2026-09: the documented propose.mjs command is a cwd-relative script path',
      part: '.claude/skills/loop/SKILL.md',
      change: 'invoke propose.mjs through the repository root, not a cwd-relative path',
      proof: 'the documented command files a proposal from a project subdirectory',
    };
    await writeFile(path.join(runDir, 'proposal.json'), JSON.stringify(proposal));

    // The exact documented text, through bash -c, standing in a subdirectory —
    // reproducing the session's own working position when it stops mid-task.
    // A real bash on every platform: the line is bash syntax
    // (`$(git rev-parse --show-toplevel)`, `$RIG_RUN_DIR`), and a shell-less
    // `exec` goes through cmd.exe on win32, which expands neither.
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          bashExecutable(),
          ['-c', documentedCommand],
          { cwd: subdir, env: { ...process.env, RIG_RUN_DIR: runDir } },
          (error, stdout, stderr) => {
            resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
          },
        );
      },
    );

    expect(result.code, result.stdout + result.stderr).toBe(0);

    const { triageItemFor } = (await import(
      pathToFileURL(path.join(scratchDir, '.claude', 'scripts', 'queue', 'plan-md.mjs')).href
    )) as { triageItemFor: (p: typeof proposal) => { fingerprint: string } };
    const rootPlan = await readFile(path.join(scratchDir, 'PLAN.md'), 'utf8');
    expect(rootPlan).toContain(triageItemFor(proposal).fingerprint);
  });
});
