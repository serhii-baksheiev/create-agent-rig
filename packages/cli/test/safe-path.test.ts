import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeSegment, resolveInside } from '../src/lib/safe-path.js';

describe('path safety — the containment `upgrade` writes behind', () => {
  const root = path.resolve('/tmp/rig');

  it('resolves a normal install path under the root', () => {
    expect(resolveInside(root, '.claude/rules/workflow.md')).toBe(
      path.join(root, '.claude', 'rules', 'workflow.md'),
    );
    expect(resolveInside(root, 'CLAUDE.md')).toBe(path.join(root, 'CLAUDE.md'));
  });

  it('refuses anything that leaves the root', () => {
    // the path a substituted `__PROJECT_NAME__` could smuggle in
    expect(resolveInside(root, '../outside/pwned.txt')).toBeNull();
    expect(resolveInside(root, '.claude/../../etc/passwd')).toBeNull();
    expect(resolveInside(root, path.resolve('/etc/passwd'))).toBeNull();
    expect(resolveInside(root, '')).toBeNull();
  });

  it('a prefix match is not containment', () => {
    // /tmp/rig-evil starts with /tmp/rig but is a different directory
    expect(resolveInside(root, '../rig-evil/x')).toBeNull();
  });

  it('names the values that are safe to substitute into a path', () => {
    expect(isSafeSegment('my-app')).toBe(true);
    expect(isSafeSegment('_internal')).toBe(true); // `init` can slug this
    expect(isSafeSegment('eu-central-1')).toBe(true);
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('.')).toBe(false);
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('a\\b')).toBe(false);
    expect(isSafeSegment('')).toBe(false);
    expect(isSafeSegment('nul\0byte')).toBe(false);
  });
});
