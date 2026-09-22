/**
 * The files that make up a folder-format project on disk: what pack_project
 * packs and what a .c3p working folder writes back.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Directories to skip when packing a C3 project. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.bak', '__MACOSX']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Recursively collect all files in a directory, returning paths relative
 * to the root. Skips .git, node_modules, backups, and OS junk.
 */
export async function collectProjectFiles(rootDir: string, subDir = ''): Promise<string[]> {
  const results: string[] = [];
  const fullDir = subDir ? join(rootDir, subDir) : rootDir;
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_FILES.has(entry.name)) continue;
    const relPath = subDir ? `${subDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const subFiles = await collectProjectFiles(rootDir, relPath);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      // Skip .bak files from the writer's backup system
      if (entry.name.endsWith('.bak')) continue;
      results.push(relPath);
    }
  }

  return results;
}
