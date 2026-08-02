import { describe, expect, it } from 'vitest';
import { GIT_LOCATION_VARS, gitEnv } from '../src/lib/git-env.js';

describe('gitEnv', () => {
  it('strips every variable that locates a repository', () => {
    const inherited: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const key of GIT_LOCATION_VARS) inherited[key] = '/somewhere/else/.git';
    const sanitised = gitEnv(inherited);
    for (const key of GIT_LOCATION_VARS) expect(sanitised[key], key).toBeUndefined();
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
