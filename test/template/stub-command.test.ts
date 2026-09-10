import { execFileSync } from 'node:child_process';
import { copyFile, link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stubCommand } from '../helpers/stub-command.js';

const executableFixture = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'stub-command-materialize-'));
  const source = path.join(dir, 'node.exe');
  const destination = path.join(dir, 'gh.exe');
  const contents = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x73, 0x74, 0x75, 0x62]);
  await writeFile(source, contents);
  return {
    source,
    destination,
    contents,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

const materializeStubExecutable = async () => {
  const helper = (await import('../helpers/stub-command.js')) as Record<string, unknown>;
  return helper['materializeStubExecutable'] as (
    source: string,
    destination: string,
    dependencies?: {
      linkFile?: (source: string, destination: string) => Promise<void>;
      copyFile?: (source: string, destination: string) => Promise<void>;
    },
  ) => Promise<void>;
};

// The stub is what lets a test that spawns `gh` run on Windows (AR-93): on
// POSIX a shell wrapper, on win32 node named `gh.exe` plus a preload
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

  it('reuses the running executable on the same Windows volume and still runs its handler', async () => {
    const stub = await stubCommand('ghstub', 'return { stdout: "linked\\n" };');
    try {
      const out = execFileSync('ghstub', ['issue', 'list'], { encoding: 'utf8' });
      expect(out).toBe('linked\n');

      if (process.platform === 'win32') {
        const stubExecutable = path.join(stub.bin, 'ghstub.exe');
        const sameVolume =
          path.parse(stubExecutable).root.toLowerCase() ===
          path.parse(process.execPath).root.toLowerCase();

        if (sameVolume) {
          const [stubStats, nodeStats] = await Promise.all([
            stat(stubExecutable, { bigint: true }),
            stat(process.execPath, { bigint: true }),
          ]);
          expect(stubStats.dev).toBe(nodeStats.dev);
          expect(stubStats.ino).toBe(nodeStats.ino);
        }
      }
    } finally {
      stub.restore();
    }
  });

  it('copies the executable when linking across volumes is refused', async () => {
    const fixture = await executableFixture();
    const crossVolume = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    let linkAttempts = 0;
    let copies = 0;
    try {
      await (
        await materializeStubExecutable()
      )(fixture.source, fixture.destination, {
        linkFile: async () => {
          linkAttempts += 1;
          throw crossVolume;
        },
        copyFile: async (source, destination) => {
          copies += 1;
          await copyFile(source, destination);
        },
      });
      expect(linkAttempts).toBe(1);
      expect(copies).toBe(1);
      expect(await readFile(fixture.destination)).toEqual(fixture.contents);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not copy the executable after linking succeeds', async () => {
    const fixture = await executableFixture();
    let copies = 0;
    try {
      await (
        await materializeStubExecutable()
      )(fixture.source, fixture.destination, {
        linkFile: link,
        copyFile: async () => {
          copies += 1;
        },
      });
      expect(copies).toBe(0);
      const [sourceStats, destinationStats] = await Promise.all([
        stat(fixture.source, { bigint: true }),
        stat(fixture.destination, { bigint: true }),
      ]);
      expect(destinationStats.ino).toBe(sourceStats.ino);
    } finally {
      await fixture.cleanup();
    }
  });

  it('propagates a link error other than cross-volume refusal without copying', async () => {
    const fixture = await executableFixture();
    const denied = Object.assign(new Error('access denied'), { code: 'EPERM' });
    let copies = 0;
    try {
      await expect(
        (await materializeStubExecutable())(fixture.source, fixture.destination, {
          linkFile: async () => {
            throw denied;
          },
          copyFile: async () => {
            copies += 1;
          },
        }),
      ).rejects.toBe(denied);
      expect(copies).toBe(0);
    } finally {
      await fixture.cleanup();
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
