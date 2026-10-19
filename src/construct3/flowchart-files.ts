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
