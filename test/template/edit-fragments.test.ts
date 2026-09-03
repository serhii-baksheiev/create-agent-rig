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

/**
 * What a consumer of this module may find on a fragment. The three optional
 * fields are the refusal contract: the reason, the remedy that travels beside
 * it, and the flag that says the refusal covers the whole payload rather than
 * one path.
 */
type Fragment = {
  filePath: string;
  fragment: string;
  inspectionRefusal?: string;
  remedy?: string;
  appliesToAll?: boolean;
};

const load = () =>
  import(pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href) as Promise<{
    editFragments: (input: unknown) => Fragment[];
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

/**
 * RP-85 — the four Claude edit arms answer an unreadable `tool_input` the way
 * the `apply_patch` arm below them already refuses to.
 *
 * `editFragments` opens with `input?.tool_input ?? {}`, and `??` substitutes for
 * null and undefined ONLY. So a `tool_input` that is PRESENT in a shape the
 * normaliser cannot read — a string, an array, a number — flows on as that
 * value, every field read off it comes back `undefined`, and the arm yields a
 * fragment with an empty path and empty text. Measured on this branch before
 * the fix:
 *
 * | tool_name      | tool_input   | editFragments returns          |
 * | -------------- | ------------ | ------------------------------ |
 * | `Write`        | `'oops'`     | `[{filePath:'',fragment:''}]`  |
 * | `Edit`         | `['a','b']`  | `[{filePath:'',fragment:''}]`  |
 * | `NotebookEdit` | `12`         | `[{filePath:'',fragment:''}]`  |
 * | `MultiEdit`    | `'oops'`     | `[]`                           |
 * | `apply_patch`  | `'oops'`     | one refusal, `appliesToAll`    |
 *
 * Every one of those first four reads to a consuming guard as a clean edit —
 * `guard-secret-file` measured exit 0 on the `Write` row. The asymmetry is
 * between arms of one file.
 *
 * The contract is `.claude/rules/invariants.md`, "Refusing to inspect is a
 * third outcome, not a match and not an error": a field that is ABSENT is the
 * fail-open case, because there is nothing to judge; a field PRESENT in a shape
 * the guard does not accept is the REFUSAL case — it blocks, names the shape it
 * expected, and tells the caller to resend in that shape. It must NOT say
 * "split and retry": that is the bound-crossed remedy, and nothing about
 * splitting changes a container.
 */

/** Every Claude edit surface, with a readable payload and the fragment it must still yield. */
const EDIT_SURFACES: Array<
  [toolName: string, readable: Record<string, unknown>, expected: Fragment[]]
> = [
  [
    'Write',
    { file_path: 'packages/core/src/x.ts', content: 'const a = 1;' },
    [{ filePath: 'packages/core/src/x.ts', fragment: 'const a = 1;' }],
  ],
  [
    'Edit',
    { file_path: 'packages/core/src/x.ts', old_string: 'a', new_string: 'b' },
    [{ filePath: 'packages/core/src/x.ts', fragment: 'b' }],
  ],
  [
    'MultiEdit',
    { file_path: 'packages/core/src/x.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
    [{ filePath: 'packages/core/src/x.ts', fragment: 'b' }],
  ],
  [
    'NotebookEdit',
    { notebook_path: 'notes/x.ipynb', new_source: 'print(1)' },
    [{ filePath: 'notes/x.ipynb', fragment: 'print(1)' }],
  ],
];

/**
 * Shapes a `tool_input` can arrive in that this module cannot read. Three of
 * them, so the check is about the CONTAINER's shape and not about one type
 * somebody special-cased.
 */
const UNREADABLE_TOOL_INPUTS: Array<[label: string, value: unknown]> = [
  ['a string', 'oops'],
  ['an array', ['a', 'b']],
  ['a number', 12],
];

const payloadFor = (toolName: string, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
});

/** The key genuinely missing — not `undefined` under a key, which is the same thing to `??`. */
const payloadWithoutToolInput = (toolName: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
});

const surfacesTimesUnreadable = EDIT_SURFACES.flatMap(([toolName]) =>
  UNREADABLE_TOOL_INPUTS.map(([label, value]) => [toolName, label, value] as const),
);

describe('editFragments: a tool_input present in a shape it cannot read is refused, not read as a clean edit', () => {
  it.each(surfacesTimesUnreadable)(
    'on %s, refuses a tool_input that is %s',
    async (toolName, _label, value) => {
      const { editFragments } = await load();
      const fragments = editFragments(payloadFor(toolName, value));

      // One fragment, and it carries the refusal. An empty list is the other
      // wrong answer — every consumer reads it as "nothing to inspect".
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.inspectionRefusal).toBeTruthy();
    },
  );

  it.each(surfacesTimesUnreadable)(
    'on %s, vouches for no path when the tool_input is %s',
    async (toolName, _label, value) => {
      const { editFragments } = await load();
      const [fragment] = editFragments(payloadFor(toolName, value));

      // `appliesToAll` is what makes a guard block the payload rather than one
      // path; empty path and empty text are what stop it being mistaken for a
      // real edit that happens to be blank.
      expect(fragment).toMatchObject({ filePath: '', fragment: '', appliesToAll: true });
    },
  );

  it.each(surfacesTimesUnreadable)(
    'on %s, names the shape it cannot read rather than a limit, for a tool_input that is %s',
    async (toolName, _label, value) => {
      const { editFragments } = await load();
      const [fragment] = editFragments(payloadFor(toolName, value));

      expect(fragment?.inspectionRefusal).toMatch(/shape|cannot read/i);
      expect(fragment?.inspectionRefusal).not.toMatch(/limit|size/i);
    },
  );
});

describe('editFragments: the remedy for an unreadable tool_input is to resend it, never to split it', () => {
  /**
   * 🔴 The remedy travels as its own field beside the reason. Choosing it by
   * pattern-matching the reason's wording is what this module's own comment
   * warns about: it stays correct only by coincidence of wording.
   */
  it.each(EDIT_SURFACES)('%s names resending the tool_input as an object', async (toolName) => {
    const { editFragments } = await load();
    const [fragment] = editFragments(payloadFor(toolName, 'oops'));

    expect(fragment?.remedy).toBeTruthy();
    expect(fragment?.remedy).toMatch(/object/i);
    expect(fragment?.remedy).toMatch(/send|resend/i);
  });

  /**
   * `invariants.md` separates the two refusals precisely: a BOUND crossed says
   * "split the change and retry", because a smaller edit really does fit. An
   * unreadable CONTAINER must not — a remedy the caller cannot act on turns a
   * refusal into a loop.
   */
  it.each(EDIT_SURFACES)(
    '%s does not tell the caller to split the change and retry',
    async (toolName) => {
      const { editFragments } = await load();
      const [fragment] = editFragments(payloadFor(toolName, 'oops'));

      expect(fragment?.remedy).not.toMatch(/split|smaller/i);
      expect(fragment?.inspectionRefusal).not.toMatch(/split|smaller/i);
    },
  );
});

describe('editFragments: an absent tool_input still fails open, because there is nothing to judge', () => {
  // The passing direction, so the refusal above cannot be satisfied by refusing
  // everything. ABSENT is the fail-open half of the same rule.
  it.each(EDIT_SURFACES)(
    'reads no refusal into a %s payload carrying no tool_input at all',
    async (toolName) => {
      const { editFragments } = await load();
      const fragments = editFragments(payloadWithoutToolInput(toolName));

      expect(fragments.some(({ inspectionRefusal }) => inspectionRefusal)).toBe(false);
    },
  );

  it.each(EDIT_SURFACES)(
    'reads no refusal into a %s payload whose tool_input is null',
    async (toolName) => {
      const { editFragments } = await load();
      const fragments = editFragments(payloadFor(toolName, null));

      expect(fragments.some(({ inspectionRefusal }) => inspectionRefusal)).toBe(false);
    },
  );
});

describe('editFragments: a readable tool_input is still read', () => {
  it.each(EDIT_SURFACES)(
    'still yields the real path and text for a readable %s',
    async (toolName, readable, expected) => {
      const { editFragments } = await load();

      expect(editFragments(payloadFor(toolName, readable))).toEqual(expected);
    },
  );
});

describe('editFragments: the refusal belongs to the edit surfaces, not to every payload', () => {
  // A tool this module normalises nothing for has nothing to refuse — widening
  // the refusal to every payload would block reads and searches on a shape they
  // were never judged by.
  it.each(UNREADABLE_TOOL_INPUTS)(
    'yields nothing for an unknown tool whose tool_input is %s',
    async (_label, value) => {
      const { editFragments } = await load();

      expect(editFragments(payloadFor('Frobnicate', value))).toEqual([]);
    },
  );
});

describe('the guards block on a tool_input they cannot read', () => {
  /**
   * The consequence, through a public entry point: `guard-secret-file` measured
   * exit 0 on this payload, because the fragment it was handed looked like a
   * clean edit. Its fallback remedy for a non-apply_patch refusal is "Split it
   * into a smaller edit and retry" — so the stderr assertion below also pins
   * that the module carries a `remedy` of its own rather than leaving the guard
   * to print advice the caller cannot act on.
   */
  it('guard-secret-file refuses a Write whose tool_input it cannot read, and says to resend it', async () => {
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [path.join(hooksDir, 'guard-secret-file.mjs')],
        { env: { ...process.env } },
        (error, _stdout, stderr) => {
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
        },
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(JSON.stringify(payloadFor('Write', 'oops')));
      child.stdin.end();
    });

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/object/i);
    expect(result.stderr).not.toMatch(/split/i);
  });
});
