// RP-209: the `loop` skill's §7 improvement-proposal snippet
// (`templates/agent-os/universal/.claude/skills/loop/SKILL.md`, "proposeTriage")
// tells a session to file a proposal with a relative `import("./.claude/scripts/
// queue/plan-md.mjs")` and `plan-md`'s cwd-relative default `planPath`. Both
// break the moment the session is standing in a subdirectory: the import throws
// `ERR_MODULE_NOT_FOUND`, and even a fixed import still resolves `'PLAN.md'`
// against cwd and throws `ENOENT` — on a queue that is on disk and fine. The
// Jira project key also has to be hand-copied, and neither failure is
// journalled anywhere.
//
// `queue/propose.mjs` is the one root-safe entry point this ticket adds:
//
//   node .claude/scripts/queue/propose.mjs --file <proposal.json>   # or --file -
//
// It resolves its config from its OWN location (`<script dir>/../../queue.json`,
// exactly like `index.mjs`'s `projectRoot`), reuses `loadConfig` /
// `resolveAdapter` / `optionsWithPlanPath` from `index.mjs` so the plan path and
// the active board's options (Jira's `project` included) are derived rather
// than typed, and — when `RIG_RUN_DIR` is declared — records one `proposal`
// event in the run journal so a failed filing is journalled as a failure
// instead of silently going nowhere.
//
// This file is RED on purpose: `queue/propose.mjs` does not exist yet.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');

const PLAN = [
  '# P — plan',
  '',
  '## Agent queue',
  '',
  '- add a route',
  '',
  '## Operator queue',
  '',
  '- decide: retention window',
  '',
  '## Journal',
  '',
].join('\n');

const PLAN_NO_OPERATOR_QUEUE = [
  '# P — plan',
  '',
  '## Agent queue',
  '',
  '- add a route',
  '',
  '## Journal',
  '',
].join('\n');

const PROPOSAL = {
  finding:
    'journal 2026-09: proposeTriage snippet ERR_MODULE_NOT_FOUND from a subdirectory\ntraced to a relative import and a cwd-relative planPath default',
  part: '.claude/skills/loop/SKILL.md',
  change: 'add .claude/scripts/queue/propose.mjs as the one root-safe entry point',
  proof: 'filing from a subdirectory lands in the project-root PLAN.md, not one under cwd',
};

/** A fresh scratch project: the real queue scripts, copied in, so the CLI's
 * own location is inside the fixture — the whole point of RP-209's fix. */
const scratchProject = async (
  plan: string = PLAN,
): Promise<{ dir: string; scriptPath: string }> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'propose-'));
  await cp(path.join(universal, '.claude', 'scripts'), path.join(dir, '.claude', 'scripts'), {
    recursive: true,
  });
  await writeFile(path.join(dir, 'PLAN.md'), plan);
  return { dir, scriptPath: path.join(dir, '.claude', 'scripts', 'queue', 'propose.mjs') };
};

const runCli = (
  scriptPath: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
          out: stdout + stderr,
        });
      },
    );
  });

const sectionOf = (plan: string, heading: string): string => {
  const wanted = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
  const lines = plan.split('\n');
  const start = lines.findIndex((line) => wanted.test(line));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
};

const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'propose-run-'));

const readJournalEvents = async (
  dir: string,
  runDir: string,
): Promise<Array<{ kind: string; data: unknown }>> => {
  const { readRun } = (await import(
    pathToFileURL(path.join(dir, '.claude', 'scripts', 'run-journal.mjs')).href
  )) as {
    readRun: (args: { runDir: string }) => { events: Array<{ kind: string; data: unknown }> };
  };
  return readRun({ runDir }).events;
};

describe('queue/propose.mjs — the root-safe proposal entry point (RP-209)', () => {
  it('files a proposal with a multiline finding from a project subdirectory, into the project-root PLAN.md', async () => {
    const { dir, scriptPath } = await scratchProject();
    const { triageItemFor } = (await import(
      pathToFileURL(path.join(dir, '.claude', 'scripts', 'queue', 'plan-md.mjs')).href
    )) as { triageItemFor: (p: typeof PROPOSAL) => { fingerprint: string } };

    const subdir = path.join(dir, 'src', 'deep');
    await mkdir(subdir, { recursive: true });
    await writeFile(path.join(subdir, 'proposal.json'), JSON.stringify(PROPOSAL));
    // A decoy PLAN.md sitting where a cwd-relative default would look — the
    // exact wrong file this ticket's bug reproduction wrote to.
    const decoyPlan = [
      '# decoy',
      '',
      '## Operator queue',
      '',
      '- pre-existing decoy item',
      '',
    ].join('\n');
    await writeFile(path.join(subdir, 'PLAN.md'), decoyPlan);

    const result = await runCli(scriptPath, ['--file', 'proposal.json'], subdir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    const rootPlan = await readFile(path.join(dir, 'PLAN.md'), 'utf8');
    expect(sectionOf(rootPlan, 'Operator queue')).toContain(triageItemFor(PROPOSAL).fingerprint);

    const decoyAfter = await readFile(path.join(subdir, 'PLAN.md'), 'utf8');
    expect(decoyAfter).toBe(decoyPlan);
  });

  it('exits 1 with ok: false on stdout when PLAN.md has no Operator queue heading, and journals the failure', async () => {
    const { dir, scriptPath } = await scratchProject(PLAN_NO_OPERATOR_QUEUE);
    await writeFile(path.join(dir, 'proposal.json'), JSON.stringify(PROPOSAL));
    const runDir = await newRunDir();

    const result = await runCli(scriptPath, ['--file', 'proposal.json'], dir, {
      RIG_RUN_DIR: runDir,
    });

    expect(result.code, result.out).toBe(1);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(false);

    const events = await readJournalEvents(dir, runDir);
    const proposalEvent = events.find((event) => event.kind === 'proposal');
    expect(proposalEvent, JSON.stringify(events)).toBeTruthy();
    const data = proposalEvent?.data as { ok: boolean; reason?: string };
    expect(data.ok).toBe(false);
    expect(typeof data.reason, JSON.stringify(data)).toBe('string');
    expect((data.reason ?? '').length).toBeGreaterThan(0);
  });

  it('journals a proposal event with ok: true on a successful filing under RIG_RUN_DIR', async () => {
    const { dir, scriptPath } = await scratchProject();
    await writeFile(path.join(dir, 'proposal.json'), JSON.stringify(PROPOSAL));
    const runDir = await newRunDir();

    const result = await runCli(scriptPath, ['--file', 'proposal.json'], dir, {
      RIG_RUN_DIR: runDir,
    });

    expect(result.code, result.out).toBe(0);

    const events = await readJournalEvents(dir, runDir);
    const proposalEvent = events.find((event) => event.kind === 'proposal');
    expect(proposalEvent, JSON.stringify(events)).toBeTruthy();
    expect((proposalEvent?.data as { ok: boolean }).ok).toBe(true);
  });

  it('refuses a missing --file with a stderr reason and writes nothing to PLAN.md', async () => {
    const { dir, scriptPath } = await scratchProject();
    const before = await readFile(path.join(dir, 'PLAN.md'), 'utf8');

    const result = await runCli(scriptPath, [], dir);

    expect(result.code).not.toBe(0);
    // A specific reason, not merely a non-empty stderr: Node's own
    // `MODULE_NOT_FOUND` for a script that does not exist is also non-empty,
    // and must not satisfy this test.
    expect(result.stderr, result.out).toMatch(/--file/i);
    expect(result.stderr, result.out).not.toMatch(/cannot find module/i);
    expect(await readFile(path.join(dir, 'PLAN.md'), 'utf8')).toBe(before);
  });

  it('refuses an unparseable --file with a stderr reason and writes nothing to PLAN.md', async () => {
    const { dir, scriptPath } = await scratchProject();
    const before = await readFile(path.join(dir, 'PLAN.md'), 'utf8');
    await writeFile(path.join(dir, 'proposal.json'), '{ not json');

    const result = await runCli(scriptPath, ['--file', 'proposal.json'], dir);

    expect(result.code).not.toBe(0);
    expect(result.stderr, result.out).toMatch(/json|parse/i);
    expect(result.stderr, result.out).not.toMatch(/cannot find module/i);
    expect(await readFile(path.join(dir, 'PLAN.md'), 'utf8')).toBe(before);
  });

  // Requirement 5 (the file ships in the workflow layer) is primarily the job of
  // `test/template/layers-split.test.ts` › "the workflow layer is exactly the
  // named set RP-180 decided on" and › "the union of `process` and `workflow` is
  // exactly every payload file on disk `init` can install" — both already fail
  // the moment `propose.mjs` lands on disk without a `layers.json` entry. This
  // is the narrow, script-local half: the entry itself, once it exists.
  it('is declared in the workflow layer of layers.json, beside the other queue/*.mjs scripts', async () => {
    const manifest = JSON.parse(await readFile(path.join(universal, 'layers.json'), 'utf8')) as {
      workflow?: string[];
    };
    expect(manifest.workflow ?? []).toContain('.claude/scripts/queue/propose.mjs');
  });
});
