/**
 * Flowchart files: where a registered flowchart lives, reading one for a
 * tool call, writing it back, and the project.c3proj registration that
 * create and delete keep consistent with the file.
 *
 * A flowchart is read through the reader (size limit, BOM dropped, the state
 * the file was read in recorded for the call) and written back through
 * writer.replaceFile with that state as `expected`, so a file saved in the
 * editor during the call is never overwritten. Flowcharts are not entity
 * files of the writer: the writer records only entity files and
 * project.c3proj for undoToolCall, and that puts back the file as it was
 * before the call's first update (losing a save of the editor that a later
 * round of the update merged in). So a rollback here undoes only this
 * call's registration, by a second update on the project as it is then
 * (withdrawFlowchart, registerFlowchart); create removes the flowchart
 * file it wrote (restoreForCall) once project.c3proj is known not to
 * register it, delete restores a deleted file before it puts the
 * registration back, and both say what is on disk.
 */

import { readFile } from 'fs/promises';
import { dirname } from 'path';
import type { Construct3ProjectReader } from './project-reader.js';
import type { Construct3ProjectWriter } from './project-writer.js';
import { newProjectFolder } from './project-writer.js';
import { StaleFileError, currentToolCall, fileKey, sameFileState, statFileState, type FileState } from './disk-state.js';
import { existingSpelling } from './atomic-write.js';
import { parseJsonText, resolveJsonTextStyle, serializeJson } from './json-format.js';
import { resolveProjectPath } from './path-utils.js';
import type { ProjectFolderNode } from './timeline-folders.js';
import type { Flowchart } from './flowchart-model.js';

/** What these functions use of the reader. */
export type Reader = Pick<Construct3ProjectReader, 'getProjectDir' | 'getProjectPath' | 'readDataFileText' | 'stateAsRead'>;

/** What these functions use of the writer. */
export type Writer = Pick<Construct3ProjectWriter,
  'replaceFile' | 'deleteFile' | 'restoreForCall' | 'updateProject' | 'assertProjectFileCurrent' | 'projectRelative'>;

// ─── Messages and paths ────────────────────────────────────

/**
 * An error's message for a tool result: without the ", <syscall> '<path>'"
 * Node appends to fs errors (the project's absolute path), and without a
 * trailing full stop, so a sentence can follow.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/,? ?(?:open|read|stat|lstat|scandir|access|rename|unlink|copyfile|mkdir|rmdir|link|symlink|utime) '.*'$/, '')
    .replace(/\.$/, '');
}

/** The project-relative path of a flowchart file, as shown in messages. */
export function flowchartLabel(name: string, folders: readonly string[]): string {
  return ['flowcharts', ...folders, `${name}.json`].join('/');
}

/**
 * The path of a flowchart file, confined to the flowcharts folder as the
 * reader confines its reads: a registered folder or name with ".." in it
 * throws (Path traversal detected) instead of naming another project file.
 */
export function flowchartFilePath(projectDir: string, name: string, folders: readonly string[]): string {
  const root = resolveProjectPath(projectDir, 'flowcharts');
  return resolveProjectPath(root, ...folders, `${name}.json`);
}

/** The editor-state file Construct 3 keeps beside a flowchart file. */
export function uistatePath(flowchartPath: string): string {
  return flowchartPath.replace(/\.json$/, '.uistate.json');
}

// ─── Reading ───────────────────────────────────────────────

/** A registered flowchart, read for a tool call. */
export interface OpenedFlowchart {
  name: string;
  folders: string[];
  /** The project-relative path of the file. */
  label: string;
  /** The file as spelled on disk. */
  filePath: string;
  data: Flowchart;
  /** The file's state when this call read it; the write is refused when the file is no longer in it. */
  state: FileState | undefined;
}

export type OpenResult = { ok: true; flowchart: OpenedFlowchart } | { ok: false; refusal: string };

/** Whether a value is a plain JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why parsed JSON cannot be handed to the flowchart model, or undefined when
 * it can: the model reads `nodes[i].sid` and `outputs[j].sid`, so the file
 * must be an object whose nodes are objects and whose outputs, when a node
 * has them, are a list of objects.
 */
function flowchartShapeProblem(data: unknown): string | undefined {
  if (!isPlainObject(data) || !Array.isArray(data.nodes)) return 'it has no list of nodes';
  for (const node of data.nodes as unknown[]) {
    if (!isPlainObject(node)) return 'a node in it is not an object';
    if (node.outputs === undefined) continue;
    if (!Array.isArray(node.outputs)) return 'the outputs of a node are not a list';
    if (!(node.outputs as unknown[]).every(isPlainObject)) return 'an output in it is not an object';
  }
  return undefined;
}

/**
 * Read a registered flowchart. A file that is missing, cannot be read, is
 * not valid JSON, is not an object, has no list of nodes, or has a node or an
 * output that is not an object is refused, in a sentence that names the file
 * project-relative.
 */
export async function openFlowchart(reader: Reader, name: string, folders: readonly string[]): Promise<OpenResult> {
  const label = flowchartLabel(name, folders);
  const registered = `Flowchart "${name}" is registered in the project but ${label}`;
  let text: string;
  try {
    text = await reader.readDataFileText('flowcharts', [...folders, `${name}.json`].join('/'));
  } catch (error) {
    const reason = describeError(error).replace(/^Failed to read flowcharts file "[^"]*": /, '');
    return { ok: false, refusal: `${registered} could not be read: ${reason}.` };
  }
  let data: unknown;
  try {
    data = parseJsonText(text);
  } catch (error) {
    return { ok: false, refusal: `${registered} is not valid JSON: ${describeError(error)}.` };
  }
  const problem = flowchartShapeProblem(data);
  if (problem !== undefined) return { ok: false, refusal: `${registered} does not hold a flowchart: ${problem}.` };
  const filePath = await existingSpelling(flowchartFilePath(reader.getProjectDir(), name, folders));
  return {
    ok: true,
    flowchart: { name, folders: [...folders], label, filePath, data: data as Flowchart, state: reader.stateAsRead(filePath) },
  };
}

// ─── Writing ───────────────────────────────────────────────

/** Where a write went, for its failure message. */
interface WriteTarget {
  filePath: string;
  label: string;
  /** The state the file was in before the call (null: there was no file); undefined: not known. */
  state: FileState | undefined;
}

/**
 * The message for a write that failed: what is on disk. A refusal as stale
 * is the writer's own text. The file counts as untouched only when its state
 * is still the one it was read in; otherwise the message says it may have
 * been changed and, when this call made one, where the backup is.
 */
async function failedWriteMessage(writer: Writer, error: unknown, target: WriteTarget): Promise<string> {
  if (error instanceof StaleFileError) return error.message;
  const cause = describeError(error);
  let untouched = false;
  try {
    untouched = target.state !== undefined && sameFileState(await statFileState(target.filePath), target.state);
  } catch {
    // The file's state is not known, so it is not called untouched
  }
  if (untouched) return `${cause}. Nothing was changed.`;
  const backup = currentToolCall()?.backups.get(fileKey(target.filePath));
  const backupClause = backup?.existed ? ` Its state from before the call is in ${writer.projectRelative(backup.path)}.` : '';
  return `${cause}. ${target.label} may have been changed by this call.${backupClause} Check it before you run the tool again.`;
}

export type WriteOutcome = { ok: true; backupFile: string | undefined } | { ok: false; message: string };

/**
 * Write a changed flowchart back, in the text style of the file, through
 * writer.replaceFile: one backup per call, a temp file, a read-back, and a
 * refusal when the file changed since the call read it.
 */
export async function writeFlowchart(reader: Reader, writer: Writer, flowchart: OpenedFlowchart): Promise<WriteOutcome> {
  try {
    const style = await resolveJsonTextStyle(flowchart.filePath, reader.getProjectPath(), dirname(flowchart.filePath));
    const backupFile = await writer.replaceFile(flowchart.filePath, serializeJson(flowchart.data, style), { expected: flowchart.state });
    return { ok: true, backupFile };
  } catch (error) {
    return { ok: false, message: await failedWriteMessage(writer, error, flowchart) };
  }
}

// ─── The project.c3proj registration ───────────────────────

/** The part of a parsed project.c3proj these functions change. */
export interface ProjectWithFlowcharts {
  flowcharts?: unknown;
}

/** The subfolder of `folder` with this name; entries that are not objects are skipped, as locateFlowcharts skips them. */
function namedChild(folder: ProjectFolderNode, name: string): ProjectFolderNode | undefined {
  if (!Array.isArray(folder.subfolders)) return undefined;
  return (folder.subfolders as unknown[]).find(
    (sub): sub is ProjectFolderNode => typeof sub === 'object' && sub !== null && (sub as ProjectFolderNode).name === name,
  );
}

/** The folder `folders` below the flowcharts container (the container itself for none), or undefined when there is none. */
function folderAt(project: ProjectWithFlowcharts, folders: readonly string[]): ProjectFolderNode | undefined {
  let folder = project.flowcharts as ProjectFolderNode | null | undefined;
  for (const part of folders) {
    folder = typeof folder === 'object' && folder !== null ? namedChild(folder, part) : undefined;
  }
  return typeof folder === 'object' && folder !== null ? folder : undefined;
}

/** Whether a folder holds no flowchart and no subfolder. */
function isEmptyFolder(folder: ProjectFolderNode): boolean {
  return (!Array.isArray(folder.items) || folder.items.length === 0)
    && (!Array.isArray(folder.subfolders) || folder.subfolders.length === 0);
}

/**
 * What registerFlowchart added to a project: the flowcharts container, and
 * how many of the folders on the path it made (always the innermost ones:
 * a folder made has no folder below it that was there before).
 */
export interface Registration {
  container: boolean;
  foldersMade: number;
}

/**
 * Register `name` in the flowcharts container of a parsed project.c3proj, in
 * `folders`, creating the container and the folders the way the editor
 * writes them (key order items, subfolders, name). Returns what it added, or
 * undefined when the name is already registered there; throws when the
 * entry is not a folder container, before anything is changed.
 */
export function registerFlowchart(project: ProjectWithFlowcharts, name: string, folders: readonly string[]): Registration | undefined {
  const container = project.flowcharts === undefined;
  if (container) project.flowcharts = { items: [], subfolders: [] };
  if (typeof project.flowcharts !== 'object' || project.flowcharts === null || Array.isArray(project.flowcharts)) {
    throw new Error('project.c3proj has a "flowcharts" entry that is not a folder container');
  }
  let folder = project.flowcharts as ProjectFolderNode;
  let foldersMade = 0;
  for (const part of folders) {
    if (!Array.isArray(folder.subfolders)) folder.subfolders = [];
    let next = namedChild(folder, part);
    if (!next) {
      next = newProjectFolder(part);
      (folder.subfolders as unknown[]).push(next);
      foldersMade++;
    }
    folder = next;
  }
  if (!Array.isArray(folder.items)) folder.items = [];
  const items = folder.items as unknown[];
  if (items.includes(name)) return undefined;
  items.push(name);
  return { container, foldersMade };
}

/** Whether `name` is registered in exactly the folder `folders`. */
export function isRegistered(project: ProjectWithFlowcharts, name: string, folders: readonly string[]): boolean {
  const folder = folderAt(project, folders);
  return folder !== undefined && Array.isArray(folder.items) && (folder.items as unknown[]).includes(name);
}

/**
 * Remove `name` from exactly the folder it is registered in. Throws when it
 * is not registered there (the project changed since the call looked).
 */
export function unregisterFlowchart(project: ProjectWithFlowcharts, name: string, folders: readonly string[]): void {
  const folder = folderAt(project, folders);
  const items = folder && Array.isArray(folder.items) ? folder.items as unknown[] : [];
  const index = items.indexOf(name);
  if (index === -1) throw new Error(`"${name}" is not registered in ${['flowcharts', ...folders].join('/')} of project.c3proj`);
  items.splice(index, 1);
}

/**
 * Undo registerFlowchart on the project as it is now (a save of the editor
 * since is kept): remove `name`, then, innermost first, the folders and the
 * container the registration made, as long as each is still empty, since
 * something saved into one is not this call's to remove. False, with
 * nothing changed, when `name` is not registered in `folders`.
 */
export function withdrawFlowchart(project: ProjectWithFlowcharts, name: string, folders: readonly string[], made: Registration): boolean {
  if (!isRegistered(project, name, folders)) return false;
  unregisterFlowchart(project, name, folders);
  for (let depth = folders.length; depth > folders.length - made.foldersMade; depth--) {
    const parent = folderAt(project, folders.slice(0, depth - 1));
    const folder = folderAt(project, folders.slice(0, depth));
    if (parent === undefined || folder === undefined || !Array.isArray(parent.subfolders) || !isEmptyFolder(folder)) return true;
    (parent.subfolders as unknown[]).splice((parent.subfolders as unknown[]).indexOf(folder), 1);
  }
  const root = folderAt(project, []);
  if (made.container && root !== undefined && isEmptyFolder(root)) delete project.flowcharts;
  return true;
}

// ─── Create and delete ─────────────────────────────────────

/**
 * Whether project.c3proj as it is on disk registers `name` in exactly
 * `folders`; undefined when it cannot be read or parsed, so the answer is
 * not known. The rollbacks below decide on this, not on what the update
 * they ran reported: an update can fail after it wrote.
 */
async function registeredOnDisk(reader: Reader, name: string, folders: readonly string[]): Promise<boolean | undefined> {
  try {
    return isRegistered(parseJsonText(await readFile(reader.getProjectPath(), 'utf-8')) as ProjectWithFlowcharts, name, folders);
  } catch {
    return undefined;
  }
}

/** What an update that undoes this call's registration did: whether it wrote, or why it failed. */
interface UpdateAttempt {
  wrote: boolean;
  error?: unknown;
}

/**
 * Run an update of project.c3proj that undoes this call's registration on
 * the project as it is now. Its failure is reported, not thrown: a throw
 * would reach the tool's catch, which answers that nothing was written,
 * after this call wrote a file.
 */
async function attemptUpdate(writer: Writer, change: (project: ProjectWithFlowcharts) => boolean | void): Promise<UpdateAttempt> {
  try {
    return { wrote: (await writer.updateProject(change)) !== undefined };
  } catch (error) {
    return { wrote: false, error };
  }
}

/**
 * Remove a file this call created (restoreForCall, which leaves a file that
 * changed since this call wrote it, or one the call holds no state for).
 * Returns whether it was removed.
 */
async function removeCreatedFile(writer: Writer, filePath: string): Promise<boolean> {
  try {
    await writer.restoreForCall(filePath, null);
    return true;
  } catch {
    return false;
  }
}

/** The sentence that ends a failure message that could not say everything is as it was. */
const CHECK_THE_PROJECT = 'Check the project (validate_project, git diff) before you run the tool again.';

/** The closing sentence of a failure message: nothing was changed, or what to check. */
function closing(clean: boolean): string {
  return clean ? 'Nothing was changed.' : CHECK_THE_PROJECT;
}

/**
 * The message for a create whose write of the new file failed after the
 * file was written (the read-back or the check after it failed): the file
 * is removed again when it still holds what this call wrote, and otherwise
 * named as unregistered.
 */
async function failedNewFileMessage(writer: Writer, error: unknown, filePath: string, label: string): Promise<string> {
  if (await removeCreatedFile(writer, filePath)) {
    return `${describeError(error)}. ${label}, which this call created, was removed again. Nothing was changed.`;
  }
  return `${describeError(error)}. ${label} may have been written by this call and is not registered in project.c3proj; ` +
    'it could not be removed again, so it was left as it is. Check it before you run the tool again.';
}

/** Refusal thrown inside the create's project update, before it changes project.c3proj: the checks failed on the project as it is now. */
export class CreateRefusedError extends Error {}

/** The file a create wrote and the registration it tried. */
interface CreatedFile {
  filePath: string;
  label: string;
  name: string;
  folders: readonly string[];
  /** What the last round of the registration update added; undefined when no round got as far as registering. */
  registration: Registration | undefined;
}

/**
 * The message for a create whose registration failed after the file was
 * written. This call's registration is withdrawn first, by an update on
 * the project as it is now (a save of the editor meanwhile is kept, which
 * putting a saved copy back would not do). The file is removed only when
 * project.c3proj on disk is then known not to register it; otherwise it is
 * kept and named. In this order a process stopped between the two leaves an
 * unregistered file, never a registered name without its file.
 */
async function failedCreateMessage(reader: Reader, writer: Writer, error: unknown, created: CreatedFile): Promise<string> {
  const { filePath, label, name, folders, registration } = created;
  const withdraw = registration === undefined
    ? undefined
    : await attemptUpdate(writer, project => withdrawFlowchart(project, name, folders, registration));
  const registered = await registeredOnDisk(reader, name, folders);
  const lead = error instanceof CreateRefusedError ? ' project.c3proj was saved while this call was working, after its checks.' : '';
  if (registered !== false) {
    const why = registered === true ? 'project.c3proj still registers it' : 'project.c3proj could not be read to check that it does not register it';
    const failure = withdraw?.error !== undefined ? ` The registration could not be removed again: ${describeError(withdraw.error)}.` : '';
    return `${describeError(error)}.${lead} ${label}, which this call created, was kept: ${why}.${failure} ${closing(false)}`;
  }
  const removed = await removeCreatedFile(writer, filePath);
  const sentences = [
    removed
      ? `${label}, which this call created, was removed again.`
      : `${label}, which this call created, could not be removed and is still there.`,
  ];
  if (withdraw?.wrote) sentences.push(`The registration of "${name}" was removed from project.c3proj again.`);
  return `${describeError(error)}.${lead} ${sentences.join(' ')} ${closing(removed)}`;
}

/**
 * The label of the folder a failed create made and left behind, when it made
 * one (`madeFolder`) and the folder is still there. A folder cannot be
 * removed through the writer, so it stays, empty.
 */
async function leftFolder(writer: Writer, filePath: string, madeFolder: boolean): Promise<string | undefined> {
  if (!madeFolder) return undefined;
  try {
    return (await statFileState(dirname(filePath))) === null ? undefined : writer.projectRelative(dirname(filePath));
  } catch {
    return undefined;
  }
}

/**
 * A create's failure message with the folder it left behind: "Nothing was
 * changed." becomes "Nothing else was changed.", since the empty folder is
 * still there.
 */
function withLeftFolder(message: string, folderLabel: string | undefined): string {
  if (folderLabel === undefined) return message;
  const note = `The empty folder ${folderLabel}, and any parent folder this call created, was left.`;
  const unchanged = ' Nothing was changed.';
  return message.endsWith(unchanged)
    ? `${message.slice(0, -unchanged.length)} ${note} Nothing else was changed.`
    : `${message} ${note}`;
}

export type CreateOutcome = { ok: true } | { ok: false; message: string };

/** The checks that refuse a create on a `flowcharts` entry of project.c3proj: a sentence, or undefined to go ahead. */
export type CreateCheck = (container: unknown) => string | undefined;

/**
 * Create a flowchart file and register it in project.c3proj. Refused before
 * anything is written when project.c3proj changed on disk after the reader
 * loaded the version the caller's checks used (StaleFileError, thrown). The
 * file is written first, as a new file (it is refused when a file appeared
 * meanwhile); then the registration is made by an update that runs `check`
 * again on the project it reads, on every round, so a name or folder saved
 * in the editor after the caller's checks is refused (CreateRefusedError)
 * before project.c3proj is changed. When the write of the file fails after
 * the file landed, or the registration fails, the call's registration is
 * withdrawn and the file is removed again once project.c3proj is known not
 * to register it, so a registered name never lacks its file. A folder the
 * write made stays, and the message says so.
 */
export async function createFlowchartFile(
  reader: Reader,
  writer: Writer,
  name: string,
  folders: readonly string[],
  data: Flowchart,
  check: CreateCheck,
): Promise<CreateOutcome> {
  const label = flowchartLabel(name, folders);
  const filePath = flowchartFilePath(reader.getProjectDir(), name, folders);
  await writer.assertProjectFileCurrent();
  const madeFolder = (await statFileState(dirname(filePath))) === null;
  try {
    const style = await resolveJsonTextStyle(filePath, reader.getProjectPath(), dirname(filePath));
    await writer.replaceFile(filePath, serializeJson(data, style), { expected: null });
  } catch (error) {
    // A file there now, after a failure other than the stale refusal, may be the one this call wrote
    const landed = !(error instanceof StaleFileError) && (await statFileState(filePath).catch(() => undefined)) !== null;
    const message = landed
      ? await failedNewFileMessage(writer, error, filePath, label)
      : await failedWriteMessage(writer, error, { filePath, label, state: null });
    return { ok: false, message: withLeftFolder(message, await leftFolder(writer, filePath, madeFolder)) };
  }
  const made: { registration: Registration | undefined } = { registration: undefined };
  try {
    await writer.updateProject(project => {
      // Each round starts from the file as it is now, so what an earlier round added is forgotten
      made.registration = undefined;
      const refusal = check(project.flowcharts);
      if (refusal !== undefined) throw new CreateRefusedError(refusal);
      made.registration = registerFlowchart(project, name, folders);
      return made.registration !== undefined;
    });
  } catch (error) {
    const message = await failedCreateMessage(reader, writer, error, { filePath, label, name, folders, registration: made.registration });
    return { ok: false, message: withLeftFolder(message, await leftFolder(writer, filePath, madeFolder)) };
  }
  return { ok: true };
}

/** The flowchart a delete is working on. */
interface DeleteTarget {
  name: string;
  folders: readonly string[];
  /** The file as spelled on disk. */
  filePath: string;
  label: string;
  /** Whether the file was there before the call (a registered name can lack its file). */
  existed: boolean;
}

/**
 * The message for a delete whose removal of the registration failed.
 * `removed` is whether the last round of the update took the name out of
 * the parsed project. When it did, the update may have written before it
 * failed, so project.c3proj is read: a registration that is gone is put
 * back by an update on the project as it is now. When it did not, nothing
 * was written.
 */
async function failedUnregisterMessage(reader: Reader, writer: Writer, error: unknown, target: DeleteTarget, removed: boolean): Promise<string> {
  const { name, folders } = target;
  const cause = describeError(error);
  if (!removed) return `${cause}. Nothing was changed.`;
  let registered = await registeredOnDisk(reader, name, folders);
  let put: UpdateAttempt = { wrote: false };
  if (registered !== true) {
    put = await attemptUpdate(writer, project => registerFlowchart(project, name, folders) !== undefined);
    registered = await registeredOnDisk(reader, name, folders);
  }
  if (registered === true) {
    return `${cause}.${put.wrote ? ` The registration of "${name}" was put back in project.c3proj.` : ''} Nothing was changed.`;
  }
  const why = put.error !== undefined ? ` (${describeError(put.error)})` : '';
  const state = registered === false ? `project.c3proj no longer registers "${name}"` : 'project.c3proj could not be read to check that it still registers it';
  return `${cause}. ${state} and the registration could not be put back${why}; ${target.label} was not deleted. ${CHECK_THE_PROJECT}`;
}

/**
 * Put a flowchart file this call deleted back from the backup the writer
 * made of it before it deleted it (restoreForCall refuses when something
 * was saved at the path since). Returns why it could not, or undefined.
 */
async function restoreDeletedFile(writer: Writer, filePath: string): Promise<string | undefined> {
  const backup = currentToolCall()?.backups.get(fileKey(filePath));
  if (backup === undefined || !backup.existed) return 'this call has no backup of it';
  try {
    if (!sameFileState(await statFileState(backup.path), backup.state)) return 'its backup was replaced after it was made';
    await writer.restoreForCall(filePath, await readFile(backup.path));
    return undefined;
  } catch (error) {
    return describeError(error);
  }
}

/**
 * The message for a delete whose flowchart file could not be deleted, after
 * its registration was removed. A file that is gone is restored first and
 * its registration put back after, by an update on the project as it is
 * now, so project.c3proj never registers a name whose file is missing; a
 * file that cannot be restored leaves the registration removed, and the
 * message names the backup.
 */
async function failedFileDeleteMessage(reader: Reader, writer: Writer, error: unknown, target: DeleteTarget): Promise<string> {
  const { name, folders, filePath, label } = target;
  const cause = describeError(error);
  let present: boolean | undefined;
  try {
    present = (await statFileState(filePath)) !== null;
  } catch {
    present = undefined;
  }
  if (present === undefined) {
    return `${cause}. Whether ${label} is still there could not be checked, so the registration of "${name}" was left removed. ${CHECK_THE_PROJECT}`;
  }
  let restored = '';
  // A file that was missing before the call has nothing to restore: the registration alone is put back
  if (!present && target.existed) {
    const failure = await restoreDeletedFile(writer, filePath);
    if (failure !== undefined) {
      // The file as spelled on disk, and the backup the writer made of it (not a name built from the registration)
      const backup = currentToolCall()?.backups.get(fileKey(filePath));
      const saved = backup?.existed ? ` Its state from before the call is in ${writer.projectRelative(backup.path)}.` : '';
      return `${cause}. ${label} is gone and could not be restored (${failure}).${saved} ` +
        `The registration was left removed, so project.c3proj names no flowchart without a file. ${CHECK_THE_PROJECT}`;
    }
    restored = ` ${label} was restored from its backup.`;
  }
  const put = await attemptUpdate(writer, project => registerFlowchart(project, name, folders) !== undefined);
  if ((await registeredOnDisk(reader, name, folders)) === true) {
    return `${cause}.${restored}${put.wrote ? ` The registration of "${name}" was put back in project.c3proj.` : ''} Nothing was changed.`;
  }
  const why = put.error !== undefined ? ` (${describeError(put.error)})` : '';
  return `${cause}.${restored} The registration of "${name}" could not be put back in project.c3proj${why}, so ${label} is there without a registration. ${CHECK_THE_PROJECT}`;
}

/**
 * Delete the editor-state file beside a flowchart file, if there was one
 * before the call, and only while it is still in the state the call saw
 * (`seen`; null: there was none, so one that appeared is refused too). A
 * file saved or created since is kept; any failure is a warning.
 */
async function deleteEditorStateFile(writer: Writer, statePath: string, seen: FileState): Promise<string[]> {
  const stateLabel = writer.projectRelative(statePath);
  try {
    if (seen === null && (await statFileState(statePath)) === null) return [];
    const backup = await writer.deleteFile(statePath, { expected: seen });
    return [`Also deleted the editor-state file ${stateLabel}${backup ? ` (its copy is in ${writer.projectRelative(backup)})` : ''}.`];
  } catch (error) {
    if (error instanceof StaleFileError) return [`The editor-state file ${stateLabel} changed on disk during the call, so it was left in place.`];
    return [`The editor-state file ${stateLabel} could not be deleted: ${describeError(error)}. It was left in place.`];
  }
}

export type DeleteOutcome =
  | { ok: true; backupFile: string | undefined; warnings: string[] }
  | { ok: false; message: string };

/**
 * Delete a registered flowchart: its registration first, then its file (kept
 * as a .bak), then its editor-state file. Each file is deleted only while it
 * is still in the state it had before the call began (the project update in
 * between is a window for a save of the editor, or for a file to appear
 * where there was none), so a saved file is kept and the delete is
 * refused. When the file cannot be deleted the registration is put back,
 * after a file that is gone is restored. A registered name whose file is
 * missing loses its registration, with a warning. Refused before anything
 * is changed when project.c3proj changed on disk during the call
 * (StaleFileError, thrown).
 */
export async function deleteFlowchartFiles(
  reader: Reader,
  writer: Writer,
  name: string,
  folders: readonly string[],
): Promise<DeleteOutcome> {
  const label = flowchartLabel(name, folders);
  const filePath = await existingSpelling(flowchartFilePath(reader.getProjectDir(), name, folders));
  const statePath = await existingSpelling(uistatePath(filePath));
  // The states the files are deleted in; null: there is no such file
  const fileSeen = await statFileState(filePath);
  const stateSeen = await statFileState(statePath);
  await writer.assertProjectFileCurrent();
  const target: DeleteTarget = { name, folders, filePath, label, existed: fileSeen !== null };
  const round = { removed: false };
  try {
    await writer.updateProject(project => {
      round.removed = false;
      unregisterFlowchart(project, name, folders);
      round.removed = true;
    });
  } catch (error) {
    return { ok: false, message: await failedUnregisterMessage(reader, writer, error, target, round.removed) };
  }
  let backupFile: string | undefined;
  try {
    // With the state seen before the call, also for a file that was not there: one that appeared since is refused
    backupFile = await writer.deleteFile(filePath, { expected: fileSeen });
  } catch (error) {
    return { ok: false, message: await failedFileDeleteMessage(reader, writer, error, target) };
  }
  const warnings = fileSeen === null ? [`${label} was not found; only the registration was removed.`] : [];
  warnings.push(...await deleteEditorStateFile(writer, statePath, stateSeen));
  return { ok: true, backupFile, warnings };
}
