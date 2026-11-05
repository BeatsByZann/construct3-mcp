/**
 * The script files a project registers (rootFileFolders.script), with their
 * paths inside its scripts/ folder: the one walk the index, the runtime-trap
 * check and the usage queries share.
 */
import type { FileFolder, FileFolderSubfolder, FileItem } from './types.js';

const MAX_DEPTH = 50;

/**
 * Registered script files, e.g. `importsForEvents.js` and `lib/b.js`, in
 * file order; `notWalked` names the folders below the depth limit that
 * were not entered, so their files are missing from `files`.
 */
export function registeredScriptFiles(folder: FileFolder | undefined): { files: Array<{ path: string; item: FileItem }>; notWalked: string[] } {
  const files: Array<{ path: string; item: FileItem }> = [];
  const notWalked: string[] = [];
  const walk = (f: FileFolder | FileFolderSubfolder, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      notWalked.push(`scripts/${prefix}`);
      return;
    }
    for (const item of Array.isArray(f.items) ? f.items : []) {
      if (item && typeof item.name === 'string' && item.name !== '') files.push({ path: prefix + item.name, item });
    }
    for (const sub of Array.isArray(f.subfolders) ? f.subfolders : []) {
      if (sub && typeof sub.name === 'string') walk(sub, `${prefix}${sub.name}/`, depth + 1);
    }
  };
  if (folder) walk(folder, '', 0);
  return { files, notWalked };
}
