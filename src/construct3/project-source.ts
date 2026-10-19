/**
 * Where the server finds its project: a folder or a .c3proj file is used as
 * it is; a .c3p archive is opened through a working folder (c3p-archive.ts),
 * whose project file the server then loads.
 */

import { C3pArchive, isC3pPath, type C3pArchiveOptions } from './c3p-archive.js';

/** The project path to load, and the archive it came from when it is a .c3p. */
export async function openProjectSource(path: string, options?: C3pArchiveOptions): Promise<{ projectPath: string; archive?: C3pArchive }> {
  if (!isC3pPath(path)) return { projectPath: path };
  const archive = await C3pArchive.open(path, options);
  return { projectPath: archive.projectFile, archive };
}

/**
 * Open the project source and run the whole server start on it (`start`:
 * loading, registration, connecting the transport). When any of it fails
 * after a .c3p was unpacked, the archive is closed (its working folder
 * removed: no call has run, so nothing was changed) before the error is
 * thrown on.
 */
export async function startC3pSession<T>(
  path: string, start: (projectPath: string, archive: C3pArchive | undefined) => Promise<T>, options?: C3pArchiveOptions,
): Promise<T> {
  const source = await openProjectSource(path, options);
  try {
    return await start(source.projectPath, source.archive);
  } catch (error) {
    await source.archive?.close();
    throw error;
  }
}
