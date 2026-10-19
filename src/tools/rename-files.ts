/**
 * The writes of a rename that do not go through writeEntityFile or
 * updateProject: the timelines that name a renamed layout or object type,
 * a renamed object type's other files, its frame image names, and the
 * editor's view-state files of the renamed entity; and the rollback of a
 * rename.
 *
 * The rename tools write the entity files and project.c3proj first, then
 * these, then the view state. So a write the writer refuses because an
 * entity file changed on disk during the call (StaleFileError) comes
 * before any of these, and the writer has then put back what the call
 * wrote. When a later step fails, rollBackRename puts these files back
 * from the bytes they held before the call (restoreForCall, which leaves a
 * file changed on disk since the call wrote it), renames the image files
 * back, then has rollBackFailedCall put back the entity files and
 * project.c3proj. The view-state files hold editor view settings only:
 * they are moved after everything else, and a failure there is a warning.
 */

import { readFile } from 'fs/promises';
import { basename } from 'path';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import type { ImageFileRename } from '../construct3/animation-rename.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { parseJsonText } from '../construct3/json-format.js';
import { StaleFileError, currentToolCall, fileKey, noteFileRead, noteFileWritten, sameFileState, statFileState, type FileState } from '../construct3/disk-state.js';
import { scriptFilePaths } from '../construct3/analyzers/index-builder.js';
import { rollBackFailedCall } from './call-rollback.js';

type RenameWriter = Pick<Construct3ProjectWriter,
  'replaceFile' | 'deleteFile' | 'restoreForCall' | 'renameImageFiles' | 'restoreFailedWrite' | 'undoToolCall' | 'projectRelative'>;
type RenameReader = Pick<Construct3ProjectReader, 'getProjectDir' | 'readObjectType' | 'readEventSheet' | 'readLayout' | 'readFamily'>;

/** The entity categories a rename moves a file of. */
export type RenamedCategory = 'objectTypes' | 'eventSheets' | 'layouts' | 'families';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Path segments of an entity's file in the project: <category>/<folders>/<name>.json. */
export function entityFileSegments(category: RenamedCategory, subfolder: string | undefined, name: string): string[] {
  return [category, ...(subfolder ? subfolder.split('/') : []), `${name}.json`];
}

/** The JSON of a file read for a rename, or undefined when there was no file or it does not parse. */
function jsonOf(read: { bytes: Buffer | null }): unknown {
  if (read.bytes === null) return undefined;
  try {
    return parseJsonText(read.bytes.toString('utf-8'));
  } catch {
    return undefined;
  }
}

/** A registered entity as the reader parses it. */
function readEntity(reader: RenameReader, category: RenamedCategory, name: string): Promise<unknown> {
  switch (category) {
    case 'objectTypes': return reader.readObjectType(name);
    case 'eventSheets': return reader.readEventSheet(name);
    case 'layouts': return reader.readLayout(name);
    default: return reader.readFamily(name);
  }
}

/**
 * Whether a file is in the way of an entity's new name: none ('free'), the
 * file a stopped run of this rename wrote ('stopped-run': spelled exactly
 * as the new name, with the new name in "name" and the entity's SID, read
 * for the write over it), or any other file ('other', with the writer's
 * refusal). A file spelled in another case is found too (the writer's
 * search ignores case on every file system); it is not the stopped run's,
 * which wrote the new name exactly.
 */
export async function newFileState(
  reader: Pick<Construct3ProjectReader, 'getProjectDir'>,
  writer: Pick<Construct3ProjectWriter, 'entityFileRefusal'>,
  category: RenamedCategory, subfolder: string | undefined, newName: string, sid: unknown,
): Promise<{ state: 'free' } | { state: 'stopped-run'; read: ReadForRename } | { state: 'other'; refusal: string }> {
  const refusal = await writer.entityFileRefusal(category, newName, subfolder);
  if (refusal === undefined) return { state: 'free' };
  const path = resolveProjectPath(reader.getProjectDir(), ...entityFileSegments(category, subfolder, newName));
  const found = await findFileIgnoringCase(path);
  if (found !== undefined && basename(found) === basename(path)) {
    const read = await readForRename(found);
    const data = jsonOf(read);
    if (isRecord(data) && data.name === newName && typeof sid === 'number' && data.sid === sid) return { state: 'stopped-run', read };
  }
  return { state: 'other', refusal };
}

/**
 * Whether a rename of `oldName` to `newName` stopped after its project
 * update: `newName` is registered and readable, and the old file itself
 * is still on disk beside the new one with the same SID. A rename deletes
 * the old file as its last step, so a finished rename never leaves this
 * evidence (its .bak is not taken as evidence). Returns the entity under
 * its new name and the old file, read for its delete, or undefined.
 */
export async function stoppedRename(
  reader: RenameReader,
  writer: Pick<Construct3ProjectWriter, 'getSubfolderForEntity'>,
  category: RenamedCategory, oldName: string, newName: string,
): Promise<{ current: Record<string, unknown>; oldRead: ReadForRename } | undefined> {
  let current: unknown;
  try {
    current = await readEntity(reader, category, newName);
  } catch {
    return undefined;
  }
  if (!isRecord(current) || typeof current.sid !== 'number') return undefined;
  const oldPath = resolveProjectPath(reader.getProjectDir(), ...entityFileSegments(category, writer.getSubfolderForEntity(category, newName), oldName));
  const oldRead = await readForRename(oldPath);
  const data = jsonOf(oldRead);
  return isRecord(data) && data.sid === current.sid ? { current, oldRead } : undefined;
}

/**
 * Refuse (StaleFileError) a write over or a delete of a file the reader did
 * not read for this call, when it changed since `read` (readForRename).
 */
export async function assertUnchangedSinceRead(writer: Pick<Construct3ProjectWriter, 'projectRelative'>, read: ReadForRename): Promise<void> {
  if (sameFileState(await statFileState(read.path), read.state)) return;
  const label = writer.projectRelative(read.path);
  throw new StaleFileError(`${label} was changed on disk after this call read it. It was left as it is.`, label);
}

/** A file as a rename read it: its state, then its bytes (null: there was no file). */
export interface ReadForRename {
  path: string;
  state: FileState;
  bytes: Buffer | null;
}

/** What a rename changed outside writeEntityFile and updateProject, in order, for rollBackRename. */
export interface RenameSideWrites {
  /** Files written or deleted, with their bytes from before the call (null: there was no file) */
  files: Array<{ path: string; before: Buffer | null }>;
  /** Files a failed write or delete left holding bytes that are neither the call's nor from before (or that could not be read): never put back, named */
  unresolved: Array<{ path: string; before: Buffer | null }>;
  /** Image file renames made, in order */
  imageRenames: ImageFileRename[];
}

/** An empty record of side writes. */
export function newSideWrites(): RenameSideWrites {
  return { files: [], unresolved: [], imageRenames: [] };
}

/**
 * An error's text for a message: an fs error by its code and the file's
 * path in the project (its own message spells the absolute path), any
 * other error by its message (the writer names files project-relative).
 */
export function reasonOf(error: unknown, relative: (path: string) => string): string {
  if (typeof error === 'object' && error !== null) {
    const { code, path } = error as { code?: unknown; path?: unknown };
    if (typeof code === 'string' && typeof path === 'string') return `${code} on ${relative(path)}`;
  }
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
}

/**
 * Read a file for a later replace or delete that must not write over
 * another change: its state first, then its bytes. A change between the
 * two leaves bytes newer than the state, and the replace then refuses.
 */
export async function readForRename(path: string): Promise<ReadForRename> {
  const state = await statFileState(path);
  // The writer's own check, under the file's lock, then compares the file with this state
  // (writeEntityFile and deleteEntityFile ask the reader, which asks the running call first)
  noteFileRead(fileKey(path), state);
  return { path, state, bytes: state === null ? null : await readFile(path) };
}

/** Bytes as a Buffer. */
const bytesOf = (content: string | Buffer): Buffer => (typeof content === 'string' ? Buffer.from(content, 'utf-8') : content);

/**
 * After a side write or delete through the writer threw: record what the
 * call demonstrably changed, so rollBackRename puts it back, and nothing
 * else. The file holds its bytes from before: nothing to record. It holds
 * what the call wrote (`written`; null: the call deleted it), or is gone
 * where the call replaced it (the writer's replacement can remove the
 * file before it fails): the change is the call's, recorded with
 * `before`, with the state it left as the call's own (the writer did not
 * record one when it failed), which restoreForCall compares the file with.
 * It holds other bytes: another write's, left as it is and recorded as
 * such, so the message names it with its backup.
 * A file that is gone is taken as the call's own replace or delete, also
 * when another program removed it meanwhile; the rollback then writes the
 * bytes from before the call back.
 */
async function recordFailedSideWrite(
  side: RenameSideWrites, path: string, before: Buffer | null, written: Buffer | null,
): Promise<void> {
  let state: FileState;
  let now: Buffer | null;
  try {
    state = await statFileState(path);
    now = state === null ? null : await readFile(path);
  } catch {
    side.unresolved.push({ path, before });
    return;
  }
  const same = (a: Buffer | null, b: Buffer | null) => (a === null ? b === null : b !== null && a.equals(b));
  if (same(now, before)) return;
  if (same(now, written) || now === null) {
    noteFileWritten(fileKey(path), state);
    side.files.push({ path, before });
  } else {
    side.unresolved.push({ path, before });
  }
}

/**
 * Replace `read.path` with `content` through the writer, refused
 * (StaleFileError) when the file is no longer in the state it was read in
 * (checked by the writer under the file's lock), and record its bytes from
 * before for rollBackRename, also when the writer throws after it changed
 * the file (recordFailedSideWrite).
 */
export async function replaceForRename(
  writer: RenameWriter, side: RenameSideWrites, read: ReadForRename, content: string | Buffer,
): Promise<void> {
  try {
    await writer.replaceFile(read.path, content, { expected: read.state });
  } catch (error) {
    if (!(error instanceof StaleFileError)) await recordFailedSideWrite(side, read.path, read.bytes, bytesOf(content));
    throw error;
  }
  side.files.push({ path: read.path, before: read.bytes });
}

/**
 * Create `path` with `content` through the writer, refused (StaleFileError)
 * when a file is there. The file is recorded for the rollback once it holds
 * what the call wrote, or, when the writer threw after it changed the file,
 * as recordFailedSideWrite finds it; a refused create records nothing, so a
 * rollback never touches a file this call did not make.
 */
export async function createFileForCall(
  writer: RenameWriter, side: RenameSideWrites, path: string, content: string | Buffer,
): Promise<void> {
  try {
    await writer.replaceFile(path, content, { expected: null });
  } catch (error) {
    if (!(error instanceof StaleFileError)) await recordFailedSideWrite(side, path, null, bytesOf(content));
    throw error;
  }
  side.files.push({ path, before: null });
}

/**
 * Move a file to `to` through the writer: written there with `content`
 * (default: its bytes), refused when a file appeared there; then deleted
 * at its old path, refused (under the file's lock) when it changed since
 * it was read. Both steps are recorded for rollBackRename, also when the
 * writer throws after it changed a file (recordFailedSideWrite).
 */
export async function moveFileForRename(
  writer: RenameWriter, side: RenameSideWrites, from: ReadForRename, to: string, content?: string | Buffer,
): Promise<void> {
  const label = writer.projectRelative(from.path);
  if (from.bytes === null) throw new Error(`${label} does not exist, so it cannot be moved.`);
  const moved = content ?? from.bytes;
  await createFileForCall(writer, side, to, moved);
  try {
    await writer.deleteFile(from.path, { expected: from.state });
  } catch (error) {
    if (error instanceof StaleFileError) {
      throw new StaleFileError(`${label} was changed on disk after this call read it. It was not deleted, so that change is kept.`, label);
    }
    await recordFailedSideWrite(side, from.path, from.bytes, null);
    throw error;
  }
  side.files.push({ path: from.path, before: from.bytes });
}

/** A view-state file to move: its path segments in the project, those of its new name, and a change of its text. */
export interface ViewStateMove {
  from: readonly string[];
  to: readonly string[];
  rewrite?: (text: string) => string;
}

/**
 * Move the editor's view-state files of a renamed entity. They hold view
 * settings only, and the editor starts a new one where it is missing, so
 * a failure is a warning and the next file is moved: a file whose new name
 * holds other bytes is left as it is, and one whose new name holds the
 * same bytes (a run that stopped between the two steps) only loses its old
 * name. A move whose `to` is its `from` rewrites the file in place (a
 * view-state file that lists the entity by name). Not rolled back.
 * Returns the moves made and the warnings.
 */
export async function moveViewStateFiles(
  writer: RenameWriter, projectDir: string, moves: readonly ViewStateMove[],
): Promise<{ moved: Array<{ from: string; to: string }>; warnings: string[] }> {
  const moved: Array<{ from: string; to: string }> = [];
  const warnings: string[] = [];
  for (const move of moves) {
    const fromLabel = move.from.join('/');
    const toLabel = move.to.join('/');
    const fromPath = resolveProjectPath(projectDir, ...move.from);
    const toPath = resolveProjectPath(projectDir, ...move.to);
    try {
      const from = await readForRename(fromPath);
      if (from.bytes === null) continue;
      const content = move.rewrite ? Buffer.from(move.rewrite(from.bytes.toString('utf-8')), 'utf-8') : from.bytes;
      if (fromLabel === toLabel) {
        if (content.equals(from.bytes)) continue;
        await replaceForRename(writer, newSideWrites(), from, content);
        moved.push({ from: fromLabel, to: toLabel });
        continue;
      }
      const taken = await findFileIgnoringCase(toPath);
      if (taken) {
        if (!(await readFile(taken)).equals(content)) {
          warnings.push(`The editor's view state ${fromLabel} was left as it is: ${writer.projectRelative(taken)} already exists.`);
          continue;
        }
        // Only the old name goes, and only while it is as read: refused early here, and again by the writer under the file's lock (deleteFile keeps a .bak of it)
        await assertUnchangedSinceRead(writer, from);
        await writer.deleteFile(fromPath, { expected: from.state });
      } else {
        await moveFileForRename(writer, newSideWrites(), from, toPath, content);
      }
      moved.push({ from: fromLabel, to: toLabel });
    } catch (error) {
      warnings.push(`The editor's view state ${fromLabel} could not be moved to ${toLabel} `
        + `(${reasonOf(error, path => writer.projectRelative(path))}); Construct 3 starts a new one where it is missing.`);
    }
  }
  return { moved, warnings };
}

/** Whether this call's backup of `path` still holds what the call put there (the check rollBackFailedCall makes). */
async function ownBackup(path: string): Promise<boolean> {
  const record = currentToolCall()?.backups.get(fileKey(path));
  return record !== undefined && record.existed && sameFileState(await statFileState(record.path), record.state);
}

/** Put back the side writes, last first: the image names, then the files. */
export async function putBackSideWrites(writer: RenameWriter, side: RenameSideWrites): Promise<{ putBack: string[]; left: string[] }> {
  const putBack: string[] = [];
  const left: string[] = [];
  const relative = (path: string) => writer.projectRelative(path);
  if (side.imageRenames.length > 0) {
    const back = side.imageRenames.map(r => ({ from: r.to, to: r.from })).reverse();
    try {
      await writer.renameImageFiles(back);
      putBack.push(`images/ (${side.imageRenames.length} file(s) the call renamed, renamed back)`);
    } catch (error) {
      left.push(`the image files it renamed in images/ (renaming them back failed: ${reasonOf(error, relative)}; `
        + `rename them back by hand: ${back.map(r => `images/${r.from} to images/${r.to}`).join(', ')})`);
    }
  }
  for (const file of [...side.files].reverse()) {
    const label = relative(file.path);
    try {
      await writer.restoreForCall(file.path, file.before);
      putBack.push(file.before === null ? `${label} (removed: the call had created it)` : label);
    } catch (error) {
      left.push(`${label} (${reasonOf(error, relative)}; ${file.before === null
        ? 'it did not exist before the call'
        : (await ownBackup(file.path))
          ? `its state from before the call is in ${label}.bak`
          : `${label}.bak is no longer the copy this call made`})`);
    }
  }
  for (const file of side.unresolved) {
    const label = relative(file.path);
    left.push(`${label} (its write or delete failed, and it now holds bytes that are neither this call's nor those from before it; `
      + (file.before === null
        ? 'it did not exist before the call'
        : (await ownBackup(file.path)) ? `its state from before the call is in ${label}.bak` : `${label}.bak is no longer the copy this call made`)
      + ')');
  }
  return { putBack, left };
}

/**
 * Roll back a rename after `error` and return the error message: the side
 * writes first (putBackSideWrites), then the entity files and
 * project.c3proj (rollBackFailedCall, with `options.writing` as there). A
 * StaleFileError the writer threw after it had undone the call's earlier
 * writes (`undone`) is passed on as it is; any other, such as one
 * replaceFile or moveFileForRename threw for a side file, has not had
 * them undone, so it is passed on as an ordinary error and they are.
 */
export async function rollBackRename(
  writer: RenameWriter, error: unknown, side: RenameSideWrites, options: { writing?: string } = {},
): Promise<string> {
  const extras = await putBackSideWrites(writer, side);
  const cause = error instanceof StaleFileError && !error.undone ? new Error(error.message, { cause: error }) : error;
  return joinRollbackMessages(await rollBackFailedCall(writer, cause, options), extras);
}

const NOTHING_CHANGED = ' Nothing was changed.';
const CHECK = ' Check the project (validate_project, git diff) before you run the tool again.';
/** The closing advice of the writer's stale-file message, which a partial rollback replaces with CHECK. */
const RUN_AGAIN = / Run the tool again: it reads the file as it is now\./;

/**
 * The message of rollBackFailedCall (`core`) with what became of the side
 * writes. When every side write was put back, the message says so in the
 * form of core; when one was left, "Nothing was changed." is never kept.
 */
export function joinRollbackMessages(core: string, extras: { putBack: string[]; left: string[] }): string {
  if (extras.putBack.length === 0 && extras.left.length === 0) return core;
  const restored = extras.putBack.join(', ');
  const verb = extras.putBack.length === 1 ? 'is' : 'are';
  if (extras.left.length === 0) {
    if (core.endsWith(NOTHING_CHANGED)) {
      return `${core.slice(0, -NOTHING_CHANGED.length)} The call was rolled back: ${restored} ${verb} as before the call.`;
    }
    return `${core} Also as before the call: ${restored}.`;
  }
  const head = (core.endsWith(NOTHING_CHANGED)
    ? `${core.slice(0, -NOTHING_CHANGED.length)} The entity files and project.c3proj are as before the call.`
    : core.replace(CHECK, '')).replace(RUN_AGAIN, '');
  const parts = [
    ...(extras.putBack.length > 0 ? [`as before the call: ${restored}`] : []),
    `left as it is: ${extras.left.join('; ')}`,
  ];
  return `${head} Of the other files the call changed: ${parts.join('; ')}.${CHECK}`;
}

/** A JavaScript string literal (double, single or back quotes) that is `name`, ignoring case. */
export function jsQuotedNamePattern(name: string): RegExp {
  return new RegExp(`(["'\`])${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\1`, 'iu');
}

/**
 * The lines of the project script files (rootFileFolders.script, on the
 * reference index's walk) that `test` matches, and the script files that
 * could not be read. Scripts are never rewritten: the rename tools list
 * these lines and name the unreadable files in a warning.
 */
export async function scriptFileUses(
  reader: Pick<Construct3ProjectReader, 'getProject' | 'readScriptFile'>,
  test: (line: string) => boolean,
): Promise<{ lines: Array<{ path: string; line: string }>; unreadable: string[] }> {
  const lines: Array<{ path: string; line: string }> = [];
  const unreadable: string[] = [];
  for (const path of scriptFilePaths(reader.getProject())) {
    let text: string;
    try {
      text = await reader.readScriptFile(path);
    } catch {
      unreadable.push(`scripts/${path}`);
      continue;
    }
    for (const line of text.split(/\r?\n/)) if (test(line)) lines.push({ path: `scripts/${path}`, line: line.trim() });
  }
  return { lines, unreadable };
}
