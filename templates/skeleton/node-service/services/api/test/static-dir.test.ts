// The composition root resolves the built web bundle relative to itself; the
// resolution is a pure function so it can be tested without importing main.ts.
//
// What is NOT pinned here: the Windows half of the same defect — the old
// `new URL(url).pathname` yielded `/C:/…`. Both expressions are identical on a
// POSIX runner, so observing the difference would mean passing a path flavour
// into `defaultStaticDirFor`, i.e. a parameter that exists only for the test.
// The decision was to leave that hook out; percent-decoding below is the same
// bug's POSIX-visible half, and it fails against the old expression.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultStaticDirFor } from '../src/static-dir.js';

describe('resolving the default static dir from the module url', () => {
  it('decodes percent-escapes in the path (a directory may contain a space)', () => {
    const resolved = defaultStaticDirFor('file:///Users/a%20b/proj/services/api/src/main.ts');

    expect(resolved).toContain('a b');
    expect(resolved).not.toContain('%20');
  });

  it('points three levels up from services/api/src at apps/web/out', () => {
    const resolved = defaultStaticDirFor('file:///Users/a%20b/proj/services/api/src/main.ts');

    expect(resolved.endsWith(path.join('a b', 'proj', 'apps', 'web', 'out'))).toBe(true);
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});
