// RP-313 gate round 2: the `loop` skill tells an agent to attach browser
// evidence with a specific `evidence-attach.mjs attach` invocation
// (`templates/agent-os/universal/.claude/skills/loop/SKILL.md`). Prose
// about a command that does not actually run is worse than no prose at all
// (`.claude/rules/invariants.md`, "State the limits — and test them") — so
// this file extracts the command from a fenced ```sh block in the skill
// itself, substitutes its placeholders for concrete fixture values, and
// RUNS it against the real `evidence-attach.mjs`, rather than asserting
// anything about the surrounding wording.
//
// The command this file expects to find (backslash-continued lines
// allowed in the markdown source):
//
//   node .claude/scripts/evidence-attach.mjs attach --ticket <item-id> \
//        --kind browser-screenshot --producer playwright-mcp \
//        --subject-kind page --subject-id <url> --authority-class \
//        automated --file <screenshot-path>
//
// Independent-oracle rule (`.claude/rules/invariants.md`): every expected
// value below (the sha256 digest, the head SHA) is computed by this file's
// own code, never by trusting the CLI's own answer back.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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
const newProject = async (): Promise<{ dir: string; head: string }> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'loop-skill-evidence-repo-')));
  await git(['init', '-q', '-b', 'master'], dir);
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await git(['add', 'README.md'], dir);
  await git(['commit', '-q', '-m', 'seed'], dir);
  const head = await git(['rev-parse', 'HEAD'], dir);
  return { dir, head };
};

const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'loop-skill-evidence-run-'));

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

const sha256Hex = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Finds the fenced ```sh block (anywhere in the markdown) whose content
 * names both `evidence-attach.mjs attach` and `browser-screenshot`, then
 * extracts the single command line it carries — joining any
 * backslash-continued lines into one — starting from the line that opens
 * with `node .claude/scripts/evidence-attach.mjs`.
 */
function extractAttachCommand(markdown: string): string {
  const FENCE = /```sh\n([\s\S]*?)```/g;
  let block: string | undefined;
  for (const match of markdown.matchAll(FENCE)) {
    const content = match[1] ?? '';
    if (content.includes('evidence-attach.mjs attach') && content.includes('browser-screenshot')) {
      block = content;
      break;
    }
  }
  if (block === undefined) {
    throw new Error(
      'no fenced ```sh block in the loop SKILL names both evidence-attach.mjs attach and browser-screenshot',
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

describe('the loop SKILL’s browser-evidence attach command actually runs (RP-313)', () => {
  it('attaches a browser-screenshot evidence record exactly as the skill’s own command describes', async () => {
    const markdown = await readFile(loopSkillPath, 'utf8');
    const command = extractAttachCommand(markdown);

    expect(command).toContain('evidence-attach.mjs attach');
    expect(command).toContain('browser-screenshot');
    expect(command).toContain('playwright-mcp');
    expect(command).toContain('automated');

    const { dir, head } = await newProject();
    const runDir = await newRunDir();
    const ticket = 'RP-1';
    const url = 'https://app.example.invalid/login';
    await journalSelect(runDir, ticket);

    const screenshotRel = 'screenshot.png';
    const screenshotAbs = path.join(dir, screenshotRel);
    const screenshotBytes = Buffer.from('fixture-png-bytes-not-a-real-image');
    await writeFile(screenshotAbs, screenshotBytes);

    const substituted = command
      .replaceAll('<item-id>', ticket)
      .replaceAll('<url>', url)
      .replaceAll('<screenshot-path>', screenshotRel);

    const tokens = substituted.split(/\s+/).filter((token) => token.length > 0);
    // Fixture sanity: the command names `node` and the repo-relative
    // evidence-attach.mjs path exactly as the skill documents it, before
    // this test rewrites that path to run the real, absolute script.
    expect(tokens[0]).toBe('node');
    expect(tokens[1]).toBe('.claude/scripts/evidence-attach.mjs');
    expect(tokens).not.toContain('<item-id>');
    expect(tokens).not.toContain('<url>');
    expect(tokens).not.toContain('<screenshot-path>');
    const args = tokens.slice(2);

    const env = withoutGitLocation();
    env.RIG_RUN_DIR = runDir;
    const result = await run(process.execPath, [evidenceAttachScript, ...args], dir, env);
    expect(result.code, result.out).toBe(0);

    const evidenceFile = path.join(dir, '.rig', 'evidence', `${ticket}.jsonl`);
    const lines = (await readFile(evidenceFile, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    const stored = lines[0]!;

    expect(stored.kind).toBe('browser-screenshot');
    expect(stored.producer).toBe('playwright-mcp');
    expect(stored.authorityClass).toBe('automated');
    expect(stored.item).toBe(ticket);
    expect(stored.headSha).toBe(head);
    expect(stored.sha256).toBe(sha256Hex(screenshotBytes));
    expect((stored.subject as Record<string, unknown>).kind).toBe('page');
    expect((stored.subject as Record<string, unknown>).id).toBe(url);
  });
});
