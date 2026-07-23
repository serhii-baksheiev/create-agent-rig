import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTree } from '../src/lib/copy-tree.js';

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

  it('applies the name transform to files and directories', async () => {
    const src = await makeSrc({ '__NAME__/file-__NAME__.txt': 'x' });
    const dest = path.join(work, 'dest');
    await copyTree(src, dest, {
      transformName: (name) => name.replaceAll('__NAME__', 'app'),
    });
    expect(await readFile(path.join(dest, 'app/file-app.txt'), 'utf8')).toBe('x');
  });
});
