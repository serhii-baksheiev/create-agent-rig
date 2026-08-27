import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stubCommand } from '../helpers/stub-command.js';

// The stub is what lets a test that spawns `gh` run on Windows (AR-93): on
// POSIX a shell wrapper, on win32 a copy of node named `gh.exe` plus a preload
// that answers before node looks for a script. The same handler serves both.
describe('test/helpers/stub-command', () => {
  it('answers a bare-name spawn with the handler, on this platform', async () => {
    const stub = await stubCommand(
      'ghstub',
      'if (args[0] === "issue" && args[1] === "list") return { stdout: "[]\\n" }; return { exitCode: 1 };',
    );
    try {
      const out = execFileSync('ghstub', ['issue', 'list'], { encoding: 'utf8' });
      expect(out).toBe('[]\n');
      expect(() => execFileSync('ghstub', ['nope'], { stdio: 'pipe' })).toThrow();
    } finally {
      stub.restore();
    }
  });

  it('leaves an ordinary node child untouched under the same environment', async () => {
    const stub = await stubCommand('ghstub', 'return { stdout: "stub" };');
    try {
      const out = execFileSync(process.execPath, ['-e', 'process.stdout.write("real")'], {
        encoding: 'utf8',
      });
      expect(out).toBe('real');
    } finally {
      stub.restore();
    }
  });

  it('restores PATH and NODE_OPTIONS', async () => {
    const before = { PATH: process.env['PATH'], NODE_OPTIONS: process.env['NODE_OPTIONS'] };
    const stub = await stubCommand('ghstub', 'return {};');
    stub.restore();
    expect(process.env['PATH']).toBe(before.PATH);
    expect(process.env['NODE_OPTIONS']).toBe(before.NODE_OPTIONS);
  });
});
