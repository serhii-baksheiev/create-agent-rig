// The composition root resolves the built web bundle relative to itself; the
// resolution is a pure function so it can be tested without importing main.ts.
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
