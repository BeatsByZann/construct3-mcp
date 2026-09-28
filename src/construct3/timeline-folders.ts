/**
 * The editor's Transitions folder in the project.c3proj timelines container.
 *
 * Construct 3 writes the timelines container with one first-level subfolder
 * that has no "name" key: its Transitions folder. It is often empty; its items
 * are transitions (easing curves that timelines reference by name), stored in
 * timelines/transitions/<name>.json. Checked against editor-saved projects.
 * Shared by the timeline tools and validate_project.
 */

/** Folder on disk, below timelines/, that holds the editor's transitions. */
export const TRANSITIONS_DIR = 'transitions';

/** A project-bar folder node as found in project.c3proj (fields unchecked). */
export type ProjectFolderNode = { name?: unknown; items?: unknown; subfolders?: unknown };

/** True when a project-bar folder has no usable name (missing or empty). */
export function isNamelessFolder(folder: ProjectFolderNode): boolean {
  return typeof folder.name !== 'string' || folder.name === '';
}

/**
 * Index of the Transitions folder among the first-level subfolders of the
 * timelines container: the first one without a name, or -1. A second nameless
 * first-level folder, or a nameless folder nested deeper, is not the
 * Transitions folder but a malformed entry.
 */
export function transitionsFolderIndex(timelines: ProjectFolderNode | undefined): number {
  if (!timelines || !Array.isArray(timelines.subfolders)) return -1;
  return (timelines.subfolders as unknown[]).findIndex(
    sf => typeof sf === 'object' && sf !== null && isNamelessFolder(sf as ProjectFolderNode)
  );
}

/** The Transitions folder as the ease tools use it: registered ease names and (unused) subfolders. */
export type TransitionsFolder = { name?: string; items: string[]; subfolders: unknown[] };

/**
 * The Transitions folder of a timelines container (see transitionsFolderIndex),
 * wherever it sits among the first-level subfolders; undefined when there is
 * none or it has no `items` array.
 */
export function transitionsFolder(timelines: ProjectFolderNode | undefined): TransitionsFolder | undefined {
  const index = transitionsFolderIndex(timelines);
  if (index < 0) return undefined;
  const folder = (timelines!.subfolders as unknown[])[index] as TransitionsFolder;
  return Array.isArray(folder.items) ? folder : undefined;
}

/**
 * The Transitions folder, created at index 0 (where the editor writes it) when
 * the container has none. A nameless folder without an `items` array is
 * completed rather than followed by a second nameless folder.
 */
export function ensureTransitionsFolder(container: { items: string[]; subfolders: unknown[] }): TransitionsFolder {
  const index = transitionsFolderIndex(container);
  if (index >= 0) {
    const folder = container.subfolders[index] as TransitionsFolder;
    if (!Array.isArray(folder.items)) folder.items = [];
    return folder;
  }
  const created: TransitionsFolder = { items: [], subfolders: [] };
  container.subfolders.unshift(created);
  return created;
}
