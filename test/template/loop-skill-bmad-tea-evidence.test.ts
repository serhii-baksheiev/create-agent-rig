// RP-315 (BMAD TEA evidence) generalizes the loop skill's evidence-attach
// guidance beyond Playwright's browser evidence: next to the
// browser-evidence paragraph (`loop-skill-evidence-attach-command.test.ts`),
// the skill must carry its own fenced ```sh block showing a BMAD Test
// Architect & Evaluator (TEA) producer attaching a `gate-decision.json`
// trace through the very same `evidence-attach.mjs attach` entry point,
// naming `--producer bmad-tea`, `--kind tea-trace` and `--producer-version`.
// This file extracts that block and RUNS it against the real script, the
// same way the Playwright file does for its own paragraph — a sentence
// about a command that does not actually run is worse than no sentence at
// all (`.claude/rules/invariants.md`, "State the limits — and test them").
//
// It also pins three prose requirements next to that block: the TEA gate
// word maps to `--advisory-decision` lowercased, `WAIVED` has no advisory
// word, and nothing claims TEA runs on its own, attended or not.
//
// Independent-oracle rule (`.claude/rules/invariants.md`): the flag
// vocabulary a command is checked against is read from `evidence-attach.mjs`'s
// own `ATTACH_FLAGS` object literal by a dedicated regex here — never by
// importing the script's private constant — so a flag the skill documents
// that the script does not actually accept still fails this file.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const evidenceAttachScript = scriptPath('evidence-attach.mjs');
const loopSkillPath = path.join(universalDir, '.claude', 'skills', 'loop', 'SKILL.md');

const { withoutGitLocation } = (await import(pathToFileURL(scriptPath('git-env.mjs')).href)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

type RunResult = { code: number; stdout: string; stderr: string; out: string };

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> =>
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

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

/** A fresh git project with one commit: `dir` is the project root (and the git toplevel). */
const newProject = async (): Promise<{ dir: string }> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'loop-skill-tea-repo-')));
  await git(['init', '-q', '-b', 'master'], dir);
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await git(['add', 'README.md'], dir);
  await git(['commit', '-q', '-m', 'seed'], dir);
  return { dir };
};

const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'loop-skill-tea-run-'));

const journalSelect = async (runDir: string, ticket: string): Promise<void> => {
  const { recordEvent } = (await import(pathToFileURL(scriptPath('run-journal.mjs')).href)) as {
    recordEvent: (input: Record<string, unknown>) => unknown;
  };
  recordEvent({
    runDir,
    kind: 'revalidation',
    data: {
      point: 'SELECT',
      ticket,
      result: 'BASELINE_CREATED',
      sourcePointer: `.rig/claims/${ticket}.json`,
    },
    now: new Date().toISOString(),
  });
};

/**
 * The flag vocabulary `evidence-attach.mjs attach` actually accepts — read
 * from its own `ATTACH_FLAGS` object literal, never restated by hand, so a
 * renamed or removed flag in the script fails this file rather than letting
 * a stale flag list silently pass.
 */
function acceptedAttachFlags(source: string): Set<string> {
  const match = /const ATTACH_FLAGS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source);
  if (!match) throw new Error('evidence-attach.mjs no longer declares ATTACH_FLAGS as expected');
  const flags = new Set<string>();
  const FLAG_KEY = /'(--[a-z-]+)':/g;
  for (const flagMatch of match[1]!.matchAll(FLAG_KEY)) flags.add(flagMatch[1]!);
  return flags;
}

/**
 * Finds the fenced ```sh block (anywhere in the markdown) whose content
 * names both `evidence-attach.mjs attach` and `tea-trace`, then extracts the
 * single command line it carries — joining any backslash-continued lines
 * into one — starting from the line that opens with
 * `node .claude/scripts/evidence-attach.mjs`.
 */
function extractTeaAttachCommand(markdown: string): string {
  const FENCE = /```sh\n([\s\S]*?)```/g;
  let block: string | undefined;
  for (const match of markdown.matchAll(FENCE)) {
    const content = match[1] ?? '';
    if (content.includes('evidence-attach.mjs attach') && content.includes('tea-trace')) {
      block = content;
      break;
    }
  }
  if (block === undefined) {
    throw new Error(
      'no fenced ```sh block in the loop SKILL names both evidence-attach.mjs attach and tea-trace',
    );
  }
  const lines = block.split('\n');
  const startIndex = lines.findIndex((line) =>
    line.trim().startsWith('node .claude/scripts/evidence-attach.mjs'),
  );
  if (startIndex === -1) {
    throw new Error('the fenced sh block has no line starting the evidence-attach.mjs command');
  }
  const commandLines: string[] = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i]!;
    const continues = line.trimEnd().endsWith('\\');
    commandLines.push(continues ? line.trimEnd().slice(0, -1).trim() : line.trim());
    if (!continues) break;
  }
  return commandLines.join(' ').replace(/\s+/g, ' ').trim();
}

/** Fixture values substituted for whatever placeholder each flag's own value carries. */
const FIXTURE_VALUE_OF: Record<string, (ticket: string) => string> = {
  '--ticket': (ticket) => ticket,
  '--kind': () => 'tea-trace',
  '--producer': () => 'bmad-tea',
  '--producer-version': () => '1.27.2',
  '--subject-kind': () => 'story',
  '--subject-id': () => '1.2',
  '--subject-version': () => 'v1',
  '--authority-class': () => 'automated',
  '--advisory-decision': () => 'pass',
  '--advisory-summary': () => 'tea trace attached',
};

describe('the loop SKILL names a BMAD TEA evidence-attach command next to the browser-evidence paragraph (RP-315)', () => {
  it('extracts a fenced ```sh block naming evidence-attach.mjs attach, tea-trace, bmad-tea and --producer-version', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    const command = extractTeaAttachCommand(markdown);
    expect(command).toContain('evidence-attach.mjs attach');
    expect(command).toContain('--producer bmad-tea');
    expect(command).toContain('--kind tea-trace');
    expect(command).toContain('--producer-version');
  });

  it('names gate-decision.json in that command', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    const command = extractTeaAttachCommand(markdown);
    expect(command).toContain('gate-decision.json');
  });

  it('uses only flags evidence-attach.mjs actually accepts', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    const command = extractTeaAttachCommand(markdown);
    const source = await readFile(evidenceAttachScript, 'utf8');
    const accepted = acceptedAttachFlags(source);
    const tokens = command.split(/\s+/).filter((token) => token.length > 0);
    const usedFlags = tokens.filter((token) => token.startsWith('--'));
    for (const flag of usedFlags) {
      expect(accepted.has(flag), `${flag} is not a flag evidence-attach.mjs attach accepts`).toBe(
        true,
      );
    }
  });

  it('runs the documented command end to end and attaches a tea-trace record from bmad-tea', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    const command = extractTeaAttachCommand(markdown);
    const tokens = command.split(/\s+/).filter((token) => token.length > 0);
    expect(tokens[0]).toBe('node');
    expect(tokens[1]).toBe('.claude/scripts/evidence-attach.mjs');
    const args = tokens.slice(2);

    const { dir } = await newProject();
    const runDir = await newRunDir();
    const ticket = 'RP-1';
    await journalSelect(runDir, ticket);

    // The artifact the documented --file flag names, always substituted to
    // this one repo-relative path regardless of the placeholder the skill
    // itself used for the rest of that value.
    const gateDecisionRel = path.join('test-artifacts', 'gate-decision.json');

    const substituted: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      if (token === '--json') {
        substituted.push(token);
        continue;
      }
      if (!token.startsWith('--')) {
        // A value token with no flag immediately before it in this pass —
        // only reached if the previous iteration did not already consume it.
        substituted.push(token);
        continue;
      }
      substituted.push(token);
      const value = args[index + 1];
      if (value === undefined) continue;
      if (token === '--file') {
        substituted.push(gateDecisionRel);
      } else if (FIXTURE_VALUE_OF[token]) {
        substituted.push(FIXTURE_VALUE_OF[token]!(ticket));
      } else {
        substituted.push(value);
      }
      index += 1;
    }

    if (substituted.includes('--file')) {
      const abs = path.join(dir, gateDecisionRel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, '{"schema_version":"0.1.0","gate_status":"PASS"}\n');
    }

    const env = withoutGitLocation();
    env.RIG_RUN_DIR = runDir;
    const result = await run(process.execPath, [evidenceAttachScript, ...substituted], dir, env);
    expect(result.code, result.out).toBe(0);

    const evidenceFile = path.join(dir, '.rig', 'evidence', `${ticket}.jsonl`);
    const lines = (await readFile(evidenceFile, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    const stored = lines[0]!;
    expect(stored.kind).toBe('tea-trace');
    expect(stored.producer).toBe('bmad-tea');
    expect(stored.producerVersion).toBe('1.27.2');
  });
});

describe('the loop SKILL maps the TEA gate word to --advisory-decision, and names WAIVED as having no advisory word (RP-315)', () => {
  it('mentions --advisory-decision and "lowercased" together, naming how a TEA gate word becomes an advisory word', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    expect(markdown).toMatch(
      /--advisory-decision[\s\S]{0,300}lowercased|lowercased[\s\S]{0,300}--advisory-decision/i,
    );
  });

  it('names WAIVED as the one gate word with no advisory word', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    expect(markdown).toMatch(/WAIVED/);
  });

  it('does not claim TEA runs automatically, attended or unattended', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    expect(markdown).not.toMatch(/TEA[\s\S]{0,80}\bruns? automatically\b/i);
    expect(markdown).not.toMatch(/\bautomatically\b[\s\S]{0,80}\bTEA\b/i);
  });
});
