import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { withoutGitLocation } from '../git-env.mjs';

const MAX_UNTRACKED_FILES = 1024;

const pathBytes = (path) => {
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.toString('utf8') !== path || path.includes('\0')) throw new Error('Git path is not valid UTF-8');
  return bytes;
};

const encode = (bytes) => {
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return [size, bytes];
};

const parsePaths = (bytes) => {
  const paths = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new Error('Git path list contains an empty path');
    const path = bytes.subarray(start, index).toString('utf8');
    pathBytes(path);
    paths.push(path);
    start = index + 1;
  }
  if (start !== bytes.length) throw new Error('Git path list is not NUL-terminated');
  return paths;
};

const gitPaths = ({ projectRoot, args, maxBytes }) => {
  let bytes;
  try {
    bytes = execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'buffer',
      env: withoutGitLocation(),
      maxBuffer: maxBytes,
    });
  } catch {
    throw new Error('Git working-tree paths could not be read');
  }
  const paths = parsePaths(bytes);
  if (paths.length > MAX_UNTRACKED_FILES) throw new Error('Git working-tree path count exceeds the configured bound');
  return paths;
};

export const untrackedPaths = ({ projectRoot, paths = null, maxBytes }) =>
  gitPaths({
    projectRoot,
    args: ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(paths ?? [])],
    maxBytes,
  });

// Package-manager and test-runner caches are never repository source. They
// may appear during the check itself, after its implementation boundary was
// captured, so including them would make an otherwise unchanged GREEN stale.
export const isEphemeralUntrackedPath = (path) => path.startsWith('node_modules/');

const readWorkingTreeFile = ({ projectRoot, path, maxBytes }) => {
  const root = lstatSync(projectRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('project root is unsafe');
  const parts = path.split('/');
  let current = projectRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const directory = lstatSync(current);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('untracked path has a symlink ancestor');
  }
  const file = join(projectRoot, path);
  const declared = lstatSync(file);
  if (!declared.isFile() || declared.isSymbolicLink() || declared.size > maxBytes) {
    throw new Error('untracked file is unsafe or exceeds the working-tree bound');
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== declared.dev || opened.ino !== declared.ino) {
      throw new Error('untracked file changed during validation');
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new Error('untracked file exceeds the working-tree bound');
      chunks.push(chunk.subarray(0, read));
    }
    const finished = lstatSync(file);
    if (
      finished.isSymbolicLink() ||
      !finished.isFile() ||
      finished.dev !== declared.dev ||
      finished.ino !== declared.ino
    ) {
      throw new Error('untracked file changed during validation');
    }
    return { bytes: Buffer.concat(chunks, total), mode: declared.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
};

/** Canonical bounded state for tracked changes plus untracked regular files. */
export const workingTreeState = ({ projectRoot, gitRef, paths = null, maxBytes }) => {
  let diff;
  try {
    diff = execFileSync(
      'git',
      ['-C', projectRoot, 'diff', '--binary', '--no-ext-diff', '--no-textconv', gitRef, '--', ...(paths ?? [])],
      { encoding: 'buffer', env: withoutGitLocation(), maxBuffer: maxBytes },
    );
  } catch {
    throw new Error('Git working-tree diff could not be read');
  }
  const chunks = [Buffer.from('rig-working-tree-state/v1\0')];
  let total = chunks[0].length;
  const append = (bytes) => {
    const encoded = encode(bytes);
    const next = total + encoded[0].length + encoded[1].length;
    if (next > maxBytes) throw new Error('working-tree state exceeds the configured bound');
    chunks.push(...encoded);
    total = next;
  };
  append(diff);
  const listed = untrackedPaths({ projectRoot, paths, maxBytes }).filter(
    (path) => !isEphemeralUntrackedPath(path),
  );
  for (const path of listed) {
    if (
      path.length > 4096 ||
      path.startsWith('/') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error('Git working-tree path is unsafe');
    }
    append(pathBytes(path));
    const remaining = maxBytes - total - 8;
    if (remaining < 0) throw new Error('working-tree state exceeds the configured bound');
    append(readWorkingTreeFile({ projectRoot, path, maxBytes: remaining }).bytes);
  }
  return Buffer.concat(chunks, total);
};

/**
 * Canonical state of selected working-tree paths. Unlike a Git patch, this
 * remains the same when an untracked file is staged or committed unchanged.
 */
export const workingTreePathState = ({ projectRoot, paths, maxBytes }) => {
  const selected = [...new Set(paths)].sort();
  const chunks = [Buffer.from('rig-working-tree-path-state/v1\0')];
  let total = chunks[0].length;
  const append = (bytes) => {
    const encoded = encode(bytes);
    const next = total + encoded[0].length + encoded[1].length;
    if (next > maxBytes) throw new Error('working-tree state exceeds the configured bound');
    chunks.push(...encoded);
    total = next;
  };
  for (const path of selected) {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > 4096 ||
      path.startsWith('/') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error('Git working-tree path is unsafe');
    }
    append(pathBytes(path));
    let current;
    try {
      current = readWorkingTreeFile({ projectRoot, path, maxBytes: maxBytes - total - 17 });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        append(Buffer.from('deleted'));
        continue;
      }
      throw error;
    }
    append(Buffer.from(`file:${current.mode.toString(8)}`));
    append(current.bytes);
  }
  return Buffer.concat(chunks, total);
};
