/**
 * The rootFileFolders entries of project.c3proj: script files and imported
 * Project Files. Both use the same nested folder shape ({ items, subfolders,
 * name }); the metadata key differs: scripts carry `script-info`, imported
 * files `file-info`. These helpers edit a parsed project.c3proj in memory;
 * the tools write it through the project writer.
 */

import type { Construct3Project, FileFolder, FileFolderSubfolder, FileItem, RootFileFolders } from './types.js';
import { findFolderPathClash, findNameClash } from './names.js';

/** The rootFileFolders families the file tools register in. */
export type RegisteredFileFolder = 'script' | 'general' | 'sound' | 'music' | 'video' | 'font';

/** Metadata key of an entry: scripts use `script-info`, every other family `file-info`. */
export type FileInfoKey = 'script-info' | 'file-info';

/** Directory (relative to the project root) each family keeps its files in, for a project saved as a folder. */
export const FILE_FOLDER_DIRECTORIES: Record<RegisteredFileFolder, string> = {
  script: 'scripts',
  general: 'files',
  sound: 'sounds',
  music: 'music',
  video: 'videos',
  font: 'fonts',
};

/** Directory (relative to the project root) that holds a family's files. */
export function getFileFolderDirectory(folder: RegisteredFileFolder): string {
  return FILE_FOLDER_DIRECTORIES[folder];
}

/** An entry with the folder that holds it, the folder's slash path and its position. */
export interface FileEntryLocation {
  entry: FileItem;
  folder: FileFolder | FileFolderSubfolder;
  subfolder?: string;
  index: number;
}

/** A folder's entries; [] when the file lacks the array. */
function itemsOf(folder: FileFolder | FileFolderSubfolder): FileItem[] {
  return Array.isArray(folder.items) ? folder.items : [];
}

/** A folder's subfolders; [] when the file lacks the array. */
function subfoldersOf(folder: FileFolder | FileFolderSubfolder): FileFolderSubfolder[] {
  return Array.isArray(folder.subfolders) ? folder.subfolders : [];
}

/** The family's root folder as the file holds it, or undefined (also when the project has no rootFileFolders). */
function rootOf(project: Construct3Project, folderName: RegisteredFileFolder): FileFolder | undefined {
  const roots = project.rootFileFolders as Partial<RootFileFolders> | undefined;
  const root = roots?.[folderName];
  return root && typeof root === 'object' && !Array.isArray(root) ? root : undefined;
}

/**
 * The family's root folder, created empty when the project has none. A root
 * that lacks one of its arrays gets an empty one and keeps its entries.
 */
export function ensureRootFileFolder(project: Construct3Project, folderName: RegisteredFileFolder): FileFolder {
  const existing = rootOf(project, folderName);
  if (existing) {
    if (!Array.isArray(existing.items)) existing.items = [];
    if (!Array.isArray(existing.subfolders)) existing.subfolders = [];
    return existing;
  }
  if (!project.rootFileFolders || typeof project.rootFileFolders !== 'object') {
    project.rootFileFolders = {} as RootFileFolders;
  }
  const created: FileFolder = { items: [], subfolders: [] };
  (project.rootFileFolders as Partial<RootFileFolders>)[folderName] = created;
  return created;
}

/** The nested folder addressed by a slash-separated path, or undefined. */
export function findFileSubfolder(folder: FileFolder, subfolder?: string): FileFolder | FileFolderSubfolder | undefined {
  if (!subfolder) return folder;
  let current: FileFolder | FileFolderSubfolder = folder;
  for (const part of subfolder.split('/')) {
    const next: FileFolderSubfolder | undefined = subfoldersOf(current).find(candidate => candidate.name === part);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/** The nested folder addressed by a slash-separated path, created with the editor's key order (items, subfolders, name). */
export function ensureFileSubfolder(folder: FileFolder, subfolder?: string): FileFolder | FileFolderSubfolder {
  if (!subfolder) return folder;
  let current: FileFolder | FileFolderSubfolder = folder;
  for (const part of subfolder.split('/')) {
    if (!Array.isArray(current.subfolders)) current.subfolders = [];
    let next: FileFolderSubfolder | undefined = current.subfolders.find(candidate => candidate.name === part);
    if (!next) {
      next = { items: [], subfolders: [], name: part };
      current.subfolders.push(next);
    }
    current = next;
  }
  if (!Array.isArray(current.items)) current.items = [];
  return current;
}

/** The entry with exactly this name in the folder, or undefined. */
export function findFileEntry(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  name: string,
  subfolder?: string,
): FileEntryLocation | undefined {
  const root = rootOf(project, folderName);
  if (!root) return undefined;
  const target = findFileSubfolder(root, subfolder);
  if (!target) return undefined;
  const items = itemsOf(target);
  const index = items.findIndex(item => item.name === name);
  return index === -1 ? undefined : { entry: items[index], folder: target, subfolder, index };
}

/** The registered spelling of a name in the folder that differs from `name` only in case, or undefined. */
export function findEntryNameClash(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  name: string,
  subfolder?: string,
): string | undefined {
  const root = rootOf(project, folderName);
  const target = root && findFileSubfolder(root, subfolder);
  if (!target) return undefined;
  const clash = findNameClash(name, itemsOf(target).map(item => item.name));
  return clash !== undefined && clash !== name ? clash : undefined;
}

/** The subfolder path spelled as the existing folders are when a folder of it differs from a sibling only in case, or undefined. */
export function findSubfolderClash(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  subfolder: string,
): string | undefined {
  const root = rootOf(project, folderName);
  return root ? findFolderPathClash(root, subfolder) : undefined;
}

/** What to register. */
export interface FileRegistration {
  name: string;
  type: string;
  infoKey: FileInfoKey;
  subfolder?: string;
  /** The purpose to record. Omitted: an existing entry keeps its purpose and a new one gets "none". */
  purpose?: string;
  /** SID for a new entry, taken before project.c3proj was read; unused when the entry exists. */
  sid?: number;
}

/** What applyRegistration did to the parsed project. */
export type RegistrationOutcome =
  | { kind: 'added'; sid: number }
  | { kind: 'unchanged'; sid: number }
  | { kind: 'repaired'; sid: number; repairs: string[] }
  | { kind: 'needs-sid' };

/**
 * Register an entry in the parsed project, or repair the existing one: the
 * metadata key of the family, the purpose when one is given, duplicate
 * registrations of the name in the folder (the first stays). An existing
 * entry keeps its SID and type. Without `sid` a new entry is not added.
 */
export function applyRegistration(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  registration: FileRegistration,
): RegistrationOutcome {
  const { name, type, infoKey, subfolder } = registration;
  const existing = findFileEntry(project, folderName, name, subfolder);
  if (!existing) {
    if (registration.sid === undefined) return { kind: 'needs-sid' };
    const target = ensureFileSubfolder(ensureRootFileFolder(project, folderName), subfolder);
    target.items.push({ name, type, sid: registration.sid, [infoKey]: { purpose: registration.purpose ?? 'none' } });
    return { kind: 'added', sid: registration.sid };
  }

  const item = existing.entry;
  const otherKey: FileInfoKey = infoKey === 'script-info' ? 'file-info' : 'script-info';
  // The purpose recorded under either key (an older registration holds it under the other one)
  const recorded = (item[infoKey] ?? item[otherKey])?.purpose;
  const purpose = registration.purpose ?? recorded ?? 'none';
  const repairs: string[] = [];
  if (item[otherKey] !== undefined) repairs.push(`metadata key ${otherKey} replaced by ${infoKey}`);
  else if (item[infoKey] === undefined) repairs.push(`${infoKey} added`);
  if (recorded !== undefined && recorded !== purpose) {
    repairs.push(`purpose changed from "${recorded}" to "${purpose}"`);
  }
  if (repairs.length > 0) {
    item[infoKey] = { purpose };
    delete item[otherKey];
  }
  const duplicates = existing.folder.items.filter(candidate => candidate.name === name).length - 1;
  if (duplicates > 0) {
    existing.folder.items = existing.folder.items.filter((candidate, index) => candidate.name !== name || index === existing.index);
    repairs.push(`${duplicates} duplicate registration${duplicates === 1 ? '' : 's'} removed`);
  }
  return repairs.length === 0 ? { kind: 'unchanged', sid: item.sid } : { kind: 'repaired', sid: item.sid, repairs };
}

/** Remove every entry of the name from the folder (duplicates too). False when there was none. */
export function removeFileEntry(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
  name: string,
  subfolder?: string,
): boolean {
  const location = findFileEntry(project, folderName, name, subfolder);
  if (!location) return false;
  location.folder.items = location.folder.items.filter(item => item.name !== name);
  return true;
}

/** Every entry of a family with the slash-separated subfolder that holds it (undefined: the family's root). */
export function listFileEntries(
  project: Construct3Project,
  folderName: RegisteredFileFolder,
): Array<{ entry: FileItem; subfolder?: string }> {
  const root = rootOf(project, folderName);
  if (!root) return [];
  const collected: Array<{ entry: FileItem; subfolder?: string }> = [];
  /** Collect the folder's entries, then those of its subfolders, with their slash paths. */
  const walk = (folder: FileFolder | FileFolderSubfolder, path: string | undefined): void => {
    for (const entry of itemsOf(folder)) collected.push({ entry, subfolder: path });
    for (const child of subfoldersOf(folder)) walk(child, path ? `${path}/${child.name}` : child.name);
  };
  walk(root, undefined);
  return collected;
}

/** The purpose recorded on an entry: `script-info`, else `file-info` (an older registration); "none" when it has none. */
export function entryPurpose(entry: FileItem): string {
  return (entry['script-info'] ?? entry['file-info'])?.purpose ?? 'none';
}

/** What applyMainScript did: the entries it changed ("path -> purpose"), or that the script is not registered. */
export type MainScriptOutcome = { changed: string[] } | { missing: true };

/**
 * Make one registered script the main script: it gets purpose "main" and
 * every other script that had "main" gets "none". Other purposes stay.
 */
export function applyMainScript(project: Construct3Project, name: string, subfolder?: string): MainScriptOutcome {
  const scripts = listFileEntries(project, 'script');
  const target = scripts.find(located => located.entry.name === name && located.subfolder === subfolder);
  if (!target) return { missing: true };
  const changed: string[] = [];
  for (const located of scripts) {
    const current = entryPurpose(located.entry);
    const desired = located === target ? 'main' : current === 'main' ? 'none' : current;
    if (desired === current) continue;
    located.entry['script-info'] = { purpose: desired };
    delete located.entry['file-info'];
    changed.push(`${located.subfolder ? `${located.subfolder}/` : ''}${located.entry.name} -> ${desired}`);
  }
  return { changed };
}
