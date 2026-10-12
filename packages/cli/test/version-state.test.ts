import { describe, expect, it } from 'vitest';
import { classifyVersion } from '../src/integrations/version-state.js';

// RP-445: the expected version is the repository's declaration when it has
// one, otherwise the Rig-tested default; the state says which of the two the
// installed version matched, or that it matched neither.
describe('classifyVersion', () => {
  it.each([
    [{ tested: '1.0.0', installed: '1.0.0' }, 'tested'],
    [{ tested: '1.0.0', declared: '1.0.0', installed: '1.0.0' }, 'tested'],
    [{ tested: '1.0.0', declared: '1.1.0', installed: '1.1.0' }, 'overridden'],
    [{ tested: '1.0.0', declared: '1.1.0', installed: '1.0.0' }, 'drift'],
    [{ tested: '1.0.0', installed: '0.9.0' }, 'drift'],
    [{ tested: '1.0.0', declared: '1.1.0' }, 'unknown'],
    [{ tested: '1.0.0' }, 'unknown'],
  ] as const)('%j is %s', (input, state) => {
    expect(classifyVersion(input)).toEqual({ state, ...input });
  });
});
