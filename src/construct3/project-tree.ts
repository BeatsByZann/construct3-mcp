/**
 * Project Bar trees. project.c3proj stores each tree as `{ items, subfolders }`,
 * and a folder as `{ items, subfolders, name }`. Construct keeps the file path
 * in step with the folder, so a folder name is also a directory name. Item and
 * folder order is the user's own: a new folder is appended after its siblings.
 */

/** A Project Bar tree or folder. Entity trees hold names; file trees hold `{ name, ... }` items. */
export interface TreeFolder {
  items: unknown[];
  subfolders: TreeFolder[];
  name?: string;
}

/** One place a name is registered. */
export interface TreeLocation {
  folder: TreeFolder;
  index: number;
  /** Slash-separated folder path, '' for the tree root. */
  path: string;
}

/** The name an item registers: the string itself, or the `name` of a file item. */
export function itemName(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
    return (item as { name: string }).name;
  }
  return undefined;
}

/** Whether `value` has the `{ items, subfolders }` shape of a tree or folder. */
export function isTree(value: unknown): value is TreeFolder {
  return !!value && typeof value === 'object'
    && Array.isArray((value as TreeFolder).items)
    && Array.isArray((value as TreeFolder).subfolders);
}

/**
 * Every place `name` is registered. Subfolders without a string name are
 * skipped: the timelines tree's unnamed custom-ease folder is the only one
 * observed, and it is not a user folder.
 */
export function locateInTree(root: TreeFolder, name: string): TreeLocation[] {
  const out: TreeLocation[] = [];
  const walk = (folder: TreeFolder, path: string, depth: number) => {
    if (depth > 64) return;
    folder.items.forEach((item, index) => {
      if (itemName(item) === name) out.push({ folder, index, path });
    });
    for (const sub of folder.subfolders) {
      if (!isTree(sub) || typeof sub.name !== 'string') continue;
      walk(sub, path ? `${path}/${sub.name}` : sub.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

/** The subfolder whose name is exactly `part`, or undefined. */
function findSubfolder(folder: TreeFolder, part: string): TreeFolder | undefined {
  return folder.subfolders.find(sub => isTree(sub) && sub.name === part);
}

/** The folder at `path`, segments matched exactly, or undefined. */
export function findTreeFolder(root: TreeFolder, path: string): TreeFolder | undefined {
  if (!path) return root;
  let current: TreeFolder = root;
  for (const part of path.split('/')) {
    const next = findSubfolder(current, part);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;

/** Why a folder path cannot be a Project Bar folder path on Windows, or undefined when it can. */
export function folderSegmentsProblem(path: string): string | undefined {
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) return 'Subfolder path contains invalid characters (use forward slashes only, no "..")';
  for (const part of path.split('/')) {
    if (part.length === 0 || part === '.') return 'Subfolder path contains invalid segments';
    if (part.length > 255) return `Folder name "${part.slice(0, 20)}..." is too long (max 255 characters)`;
    if (WINDOWS_FORBIDDEN.test(part)) return `Folder name "${part}" contains a character Windows does not allow in folder names (< > : " | ? * or a control character)`;
    if (/[ .]$/.test(part) || /^ /.test(part)) return `Folder name "${part}" must not start with a space or end with a space or a dot`;
    if (WINDOWS_RESERVED.test(part)) return `Folder name "${part}" is reserved on Windows`;
  }
  return undefined;
}

/** Why `name` cannot be the name of a file item (the folder path is separate), or undefined when it can. */
export function fileNameProblem(name: string): string | undefined {
  if (!name || name.length === 0) return 'File name cannot be empty';
  if (name.length > 255) return 'File name too long (max 255 characters)';
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return 'File name must be a single path segment';
  }
  return undefined;
}

/** The folder at `path`, created with Construct's `{ items, subfolders, name }` key order where missing. */
export function ensureTreeFolder(root: TreeFolder, path: string): { folder: TreeFolder; created: string[] } {
  const created: string[] = [];
  if (!path) return { folder: root, created };
  let current: TreeFolder = root;
  let walked = '';
  for (const part of path.split('/')) {
    walked = walked ? `${walked}/${part}` : part;
    let next = findSubfolder(current, part);
    if (!next) {
      next = { items: [], subfolders: [], name: part };
      current.subfolders.push(next);
      created.push(walked);
    }
    current = next;
  }
  return { folder: current, created };
}

/** Every name registered in the tree, in tree order; unnamed subfolders only when `includeUnnamed`. */
export function allTreeNames(root: TreeFolder, includeUnnamed: boolean): string[] {
  const out: string[] = [];
  const walk = (folder: TreeFolder, depth: number) => {
    if (depth > 64) return;
    for (const item of folder.items) {
      const n = itemName(item);
      if (n !== undefined) out.push(n);
    }
    for (const sub of folder.subfolders) {
      if (!isTree(sub)) continue;
      if (typeof sub.name !== 'string' && !includeUnnamed) continue;
      walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** A folder path for a message: the quoted path, or 'the root'. */
export function describeFolder(path: string): string {
  return path ? `"${path}"` : 'the root';
}

/**
 * Register `name` directly after `source` in the folder where `source` is
 * registered (its first place). Throws when `source` is not registered.
 */
export function registerAfterInTree(root: TreeFolder, source: string, name: string): void {
  const found = locateInTree(root, source);
  if (found.length === 0) throw new Error(`"${source}" is no longer registered in project.c3proj`);
  const { folder, index } = found[0];
  folder.items.splice(index + 1, 0, name);
}
