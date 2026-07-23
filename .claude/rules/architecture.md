# Architecture — layers and boundaries

The layout is the same in every target; only the adapters at the edges change.

## Layers

| Layer | Location | May depend on | Never contains |
| --- | --- | --- | --- |
| **core** | `packages/core/` | nothing (plus its schema library) | I/O, clock, randomness, environment, SDKs |
| **shared** | `packages/shared/` | nothing external of note | domain logic |
| **db** | `packages/db/` | core, shared | HTTP handling, business decisions |
| **services** | `services/*` | core, db, shared | direct SDK/storage access |

Dependency direction is one-way: `services → (core, db, shared)`, `db → (core, shared)`,
`core → nothing`. A dependency pointing the other way is a defect, not a style choice.

## The request path is fixed

Every operation travels the same route, with no shortcuts:

```
payload (schema-validated) → handler → usecase → domain function / model
```

- **Handlers** translate transport into typed input and back. Nothing else.
- **The usecase layer is mandatory.** Every business operation has exactly one
  usecase function. Handlers never call models or SDKs directly — even for a
  "trivial" read. The uniformity is the point: it is what makes the codebase
  predictable for both humans and agents.
- **Usecases receive their dependencies** (models, publishers, clock, id
  generation) as arguments. That is what keeps the core pure and the tests fast.

## The core is pure — and the rule is mechanical

`packages/core/src/` contains domain logic only: pure functions and schemas.
No I/O, no clock, no randomness, no environment, no SDK. Values like "now" and
"a new id" enter as arguments from the usecase layer.

This is not a convention you are trusted to follow; the
`guard-core-purity` hook refuses the edit at the tool layer. If the hook blocks
you, the answer is to move the impure part out — never to look for a way around
the hook.

## Storage has exactly one owner

`packages/db/` is the only place that touches the storage SDK/driver. Every
other external SDK likewise gets exactly one owning module. If you need a second
place, you actually need a function exported from the first place.
