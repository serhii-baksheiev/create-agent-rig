# Workflow — TDD, branches, PR policy, Definition of Done

## TDD is the default motion

Red → Green → Refactor, in that order, every time:

1. **Red** — write the test that describes the behavior; run it; watch it fail.
   Use the `test-writer` agent for this step: it writes the failing test and is
   scoped so it cannot "helpfully" write the implementation too.
2. **Green** — the minimum implementation that makes the test pass.
3. **Refactor** — clean up with the tests staying green.

No implementation before its failing test exists. A bug fix starts with a test
that reproduces the bug.

## Tests are load-bearing

- Never delete, skip, or weaken a test to make a run green.
- A flaky test is a defect to investigate, **not** a thing to re-run until it
  passes (see stop rules in `autonomy.md`).
- Fast checks run pre-commit; the full suite runs in CI. Bypassing pre-commit
  (`--no-verify`) is refused by a hook — fix the failure instead.

## Branches and commits

- Work happens on short-lived branches off the default branch; the default
  branch stays releasable.
- Commits are small and single-purpose; the message says *why*, not just *what*.

## Review-context isolation

The session that wrote the code is measurably worse at reviewing it: it
carries its own reasoning in context and will not challenge its own decisions
the way a cold reader does. That is *why* `code-reviewer` is a separate
subagent with a fresh context, and why the `pr-ship` gate fans reviewers out
instead of self-checking. This isolation is load-bearing, not ceremony — do
not "optimise" it away by reviewing in the authoring session.

## PR policy

- One concern per PR. If the description needs the word "also", split it.
- The `pr-ship` skill is the pre-merge gate: full checks, reviewer fan-out,
  DoD walk, and a SHIP / HOLD verdict with named blockers.
- The PR description states: intent, what changed, how it was verified, and any
  autonomy-tier judgment calls made (see `autonomy.md`).
- The `code-reviewer` agent runs before a PR is opened; its blocking findings
  are resolved, not argued with. The `security-scanner` agent runs whenever the
  change touches auth, secrets, input parsing, or outbound calls.
- CI must be green before merge. A red check is fixed or the PR is closed —
  never merged around.

## Definition of Done

A change is done when **all** of these hold:

- [ ] A test written first demonstrates the new behavior (and failed before the change)
- [ ] The full test suite is green — nothing skipped, nothing weakened
- [ ] Lint and typecheck are clean
- [ ] Layer boundaries respected (no new cross-layer imports; core still pure)
- [ ] No secrets, credentials, or personal data in code, config, or fixtures
- [ ] Docs touched by the change (README, rules) are updated
- [ ] The autonomy tier of the change was checked and honored (`autonomy.md`)
