# Stack rules — AWS + CDK

How the universal boundaries land on AWS. If a rule here seems to fight a
universal rule, that is an invariant conflict — stop and surface it.

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

- Each function has one composition root (`src/main.ts`): environment parsed
  with `loadEnv(zod)` at boot, clients constructed once, handler exported.
  Nothing else imports `main.ts`.
- Functions stay single-purpose — one route or one event source each. Fan-out
  belongs to infrastructure (queues, topics), not to in-process branching.

## Post-deploy verification (target-specific means)

The universal rule says verify runtime health after deploy; here the
implementation is the **`post-deploy-verify` skill** (`.claude/skills/`): stack
freshness, smoke the HTTP route (expect 201), confirm the worker consumed the
event, confirm the DLQ and its alarm are quiet — ending in the binary
HEALTHY / REGRESSION verdict. On regression: redeploy the previous revision
first, diagnose second.
