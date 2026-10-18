/**
 * The rollback of a tool call whose write failed. The file whose write
 * failed is put back by restoreFailedWrite, which does so only while the
 * file holds that write's own text, the backup's content, or nothing, and
 * only when its .bak is the one this call made (checked here before and
 * after the restore); the files the call wrote before are put back by
 * undoToolCall, which leaves a file changed on disk since the call wrote
 * it. A file left as it is is named with its .bak. The message says what is
 * on disk, and says "Nothing was changed." only when that was checked.
 *
 * For calls whose writes are entity files (writeEntityFile) and
 * project.c3proj (updateProject): only those record the call's changes for
 * undoToolCall. A project.c3proj update that fails while replacing the file
 * is not recorded by the writer (the atomicReplace EEXIST fallback, which
 * may remove the file first, is a writer defect of its own): the caller
 * names that file in `writing`, and the message says what it holds. Writes
 * through replaceFile or deleteFile, and image writes, are not undone here,
 * and a message for such a call would not mention them.
 */

import { readFile } from 'fs/promises';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import type { EntityCategory } from '../construct3/project-reader.js';
import { EntityWriteError, failedWriteLeftReason, filesLeftClause } from '../construct3/project-writer.js';
import { StaleFileError, currentToolCall, fileKey, sameFileState, statFileState, type CallBackup } from '../construct3/disk-state.js';

/** This call's backup of `filePath` when it still holds what the call put there; undefined otherwise. */
async function ownBackup(filePath: string): Promise<CallBackup | undefined> {
  const record = currentToolCall()?.backups.get(fileKey(filePath));
  if (record === undefined || !record.existed) return undefined;
  return sameFileState(await statFileState(record.path), record.state) ? record : undefined;
}

/** Whether the file holds exactly the bytes of `backupPath` (false when either cannot be read). */
async function holdsBackup(filePath: string, backupPath: string): Promise<boolean> {
  try {
    return (await readFile(filePath)).equals(await readFile(backupPath));
  } catch {
    return false;
  }
}

/**
 * Roll back the running tool call after `error` and return the error
 * message for the tool result. `error` is what a write of the writer threw
 * (EntityWriteError: the write may have replaced the file), or any other
 * error of a step after earlier writes. A StaleFileError comes back as the
 * writer worded it: the writer has already undone the call's earlier writes
 * and said so. `options.writing`: the absolute path of a file other than an
 * entity file whose writer update was running when `error` came
 * (project.c3proj for updateProject); when undoToolCall does not report
 * it, its state is read here. Call it outside the writer's locks, inside
 * the tool call.
 */
export async function rollBackFailedCall(
  writer: Pick<Construct3ProjectWriter, 'restoreFailedWrite' | 'undoToolCall' | 'projectRelative'>,
  error: unknown,
  options: { writing?: string } = {},
): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StaleFileError) return message;
  // A refusal of the writer ends with a full stop already
  const cause = message.replace(/\.$/, '');
  const putBack: string[] = [];
  const left: string[] = [];
  if (error instanceof EntityWriteError) {
    const filePath = error.backupPath.slice(0, -'.bak'.length);
    const label = writer.projectRelative(filePath);
    const bak = `${label}.bak`;
    const record = currentToolCall()?.backups.get(fileKey(filePath));
    if (record !== undefined && !record.existed) {
      // A new file: a .bak beside it is not this call's (an earlier call's, say), so it is never restored from
      if ((await statFileState(filePath)) !== null) {
        left.push(`${label} (it did not exist before the call; it now holds what this call's failed write left there)`);
      }
    } else if ((await ownBackup(filePath)) === undefined) {
      left.push(`${label} (${bak} is no longer the copy this call made before its write, `
        + 'so it is not known to hold the state from before the call)');
    } else {
      try {
        const { restored, reason } = await writer.restoreFailedWrite(error);
        // Checked again: another call may have replaced the .bak while the restore waited for the file's lock
        if (restored && (await ownBackup(filePath)) !== undefined) putBack.push(label);
        else if (restored) left.push(`${label} (it was put back from ${bak}, but ${bak} was replaced meanwhile, so what it holds is not known)`);
        else left.push(`${label} (${failedWriteLeftReason(reason)}; its state from before the call is in ${bak})`);
      } catch {
        left.push(`${label} (it could not be put back; its state from before the call is in ${bak})`);
      }
    }
  }
  const undo = await writer.undoToolCall();
  putBack.push(...undo.restored);
  if (options.writing !== undefined) {
    const label = writer.projectRelative(options.writing);
    const reported = [...undo.restored, ...undo.left.map(entry => entry.label)].some(entry => entry.startsWith(label));
    const record = currentToolCall()?.backups.get(fileKey(options.writing));
    if (!reported && record?.existed) {
      // The writer threw before it recorded the change: say what the file holds
      const backup = await ownBackup(options.writing);
      const bak = writer.projectRelative(record.path);
      if ((await statFileState(options.writing)) === null) {
        left.push(`${label} (it is missing: its replacement failed after the old file was removed, and the server could not put it back; `
          + (backup ? `its state from before the call is in ${bak}` : `${bak} is no longer the copy this call made`) + ')');
      } else if (!(backup !== undefined && await holdsBackup(options.writing, backup.path))) {
        left.push(`${label} (its update failed before the server recorded it, so whether it holds this call's change is not known; `
          + (backup ? `its state from before the call is in ${bak}` : `${bak} is no longer the copy this call made`) + ')');
      }
      // Else it holds this call's own copy of its state from before the call: unchanged, checked
    }
  }
  if (left.length === 0 && undo.left.length === 0) {
    if (putBack.length === 0) return `${cause}. Nothing was changed.`;
    return `${cause}. The call was rolled back: ${putBack.join(', ')} ${putBack.length === 1 ? 'is' : 'are'} as before the call.`;
  }
  const parts = [
    ...(putBack.length > 0 ? [`put back as they were before the call: ${putBack.join(', ')}`] : []),
    ...(undo.left.length > 0 ? [filesLeftClause(undo.left)] : []),
    ...(left.length > 0 ? [`left as it is: ${left.join(', ')}`] : []),
  ];
  return `${cause}. The call was rolled back only in part: ${parts.join('; ')}. ` +
    'Check the project (validate_project, git diff) before you run the tool again.';
}

/**
 * Write an entity file for a tool through writer.writeEntityFile (in its
 * subfolder); when the write fails, roll the call back (rollBackFailedCall)
 * and throw an Error with that message. Returns the backup path.
 */
export async function writeEntityOrRollBack(
  writer: Pick<Construct3ProjectWriter, 'writeEntityFile' | 'getSubfolderForEntity' | 'restoreFailedWrite' | 'undoToolCall' | 'projectRelative'>,
  category: EntityCategory, name: string, data: unknown,
): Promise<string> {
  try {
    return await writer.writeEntityFile(category, name, data, writer.getSubfolderForEntity(category, name));
  } catch (error) {
    throw new Error(await rollBackFailedCall(writer, error));
  }
}
