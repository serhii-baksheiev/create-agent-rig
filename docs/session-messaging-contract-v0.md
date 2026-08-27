# Session Messaging Contract v0

Status: proposed for RP-11. Owner human-review is required before RP-12 turns
these semantics into schemas and golden fixtures.

## Scope and invariants

Contract v0 defines session addressing, message delivery intent, observable
delivery outcomes, and capability evidence. It is a semantic contract, not a
transport API. Runtime adapters may add private metadata, but they must not add
transport routing identifiers or harness-native payloads to the public types.

Session identity is per concrete session instance. Two concurrent sessions for
the same engineer, harness, and project are distinct recipients and may expose
different effective capabilities.

Sender fields in an envelope are descriptive and not authoritative. An
authenticated transport principal is the authoritative sender identity, and
routing permissions bind that principal to the sender identity accepted by the
runtime. Recipients never trust a self-asserted payload identity.

DeliveryIntent and DeliveryClass are orthogonal. Intent records what the sender
asks the receiver to do; class records the delivery mechanism and timing. A
class such as PUSH is not a synonym for wake.

## Contract v0 types

The shapes below define required semantics. RP-12 owns their schema spelling,
strictness, and fixtures; it may add fields only when they preserve these
boundaries.

### SessionIdentity

`SessionIdentity` addresses one concrete instance and contains enough domain
identity to distinguish simultaneous sessions belonging to the same engineer,
harness kind, and project. At minimum it identifies the engineer, harness kind,
project where applicable, and a per-instance identifier. Capability resolution
uses the complete identity rather than the harness kind alone.

### Envelope

`Envelope` carries a message identifier, contract major version, message type,
payload, sender and recipient `SessionIdentity`, `correlationId`, optional
causation or reply linkage, and the requested `DeliveryIntent`.

The envelope contains domain identity only. Sender authenticity is established
outside the payload. Transport routing identifiers, self-asserted assurance
levels, and harness-native request payloads are excluded from this public shape.

### DeliveryIntent

`DeliveryIntent` is the closed set `notify | wake`.

- `notify` places information into the receiver's available context without
  intentionally starting or steering generation.
- `wake` asks the runtime to start a turn while idle or safely steer an active
  turn, subject to receiver authorization and admission safety.

`DeliveryIntent` remains independent of `DeliveryClass`; any supported class and
intent combination is interpreted by receiver policy and runtime capability,
not by treating the two fields as aliases.

### DeliveryClass

`DeliveryClass` is the closed set `PUSH | TURN_BOUNDARY | POLL | OFFLINE`.

- `PUSH` makes a message available immediately through a runtime capability.
- `TURN_BOUNDARY` makes it available at a safe boundary between turns.
- `POLL` requires the receiver to fetch available messages.
- `OFFLINE` records that no live delivery path is currently effective.

Class describes mechanism and timing, not whether generation should begin.

### SessionCapabilities

`SessionCapabilities` belongs to a `SessionIdentity` and records its effective
delivery class, supported intents, adapter-owned `ingressKind`, verification
state, and degradation information. It includes:

- `verifiedAt`;
- `verifiedBy: probe | traffic`;
- optional `lastAckAt`;
- a `verified | degraded | unverified` state;
- the count of consecutive expected-observation failures;
- an optional degradation or downgrade reason.

These are effective capabilities observed for one session, not a static mapping
from harness kind. A missing optional acknowledgement timestamp does not by
itself imply failure.

### DeliveryReceipt

`DeliveryReceipt` identifies the message and correlation, records an observation
time, keeps `requestedIntent` beside `effectiveIntent`, and optionally carries a
downgrade `{ from, to, reason }` or decline reason.

Observable progress uses these stages:

- `accepted`: the bus accepted the message;
- `routed`: the target adapter or runtime received it;
- `surfaced`: the message became available to the target session through an
  observable mechanism;
- `handled`: the bus observed a reply, ack, decline, or another explicit
  bus-visible reaction.

`declined` is a terminal outcome, not another linear stage after `handled`.
Receipts never infer model read or model cognition. A message may be surfaced
without being handled.

### ProbeResult

`ProbeResult` records a one-shot registration or reconnect probe. It identifies
the session, mechanism tested, observed outcome, observation time, evidence
pointer or notes, and the resulting effective capability and verification
state. It describes an observation and does not schedule future probes.

## Transport and adapter rulings

The public contract is transport-neutral. Transport subjects are derived by the
adapter/runtime from a validated `SessionIdentity`; they never appear in the
public envelope. NATS is the MVP transport, while replacing NATS is not an MVP
goal. Transport-neutral therefore does not mean that multiple transports must
be implemented.

Hooks are a degradation path for surfacing notify traffic at turn boundaries;
they are not the bus transport and do not define the canonical messaging model.
No central Session Gateway is assumed. A machine-local runtime or daemon is
allowed only when a later runtime ticket proves the concrete state it must own
and its topology.

The expected v0 baseline is:

- **Claude attached:** notify is surfaced through hooks at `TURN_BOUNDARY`.
  Claude channel wake is an optional candidate capability and remains enabled
  only when real traffic or an explicit ack verifies it.
- **Codex attached:** an ordinary attached session has notify through a
  `TURN_BOUNDARY` or other best-effort integration. Arbitrary attachment to an
  already-running ordinary TUI session is not promised as wake capability.
- **Codex managed:** a runtime-owned remote or app-server session uses
  `thread/inject_items` for notify. Wake uses `turn/start` when idle and
  `turn/steer` when busy, subject to receiver policy and safe admission.

These mappings are runtime details. They do not specialize or widen any public
type.

## Wake authorization and admission

Wake is receiver-authorized. The default authorization routes are:

1. a reply to a receiver-originated open request with the matching
   `correlationId`; or
2. an explicitly allowlisted engineer or authenticated principal.

Authorization is necessary but not sufficient. A background wake must not race
a human turn. When the runtime is uncertain about idle state or cannot atomically
admit an idle turn, it must downgrade wake to notify. When busy, it may steer
only if the runtime exposes a safe active-turn primitive.

A permitted downgrade keeps the message alive: `requestedIntent='wake'`,
`effectiveIntent='notify'`, and a visible downgrade reason. If the sender or
message is forbidden entirely, the message terminates as `declined` with a
reason. A policy transformation is not a decline.

## Capability verification and evidence

Effective capability is runtime-observed for each concrete session instance.
One active probe at registration and reconnect is allowed.
Periodic synthetic probes are forbidden because they consume and pollute a developer session.
After registration, verification is passive and based on real traffic.

Evidence is mechanism-specific:

- a turn-boundary path is surfaced only when the runtime reports that its output
  or context insertion was accepted;
- managed notify is verified by observable thread state showing the inserted
  item;
- managed wake is verified by observable turn-started or active-turn evidence;
- a channel with no delivery signal requires an explicit message ack, and only
  repeated expected-but-missing acknowledgements degrade capability.

Absence of traffic is never a failure. Degradation occurs only after the stated
number of expected observations fail.

Every evidence claim names, in order, the harness surface, harness version, OS,
and observed date, plus the test case or mechanism, result, and evidence
pointer. A newer version lowers confidence and may require re-validation; it
does not silently inherit evidence from an older version.

## Versioning

Contract v0 schemas use an explicit major version. Additive evolution within the
first supported major is allowed; consumers reject unsupported major versions.
Capability evidence has its own harness-version scope and is not made timeless
by the contract version.

## Non-enterprise-first baseline

Local, self-hosted, and public-subscription use remains a complete first-class
path for session identity, routing, delivery, receipts, and capability
verification. No core contract field, policy, lifecycle rule, or acceptance
criterion requires enterprise-managed capabilities.

Enterprise-managed capabilities and integrations may be optional capability
upgrades or governance enhancements; they are not a prerequisite for useful
delivery semantics.

## Conformance handoff

RP-12 can encode this decision when its positive and negative fixtures prove:

- concurrent instances of the same engineer and harness remain addressable;
- envelope identity cannot assert authority or carry transport routing data;
- intent and class are independent;
- allowed wake, downgrade-to-notify, unsafe-admission downgrade, terminal
  decline, surfaced-without-handled, and explicit handling are distinct;
- capability evidence includes verification method, time, version, OS, observed
  date, and expected-observation failure state;
- registration and reconnect probes do not imply periodic probing; and
- a complete non-enterprise installation passes the core contract.
