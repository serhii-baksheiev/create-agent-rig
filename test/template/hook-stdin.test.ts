import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-54 — a hook that cannot parse its payload allows the tool call, and on
 * Windows the Codex wrapper hands it a payload it could not parse.
 *
 * Measured on the hosted `windows-unit` runner through the generated
 * `commandWindows` (CI run 33281160544): the wrapper delivers stdin and
 * propagates the child's exit code, but the guard receives **290 bytes for a
 * 287-byte payload** — PowerShell prepends a UTF-8 BOM. `JSON.parse` throws on
 * a leading U+FEFF, every hook's `catch` resolves that to "not ours to judge",
 * and the guard allows the edit it exists to refuse. The same tree blocks on a
 * Windows host whose PowerShell does not add the BOM, which is why this stayed
 * invisible for two days.
 *
 * All eight hooks read stdin the same way, so all eight fail open together —
 * `guard-bash`, which carries the Never tier and the kill switch, among them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const hooksDir = path.join(universal, '.claude', 'hooks');

const BOM = '﻿';

const runHook = (
  hookPath: string,
  payload: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookPath],
      { env: { ...process.env, ...env } },
      (error, _stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr }),
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.end(payload);
  });

const forcePush = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push --force origin master' },
});

describe('a hook reads its payload whatever the harness prefixes it with', () => {
  it('blocks a Never-tier command when the payload carries no BOM', async () => {
    const result = await runHook(path.join(hooksDir, 'guard-bash.mjs'), forcePush, {
      AGENT_LOOP_STOP: path.join(repoRoot, 'no-such-brake-flag'),
    });
    expect(result.code, result.stderr).toBe(2);
  });

  // The Red case: identical payload, one UTF-8 BOM in front of it.
  it('blocks the same command when PowerShell prepends a UTF-8 BOM', async () => {
    const result = await runHook(path.join(hooksDir, 'guard-bash.mjs'), BOM + forcePush, {
      AGENT_LOOP_STOP: path.join(repoRoot, 'no-such-brake-flag'),
    });
    expect(result.code, `a BOM must not turn a refusal into an allow: ${result.stderr}`).toBe(2);
  });

  /**
   * One mechanism, one implementation (`invariants.md`). Eight hooks parsing
   * stdin eight times is eight chances for one of them to keep the defect, and
   * the one nobody looks at is the one that will.
   */
  it('reads stdin through the one shared reader, in every hook that reads it', async () => {
    const entries = (await readdir(hooksDir)).filter((name) => name.endsWith('.mjs'));
    const readsStdinDirectly: string[] = [];
    const throughTheReader: string[] = [];
    for (const name of entries) {
      const source = await readFile(path.join(hooksDir, name), 'utf8');
      if (source.includes('readFileSync(0')) readsStdinDirectly.push(name);
      if (source.includes('readHookInput(')) throughTheReader.push(name);
    }
    // Not "every file that still reads stdin directly also imports the reader" —
    // that passes vacuously the moment none of them does. The claim is that fd 0
    // is read in exactly one place, and that the hooks go through it.
    expect(readsStdinDirectly).toEqual([]);
    expect(throughTheReader.length).toBeGreaterThanOrEqual(8);
  });
});
