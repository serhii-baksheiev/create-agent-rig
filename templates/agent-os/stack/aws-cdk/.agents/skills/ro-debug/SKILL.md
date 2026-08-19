---
name: ro-debug
description: Investigate the deployed runtime read-only — Lambda logs and error rates, DLQ depth and message age, table reads — with the traps that have produced confidently-wrong diagnoses before. Use when something on the deployed stage misbehaves, and before writing any fix.
allowed-tools: Bash, Read, Grep
---

# Read-only runtime investigation

A fix is always a code change through a PR. This skill only **looks** — and it is
scoped read-only so that a session diagnosing an incident cannot become a session
mutating production state under pressure, which is when that decision is worst.

## The role this assumes, and the honest caveat

Every command below wants a **read-only profile**: permission to read logs,
metrics, queue attributes and table items, and nothing else. No decrypt, no
secret reads, no mutations — so a credential cannot leak through this path even
by accident.

⚠ **The skeleton does not provision that role.** It ships the application, not
your account's access model, and minting a role is an **owner action** (a Tier-2
decision — it is IAM). Until it exists, either create it once with those four
read scopes, or accept that you are investigating with wider credentials than the
task needs and say so in the write-up. Do not silently upgrade to an admin
profile and carry on.

```sh
export AWS_PROFILE=<your read-only profile>
export AWS_REGION=__REGION__
```

## Before reading ANY code to explain a runtime behaviour

```sh
git fetch origin && git rev-parse HEAD "origin/$(git symbolic-ref --short HEAD)"
```

**If the local branch differs from its remote, diagnose from the remote**
(`git show origin/<branch>:<file>`, or a worktree). **A fetch does not move your
checkout** — reading stale local code while describing deployed behaviour is
the single most reliable way to produce a confident, wrong diagnosis, and it has
happened more than once. See `.claude/rules/autonomy.md`, "Session staleness".

## Recipes

**Find the function first** — CDK generates the physical names, so never guess one:

```sh
aws lambda list-functions \
  --query "Functions[?contains(FunctionName,'Notes')].FunctionName" --output text
```

**Errors in a window:**

```sh
aws logs filter-log-events --log-group-name "/aws/lambda/<fn>" \
  --start-time <epoch-ms> --filter-pattern "ERROR" \
  --max-items 20 --query 'events[].message' --output text
```

**DLQ depth, then message age.** Depth comes from the queue; **age does not** —
`ApproximateAgeOfOldestMessage` is a **CloudWatch metric, not an SQS attribute**,
and asking for it as an attribute fails with `InvalidAttributeName`:

```sh
aws sqs get-queue-attributes --queue-url <notes-dlq-url> \
  --attribute-names ApproximateNumberOfMessages

aws cloudwatch get-metric-statistics --namespace AWS/SQS \
  --metric-name ApproximateAgeOfOldestMessage \
  --dimensions Name=QueueName,Value=<notes-dlq-name> \
  --start-time <iso> --end-time <iso> --period 300 --statistics Maximum
```

Age is what tells you whether a non-empty DLQ **predates** the thing you are
investigating. A days-old backlog is not your regression, and treating it as one
sends the whole diagnosis in the wrong direction.

**Table reads** — key by whatever `packages/db` composes; nothing else knows the
key shape:

```sh
aws dynamodb query --table-name <NotesTable output> \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"NOTE#<id>"}}' --max-items 3
```

**Error rate:** `AWS/Lambda` `Errors`, `Sum`, by `FunctionName`, over the suspect
window.

## Interpretation rules — where wrong diagnoses actually come from

- 🔴 **An empty metric result is "no signal", never "healthy".** Zero datapoints
  means **no invocations in the window** — the function was not exercised, so the
  metric says nothing about whether it works. Report it as no signal and go find
  a window with traffic. This is the same rule the `post-deploy-verify` skill
  states, and for the same reason: a vacuous pass is worse than a missing one,
  because it gets believed.
- 🔴 **`StackStatus: UPDATE_COMPLETE` is stale evidence.** It persists from the
  previous deploy, so it is true of a stack whose latest deploy failed. The
  authoritative signals are the **deploy job's conclusion**
  (`gh run list --workflow deploy`) and the stack's `LastUpdatedTime` freshness.
- **DNS and asset-upload failures are infrastructure flakes, not code
  regressions.** A deploy that died at asset publish or checkout tells you nothing
  about the change. Your own read-only calls can hit the same flake — a failed
  probe is `unknown`, not a finding.
- **Never work around the profile's denials — that is the point of the profile.**
  Needing a decrypt, a secret or a mutation means the investigation has reached
  its boundary: escalate to the human with what you found
  (`.claude/rules/autonomy.md`, "Escalation format").

## What to hand back

What was observed (verbatim, not summarised), which window, which signals were
**unavailable** and why, the current hypothesis, and the narrowest reproduction.
A read-only investigation that ends in a named uncertainty is a good outcome; one
that ends in a confident story built on a stale read is not.
