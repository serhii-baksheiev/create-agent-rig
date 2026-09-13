# Policy benchmark

Build the generator, then run the adapter benchmark from a clean checkout:

```sh
pnpm build
git rev-parse HEAD
node scripts/policy-benchmark.mjs --head <full-head-sha>
```

Use the SHA printed by Git. Retain the JSON output with the CI logs for that
commit. A failing benchmark must block acceptance; inspect its scenario results
before changing code or expectations.

`headSha` identifies the measured repository. `verifier.headSha` identifies the
generator checkout. Retain `verifier.contentSha256` with the report; it identifies
the verifier content measured by the runner, without certifying that a dirty
generator checkout has been committed or reviewed. The identity assertions live
in `test/template/policy-benchmark.test.ts` > "runs the same versioned corpus in
one process per harness and reports adapter-process evidence, not live-harness
proof".

The runner is a generator verification tool. Its evidence kind is
`adapter-process`: see `test/template/policy-benchmark.test.ts` > "runs the same
versioned corpus in one process per harness and reports adapter-process evidence,
not live-harness proof". Installed harness versions, interactive model behavior,
and a clean-machine Rig plus Memory installation need separate release evidence.

Run it only against repositories whose hook code you trust. The temporary
snapshot and restricted environment do not isolate filesystem access: see
`test/template/policy-benchmark-security.test.ts` > "refuses adapter-process
evidence when the measured target head moves after a worker has begun", whose
hook writes outside its snapshot workspace.

On Windows, Codex subprocesses execute the verified PowerShell wrapper with
piped input. Claude's single Node command runs with its verified hook path
resolved by the runner; this does not measure Claude's shell expansion. The
report names that execution boundary for each harness.
See `test/template/policy-benchmark.test.ts` > "observes the native process
boundary of each configured harness command" for the process observations.

Windows functional deadlines allow 30 seconds per benchmark command and 210
seconds per worker (six commands plus 30 seconds for setup and reporting).
The integration test allows 240 seconds per run, or 480 seconds for two serial
runs. See `test/template/policy-benchmark-runtime.test.ts` > "uses the Windows budget for six native commands and preserves the generic non-Windows budget",

> "allows a calibrated Windows command to complete after fifteen seconds", and
> "returns a stuck nested Windows command at thirty seconds without killing its worker boundary".

On Windows the two harness workers run one after another; on every other
platform they start together. See `test/template/policy-benchmark-runtime.test.ts`

> "runs the harness workers one after another on win32 and keeps adapter order
> in the settled results" and > "starts every harness worker at once off Windows
> and keeps adapter order in the settled results".

The corpus lives in `packages/cli/src/policy/benchmark/corpus.ts`. Its
classifications are `equivalent`, `intentional-degradation`, and `unsupported`;
see `packages/cli/test/policy-benchmark.test.ts` > "derives the closed benchmark
classifications from CapabilityState without inventing a fourth answer".
`INTEGRATION-FAILED` retains a separate failure flag: see the same suite > "keeps
an integration failure visible while classifying it as unsupported, so it can
never be mistaken for working enforcement".

A negative scenario can meet its expected rejection while describing unsupported
enforcement. Read the observed capability state alongside the assertion result;
see `test/template/policy-benchmark.test.ts` > "records an expected integration
failure as unsupported evidence instead of a passing enforcement result".

RP-111 final integration acceptance remains pending on the RP-13 payload and
integration of Memory's completed RP-14 contract deliverable. RP-14 itself is
Done; this benchmark has not yet provided that integration evidence. The report lists those dependencies under
`deferredIntegration`; they must receive their own evidence before RP-91 closes.
Keep the clean-machine, both-backend, and installed-harness acceptance records
with that release gate.
