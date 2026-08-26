import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-51 — `editFragments` is the one normaliser every edit guard reads through,
 * and it knew Write, Edit and apply_patch only. A MultiEdit or a NotebookEdit
 * returned `[]`, which every consumer reads as "nothing to inspect" — so a
 * `Date.now()` reached the core through MultiEdit while the purity guard said
 * it had looked.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');

const load = () =>
  import(pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href) as Promise<{
    editFragments: (input: unknown) => Array<{ filePath: string; fragment: string }>;
  }>;

const multiEdit = (filePath: string, edits: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'MultiEdit',
  tool_input: { file_path: filePath, edits },
});

describe('editFragments: MultiEdit and NotebookEdit are edit surfaces too', () => {
  it('yields one fragment per MultiEdit edit, each carrying the new text under the file path', async () => {
    const { editFragments } = await load();
    const fragments = editFragments(
      multiEdit('packages/core/src/x.ts', [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ]),
    );
    expect(fragments).toEqual([
      { filePath: 'packages/core/src/x.ts', fragment: 'b' },
      { filePath: 'packages/core/src/x.ts', fragment: 'd' },
    ]);
  });

  it('normalises the MultiEdit file path the way it does for Write', async () => {
    const { editFragments } = await load();
    const [fragment] = editFragments(
      multiEdit('./packages\\core\\src\\x.ts', [{ old_string: 'a', new_string: 'b' }]),
    );
    expect(fragment?.filePath).toBe('packages/core/src/x.ts');
  });

  it('yields one fragment for a NotebookEdit: notebook_path and new_source', async () => {
    const { editFragments } = await load();
    const fragments = editFragments({
      hook_event_name: 'PreToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'notes/x.ipynb', new_source: 'print(1)' },
    });
    expect(fragments).toEqual([{ filePath: 'notes/x.ipynb', fragment: 'print(1)' }]);
  });

  it('yields nothing for a MultiEdit whose edits is not an array', async () => {
    const { editFragments } = await load();
    expect(editFragments(multiEdit('packages/core/src/x.ts', 'not-a-list'))).toEqual([]);
  });
});

describe('the existing guards see a MultiEdit', () => {
  it('guard-core-purity blocks a clock call reaching the core through MultiEdit', async () => {
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [path.join(hooksDir, 'guard-core-purity.mjs')],
        { env: { ...process.env } },
        (error, _stdout, stderr) => {
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
        },
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(
        JSON.stringify(
          multiEdit(path.join(repoRoot, 'packages/core/src/x.ts'), [
            { old_string: 'a', new_string: 'const t = Date.now();' },
          ]),
        ),
      );
      child.stdin.end();
    });
    expect(result.code, result.stderr).toBe(2);
  });
});
