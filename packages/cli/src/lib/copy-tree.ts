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
  await mkdir(destDir, { recursive: true });
  await copyDir(srcDir, destDir, '', { ...options, ignore });
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

async function copyDir(
  srcDir: string,
  destDir: string,
  relDir: string,
  options: ResolvedOptions,
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
      await copyDir(srcPath, destPath, relPath, options);
    } else if (entry.isFile()) {
      await copyFileEntry(srcPath, destPath, relPath, options);
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
  const buffer = await readFile(srcPath);
  if (isBinary(buffer)) {
    await writeFile(destPath, buffer);
  } else {
    await writeFile(destPath, options.transformContent(buffer.toString('utf8'), relPath));
  }
  // writeFile does NOT preserve permissions — restore them (chmod ignores umask),
  // otherwise executable template files (scripts, hooks) arrive non-executable.
  const { mode } = await stat(srcPath);
  await chmod(destPath, mode & 0o777);
}
