import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import { needsGit, skipUnless } from '../helpers/env.js';

// AR-5 / AR-51: a Windows checkout with core.autocrlf=true rewrote hashbang
// `.mjs` scripts to CRLF, and vitest's `import()` of them died with
// `SyntaxError: Invalid or unexpected token` on the windows-unit job. The fix is
// a root `.gitattributes` pinning `*.mjs` and `*.sh` to LF; these tests read the
// pin back through `git check-attr`, so they pass only when git itself agrees.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, '.claude/scripts/git-env.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, env: withoutGitLocation(), encoding: 'utf8' });

const checkAttr = (file: string): string => git('check-attr', 'eol', 'text', '--', file);

const expectPinnedToLf = (file: string): void => {
  const out = checkAttr(file);
  expect(out, `expected ${file} to carry eol=lf, got:\n${out}`).toContain(`${file}: eol: lf`);
  expect(out, `expected ${file} to carry text=set, got:\n${out}`).toContain(`${file}: text: set`);
};

describe('line-ending attributes (.gitattributes)', () => {
  beforeEach((ctx) => skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason));

  it('pins *.mjs to LF so a Windows checkout cannot turn a hashbang script into CRLF', () => {
    expectPinnedToLf('.claude/hooks/guard-bash.mjs');
  });

  it('pins the template hooks the same way', () => {
    expectPinnedToLf('templates/agent-os/universal/.claude/hooks/guard-bash.mjs');
    // `demo.sh` is tracked; naming it keeps this half from silently not running.
    expectPinnedToLf('demo.sh');
  });

  it('no tracked *.mjs carries a CR', () => {
    const tracked = git('ls-files', '-z', '--', '*.mjs').split('\0').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    const offenders = tracked.filter((file) =>
      readFileSync(path.join(repoRoot, file), 'utf8').includes('\r'),
    );
    expect(offenders).toEqual([]);
  });
});
