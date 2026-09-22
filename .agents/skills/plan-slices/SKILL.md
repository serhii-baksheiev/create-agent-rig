---
name: plan-slices
description: Use when a task cannot be verified as one reviewable PR and splits into slices that are each independently verifiable on their own. Ships only with the opt-in workflow layer.
allowed-tools: Read, Grep, Glob, Write, Edit
---

# Splitting a task into slices

This applies when a task's change cannot be reviewed and verified as one PR,
and decomposes into slices that are each independently verifiable — each
slice stands on its own claim about behaviour, checked by its own test.

Do not trigger it mechanically based on file or module count: a change
that touches many files but makes one verifiable claim stays one PR, and a
change touching few files but making several independent claims still
splits.

There is no planner role dispatched for this — the session writes the slice
plan directly. For each slice, record:

- the outcome the slice delivers, stated as a claim a test can check;
- its own failing test, written by `test-writer` in the ordinary Red step;
- the elevated paths it touches, if any (`AGENTS.md`'s elevated-paths block);
- where it sits in the slice order, and what it depends on.

Each slice then ships as its own PR through the ordinary flow —
`.claude/rules/workflow.md` has the TDD cycle and the PR flow in full; this
skill does not restate them.

This skill ships only with the opt-in workflow layer.
