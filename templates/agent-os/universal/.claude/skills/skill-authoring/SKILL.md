---
name: skill-authoring
description: Use when authoring or editing a skill in this rig — a new SKILL.md under .claude/skills/, or a change to an existing one.
allowed-tools: Read, Grep, Glob
---

# Authoring a skill

The rules this skill checks against are the ones every shipped skill here
already follows — this does not invent new ones.

- **The frontmatter `name` equals the directory name.** A skill loaded from
  `.claude/skills/foo/` is named `foo`, not something else.
- **The `description` says when to use the skill**, not just what it does —
  the dispatching session picks a skill off that sentence alone.
- **Keep it short, and point at existing rules or scripts rather than
  restating them.** A skill that copies a rule's wording is a second copy
  that goes stale the day the rule changes; link to `.claude/rules/` or a
  script instead.
- **Every sentence describing how a mechanism behaves either points at the
  test that proves it, or is deleted.** `.claude/rules/invariants.md`,
  "State the limits — and test them", is the norm; the form is `see <file>
  (absent in a generated rig) › "<exact test name>"`.
- **A mention of a workflow-layer skill or script in a Core document is
  qualified "opt-in workflow layer"** — `loop` and `pr-ship` are examples,
  not this skill's own concern.
- **Both copies ship and must stay identical**: the Claude skill under
  `.claude/skills/` and the Codex repository skill under `.agents/skills/`.
  That mirror is checked in `test/template/codex.test.ts` (absent in a
  generated rig) › "publishes every shared skill through the Codex
  repository skill location" — not repeated here.

The structural checks a skill in this repository must pass — frontmatter
shape, the description, the cross-references, the routing-role names — are
generator tests: see `test/template/skill-authoring.test.ts` (absent in a
generated rig).

## Out of scope

This is not a generic skill evaluator. It checks the rules this rig actually
enforces on its own skills, nothing broader.
