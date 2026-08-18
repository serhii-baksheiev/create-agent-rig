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
function runHook(payload: unknown): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hook], (error, _stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
    });
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
    'allows a %s call carrying the same credential payload — the matcher is Write|Edit',
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
});
