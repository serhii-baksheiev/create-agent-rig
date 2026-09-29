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

/**
 * `CLAUDE_PROJECT_DIR` names the checkout a session's own calls scope to (the
 * `loop` skill, a manual `unattended-flag.mjs on --root` probe). The
 * unattended-flag env() helpers this test tree builds inherit it from
 * `process.env` exactly like `RIG_RUN_DIR` above, scoping a fixture's flag to
 * whatever checkout the invoking shell happened to export rather than the one
 * the fixture actually created (RP-288, `test/template/unattended-flag.test.ts`).
 * Scrubbed here, before any test file loads, and pinned by
 * `test/template/claude-project-dir-scrub.test.ts`.
 */
delete process.env.CLAUDE_PROJECT_DIR;
