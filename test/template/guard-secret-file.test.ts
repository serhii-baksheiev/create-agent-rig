import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ATLASSIAN_TOKEN, CLOUD_ACCESS_KEY, GITHUB_PAT, PEM_HEADER } from './secrets-fixtures.js';

// AR-49(b), the PreToolUse half of the "both layers, one shared module" ruling.
//
// `.gitignore` (half a) stops a credential FILENAME from reaching a commit. It
// cannot stop an agent from writing one in the first place, and it says nothing
// at all about a credential VALUE pasted into an ordinary file — `notes.md`,
// a test fixture, a service module. That is the gap this hook closes, at the
// tool layer, before the write lands.
//
// The hook owns no vocabulary of its own: `isCredentialPath` and
// `findSecretValues` come from `.claude/scripts/lib/secrets.mjs`, which is
// pinned by `secrets-lib.test.ts`. Nothing here re-tests the module — these are
// the HOOK's behaviours: which tools it judges, which direction it fails in,
// and what its refusal is allowed to say out loud.
//
// 🔴 The negative half is the more important half, twice over. A guard that
// fires on `auth.ts`, `session.ts` or `.env.example` gets routed around within
// the week; and a guard that THROWS on a payload it did not expect blocks every
// edit in the session, which `.claude/rules/invariants.md` says gets it deleted
// within the hour. So both directions are pinned, and so is fail-open.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const hook = path.join(universal, '.claude', 'hooks', 'guard-secret-file.mjs');

interface HookResult {
  code: number;
  stderr: string;
}

/** Feed a synthetic hook payload to the hook, exactly as Claude Code does. */
function runHook(payload: unknown, env: NodeJS.ProcessEnv = {}): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hook],
      { env: { ...process.env, ...env } },
      (error, _stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    // A hook that decides early and exits closes the pipe under us; that EPIPE
    // is the hook working, not the test failing. The exit code is the subject.
    child.stdin.on('error', () => {});
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

const write = (filePath: string, content: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content },
});

const edit = (filePath: string, newString: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'x', new_string: newString },
});

const applyPatch = (filePath: string, addition: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: {
    command: ['*** Begin Patch', `*** Add File: ${filePath}`, `+${addition}`, '*** End Patch'].join(
      '\n',
    ),
  },
});

const deny = async (payload: unknown, why: string): Promise<HookResult> => {
  const result = await runHook(payload);
  expect(result.code, `should BLOCK: ${why}\nstderr: ${result.stderr}`).toBe(2);
  return result;
};

const allow = async (payload: unknown, why: string): Promise<HookResult> => {
  const result = await runHook(payload);
  expect(result.code, `should ALLOW: ${why}\nstderr: ${result.stderr}`).toBe(0);
  return result;
};

// Synthetic credentials, none of them real. They come from a shared module and
// are ASSEMBLED rather than written literally — a fixture written out in full
// here becomes the scanner's own first finding the moment this file is
// committed, and then blocks the commit that adds it. secrets-fixtures.ts says
// why that is preferred to an exemption list.

describe('guard-secret-file: a credential-named path is refused whatever is in it', () => {
  it('ships as a hook file at the path settings.json names', async () => {
    await expect(access(hook)).resolves.toBeUndefined();
  });

  it.each([
    ['jira.env', 'an env file, the one AR-49(a) was filed for'],
    ['config/secrets/prod.txt', 'the segment arm an ignore rule could not express'],
    ['id_rsa', 'a key with no extension to give it away'],
    ['private.pem', 'key material by extension'],
    ['db.secret', 'a credential word used as the extension'],
  ])('blocks a Write to %s (%s)', async (filePath) => {
    await deny(write(filePath, 'anything at all\n'), filePath);
  });

  it('blocks a Write to a credential path given absolutely, as the tool actually sends it', async () => {
    await deny(write(`${repoRoot}/config/secrets/prod.txt`, 'anything at all\n'), 'absolute path');
  });

  it('blocks apply_patch from adding a credential-named file', async () => {
    await deny(applyPatch('config/secrets/prod.txt', 'documented placeholder'), 'apply_patch path');
  });

  it('names the path it refused and where a credential belongs instead', async () => {
    const result = await deny(write('jira.env', 'anything at all\n'), 'jira.env');
    expect(result.stderr).toContain('jira.env');
    // `.claude/rules/invariants.md`: a refusal that does not say what to do
    // instead is a refusal that gets routed around.
    expect(result.stderr).toMatch(/outside the repo|\.claude\/rules\/[a-z-]+\.md/);
  });
});

describe('guard-secret-file: a credential value is refused wherever it is being written', () => {
  it.each([
    ['notes.md', CLOUD_ACCESS_KEY],
    ['notes.md', GITHUB_PAT],
    ['packages/core/src/thing.ts', CLOUD_ACCESS_KEY],
    ['packages/core/src/thing.ts', PEM_HEADER],
  ])('blocks a Write to %s carrying a credential value', async (filePath, value) => {
    await deny(write(filePath, `const config = {\n  value: '${value}',\n};\n`), filePath);
  });

  // Proves the hook reads the field the Edit tool actually populates. A hook
  // that only ever looked at `content` would pass every Edit in the session.
  it('blocks an Edit whose new_string carries a credential value', async () => {
    await deny(edit('packages/core/src/thing.ts', `const key = '${GITHUB_PAT}';`), 'Edit');
  });

  it('blocks apply_patch when an added line carries a credential value', async () => {
    await deny(
      applyPatch('notes.md', `const key = '${GITHUB_PAT}';`),
      'apply_patch credential value',
    );
  });

  it('names which shape it matched and the line it is on', async () => {
    const content = ['first line', 'second line', 'third line', `AWS_KEY=${CLOUD_ACCESS_KEY}`].join(
      '\n',
    );
    const result = await deny(write('notes.md', content), 'aws key on line 4');
    expect(result.stderr).toContain('cloud-access-key');
    expect(result.stderr).toMatch(/line 4\b/);
  });

  // 🔴 The headline of this file. A guard that prints what it found has copied
  // the credential into a hook transcript, a terminal scrollback and a CI log —
  // it has leaked the secret in the act of refusing it.
  it('never prints the credential it found, nor a fragment of it', async () => {
    const content = [
      `ATLASSIAN=${ATLASSIAN_TOKEN}`,
      `GITHUB=${GITHUB_PAT}`,
      `AWS=${CLOUD_ACCESS_KEY}`,
      PEM_HEADER,
    ].join('\n');
    const result = await deny(write('notes.md', content), 'four credentials at once');

    for (const value of [ATLASSIAN_TOKEN, GITHUB_PAT, CLOUD_ACCESS_KEY, PEM_HEADER])
      expect(result.stderr).not.toContain(value);
    // and not a distinctive fragment either, so a "truncated for safety"
    // implementation does not pass this by printing the first half
    for (const value of [ATLASSIAN_TOKEN, GITHUB_PAT, CLOUD_ACCESS_KEY, PEM_HEADER])
      expect(result.stderr).not.toContain(value.slice(0, 12));
  });
});

// 🔴 A payload the normalizer cannot READ is not a payload it may DROP. For an
// `apply_patch` whose `command` is neither a string nor an array of strings,
// `editFragments` returned no fragments at all — and a hook handed no fragments
// finds nothing to refuse, so the credential inside the shape it could not parse
// was written. The over-length branch ten lines above it in the same file already
// answers this situation the other way: a fragment carrying `inspectionRefusal`
// and `appliesToAll`, which every consumer fails closed on.
//
// This is not the fail-open case of `.claude/rules/invariants.md`. That rule is
// about the guard THROWING — an error it cannot reason about. This is a condition
// the guard detected, named in its own diagnostic, and then declined to act on.
describe('guard-secret-file: an apply_patch command it cannot read is refused, not dropped', () => {
  const patchLines = (addition: string) => [
    '*** Begin Patch',
    '*** Add File: notes.md',
    `+${addition}`,
    '*** End Patch',
  ];
  const credentialLine = `AWS_KEY=${CLOUD_ACCESS_KEY}`;
  const withCommand = (command: unknown) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command },
  });

  it('blocks a credential in a command given as one string', async () => {
    await deny(withCommand(patchLines(credentialLine).join('\n')), 'string command');
  });

  it('blocks a credential in a command given as an array of strings', async () => {
    await deny(withCommand(patchLines(credentialLine)), 'array-of-strings command');
  });

  it('refuses a command array holding a non-string element rather than inspecting nothing', async () => {
    const result = await deny(
      withCommand([
        '*** Begin Patch',
        '*** Add File: notes.md',
        42,
        `+${credentialLine}`,
        '*** End Patch',
      ]),
      'array with one non-string element',
    );
    expect(result.stderr).toMatch(/cannot safely inspect/i);
  });

  it('refuses a command given as an object rather than inspecting nothing', async () => {
    const result = await deny(
      withCommand({ patch: patchLines(credentialLine).join('\n') }),
      'object command',
    );
    expect(result.stderr).toMatch(/cannot safely inspect/i);
  });

  it('names the unreadable command shape as its reason, and still prints no credential', async () => {
    const result = await deny(
      withCommand({ patch: patchLines(credentialLine).join('\n') }),
      'object command',
    );
    expect(result.stderr).toMatch(/shape|form/i);
    // A size refusal and a credential finding are different diagnoses; borrowing
    // either one sends the reader to fix something that is not wrong.
    expect(result.stderr).not.toMatch(/is a credential file/);
    expect(result.stderr).not.toContain(CLOUD_ACCESS_KEY);
  });

  it('leaves a well-formed patch that carries no credential allowed', async () => {
    await allow(
      withCommand(patchLines('export const greet = () => "hello";')),
      'ordinary apply_patch',
    );
  });
});

describe('guard-secret-file: the ordinary work of the day stays allowed', () => {
  it('allows a Write to .env.example, which is how a project states what it needs', async () => {
    await allow(write('.env.example', `JIRA_API_TOKEN=${'your-token-here'}\n`), '.env.example');
  });

  it.each(['packages/core/src/auth.ts', 'packages/core/src/session.ts', 'src/tokenizer.ts'])(
    'allows a Write to %s, a security-ish name that is ordinary source',
    async (filePath) => {
      await allow(
        write(filePath, 'export const parse = (input: string) => input.trim();\n'),
        filePath,
      );
    },
  );

  it('allows a Write to test/template/secrets-lib.test.ts — the word is in the basename, not a directory', async () => {
    await allow(
      write('test/template/secrets-lib.test.ts', "describe('the vocabulary', () => {});\n"),
      'secrets in a basename',
    );
  });

  it.each([
    ['Read', { file_path: 'jira.env' }],
    ['Bash', { command: `echo ${CLOUD_ACCESS_KEY} >> notes.md` }],
    ['Grep', { pattern: GITHUB_PAT, path: '.' }],
  ])(
    'allows a %s call carrying the same credential payload — the matcher is edit-only',
    async (toolName, toolInput) => {
      await allow(
        { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput },
        `${toolName} is not this hook's business`,
      );
    },
  );
});

// `.claude/rules/invariants.md`: "Fail closed on a match, fail open on an
// error." Every case below is a payload the hook did not expect, and every one
// of them must resolve to allow — a crashed guard that blocks everything gets
// deleted within the hour, which costs all the rules at once, not just this one.
describe('guard-secret-file: it fails open on anything it does not understand', () => {
  it('allows a payload that is not JSON at all', async () => {
    await allow('{not json', 'unparseable stdin');
  });

  it('allows a payload with no tool_input at all', async () => {
    await allow({ hook_event_name: 'PreToolUse', tool_name: 'Write' }, 'no tool_input');
  });

  // 🔴 A payload the hook cannot locate is a payload it does not understand —
  // it allows rather than guessing, credential-looking content notwithstanding.
  it('allows a Write whose file_path is missing', async () => {
    await allow(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { content: `KEY=${CLOUD_ACCESS_KEY}\n` },
      },
      'missing file_path',
    );
  });

  it('allows a Write whose file_path is empty', async () => {
    await allow(write('', `KEY=${CLOUD_ACCESS_KEY}\n`), 'empty file_path');
  });

  // Bounded work is the other half of failing open: any input that can make the
  // guard hang is a total bypass of every rule it enforces.
  it('returns promptly on a very large harmless write', async () => {
    const started = Date.now();
    const result = await allow(
      write('notes.md', 'ordinary prose about tokens and passwords\n'.repeat(120_000)),
      'five megabytes of harmless text',
    );
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

// A hook nobody calls is decoration, and a hook installed without the module it
// imports is worse — it throws on a missing import at every single edit.
describe('guard-secret-file: the wiring that makes it run at all', () => {
  it('names every covered edit tool in autonomy.md’s mechanical refusal sentence', async () => {
    const autonomy = await readFile(
      path.join(universal, '.claude', 'rules', 'autonomy.md'),
      'utf8',
    );
    const mechanicalSentence = autonomy.match(/\*\*mechanical\*\*:\s*([\s\S]*?)\.\s*⚠/)?.[1] ?? '';

    expect(mechanicalSentence).toContain('`Write`');
    expect(mechanicalSentence).toContain('`Edit`');
    expect(mechanicalSentence).toContain('`apply_patch`');
  });

  it('is registered in settings.json under a PreToolUse matcher covering Write and Edit', async () => {
    const settings = JSON.parse(
      await readFile(path.join(universal, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };

    const groups = settings.hooks.PreToolUse.filter((group) =>
      group.hooks.some((entry) => entry.command.includes('guard-secret-file.mjs')),
    );
    expect(groups, 'no PreToolUse entry runs guard-secret-file.mjs').toHaveLength(1);

    const matcher = groups[0]?.matcher ?? '';
    const tools = matcher.split('|').map((part) => part.trim());
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
  });

  it('is classified in layers.json together with the module it imports', async () => {
    const layers = JSON.parse(
      await readFile(path.join(universal, 'layers.json'), 'utf8'),
    ) as Record<string, string[]>;
    // `.claude/scripts/lib/verdict.mjs` is the precedent: a shared module rides
    // in the same layer as the thing that imports it, or `init` installs a hook
    // whose first line is an unresolvable import.
    expect(layers.process).toContain('.claude/hooks/guard-secret-file.mjs');
    expect(layers.process).toContain('.claude/scripts/lib/secrets.mjs');
  });

  it('registers apply_patch and consumes the shared edit normalizer', async () => {
    const settings = JSON.parse(
      await readFile(path.join(universal, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };
    const group = settings.hooks.PreToolUse.find((candidate) =>
      candidate.hooks.some((entry) => entry.command.includes('guard-secret-file.mjs')),
    );
    expect(group?.matcher.split('|').map((part) => part.trim())).toContain('apply_patch');

    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/from ['"]\.\/lib\/edit-input\.mjs['"]/);
    expect(source).toMatch(/editFragments\(input\)/);
  });
});

// `.claude/rules/invariants.md`, "State the limits — and test them": a limits
// comment is the guard's own claim about how far it can be trusted, and nothing
// checks prose, so it drifts — into overstatement, which is the direction that
// gets someone hurt. The hook's header names four limits. These are them.
describe('guard-secret-file: the limits it states, asserted rather than asserted-in-prose', () => {
  it('does not see a credential split across two edits, because it is shown one fragment at a time', async () => {
    // The halves are innocuous apart and a credential together. Each edit is
    // allowed — not because the guard judged them safe, but because it never
    // sees the file the two of them build. This is the limit every PreToolUse
    // guard in this directory shares, and the layer that covers it is
    // `validate-no-secrets.mjs --staged`, which reads the assembled file.
    const half = CLOUD_ACCESS_KEY.slice(0, 10);
    const rest = CLOUD_ACCESS_KEY.slice(10);
    await allow(edit('src/config.ts', `const a = '${half}';`), 'the first half alone');
    await allow(edit('src/config.ts', `const b = '${rest}';`), 'the second half alone');

    // and the assembled text IS refused, so the two assertions above are a
    // statement about the guard's reach rather than about a weak pattern
    await deny(edit('src/config.ts', `const key = '${half}${rest}';`), 'the two halves together');
  });

  it('states its limits in its own source, where the next reader looks for them', async () => {
    // The comment is load-bearing: a guard whose reach is undocumented gets
    // trusted for cover it does not give. Asserted so deleting the block is a
    // red test rather than a silent loss.
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/LIMITS/);
    expect(source).toMatch(/fragment/i);
    expect(source).toMatch(/FAILS OPEN/i);
  });

  it('includes unsupported apply_patch command shapes in its existing fail-open limit', async () => {
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/There are FOUR:/);

    const failOpenLimit =
      source.match(/\/\/ {3}- It FAILS OPEN[\s\S]*?(?=\n\/\/\n\/\/ Failing open)/)?.[0] ?? '';
    expect(failOpenLimit).toMatch(
      /(?:unsupported|unrecognised|unrecognized)[\s\S]{0,40}`?apply_patch`?[\s\S]{0,40}command[\s\S]{0,20}(?:shape|form)|`?apply_patch`?[\s\S]{0,40}command[\s\S]{0,20}(?:shape|form)[\s\S]{0,40}(?:unsupported|unrecognised|unrecognized)/i,
    );
  });
});

describe('guard-secret-file: a checkout is judged by its repo-relative path', () => {
  // A project living under a directory called `secrets` is an ordinary thing —
  // `~/secrets/work/app`. If the guard judged the ABSOLUTE path it would refuse
  // every edit in that checkout, and be uninstalled the same day.
  it.each([
    ['/tmp/secrets/project', 'without a trailing slash'],
    ['/tmp/secrets/project/', 'with a trailing slash'],
  ])('judges the repo-relative path even when the project directory is given %s', async (dir) => {
    const result = await runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/secrets/project/src/index.ts',
          content: 'export const greet = () => "hello";\n',
        },
      },
      { CLAUDE_PROJECT_DIR: dir },
    );
    expect(result.code, `an ordinary edit was refused\n${result.stderr}`).toBe(0);
  });

  it('still refuses a credential directory INSIDE the project, whatever the project is called', async () => {
    const result = await runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/secrets/project/config/secrets/prod.txt',
          content: 'nothing special\n',
        },
      },
      { CLAUDE_PROJECT_DIR: '/tmp/secrets/project/' },
    );
    expect(result.code, result.stderr).toBe(2);
  });
});
