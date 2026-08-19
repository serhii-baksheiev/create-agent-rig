import { describe, expect, it } from 'vitest';
import { EMPTY_HISTORY, presentInEveryRelease } from '../src/lib/history.js';
import type { HashHistory } from '../src/lib/history.js';

/**
 * `presentInEveryRelease` decides whether a manifest-less rig gets to KEEP a
 * deletion — if the path shipped in every version the rig could be, it is gone
 * because somebody removed it, and re-delivering it would undo their work.
 *
 * It had no test of any kind. These are tests for behaviour that already exists
 * (Tier 0), not a TDD cycle: there is no Red step to show, because nothing here
 * changes what the function does. What they add is that the function's one
 * load-bearing assumption stops being invisible.
 */
const historyOf = (versions: string[], files: HashHistory['files']): HashHistory => ({
  versions,
  files,
});

const entry = (since: string): HashHistory['files'][string] => ({
  since,
  hashes: ['a'.repeat(64)],
});

describe('presentInEveryRelease — whether a deletion is the user’s or the rig’s', () => {
  it('says yes for a path the oldest release already carried', () => {
    const history = historyOf(['0.3.0', '0.3.1', '0.3.2'], { 'CLAUDE.md': entry('0.3.0') });
    expect(presentInEveryRelease(history, 'CLAUDE.md')).toBe(true);
  });

  it('says no for a path a later release added, so an older rig still receives it', () => {
    const history = historyOf(['0.3.0', '0.3.1', '0.3.2'], { 'AGENTS.md': entry('0.3.2') });
    expect(presentInEveryRelease(history, 'AGENTS.md')).toBe(false);
  });

  it('says no for a path the table has never heard of', () => {
    const history = historyOf(['0.3.0'], { 'CLAUDE.md': entry('0.3.0') });
    expect(presentInEveryRelease(history, 'unknown/path.md')).toBe(false);
  });

  it('says no when there are no releases to compare against', () => {
    // The fail-open table. Every path is then unrecognised, which downgrades
    // files to conflicts — the safe direction.
    expect(presentInEveryRelease(EMPTY_HISTORY, 'CLAUDE.md')).toBe(false);
    expect(presentInEveryRelease(historyOf([], { 'CLAUDE.md': entry('0.3.0') }), 'CLAUDE.md')).toBe(
      false,
    );
  });

  /**
   * 🔴 The assumption, pinned so it is a decision rather than an accident.
   *
   * The baseline is `versions[0]` — the FIRST element, not the numerically
   * lowest. `HashHistory` documents `versions` as "oldest first" and
   * `scripts/build-hash-history.mjs` sorts before writing, so position and age
   * agree in every table the rig ships. This test states what happens if they
   * ever stop agreeing, so the next reader does not have to derive it: the
   * baseline follows the position.
   *
   * The guard against that ever happening is not here — it is the shipped
   * table's own ordering, asserted by test/template/hash-history.test.ts ›
   * "ships its versions oldest first, because the baseline is read by position".
   */
  it('reads the baseline by position, so an out-of-order table moves it', () => {
    const files = { 'CLAUDE.md': entry('0.3.0') };
    expect(presentInEveryRelease(historyOf(['0.3.0', '0.3.2'], files), 'CLAUDE.md')).toBe(true);
    // same versions, same file, only the order changed
    expect(presentInEveryRelease(historyOf(['0.3.2', '0.3.0'], files), 'CLAUDE.md')).toBe(false);
  });
});
