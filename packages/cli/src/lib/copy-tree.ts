import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Entry names never copied out of a template (local artifacts, never payload). */
export const DEFAULT_IGNORE = [
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'cdk.out',
  '.turbo',
  '.DS_Store',
  // packaging metadata of the template itself, meaningless in a generated project
  '.npmignore',
  'var',
  // frontend build artifacts of in-place template runs
  '.next',
  'out',
  'next-env.d.ts',
  // the init-manifest of the universal layer — tooling metadata, not payload
  'layers.json',
];

export interface CopyTreeOptions {
  /** Entry names to skip at any depth. Defaults to {@link DEFAULT_IGNORE}. */
  ignore?: readonly string[];
  /** Applied to the content of every text file. Binary files are copied untouched. */
  transformContent?: (content: string, relPath: string) => string;
  /** Applied to every file and directory name. */
  transformName?: (name: string) => string;
}

/** A file is treated as binary if its first bytes contain a NUL byte. */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export async function copyTree(
  srcDir: string,
  destDir: string,
  options: CopyTreeOptions = {},
): Promise<void> {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
  const files: CopyFileTask[] = [];
  await mkdir(destDir, { recursive: true });
  await collectCopyTasks(srcDir, destDir, '', { ...options, ignore }, files);
  await mapConcurrent(files, 16, ({ srcPath, destPath, relPath }) =>
    copyFileEntry(srcPath, destPath, relPath, { ...options, ignore }),
  );
}

/** Run independent async work through a bounded pool while preserving result order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('concurrency limit must be positive');
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const run = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  if (failed) throw firstError;
  return results;
}

/** One file {@link copyTree} would produce, and the template file behind it. */
export interface TreeEntry {
  /** Destination-relative path, always `/`-separated. */
  rel: string;
  /** Absolute path of the source file. */
  source: string;
}

/**
 * The destination-relative file paths {@link copyTree} would produce — same
 * ignore list, same name transform, no writes. Used to check layer
 * composition for collisions before anything is copied.
 */
export async function listTree(
  srcDir: string,
  options: Pick<CopyTreeOptions, 'ignore' | 'transformName'> = {},
): Promise<string[]> {
  return (await listTreeEntries(srcDir, options)).map((entry) => entry.rel);
}

/**
 * {@link listTree} with the source path kept alongside each destination — what
 * an upgrade needs to read the new version of a file, and to name where it
 * lives when it must not write it.
 */
export async function listTreeEntries(
  srcDir: string,
  options: Pick<CopyTreeOptions, 'ignore' | 'transformName'> = {},
): Promise<TreeEntry[]> {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
  const files: TreeEntry[] = [];
  const walk = async (dir: string, relDir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const destName = options.transformName ? options.transformName(entry.name) : entry.name;
      const relPath = relDir === '' ? destName : `${relDir}/${destName}`;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        files.push({ rel: relPath, source: path.join(dir, entry.name) });
      }
    }
  };
  await walk(srcDir, '');
  return files;
}

interface ResolvedOptions extends Omit<CopyTreeOptions, 'ignore'> {
  ignore: Set<string>;
}

interface CopyFileTask {
  srcPath: string;
  destPath: string;
  relPath: string;
}

async function collectCopyTasks(
  srcDir: string,
  destDir: string,
  relDir: string,
  options: ResolvedOptions,
  files: CopyFileTask[],
): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (options.ignore.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destName = options.transformName ? options.transformName(entry.name) : entry.name;
    const destPath = path.join(destDir, destName);
    const relPath = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await collectCopyTasks(srcPath, destPath, relPath, options, files);
    } else if (entry.isFile()) {
      files.push({ srcPath, destPath, relPath });
    }
    // Symlinks and other special entries are intentionally not copied:
    // templates are plain trees.
  }
}

async function copyFileEntry(
  srcPath: string,
  destPath: string,
  relPath: string,
  options: ResolvedOptions,
): Promise<void> {
  if (!options.transformContent) {
    await copyFile(srcPath, destPath); // copyFile preserves the mode by itself
    return;
  }
  const [buffer, { mode }] = await Promise.all([readFile(srcPath), stat(srcPath)]);
  if (isBinary(buffer)) {
    await writeFile(destPath, buffer);
  } else {
    await writeFile(destPath, options.transformContent(buffer.toString('utf8'), relPath));
  }
  // writeFile does NOT preserve permissions — restore them (chmod ignores umask),
  // otherwise executable template files (scripts, hooks) arrive non-executable.
  await chmod(destPath, mode & 0o777);
}
