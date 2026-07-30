# Stack rules — AWS + CDK

How the universal boundaries land on AWS. If a rule here seems to fight a
universal rule, that is an invariant conflict — stop and surface it.

## The elevated paths this layer adds

`CLAUDE.md` declares the project's own elevated paths; this block adds the ones
that exist only because this layer does. The gate sweep
(`.claude/scripts/detect-missed-gate.mjs`) unions every declaration it finds, so a
target without infrastructure never declares a directory it does not have.

```elevated-paths
infra/
```

## Infrastructure is code, and only code

- Everything lives in the CDK app under `infra/`. A console change ("click-ops")
  is drift, and drift is a defect — reproduce it in CDK or revert it.
- **Every change under `infra/` passes the `cdk-diff-reviewer` agent before it
  is deployed.** The review reads the synthesized diff (what CloudFormation
  will do), not just the source. Deploying around a BLOCKED verdict is a
  Never-tier action.
- `cdk synth` stays region-agnostic and credential-free: synth must work on any
  machine, in CI, with nothing configured.
- `RemovalPolicy` is always explicit. The skeleton ships DESTROY for easy
  teardown; flip to RETAIN before real data arrives — that flip is a Tier-2
  decision.

## Stacks: what may move, and what may never

- 🔴 **Never move a stateful construct between stacks.** A Table, Bucket, Secret
  or user pool that changes stack is **deleted and recreated** by
  CloudFormation — that is data loss, not a refactor, and it passes review as
  "tidying" if nobody knows this rule. Stateful constructs stay put and are
  referenced cross-stack.
- **A stack has a hard resource ceiling (500).** One HTTP route costs several
  resources, so a growing API stack approaches it long before it looks big. When
  it does, split out the least-coupled domain as a **stateless-only** stack —
  functions, roles, routes — attached to the same API cross-stack, with a
  **one-way** dependency. Splitting stateless costs nothing; splitting stateful
  costs the data (above).
- **Fleet-wide function defaults live in one module, not in a stack.**
  Architecture, runtime, `NODE_OPTIONS`, tracing: one edit there reaches every
  function. A per-stack override of a fleet default is the thing to reject in
  review — it is invisible from anywhere except that stack.

## IAM: least privilege, by construction

- Use the narrow grant for the operation actually performed
  (`grantWriteData`, `grantSendMessages`) — never `grantFullAccess`, never
  hand-rolled `*` policies.
- A new permission is added when a usecase needs it, in the same PR, with the
  test asserting it.

## Queues: DLQ discipline

- Every queue gets a dead-letter queue (small `maxReceiveCount`) **and** an
  alarm on DLQ depth. A queue without a DLQ is an unbounded retry loop.
- Consumers let poison messages throw. Catch-and-continue in a worker silently
  deletes data — the DLQ + alarm exist precisely so failure is visible.

## DynamoDB: single-table, single owner

- One table, generic key names (`pk`, `sk`). Key construction and item shapes
  live only in `packages/db` models — no other module composes a key string.
- Validate items on read (schema parse): the table is an external system, not
  a trusted store.
- On-demand billing by default; provisioned capacity is a data-driven Tier-2
  change.

## Lambda

- Each function has exactly one composition root entry file (`src/main.ts`,
  `src/list-main.ts`, …): environment parsed with `loadEnv(zod)` at boot,
  clients constructed once, handler exported. Nothing else imports an entry.
- Functions stay single-purpose — one route or one event source each. Fan-out
  belongs to infrastructure (queues, topics), not to in-process branching.
- **SDK clients are constructed at module top level, never inside the handler.**
  Containers are reused across warm invocations, so a client built in the handler
  body is paid on every invocation and defeats connection reuse — the most common
  Lambda performance bug, and invisible in tests because tests are always cold.
  The same applies to anything expensive and stateless: build once per container.
- Environment is parsed **once, at module scope**, through `loadEnv(zod)`. A
  misconfigured function then fails its cold start loudly instead of misbehaving
  quietly per request, and no code below the entry file reads the environment
  directly.

## When the deployed runtime misbehaves

Investigate before writing anything: the **`ro-debug` skill** has the read-only
recipes and, more usefully, the traps that have produced confident wrong
diagnoses — a stale local branch read as current, `UPDATE_COMPLETE` left over
from the previous deploy, an empty metric read as healthy when it means the
function was never invoked.

## Post-deploy verification (target-specific means)

The universal rule says verify runtime health after deploy; here the
implementation is the **`post-deploy-verify` skill** (`.claude/skills/`): stack
freshness, smoke the HTTP route (expect 201), confirm the worker consumed the
event, confirm the DLQ and its alarm are quiet — ending in the binary
HEALTHY / REGRESSION verdict. On regression: redeploy the previous revision
first, diagnose second.
