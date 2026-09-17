# ADR-RP-003 — ownership hashes cover exact bytes

⚠ **This record is not synced.** Most files in this directory are composed from
`templates/agent-os/universal/docs/decisions/` by `scripts/sync-agent-os.mjs`.
This record governs create-agent-rig's own upgrade manifest and stays only in
the generator repository, alongside `memory-rig-boundary.md` and
`cost-ceiling-over-growth-ratio.md`.

Status: accepted for RP-177.

## Decision

A SHA-256 value in `.claude/.rig-manifest.json` is evidence about the exact
bytes that create-agent-rig observed or wrote. Manifest comparison reads the
file as bytes and hashes those bytes. It must not decode the file as UTF-8 and
hash a replacement-character string.

Text normalization is a separate compatibility classifier. In particular,
line-ending-only compatibility may explain a text difference, but normalized
bytes never prove that the on-disk file is pristine and never replace the raw
ownership hash.

The manifest schema does not change: hashes remain lowercase SHA-256 strings.
Only their enforced meaning becomes exact. A legacy `kept` hash that was
derived through lossy UTF-8 decoding cannot vouch for different raw bytes, so
upgrade fails safe and classifies the file as edited rather than overwriting
it.

Detokenization remains a text operation. Upgrade may compare a detokenized
candidate only when the current byte sequence round-trips through UTF-8
without loss; the raw-byte candidate is always checked independently.

## Evidence

`packages/cli/test/init.test.ts` records invalid UTF-8 as a kept file and pins
its exact-byte hash. `packages/cli/test/create.test.ts` carries the same
ownership through create and proves upgrade classifies matching raw bytes as
an update rather than a conflict.
