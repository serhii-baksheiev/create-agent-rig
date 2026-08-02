import { describe, expect, it } from 'vitest';
import { GIT_LOCATION_VARS, gitEnv } from '../src/lib/git-env.js';

describe('gitEnv', () => {
  // The list is written out rather than derived from GIT_LOCATION_VARS: a test
  // that builds its input from the constant it checks passes for any list,
  // including an empty one.
  it('strips every variable that locates a repository', () => {
    const located = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE',
      'GIT_PREFIX',
    ];
    const inherited: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const key of located) inherited[key] = '/somewhere/else/.git';
    const sanitised = gitEnv(inherited);
    for (const key of located) expect(sanitised[key], key).toBeUndefined();
    // and the module's own list says the same thing
    expect([...GIT_LOCATION_VARS].sort()).toEqual([...located].sort());
  });

  it('leaves the rest of the caller’s environment alone', () => {
    const sanitised = gitEnv({
      PATH: '/usr/bin',
      GIT_SSH_COMMAND: 'ssh -i key',
      GIT_TERMINAL_PROMPT: '0',
      GIT_DIR: '/elsewhere/.git',
    });
    expect(sanitised['PATH']).toBe('/usr/bin');
    expect(sanitised['GIT_SSH_COMMAND']).toBe('ssh -i key');
    expect(sanitised['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(sanitised['GIT_DIR']).toBeUndefined();
  });

  it('does not mutate what it was given — the caller keeps its own env', () => {
    const original: NodeJS.ProcessEnv = { GIT_DIR: '/elsewhere/.git' };
    gitEnv(original);
    expect(original['GIT_DIR']).toBe('/elsewhere/.git');
  });
});
