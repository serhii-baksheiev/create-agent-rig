# ADR-RP-004 — the agent roles 1.0 targets

⚠ **This record is not synced.** Most files in this directory are composed from
`templates/agent-os/universal/docs/decisions/` by `scripts/sync-agent-os.mjs`
and travel into every generated project. This one is authored here and stays
here: it records a target for a release that has not shipped and names tracker
keys, so no shipped rulebook cites it. **Edit it in place.** The precedent is
`memory-rig-boundary.md` beside it.

Status: accepted as a **target**, not as shipped behaviour. The owner's
decisions are recorded on RP-194; the 1.0 work that implements them is tracked
under RP-89. Nothing in this record changes what 0.10.x installs.

## Why a record now

The role set was settled before 0.10.0 shipped and before any 1.0 work began.
Written down now, the 1.0 work starts from one agreed list instead of
re-deriving it, and a 0.10.x patch has a written line it must not cross.

## The decision

**Agents** in the 1.0 rulebook:

- `implementer`
- `test-writer`
- `failure-diagnostician`
- `code-reviewer`
- `security-scanner`
- `prose-reviewer`

**Skills:** the existing Core and workflow-layer set, plus `diagnose`,
`skill-authoring` and `plan-slices`.

**Not adopted:**

- no planner, architect or custom Explorer agent;
- `docs-researcher` stays optional — not part of the default set;
- no new hooks and no orchestration framework come with the role set.

## What this does not decide

- **The relation between `implementer` and 0.10.0's `implementation-agent`**
  was left to the 1.0 work, which has since settled it: `implementer` is
  `implementation-agent`. The owner's 1.0 mandate (22 September 2026) kept the
  shipped name, so no rename is part of 1.0.
- **Routing.** Which model each role runs on and how a change reaches a role
  are left to the 1.0 work and `subagent-routing.md`.

## Consequences for 0.10.x

A 0.10.x release adds none of the roles or skills above: no new agent file, no
new `SKILL.md`, no new routing row, no new hook. A patch that needs one of them
is 1.0 scope and waits for it.

**0.10.1 was the last 0.10.x release.** It was published from `738b494`, and from
there `master` is the 1.0 line: the roles and skills above land on it under
RP-195 and ship in 1.0.0, never in a 0.10.x release. The version in
`package.json` stays 0.10.1 until the 1.0.0 release commit changes it. A
0.10.x fix, if one is ever needed, is cut from `738b494`, not from `master`.
