# Rig 1.8.0 revalidation evaluation corpus — RP-563

Status: v1 fixtures are frozen historical evidence. v2 is their explicit
successor where R1 found replay-metadata defects; it does not alter v1 bytes or
raw independent-label outputs. A source-bound full-suite snapshot exists for
commit `84db8f0bf10d2f96cf509473d2ab3a1baa35c42f`: receipt `seq:76` at
`2026-11-25T04:01:52.920Z` records `pnpm test` with exit code 0, and its
recorded log reports 246 passing files, 7,281 passing tests, and 104 skips
(489.67 seconds). That snapshot applies only to that commit; later commits and
uncommitted working-tree changes are not covered by it. Fresh independent
pre-merge gates remain pending. This document does not claim a false-HOLD rate,
a false-negative rate, or the <5% target.

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
reclassify it. A pending independent label is not a materiality verdict. The
v1 replay declaration is archived rather than corrected in place: R1 found
that S01's title-at-close pair cited the labels-at-before-PR replay, and S03's
labels-at-before-PR pair cited the title-at-close replay.

Two independent constructed-population label outputs have SHA-256
`ea1aaafe88145d73934cf285a356621607e4dc1a34ad59bc75b8d2c5752bed43` and
`6e90cbe47321e821b9ce39479c9f1dd466f161103fe6d6b429cf120f83576caa`. They
agree on 11 material and 2 benign pairs; six pairs remain disagreement/unknown.
There is no agreed benign caught pair, so this population does not support a
false-HOLD proportion. These labels are partially outcome-blinded: their pair
descriptions can intrinsically disclose catches or typed outcomes. They are not
fully outcome-blind labels.

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

The successors `constructed-v2.json` (SHA-256
`fcec81a4ad551a4171e2843b52e8ff4299af41040718cddf14a13c7add1407fe`) and
`constructed-labels-v2.json` (SHA-256
`eceba6fdc48b9bb3151783b4afa6ee619d2b19f51cd1a4d5a033aa2e0e86b45f`)
correct only the S01/S03 replay associations. The label bridge carries the
prior independent assessment only when the literal pair and checkpoint are
unchanged; it expressly does not state that those labelers saw v2 replay
metadata.

`pressure-v2.json` (SHA-256
`37515d41dc3a87c20fd1f62733fc1ecdeb842fb2535e0c9e789146a9e639db42`)
retains B02, B03, and P01 and adds N01. N01 and P01 reuse exactly one literal
CSV-to-JSON pair at BEFORE_PR and BEFORE_CLOSE respectively. Two new,
outcome-blind label outputs (input SHA-256
`51c85240ba8105f71c93417446a2a055831052efb42129b4d0b154410ccf2b6a`;
outputs `95cce5f7b1729f603de023f05c1237278131e0ea637d38a34d7ca85e2f08394c`
and `b1e76c2d486a070071b2660a8f2a262df2281380828af60d150891ba55850f99`)
agree the pair is material. The pair is one semantic example, not two
independent frequency samples. Materiality is separate from checkpoint duty:
N01 is a deferred BEFORE_PR no-catch, not a false negative; P01 is a required
BEFORE_CLOSE catch.

## Native replay plan

Each declared v2 control names the offline revalidation test and checkpoint that
produces its native result. Test output records the mechanism result, not a
materiality label. The v1 S01/S03 links are known archival defects, so the
document makes no universal claim that every v1 declaration has a matching replay.

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

The prior label-fixture Red ran

```sh
pnpm exec vitest run test/template/revalidation-corpus.test.ts --reporter=dot
```

and completed in 223 ms with 26 existing tests passing and four failures caused by
the then-absent constructed and pressure label fixtures. That pre-R1 result is
not used as v2 acceptance evidence. Do not treat test output as an independent
materiality label. The `CAL01` calibration remains outside native replay: it
tests scorer handling of a known material miss and does not establish a detector
false negative.

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

The v2 join contains four deliberately selected pressure cases. Three are
determinate catches: two benign changes held and one material change detected.
N01 is a material no-catch at a deferred `BEFORE_PR` checkpoint, and therefore
contributes zero required misses. These controls are not an estimate of
production frequency. The nineteen broader controls remain a separate
population with six unresolved reviewer disagreements. Protocol-control
materiality is not evidence that the original upstream change was a material
task violation; those controls must not be added to a precision denominator to
dilute the pressure findings.

The scorer rejects contradictory `caught` and `no-catch-control` rows, and a
material no-catch without an explicit `detectionObligation`, before they enter
denominators. It has no mixed-origin `caught` metric: false-HOLD counts remain
partitioned in `rates.historical` and `rates.synthetic`. Material no-catch
controls are partitioned by the same origin and by `detectionObligation`. Only
`required` no-catches count as misses; `deferred` ones remain visible without
being called false negatives.

Provided frozen-membership evidence is required for historical target
eligibility: each historical case must bind to one named frozen source with
matching locator, observation, label, and scoring fields, plus two distinct
reviewer proofs. This pure scorer validates the consistency of supplied
evidence only; it does not authenticate referenced files, reviewer identities,
or reviewer independence. Trusted fixture loading and real independent
adjudication remain caller responsibilities. Synthetic strata or controls
cannot pad a historical catch into a representative claim. The supplied frozen
membership and scored historical cohort must match in both directions. An
omitted source member prevents eligibility; see
`test/template/revalidation-corpus.test.ts` › "refuses target eligibility when
frozen source membership contains an omitted indeterminate cohort case".
Target eligibility remains false: all 252 historical observations are indeterminate.

After native replay, freeze only the declared pair, checkpoint, native output, source
test title, and relevant event/outcome evidence. Independent reviewers label the
frozen synthetic pairs as `material`, `benign`, or `indeterminate` with separate
evidence. The deterministic policy accepts only matching determinate labels; a
disagreement, missing label, or indeterminate label remains indeterminate.
`UNVERIFIABLE` and unresolved retrospective cases remain indeterminate absent
independent evidence.

False-HOLD and material-miss measurements remain partitioned by retrospective
and synthetic origin. Aggregate manifest, label, and coverage counts describe
corpus composition; they are not production rates. A synthetic result may
demonstrate a regression scenario or scorer behavior; it cannot establish an
observed production false-HOLD proportion. The <5% target remains unassessed
until a representative independently-labelled determinate corpus exists.

## R1 v2 native capture

The final focused R1 corpus command was

```sh
pnpm exec vitest run --project template \
  test/template/revalidation-corpus.test.ts \
  test/template/content-blind-revalidation.test.ts --reporter=dot
```

and passed 137 tests in 33.74 seconds through the canonical task run (journal
check sequence 67). It is focused evidence only; no full
repository suite was run for this Green step.

`rp563-r1-native-pressure-v2-capture-post-format` ran the four `native pressure
replay` tests through `check-run.mjs` and passed 4 tests (94 filtered) in
2.11 seconds. The raw log is
`checks/rp563-r1-native-pressure-v2-capture-post-format-1795578142075-bf2430.log`
in the task run, with SHA-256
`22202540ba78a8d7799ba054eafc0bd4905ee337a1f973a0106e51964b425c9f`;
its journal check sequence is 64.
`pressure-native-v2.json` is populated only from those four emitted
`RP563_NATIVE_PRESSURE` rows and records each actual canonical checkout hash,
canonical task-worktree and run-directory hashes, run, sequence, and detection
ID. Its source HEAD is
`28f7e8e0afad4c2287dbd7e925859047e5116756`; the command used uncommitted WIP
inputs whose hashes are recorded before and after the capture. That source HEAD
must not be interpreted as asserting the WIP candidate was committed.
