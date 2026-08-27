import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTree, mapConcurrent } from '../src/lib/copy-tree.js';
import { modeBitsDeny, skipUnless } from '../../../test/helpers/env.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-copy-tree-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function makeSrc(files: Record<string, string | Buffer>): Promise<string> {
  const src = path.join(work, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(src, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return src;
}

describe('copyTree', () => {
  it('overlaps independent work up to the concurrency limit', async () => {
    const items = Array.from({ length: 8 }, (_, index) => index);
    const gates = items.map(() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });
    let announceThreeStarted!: () => void;
    const threeStarted = new Promise<void>((resolve) => {
      announceThreeStarted = resolve;
    });
    let active = 0;
    let maxActive = 0;

    const mapped = mapConcurrent(items, 3, async (item: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 3) announceThreeStarted();
      await gates[item]!.promise;
      active -= 1;
      return item * 2;
    });

    await threeStarted;
    try {
      expect(active).toBe(3);
      expect(maxActive).toBe(3);
    } finally {
      for (const gate of gates) gate.release();
    }
    expect(await mapped).toEqual(items.map((item) => item * 2));
  });

  it('stops claiming new work and waits for started work before rejecting', async () => {
    const originalError = new Error('worker failed');
    const started: number[] = [];
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let announceTwoStarted!: () => void;
    const twoStarted = new Promise<void>((resolve) => {
      announceTwoStarted = resolve;
    });
    let announceSiblingSettled!: () => void;
    const siblingSettled = new Promise<void>((resolve) => {
      announceSiblingSettled = resolve;
    });
    let siblingHasSettled = false;

    const mapped = mapConcurrent([0, 1, 2], 2, async (item) => {
      started.push(item);
      if (started.length === 2) announceTwoStarted();
      if (item === 0) {
        await failureGate;
        throw originalError;
      }
      if (item === 1) {
        await siblingGate;
        siblingHasSettled = true;
        announceSiblingSettled();
      }
      return item;
    });
    let rejectedBeforeSiblingSettled = false;
    void mapped.catch(() => {
      rejectedBeforeSiblingSettled = !siblingHasSettled;
    });

    await twoStarted;
    releaseFailure();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseSibling();
    await siblingSettled;
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(mapped).rejects.toBe(originalError);
    expect({ rejectedBeforeSiblingSettled, started }).toEqual({
      rejectedBeforeSiblingSettled: false,
      started: [0, 1],
    });
  });

  it('copies a nested tree', async () => {
    const src = await makeSrc({
      'a.txt': 'A',
      'sub/deep/b.txt': 'B',
    });
    const dest = path.join(work, 'dest');
    await copyTree(src, dest);
    expect(await readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('A');
    expect(await readFile(path.join(dest, 'sub/deep/b.txt'), 'utf8')).toBe('B');
  });

  it('skips ignored directory names at any depth', async () => {
    const src = await makeSrc({
      'keep.txt': 'x',
      'node_modules/pkg/index.js': 'no',
      'sub/node_modules/pkg/index.js': 'no',
      'dist/out.js': 'no',
      '.git/HEAD': 'no',
    });
    const dest = path.join(work, 'dest');
    await copyTree(src, dest);
    expect(await readdir(dest)).toEqual(expect.arrayContaining(['keep.txt', 'sub']));
    expect(await readdir(dest)).not.toEqual(expect.arrayContaining(['node_modules', 'dist']));
    expect(await readdir(path.join(dest, 'sub'))).toEqual([]);
  });

  it('applies the content transform to text files', async () => {
    const src = await makeSrc({ 'a.txt': 'hello TOKEN' });
    const dest = path.join(work, 'dest');
    await copyTree(src, dest, {
      transformContent: (content) => content.replace('TOKEN', 'world'),
    });
    expect(await readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('hello world');
  });

  it('copies binary files byte-identical, without transformation', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47, 0x00, 0xff]);
    const src = await makeSrc({ 'img.png': binary });
    const dest = path.join(work, 'dest');
    await copyTree(src, dest, {
      transformContent: () => {
        throw new Error('must not be called for binary files');
      },
    });
    expect(await readFile(path.join(dest, 'img.png'))).toEqual(binary);
  });

  it('preserves the executable bit through the content transform', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const src = await makeSrc({ 'run.sh': '#!/bin/sh\necho TOKEN' });
    await chmod(path.join(src, 'run.sh'), 0o755);
    const dest = path.join(work, 'dest');
    await copyTree(src, dest, {
      transformContent: (content) => content.replace('TOKEN', 'ok'),
    });
    const mode = (await stat(path.join(dest, 'run.sh'))).mode & 0o777;
    expect(mode & 0o111, `mode was 0o${mode.toString(8)}`).not.toBe(0);
    expect(await readFile(path.join(dest, 'run.sh'), 'utf8')).toContain('echo ok');
  });

  it('applies the name transform to files and directories', async () => {
    const src = await makeSrc({ '__NAME__/file-__NAME__.txt': 'x' });
    const dest = path.join(work, 'dest');
    await copyTree(src, dest, {
      transformName: (name) => name.replaceAll('__NAME__', 'app'),
    });
    expect(await readFile(path.join(dest, 'app/file-app.txt'), 'utf8')).toBe('x');
  });
});
