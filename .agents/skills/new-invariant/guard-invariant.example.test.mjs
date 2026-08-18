// TEMPLATE — the third of the three parts (.claude/rules/invariants.md).
//
// Copy alongside your hook and rewrite the cases for your invariant. Run with:
//
//   node --test .claude/hooks/guard-<invariant-name>.test.mjs
//
// The four cases below are not a suggestion — they are the minimum set. The last
// two are the ones people skip, and they are exactly the ones that decide whether
// the guard survives contact with real work: a guard that polices out-of-scope
// files, or that fires on prose about its own rule, gets switched off.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'guard-invariant.example.mjs');

/** Feed a synthetic PreToolUse payload to the hook, exactly as Claude Code does. */
const runHook = (filePath, content) =>
  new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hook], (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stderr });
    });
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
      }),
    );
    child.stdin.end();
  });

const IN_SCOPE = 'services/api/src/handlers/create-note.ts';

describe('the example invariant: service code logs through the shared logger', () => {
  it('blocks the violation, and the reason names what to do instead', async () => {
    const result = await runHook(IN_SCOPE, 'console.log("created", id);');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /logger/i);
  });

  it('blocks the other console methods too, not just log', async () => {
    for (const method of ['info', 'warn', 'error', 'debug']) {
      const result = await runHook(IN_SCOPE, `console.${method}("x");`);
      assert.equal(result.code, 2, method);
    }
  });

  it('allows the compliant form', async () => {
    const result = await runHook(IN_SCOPE, 'logger.info({ msg: "created", id });');
    assert.equal(result.code, 0);
  });

  it('allows files outside the guarded scope', async () => {
    // A guard with repo-wide reach fires on honest work and gets disabled.
    for (const path of ['scripts/one-off.mjs', 'apps/web/src/app/page.tsx', 'README.md']) {
      const result = await runHook(path, 'console.log("fine here");');
      assert.equal(result.code, 0, path);
    }
  });

  it('allows prose that merely mentions the violation', async () => {
    // The false-positive case. Skipping it is how a guard ends up switched off.
    for (const content of [
      '// never use console.log here — use the logger',
      '/* console.error is banned in service code */',
      'const banned = "console.log(";',
      'const help = `do not call console.warn(...)`;',
    ]) {
      const result = await runHook(IN_SCOPE, content);
      assert.equal(result.code, 0, content);
    }
  });

  it('fails open on a payload it does not understand', async () => {
    const result = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [hook], (error) => {
        resolve({ code: error ? (error.code ?? 1) : 0 });
      });
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write('{not json');
      child.stdin.end();
    });
    assert.equal(result.code, 0);
  });
});
