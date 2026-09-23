import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLOUD_ACCESS_KEY } from './secrets-fixtures.js';

/**
 * AR-51 — `editFragments` is the one normaliser every edit guard reads through,
 * and it knew Write, Edit and apply_patch only. A MultiEdit or a NotebookEdit
 * returned `[]`, which every consumer reads as "nothing to inspect" — so a
 * credential could reach a tracked file through MultiEdit while a guard said
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
  it('guard-secret-file blocks a credential reaching a tracked file through MultiEdit', async () => {
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
      child.stdin.write(
        JSON.stringify(
          multiEdit(path.join(repoRoot, 'notes.md'), [
            { old_string: 'a', new_string: `AWS_KEY=${CLOUD_ACCESS_KEY}` },
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

/**
 * RP-244 — failure-diagnostician, measured on NTFS at 1221613.
 *
 * `normalisePath` converts every backslash to a forward slash and then runs
 * `path.posix.normalize`, which collapses the leading `//` a Win32 verbatim
 * (`\\?\`) or device-namespace (`\\.\`) prefix depends on: `\\?\C:\…`
 * reaches every consuming guard as `/?/C:/…`, and `\\.\C:\…` as `/C:/…` —
 * neither of which any rulebook prefix ever matches — while Node's own `fs`
 * writes through every one of these spellings to the real file underneath.
 * `guard-rulebook.test.ts` › "guard-rulebook: a Win32 verbatim path does not
 * bypass the guard (RP-244)" is the consequence through the guard's own
 * entry point, gated to the windows-e2e lane because the
 * spelling only resolves to a real file on a Windows filesystem; this block
 * is the platform-independent pin, because `normalisePath` is plain string
 * manipulation with no filesystem dependency.
 *
 * Expected values are hand-written from the Win32 rule the fix applies —
 * strip a verbatim/device prefix when it is followed by a drive letter, and
 * map `\\?\UNC\server\share\…` to `//server/share/…` — never derived by
 * calling `editFragments` a second time on the plain spelling and comparing
 * the two outputs (`.claude/rules/invariants.md`, the independent-oracle
 * invariant: a test must not derive its expected result from the same
 * production mechanism it checks).
 *
 * RP-244 round 2 — security-scanner HOLD on PR #302, measured on NTFS at
 * 1221613's round-1 fix. Four more blockers, all still inside `normalisePath`
 * except blocker 1 (`guard-rulebook`'s own inability to judge a `//`-prefixed
 * path, pinned in `guard-rulebook.test.ts` instead): a plain (non-verbatim)
 * UNC path had the identical bypass "pre-existing on master" (blocker 1); a
 * doubled separator after the `?`/`.` was not stripped because the regex
 * required exactly one (blocker 2); a verbatim/device path with no drive
 * letter and no `UNC` token — `\\?\Volume{GUID}\…` — fell through to plain
 * `path.posix.normalize` and lost its leading `//` the same way the round-1
 * bug did (blocker 3); and the UNC branch normalised its remainder as
 * RELATIVE rather than ABSOLUTE, so a crafted run of `../` segments was not
 * clamped at the root and instead did unbounded work, and a killed hook is
 * an ALLOW (blocker 4). The fix: any
 * input beginning with two separators that is not a recognised
 * verbatim/device DRIVE form keeps a leading `//` and has its remainder
 * normalised as ABSOLUTE (`'/' + path.posix.normalize('/' + rest)`) rather
 * than relative, which is what clamps a leading `..` run at the root instead
 * of carrying it through.
 */
describe('editFragments: normalisePath resolves a Win32 verbatim/device path the way the OS does (RP-244)', () => {
  const writePayload = (filePath: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'x' },
  });

  const filePathOf = async (filePath: string) => {
    const { editFragments } = await load();
    const [fragment] = editFragments(writePayload(filePath));
    return fragment?.filePath;
  };

  it.each([
    [
      'verbatim, uppercase drive, backslash form',
      String.raw`\\?\C:\Users\x\rig\.claude\settings.json`,
      'C:/Users/x/rig/.claude/settings.json',
    ],
    [
      'verbatim, forward-slash form',
      '//?/C:/Users/x/rig/.claude/settings.json',
      'C:/Users/x/rig/.claude/settings.json',
    ],
    [
      'verbatim, lowercase drive letter — the drive letter case is preserved',
      String.raw`\\?\c:\Users\x\rig\.claude\settings.json`,
      'c:/Users/x/rig/.claude/settings.json',
    ],
    [
      'device namespace, backslash form',
      String.raw`\\.\C:\Users\x\rig\.claude\settings.json`,
      'C:/Users/x/rig/.claude/settings.json',
    ],
    [
      'device namespace, forward-slash form',
      '//./C:/Users/x/rig/.claude/settings.json',
      'C:/Users/x/rig/.claude/settings.json',
    ],
    [
      'verbatim, an NTFS ::$INDEX_ALLOCATION stream named on the directory component',
      String.raw`\\?\C:\Users\x\rig\.claude::$INDEX_ALLOCATION\settings.json`,
      'C:/Users/x/rig/.claude::$INDEX_ALLOCATION/settings.json',
    ],
    [
      // RP-244 round 2, blocker 2: the strip regex required EXACTLY one
      // separator after the `?`/`.`, so a doubled separator (two backslashes
      // here, where the ordinary form has one) left the whole `\\?\\C:` prefix
      // unstripped — `/?/C:/…`, matching no rulebook prefix. The fix accepts
      // one-or-more separators, so this collapses to the same plain spelling
      // as the singly-separated form above.
      'verbatim, doubled separator after the `?` (not exactly one)',
      String.raw`\\?\\C:\Users\x\rig\.claude\settings.json`,
      'C:/Users/x/rig/.claude/settings.json',
    ],
  ])('%s resolves to the plain C:/… spelling', async (_label, input, expected) => {
    expect(await filePathOf(input)).toBe(expected);
  });

  it.each([
    ['backslash form', String.raw`\\?\UNC\localhost\c$\Users\x\rig\.claude\settings.json`],
    ['forward-slash form', '//?/UNC/localhost/c$/Users/x/rig/.claude/settings.json'],
    [
      'device-namespace form (\\\\.\\UNC\\…, not \\\\?\\UNC\\…)',
      String.raw`\\.\UNC\localhost\c$\Users\x\rig\.claude\settings.json`,
    ],
    ['lowercase "unc"', String.raw`\\?\unc\localhost\c$\Users\x\rig\.claude\settings.json`],
  ])(
    'a verbatim UNC path, %s, resolves to //localhost/c$/Users/x/rig/.claude/settings.json',
    async (_label, input) => {
      expect(await filePathOf(input)).toBe('//localhost/c$/Users/x/rig/.claude/settings.json');
    },
  );

  it(// RP-244 round 2, blocker 3: a verbatim/device path with no drive letter
  // and no `UNC` token (an NTFS volume GUID path, `\\?\Volume{…}\…`, or a
  // `\\?\GLOBALROOT\…`-style device path) matched neither the UNC regex nor
  // the drive regex, so it fell all the way through to
  // `path.posix.normalize`, which swallowed the leading `//` as it does for
  // any other doubled slash — `/?/Volume{…}/…`. The fix keeps a leading `//`
  // for anything that starts with two separators and is not a recognised
  // verbatim/device DRIVE form, so this stays `//`-prefixed instead.
  'a verbatim device path with no drive letter (\\\\?\\Volume{GUID}\\…) keeps a leading // rather than losing it to POSIX normalisation', async () => {
    expect(
      await filePathOf(
        String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\a\.claude\settings.json`,
      ),
    ).toBe('//?/Volume{12345678-1234-1234-1234-123456789abc}/a/.claude/settings.json');
  });

  it(// RP-244 round 2, blocker 4: the UNC branch normalised its remainder as
  // RELATIVE, so a run of leading `../` segments was carried through
  // in full instead of clamping at the root the way an ABSOLUTE
  // normalisation does — unbounded work on the unfixed implementation for
  // 200,000 segments; the fixed, absolute form returns quickly. A killed
  // hook is an ALLOW (`.claude/rules/invariants.md`, "fail-open guards"), so
  // this is itself the vulnerability, not just a performance concern. No
  // wall-clock assertion here — RP-218 already showed those are
  // load-sensitive, and measuring this one directly showed a second reason:
  // `normalisePath` runs synchronously with no `await` inside it, so it
  // blocks the event loop for the whole unfixed call, and vitest's
  // `testTimeout` timer — itself just a `setTimeout` racing the test — never
  // gets a turn to fire before the call returns. The unfixed implementation
  // is red on the equality assertion below instead, only after that full
  // unbounded pass; the fixed one returns quickly and is red on nothing.
  // `testTimeout` (15s here, `vitest.config.ts`) still matters as the
  // ceiling on the file staying runnable at all — a still-unbounded rewrite
  // that grows past it hangs the suite rather than reporting a clean
  // failure — it is just not what turns this particular case red today.
  'a crafted UNC path with 200,000 ../ segments clamps at the root instead of growing without bound', async () => {
    // Not String.raw: a raw template literal cannot end in a single
    // backslash immediately before the closing backtick (it would escape
    // the backtick itself), so the verbatim UNC prefix `\\?\UNC\` is built
    // with ordinary escapes instead.
    const filePath = '\\\\?\\UNC\\' + '../'.repeat(200_000) + 'x';
    expect(await filePathOf(filePath)).toBe('//x');
  });

  describe('ordinary spellings are unchanged from today — pinned as hand-written literals', () => {
    it.each([
      ['a POSIX absolute path', '/usr/local/bin/foo', '/usr/local/bin/foo'],
      ['an ordinary relative path', 'packages/core/src/x.ts', 'packages/core/src/x.ts'],
      [
        'an ordinary C:\\… path',
        String.raw`C:\Users\x\rig\.claude\settings.json`,
        'C:/Users/x/rig/.claude/settings.json',
      ],
    ])('%s: %s stays %s', async (_label, input, expected) => {
      expect(await filePathOf(input)).toBe(expected);
    });
  });

  it(// RP-244 round 2, blocker 1: a genuine (non-verbatim) UNC path used to
  // normalise to a single-slash `/server/share/…` — a spelling
  // `guard-rulebook`'s `relativeTo` can no more judge against a `C:/…`
  // repository root than the `//`-prefixed verbatim forms can, so it carried
  // the exact same bypass "pre-existing on master" per the diagnosis. It is
  // deliberately moved out of "unchanged from today" above and changed here
  // to the same `//`-prefixed, undecidable-by-root spelling every other
  // device/UNC form gets, so `guard-rulebook`'s new refusal (RP-244 round 2)
  // covers it identically.
  'a genuine (non-verbatim) UNC path keeps a // prefix instead of losing it to POSIX normalisation', async () => {
    expect(await filePathOf(String.raw`\\server\share\rig\.claude\settings.json`)).toBe(
      '//server/share/rig/.claude/settings.json',
    );
  });

  /**
   * RP-244 round 3 — security-scanner findings on PR #302, measured on NTFS
   * at this branch's head `b0114ac`. Both live in the DRIVE branch (once a
   * `\\?\`/`\\.\` marker is stripped) and in the plain fallback at the
   * bottom of `normalisePath`: neither clamps `C:` and its remainder at the
   * drive root the way the UNC/device branch above does (round 2, blocker
   * 4) — each runs `path.posix.normalize` on the drive letter and the
   * remainder TOGETHER, relatively, so a `..` run walks straight past the
   * drive letter instead of stopping there.
   *
   * Finding A — a wrong answer, not only an unbounded one: Win32 clamps
   * `C:\..\Users\x\.claude\rules\autonomy.md` at the drive root and writes
   * the real file there; `normalisePath` today returns the relative
   * `Users/x/.claude/rules/autonomy.md`, which `guard-rulebook`'s
   * `relativeTo` can no more strip a repository root from than the
   * `//`-prefixed bypasses above, so the armed guard exits 0 on a live
   * rulebook edit.
   *
   * Finding B — the same shape is also quadratic: `\\?\C:\` or `C:\`
   * followed by `'../'.repeat(200_000)` does unbounded relative work here,
   * where the UNC branch a few tests above (fixed in round 2) is linear
   * because it normalises absolutely. A killed hook is an ALLOW
   * (`.claude/rules/invariants.md`, "fail-open guards"), so this is the
   * vulnerability, not a performance footnote — same reasoning as blocker 4
   * above, and the same reason there is no wall-clock assertion here: the
   * call is synchronous, so an unfixed run is red on the equality assertion
   * below rather than on a timeout.
   *
   * Planned fix: clamp at the drive root the way the UNC branch already
   * does — `drive + path.posix.normalize('/' + rest)`.
   */
  it.each([
    [
      'a `..` immediately after the drive root, backslash form',
      String.raw`C:\..\Users\x\rig\.claude\settings.json`,
      'C:/Users/x/rig/.claude/settings.json',
    ],
    [
      'a `..` run immediately after the drive root, forward-slash form',
      'C:/../../../Users/x/rig/.claude/settings.json',
      'C:/Users/x/rig/.claude/settings.json',
    ],
    [
      'a `..` immediately after the drive root, verbatim-prefixed',
      String.raw`\\?\C:\..\Users\x\rig\.claude\settings.json`,
      'C:/Users/x/rig/.claude/settings.json',
    ],
    [
      'a `..` immediately after the drive root, lowercase drive letter — the drive letter case is preserved',
      String.raw`c:\..\a`,
      'c:/a',
    ],
  ])(
    '%s clamps at the drive root instead of escaping it (RP-244 round 3)',
    async (_label, input, expected) => {
      expect(await filePathOf(input)).toBe(expected);
    },
  );

  describe('ordinary spellings under a drive letter are unchanged from today — pinned as hand-written literals (RP-244 round 3)', () => {
    it.each([
      [
        'a `..` that cancels an intermediate segment, not the drive root',
        String.raw`C:\a\.\b\..\c`,
        'C:/a/c',
      ],
      [
        // Pinned exactly as `normalisePath` yields it today — not a claim
        // that the shape is meaningful, only that the fix for findings A/B
        // above must not change it.
        'a drive-relative spelling with no separator after the colon',
        String.raw`C:foo\bar`,
        'C:foo/bar',
      ],
    ])('%s: %s stays %s', async (_label, input, expected) => {
      expect(await filePathOf(input)).toBe(expected);
    });
  });

  it(// RP-244 round 3, finding B: the verbatim-prefixed DRIVE branch
  // normalises its remainder RELATIVE to the drive letter instead of
  // clamping at it, so a run of leading `../` segments is carried through
  // in full instead of stopping at the root — unbounded relative work on
  // the unfixed implementation for 200,000 segments; the fixed, clamped
  // form returns quickly. No wall-clock assertion here, for the same reason
  // as the UNC case above: `normalisePath` is synchronous, so an unfixed
  // run is red on the equality assertion below, only after the full
  // unbounded pass, rather than on a timeout.
  'a crafted verbatim-prefixed drive path with 200,000 ../ segments clamps at the drive root instead of growing without bound (RP-244 round 3)', async () => {
    // Not String.raw: a raw template literal cannot end in a single
    // backslash immediately before the closing backtick, so the verbatim
    // drive prefix `\\?\C:\` is built with ordinary escapes instead.
    const filePath = '\\\\?\\C:\\' + '../'.repeat(200_000) + 'x';
    expect(await filePathOf(filePath)).toBe('C:/x');
  });

  it(// RP-244 round 3, finding B: the same unclamped-relative defect, on the
  // plain (non-verbatim) fallback branch rather than the verbatim DRIVE
  // branch — the two are separate code paths in `normalisePath` and both
  // need their own pin.
  'a crafted plain drive path with 200,000 ../ segments clamps at the drive root instead of growing without bound (RP-244 round 3)', async () => {
    const filePath = 'C:\\' + '../'.repeat(200_000) + 'x';
    expect(await filePathOf(filePath)).toBe('C:/x');
  });

  /**
   * RP-244 round 4 — security-scanner finding on PR #302, measured against
   * round 3's fix at this branch's head `9bcb362`. Round 3's `clampAtDriveRoot`
   * only recognises the DRIVE-ROOT spelling — a separator immediately after
   * the colon (`DRIVE_ROOT_PREFIX`, `/^[A-Za-z]:\//`) — and leaves every
   * DRIVE-RELATIVE spelling (no separator right after the colon, e.g.
   * `C:foo\bar` or `C:..\..\a`) to plain `path.posix.normalize` run over the
   * drive marker and the remainder TOGETHER. `path.posix.normalize` treats
   * the segment `C:..` as an ordinary filename — it is not the literal
   * string `..` — so a SECOND `..` segment cancels it exactly as it would
   * cancel any other segment, and the drive marker disappears from the
   * result entirely: `C:../../a/b` normalises to the bare, driveless `a/b`.
   * That is a worse bypass than round 3's finding A, not merely an
   * unclamped one: a driveless relative path carries no signal downstream
   * that it ever named a drive-relative spelling at all, so
   * `guard-rulebook`'s root comparison has nothing left to refuse as
   * unjudgeable — it just judges the wrong (bare) path and exits 0.
   * `guard-rulebook.test.ts` (absent in a generated rig) › "blocks a Write
   * to a drive-relative `..\..` escape of .claude/settings.json, run with
   * the checkout root as cwd (RP-244 round 4)" is the consequence through
   * the guard's own entry point, gated to windows-e2e because it depends on
   * a real Win32 drive-relative resolution; this block is the
   * platform-independent pin on `normalisePath` itself.
   *
   * Expected values are hand-written from the planned fix, not derived by
   * calling `editFragments` a second time and comparing (the independent-
   * oracle invariant, `.claude/rules/invariants.md`): split a
   * drive-RELATIVE prefix (`/^[A-Za-z]:(?![\\/])/`) off before normalising,
   * normalise the REMAINDER alone, RELATIVELY — never absolutely, because a
   * drive-relative spelling has no root of its own to clamp at — and
   * re-attach the drive marker afterward, so no `..` in the remainder can
   * ever reach back far enough to cancel the marker itself.
   */
  describe('a drive-relative spelling never lets a `..` cancel the drive marker itself (RP-244 round 4)', () => {
    it.each([
      [
        'a `..` that cancels the whole remainder, leaving nothing after the drive marker',
        'C:foo/..',
        // `'C:' + path.posix.normalize('foo/..')` — the remainder alone
        // normalises to `.`, so the drive marker is followed by a bare `.`
        // rather than nothing.
        'C:.',
      ],
      [
        "two leading `..` segments — today's bug: the second `..` cancels the " +
          '`C:..` segment itself instead of walking past it, dropping the drive ' +
          'marker from the result entirely',
        String.raw`C:..\..\a\b`,
        'C:../../a/b',
      ],
      ['the same escape, verbatim-prefixed', String.raw`\\?\C:..\..\a`, 'C:../../a'],
      ['lowercase drive letter — the drive letter case is preserved', String.raw`c:..\x`, 'c:../x'],
    ])('%s: %s resolves to %s', async (_label, input, expected) => {
      expect(await filePathOf(input)).toBe(expected);
    });
  });
});
