# Unattended Execution

Rig does not run agents. Claude Code or Codex runs the session. Rig installs
the hooks that session calls, and offers two checks: preflight before an
unattended run starts, and `create-agent-rig doctor` at any time. Preflight
and the `loop` skill that runs it ship only with the opt-in workflow layer
(`init --layer workflow`), and doctor reports a rig without it as not ready:
`packages/cli/test/doctor-unattended.test.ts` › "reports workflow-layer-missing
as a failure on a rig without the workflow layer, and ok with it". Rig is not a
sandbox, a daemon or a remote execution platform. Isolating the process, its
permissions and its network stays with the harness's own sandbox setting.

## One contract, two surfaces

Which conditions decide whether a checkout is ready to run unattended, how each
is classified (`required`, `advisory`, `not-observable`) and which surface
reports it are defined once, in
[`.claude/scripts/lib/posture.mjs`](../templates/agent-os/universal/.claude/scripts/lib/posture.mjs).
The reasons are in
[`docs/decisions/unattended-posture.md`](decisions/unattended-posture.md).
This page does not repeat the list. Read the module for the current one; each
condition carries a one-line summary of what it checks.

Preflight and doctor report against that module and use its ids. Where both
report the same condition, they read it through the same code:
`packages/cli/test/doctor-unattended.test.ts` › "answers kill-switch-armed
exactly as the brake preflight reads does, including an AGENT_LOOP_STOP path"
and › "answers detection-contract-invalid exactly as preflight does, valid,
malformed and absent".

## What Rig enforces, verifies, and leaves to the harness

- **Enforced, at the tool layer.** The guards refuse specific edits and
  commands before they run. `AGENTS.md`, "Enforcement is mechanical", names
  each one, and each guard's own header lists what it cannot see.
- **Verified, before the first task.** A required condition that preflight
  checks and finds failing is STOP:
  `test/template/preflight-posture.test.ts` › "takes the verdict from the
  contract: every required check stops on its own, an advisory fail only
  cautions".
- **Reported, at any time.** `doctor --json` carries an `unattended` section
  beside its own checks. It changes neither doctor's own status nor its exit
  code: `packages/cli/test/doctor-unattended.test.ts` › "is additive: a rig
  not ready to run unattended still gets doctor’s own status and exit code".
- **Left to the harness, and said so.** Rig cannot observe the native sandbox
  mode, workspace trust, or whether the harness loaded its hooks this session.
  Doctor names that state as `unknown`, never as a pass:
  `packages/cli/test/doctor-unattended.test.ts` › "names the native harness
  state it cannot observe, only as unknown, never as ok". Preflight does not
  name it at all: `test/template/preflight-posture.test.ts` › "never reports a
  native harness state it did not measure".

## Before the first task

The opt-in workflow layer's `loop` skill runs this sequence; its §1 has the
full steps.

1. Run `node .claude/scripts/preflight.mjs`. Paste the block into the journal.
2. STOP: do not start. Fix the cause the failing line names, then run
   preflight again.
3. CAUTION: start, knowing which ground is soft. While any condition preflight
   names cannot be checked, a clean scripted run reads CAUTION:
   `test/template/preflight-posture.test.ts` › "names every condition it does
   not check by id and only as unknown, so a clean scripted run cautions rather
   than reporting GO".
4. Declare the run directory, then let the loop claim its first item.

An unattended flag that an earlier run left on disk for this checkout is a
STOP, because preflight runs before this run arms its own:
`test/template/preflight-posture.test.ts` › "stops on a flag a previous run
left armed, naming its item".

## Troubleshooting with doctor

```sh
npx create-agent-rig@latest doctor
npx create-agent-rig@latest doctor --json
```

The human output ends with `unattended readiness: <status>` and one
`<status>: unattended:<id>: <outcome>` line per condition:
`packages/cli/test/doctor-unattended.test.ts` › "prints the section in the
human-readable output too, one line per condition". Look up an id in
`posture.mjs` to see what it checks. `fail` is a required condition that
failed, `warn` is an advisory one or one that could not be judged, `ok` passed.
`docs/command-contract.md` describes the JSON shape.

After that block come five `authority:` lines: execution mode, decision
authority, publication authority, safety gates and kill switch:
`packages/cli/test/doctor-authority.test.ts` › "prints execution mode, decision
authority, publication authority, safety gates and kill switch". Execution mode
reads `unattended` only when an armed unattended flag for this checkout is
readable; otherwise it reads `unknown`, never `attended`. Decision authority
then comes from that run's `state.json`. With no armed run it reads `owner`,
the contract's default, which is not a measurement of any session:
› "is owner when no unattended flag is armed — no run declared any authority".
Without a rig manifest there is no project name to find the flag by, and both
read `unknown`: › "reports execution mode and decision authority unknown when
there is no rig manifest to name the flag".

## Kill switch and stopping

The brake is a file: `touch ~/.claude/<project>-loop-STOP`. While it exists,
`guard-bash` denies every merge, and everything short of the merge stays
allowed: `test/template/guard-bash.test.ts` › "denies gh pr merge while the flag
exists" and › "allows everything short of the merge while the flag exists".
Preflight and doctor both report the armed brake as a failure. Remove the file
to release it: `test/template/guard-bash.test.ts` › "allows the merge once the
flag is gone". A flag path that cannot be inspected counts as armed:
`test/template/guard-hardening.test.ts` › "denies gh pr merge when
AGENT_LOOP_STOP names a STOP file whose directory is chmod 000".

The loop's own stop conditions, and how a run turns its unattended flag off
when it stops, are in the `loop` skill.
