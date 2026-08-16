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

- **One task, one branch.** Every unit of work gets its own short-lived branch
  off the default branch. **Never commit work to the default branch** — it
  stays releasable at all times. This isolation of a unit of work is the rule;
  it holds even before there is a remote (local branches are enough).
- Commits are small and single-purpose; the message says *why*, not just *what*.

## Review-context isolation

The session that wrote the code is measurably worse at reviewing it: it
carries its own reasoning in context and will not challenge its own decisions
the way a cold reader does. That is *why* `code-reviewer` is a separate
subagent with a fresh context, and why the `pr-ship` gate fans reviewers out
instead of self-checking. This isolation is load-bearing, not ceremony — do
not "optimise" it away by reviewing in the authoring session.

## PR flow

This applies **once the project has a remote and CI checks** — a freshly
generated project has neither, and until it does the branch discipline above is
the whole of it. When they exist, a human-review change (see `autonomy.md`)
travels one path to merge, in this order:

1. **Local checks** — the full suite, lint, typecheck, all green locally first.
   A red check is information, never something to retry until green (`autonomy.md`).
2. **Reviewer fan-out**, by what the change touches — and *how much* fan-out is
   decided first, in ascending order of cost:

   | lane | what reaches it | what it costs |
   | --- | --- | --- |
   | `deterministic` | every changed file is a derived artifact | the checks alone; no reviewer |
   | `fast-path` | documentation outside the rulebook | `prose-reviewer` alone |
   | `model` | everything else | the full fan-out below |

   `.claude/scripts/decision-router.mjs` decides this from the changed paths,
   and **risk flags escalate ahead of all three**: a file under a declared
   elevated path, a dependency manifest, a path naming auth or secrets or
   sessions, a deleted test. Any one of them means `model`, however cheap the
   change otherwise looked, and a path the router cannot classify means `model`
   too. The cheap lanes are an addition to this gate, never a subtraction from
   it — `code-reviewer` was "always" because every change was assumed to carry
   code, and the router decides that question mechanically instead of assuming
   it. A rulebook document is code here, so it never reaches the prose lane.

   The reviewer list the router returns is a **floor, not a ceiling**: it reads
   paths, while the triggers below read what the code *does*, and a path cannot
   say that a module parses untrusted input. The triggers may only add.

   On the `model` lane:
   - the `code-reviewer` agent **always**;
   - `security-scanner` when it touches auth, secrets/configuration, input
     parsing, file handling, or outbound calls;
   - `prose-reviewer` when it touches the documents that instruct agents — a
     rule file, a skill, an agent spec, `CLAUDE.md`, the README. In this layer
     the prose *is* the implementation, and it fails the same way code does:
     silently, in the direction of false confidence;
   - an infrastructure review when it touches infrastructure (the stack layer
     names the reviewing agent for the target).

   The `pr-ship` skill drives this fan-out and returns a SHIP / HOLD verdict
   with named blockers; blocking findings are resolved, not argued with.
3. **Merge — on an explicit, non-lazy criterion.** Do not trust a watcher
   command that can exit before the checks have even registered. Confirm that
   the **required** check completed successfully **for this commit** — a list
   that is merely "not failing yet" is not a pass. The concrete command is
   stack-specific and lives in `stack/*`; the criterion here does not name one.

**Post-merge tail:** verify the deployed surface is healthy (the target's
post-deploy verdict — `autonomy.md`), then update `PLAN.md` (close the task,
record any follow-up in a queue). Merge is not the finish line; a healthy
runtime and an honest plan are.

## PR policy

- One concern per PR. If the description needs the word "also", split it.
- The PR description states: intent, what changed, how it was verified, and any
  autonomy-tier judgment calls made (see `autonomy.md`).
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
