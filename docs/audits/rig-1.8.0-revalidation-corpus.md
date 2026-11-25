# Rig 1.8.0 revalidation evaluation corpus — RP-563

Status: the historical, constructed, and pressure populations are frozen inputs.
Independent labels are bound to the two synthetic populations; 32 corpus checks pass.
Full candidate verification and independent pre-merge gates remain pending. This document does not claim a
false-HOLD rate, a false-negative rate, or the <5% target.

## Populations and boundaries

The retrospective fixture is `test/fixtures/revalidation-corpus/historical-2026-10.json`
(SHA-256 `9fec66526223db94383b1dbf6003f4dd164b173ec65fe8496f8d5bbddb1cdb9f`). It
contains the available-source population selected from 90 run directories and 1,309
events in the predeclared `[2026-10-01T00:00:00.000Z, 2026-11-24T00:00:00.000Z)`
window. It contains 252 opportunities: 124 recorded catches, 8 unverifiable
observations, 117 recorded `actionRequired: false` outcomes, 1 `true` outcome, and
6 unresolved outcomes.

The 124 catches include the eight `UNVERIFIABLE` observations: native results
are 116 `CHANGED`, 8 `UNVERIFIABLE`, 74 `BASELINE_CREATED`, and 54 `CURRENT`.
The 117 recorded false outcomes consist of 114 `CHANGED` and 3 `UNVERIFIABLE`
observations. The sole recorded true outcome belongs to an `UNVERIFIABLE`
observation; it does not independently establish detection of a material
violation. Two `CHANGED` and four `UNVERIFIABLE` observations have no recorded
boolean outcome. These are observation counts, not adjudicated labels.

This is not a verified reconstruction of the historical 134-run claim. The source
fixture marks both original-134 membership and immutability at the original assessment
as unverified. It is a bounded available-source population, not a replacement
denominator for the historical statement.

The independent adjudication fixture
`test/fixtures/revalidation-corpus/historical-labels-v1.json` is bound to that source
fixture. Two reviewers agreed that 242 observations remain indeterminate and disagreed
on 10; the adjudication therefore leaves all 252 indeterminate. Those outcomes do not
support a historical precision or recall rate.

`test/fixtures/revalidation-controls/constructed-v1.json` is a separate synthetic,
versioned input with 19 native controls and one isolated material-no-catch scorer
calibration (`CAL01`); its SHA-256 is
`2e70ee231b0fa1ad0de1e436a7bf3d674808aded162eae182c757470b2978e86`.
Synthetic rows are never combined with the retrospective population and do not
reclassify it. A pending independent label is not a materiality verdict.

Two independent constructed-population label outputs have SHA-256
`ea1aaafe88145d73934cf285a356621607e4dc1a34ad59bc75b8d2c5752bed43` and
`6e90cbe47321e821b9ce39479c9f1dd466f161103fe6d6b429cf120f83576caa`. They
agree on 11 material and 2 benign pairs; six pairs remain disagreement/unknown.
There is no agreed benign caught pair, so this population does not support a
false-HOLD proportion.

`test/fixtures/revalidation-controls/pressure-v1.json` is a separate,
three-pair synthetic pressure addendum based on the immutable constructed input. Its
SHA-256 is `7a1d4ffcc13aa0342586eafea77ac4cd5144b5e4cc07e41ea85ed03d8974037c`.
It covers a whitespace-only body change, benign close-time commentary, and a changed
output requirement.

Two independent pressure-population label outputs have SHA-256
`9ee50bbc89cf58bf16360fb211ba9cbc96d1cc660a4bdea7d3edfc337fe03b57` and
`21d9a39f1a2f0138458039278fbcfbdaf10b8801e1b55e7bbcc11c3513436122`. They
independently label two real `CHANGED`/HOLD controls (`B02` and `B03`) benign and
one real `CHANGED`/HOLD control (`P01`) material. This narrowly predeclared
synthetic addendum neither settles the retrospective observations nor establishes a
representative sample or a production rate.

## Native replay plan

Each declared control names the offline revalidation test and checkpoint that produces
its native result. Test output records the mechanism result, not a materiality label.

The commands below ran in the task worktree through `check-run.mjs`, with
`RIG_RUN_DIR` set to its own `.claude/runs/20261125-rp563-baseline-repair`.
They are focused suite evidence, not full new-head acceptance or an
external-provider acceptance result.

`rp563-complete-constructed-native-replay` ran

```sh
pnpm exec vitest run test/template/revalidation-corpus.test.ts \
  test/template/content-blind-revalidation.test.ts test/template/revalidate.test.ts --reporter=dot
```

and passed 193 tests in 33.40 seconds before subsequent metadata alignment. The original native
test inputs were unchanged. After correcting S03's declaration to its `BEFORE_PR`
checkpoint, `rp563-final-v1-declaration-validation` ran

```sh
pnpm exec vitest run test/template/revalidation-corpus.test.ts --reporter=dot
```

and passed the 25 corpus fixture tests in 216 ms. The exact command logs and native
journal events remain in `.claude/runs/20261125-rp563-baseline-repair/checks/`; this
document does not copy per-case JSON outputs.

The pressure Red ran

```sh
pnpm exec vitest run test/template/content-blind-revalidation.test.ts \
  test/template/revalidation-corpus.test.ts --project template \
  --testNamePattern 'native pressure replay|freezes three concrete pending-label pairs' --reporter=dot
```

and completed in 1.82 seconds with three native replay tests passing and one fixture
test failing solely because `pressure-v1.json` did not exist. That historical Red
established the pressure-fixture contract; it is not a later label-fixture Green.

The most recent label-fixture Red ran

```sh
pnpm exec vitest run test/template/revalidation-corpus.test.ts --reporter=dot
```

and completed in 223 ms with 26 existing tests passing and four failures caused by
the then-absent constructed and pressure label fixtures. Subsequent evidence-bound
validation passed all 32 corpus tests in 204 ms. Do not treat test output as an
independent materiality label. The `CAL01` calibration remains outside native replay: it tests
scorer handling of a known material miss and does not establish a detector false
negative.

## Labelling and metrics

`pressure-native-v1.json` contains three observations extracted from actual
`RP563_NATIVE_PRESSURE` output, not from the declared expected results. Its metadata
records the capture command, source commit, uncommitted input hashes, and raw-log
digest. Input hashes were checked before and after capture and remained unchanged.
The final capture passed three native pressure tests in 1.81 seconds; 94 unrelated
tests were filtered out.

The three fixture checkouts use the same native run name and sequence number.
The two commentary cases also produce the same detection ID. The capture therefore
retains those original values and adds a hash of each actual canonical checkout
path; the composite checkout/run/sequence identifies the execution scope. No native
identifier or journal event was fabricated. This corrects measurement provenance;
it does not establish a production claim-recovery defect.

Joining those observations to the independent pressure labels produces three
determinate catches: two benign changes held and one material change detected.
These are deliberately selected pressure cases, not an estimate of production
frequency. The nineteen broader controls remain a separate population with six
unresolved reviewer disagreements. Protocol-control materiality is not evidence
that the original upstream change was a material task violation; those controls
must not be added to a precision denominator to dilute the pressure findings.

The scorer also rejects a contradictory `caught` row whose own observation says
`detected: false`, retaining it in the rejected manifest count while excluding it
from scores and eligibility. The regression failed before the guard was added;
the final full corpus check passed all 32 tests. Target eligibility remains false.

After native replay, freeze only the declared pair, checkpoint, native output, source
test title, and relevant event/outcome evidence. Independent reviewers label the
frozen synthetic pairs as `material`, `benign`, or `indeterminate` with separate
evidence. The deterministic policy accepts only matching determinate labels; a
disagreement, missing label, or indeterminate label remains indeterminate.
`UNVERIFIABLE` and unresolved retrospective cases remain indeterminate absent
independent evidence.

No metric may combine retrospective and synthetic populations. A synthetic result may
demonstrate a regression scenario or scorer behavior; it cannot establish an observed
production false-HOLD proportion. The <5% target remains unassessed until a
representative independently-labelled determinate corpus exists.
