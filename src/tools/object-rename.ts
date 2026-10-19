/**
 * rename_object_type and rename_family (#ISSUE): rename an object type or a
 * family with what names it (object-name-references.ts): in event sheets
 * the condition and action objects, custom action owners, the family of a
 * custom action call, object parameters, the object of an instance variable
 * parameter and "Name.member" expressions; for an object type also the
 * layout instances, its own single-global instance, the families that list
 * it, the containers in project.c3proj, its frame image files in images/ and
 * its tilemap brush file. Strings, scripts, variable values, timeline
 * tracks, flowchart nodes and other names in expressions that may name it
 * are listed in possibleReferences and never changed.
 *
 * The writes go in this order: the event sheets, layouts and families that
 * name it; the object type or family under its new name (its folder and
 * SID kept); its entry in project.c3proj, in place, with the containers in
 * the same write (renameInProject); the frame image files; the tilemap
 * brush file; the old file, deleted and kept as .bak; then the editor's view
 * state (rename-files.ts says why). A failure is rolled back by
 * rollBackRename, which renames the image files back and puts the brush file
 * back when a later write fails. rename_object_type runs under the
 * animation lock for the whole call, as the animation tools do, since it
 * renames frame image files.
 *
 * Timeline tracks are not rewritten: no editor save has shown where a track
 * names its object, so a timeline holding the name as a value is listed, and
 * the timelines searched are named in a warning.
 *
 * The new name must be one an expression can name the object by
 * (objectNameProblem): Name.X is written with it.
 *
 * A run that stopped midway is finished by the same call, as for
 * rename_event_sheet: a leftover new file holding the object's SID is
 * written over, and an object type or family registered under the new name
 * already, whose old file itself still holds the same SID, gets the writes
 * after the project update (stoppedRun in the result).
 */

import { z } from 'zod';
import { readdir, readFile } from 'fs/promises';
import { dirname, join, relative, sep } from 'path';
import type { MutationToolDeps } from './shared.js';
import type { EventSheet, Layout } from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError } from './shared.js';
import { findNameClash, nameKey } from '../construct3/names.js';
import { ProjectReadError, classifyReadError } from '../construct3/project-reader.js';
import { functionsObjectName } from '../construct3/event-shapes.js';
import {
  builtinObjectClassClashMessage,
  findBuiltinObjectClassClash,
  findObjectClassNameClash,
  objectClassNameClashMessage,
} from '../construct3/analyzers/load-rules.js';
import {
  blocksWithoutForce,
  checkUnscannedFiles,
  describeReadFailure,
  listSome,
  unscannedFields,
  unscannedFilesOf,
  unscannedRefusal,
  unscannedWarnings,
  type UnscannedFile,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
import { indexImageFiles, simulateImageRenames, type ImageFileRename } from '../construct3/animation-rename.js';
import { namedAfterAnyObject, objectImageFiles } from '../construct3/object-images.js';
import { containerMemberships, renameContainerMember } from '../construct3/containers.js';
import {
  findFamilyMemberUses,
  findFlowchartNodeUses,
  findInstanceTypeUses,
  findObjectNameUsesInSheets,
  objectNameUseLocation,
  projectVariableNames,
  renameFamilyMember,
  renameInstanceTypes,
  renameObjectInSheet,
  renameSingleGlobalInstanceType,
  scriptReadsObject,
  type InstanceVariableObjects,
  type ObjectNameUse,
} from '../construct3/object-name-references.js';
import { jsonTextStyleOf, parseJsonText, serializeJson } from '../construct3/json-format.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { StaleFileError, fileKey, noteFileWritten, statFileState } from '../construct3/disk-state.js';
import { EntityWriteError } from '../construct3/project-writer.js';
import { readRegisteredTimelines, type RegisteredTimeline } from './timeline-tools.js';
import {
  assertUnchangedSinceRead,
  entityFileSegments,
  moveFileForRename,
  moveViewStateFiles,
  newFileState,
  newSideWrites,
  reasonOf,
  readForRename,
  rollBackRename,
  scriptFileUses,
  stoppedRename,
  type ReadForRename,
  type ViewStateMove,
} from './rename-files.js';
import { nothingChanged, unknownKeysErrorMap } from './event-helpers.js';
import { withProjectSync } from './project-sync.js';

type Category = 'objectTypes' | 'families';
type Reader = MutationToolDeps['reader'];
type Writer = MutationToolDeps['writer'];

const KINDS = {
  objectTypes: { tool: 'rename_object_type', label: 'object type', title: 'Object type', category: 'object', listTool: 'list_objects' },
  families: { tool: 'rename_family', label: 'family', title: 'Family', category: 'family', listTool: 'list_families' },
} as const;

/** The definite uses of each kind, for the warning that lists them. */
const USE_LABELS: Readonly<Record<string, string>> = {
  'objectClass': 'condition or action object(s)',
  'custom action owner': 'custom action owner(s)',
  'custom action family': 'custom action call family name(s)',
  'object parameter': 'object parameter(s)',
  'instance-variable object': 'instance variable parameter object(s)',
  'expression': 'expression(s) that use it as an object',
  'instance type': 'layout instance(s)',
  'family member': 'family member(s)',
};

interface RenameArgs {
  name: string;
  newName: string;
  dryRun: boolean;
  force: boolean;
}

type Start =
  | { mode: 'rename'; own: Record<string, unknown>; leftover?: ReadForRename }
  | { mode: 'finish'; current: Record<string, unknown>; oldRead: ReadForRename };

/**
 * The object of an object-valued "instance-variable" parameter is rewritten
 * (Construct 3 r506-2, Free edition, guest, rewrote it on a rename).
 */
const INSTANCE_VARIABLE_OBJECTS: InstanceVariableObjects = 'rewrite';

/** The most string values of one file the timeline search reads. */
const MAX_SEARCHED_VALUES = 200_000;

/** Every string value in a parsed JSON value (keys left out), depth first; undefined when there are more than MAX_SEARCHED_VALUES (the search would be incomplete). */
function stringValuesOf(value: unknown): string[] | undefined {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (out.push(node) > MAX_SEARCHED_VALUES) return undefined;
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (typeof node === 'object' && node !== null) {
      for (const item of Object.values(node)) stack.push(item);
    }
  }
  return out;
}

/** What Construct 3 r506-2 (Free edition, guest) removed from a name typed in the editor: spaces, ".", "-" and "$". */
const EDITOR_REMOVED = /[\s.\-$]/g;

/**
 * Why a new object type or family name cannot be used in expressions, or
 * undefined. Expressions name an object by a run of letters, digits and
 * underscores (the reference index's EXPRESSION_OBJECT_TOKEN), so a name
 * with a space would be written as "Big Alpha.X", which reads as two names.
 * The editor removed the spaces and punctuation it was given; the form it
 * would have produced is suggested.
 */
function objectNameProblem(newName: string): string | undefined {
  if (!/\s/.test(newName)) return undefined;
  const edge = newName !== newName.trim();
  const editorForm = newName.replace(EDITOR_REMOVED, '');
  const suggestion = editorForm !== '' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(editorForm)
    ? ` Typed in the Construct 3 editor (r506-2, Free edition, guest), the spaces are removed, which gives "${editorForm}".`
    : '';
  return edge
    ? `The new name "${newName}" starts or ends with a space, which this tool does not accept.${suggestion}`
    : `"${newName}" has a space, and expressions cannot name an object type or family by a name with a space `
      + `("${newName}.X" would read as two names). Choose a name of letters, digits and underscores.${suggestion}`;
}

/** The editor's form of a name that has punctuation the editor removes, as a sentence to add to a refusal, or ''. */
function punctuationSuggestion(newName: string): string {
  const editorForm = newName.replace(EDITOR_REMOVED, '');
  return editorForm !== newName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(editorForm)
    ? ` Typed in the Construct 3 editor (r506-2, Free edition, guest), the punctuation is removed, which gives "${editorForm}".`
    : '';
}

/** A tilemap brush file moved with its object type. */
interface BrushMove {
  read: ReadForRename;
  /** Absolute path of the new name */
  to: string;
  from: string;
  label: string;
  /** 'move': write the new name, then delete the old; 'finish-delete': the new name holds the old bytes already, only the old name goes */
  state: 'move' | 'finish-delete';
}

interface RenamePlan {
  category: Category;
  oldName: string;
  newName: string;
  subfolder: string | undefined;
  start: Start;
  variableNames: ReadonlySet<string>;
  referencing: ObjectNameUse[];
  images: ImageFileRename[];
  brush: BrushMove | undefined;
  views: ViewStateMove[];
  /** Whether the object type's own single-global instance names it */
  singleGlobal: boolean;
  /** Filled while the view-state files move: the editor's view state that still names the old name */
  declinedViews: string[];
  result: Record<string, unknown>;
  warnings: string[];
}

const refuse = (message: string) => toolError(nothingChanged(message));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An error as a message may show it: an fs error (it carries a code and a
 * path) becomes a plain error with its code and the file's path in the
 * project, since its own message spells the absolute path. A stale-file
 * error and an entity write error are returned as they are (the writer
 * words them).
 */
function withoutAbsolutePath(writer: Writer, error: unknown): unknown {
  if (error instanceof StaleFileError || error instanceof EntityWriteError) return error;
  if (error instanceof ProjectReadError) {
    // Its message spells the absolute path of the file; the cause names it by code and project path
    const head = /^Failed to read [^"]*"[^"]*"/.exec(error.message)?.[0] ?? 'Failed to read a file';
    return new Error(`${head}: ${reasonOf(error.cause ?? error, file => writer.projectRelative(file))}`);
  }
  const { code, path } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; path?: unknown };
  return typeof code === 'string' && typeof path === 'string' ? new Error(reasonOf(error, file => writer.projectRelative(file))) : error;
}

/**
 * The frame image renames of an object type renamed from `oldName` to
 * `newName`: each image its frames or single image use (objectImageFiles),
 * from lower("<old>...") to lower("<new>..."), as the editor names them
 * (object-images.ts). A refusal when a file is used by another object type
 * as well, or is named after an object type whose file could not be
 * parsed (either may need it under its name, as delete_object leaves such
 * files), or when a new name is taken by a file not renamed away first.
 */
export function planObjectImageRenames(
  oldName: string, newName: string, objectType: unknown, files: readonly string[],
  others: ReadonlyMap<string, unknown>, unparsed: readonly string[],
): { renames: ImageFileRename[] } | { refusal: string } {
  const index = indexImageFiles(files);
  const own = objectImageFiles(oldName, objectType, files, index);
  if (own.length === 0) return { renames: [] };
  const shared = new Set<string>();
  for (const [name, other] of others) {
    const stored = isRecord(other) && typeof other.name === 'string' && other.name !== '' ? other.name : name;
    for (const file of objectImageFiles(stored, other, files, index)) if (own.includes(file)) shared.add(file);
  }
  if (shared.size > 0) {
    return { refusal: `Image file(s) of "${oldName}" are used by another object type as well (the same file name): `
      + `${listSome([...shared].map(f => `images/${f}`))}. Renaming them would take them from that object type. Rename it in the Construct 3 editor.` };
  }
  const unknownUse = own.filter(namedAfterAnyObject(unparsed));
  if (unknownUse.length > 0) {
    return { refusal: `Image file(s) of "${oldName}" are named after an object type whose file could not be parsed, which may use them: `
      + `${listSome(unknownUse.map(f => `images/${f}`))}. Repair that file first, or rename the object type in the Construct 3 editor.` };
  }
  const oldKey = nameKey(oldName);
  const prefix = newName.toLowerCase();
  const renames = own.map(from => ({ from, to: `${prefix}${nameKey(from).slice(oldKey.length)}` }));
  const { clashes } = simulateImageRenames(files, renames);
  if (clashes.length > 0) {
    return { refusal: `The image files of "${oldName}" would be renamed to ${listSome(clashes.map(c => `images/${c.to}`))}, which already exist(s). `
      + 'Check these files and remove them if nothing uses them, or choose another name.' };
  }
  return { renames };
}

/**
 * The editor's view state of a renamed object type: its entry in
 * objecttypes.uistate.json, in the file's own text style. A file that still
 * names the old name but cannot be read as a list of entries is added to
 * `declined` and left as it is.
 */
function viewStateMoves(category: Category, oldName: string, newName: string, declined: string[]): ViewStateMove[] {
  if (category !== 'objectTypes') return [];
  const key = nameKey(oldName);
  const file = 'objecttypes.uistate.json';
  return [{
    from: [file],
    to: [file],
    rewrite: text => {
      const mentionsOldName = text.toLowerCase().includes(`"${oldName.toLowerCase()}"`);
      let entries: unknown;
      try {
        entries = parseJsonText(text);
      } catch {
        if (mentionsOldName) declined.push(file);
        return text;
      }
      if (!Array.isArray(entries)) {
        if (mentionsOldName) declined.push(file);
        return text;
      }
      let changed = false;
      const next = entries.map(entry => {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && nameKey(entry[0]) === key) {
          changed = true;
          return [newName, ...entry.slice(1)];
        }
        return entry;
      });
      return changed ? serializeJson(next, jsonTextStyleOf(text)) : text;
    },
  }];
}

/** A use as tool results list it, in the file `fileOf` names (project-relative, with its folder and extension). */
function useEntry(use: ObjectNameUse, fileOf: (use: ObjectNameUse) => string): Record<string, unknown> {
  return {
    in: fileOf(use),
    kind: use.kind,
    ...(use.eventPath !== undefined ? { path: use.eventPath } : {}),
    ...(use.ace !== undefined ? { ace: use.ace } : {}),
    ...(use.uid !== undefined ? { uid: use.uid } : {}),
    ...(use.parameter !== undefined ? { parameter: use.parameter } : {}),
    value: use.value,
  };
}

/** What planBrush found: the move to make, or why not. */
interface BrushPlan {
  brush?: BrushMove;
  /** Label of a brush file under the new name that a run of this rename left */
  alreadyMoved?: string;
  refusal?: string;
  /** Project-relative path of the brush file when it is not in the object type's own folder */
  foundAt?: string;
  /** More brush files than the search reads: the search may have missed some */
  capped?: boolean;
}

/** Brush files named `<name>.brush.json` (ignoring case) anywhere below tilemapBrushes/: absolute paths, and whether the search stopped at its limit. */
async function findBrushFiles(projectDir: string, names: readonly string[]): Promise<{ found: Map<string, string[]>; capped: boolean }> {
  const keys = new Map(names.map(name => [nameKey(`${name}.brush.json`), name] as const));
  const found = new Map<string, string[]>(names.map(name => [name, []]));
  let seen = 0;
  let capped = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > 20_000 || depth > 8) {
        capped = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (keys.has(nameKey(entry.name))) found.get(keys.get(nameKey(entry.name)) as string)?.push(full);
    }
  };
  await walk(resolveProjectPath(projectDir, 'tilemapBrushes'), 0);
  return { found, capped };
}

/**
 * The tilemap brush file of an object type: found by its name below
 * tilemapBrushes/ (the object type's own folder is tilemapBrushes/objectTypes/
 * <folders>/), in whatever state a run of this rename that stopped left it:
 * not moved yet, moved already, or written under the new name with the old
 * name still there. A brush file under the old name in another folder moves
 * within that folder (foundAt says so); several of them, a file under the new
 * name that no stopped run left, and a new name that holds other content are
 * refusals.
 */
async function planBrush(reader: Reader, subfolder: string | undefined, oldName: string, newName: string, finishing: boolean): Promise<BrushPlan> {
  const projectDir = reader.getProjectDir();
  const relativeLabel = (full: string) => relative(projectDir, full).split(sep).join('/');
  const ownDir = resolveProjectPath(projectDir, 'tilemapBrushes', 'objectTypes', ...(subfolder ? subfolder.split('/') : []));
  const { found, capped } = await findBrushFiles(projectDir, [oldName, newName]);
  const olds = found.get(oldName) ?? [];
  const news = found.get(newName) ?? [];
  const inOwnDir = olds.find(file => dirname(file) === ownDir);
  if (inOwnDir === undefined && olds.length > 1) {
    return { refusal: `More than one brush file is named after "${oldName}": ${listSome(olds.map(relativeLabel))}. Check which one belongs to it, or rename the object type in the Construct 3 editor.`, capped };
  }
  const source = inOwnDir ?? olds[0];
  if (source === undefined) {
    if (news.length === 0) return { capped };
    if (finishing) return { alreadyMoved: relativeLabel(news[0]), capped };
    return { refusal: `A brush file named after the new name already exists (${listSome(news.map(relativeLabel))}), and no brush file of "${oldName}" is there to take its place. `
      + 'It would belong to the renamed object type. Move or delete it, or choose another name.', capped };
  }
  const read = await readForRename(source);
  const toPath = join(dirname(source), `${newName}.brush.json`);
  const taken = await findFileIgnoringCase(toPath);
  const toRead = taken !== undefined ? await readForRename(taken) : undefined;
  const from = relativeLabel(source);
  const label = relativeLabel(toPath);
  const foundAt = source === inOwnDir ? {} : { foundAt: from };
  if (toRead?.bytes) {
    // Both names: a run that stopped after writing the new name, when it holds exactly the old bytes
    if (taken !== toPath || !read.bytes?.equals(toRead.bytes)) {
      return { refusal: `The brush file of "${oldName}" would be renamed to ${label}, which already exists with other content.`, capped };
    }
    return { brush: { read, to: toPath, from, label, state: 'finish-delete' }, ...foundAt, capped };
  }
  return { brush: { read, to: toPath, from, label, state: 'move' }, ...foundAt, capped };
}

/**
 * Decide the rename: every check and refusal, the references, and the
 * dry run or rename_blocked result, before anything is written. Returns a
 * tool result to return as it is, or the rename to apply.
 */
async function planRename(reader: Reader, writer: Writer, category: Category, args: RenameArgs): Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError> | RenamePlan> {
  const kind = KINDS[category];
  const { name: oldName, newName } = args;
  const nameProblem = objectNameProblem(newName);
  if (nameProblem) return refuse(nameProblem);
  try {
    validateName(newName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shown = message.startsWith('Name must start') ? 'Name must start with a letter or underscore and contain only letters, digits and underscores' : message;
    return refuse(`${shown}.${punctuationSuggestion(newName)}`);
  }
  if (newName === oldName) return refuse(`${kind.title} "${oldName}" already has this name.`);
  if (nameKey(newName) === nameKey(oldName)) {
    return refuse(`Renaming "${oldName}" to "${newName}" changes only the letter case, which this tool does not do: on Windows `
      + `and macOS both names are the same file. Rename it to another name first, then to "${newName}".`);
  }
  const objectTypes = await reader.listObjectTypes();
  const families = await reader.listFamilies();
  const registered = category === 'objectTypes' ? objectTypes : families;
  const spelled = findNameClash(oldName, registered);
  if (spelled !== undefined && spelled !== oldName) {
    return refuse(`${kind.title} "${oldName}" is named "${spelled}" in the project. Use name "${spelled}".`);
  }
  let start: Start;
  if (spelled === undefined) {
    const stopped = registered.includes(newName) ? await stoppedRename(reader, writer, category, oldName, newName) : undefined;
    if (stopped === undefined) {
      const nearest = category === 'objectTypes' ? reader.findNearestName(oldName, 'objects') : [];
      return refuse(notFoundError(kind.title, oldName, nearest, kind.listTool).content[0].text);
    }
    start = { mode: 'finish', ...stopped };
  } else {
    // The entity's own name cannot clash: a new name equal to it ignoring case was refused above
    const clash = findObjectClassNameClash(newName, objectTypes, families);
    if (clash) return refuse(objectClassNameClashMessage(newName, clash));
    const builtin = findBuiltinObjectClassClash(newName, functionsObjectName(reader));
    if (builtin) return refuse(builtinObjectClassClashMessage(newName, builtin));
    let own: Record<string, unknown>;
    try {
      own = (category === 'objectTypes' ? await reader.readObjectType(oldName) : await reader.readFamily(oldName)) as unknown as Record<string, unknown>;
    } catch (error) {
      const code = classifyReadError(error);
      const file = reader.getEntityRelativePath(category, oldName);
      return refuse(code === 'E_FILE_NOT_FOUND'
        ? `The file of ${kind.label} "${oldName}" (${file}) does not exist, so there is nothing to rename.`
        : `The file of ${kind.label} "${oldName}" (${file}) could not be parsed (${describeReadFailure(code)}), so it cannot be `
          + 'renamed here: its "name" must change with its file name. Rename it in the Construct 3 editor.');
    }
    const leftover = await newFileState(reader, writer, category, writer.getSubfolderForEntity(category, oldName), newName, own.sid);
    if (leftover.state === 'other') return refuse(leftover.refusal);
    start = { mode: 'rename', own, ...(leftover.state === 'stopped-run' ? { leftover: leftover.read } : {}) };
  }
  const subfolder = writer.getSubfolderForEntity(category, start.mode === 'rename' ? oldName : newName);
  const ownData = start.mode === 'rename' ? start.own : start.current;

  // Every place that names it, read before any write
  const sheets = await reader.readAllEventSheets();
  const skipped: UnscannedFile[] = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, reader.getReadFailures('eventSheets'));
  const variableNames = projectVariableNames(sheets);
  const uses: ObjectNameUse[] = findObjectNameUsesInSheets(sheets, oldName, INSTANCE_VARIABLE_OBJECTS);
  // Project script files: listed, never changed
  const scripts = await scriptFileUses(reader, line => scriptReadsObject(line, oldName));
  for (const { path: file, line } of scripts.lines) {
    uses.push({ category: 'scripts', file: file.replace(/^scripts\//, ''), kind: 'script', value: line, definite: false });
  }
  // Flowchart nodes: what a node's "c" holds is not known, so a node that has the name is listed
  const flowcharts = new Map<string, unknown>();
  const flowchartsUnread: string[] = [];
  for (const file of await reader.listDataFiles('flowcharts')) {
    try {
      flowcharts.set(file, parseJsonText(await reader.readDataFileText('flowcharts', file)));
    } catch {
      flowchartsUnread.push(`flowcharts/${file}`);
    }
  }
  uses.push(...findFlowchartNodeUses(flowcharts, oldName));

  const project = reader.getProject() as unknown as Record<string, unknown>;
  // Timelines with a value that is the name: their track shape is not verified, so they are listed, never changed
  const trackLists: RegisteredTimeline[] = [];
  const timelinesChecked: RegisteredTimeline[] = [];
  let timelinesUnread: string | undefined;
  let images: ImageFileRename[] = [];
  let containers: Array<{ index: number; members: string[] }> = [];
  let brush: BrushMove | undefined;
  let brushMoved: string | undefined;
  let brushFoundAt: string | undefined;
  let brushSearchCapped = false;
  let brushMissing = false;
  let singleGlobal = false;
  if (category === 'objectTypes') {
    const layouts = await reader.readAllLayouts();
    skipped.push(...unscannedFilesOf('layouts', await reader.listLayouts(), layouts, reader.getReadFailures('layouts')));
    uses.push(...findInstanceTypeUses(layouts, oldName));
    const familyFiles = await reader.readAllFamilies();
    skipped.push(...unscannedFilesOf('families', families, familyFiles, reader.getReadFailures('families')));
    uses.push(...findFamilyMemberUses(familyFiles, oldName));
    containers = (containerMemberships(project).get(nameKey(oldName)) ?? []).map(({ index, members }) => ({ index, members }));
    singleGlobal = start.mode === 'rename' && isRecord(ownData['singleglobal-inst'])
      && typeof ownData['singleglobal-inst'].type === 'string' && nameKey(ownData['singleglobal-inst'].type) === nameKey(oldName);
    const scan = await readRegisteredTimelines(reader.getProjectDir(), project.timelines);
    const unsearched = [...scan.unreadable];
    for (const timeline of scan.timelines) {
      const values = stringValuesOf(timeline.data);
      if (values === undefined) {
        unsearched.push(`${timeline.file} (more than ${MAX_SEARCHED_VALUES} values, not searched to the end)`);
        continue;
      }
      timelinesChecked.push(timeline);
      if (values.some(value => nameKey(value) === nameKey(oldName))) trackLists.push(timeline);
    }
    if (unsearched.length > 0) {
      timelinesUnread = `Timeline file(s) that could not be read, parsed or searched may have tracks of this object type: ${listSome(unsearched)}.`;
    }
    const objectTypeFiles = await reader.readAllObjectTypes();
    const others = new Map([...objectTypeFiles].filter(([name]) => name !== oldName && name !== newName));
    const unparsed = unscannedFilesOf('objectTypes', objectTypes, objectTypeFiles, reader.getReadFailures('objectTypes')).map(f => f.name);
    const planned = planObjectImageRenames(oldName, newName, ownData, await writer.listImageFiles(), others, unparsed);
    if ('refusal' in planned) return refuse(planned.refusal);
    images = planned.renames;
    const brushPlan = await planBrush(reader, subfolder, oldName, newName, start.mode === 'finish');
    if (brushPlan.refusal !== undefined) return refuse(brushPlan.refusal);
    brush = brushPlan.brush;
    brushMoved = brushPlan.alreadyMoved;
    brushFoundAt = brushPlan.foundAt;
    brushSearchCapped = brushPlan.capped === true;
    brushMissing = brush === undefined && brushMoved === undefined && ownData['plugin-id'] === 'Tilemap';
  }
  const unscanned = await checkUnscannedFiles(reader, skipped, [
    { categories: category === 'objectTypes' ? ['eventSheets', 'layouts', 'families'] : ['eventSheets'], allOf: [[nameTerm(oldName)]] },
  ]);
  const definite = uses.filter(u => u.definite);
  const possible = uses.filter(u => !u.definite);
  const oldFile = entityFileSegments(category, subfolder, oldName).join('/');
  const newFile = entityFileSegments(category, subfolder, newName).join('/');
  const referencing = [...new Map(definite.map(u => [`${u.category}/${u.file}`, u] as const)).values()];
  const fileOf = (use: ObjectNameUse): string => {
    switch (use.category) {
      case 'scripts': return `scripts/${use.file}`;
      case 'flowcharts': return `flowcharts/${use.file}`;
      default: return reader.getEntityRelativePath(use.category, use.file);
    }
  };
  // After a rename the object type's own file is the one under its new name; a dry run names the files as they are
  const ownFileLabel = args.dryRun ? oldFile : newFile;
  const references = [
    ...definite.map(use => useEntry(use, fileOf)),
    ...(singleGlobal ? [{ in: ownFileLabel, kind: 'single-global instance type', value: oldName }] : []),
    ...(start.mode === 'rename' ? containers.map(c => ({ in: 'project.c3proj', kind: 'container member', path: `containers[${c.index}]`, value: oldName })) : []),
  ];
  const possibleList = [
    ...possible.map(use => useEntry(use, fileOf)),
    ...trackLists.map(t => ({ in: t.file, kind: 'timeline track', value: oldName })),
  ];
  const possibleReferences = possibleList.length > 0 ? { possibleReferences: possibleList } : {};

  if ((blocksWithoutForce(unscanned) || timelinesUnread) && !args.force) {
    return toolResult({
      success: false,
      entity: oldName,
      category: kind.category,
      action: 'rename_blocked',
      message: `${[unscannedRefusal(unscanned), timelinesUnread].filter(Boolean).join(' ')} References there would NOT be updated. `
        + 'Use force=true to rename anyway (references in these files will NOT be updated). Nothing was changed.',
      references,
      ...possibleReferences,
      ...unscannedFields(unscanned),
    });
  }

  const would = args.dryRun ? 'Would point' : 'Pointed';
  const warnings: string[] = [];
  if (start.mode === 'finish') {
    warnings.push(`"${newName}" is registered already and ${oldFile} still holds the same ${kind.label}: an earlier rename stopped `
      + `after its project update. ${args.dryRun ? 'This call would finish it' : 'This call finished it'}.`);
  }
  for (const useKind of Object.keys(USE_LABELS)) {
    const ofKind = definite.filter(u => u.kind === useKind);
    if (ofKind.length > 0) {
      warnings.push(`${would} ${ofKind.length} ${USE_LABELS[useKind]} that named "${oldName}" at "${newName}": ${listSome(ofKind.map(objectNameUseLocation))}.`);
    }
  }
  if (singleGlobal) {
    warnings.push(`${would} the single-global instance of "${oldName}" at "${newName}": ${ownFileLabel}.`);
  }
  if (start.mode === 'rename' && containers.length > 0) {
    warnings.push(`${args.dryRun ? 'Would rename' : 'Renamed'} "${oldName}" in ${containers.length} container(s) of project.c3proj, in the same write as its entry.`);
  }
  if (images.length > 0) {
    warnings.push(`${args.dryRun ? 'Would rename' : 'Renamed'} ${images.length} image file(s) in images/ (images/${images[0].from} to images/${images[0].to}${images.length > 1 ? ', ...' : ''}).`);
  }
  if (brush !== undefined) {
    warnings.push(`${args.dryRun ? 'Would move' : 'Moved'} the tilemap brush file ${brush.from} to ${brush.label}.`);
  }
  if (brush !== undefined && brushFoundAt !== undefined) {
    warnings.push(`The brush file of "${oldName}" is ${brushFoundAt}, not in the folder of the object type; it ${args.dryRun ? 'would stay' : 'stays'} in the folder it is in.`);
  }
  if (brushMissing) {
    warnings.push(`"${oldName}" is a Tilemap, and no brush file named after it was found below tilemapBrushes/, so none ${args.dryRun ? 'would be' : 'was'} renamed.`);
  }
  if (brushSearchCapped) {
    warnings.push('The search below tilemapBrushes/ stopped at its limit of entries, so a brush file of this object type may have been missed.');
  }
  if (brushMoved !== undefined) {
    warnings.push(`The tilemap brush file was moved to ${brushMoved} already (brush file already moved by the earlier run).`);
  }
  if (possible.length > 0) {
    warnings.push(`${possible.length} other expression(s), string(s), script line(s), flowchart node(s), parameter name(s) or variable value(s) may name "${oldName}" (e.g. Create object (by name), `
      + `runtime.objects.${oldName} in a script, a bare name an event variable may share) and ${args.dryRun ? 'would' : 'were'} NOT `
      + `${args.dryRun ? 'be ' : ''}changed: ${listSome(possible.map(objectNameUseLocation))}.`);
  }
  if (scripts.unreadable.length > 0) {
    warnings.push(`Script file(s) that could not be read were not searched for "${oldName}": ${listSome(scripts.unreadable)}.`);
  }
  if (flowchartsUnread.length > 0) {
    warnings.push(`Flowchart file(s) that could not be read or parsed were not searched for "${oldName}": ${listSome(flowchartsUnread)}.`);
  }
  if (trackLists.length > 0) {
    warnings.push(`${trackLists.length} timeline(s) have a value that is "${oldName}", which may be the object type of a track; they ${args.dryRun ? 'would' : 'were'} NOT `
      + `${args.dryRun ? 'be ' : ''}changed, since the track shape has not been checked against an editor save: `
      + `${listSome(trackLists.map(t => `"${t.name}"`))}. Check them in the Construct 3 editor.`);
  }
  const unlisted = timelinesChecked.filter(t => !trackLists.includes(t));
  if (unlisted.length > 0) {
    warnings.push(`The tracks of ${unlisted.length} timeline(s) were searched only for a value equal to "${oldName}", since the track shape has not been checked `
      + `against an editor save, so a track of this object type may be missed: ${listSome(unlisted.map(t => `"${t.name}"`))}.`);
  }
  warnings.push(...unscannedWarnings(unscanned, args.dryRun ? 'Would rename' : 'Renamed'));
  if (timelinesUnread) warnings.push(`${args.dryRun ? 'Would rename' : 'Renamed'} with force=true: ${timelinesUnread} They were NOT updated.`);

  const common = {
    entity: oldName,
    category: kind.category,
    references,
    ...possibleReferences,
    ...(images.length > 0 ? { imageRenames: images.map(r => ({ from: `images/${r.from}`, to: `images/${r.to}` })) } : {}),
    ...(start.mode === 'finish' ? { stoppedRun: true } : {}),
    ...(brushMissing ? { brushFileFound: false } : {}),
    ...unscannedFields(unscanned),
  };
  if (args.dryRun) {
    return toolResult({
      success: true,
      dryRun: true,
      action: 'would_rename',
      newName,
      ...common,
      filesToWrite: [
        ...referencing.map(u => fileOf(u)),
        ...(start.mode === 'rename' ? [newFile, 'project.c3proj'] : []),
        ...images.map(r => `images/${r.to}`),
        ...(brush?.state === 'move' ? [brush.label] : []),
      ],
      fileToDelete: oldFile,
      ...(brush?.state === 'finish-delete' ? { brushFileToDelete: brush.from } : {}),
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }
  const declinedViews: string[] = [];
  return {
    category, oldName, newName, subfolder, start, variableNames, singleGlobal, brush, images, declinedViews,
    referencing: referencing.filter(u => u.category === 'eventSheets' || u.category === 'layouts' || u.category === 'families'),
    views: viewStateMoves(category, oldName, newName, declinedViews),
    result: { ...common, fileDeleted: oldFile },
    warnings,
  };
}

/**
 * After the writer's delete of a file read for the call threw something other
 * than a stale-file error: record what the call demonstrably changed. The
 * file is gone: put back from the bytes read. It holds its bytes from before:
 * nothing to record. It holds other bytes, or cannot be read: named as left.
 */
async function recordFailedDelete(side: ReturnType<typeof newSideWrites>, read: ReadForRename): Promise<void> {
  try {
    const state = await statFileState(read.path);
    if (state === null) {
      noteFileWritten(fileKey(read.path), state);
      side.files.push({ path: read.path, before: read.bytes });
      return;
    }
    const now = await readFile(read.path);
    if (read.bytes === null || !now.equals(read.bytes)) side.unresolved.push({ path: read.path, before: read.bytes });
  } catch {
    side.unresolved.push({ path: read.path, before: read.bytes });
  }
}

/** Apply a decided rename (see the module comment for the order); a failure is rolled back and thrown with what is on disk. */
async function applyRename(reader: Reader, writer: Writer, plan: RenamePlan) {
  const { category, oldName, newName, subfolder, start } = plan;
  const side = newSideWrites();
  const filesWritten: string[] = [];
  let backupPath: string | undefined;
  let writing: string | undefined;
  try {
    for (const use of plan.referencing) {
      // Read again: only what still names it is changed
      if (use.category === 'eventSheets') {
        const sheet: EventSheet = await reader.readEventSheet(use.file);
        if (renameObjectInSheet(sheet, oldName, newName, plan.variableNames, INSTANCE_VARIABLE_OBJECTS) === 0) continue;
        await writer.writeEntityFile('eventSheets', use.file, sheet, writer.getSubfolderForEntity('eventSheets', use.file));
      } else if (use.category === 'layouts') {
        const layout: Layout = await reader.readLayout(use.file);
        if (renameInstanceTypes(layout, oldName, newName) === 0) continue;
        await writer.writeEntityFile('layouts', use.file, layout, writer.getSubfolderForEntity('layouts', use.file));
      } else {
        const family = await reader.readFamily(use.file);
        if (renameFamilyMember(family, oldName, newName) === 0) continue;
        await writer.writeEntityFile('families', use.file, family, writer.getSubfolderForEntity('families', use.file));
      }
      filesWritten.push(reader.getEntityRelativePath(use.category as 'eventSheets' | 'layouts' | 'families', use.file));
    }
    if (start.mode === 'rename') {
      // A copy: the reader's own object is not changed, so a failed call leaves it as it was read
      const own = structuredClone(start.own);
      own.name = newName;
      if (plan.singleGlobal) renameSingleGlobalInstanceType(own, oldName, newName);
      // The stopped run's leftover is written over only while it is as read
      if (start.leftover) await assertUnchangedSinceRead(writer, start.leftover);
      await writer.writeEntityFile(category, newName, own, subfolder, { createOnly: start.leftover === undefined });
      filesWritten.push(entityFileSegments(category, subfolder, newName).join('/'));
      writing = reader.getProjectPath();
      // The checks made before the first write, again, on project.c3proj as the update reads it: object types and families share one namespace
      const recheck = { expectedFolder: subfolder ? subfolder.split('/') : [], clashesWith: ['objectTypes', 'families'] as const };
      await writer.renameInProject(category, oldName, newName, category === 'objectTypes'
        ? { ...recheck, alsoChange: project => { renameContainerMember(project, oldName, newName); } }
        : recheck);
      writing = undefined;
      filesWritten.push('project.c3proj');
    }
    if (plan.images.length > 0) {
      // All or nothing: when one rename fails, renameImageFiles renames the others back itself
      await writer.renameImageFiles(plan.images);
      side.imageRenames.push(...plan.images);
      filesWritten.push(...plan.images.map(r => `images/${r.to}`));
    }
    if (plan.brush?.state === 'move') {
      await moveFileForRename(writer, side, plan.brush.read, plan.brush.to);
      filesWritten.push(plan.brush.label);
    } else if (plan.brush?.state === 'finish-delete') {
      // The new name holds these bytes already; only the old name goes, while it is as read (checked under the writer's lock)
      try {
        await writer.deleteFile(plan.brush.read.path, { expected: plan.brush.read.state });
      } catch (error) {
        if (!(error instanceof StaleFileError)) await recordFailedDelete(side, plan.brush.read);
        throw error;
      }
      side.files.push({ path: plan.brush.read.path, before: plan.brush.read.bytes });
      filesWritten.push(plan.brush.label);
    }
    // The old file last of the writes that matter: a rename that stops before this delete
    // leaves the old file beside the new name, which the same call recognises
    if (start.mode === 'finish') await assertUnchangedSinceRead(writer, start.oldRead);
    backupPath = await writer.deleteEntityFile(category, oldName, subfolder);
  } catch (error) {
    throw new Error(await rollBackRename(writer, withoutAbsolutePath(writer, error), side, writing !== undefined ? { writing } : {}));
  }
  const view = await moveViewStateFiles(writer, reader.getProjectDir(), plan.views);
  const warnings = [
    ...plan.warnings,
    ...view.warnings,
    ...plan.declinedViews.map(file => `The editor's view state ${file} still names "${oldName}": it could not be read as a list of entries, so it was left as it is.`),
  ];
  return toolResult({
    success: true,
    action: 'renamed',
    ...plan.result,
    entity: newName,
    previousName: oldName,
    filesWritten,
    ...(plan.brush !== undefined ? { brushMoved: { from: plan.brush.from, to: plan.brush.label } } : {}),
    ...(view.moved.length > 0 ? { viewStateMoved: view.moved } : {}),
    ...(backupPath !== undefined ? { backupFile: backupPath } : {}),
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

/** The input schema of rename_object_type and rename_family, strict. */
function renameSchema(category: Category) {
  const { tool, label } = KINDS[category];
  return z.object({
    name: z.string().max(200).describe(`Current ${label} name, as registered (letter case included)`),
    newName: z.string().max(200).describe(`New ${label} name (letters, digits and underscores, starting with a letter or underscore, no spaces: expressions name it as Name.X; must not match an object type or family name, "System" or the name of the built-in Functions object, ignoring case; a change of letter case only is refused)`),
    dryRun: z.boolean().optional().default(false).describe('Report the references and files the rename would change, and write nothing'),
    force: z.boolean().optional().default(false).describe('Rename even when files that could not be parsed possibly name it (they are NOT updated; listed in unscannedFiles and a warning)'),
  }, { errorMap: unknownKeysErrorMap(`the arguments of ${tool}`, `${tool} takes name, newName, dryRun and force.`) }).strict();
}

/** Register rename_object_type and rename_family. */
export function registerObjectRenameTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);
  const run = async (category: Category, args: RenameArgs) => {
    const { tool, label } = KINDS[category];
    let planned: Awaited<ReturnType<typeof planRename>>;
    try {
      planned = await planRename(reader, writer, category, args);
    } catch (error) {
      console.error(`[${tool}] failed:`, error);
      return refuse(`The rename stopped before anything was written: ${reasonOf(error, file => writer.projectRelative(file))}.`);
    }
    if ('content' in planned) return planned;
    try {
      return await applyRename(reader, writer, planned);
    } catch (error) {
      console.error(`[${tool}] failed:`, error);
      const shown = withoutAbsolutePath(writer, error);
      return toolError(`Error renaming ${label}: ${shown instanceof Error ? shown.message : String(shown)}`);
    }
  };

  // ─── rename_object_type ───────────────────────────────

  server.registerTool(
    'rename_object_type',
    {
      description: 'Rename an object type and update what names it: in event sheets the condition and action objects, custom action '
        + 'owners, object parameters, the object of an instance variable parameter and expressions that use it as an object (Name.X, Name(0).X); '
        + 'the layout instances of it, its own single-global instance, the families and containers that list it, its frame image files in images/, '
        + 'its tilemap brush file, its entry in project.c3proj (it keeps its folder and place) and its file name (the old file is kept as .bak). '
        + 'Names are matched ignoring case. The new name must have no spaces. Strings (Create object (by name)), scripts and project '
        + 'script files (runtime.objects.Name), timeline tracks, flowchart nodes, variable values and other names in expressions that may name it are '
        + 'listed in possibleReferences, never changed. A failure midway puts back what the call wrote, except a file another write changed since, '
        + 'which is named; running the same call again finishes a rename that stopped. Event sheets, layouts and families that could not be parsed, '
        + 'and timelines that could not be read, refuse without force when they possibly name it (rename_blocked). Runs one at a time with the '
        + 'animation tools. Use dryRun first.',
      inputSchema: renameSchema('objectTypes'),
    },
    // The whole call under the animation lock: it renames frame image files, as the animation tools do
    args => writer.withAnimationLock(() => run('objectTypes', args)),
  );

  // ─── rename_family ────────────────────────────────────

  server.registerTool(
    'rename_family',
    {
      description: 'Rename a family and update what names it: in event sheets the condition and action objects, custom action owners '
        + 'and the family of a custom action call, object parameters, the object of an instance variable parameter and expressions that use it '
        + 'as an object (Fam.X); its entry in project.c3proj (it keeps its folder and place) and its file name (the old file is kept as .bak). '
        + 'A family has no instances, containers or images of its own. Strings, scripts, flowchart nodes, variable values and other names in '
        + 'expressions that may name it are listed in possibleReferences, never changed. Dry run, refusals, rollback and rerun as for rename_object_type.',
      inputSchema: renameSchema('families'),
    },
    args => run('families', args),
  );
}
