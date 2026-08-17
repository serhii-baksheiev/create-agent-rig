import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Extraction brief §1 and §6.4: the reusable thing is not any one rule but ONE
// PATTERN applied repeatedly — a stated invariant, a mechanical check that blocks
// its violation, and a test for the check. The rig ships the pattern and the
// scaffolding, plus a generator that asks what THIS project's invariant is.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const skillDir = path.join(universal, '.claude', 'skills', 'new-invariant');

const read = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

function node(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr });
    });
  });
}

describe('rules/invariants.md — the pattern, stated once', () => {
  const rule = () => read(universal, '.claude', 'rules', 'invariants.md');

  it('names all three parts, and says two of three is decoration', async () => {
    const content = await rule();
    expect(content).toMatch(/invariant/i);
    expect(content).toMatch(/hook/i);
    expect(content).toMatch(/test/i);
    // a rule with no check is a wish; a check with no test is a guess
    expect(content).toMatch(/all three|three parts/i);
  });

  // 🔴 AR-68: the norm behind `check-premises`'s `UNMEASURED` verdict. This section
  // already tells a guard to state its limits; what it did not say is what a limits
  // sentence has to be BACKED by, and the gap showed up as the largest single class
  // of gate blocker in this repository — a run's own prose about a mechanism. The
  // counts are in `docs/decisions/unbacked-prose-is-a-blocker.md`, which this rule
  // must cite, since a record no rule points at is a dump.
  it('requires a limits claim to be generated or a pointer to its test', async () => {
    const content = await rule();
    expect(content).toMatch(/generated/i);
    expect(content).toMatch(/pointer to (a|the) test/i);
    // and it names the consequence, so the norm is enforceable rather than advisory
    expect(content).toMatch(/by rule|blocker by rule/i);
    // the check that catches it before a reviewer does
    expect(content).toMatch(/UNMEASURED|check-premises/);
  });

  it('states what makes an invariant hookable at all', async () => {
    const content = await rule();
    // decidable from the text of one edit, with no network and no whole-repo scan
    expect(content).toMatch(/single edit|one edit|edit fragment/i);
    expect(content).toMatch(/not everything|do not|poor fit|bad fit/i);
  });

  it('does not overstate the enforcement it provides', async () => {
    const content = await rule();
    expect(content).toMatch(/best-effort/i);
    expect(content).toMatch(/review|tests/i); // the layers behind the hook
  });

  it('offers core purity as ONE project’s answer, never as a law', async () => {
    const content = await rule();
    expect(content).toMatch(/guard-core-purity/);
    // the brief's whole thesis: an inherited rule is invisibly wrong
    expect(content).toMatch(/example|not universal|delete it|yours/i);
  });
});

describe('the new-invariant skill — the generator', () => {
  const skill = () => read(skillDir, 'SKILL.md');

  it('is a skill with a constrained tool set', async () => {
    const content = await skill();
    const fm = /^---\n([\s\S]*?)\n---/.exec(content);
    expect(fm).toBeTruthy();
    expect(fm![1]).toMatch(/name:\s*new-invariant/);
    expect(fm![1]).toMatch(/allowed-tools:/);
  });

  it('puts the failing test before the hook, like every other change here', async () => {
    const content = await skill();
    const testStep = content.search(/write the (failing )?test/i);
    const hookStep = content.search(/write the hook/i);
    expect(testStep).toBeGreaterThan(-1);
    expect(hookStep).toBeGreaterThan(-1);
    expect(testStep).toBeLessThan(hookStep);
  });

  it('requires the invariant to come from the project, not from the agent', async () => {
    const content = await skill();
    expect(content).toMatch(/do not invent|never invent|ask/i);
  });

  it('ends by wiring the hook and stating the rule — an unwired hook enforces nothing', async () => {
    const content = await skill();
    expect(content).toMatch(/settings\.json/);
    expect(content).toMatch(/rules\//);
  });

  it('names the false-positive trap, which is how guards get disabled', async () => {
    const content = await skill();
    expect(content).toMatch(/false positive/i);
  });
});

describe('the shipped example is real code, not a sketch', () => {
  it('the example hook parses and runs', async () => {
    const result = await node(
      ['--check', path.join(skillDir, 'guard-invariant.example.mjs')],
      repoRoot,
    );
    expect(result.code, result.out).toBe(0);
  });

  it('the example test passes against the example hook', async () => {
    // "the three parts" is only credible if the shipped demonstration of it works
    const result = await node(
      ['--test', path.join(skillDir, 'guard-invariant.example.test.mjs')],
      skillDir,
    );
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/pass \d+/);
  });

  it('the example hook blocks its violation and allows the compliant form', async () => {
    const hook = path.join(skillDir, 'guard-invariant.example.mjs');
    const payload = (filePath: string, content: string) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
      });

    const runHook = (json: string) =>
      new Promise<{ code: number; err: string }>((resolve, reject) => {
        const child = execFile(process.execPath, [hook], (error, _stdout, stderr) => {
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, err: stderr });
        });
        if (!child.stdin) return reject(new Error('no stdin'));
        child.stdin.write(json);
        child.stdin.end();
      });

    const blocked = await runHook(
      payload('services/api/src/handlers/create-note.ts', 'console.log("hi");'),
    );
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/logger/i);

    const allowed = await runHook(
      payload('services/api/src/handlers/create-note.ts', 'logger.info({ msg: "hi" });'),
    );
    expect(allowed.code).toBe(0);
  });

  it('generating a hook from the example is a copy and a rename, nothing more', async () => {
    // The template must be self-contained: copied into .claude/hooks/ under a new
    // name it has to work with no edits beyond the rule it encodes.
    const dir = await mkdtemp(path.join(tmpdir(), 'inv-'));
    const source = await read(skillDir, 'guard-invariant.example.mjs');
    const copied = path.join(dir, 'guard-my-rule.mjs');
    await writeFile(copied, source);
    expect((await node(['--check', copied], dir)).code).toBe(0);
    // no relative import back into the skill directory
    expect(source).not.toMatch(/from '\.\.?\//);
  });
});

describe('composition', () => {
  it('layers.json classifies the pattern as process — it travels to any repo', async () => {
    const manifest = JSON.parse(await read(universal, 'layers.json')) as Record<string, string[]>;
    for (const file of [
      '.claude/rules/invariants.md',
      '.claude/skills/new-invariant/SKILL.md',
      '.claude/skills/new-invariant/guard-invariant.example.mjs',
      '.claude/skills/new-invariant/guard-invariant.example.test.mjs',
    ]) {
      expect(manifest['process'], file).toContain(file);
    }
  });

  it('CLAUDE.md points at the pattern, so a reader finds it without grep', async () => {
    const claudeMd = await read(universal, 'CLAUDE.md');
    expect(claudeMd).toMatch(/invariants\.md|new-invariant/);
  });
});
