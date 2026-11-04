/**
 * The files a project registers in `rootFileFolders` (scripts, sounds,
 * music), read only: what the timeline tools need to find an audio file
 * for an audio track and the scripts to search for an ease name.
 */

import type { Construct3Project, FileFolder, FileFolderSubfolder, FileItem } from './types.js';

/** The `rootFileFolders` families this module reads. */
export type RegisteredFamily = 'script' | 'sound' | 'music';

/** Every entry of a family, with the slash-separated subfolder that holds it (undefined at the root). */
export function listRegisteredFileEntries(
  project: Construct3Project,
  family: RegisteredFamily,
): Array<{ entry: FileItem; subfolder?: string }> {
  const root = (project.rootFileFolders as unknown as Partial<Record<RegisteredFamily, FileFolder>> | undefined)?.[family];
  if (!root) return [];
  const collected: Array<{ entry: FileItem; subfolder?: string }> = [];
  /** Collect a folder's items, then those of its subfolders with their joined path. */
  const walk = (folder: FileFolder | FileFolderSubfolder, path: string | undefined): void => {
    for (const entry of folder.items ?? []) collected.push({ entry, subfolder: path });
    for (const child of folder.subfolders ?? []) walk(child, path ? `${path}/${child.name}` : child.name);
  };
  walk(root, undefined);
  return collected;
}
