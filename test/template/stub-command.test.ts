import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stubCommand } from '../helpers/stub-command.js';
import { removeFixture } from '../helpers/remove-fixture.js';
import { onlyOnWindows, skipUnless } from '../helpers/env.js';

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
    cleanup: () => removeFixture(dir),
  };
};

const materializeStubExecutable = async () => {
  const helper = (await import('../helpers/stub-command.js')) as Record<string, unknown>;
  return helper['materializeStubExecutable'] as (
    source: string,
    destination: string,
    dependencies?: {
      linkFile?: (source: string, destination: string) => Promise<void>;
      copyFile?: (source: string, destination: string, mode?: number) => Promise<void>;
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

  it('runs its handler after materializing the stub executable', async () => {
    const stub = await stubCommand('ghstub', 'return { stdout: "linked\\n" };');
    try {
      const out = execFileSync('ghstub', ['issue', 'list'], { encoding: 'utf8' });
      expect(out).toBe('linked\n');
    } finally {
      stub.restore();
    }
  });

  it('hard-links a fresh executable on the same volume when hard-link capability is available', async () => {
    const fixture = await executableFixture();
    await copyFile(process.execPath, fixture.source);
    try {
      await (
        await materializeStubExecutable()
      )(fixture.source, fixture.destination);

      const [sourceStats, destinationStats] = await Promise.all([
        stat(fixture.source, { bigint: true }),
        stat(fixture.destination, { bigint: true }),
      ]);
      expect(destinationStats.dev).toBe(sourceStats.dev);
      expect(destinationStats.ino).toBe(sourceStats.ino);
    } finally {
      await fixture.cleanup();
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

  it('copies the executable when Windows reports an unknown error for an exhausted hard-link operation', async () => {
    const fixture = await executableFixture();
    const exhausted = Object.assign(new Error('unknown error, link'), {
      code: 'UNKNOWN',
      syscall: 'link',
    });
    let copies = 0;
    try {
      await (
        await materializeStubExecutable()
      )(fixture.source, fixture.destination, {
        linkFile: async () => {
          throw exhausted;
        },
        copyFile: async (source, destination) => {
          copies += 1;
          await copyFile(source, destination);
        },
      });
      expect(copies).toBe(1);
      expect(await readFile(fixture.destination)).toEqual(fixture.contents);
    } finally {
      await fixture.cleanup();
    }
  });

  it('copies the executable when the filesystem reports too many hard links', async () => {
    const fixture = await executableFixture();
    const exhausted = Object.assign(new Error('too many links'), { code: 'EMLINK' });
    let copies = 0;
    try {
      await (
        await materializeStubExecutable()
      )(fixture.source, fixture.destination, {
        linkFile: async () => {
          throw exhausted;
        },
        copyFile: async (source, destination) => {
          copies += 1;
          await copyFile(source, destination);
        },
      });
      expect(copies).toBe(1);
      expect(await readFile(fixture.destination)).toEqual(fixture.contents);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses an exclusive copy when a hard-link limit requires the fallback', async () => {
    const fixture = await executableFixture();
    const exhausted = Object.assign(new Error('too many links'), { code: 'EMLINK' });
    let copyMode: number | undefined;
    try {
      await (
        await materializeStubExecutable()
      )(fixture.source, fixture.destination, {
        linkFile: async () => {
          throw exhausted;
        },
        copyFile: async (_source, _destination, mode) => {
          copyMode = mode;
        },
      });
      expect(copyMode).toBe(fsConstants.COPYFILE_EXCL);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not treat an unknown error outside the hard-link operation as a copy fallback', async () => {
    const fixture = await executableFixture();
    const unrelated = Object.assign(new Error('unknown error, open'), {
      code: 'UNKNOWN',
      syscall: 'open',
    });
    let copies = 0;
    try {
      await expect(
        (await materializeStubExecutable())(fixture.source, fixture.destination, {
          linkFile: async () => {
            throw unrelated;
          },
          copyFile: async () => {
            copies += 1;
          },
        }),
      ).rejects.toBe(unrelated);
      expect(copies).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('propagates a copy failure after a hard-link limit fallback', async () => {
    const fixture = await executableFixture();
    const exhausted = Object.assign(new Error('too many links'), { code: 'EMLINK' });
    const copyFailed = Object.assign(new Error('copy failed'), { code: 'EACCES' });
    try {
      await expect(
        (await materializeStubExecutable())(fixture.source, fixture.destination, {
          linkFile: async () => {
            throw exhausted;
          },
          copyFile: async () => {
            throw copyFailed;
          },
        }),
      ).rejects.toBe(copyFailed);
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

  it('restore removes the stub directory it created, including the Windows executable link, and nothing else', async () => {
    // A sibling temp directory with a different, unique prefix: proves
    // restore() deletes only the one directory it created, not everything
    // under os.tmpdir() that looks like a stub.
    const sentinelDir = await mkdtemp(path.join(tmpdir(), 'stub-rp348sentinel-'));
    const sentinelFile = path.join(sentinelDir, 'keep.txt');
    await writeFile(sentinelFile, 'keep');

    const leftover: string[] = [];
    try {
      for (let lifetime = 0; lifetime < 3; lifetime += 1) {
        const handle = await stubCommand('rp348stub', 'return { stdout: "ok" };');
        leftover.push(handle.bin);
        await expect(stat(handle.bin)).resolves.toBeTruthy();

        // On win32 the executable inside the directory is the hard link (or
        // the EXDEV copy) that used to outlive restore(). The running
        // binary's nlink is not asserted: every concurrent stubCommand in a
        // parallel worker moves the same host-wide counter, so only this
        // lifetime's own link path is checked, through its directory.
        const stubExecutable =
          process.platform === 'win32' ? path.join(handle.bin, 'rp348stub.exe') : null;
        if (stubExecutable !== null) await expect(stat(stubExecutable)).resolves.toBeTruthy();

        handle.restore();
        // The directory this lifetime created must be gone before the next
        // one starts, or a leak here would just be masked by the next loop.
        await expect(stat(handle.bin)).rejects.toMatchObject({ code: 'ENOENT' });
        if (stubExecutable !== null) {
          await expect(stat(stubExecutable)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        leftover.pop();
      }

      // The sentinel, created before any stub existed, is untouched.
      await expect(stat(sentinelDir)).resolves.toBeTruthy();
      await expect(readFile(sentinelFile, 'utf8')).resolves.toBe('keep');
    } finally {
      await removeFixture(sentinelDir);
      for (const bin of leftover) {
        await removeFixture(bin);
      }
    }
  });

  // RP-412: on windows-latest something can still hold the materialised
  // `<name>.exe` open when restore() runs, and the recursive removal of
  // `bin` throws EBUSY. `stubCommand`'s third argument is a seam over that
  // one removal call — `{ remove?: (dir: string) => void }`, defaulting to
  // the production rmSync call — so these cases can drive the failure
  // without a real locked handle. A removal that cannot complete must still
  // let restore() put the environment back, and must not throw out of a
  // caller's `afterEach`/`finally`; it instead records `bin` on the handle
  // as `leftover`. A removal error that is not a busy file is a different
  // defect and still propagates.
  describe('restore() when the stub directory cannot be removed', () => {
    it('restore() leaves a busy stub directory in place, reports it as leftover, and still restores PATH and NODE_OPTIONS', async () => {
      const before = { PATH: process.env['PATH'], NODE_OPTIONS: process.env['NODE_OPTIONS'] };
      const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      const stub = await stubCommand('ghstub', 'return {};', {
        remove: () => {
          throw busy;
        },
      });
      try {
        expect(() => stub.restore()).not.toThrow();
        expect(stub.leftover).toBe(stub.bin);
        expect(process.env['PATH']).toBe(before.PATH);
        expect(process.env['NODE_OPTIONS']).toBe(before.NODE_OPTIONS);
      } finally {
        await removeFixture(stub.bin);
      }
    });

    it('restore() treats EPERM as a busy file on win32 only, and as a real error elsewhere', async () => {
      const before = { PATH: process.env['PATH'], NODE_OPTIONS: process.env['NODE_OPTIONS'] };
      const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const stub = await stubCommand('ghstub', 'return {};', {
        remove: () => {
          throw denied;
        },
      });
      try {
        if (process.platform === 'win32') {
          expect(() => stub.restore()).not.toThrow();
          expect(stub.leftover).toBe(stub.bin);
        } else {
          expect(() => stub.restore()).toThrow(/operation not permitted/);
          expect(stub.leftover).toBeUndefined();
        }
        expect(process.env['PATH']).toBe(before.PATH);
        expect(process.env['NODE_OPTIONS']).toBe(before.NODE_OPTIONS);
      } finally {
        await removeFixture(stub.bin);
      }
    });

    it('restore() still throws a removal error that is not a busy file', async () => {
      const notBusy = Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      const stub = await stubCommand('ghstub', 'return {};', {
        remove: () => {
          throw notBusy;
        },
      });
      try {
        expect(() => stub.restore()).toThrow();
      } finally {
        await removeFixture(stub.bin);
      }
    });

    it('restore() removes the directory and reports no leftover when removal succeeds', async () => {
      const stub = await stubCommand('ghstub', 'return {};');
      stub.restore();
      expect(stub.leftover).toBeUndefined();
      await expect(stat(stub.bin)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it("a busy restore keeps the stub's preload beside the executable, never a half-removed directory", async () => {
      const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      const stub = await stubCommand('ghstub', 'return {};', {
        remove: () => {
          throw busy;
        },
      });
      try {
        stub.restore();
        await expect(stat(path.join(stub.bin, 'ghstub.preload.cjs'))).resolves.toBeTruthy();
      } finally {
        await removeFixture(stub.bin);
      }
    });

    it('the default remover removes the stub executable before anything else, and a busy executable leaves the directory whole', async () => {
      const calls: string[] = [];
      const stub = await stubCommand('ghstub', 'return {};', {
        rmSync: (target: string) => {
          calls.push(target);
          const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
          throw busy;
        },
      });
      const executable = path.join(
        stub.bin,
        process.platform === 'win32' ? 'ghstub.exe' : 'ghstub',
      );
      try {
        stub.restore();
        expect(calls).toEqual([executable]);
        expect(stub.leftover).toBe(stub.bin);
        await expect(stat(executable)).resolves.toBeTruthy();
        await expect(stat(path.join(stub.bin, 'ghstub.preload.cjs'))).resolves.toBeTruthy();
      } finally {
        await removeFixture(stub.bin);
      }
    });

    it('a busy restore reports the directory it left on stderr', async () => {
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
      const stub = await stubCommand('ghstub', 'return {};', {
        remove: () => {
          throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
        },
      });
      try {
        stub.restore();
        expect(writes.join('')).toContain(stub.bin);
      } finally {
        spy.mockRestore();
        await removeFixture(stub.bin);
      }
    });

    it('restore() does not throw while the stub executable is still held open by a running child (win32)', async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

      const stub = await stubCommand(
        'ghstub',
        "process.stderr.write('ready\\n'); require('node:fs').readFileSync(0, 'utf8'); return {};",
      );
      const child = spawn('ghstub', [], { stdio: ['pipe', 'pipe', 'pipe'] });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('stub child never signalled ready')),
            5000,
          );
          child.stderr?.on('data', (chunk: Buffer) => {
            if (chunk.toString('utf8').includes('ready')) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });

        expect(() => stub.restore()).not.toThrow();
        if (stub.leftover === undefined) {
          await expect(stat(stub.bin)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect(stub.leftover).toBe(stub.bin);
          await expect(stat(path.join(stub.bin, 'ghstub.exe'))).resolves.toBeTruthy();
          await expect(stat(path.join(stub.bin, 'ghstub.preload.cjs'))).resolves.toBeTruthy();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => {
            child.once('exit', resolve);
            child.once('error', resolve);
          });
          child.kill();
          await exited;
        }
        await removeFixture(stub.bin);
      }
    });
  });
});
