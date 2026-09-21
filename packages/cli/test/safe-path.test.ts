import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initManifest } from '../src/commands/init.js';
import {
  MAX_PATH_SEGMENTS,
  exceedsMaxPathSegments,
  isSafeSegment,
  isSafeSubstitutionValue,
  resolveInside,
  resolveReadableInside,
} from '../src/lib/safe-path.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';

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

  // `safe-path.ts`'s own comment on `MAX_PATH_SEGMENTS` deliberately names no
  // specific path or count as its justification — that sentence would go
  // stale the day a rule moves a directory deeper, and nothing would catch
  // it (`.claude/rules/invariants.md`, "State the limits — and test them").
  // This is what backs the cap instead: it reads the REAL install set
  // through `initManifest()`, so a future path nested deeper than today's
  // fails HERE, loudly, before it ever reaches the cap in production.
  it("caps a path at more segments than any path this release's own install set ships, measured not guessed", async () => {
    const files = await initManifest();
    const deepest = Math.max(...files.map((f) => f.rel.split('/').length));
    expect(deepest).toBeGreaterThan(0); // sanity: the install set is not empty
    // Headroom, not equality — the cap must comfortably outlast today's
    // deepest shipped path without approaching the RangeError boundary
    // `MAX_PATH_SEGMENTS`'s own doc comment names.
    expect(MAX_PATH_SEGMENTS).toBeGreaterThanOrEqual(deepest * 2);

    // The cap's own refusal behaviour, pinned at its exact boundary — this
    // constant otherwise has no test of its own anywhere in this module.
    const atCap = `${'a/'.repeat(MAX_PATH_SEGMENTS - 1)}x`;
    const overCap = `${'a/'.repeat(MAX_PATH_SEGMENTS)}x`;
    expect(exceedsMaxPathSegments(atCap)).toBe(false);
    expect(exceedsMaxPathSegments(overCap)).toBe(true);
    expect(resolveInside(root, atCap)).not.toBeNull();
    expect(resolveInside(root, overCap)).toBeNull();
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

  it('accepts a value that is only its first character', () => {
    // Every other accepted value here is two characters or more, which leaves
    // the tail quantifier untested: a class that required a second character
    // would pass the whole suite while refusing `projectNameFor`'s one-char
    // slug and a project `create` accepts by name.
    expect(isSafeSubstitutionValue('x')).toBe(true);
    expect(isSafeSubstitutionValue('_')).toBe(true);
    expect(isSafeSubstitutionValue('7')).toBe(true);
  });
});

// `resolveReadableInside` (RP-22 round 3, safe-path.ts advisory): direct
// coverage of the read-side counterpart, separate from every place that
// exercises it only indirectly (packages/cli/test/integrations-cli.test.ts).
describe('resolveReadableInside — the read-side counterpart of resolveWritableInside', () => {
  it('reports "absent" when no component of rel exists yet', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    try {
      const result = await resolveReadableInside(root, 'a/b/c.json', 'file');
      expect(result).toEqual({ status: 'absent' });
    } finally {
      await removeFixture(root);
    }
  });

  it('reports "absent" when an intermediate directory does not exist, even if the root does', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    try {
      const result = await resolveReadableInside(root, 'missing-dir/x.json', 'file');
      expect(result).toEqual({ status: 'absent' });
    } finally {
      await removeFixture(root);
    }
  });

  it('reports "absent" when root itself is not a directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    try {
      const notADir = path.join(root, 'plain-file');
      await writeFile(notADir, 'x');
      const result = await resolveReadableInside(notADir, 'a.json', 'file');
      expect(result).toEqual({ status: 'absent' });
    } finally {
      await removeFixture(root);
    }
  });

  it('reports "unsafe: wrong-kind" when a FILE sits where a DIRECTORY was expected', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    try {
      await writeFile(path.join(root, 'should-be-a-dir'), 'x');
      const result = await resolveReadableInside(root, 'should-be-a-dir', 'directory');
      expect(result).toEqual({ status: 'unsafe', reason: 'wrong-kind' });
    } finally {
      await removeFixture(root);
    }
  });

  it('reports "unsafe: wrong-kind" when a DIRECTORY sits where a FILE was expected', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    try {
      await mkdir(path.join(root, 'should-be-a-file'), { recursive: true });
      const result = await resolveReadableInside(root, 'should-be-a-file', 'file');
      expect(result).toEqual({ status: 'unsafe', reason: 'wrong-kind' });
    } finally {
      await removeFixture(root);
    }
  });

  it('reports "unsafe: escapes-root" for a lexically-escaping rel, without ever walking the filesystem', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    try {
      const result = await resolveReadableInside(root, '../outside.json', 'file');
      expect(result).toEqual({ status: 'unsafe', reason: 'escapes-root' });
    } finally {
      await removeFixture(root);
    }
  });

  it('reports "ok" with the resolved path once every segment checks out', async () => {
    // Windows CI measured (RP-22 round 3): `mkdtemp` under `os.tmpdir()` can
    // return a path through a short (8.3) alias — `C:\Users\RUNNER~1\...` —
    // while `resolveReadableInside` itself calls `realpath` on `root` before
    // building its answer and therefore returns the LONG form
    // (`C:\Users\runneradmin\...`). `realpath`-ing `root` here first, the
    // same fixture fix `cli-version.test.ts` already applies for its own
    // `repo` variable, makes this test's own expectation and the function's
    // real behaviour agree on which spelling is canonical — a test-fixture
    // fix, not a product change.
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'caf-safe-path-')));
    try {
      await mkdir(path.join(root, 'a', 'b'), { recursive: true });
      await writeFile(path.join(root, 'a', 'b', 'c.json'), '{}');
      const result = await resolveReadableInside(root, 'a/b/c.json', 'file');
      expect(result).toEqual({ status: 'ok', path: path.join(root, 'a', 'b', 'c.json') });
    } finally {
      await removeFixture(root);
    }
  });

  it('refuses a symlink at the FINAL segment', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-outside-'));
    try {
      await writeFile(path.join(outside, 'real.json'), '{}');
      await symlink(path.join(outside, 'real.json'), path.join(root, 'link.json'));
      const result = await resolveReadableInside(root, 'link.json', 'file');
      expect(result).toEqual({ status: 'unsafe', reason: 'symlink' });
    } finally {
      await removeFixture(root);
      await removeFixture(outside);
    }
  });

  it('refuses a symlink at an INTERMEDIATE segment (the first one)', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-outside-'));
    try {
      await mkdir(path.join(outside, 'b'), { recursive: true });
      await writeFile(path.join(outside, 'b', 'c.json'), '{}');
      await symlink(outside, path.join(root, 'a'));
      const result = await resolveReadableInside(root, 'a/b/c.json', 'file');
      expect(result).toEqual({ status: 'unsafe', reason: 'symlink' });
    } finally {
      await removeFixture(root);
      await removeFixture(outside);
    }
  });

  it('refuses a symlink at a DEEPER intermediate segment (not the first, not the last)', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const root = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-safe-path-outside-'));
    try {
      await mkdir(path.join(root, 'a'), { recursive: true });
      await mkdir(path.join(outside, 'c'), { recursive: true });
      await writeFile(path.join(outside, 'c', 'd.json'), '{}');
      await symlink(outside, path.join(root, 'a', 'b'));
      const result = await resolveReadableInside(root, 'a/b/c/d.json', 'file');
      expect(result).toEqual({ status: 'unsafe', reason: 'symlink' });
    } finally {
      await removeFixture(root);
      await removeFixture(outside);
    }
  });
});
