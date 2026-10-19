/**
 * The files that make up a folder project on disk: what pack_project packs
 * and what a single-file project's write-back packs from its working
 * folder (c3p-archive.ts). Leaves out version control and package folders,
 * the writer's .bak backups and the operating system's own files.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Directories to skip when packing a C3 project. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.bak', '__MACOSX']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** Whether a file at `relPath` (forward slashes) is packed as part of the project. */
export function isPackedProjectFile(relPath: string): boolean {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some(part => SKIP_DIRS.has(part))) return false;
  // The writer's backups stay out of the archive
  return !SKIP_FILES.has(name) && !name.endsWith('.bak');
}

/** Every file below `rootDir` that is packed (isPackedProjectFile), as paths relative to it with forward slashes. */
export async function collectProjectFiles(rootDir: string, subDir = ''): Promise<string[]> {
  const results: string[] = [];
  const fullDir = subDir ? join(rootDir, subDir) : rootDir;
  const entries = await readdir(fullDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_FILES.has(entry.name)) continue;
    const relPath = subDir ? `${subDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...await collectProjectFiles(rootDir, relPath));
    } else if (entry.isFile() && isPackedProjectFile(relPath)) {
      results.push(relPath);
    }
  }
  return results;
}
