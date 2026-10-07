# Composition presets — named bundles, not a profile system

⚠ **This record is not synced.** Most files in this directory are composed from
`templates/agent-os/universal/docs/decisions/` by `scripts/sync-agent-os.mjs`
and travel into every generated project. This one is authored here and stays
here: presets are a feature of the generator's CLI, not of a generated rig, so
no shipped rulebook cites it. **Edit it in place.**

Status: accepted 2026-10-07 (RP-314; design and its refinement on the Jira item,
comments 23372 and 23375).

## Decision

`init --preset <name>` and `create <dir> --preset <name>` install a named bundle
of what the CLI already composes. The data is static —
`templates/agent-os/profiles.json` maps a name to layers and to the
integrations doctor should expect — and this version ships `minimal` (the
default install) and `sdd` (the process and workflow layers, expecting Spec
Kit).

- **A preset is configuration sugar** over existing layers and integration
  intents. It is not a runtime or profile abstraction: there is no preset
  state, and nothing branches on a preset at run time.
- **The name is recorded for diagnostics only.** The installation manifest
  keeps it so doctor can report it; nothing reads it to decide what to install,
  refresh or run, and it never becomes execution state. `upgrade` carries it
  forward unchanged.
- **A preset owns nothing that runs.** It does not own provider lifecycle,
  scheduling, claims, the task graph or merge decisions. In particular `init`
  never installs, declares or runs a preset's integrations: Spec Kit's own
  lifecycle needs consent, the network and a clean tree, and belongs to
  `setup add`. `init` prints the `setup add` step to run instead.
- **Degradation.** An optional integration a preset expects but the repository
  has not declared is reported by doctor as not declared. It is never a
  failure, never installed behind the operator's back, and never changes
  doctor's status or exit code.
- **Compatibility.** A repository without preset metadata keeps its existing
  behaviour: its manifest has no `preset` key, a plain `init` writes none, and
  `upgrade` leaves it so. `--preset` only adds layers, exactly as `--layer`
  does.

## Why not a profile system

"Profile" already names other things here — Codex agent profiles, and the 1.0
command contract's statement that no named configuration profile exists — and a
profile that grows its own state is the parallel state machine this repository
avoids. Any future preset composes existing primitives, or justifies a new one
separately; it does not add execution semantics through the preset.

A preset that expects integrations this CLI does not yet register cannot ship.
`composed` arrived with the Playwright MCP integration (RP-313) and expects
Spec Kit and Playwright MCP, and BMAD TEA since its integration landed
(RP-315) — `templates/agent-os/profiles.json`.
