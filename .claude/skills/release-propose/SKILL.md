---
name: release-propose
description: Use to turn repeated evidence from `release-evidence.mjs` into a bounded candidate-release proposal for the owner to decide. Ships only with the opt-in workflow layer.
allowed-tools: Read, Grep, Glob, Bash
---

# Proposing a release from repeated pain

## 1. What this is not

The loop's own §7 improvement proposals are per-run fixes, filed and read one
run at a time. This skill is different: a release-level proposal, built from
evidence that recurred across more than one run, addressed to the owner —
never to the queue, and never approved by the skill itself.

## 2. Gather

Run exactly:

```sh
node "$(git rev-parse --show-toplevel)/.claude/scripts/release-evidence.mjs" --since <date> --json
```

Read its `verdict`, `groups` and `why`. Optionally read
`revalidation-report.mjs --json` the same way, the triage proposals already
on file, and the tracker — cite every one of these by pointer (run id, file,
seq, or ticket id), never from memory.

## 3. Measured vs. inferred

A number in the proposal is `measured` only when it came straight out of
`release-evidence.mjs`'s JSON or a cited line of a run/ticket. Every other
number or claim is labelled `inferred`, or `UNVERIFIED` when nothing backs it
at all — never stated as if it were measured.

## 4. Routing

- `GATHER_MORE_EVIDENCE` — gather-more-evidence: name what evidence would decide it, file nothing, and stop — never build a candidate release out of anecdotes.
- `REPEATED_PAIN` — write the proposal (§5) and hand it off (§6).

## 5. Proposal template

Write these headings, in order, into `$RIG_RUN_DIR/release-proposal.md`:

- **Observed repeated pain** — the repeated groups, each with its pointers
- **Candidate release** — the bounded scope this pain justifies
- **Why now**
- **Why not the alternatives** — including a required "Do nothing" row
- **Dependencies** — proven only; nothing inferred here
- **Scope / non-goals**
- **Complexity** — small, medium or large, plus the maintenance burden it adds
- **Evidence gaps** — what is still `inferred` or `UNVERIFIED`
- **Upstream capability check** — could a native plugin, connector, MCP
  server, CLI or provider feature do this instead: sufficient, insufficient
  or rejected, and why
- **Owner decision** — approve, reject or gather-more-evidence; left blank
  for the owner to fill in, never pre-filled by this skill

## 6. Hand-off

- Write the proposal to `$RIG_RUN_DIR/release-proposal.md`.
- File exactly ONE triage item, pointing at it:
  `node "$(git rev-parse --show-toplevel)/.claude/scripts/queue/propose.mjs" --file <proposal.json>`
  — finding = the repeated-pain groups by pointer; part = `"release"`;
  change = `"candidate release: <one line>"`; proof = what the owner would
  observe if the release lands.
- A triage item filed this way is unselectable by the queue on its own;
  promotion out of triage into selectable work is the owner's act, never
  this skill's.
- This skill never files a ticket in the selectable queue, never opens a
  GitHub issue directly, and never edits PLAN.md's Agent queue: the Agent
  queue is not something this skill touches, under any verdict.

This skill ships only with the opt-in workflow layer.
