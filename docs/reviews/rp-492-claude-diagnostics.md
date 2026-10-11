# RP-492 — Claude Code diagnostics on the Rig payload (read-only)

A read-only audit, run on 2026-10-11 in a disposable clone of `master`. Nothing
in this repository, its generated payload or the loop skill was changed by it.
Findings about the auditing machine's own user-scope setup (personal plugins,
skills, hooks, installs) are not repository facts; they were reported to the
owner on the ticket and are left out here.

| Item               | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| Claude Code        | 2.1.296                                                      |
| Mode of the audits | `claude -p "<command>" --permission-mode plan`, 5-minute cap |

## What ran

| Diagnostic                        | Status        | Notes                                                                                                                                                          |
| --------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude doctor`                   | LIVE OBSERVED | No installation issue attributable to this repository.                                                                                                         |
| `/doctor` (prompt audit)          | LIVE OBSERVED | Declined to propose edits to `AGENTS.md`/`CLAUDE.md`/rules: they are synced from `templates/agent-os/universal` and pinned by `test/template/dogfood.test.ts`. |
| `/skill-doctor`                   | LIVE OBSERVED | Use counts per project skill (below).                                                                                                                          |
| Context size, measured (no model) | LIVE OBSERVED | Byte counts; tokens approximated as bytes / 4.                                                                                                                 |

## Context cost of the rulebook, measured

Byte counts at master `6cac1165`, reproducible with `wc -c <path>`; the
`inject-rules` row is the byte length of the hook's `additionalContext` for a
`{"hook_event_name":"SessionStart","source":"startup"}` payload.

| Bytes  | ~Tokens | Path                                            | Loaded (intended; not traced here)                |
| ------ | ------- | ----------------------------------------------- | ------------------------------------------------- |
| 90,582 | ~22,645 | `.claude/skills/loop/SKILL.md`                  | full body on use                                  |
| 29,904 | ~7,476  | `.claude/skills/pr-ship/SKILL.md`               | full body on use                                  |
| 22,321 | ~5,580  | `AGENTS.md`                                     | at session start (through the `CLAUDE.md` import) |
| 17,696 | ~4,424  | `.claude/rules/invariants.md`                   | at session start                                  |
| 15,854 | ~3,964  | `.claude/skills/check-premises/SKILL.md`        | full body on use                                  |
| 12,635 | ~3,159  | `.claude/rules/autonomy.md`                     | at session start                                  |
| 10,605 | ~2,651  | `.claude/rules/workflow.md`                     | at session start                                  |
| 7,854  | ~1,964  | `inject-rules` SessionStart `additionalContext` | every start, resume and compaction                |
| 4,032  | ~1,008  | `.claude/rules/node-ts.md`                      | at session start                                  |
| 909    | ~227    | `CLAUDE.md`                                     | at session start                                  |

How the harness loads `AGENTS.md`, `CLAUDE.md` and the rule files was not traced at
the wire level here. `/doctor` estimates the always-loaded rulebook at about 17k
tokens, consistent with the rows above. That figure comes from the model under audit,
not from an external counter.

## Project skill use (`/skill-doctor`, 7-day window)

| Skill                                                                            | Uses | Last used |
| -------------------------------------------------------------------------------- | ---- | --------- |
| `check-premises`                                                                 | 148  | 4 days    |
| `loop`                                                                           | 121  | 1 day     |
| `pr-ship`                                                                        | 43   | 6 days    |
| `worktree-task`                                                                  | 16   | 2 days    |
| `diagnose`, `new-invariant`, `plan-slices`, `release-propose`, `skill-authoring` | 0    | never     |

## Findings

Backed by the output above:

- `inject-rules` adds about 2k tokens at every start, resume and compaction, on top
  of the rule files themselves. The rule files and the injected excerpt overlap:
  the excerpt is `autonomy.md` minus its reference sections.
- Five shipped project skills were never invoked in this repository's own sessions
  during the window. That is a dogfood signal, not evidence that they are unused in
  generated rigs.

Speculative, proposals only, not applied, each needing its own ticket and review:

- Load `invariants.md` on demand instead of at session start (`/doctor` floated
  this and did not propose it).
- Measure whether the injected `autonomy.md` excerpt is still needed when the
  harness already loads the rule file, before removing either.
