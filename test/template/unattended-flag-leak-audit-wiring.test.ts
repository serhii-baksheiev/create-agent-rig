import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

// RP-271: `writeUnattended` (unattended-flag.mjs) mirrors a scoped record into
// every home `stop-flag.mjs`'s `homesOf` names — the password-database home is
// always among them, and no fixture `HOME` override can take it out of the set
// (that is the point of the mirroring: a scoped write is supposed to be found
// however the reader's `HOME` is set). So no per-test `HOME` override can
// contain a leak either; only every test that arms the flag actually clearing
// it — proven, per test, by test/template/queue-board.test.ts — and a run-wide
// backstop that fails the moment one does not. That backstop is a vitest
// `globalSetup`: it snapshots the real homes' `__PROJECT_NAME__-*-loop-UNATTENDED`
// files once before the project's tests run, and its teardown reports (and
// fails the run on) any that are new once they are done — the same
// before/after idea `test/e2e/pack-once.ts` uses for its own setup/teardown,
// not the static text-scan `test/template/fixture-cleanup-audit.test.ts` uses:
// a scan over source text cannot see a flag a *passing* assertion path never
// writes to disk-with-cleanup-skipped in the first place, only a real run can.
//
// This file pins the wiring, not the audit script's own behaviour (that is
// test/template/unattended-flag-audit-helper.test.ts, for the snapshot/diff
// primitive the global-setup script calls). `unit` is included because
// nothing stops a future unit test from arming the same flag; template is the
// project every currently-leaking test lives in (RP-271 diagnosis).

const LEAK_AUDIT_GLOBAL_SETUP = 'test/helpers/unattended-flag-leak-audit.ts';

interface ProjectConfig {
  name?: string;
  globalSetup?: string[];
}

interface Project {
  test: ProjectConfig;
}

function isProject(value: unknown): value is Project {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { test?: unknown }).test === 'object' &&
    (value as { test?: unknown }).test !== null
  );
}

const projects: Project[] = (
  (config as { test?: { projects?: unknown[] } }).test?.projects ?? []
).filter(isProject);

function findProject(name: string): Project | undefined {
  return projects.find((p) => p.test.name === name);
}

describe('the unattended-flag leak audit is wired into every project that can arm the flag', () => {
  it('gives the template project the shared leak-audit global setup', () => {
    const template = findProject('template');
    expect(template, "a vitest project named 'template' should exist").toBeDefined();
    expect(
      template?.test.globalSetup,
      'template project should declare test.globalSetup including the leak audit',
    ).toContain(LEAK_AUDIT_GLOBAL_SETUP);
  });

  it('gives the unit project the same leak-audit global setup', () => {
    const unit = findProject('unit');
    expect(unit, "a vitest project named 'unit' should exist").toBeDefined();
    expect(
      unit?.test.globalSetup,
      'unit project should declare test.globalSetup including the leak audit',
    ).toContain(LEAK_AUDIT_GLOBAL_SETUP);
  });
});
