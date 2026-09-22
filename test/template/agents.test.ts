import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  GATE_SPEC_PATHS,
  readGateSpec,
  verdictExamplesIn,
  verdictWordsFor,
} from './verdict-spec.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const verdictLib = async (): Promise<{
  parseVerdict: (text: string) => {
    ok: boolean;
    problems?: string[];
    verdict?: Record<string, unknown>;
  };
}> =>
  (await import(
    pathToFileURL(
      path.join(
        repoRoot,
        'templates',
        'agent-os',
        'universal',
        '.claude',
        'scripts',
        'lib',
        'verdict.mjs',
      ),
    ).href
  )) as {
    parseVerdict: (text: string) => {
      ok: boolean;
      problems?: string[];
      verdict?: Record<string, unknown>;
    };
  };

// The change under review claims to implement a queue item. Nothing in the
// checklist made "it implements something else" a finding — so a change that
// silently re-aimed its own task passed review on the strength of being
// well-built. The premise check catches a false item; this catches a true item
// the change walked away from.
describe('code-reviewer agent (universal) — the change must be the change that was asked for', () => {
  const agentPath = path.join(
    repoRoot,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'agents',
    'code-reviewer.md',
  );

  it('blocks on a change that contradicts the item it claims to implement', async () => {
    const content = await readFile(agentPath, 'utf8');
    const blocking = content.slice(content.indexOf('## Checklist'), content.indexOf('## Advisory'));
    expect(blocking).toMatch(/contradict/i);
    expect(blocking).toMatch(/queue item|the item|the task/i);
    // and the verdict is to report it, not to reconcile the two by hand —
    // the refusal is the load-bearing half, so pin it rather than "report"
    expect(blocking).toMatch(/report/i);
    expect(blocking).toMatch(/never reconcile|do not reconcile/i);
    // a reviewer handed only a diff must say the item is missing, not guess
    expect(blocking).toMatch(/not (handed|supplied)|no item/i);
  });

  it('keeps the checklist it already had — this adds one item, it rewrites none', async () => {
    const content = await readFile(agentPath, 'utf8');
    for (const item of [
      'Boundary violations',
      'Test integrity',
      'Error handling',
      'Contract drift',
      'Autonomy breaches',
    ]) {
      expect(content, item).toContain(item);
    }
  });
});

// In this layer prose IS the implementation: a rule that overstates its own
// enforcement, or points at a hook that no longer exists, fails exactly like
// broken code — silently, and in the direction of false confidence.
describe('prose-reviewer agent (universal) — the rulebook is code here', () => {
  const agentPath = path.join(
    repoRoot,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'agents',
    'prose-reviewer.md',
  );
  const read = () => readFile(agentPath, 'utf8');

  it('exists, read-only, and reports with file:line like the other gates', async () => {
    const content = await read();
    expect(content).toMatch(/^---\nname: prose-reviewer\n/);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)![1]!;
    const tools = /^tools:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    expect(tools.trim().length).toBeGreaterThan(0);
    expect(tools).not.toMatch(/Write|Edit/);
    expect(content).toMatch(/file:line/);
    expect(content).toMatch(/BLOCKER/i);
  });

  // 🔴 AR-68: the norm that turns the most common blocker class into a rule.
  // An unbacked behaviour claim is a blocker BY RULE — the finding is the absence of
  // backing, not a disproof — which is what lets `check-premises` catch it before this
  // agent is ever launched. The norm is `.claude/rules/invariants.md`, "State the
  // limits".
  it('blocks an unbacked behaviour claim by rule, and says what backing looks like', async () => {
    const content = await read();
    expect(content).toMatch(/unbacked|nothing backs it|no test behind it/i);
    // the two acceptable forms, per invariants.md "State the limits"
    expect(content).toMatch(/generated/i);
    expect(content).toMatch(/pointer to (a|the) test/i);
  });

  it('allows an absent upstream test only for a manifest-proven inherited artifact', async () => {
    const content = await read();
    const checklist = content.slice(
      content.indexOf('## Checklist'),
      content.indexOf('## Advisory'),
    );
    const exception =
      /⚠ A pointer[\s\S]*?(?=\n\s*🔴 Three things this is not)/.exec(checklist)?.[0] ?? '';

    expect(exception, 'the inherited upstream-pointer exception must still exist').toBeTruthy();
    expect(exception).toMatch(/generator-authored (?:artifact|rulebook|hook|skill)/i);
    for (const artifact of ['rules', 'hooks', 'skills', 'scripts', 'agent specs']) {
      expect(exception, artifact).toMatch(new RegExp(artifact.replace(' ', '\\s+'), 'i'));
    }
    expect(exception).toMatch(/(?:upstream|generator)[^.]{0,80}tests?[^.]{0,120}absent locally/i);
    expect(exception).toMatch(/(?:pointer|artifact)[^.]{0,120}absent locally/i);
    expect(exception).toContain('.claude/.rig-manifest.json');
    expect(exception).toMatch(
      /manifest[^.]{0,160}hash[^.]{0,120}(?:match|same)|hash[^.]{0,160}(?:match|same)[^.]{0,120}manifest/i,
    );
    expect(exception).toMatch(
      /(?:upgrade|upgraded)[^.]{0,160}(?:inherited|generator-owned)|(?:inherited|generator-owned)[^.]{0,160}(?:upgrade|upgraded)/i,
    );
    expect(exception).toMatch(/only while[^.]{0,160}(?:manifest|hash)[^.]{0,120}(?:match|same)/i);
    expect(exception).toMatch(
      /(?:hash mismatch|hash[^.]{0,80}(?:differs|does not match)|no manifest|missing manifest|no evidence)[^.]{0,180}(?:local test|test is yours|exception (?:expires|ends|no longer applies))/i,
    );
  });

  it('states the boundary that keeps it from becoming a style gate', async () => {
    const content = await read();
    expect(content).toMatch(/not a (literary|copy) editor/i);
    // the explicit non-finding: prose that merely reads badly
    expect(content).toMatch(/clumsy|awkward|inelegant/i);
  });

  it('blocks on the six failures that make a rulebook lie', async () => {
    const content = await read();
    // scoped to the blocking section: demoting an item to advisory, or losing
    // the checklist and keeping the narrative, must fail this
    const blocking = content.slice(content.indexOf('## Checklist'), content.indexOf('## Advisory'));
    expect(blocking.length).toBeGreaterThan(0);
    // 🔴 The count is read from the list rather than written in the test's name. This
    // change takes the checklist from five items to six (the new one goes in at
    // position 5, domain-leakage moves to 6), and the name said "five" until it did —
    // so the next one will not have to remember to rename anything.
    const items = [...blocking.matchAll(/^\d+\. \*\*/gm)];
    expect(items.length, 'the checklist is six items; add an assertion with a seventh').toBe(6);
    expect(blocking).toMatch(/overstat/i); // a claim the mechanism does not support
    expect(blocking).toMatch(/dead (reference|link)|no longer exists/i);
    expect(blocking).toMatch(/contradict/i); // two rule files disagreeing
    expect(blocking).toMatch(/stale/i); // stated limits that drifted
    // and the one the release note forgot it had: domain leaking into a layer
    // that claims to be neutral
    expect(blocking).toMatch(/must not travel|vendor|tracker key/i);
    // the newest: a factual claim about behaviour with nothing behind it
    expect(blocking).toMatch(/unbacked/i);
    expect(blocking).toMatch(/by\s+\*\*rule\*\*|blocker \*\*by\s+rule\*\*|by rule/i);
  });

  // The failure this agent is most likely to cause itself: a confident BLOCKER
  // on the adapter seam that exists to name the vendor it adapts.
  it('does not fire on a seam built to name a vendor', async () => {
    const content = await read();
    expect(content).toMatch(/seam .*not a leak|not a leak/i);
  });

  it('states the limit that applies to itself — nothing launches it', async () => {
    const content = await read();
    expect(content).toMatch(/nothing launches you|nothing makes this run/i);
    // and it must say so even when the overstatement is about itself
    expect(content).toMatch(/convention, not a mechanism|claim, not a guarantee/i);
  });

  it('is reachable — a gate nothing calls is decoration', async () => {
    const workflow = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'rules', 'workflow.md'),
      'utf8',
    );
    expect(workflow).toContain('prose-reviewer');
    const prShip = await readFile(
      path.join(
        repoRoot,
        'templates',
        'agent-os',
        'universal',
        '.claude',
        'skills',
        'pr-ship',
        'SKILL.md',
      ),
      'utf8',
    );
    expect(prShip).toContain('prose-reviewer');
  });
});

// AR-65: a reviewer's verdict stops being prose the calling session
// pattern-matches by eye. Each of these agents ends its report with exactly one
// fenced ```json block of the shape `lib/verdict.mjs` defines, so `pr-ship` can
// check "one verdict per run" and "a stop names a blocker" instead of reading
// for them. The gate SKILLS make the same promise — their half of this is
// in `skills.test.ts`. RP-177 retired the fourth reviewer this used to cover
// (`cdk-diff-reviewer`, stack-scoped) along with the aws-cdk stack.
describe('every reviewing agent ends with one machine-readable verdict', () => {
  const REVIEWERS = ['code-reviewer', 'prose-reviewer', 'security-scanner'];

  it.each(REVIEWERS)('%s asks for exactly one fenced json block', async (gate) => {
    const content = await readGateSpec(gate);
    // "exactly one" is the load-bearing half: two blocks is two verdicts, and a
    // reader that takes either one is choosing a verdict for the reviewer.
    expect(content).toMatch(/exactly one[\s\S]{0,80}json/i);
  });

  it.each(REVIEWERS)('%s shows an example verdict that names itself', async (gate) => {
    const content = await readGateSpec(gate);
    const examples = verdictExamplesIn(content, gate);
    expect(examples, `${gate} ships no fenced json example`).not.toHaveLength(0);

    // The gate field is copied from the example by whoever follows the spec, so
    // an example naming a DIFFERENT gate teaches every run to mislabel itself.
    const own = examples.filter((example) => example['gate'] === gate);
    expect(own, `no example in ${gate} carries \`"gate": "${gate}"\``).not.toHaveLength(0);

    const allowed = await verdictWordsFor(gate);
    for (const example of own) {
      expect(allowed, `${gate} shows a word it may not return`).toContain(example['verdict']);
    }
  });
});

// RP-195 slice 2: failure-diagnostician answers in the same machine-readable
// shape as the reviewers (lib/verdict.mjs), but it is not a merge gate — it
// diagnoses a failure or a claimed/historical finding, on request, and its
// two input kinds return different halves of its vocabulary
// (docs/decisions/agent-roles-1.0.md; the words themselves in
// `.claude/scripts/lib/verdict.mjs`).
describe('failure-diagnostician agent (universal) — a checked answer, not a merge gate', () => {
  const gate = 'failure-diagnostician';

  it('has a declared spec path', () => {
    expect(GATE_SPEC_PATHS[gate]).toBeDefined();
  });

  it('asks for exactly one fenced json block', async () => {
    const content = await readGateSpec(gate);
    expect(content).toMatch(/exactly one[\s\S]{0,80}json/i);
  });

  it("shows one example per input kind, and each parses as this gate's own verdict", async () => {
    const content = await readGateSpec(gate);
    const examples = verdictExamplesIn(content, gate);
    expect(examples, `${gate} ships no fenced json example`).not.toHaveLength(0);

    const own = examples.filter((example) => example['gate'] === gate);
    expect(own, `no example in ${gate} carries \`"gate": "${gate}"\``).not.toHaveLength(0);

    const allowed = await verdictWordsFor(gate);
    for (const example of own) {
      expect(allowed, `${gate} shows a word it may not return`).toContain(example['verdict']);
    }

    // A failure input answers ROOT_CAUSE or INCONCLUSIVE; a claim/historical
    // finding answers one of the other four. At least one example of each
    // kind must be shown, or the definition teaches only one half of its job.
    const FAILURE_WORDS = ['ROOT_CAUSE', 'INCONCLUSIVE'];
    const CLAIM_WORDS = ['STILL_LIVE', 'ALREADY_FIXED', 'OBSOLETE', 'INSUFFICIENT_EVIDENCE'];
    expect(
      own.some((example) => FAILURE_WORDS.includes(example['verdict'] as string)),
      `${gate} shows no example answering a failure input (${FAILURE_WORDS.join(', ')})`,
    ).toBe(true);
    expect(
      own.some((example) => CLAIM_WORDS.includes(example['verdict'] as string)),
      `${gate} shows no example answering a claim/historical-finding input (${CLAIM_WORDS.join(', ')})`,
    ).toBe(true);

    // The ROOT_CAUSE example carries `classification` — required on that word
    // (design decision 2), and the definition should not show a bare example
    // that would itself be refused.
    const rootCause = own.find((example) => example['verdict'] === 'ROOT_CAUSE');
    if (rootCause !== undefined) {
      expect(
        rootCause['classification'],
        'the ROOT_CAUSE example names no classification',
      ).toBeDefined();
    }

    const { parseVerdict } = await verdictLib();
    for (const example of own) {
      const raw = '```json\n' + JSON.stringify(example) + '\n```';
      const parsed = parseVerdict(raw);
      expect(
        parsed.ok,
        `an example in ${gate} does not parse: ${JSON.stringify(parsed.problems)}`,
      ).toBe(true);
    }
  });

  it('treats absent workflow-layer run-state and journal as the normal path, qualified as opt-in', async () => {
    const content = await readGateSpec(gate);
    // The optional-evidence paragraph must say the workflow layer is opt-in —
    // Core-layer prose never presupposes a capability a Core-only rig lacks
    // (see test/template/core-workflow-references.test.ts).
    expect(content).toMatch(/opt-in workflow layer|--layer workflow|workflow layer/i);
    expect(content).toMatch(/run-state|journal/i);
  });

  it('keeps throwaway reproduction files outside the repository and makes no repository edits', async () => {
    const content = await readGateSpec(gate);
    expect(content).toMatch(/outside (the )?repository/i);
    expect(content).toMatch(/no repository edits|never edits? (the )?repository|makes no edits/i);
  });
});
