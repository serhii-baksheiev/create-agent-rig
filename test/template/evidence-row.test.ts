import { describe, expect, it } from 'vitest';
import { validateEvidenceRow } from '../helpers/evidence-row.js';
import type { EvidenceRow } from '../helpers/evidence-row.js';

// RP-178 moved the evidence-row shape check out of the deleted policy library
// into a test helper. These pin the two properties the library had and the
// first port dropped: a row is a closed shape, and it names one exact build.

const row: EvidenceRow = {
  harness: 'claude-code',
  surface: 'agent-frontmatter',
  harnessVersion: '2.1.270',
  os: 'linux',
  observedAt: '2026-09-12T20:03:48.611Z',
  mechanism: 'subagent-model-pin',
  observableSignal: 'the subagent reports the pinned model',
  status: 'SUPPORTED',
  evidencePointer: 'docs/capability-evidence.json',
};

describe('an evidence row is a closed shape naming one exact build', () => {
  it('accepts a complete row', () => {
    expect(validateEvidenceRow(row)).toEqual({ ok: true });
  });

  it('accepts a v-prefixed version, a pre-release suffix and a hex build id', () => {
    for (const harnessVersion of ['v2.1.270', '2.1.270-beta.1', '24.19.0+build.7', 'a1b2c3d']) {
      expect(validateEvidenceRow({ ...row, harnessVersion }), harnessVersion).toEqual({ ok: true });
    }
  });

  it('refuses a field the shape does not declare, and names it', () => {
    const verdict = validateEvidenceRow({ ...row, verifiedBy: 'someone' });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.problems).toContain('verifiedBy: unknown field');
  });

  it('refuses a bare date where a zoned date-time is required', () => {
    for (const observedAt of ['2026-09-12', '2026-09-12T20:03:48']) {
      expect(validateEvidenceRow({ ...row, observedAt }).ok, observedAt).toBe(false);
    }
  });

  it('pairs a downgrade reason with every status but SUPPORTED, and with SUPPORTED never', () => {
    expect(validateEvidenceRow({ ...row, status: 'DEGRADED' }).ok).toBe(false);
    expect(
      validateEvidenceRow({ ...row, status: 'DEGRADED', downgradeReason: 'loses the effort pin' }),
    ).toEqual({ ok: true });
    expect(validateEvidenceRow({ ...row, downgradeReason: 'nothing to explain' }).ok).toBe(false);
  });

  it('refuses a blank downgrade reason even on a SUPPORTED row', () => {
    for (const downgradeReason of ['', '   ']) {
      expect(
        validateEvidenceRow({ ...row, downgradeReason }).ok,
        JSON.stringify(downgradeReason),
      ).toBe(false);
    }
  });

  it('refuses a version range, a wildcard or a moving label', () => {
    for (const harnessVersion of ['>=2.1.251', '2.1.x', '^2.1.0', 'latest', 'stable', '2.1.*']) {
      const verdict = validateEvidenceRow({ ...row, harnessVersion });
      expect(verdict.ok, harnessVersion).toBe(false);
      expect((verdict.ok ? [] : verdict.problems).join('\n')).toMatch(/harnessVersion/);
    }
  });
});
