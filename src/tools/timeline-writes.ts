/**
 * What the timeline tools share for writing and refusing: refusals that end
 * "Nothing was changed.", messages without absolute paths, a JSON file
 * written through the writer in the text style the project uses, and the
 * rollback of a call that wrote several files.
 */

import { mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';
import type { MutationToolDeps } from './shared.js';
import { toolError, validateName, validateSubfolder } from './shared.js';
import { EntityWriteError, failedWriteLeftReason, filesLeftClause } from '../construct3/project-writer.js';
import { fileKey, noteFileRead, statFileState, StaleFileError, type FileState } from '../construct3/disk-state.js';
import { existingSpelling } from '../construct3/atomic-write.js';
import { nameKey } from '../construct3/names.js';
import { resolveJsonTextStyle, serializeJson } from '../construct3/json-format.js';

type Writer = MutationToolDeps['writer'];

/** A refusal: the message ends once with "Nothing was changed.". */
export function refuse(message: string) {
  const core = message.replace(/\s*Nothing was changed\.\s*$/, '').trimEnd();
  return toolError(`${core}${/[.!?]$/.test(core) ? '' : '.'} Nothing was changed.`);
}

/** The text of the refusal `validateName` throws for `name`, or undefined for a good name. */
export function invalidName(name: string): string | undefined {
  try {
    validateName(name);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The text of the refusal `validateSubfolder` throws for `subfolder`, or undefined. */
export function invalidSubfolder(subfolder: string): string | undefined {
  try {
    validateSubfolder(subfolder);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Why a file could not be read, without its path: the error code, or the JSON parse text. */
export function readFailure(error: unknown): string {
  if (error instanceof SyntaxError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : 'unreadable';
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An error's message with the project folder taken off every path in it,
 * the rest of each such path written with `/`. A folder whose name only
 * starts with the project folder's name is left as it is.
 */
export function relativeMessage(error: unknown, projectDir: string): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const form of new Set([projectDir, projectDir.replace(/\\/g, '/'), projectDir.replace(/\//g, '\\')])) {
    // A path ends at a quote, a line end, a comma, a semicolon or a bracket (paths may hold spaces)
    const inside = new RegExp(`${escapeRegExp(form)}[\\\\/]([^'"\\r\\n,;()]*)`, 'g');
    message = message.replace(inside, (_match, rest: string) => rest.replace(/\\/g, '/'));
    message = message.replace(new RegExp(`${escapeRegExp(form)}(?![^\\s'"])`, 'g'), '.');
  }
  return message;
}

/** `Did you mean "X"?` when a registered name equals `requested` apart from its letter case. */
export function caseHint(requested: string, registered: readonly string[]): string | undefined {
  const same = registered.find(name => name !== requested && nameKey(name) === nameKey(requested));
  return same === undefined ? undefined : `Names are matched with their letter case. Did you mean "${same}"?`;
}

/** The text a JSON file is written with: an existing file keeps its text style, a new one follows the project's. */
export async function jsonFileText(filePath: string, data: unknown, projectPath: string): Promise<string> {
  const target = await existingSpelling(filePath);
  return serializeJson(data, await resolveJsonTextStyle(target, projectPath, dirname(target)));
}

/**
 * Read a file a call may write: its state is taken before the text (so the
 * text is never older than the state) and recorded in the call scope, as
 * the reader records what it reads. Pass `state` as `expected` to the
 * write, so a save made on disk in between is refused. Null for a missing
 * file. The text is raw (a BOM kept), so it can be put back byte for byte.
 */
export async function readFileForWrite(filePath: string): Promise<{ text: string; state: FileState } | null> {
  const target = await existingSpelling(filePath);
  const state = await statFileState(target);
  if (state === null) {
    noteFileRead(fileKey(target), null);
    return null;
  }
  const text = await readFile(target, 'utf-8');
  noteFileRead(fileKey(target), state);
  return { text, state };
}

/** A file's raw text, or null when it does not exist. */
export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(await existingSpelling(filePath), 'utf-8');
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write a JSON file through the writer (backed up once per call, written
 * through a temp file, read back), refused when `expected` is given and the
 * file is no longer in that state. The backup path, or undefined for a new file.
 */
export async function writeJsonFile(
  writer: Writer, filePath: string, data: unknown, projectPath: string, expected?: FileState,
): Promise<string | undefined> {
  await mkdir(dirname(filePath), { recursive: true });
  const target = await existingSpelling(filePath);
  return writer.replaceFile(target, await jsonFileText(target, data, projectPath), expected === undefined ? {} : { expected });
}

/** A file a call changed through replaceFile or deleteFile, and the text it held before (null: the call created it). */
export interface ChangedFile {
  path: string;
  before: string | null;
}

/**
 * Roll the running tool call back after `error`: the files the call
 * recorded before replacing, creating or deleting them (`changed`, in that
 * order) are put back unless they still hold their text from before the
 * call (a write that failed before it changed the file), the event sheet
 * whose own write failed is restored from its backup, and the writer
 * undoes the entity files and project.c3proj it recorded. A file that
 * changed on disk since the call wrote it is left and named; a file named
 * by the StaleFileError of its own write or delete is left without a
 * mention (the call never changed it). The message says what is on disk;
 * it says "Nothing was changed." only when no file holds this call's text,
 * and never after a writer refusal that has undone the call already
 * (StaleFileError.undone: its message says what it put back).
 */
export async function rollBackToolCall(
  writer: Writer, projectDir: string, error: unknown, changed: readonly ChangedFile[],
): Promise<string> {
  // A refusal of the writer ends with a full stop already
  const cause = relativeMessage(error, projectDir).replace(/\.$/, '');
  const undoneByWriter = error instanceof StaleFileError && error.undone;
  const putBack: string[] = [];
  const left: string[] = [];
  if (error instanceof EntityWriteError) {
    const label = writer.projectRelative(error.backupPath.replace(/\.bak$/, ''));
    if (error.changedByOtherWrite) {
      left.push(`${label} (another write replaced it during this one)`);
    } else {
      try {
        const { restored, reason } = await writer.restoreFailedWrite(error);
        if (restored) putBack.push(label);
        else left.push(`${label} (${failedWriteLeftReason(reason)}; its state from before the call is in ${label}.bak)`);
      } catch {
        left.push(`${label} (it could not be put back; its state from before the call is in ${label}.bak)`);
      }
    }
  }
  for (const file of [...changed].reverse()) {
    const label = writer.projectRelative(file.path);
    // The writer refused this file's own write or delete (it is not in the state the call read, or was created meanwhile): it holds another writer's version, which this call did not change
    if (error instanceof StaleFileError && error.file === label) continue;
    // Recorded before its write: a write that failed before it changed the file leaves nothing to put back
    if ((await readTextIfExists(file.path).catch(() => undefined)) === file.before) continue;
    try {
      await writer.restoreForCall(file.path, file.before);
      putBack.push(label);
    } catch (restoreError) {
      // restoreForCall's own refusals name the file and say it was left
      const reason = relativeMessage(restoreError, projectDir).replace(/\.$/, '');
      left.push(reason.startsWith(label) ? reason : `${label} (${reason}; its state from before the call is in ${label}.bak)`);
    }
  }
  const undo = await writer.undoToolCall();
  putBack.push(...undo.restored);
  if (left.length === 0 && undo.left.length === 0) {
    if (putBack.length === 0) return undoneByWriter ? `${cause}.` : `${cause}. Nothing was changed.`;
    const list = `${putBack.join(', ')} ${putBack.length === 1 ? 'is' : 'are'} as before the call`;
    return undoneByWriter ? `${cause}. Also put back: ${list}.` : `${cause}. The call was rolled back: ${list}.`;
  }
  const parts = [
    ...(putBack.length > 0 ? [`put back as they were before the call: ${putBack.join(', ')}`] : []),
    ...(undo.left.length > 0 ? [filesLeftClause(undo.left)] : []),
    ...(left.length > 0 ? [`not put back: ${left.join('; ')}`] : []),
  ];
  return `${cause}. The call was rolled back only in part: ${parts.join('; ')}. `
    + 'Check the project (validate_project, git diff) before you run the tool again.';
}
