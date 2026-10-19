# Bounded Windows CI failure convergence

This is a session procedure, not an automated classifier or a retry service.
The same evidence standard applies on other operating systems. A red check
remains a HOLD until the required check actually succeeds on the candidate's
exact head; this procedure never waives a required check.

## Classify before acting

| Classification | Evidence needed | Next action |
| --- | --- | --- |
| Product defect | An incorrect result, or a reproducible failure whose cause is established in the product or test code. | HOLD. Write the reproducing test, fix the cause, then run the normal checks and independent reviews on the corrected head. No unchanged retry to obtain green. |
| Confirmed runner instability | Evidence tying this failure to an external runner or hosting fault, such as a matching provider incident or an explicit infrastructure failure in the job log. A timeout alone is insufficient. | Preserve the failure and classification. At most one evidence-backed rerun of the same exact head and logical job is permitted under the conditions below. |
| Inconclusive, probable instability, or mixed evidence | Missing lifecycle evidence, an unexplained timeout, conflicting observations, or an unproven runner-cause hypothesis. | HOLD. Record what is known and unknown in the existing issue for this recurring failure. A new investigation needs a discriminating hypothesis and bounded evidence collection; do not rerun the same inconclusive experiment. |

A passing Linux or macOS job does not explain a Windows failure. A passing
full-suite job and a failing smoke job at the same SHA are different jobs;
their disagreement alone does not confirm runner instability. Empty streams,
a null exit code, a supervisor kill, or a timeout without an incorrect-result
assertion do not exclude a product defect. A runner-image or antivirus theory
without discriminating evidence remains a hypothesis.

## The single rerun is an evidence exception

Before launching it, record all of the following in the existing task and run
evidence:

1. The original run/job URL, exact source SHA, workflow revision, logical job
   and matrix, failure signature, and the evidence confirming an external
   runner fault. Keep the original failure observable.
2. The attempts already made for that head and logical job, including reruns
   and separate dispatches of the same check. The identity includes workflow
   revision, matrix and inputs; changing a run ID, controller, branch name or
   worktree does not renew the allowance. If attempt history is incomplete,
   or another controller may already be launching it, HOLD instead of guessing.
3. Why this one rerun can discriminate the confirmed external failure. Keep
   source, workflow, inputs, commands, assertions, deadlines, security controls
   and required-job coverage unchanged. Do not change configuration to obtain
   a fresh allowance, or manufacture a source commit to reset the history.
4. The existing diagnostic and review budgets. This exception neither grants
   another review round nor resets an exhausted counter or an unresolved HOLD.

Only confirmed runner instability with no previous evidence rerun permits the
one launch. A success is an exact-head check result, not proof of a fixed
product or stable runners. Retain the original failure, classification,
rerun identity and result together. A failure, cancellation, missing result or
another timeout leaves HOLD; there is no second unchanged rerun. Every other
required job must also complete successfully for the exact accepted head.

Do not relabel an assertion failure as infrastructure merely because a later
sample passes. Review findings, credential protection and required security
checks retain their normal authority. When the cause cannot be confirmed,
the ordinary flaky-test stop rule applies.

## Converge recurring observations

Append a recurrence to the existing failure umbrella with its exact SHA,
job, test or command, deadline, observable result and classification. Keep
supervised-process timeouts separate from plain test-runner timeouts; their
similar symptom does not establish one cause. Do not spawn an unbounded chain
of diagnostic tickets or repeat exhausted experiments.

An independent candidate's green checks cover only that candidate. A scoped
release decision must explicitly retain any deferred diagnosis and its HOLD;
it cannot turn that diagnosis into Done. Required candidate checks, package
acceptance and independent reviews remain mandatory. If no authorized,
discriminating next step exists, preserve the evidence and continue eligible
independent work.

## Mechanical limits

The generator's `test/template/decision-records.test.ts` (absent in a generated
rig) checks manifest membership in "is listed in layers.json for every record
on disk, and vice versa" and rulebook citations in "keeps no record that the
rulebook never points at". `test/template/dogfood.test.ts` (also absent in a
generated rig), "CLAUDE.md and .claude/ are in sync with templates/agent-os",
checks the generated copy. These checks do not establish a runner
cause, count hosted reruns or enforce this decision table. The controller must
read the actual job evidence and existing attempt history. No new database,
daemon, CI retry automation or alternate workflow authority is introduced.
