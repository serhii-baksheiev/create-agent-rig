---
name: new-invariant
description: Turn a project rule into a mechanically enforced invariant — one stated rule, one PreToolUse hook that blocks its violation, one test for the hook. Use when a rule keeps being broken, when a review finding recurs, or when a post-mortem ends in "nothing stopped us doing that".
allowed-tools: Read, Grep, Glob, Write, Edit, Bash
argument-hint: [the invariant, in one sentence]
---

You add **one** invariant to this project's enforced set, using the pattern in
`.claude/rules/invariants.md`: a stated rule, a hook that blocks its violation,
and a test for the hook. All three land in the same change.

## Step 0 — get the invariant from the project, not from your own judgement

🔴 **Do not invent the invariant.** If the argument did not name one, ask. The
whole point of this layer is that the project chooses what is load-bearing; an
agent that supplies its own answer has handed the project a rule nobody agreed
to, and that rule will be obeyed without thought.

Ask for, or find, three things:

1. **The rule, in one sentence**, in the form "X never happens in Y".
2. **What it cost the last time it was broken.** If nobody can finish that
   sentence, stop and say so: an invariant with no incident behind it is a guess,
   and a guessed invariant fires on honest work.
3. **The compliant form.** What the code should look like instead — you need it
   for the allow case, and a rule with no stated alternative is a dead end.

Then check the fit against the table in `.claude/rules/invariants.md`. If it
cannot be decided from a single edit fragment — "this is too complex", "the
naming is off" — say so and stop: it belongs to `code-reviewer`, a lint rule or a
type, and forcing it into a hook produces a guard people fight.

Also check it is not already enforced. `grep` the existing hooks first; a second
guard for the same rule is two places to keep in step.

## Step 1 — write the failing test

TDD is not suspended here (`.claude/rules/workflow.md`). Copy
`guard-invariant.example.test.mjs` from this skill's directory as the shape, and
write the cases **before** the hook exists:

- **blocks** the violation — exit code 2, and the reason names the rule;
- **allows** the compliant form — exit code 0;
- **allows** a file outside the guarded scope — a guard that polices the whole
  repo will be disabled by lunchtime;
- **allows** prose that merely mentions the violation. This case is not optional.
  A guard that fires on a commit message, a doc line or a test fixture *about* the
  rule produces **false positives**, and false positives are how guards get
  switched off. Every real hook in this project strips or scopes text before
  matching for exactly this reason.

Run it. Watch it fail for the right reason (the hook does not exist yet).

## Step 2 — write the hook

Copy `guard-invariant.example.mjs` from this skill's directory to
`.claude/hooks/guard-<invariant-name>.mjs` and replace the parts the comments
mark. Name the file after **the invariant**, never after the tool it intercepts —
`guard-core-purity`, not `guard-write`.

Hold the contract:

- JSON payload on stdin; **exit 0 = allow, exit 2 = block**; stderr is the reason
  the agent reads, so write it as an instruction — what to do instead, and where
  the rule is stated.
- **Scope first, match second.** Return 0 immediately for files the invariant does
  not cover.
- **Fail open** on a malformed payload or any internal error. A crashed guard that
  blocks everything gets deleted within the hour.
- Zero dependencies, `node:` builtins only.

Run the test. Make it pass. Do not weaken a case to get there.

## Step 3 — wire it, or it enforces nothing

Add the hook to `.claude/settings.json` under `PreToolUse`, in the block whose
`matcher` covers the tools the invariant needs (`Write|Edit` for file content,
`Bash` for commands). An unwired hook is a file that passes its own test and
guards nothing — verify by triggering the violation once, for real, and watching
it be refused.

## Step 4 — state the rule where a reader will look

Add the sentence to the relevant file in `.claude/rules/` (or
`.claude/rules/invariants.md` if it fits nowhere else), next to a line saying
which hook enforces it and what the hook cannot see. A check with no stated rule
is a booby trap: someone will hit it, not understand it, and route around it.

## Done when

- [ ] The test failed before the hook existed, and passes now
- [ ] The violation is refused in a real session, not only in the test
- [ ] The hook is wired in `settings.json`
- [ ] The rule is written down, with the hook named next to it
- [ ] The hook guards **one** invariant, and its scope is as narrow as the rule

## A candidate that is already sitting there

The stack rules say service code logs through the shared structured logger, never
`console.log` — and nothing enforces it. That is the invariant the shipped example
encodes, so if the rule matters in your project, promoting the example into a real
hook is a copy, a rename and a wiring line.
