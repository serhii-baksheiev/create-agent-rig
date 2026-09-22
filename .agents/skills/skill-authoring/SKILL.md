---
name: skill-authoring
description: Use when authoring or editing a skill in this rig — a new SKILL.md under .claude/skills/, or a change to an existing one.
allowed-tools: Read, Grep, Glob
---

# Authoring a skill

No check in this rig runs on a skill you write here — the rules below are
applied by the author, and by a reviewer reading this file, never by a
mechanism. The same rules are what the generator's own
`test/template/skill-authoring.test.ts` (absent in a generated rig) checks —
against the skills this rig itself ships, not against any skill authored in
a generated rig.

- **The frontmatter `name` equals the directory name.** A skill loaded from
  `.claude/skills/foo/` is named `foo`, not something else.
- **The `description` says when to use the skill**, not just what it does.
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

## Out of scope

This is guidance to apply by reading, not an evaluator: the skill itself has
no procedure and checks nothing. It states the rules this rig applies to its
own shipped skills, nothing broader.
