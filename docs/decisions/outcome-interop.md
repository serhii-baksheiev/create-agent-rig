# Outcome Evidence interop — deferred, with the mappings that must not be made

⚠ **This record is not synced.** It is authored here and stays here, like
`adopt-wrap-extend-build.md` beside it. It records research the generator
deferred, and no shipped rulebook cites it. **Edit it in place.**

Status: accepted 2026-10-07 (RP-356, a delegated decision of the release
controller). The signal contract itself is the shipped
`templates/agent-os/universal/docs/decisions/outcome-signals.md`.

## CDEvents

The second research round mapped Rig's evidence onto CDEvents. Semantically
acceptable candidates:

- VCS change created and VCS change merged;
- change reviewed, with an outcome caveat (a Rig verdict is not a provider
  review state);
- a non-TDD-RED testSuiteRun finished;
- testOutput published, where the output is externally accessible.

Mappings that must not be made as standard CDEvents:

- agent dispatch is not a CI taskRun;
- intentional TDD RED does not inflate generic test failure;
- Rig claim/close is not the tracker ticket source of truth;
- workflow escalation/stall is not a production incident;
- evidence screenshot/trace is not a build artifact with a PURL.

The standard VCS and CI events largely duplicate what GitHub and CI providers
already emit natively, and what is unique to Rig would mostly need custom
namespace events. No CDEvents exporter or sink is committed; reopening this
needs a consumer that the provider-native events do not already serve.

## A future artifact descriptor

The RP-312 descriptor binds one artifact to one head. Aggregate or
provider-imported metrics would need a different binding — head/run/window
plus a window/population/metric scope binding — so that a figure cannot be
read as evidence about a single commit. That is recorded, not built: the
descriptor is not changed until a real producer and consumer exist.
