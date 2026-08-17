import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = (...parts: string[]) =>
  path.join(repoRoot, 'templates', 'agent-os', ...parts, 'SKILL.md');

function frontmatterOf(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  expect(match, 'skill must start with YAML frontmatter').toBeTruthy();
  const fields: Record<string, string> = {};
  for (const line of match![1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

// agent-os v2 brief §1–§3: ship the two skills without which a stated rule has
// no implementation, with frontmatter as *enforcement*, not documentation.
describe('post-deploy-verify skill (stack/aws-cdk)', () => {
  it('exists in the aws-cdk stack layer and produces the autonomy verdict', async () => {
    const content = await readFile(
      skillPath('stack', 'aws-cdk', '.claude', 'skills', 'post-deploy-verify'),
      'utf8',
    );
    expect(content).toMatch(/HEALTHY/);
    expect(content).toMatch(/REGRESSION/);
    expect(content).toMatch(/revert/i);
  });

  it('is mechanically constrained: forked context, read-only tool set', async () => {
    const content = await readFile(
      skillPath('stack', 'aws-cdk', '.claude', 'skills', 'post-deploy-verify'),
      'utf8',
    );
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('post-deploy-verify');
    expect(fm['context']).toBe('fork');
    expect(fm['allowed-tools']).toBeTruthy();
    expect(fm['allowed-tools']).not.toMatch(/Write|Edit/);
  });

  it('is scoped to what the skeleton provisions, and calls a vacuous result "no signal"', async () => {
    const content = await readFile(
      skillPath('stack', 'aws-cdk', '.claude', 'skills', 'post-deploy-verify'),
      'utf8',
    );
    // the deploy job's conclusion is the primary, always-available signal
    expect(content).toMatch(/deploy job.*primary|primary.*signal/i);
    // freshness cross-check kept; DLQ depth kept
    expect(content).toMatch(/UPDATE_COMPLETE/);
    expect(content).toMatch(/DLQ/);
    // the honesty rule: empty metric = no invocations = "no signal", not a pass
    expect(content).toMatch(/no signal/i);
    expect(content).toMatch(/no invocations/i);
  });
});

describe('loop skill (universal) — the driver the autonomy tiers were waiting for', () => {
  it('exists, selects from the queue, and REFUSES to invent work', async () => {
    const content = await readFile(skillPath('universal', '.claude', 'skills', 'loop'), 'utf8');
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('loop');
    expect(content).toMatch(/Agent queue/);
    expect(content).toMatch(/Operator queue/);
    // the load-bearing stop condition: queue empty → end, do not improvise
    expect(content).toMatch(/queue.*empty/i);
    expect(content).toMatch(/do not invent work/i);
    expect(content).toMatch(/journal/i);
  });

  // U-1: closing an item is not the end of its state. What the close released
  // is reported — and "nothing was waiting" is reported too, because an absent
  // line and an unpaid debt look identical from outside.
  it('reports what a close unblocked, including when the answer is nothing', async () => {
    const content = await readFile(skillPath('universal', '.claude', 'skills', 'loop'), 'utf8');
    const section = /## 9\.[\s\S]*?(?=\n## |$)/.exec(content);
    expect(section, 'the state-update section must still exist').toBeTruthy();
    const nine = section![0];
    // whitespace-tolerant: the prose is wrapped, and a rule that survives only
    // until the next reflow is a rule nothing checks
    expect(nine).toMatch(/unblocked/i);
    // both halves: name what was released, or say nothing was
    expect(nine).toMatch(/nothing\s+was\s+waiting/i);
    expect(nine).toMatch(/required,\s+not\s+a\s+step\s+for\s+when\s+it\s+applies/i);
    // and the third answer, which is the one a flat-list queue owes: an
    // adapter that cannot be asked must not be reported as asked
    expect(nine).toMatch(/no\s+dependency\s+links/i);
    // and it is a REPORT: correcting the dependents is what §2 forbids, so the
    // rule that would collide with it has to be ruled out where it is stated
    expect(nine).toMatch(/report,\s+not\s+an\s+edit/i);
  });

  it('the journal has the field that write-back writes to', async () => {
    // A required field with nowhere to land is a rule that decays on contact.
    // AR-64 moved the journal out of PLAN.md into `journal/YYYY-MM.md`, so the
    // field documentation moved with it — the check follows the contract, it
    // does not shrink to fit the move. (The month-file convention itself is
    // pinned in journal.test.ts.)
    const readme = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', 'journal', 'README.md'),
      'utf8',
    );
    expect(readme).toMatch(/\*\*unblocked\*\*/);
    expect(readme).toMatch(/never\s+dropped/i);
    // "cannot answer" is never "checked, found nothing" — the same distinction
    // the nullable `Ticket.body` turns on, and the reason the field has three
    // answers rather than two
    expect(readme).toMatch(/absent\*?\*?,\s+not\s+satisfied/i);
  });
});

// extraction brief §3 Tier A: the worktree lifecycle carries the mechanism and
// almost no domain — but the host-specific paths and Windows notes are domain.
describe('worktree-task skill (universal) — isolation per task, host-agnostic', () => {
  const read = () => readFile(skillPath('universal', '.claude', 'skills', 'worktree-task'), 'utf8');

  it('exists and states both halves of the lifecycle', async () => {
    const content = await read();
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('worktree-task');
    expect(fm['allowed-tools']).toBeTruthy();
    expect(content).toMatch(/git worktree add/);
    expect(content).toMatch(/git worktree remove/);
    expect(content).toMatch(/git worktree prune/);
  });

  it('names the gotchas that make the cleanup non-obvious', async () => {
    const content = await read();
    expect(content).toMatch(/absolute/i); // stale cwd nests worktrees in dead paths
    expect(content).toMatch(/cd out|cd OUT/i); // remove fails from inside
    expect(content).toMatch(/another session|other session/i); // concurrent sessions
  });

  it('carries no host-specific absolute path — the domain that must not travel', async () => {
    const content = await read();
    expect(content).not.toMatch(/[A-Z]:\//); // C:/Users/...
    expect(content).not.toMatch(/\/Users\/[a-z]/i);
    expect(content).not.toMatch(/\/home\/[a-z]/i);
    expect(content).not.toMatch(/windows/i);
  });
});

describe('PLAN.md queue convention (universal)', () => {
  it('ships both queues so work has a stated origin', async () => {
    const plan = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', 'PLAN.md'),
      'utf8',
    );
    expect(plan).toContain('## Agent queue');
    expect(plan).toContain('## Operator queue');
    expect(plan).toMatch(/__PROJECT_NAME__/);
  });

  // extraction brief §3 Tier A: the journal template. A journal with no stated
  // fields decays into a diary — and the fields are what a later reader (or a
  // sweep) can actually cross-check.
  //
  // AR-64 moved that template out of PLAN.md — `## Journal` was 58.1 KB of this
  // repo's plan and ~22k tokens on every session that opened it. The fields are
  // still pinned; what changed is the file a reader is sent to. The heading's
  // ABSENCE from PLAN.md is asserted too, so the move cannot half-happen and
  // leave two homes for one convention.
  it('states the journal entry fields in journal/README.md, not in PLAN.md', async () => {
    const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
    const plan = await readFile(path.join(universal, 'PLAN.md'), 'utf8');
    const readme = await readFile(path.join(universal, 'journal', 'README.md'), 'utf8');
    // the SECTION, anchored to its own line: a plan that explains where the
    // journal went may legitimately name the old heading in prose
    expect(plan).not.toMatch(/^##\s+Journal\s*$/m);
    for (const field of ['done', 'escalated', 'stopped at', 'queue hygiene']) {
      expect(readme.toLowerCase(), field).toContain(field);
    }
    // a field the session cannot observe stays visibly empty, never estimated
    expect(readme).toMatch(/never estimate|not estimated|visibly empty/i);
  });
});

// A queue item is a claim about the code, and the expensive failures start with
// one of those claims being false: the test is written against the item, the
// implementation against the test, and the reviewer compares the diff to the
// item — so nothing downstream re-reads the file the item was wrong about. This
// skill checks that BEFORE the Red step. Written for this repo; the shape of the
// problem is general, the text is not carried in from anywhere.
describe('check-premises skill (universal) — the item is a claim, not a fact', () => {
  const read = () =>
    readFile(skillPath('universal', '.claude', 'skills', 'check-premises'), 'utf8');
  const readLoop = () => readFile(skillPath('universal', '.claude', 'skills', 'loop'), 'utf8');

  it('exists and cannot implement anything — a verification step, read-only', async () => {
    const content = await read();
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('check-premises');
    expect(fm['allowed-tools']).toBeTruthy();
    expect(fm['allowed-tools']).not.toMatch(/Write|Edit/);
    // a cold reader is the point: the authoring context is what talked itself
    // into the premise in the first place (workflow.md, review-context isolation)
    expect(fm['context']).toBe('fork');
  });

  it('states both boundaries — the two it is worthless without', async () => {
    const content = await read();
    // 1. a false load-bearing premise stops the work; it is never routed around
    expect(content).toMatch(/stop and report|stop-and-report/i);
    expect(content).toMatch(/never.*(work around|route around|silently)/i);
    // 2. load-bearing claims only — this is not an audit of the codebase
    expect(content).toMatch(/load-bearing/i);
    expect(content).toMatch(/not an audit/i);
  });

  // The verdict vocabulary IS the contract: the loop hardcodes one of these
  // words. Renaming a verdict here must not leave the suite green.
  it('names its four verdicts, and an unverifiable premise is not a pass', async () => {
    const content = await read();
    for (const verdict of ['PREMISES HOLD', 'PREMISE FALSE', 'UNVERIFIABLE', 'UNMEASURED']) {
      expect(content, verdict).toContain(verdict);
    }
    expect(content).toMatch(/not a soft pass|is not a pass/i);
    // the limit this rulebook keeps insisting on: nobody observes the verdict
    expect(content).toMatch(/Limits/);
    expect(content).toMatch(/self-report|reporting on itself/i);
  });

  // 🔴 AR-68: the second entry point, and the measurement that bought it. Two cold
  // readers over two gate rounds returned 24 blocking findings, and the run's own
  // prose about mechanisms was the largest class of them — figures it had not measured,
  // limits wider than the code, a claim of enforcement with no hook behind it. Each
  // cost a gate round (`docs/decisions/unbacked-prose-is-a-blocker.md` for the split).
  // The claims are checkable BEFORE the gate by exactly the machinery that already
  // checks an item's claims, so this skill gains a second use rather than the repo
  // gaining a second skill.
  it("runs on the run's own prose too, before the gate, with its own verdict", async () => {
    const content = await read();
    // the second entry point is named as such, not implied
    expect(content).toMatch(/two entry points|second entry point|entry points/i);
    // and it is ordered: before the gate, not after a reviewer found it
    expect(content).toMatch(/before .{0,40}(gate|pr-ship)/i);
    // the verdict for a behaviour claim with nothing behind it
    expect(content).toContain('UNMEASURED');
    // and the only two exits from it — the claim goes, or it becomes a pointer
    expect(content).toMatch(/delete/i);
    expect(content).toMatch(/pointer to (a|the) test|pointer to the test/i);
  });

  it('carries worked examples, and no tracker key travels with them', async () => {
    const content = await read();
    expect(content).toMatch(/example/i);
    // Domain leaks as ticket keys: SCRUM-123, ABC-4. The rig is nobody's tracker.
    // Narrow on purpose — technical prose is full of SHA-256 and UTF-8, and a
    // guard that fires on honest writing gets deleted (rules/invariants.md).
    // Two-letter prefixes stay out: they are valid tracker project keys, so
    // each one is a hole opened for prose nobody has written yet.
    const technical = /^(SHA|UTF|RFC|ISO|AES|RSA|HTTP|IPV|CVE)$/;
    const keys = [...content.matchAll(/\b([A-Z][A-Z0-9]+)-\d+\b/g)]
      .map((m) => m[1]!)
      .filter((prefix) => !technical.test(prefix));
    expect(keys).toEqual([]);
  });

  it('is reachable: the loop calls it after selection and before the Red step', async () => {
    const loop = await readLoop();
    expect(loop).toMatch(/check-premises/);
    // order, not just presence — the whole value is that it runs before the test
    const procedure = /check-premises[\s\S]{0,120}failing\s+test/;
    expect(procedure.test(loop), 'the per-task procedure must run it before Red').toBe(true);
    // and the loop must speak the skill's own vocabulary
    expect(loop).toContain('PREMISE FALSE');
  });

  // The second call site has to be in the driver, because the fix belongs to the
  // author: a reviewer reporting unbacked prose has already cost the round this
  // exists to save.
  it('is called a second time before the gate, on the prose the task itself wrote', async () => {
    const loop = await readLoop();
    expect(loop).toMatch(/UNMEASURED/);
    const beforeGate = /check-premises[\s\S]{0,400}(pr-ship|the gate)/;
    expect(beforeGate.test(loop), 'the driver must run it before the gate').toBe(true);
  });

  // The loop delegates to §6 for what happens next, so §6 has to recognise it.
  // A pointer into a list that does not name the case is a dead reference.
  it('is recognised by the loop as a per-task stop, in both lists that define them', async () => {
    const loop = await readLoop();
    const perTaskStops = /Per-task stops \(([^)]*)\)/.exec(loop);
    expect(perTaskStops, 'the loop must still enumerate its per-task stops').toBeTruthy();
    expect(perTaskStops![1]).toMatch(/premise/i);
    const escalation = /Task-scoped[\s\S]{0,400}/.exec(loop);
    expect(escalation![0]).toMatch(/premise/i);
  });
});

describe('pr-ship skill (universal)', () => {
  it('exists in universal and states the gate + verdict', async () => {
    const content = await readFile(skillPath('universal', '.claude', 'skills', 'pr-ship'), 'utf8');
    expect(content).toMatch(/SHIP/);
    expect(content).toMatch(/HOLD/);
    expect(content).toMatch(/code-reviewer/);
    expect(content).toMatch(/security-scanner/);
  });

  it('carries an allowed-tools constraint', async () => {
    const content = await readFile(skillPath('universal', '.claude', 'skills', 'pr-ship'), 'utf8');
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('pr-ship');
    expect(fm['allowed-tools']).toBeTruthy();
  });
});
