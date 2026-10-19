/**
 * The rollback of a Project Bar move or copy. The call writes entity files
 * and project.c3proj through the writer and creates other files (copies,
 * images, a brush file, a timeline) through createFileForCall. On failure,
 * project.c3proj and any existing entity file the call rewrote are put back
 * first; every created file (a copy's entity file among them) is removed
 * only once project.c3proj no longer registers what the call added, so the
 * project never names a file the rollback removed.
 */

import { rollBackFailedCall } from './call-rollback.js';
import { joinRollbackMessages, putBackSideWrites, reasonOf, type RenameSideWrites } from './rename-files.js';
import { StaleFileError } from '../construct3/disk-state.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';

type StructureWriter = Pick<Construct3ProjectWriter,
  'replaceFile' | 'deleteFile' | 'restoreForCall' | 'renameImageFiles' | 'restoreFailedWrite' | 'undoToolCall' | 'projectRelative'>;

/**
 * Roll back the running call after `error` and return the message for the
 * tool result. A StaleFileError the writer threw after undoing the call's
 * writes (`undone`) is passed on as it is; any other, such as a check of the
 * tool's own that a source changed, is rolled back as an ordinary error, as
 * rollBackRename does. `projectIsBack` reads project.c3proj from disk and
 * says whether it no longer registers what the call added; when it is not
 * back, or cannot be read, the created files are kept and named. It never
 * throws: a rollback that itself fails is reported as writes that could not
 * be undone, naming project.c3proj (`writing`) and the files `side` records
 * (project-relative), because the call did write before it failed.
 */
export async function rollBackStructureCall(
  writer: StructureWriter, error: unknown, side: RenameSideWrites,
  options: { writing?: string; projectIsBack: () => Promise<boolean> },
): Promise<string> {
  try {
    return await rollBack(writer, error, side, options);
  } catch (rollbackError) {
    const relative = (file: string) => writer.projectRelative(file);
    const paths = [...(options.writing === undefined ? [] : [options.writing]), ...side.files.map(f => f.path), ...side.unresolved.map(f => f.path)];
    return `${reasonOf(error, relative)}. The call's writes could not be undone (${reasonOf(rollbackError, relative)}), `
      + `so these files may be left as the call wrote them: ${[...new Set(paths.map(relative))].join(', ')}. `
      + 'Check the project (validate_project, git diff) before you run the tool again.';
  }
}

/** The rollback itself; rollBackStructureCall catches what it throws. */
async function rollBack(
  writer: StructureWriter, error: unknown, side: RenameSideWrites,
  options: { writing?: string; projectIsBack: () => Promise<boolean> },
): Promise<string> {
  const cause = error instanceof StaleFileError && !error.undone ? new Error(error.message, { cause: error }) : error;
  const core = await rollBackFailedCall(writer, cause, { writing: options.writing });
  let back: boolean;
  try {
    back = await options.projectIsBack();
  } catch {
    back = false;
  }
  if (back) return joinRollbackMessages(core, await putBackSideWrites(writer, side));
  const kept = [...side.files, ...side.unresolved].map(file =>
    `${writer.projectRelative(file.path)} (kept: project.c3proj still registers what this call added, so the file stays)`);
  return joinRollbackMessages(core, { putBack: [], left: kept });
}
