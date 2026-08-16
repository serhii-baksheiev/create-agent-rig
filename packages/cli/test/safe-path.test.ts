import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeSegment, isSafeSubstitutionValue, resolveInside } from '../src/lib/safe-path.js';

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

// `isSafeSubstitutionValue` is a whitelisted character class, so the behaviour
// worth pinning is the class itself — one character at a time. A payload that
// is illegal on four counts at once proves nothing about any of them: it stays
// rejected while the class quietly widens under it.
describe('the values safe to substitute into an installed file', () => {
  it('accepts everything this repository can legitimately produce', () => {
    expect(isSafeSubstitutionValue('my-app')).toBe(true);
    expect(isSafeSubstitutionValue('a.b_c-d')).toBe(true);
    expect(isSafeSubstitutionValue('_work')).toBe(true); // `projectNameFor` can emit this
    expect(isSafeSubstitutionValue('app2')).toBe(true);
    expect(isSafeSubstitutionValue('eu-central-1')).toBe(true); // a region
    expect(isSafeSubstitutionValue('node-ts')).toBe(true); // a stack overlay
  });

  it('refuses a quote, a backtick and a dollar — the three that end a JS string literal', () => {
    expect(isSafeSubstitutionValue("a'b")).toBe(false);
    expect(isSafeSubstitutionValue('a`b')).toBe(false);
    expect(isSafeSubstitutionValue('a$b')).toBe(false);
  });

  it('refuses a space inside an otherwise legal value', () => {
    expect(isSafeSubstitutionValue('a b')).toBe(false);
  });

  it('refuses a newline, however legal each line looks on its own', () => {
    expect(isSafeSubstitutionValue('a\nb')).toBe(false);
    expect(isSafeSubstitutionValue('my-app\nprocess.exit()')).toBe(false);
  });

  it('refuses an uppercase letter', () => {
    expect(isSafeSubstitutionValue('MyApp')).toBe(false);
    expect(isSafeSubstitutionValue('A')).toBe(false);
  });

  it('refuses a leading dash or dot, which are legal anywhere later', () => {
    expect(isSafeSubstitutionValue('-x')).toBe(false);
    expect(isSafeSubstitutionValue('.x')).toBe(false);
    expect(isSafeSubstitutionValue('x-y')).toBe(true);
    expect(isSafeSubstitutionValue('x.y')).toBe(true);
  });

  it('refuses the empty string', () => {
    expect(isSafeSubstitutionValue('')).toBe(false);
  });
});
