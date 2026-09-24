// RP-259: a functional review of guard-bash found it doing exactly what it
// documents — refusing the git/credential-path cases it names — and NOT
// stopping `git reset --hard`, a piped `curl | sh`, or a destructive `sudo`
// command, none of which are its job. That is correct behaviour, but nothing
// in the rulebook said so: a reader could come away believing guard-bash is a
// general command sandbox, discover the gap in the worst way, and lose trust
// in every guard at once.
//
// This file pins that the rulebook states the boundary in the two places a
// reader would look — the canonical rulebook (`AGENTS.md`, of which
// `templates/agent-os/universal/AGENTS.md` is the generator's own copy) and
// `README.md` — rather than leaving it to be inferred from the hook's source
// comments alone. See `test/template/hooks.test.ts` › "leaves general
// OS/process isolation to the harness: reset --hard and a piped install stay
// allowed" for the behavioural side of the same boundary.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const README_PATH = path.join(repoRoot, 'README.md');
const AGENTS_PATH = path.join(repoRoot, 'templates', 'agent-os', 'universal', 'AGENTS.md');

/**
 * A "boundary statement" names `guard-bash`, says it is not a general
 * sandbox, and points at the harness's own sandboxing as where that job
 * actually belongs — all three within reach of one another, so a reader who
 * finds one finds the other two. Matching is a bounded window around every
 * `guard-bash` mention rather than one rigid sentence, because the three
 * clauses can land in either order ("guard-bash is not a sandbox; that is the
 * harness's job" reads as naturally as "general isolation is the harness's
 * sandbox's job, not guard-bash's").
 */
function statesTheSandboxBoundary(text: string): boolean {
  const lower = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf('guard-bash', from);
    if (at === -1) return false;
    const window = text.slice(Math.max(0, at - 200), at + 500);
    if (
      /\bnot\b/i.test(window) &&
      /\bsandbox\b/i.test(window) &&
      /\b(harness|native)\b/i.test(window)
    ) {
      return true;
    }
    from = at + 'guard-bash'.length;
  }
}

describe('the rulebook states guard-bash is not a general OS/process sandbox (RP-259)', () => {
  it('README.md says so, and points to the harness/native sandbox as the right place for that', async () => {
    const readme = await readFile(README_PATH, 'utf8');
    expect(
      statesTheSandboxBoundary(readme),
      'expected a `guard-bash` mention in README.md within reach of "not", "sandbox", and ' +
        '"harness"/"native" — the sentence stating guard-bash is not general command isolation, ' +
        "and that general OS/process isolation is the harness's own sandbox setting",
    ).toBe(true);
  });

  it('the canonical rulebook (AGENTS.md) says so, next to where guard-bash is introduced', async () => {
    const agents = await readFile(AGENTS_PATH, 'utf8');
    expect(
      statesTheSandboxBoundary(agents),
      'expected a `guard-bash` mention in templates/agent-os/universal/AGENTS.md within reach of ' +
        '"not", "sandbox", and "harness"/"native"',
    ).toBe(true);
  });

  it('the helper finds the boundary once it is written as two sentences (self-check)', () => {
    const text =
      'guard-bash refuses the Never tier. It is not a general OS sandbox — that job belongs ' +
      "to the harness's own native sandboxing, never this hook.";
    expect(statesTheSandboxBoundary(text)).toBe(true);
  });

  it('the helper does not fire on an unrelated, distant mention of sandbox/harness (self-check)', () => {
    const text =
      'guard-bash refuses a force-push to a shared branch, full stop.' +
      ' '.repeat(600) +
      'Some unrelated later section happens to talk about a sandbox and a harness for reasons ' +
      'that have nothing to do with guard-bash at all.';
    expect(statesTheSandboxBoundary(text)).toBe(false);
  });
});
