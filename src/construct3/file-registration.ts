/**
 * Shared helpers for Construct 3 rootFileFolders entries.
 *
 * C3 uses the same nested folder shape for scripts and imported Project Files,
 * but the metadata key differs: scripts use `script-info`, while imported
 * files use `file-info`.
 */

import type { Construct3Project, FileFolder, FileFolderSubfolder, FileItem, RootFileFolders } from './types.js';

export type RegisteredFileFolder = 'script' | 'general' | 'sound' | 'music' | 'video' | 'font';
export type FileInfoKey = 'script-info' | 'file-info';

export interface FileRegistrationEntry {
  name: string;
  type: string;
  sid: number;
  purpose: string;
}

export interface FileEntryLocation {
  entry: FileItem;
  folder: FileFolder | FileFolderSubfolder;
  subfolder?: string;
  index: number;
}

/** Return a root file folder, creating a valid empty folder when necessary. */
export function ensureRootFileFolder(project: Construct3Project, folderName: RegisteredFileFolder): FileFolder {
  const rootFolders = project.rootFileFolders as RootFileFolders & Partial<Record<RegisteredFileFolder, FileFolder>>;
  const existing = rootFolders[folderName];
  if (existing && Array.isArray(existing.items) && Array.isArray(existing.subfolders)) {
    return existing;
  }
  const created: FileFolder = { items: [], subfolders: [] };
  rootFolders[folderName] = created;
  return created;
}

/** Find the exact nested folder addressed by a slash-separated subfolder path. */
export function findFileSubfolder(folder: FileFolder, subfolder?: string): FileFolder | FileFolderSubfolder | undefined {
  if (!subfolder) return folder;
  let current: FileFolder | FileFolderSubfolder = folder;
  for (const part of subfolder.split('/')) {
    const next: FileFolderSubfolder | undefined = current.subfolders.find(candidate => candidate.name === part);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/** Find an entry by exact folder path and file name. */
export function findFileEntry(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  name: string,
  subfolder?: string,
): FileEntryLocation | undefined {
  const root = (project.rootFileFolders as Partial<RootFileFolders>)[folderName];
  if (!root) return undefined;
  const target = findFileSubfolder(root, subfolder);
  if (!target) return undefined;
  const index = target.items.findIndex(item => item.name === name);
  return index === -1 ? undefined : { entry: target.items[index], folder: target, subfolder, index };
}

/** Create a nested folder path, preserving C3's folder object shape. */
export function ensureFileSubfolder(folder: FileFolder, subfolder?: string): FileFolder | FileFolderSubfolder {
  if (!subfolder) return folder;
  let current: FileFolder | FileFolderSubfolder = folder;
  for (const part of subfolder.split('/')) {
    let next: FileFolderSubfolder | undefined = current.subfolders.find(candidate => candidate.name === part);
    if (!next) {
      next = { items: [], subfolders: [], name: part };
      current.subfolders.push(next);
    }
    current = next;
  }
  return current;
}

/** Add an entry if absent, returning false when the path was already registered. */
export function addFileEntry(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  registration: FileRegistrationEntry,
  infoKey: FileInfoKey,
  subfolder?: string,
): boolean {
  const root = ensureRootFileFolder(project, folderName);
  const target = ensureFileSubfolder(root, subfolder);
  if (target.items.some(item => item.name === registration.name)) return false;
  target.items.push({
    name: registration.name,
    type: registration.type,
    sid: registration.sid,
    [infoKey]: { purpose: registration.purpose },
  });
  return true;
}

/** Remove an entry if present, returning false when nothing matched. */
export function removeFileEntry(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  name: string,
  subfolder?: string,
): boolean {
  const location = findFileEntry(project, folderName, name, subfolder);
  if (!location) return false;
  // A repair should clean up duplicate registrations at the same path too.
  location.folder.items = location.folder.items.filter(item => item.name !== name);
  return true;
}
