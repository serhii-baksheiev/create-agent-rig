/**
 * The variables a test process must never inherit from the session that runs it.
 *
 * `RIG_RUN_DIR` names the run directory the `loop` skill declares for its own
 * calls. Every test that spawns the queue CLI or a gate script would otherwise
 * inherit it, and the real run's append-only trace would receive fixture
 * records: measured at 38 item-selection records and 22 revalidation events in
 * one session, with two tests exiting 1 and the failure misdiagnosed as load
 * (AR-139). Scrubbed here, before any test file loads, and pinned by
 * `test/template/rig-run-dir-scrub.test.ts`.
 */
delete process.env.RIG_RUN_DIR;
