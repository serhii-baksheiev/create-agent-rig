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

## Windows evidence

The hosted `windows-latest` runner cannot measure the cases that spawn a real
guard child process. On that image a guard — `node .claude/hooks/<guard>.mjs`
fed a payload — intermittently costs about 24.5 s before its main logic runs:
on PR #202, head `af21c6d`, the guard's own exit trace read `preload 31`,
`stderr-write 24601`, `exit-event 2 24601`, `reallyExit 2 24601`, while the
same worker's bare Node start, stdin read and module import each took under
80 ms, and the cost did not move under four, two or one concurrent guards.
Native Windows 11 does not show it. Teardown is not where the time goes; the
step before the guard's first write is. The trace does not say which part of
that step — the entry's module load, the stdin read, or the guard's own
evaluation — carries the time.

So on a runner where `RUNNER_ENVIRONMENT` is `github-hosted` and the platform
is `win32`, the ten guard-spawning cases in `test/template/policy-benchmark.test.ts`
and `test/template/policy-benchmark-security.test.ts` are **UNVERIFIABLE**:
they skip through `guardProcessesMeasurable()` with that classification as the
reason, are reported as skipped and never as passed, and are counted like every
other platform skip in `test/template/platform-skips.test.ts`. The ten include
the Codex PowerShell-wrapper dispatch — the native-boundary case,
`test/template/policy-benchmark.test.ts` › "observes the native process boundary
of each configured harness command" — so on the hosted lane no guard runs
through PowerShell at all; that execution happens only in the native run below.
Nothing else changes on that lane — the deadlines, the assertions, the cleanup
contract and the rest of the suite run as before — and a self-hosted Windows
runner (`RUNNER_ENVIRONMENT=self-hosted`) runs all of them. See
`test/template/test-env-helpers.test.ts` › "guardProcessesMeasurable is false
exactly on a github-hosted Windows runner".

The benchmark's Windows acceptance is therefore a **native exact-head run**: the
benchmark project executed on a Windows host at the release candidate's SHA,
with its log attached to the PR and to RP-91. A hosted red or skipped lane is
recorded as what it is; it is not evidence either way.
