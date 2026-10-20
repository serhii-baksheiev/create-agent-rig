# RP-526: Windows failure classification and release convergence

Observed 2026-10-19 through live Jira, GitHub REST run/job metadata, job logs
and the named historical source. This report introduces no Windows execution,
CI rerun, timeout change or diagnostic-budget extension.

The portable session policy is
[Bounded Windows CI failure convergence](../decisions/windows-ci-convergence.md).
It ships in Core because Core's autonomy stop rule cites it. The policy is
written guidance; it is not a mechanical cause classifier or rerun counter.

## Decision table applied to 1.7.1 evidence

| Observation                                                                                                                                                                                                                                                                                                                                                                                                            | Classification and limit                                                                                                                                                                                                                                         | Action                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run [38732323012](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/38732323012), Windows job 116412862128, source `b2bc4986ece61440c965e5c18b1120ebf7509325`: Spec Kit clean-init reports supervised Git root-query timeout, null exit code and empty stdout/stderr. The pinned test uses a 45,000 ms Windows child bound.                                                                            | INCONCLUSIVE. These observations do not establish whether the Git child launched or why progress stopped. Linux/macOS success is separate evidence.                                                                                                              | Retain RP-518. No identical diagnostic rerun. A future investigation needs a discriminating lifecycle hypothesis and authorized budget.                                                                                                   |
| Run [38800452553](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/38800452553), Windows job 116647794264, source `66c50ad0afbdb6912f002b769d33c598ea2acffc`: the controlled CIM-error test expected exit code 1, but observed null code, killed true, SIGTERM and empty stderr.                                                                                                                      | INCONCLUSIVE. The test invokes a real PowerShell consumer with a 45,000 ms outer timeout; it does not measure CIM availability or explain the earlier supervised Git timeout. This assertion failure does not by itself prove a product cause or a runner cause. | Preserve the unmerged diagnostic source and historical fifth-round HOLD. Do not conflate this diagnostic process with proof of failure inside the production supervisor. No sixth round was consumed by this documentation task.          |
| Run [38872343097](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/38872343097), Windows smoke job 116879147649, source `e1cc0790f7819cc6d96d29e1a1fdcbd955dd90ad`: uninstall and upgrade tests each timed out at 15,000 ms. Separate full E2E run [38872343116](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/38872343116), Windows job 116879147817, succeeded on the same SHA. | Probable runner instability was the audit hypothesis, but the cause is unconfirmed. Under this policy that is INCONCLUSIVE. These are different jobs, and a timeout without a wrong-result assertion does not exclude a product defect.                          | Keep both outcomes. Neither the green E2E sample nor the antivirus/runner-image hypothesis alone authorizes an unchanged rerun of the failed smoke job. Aggregate recurrence in RP-518 rather than opening another speculative diagnosis. |
| Independent candidate run [39106409906](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/39106409906), source `3e927da1389f205acc1406f2b431379cedd931fe`: Linux, Windows and macOS E2E jobs succeeded.                                                                                                                                                                                                | Measured success for that candidate and check set. It neither fixes nor explains the two historical timeout mechanisms.                                                                                                                                          | Preserve the prior owner-confirmed candidate-specific RP-504 scope decision. RP-518 remains deferred diagnosis, In Progress/escalated, never Done. This sample supplies no 1.7.2 acceptance evidence.                                     |

No reviewed observation above confirms an external runner fault. Consequently
none qualifies for the one-rerun exception. A confirmed infrastructure incident
or explicit runner failure would first need evidence tied to the affected job;
that is a conditional example, not a diagnosis made here. A demonstrated wrong
result attributable to product code follows the product-defect row: reproducing
test, correction and normal exact-head verification, with no unchanged retry.

The three historical failure observations were appended to the existing
[RP-518 umbrella, comment 24693](https://sbaksheiev.atlassian.net/browse/RP-518?focusedCommentId=24693)
and independently read back on 2026-10-19. This aggregation preserves the
INCONCLUSIVE classification, historical fifth-round HOLD and existing status;
it records no new diagnostic attempt or rerun authorization.

## Release and attempt boundaries

At most one evidence-backed rerun is permitted per exact head and logical job
only after external runner instability is confirmed. The workflow revision,
matrix and inputs identify the check. Record the original failure and all
attempts, including separate dispatches, before launch; an incomplete history
or uncertain concurrent launch means HOLD. A new controller, run directory,
branch name or worktree does not replenish the allowance.

The exception changes no command, assertion, deadline, security control or
required job. A successful rerun must actually satisfy the exact-head check;
the failure remains in the evidence. Failed, cancelled, missing or timed-out
results leave HOLD, with no second unchanged rerun. Existing independent review
caps, diagnostic caps and blocking findings retain their authority.

RP-527 still requires all mandatory 1.7.2 work and its own Linux, Windows and
macOS evidence. RP-521 and RP-522 acceptance HOLDs are not excluded by this
policy. RP-518's historical fifth-round record and unmerged source remain
available; this task neither resets that budget nor claims a root-cause fix.

## Verification and reproducibility

The evidence can be reread through these read-only REST commands, replacing the
numeric ID with one from the table:

```sh
gh api repos/serhii-baksheiev/create-agent-rig/actions/runs/38872343097
gh api 'repos/serhii-baksheiev/create-agent-rig/actions/runs/38872343097/jobs?per_page=100'
gh api repos/serhii-baksheiev/create-agent-rig/actions/jobs/116879147649/logs
```

The 45,000 ms consumer bound and controlled error expectations are in
`packages/cli/test/windows-process-evidence.test.ts` at exact source
`66c50ad0afbdb6912f002b769d33c598ea2acffc`; the supervised Git child bound is in
`packages/cli/test/spec-kit.test.ts` at the exact `b2bc4986` source above.
Historical log retention can expire; a missing log must remain unknown.

Existing `test/template/decision-records.test.ts` checks that every decision is
listed and cited. The new decision produced observed REDs for missing manifest
membership and missing rule citation before those connections were implemented.
These structural checks do not prove prose classifications or enforce hosted
rerun budgets. Core placement also needs generated-install verification: the
union-of-layers structural assertion alone cannot prove a Core citation's
target travels in Core. Source/template drift, installation and upgrade are
covered by the repository's existing required checks; their current results
belong in the PR and run evidence, not assumed from this report.
