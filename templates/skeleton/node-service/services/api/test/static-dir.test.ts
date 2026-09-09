// The composition root resolves the built web bundle relative to itself; the
// resolution is a pure function so it can be tested without importing main.ts.
//
// This native absolute fixture exercises the platform root spelling and
// percent-decoding without injecting a path flavor into the production helper.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultStaticDirFor } from '../src/static-dir.js';

const moduleUrl = pathToFileURL(
  path.join(path.parse(process.cwd()).root, 'a b', 'proj', 'services', 'api', 'src', 'main.ts'),
).href;

describe('resolving the default static dir from the module url', () => {
  it('decodes percent-escapes in the path (a directory may contain a space)', () => {
    const resolved = defaultStaticDirFor(moduleUrl);

    expect(resolved).toContain('a b');
    expect(resolved).not.toContain('%20');
  });

  it('points three levels up from services/api/src at apps/web/out', () => {
    const resolved = defaultStaticDirFor(moduleUrl);

    expect(resolved.endsWith(path.join('a b', 'proj', 'apps', 'web', 'out'))).toBe(true);
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});
