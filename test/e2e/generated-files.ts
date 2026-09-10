import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const filesContaining = async (root: string, needle: string): Promise<string[]> => {
  const matches: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const directory = path.join(root, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.next') await walk(file);
      } else if (entry.isFile() && (await readFile(path.join(root, file))).includes(needle)) {
        matches.push(file);
      }
    }
  };
  await walk('');
  return matches.sort();
};
