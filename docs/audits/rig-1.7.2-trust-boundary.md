# Rig 1.7.2 trust boundary audit — RP-525

Source snapshot: `5c77252b98d0978b077d3095af10a9511a9d4ab9`.
Initial host snapshot completed `2026-10-17T00:57:52.246Z` for
`serhii-baksheiev/create-agent-rig`. These dated observations describe the
owner's repository and this run; the universal payload has no corresponding
host configuration guarantee.

## Measured configuration

| Read-only query or probe                                | Observation                                                                                                                                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST repository metadata                                | Public repository; default branch `master`; caller permissions `admin`, `maintain`, `push`, `pull`, `triage` all `true`.                                                                                                                  |
| REST `repos/serhii-baksheiev/create-agent-rig/rulesets` | One branch ruleset: `19633773`, `No Push Master`, enforcement `disabled`.                                                                                                                                                                 |
| REST `branches/master/protection`                       | HTTP 404, `Branch not protected`.                                                                                                                                                                                                         |
| REST `rules/branches/master`, `2026-10-17T01:07:09Z`    | Empty array. This endpoint returns [active applicable rules][branch-rules], including rules from higher levels; no active required-check branch rule was observed on `master`.                                                            |
| REST `actions/permissions/workflow`                     | Default workflow permissions `read`; `can_approve_pull_request_reviews: false`.                                                                                                                                                           |
| REST `/user`, permission headers only                   | CLI credential advertised `admin:public_key, gist, read:org, repo, workflow`. Credential values and the response body were not retained.                                                                                                  |
| [CI job `117248935372`][ci-job] at the source snapshot  | Logged `GITHUB_TOKEN` permissions: `Contents: read`, `Metadata: read`. This measures that job's credential.                                                                                                                               |
| Reviewer runtime probe                                  | A separate security-scanner role created one assigned nonsecret file under ignored `.claude/runs/` with native `apply_patch`; the controller independently verified its bytes and SHA-256. Source-path write permissions were not probed. |

The runtime probe file contained `RP-525 reviewer runtime write probe.` and had
SHA-256 `354a2dae52842be4eedae9e24be52c2f21d7871793fb1789723f0e12b7b7b769`.
The [code][code-role], [security][security-role] and [prose][prose-role] reviewer
projections all declare `sandbox_mode = "read-only"`. The observed runtime write
means that declaration alone cannot establish a universally read-only reviewer
filesystem in this collaboration harness. Standalone Codex sandbox enforcement
and production-source write isolation remain unverified.

## Six layers: control, detection and limit

| Layer                             | What the evidence supports                                                                                                                                                                         | Boundary and bypass limit                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Harness and OS                 | Reviewer projections request read-only access; the runtime probe confirms shared runtime write access in this harness.                                                                             | Rig supplies no general OS sandbox. Separate review roles do not establish filesystem compartmentalization or source-write isolation.                                                                                                                                                                                                |
| 2. Tool hooks                     | [Wiring][wiring] invokes credential, rulebook, shell and Probity guards on named tools. [Required Probity availability][probity] produces denial answers; completed upstream refusals are relayed. | These inspect supported payloads. [Secret][secret] and [rulebook][rulebook] guards have fail-open exception paths; shell redirection is outside edit-tool inspection. [Shell parsing][shell] is bounded and POSIX-oriented. The baseline [no-verify guard][noverify] strips quoted text; RP-522 B has not delivered its replacement. |
| 3. Local Git and completion       | [Husky][husky] scans the staged index, then runs lint, typecheck and unit tests. [Stop DoD][stop] checks configured commands when applicable.                                                      | Commit-time scans cover their credential vocabulary. Stop checks depend on checkout configuration and can be inert for a clean tree or absent configuration; documented error paths fail open. They do not prove every possible write was inspected.                                                                                 |
| 4. Review and workflow            | [Coverage][coverage] checks routed, launched and answered reviewer records for the relevant source head. The controller must actually launch independent reviews and resolve blocking findings.    | [Verdict validation][verdict] checks report structure, not reviewer correctness or identity. Journal files and self-declared authority are evidence records, without cryptographic reviewer authentication.                                                                                                                          |
| 5. Hosted CI                      | [CI][ci] defines Linux checks and Windows unit smoke. [E2E][e2e] defines full Linux/Windows/macOS jobs on master, dispatch and schedule; selected PR paths select Linux E2E.                       | Windows/macOS E2E jobs exclude PR events. Documentation-only PRs do not automatically select E2E. Required checks remain a process obligation for the actual candidate head; the measured host settings do not enforce them on `master`. A green job supports only what it ran.                                                      |
| 6. GitHub privileges and metadata | The host snapshot exposes broad controller permissions and read-only workflow defaults. [The sweep][sweep] suppresses a finding when the `human-review` label is present.                          | An actor with triage access [can apply labels][labels]. The measured caller has that permission. Self-applied `human-review` and `owner-directed` labels cannot authenticate independent human review or grant engineering authority. No GitHub label or repository host setting was changed by this audit.                          |

The owner checkout's local Stop configuration listed lint and typecheck; the
audit checkout's tracked configuration additionally listed unit tests. Husky
and CI retain their own unit-test stages. A checkout-local Stop result must
therefore identify its configuration before being used as completion evidence.

## Probity worktree scope correction — RP-545

The source and host snapshots above remain historical observations. For the
generated-config correction, `packages/cli/test/probity-command.test.ts`
› "shows the pinned CLI skip a nested worktree under anchored globs and deny
it under the generated match-anywhere globs" compares the old anchored scope
with recursive source/test globs using the pinned Probity CLI and a
deterministic deny rule. The companion test › "has the pinned Probity CLI
deny a Codex apply_patch in a supported nested worktree source directory"
covers main/nested paths, dependency exclusion and a docs control.

Existing config ownership is retained; see
`packages/cli/test/probity-doctor.test.ts` › "warns that an anchored user-owned
config misses a supported nested worktree without rewriting the config".
The warning is a diagnostic for the recognized literal scope and nested
worktree shape, not a proof of arbitrary custom-config coverage.

This correction does not extend enforcement to external worktrees or resolve
lexical aliases. The direct foreign Claude Write and Codex apply_patch
exclusion cases and the lexical-alias case in
`test/template/probity-gate.test.ts` retain that boundary; the exact test
pointers are listed in [the compatibility scope notes](../compatibility.md#probity-scope-in-nested-worktrees-rp-545).
The upstream subagent-transcript limitation tracked by RP-429/RP-465 remains
outside this correction. `test/e2e/init.test.ts` › "denies nested source
writes through the generated Claude and Codex hook commands" adds the
generated POSIX command probe with a real nested Git worktree and a
deterministic deny rule. It does not execute Windows `commandWindows` or
measure a live model's TDD judgment.

## Owner-delegated elevated mode

The owner explicitly authorized autonomous ordinary and elevated engineering
decisions for this run. Independent AI review, required checks on the relevant
head, and recorded acceptance remain mandatory. This mode adds no mandatory
human-approval step, and AI acceptance is never presented as human approval.

The [authority contract][authority] lists delegated decisions and boundaries;
its native elevated-change acceptance entry is limited to changes elevated by
declared paths under that contract. [Decision records][decisions] preserve the
run's declared authority and resolution; their existence alone does not
authenticate an owner's grant. The owner instruction supplies authorization.
Required-gate failures, unreadable evidence, credential protections and the
kill switch remain boundaries. Publication requires separate authorization.

The legacy sweep's `human-review` name describes suppression metadata. Its
presence is never used here as a substitute for actual independent AI review,
an owner instruction, or independent human approval. The frozen 1.7.1 candidate
and the unresolved RP-518 evidence are unaffected by this audit.

[ci-job]: https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/38983312202/job/117248935372
[labels]: https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels#applying-a-label
[branch-rules]: https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch
[code-role]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.codex/agents/code-reviewer.toml
[security-role]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.codex/agents/security-scanner.toml
[prose-role]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.codex/agents/prose-reviewer.toml
[wiring]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/settings.json
[probity]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/hooks/probity-gate.mjs#L259
[secret]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/hooks/guard-secret-file.mjs
[rulebook]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/hooks/guard-rulebook.mjs
[shell]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/hooks/guard-bash.mjs
[noverify]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/hooks/block-no-verify.mjs#L46
[husky]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.husky/pre-commit
[stop]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/hooks/gate-stop-dod.mjs#L170
[coverage]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/scripts/lib/gate-coverage.mjs
[verdict]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/scripts/lib/verdict.mjs
[ci]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.github/workflows/ci.yml
[e2e]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.github/workflows/e2e.yml
[sweep]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/scripts/detect-missed-gate.mjs#L265
[authority]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/scripts/lib/authority.mjs#L32
[decisions]: https://github.com/serhii-baksheiev/create-agent-rig/blob/5c77252b98d0978b077d3095af10a9511a9d4ab9/.claude/scripts/delegated-decision.mjs#L178
