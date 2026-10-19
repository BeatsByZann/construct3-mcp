/**
 * rename_event_sheet and rename_layout (#ISSUE): rename an event sheet or a
 * layout with what names it (entity-name-references.ts): the include
 * events and layout bindings of an event sheet; the "layout" parameters
 * (System Go to layout), the startup layout and the timelines that start
 * on a layout. Strings, script lines, project script files and variable
 * values that may name a layout or sheet are listed in possibleReferences
 * and never changed.
 *
 * The writes go in this order: the event sheets and layouts that name it;
 * the entity under its new name (its folder and SID kept); its entry in
 * project.c3proj, in place (renameInProject); the timelines; the old file,
 * deleted and kept as .bak; then the editor's view-state files
 * (rename-files.ts says why). A failure is rolled back by rollBackRename.
 *
 * A run that stopped midway (the process ended) is finished by the same
 * call: the references it pointed at the new name are not found again; a
 * file for the new name that is not registered, is spelled as the new name
 * and holds the entity's SID is the stopped run's and is written over; and
 * when the entity is registered under the new name already and the old
 * file itself is still there with the same SID, the steps after the
 * project update are done (stoppedRun in the result). A finished rename
 * leaves only the old file's .bak, which is no such evidence: the same
 * call repeated answers that the name is not found.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { EventSheet, Layout } from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError, caseClashError } from './shared.js';
import { findNameClash, nameKey } from '../construct3/names.js';
import { classifyReadError } from '../construct3/project-reader.js';
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
import {
  entityNameUseLocation,
  findInstanceVariableValues,
  findLayoutBindings,
  findLayoutNameUses,
  findSheetIncludes,
  ENTITY_REWRITE_POLICY,
  isSameEntityName,
  renameLayoutParameters,
  renameSheetIncludes,
  type EntityNameUse,
} from '../construct3/entity-name-references.js';
import { parseJsonText } from '../construct3/json-format.js';
import { readRegisteredTimelines, timelineFileText, type RegisteredTimeline } from './timeline-tools.js';
import {
  assertUnchangedSinceRead,
  entityFileSegments,
  jsQuotedNamePattern,
  moveViewStateFiles,
  newFileState,
  newSideWrites,
  replaceForRename,
  rollBackRename,
  scriptFileUses,
  stoppedRename,
  type ReadForRename,
  type ViewStateMove,
} from './rename-files.js';
import { nothingChanged, unknownKeysErrorMap } from './event-helpers.js';
import { withProjectSync } from './project-sync.js';

type Category = 'eventSheets' | 'layouts';
type Reader = MutationToolDeps['reader'];
type Writer = MutationToolDeps['writer'];

/** How each renamed kind is named in messages and results. */
const KINDS = {
  eventSheets: { tool: 'rename_event_sheet', label: 'event sheet', title: 'Event sheet', category: 'eventsheet', nearest: 'eventsheets', listTool: 'list_eventsheets' },
  layouts: { tool: 'rename_layout', label: 'layout', title: 'Layout', category: 'layout', nearest: 'layouts', listTool: 'list_layouts' },
} as const;

/** The definite uses of each kind, for the warning that lists them: "2 include(s)". */
const USE_LABELS: Readonly<Record<string, string>> = {
  'include': 'include(s)',
  'eventSheet binding': 'layout event sheet binding(s)',
  'layout parameter': '"layout" parameter(s)',
};

interface RenameArgs {
  name: string;
  newName: string;
  dryRun: boolean;
  force: boolean;
}

/**
 * How the call starts: a rename to make (with the stopped run's leftover
 * new file, read for the write over it), or the rest of one that stopped
 * after its project update (with the old file, read for its delete).
 */
type Start =
  | { mode: 'rename'; own: EventSheet | Layout; leftover?: ReadForRename }
  | { mode: 'finish'; current: Record<string, unknown>; oldRead: ReadForRename };

/** Everything a rename writes, decided before the first write. */
interface RenamePlan {
  category: Category;
  oldName: string;
  newName: string;
  subfolder: string | undefined;
  start: Start;
  referencing: EntityNameUse[];
  startingOn: RegisteredTimeline[];
  views: ViewStateMove[];
  result: Record<string, unknown>;
  warnings: string[];
}

const refuse = (message: string) => toolError(nothingChanged(message));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The text of an event sheet's view-state file with its "name" set to the
 * new name (the editor saves the sheet's name in it). The text is changed
 * in place, so its layout stays; a file that does not hold the old name, or
 * whose changed text does not parse to the same data with the new name, is
 * returned as it is.
 */
export function viewStateWithName(text: string, oldName: string, newName: string): string {
  let data: unknown;
  try {
    data = parseJsonText(text);
  } catch {
    return text;
  }
  if (!isRecord(data) || data.name !== oldName) return text;
  const entry = new RegExp(`("name"\\s*:\\s*)${JSON.stringify(oldName).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`);
  const changed = text.replace(entry, (_all, key: string) => `${key}${JSON.stringify(newName)}`);
  try {
    return JSON.stringify(parseJsonText(changed)) === JSON.stringify({ ...data, name: newName }) ? changed : text;
  } catch {
    return text;
  }
}

/** The editor's view-state files of an event sheet or a layout, moved with it. */
function viewStateMoves(category: Category, subfolder: string | undefined, oldName: string, newName: string): ViewStateMove[] {
  const folders = subfolder ? subfolder.split('/') : [];
  const moves: ViewStateMove[] = [
    {
      from: [category, ...folders, `${oldName}.uistate.json`],
      to: [category, ...folders, `${newName}.uistate.json`],
      ...(category === 'eventSheets' ? { rewrite: (text: string) => viewStateWithName(text, oldName, newName) } : {}),
    },
  ];
  if (category === 'layouts') {
    moves.push({ from: ['layouts', 'uistate', ...folders, `${oldName}.instancesBar.json`], to: ['layouts', 'uistate', ...folders, `${newName}.instancesBar.json`] });
  }
  return moves;
}

/** A use as tool results list it. */
function useEntry(use: EntityNameUse): Record<string, unknown> {
  return {
    in: `${use.category}/${use.file}`,
    kind: use.kind,
    ...(use.eventPath !== undefined ? { path: use.eventPath } : {}),
    ...(use.ace !== undefined ? { ace: use.ace } : {}),
    ...(use.uid !== undefined ? { uid: use.uid } : {}),
    ...(use.parameter !== undefined && use.parameter !== 'script' ? { parameter: use.parameter } : {}),
    value: use.value,
  };
}

/**
 * Decide the rename: every check and refusal, the references, and the
 * dry run or rename_blocked result, before anything is written. Returns a
 * tool result to return as it is, or the rename to apply.
 */
async function planRename(reader: Reader, writer: Writer, category: Category, args: RenameArgs): Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError> | RenamePlan> {
  const kind = KINDS[category];
  const { name: oldName, newName } = args;
  try {
    validateName(newName);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  if (newName === oldName) return refuse(`${kind.title} "${oldName}" already has this name.`);
  if (nameKey(newName) === nameKey(oldName)) {
    return refuse(`Renaming "${oldName}" to "${newName}" changes only the letter case, which this tool does not do: on Windows `
      + `and macOS both names are the same file. Rename it to another name first, then to "${newName}".`);
  }
  const registered = category === 'eventSheets' ? await reader.listEventSheets() : await reader.listLayouts();
  const spelled = findNameClash(oldName, registered);
  if (spelled !== undefined && spelled !== oldName) {
    return refuse(`${kind.title} "${oldName}" is named "${spelled}" in the project. Use name "${spelled}".`);
  }

  let start: Start;
  if (spelled === undefined) {
    const stopped = registered.includes(newName) ? await stoppedRename(reader, writer, category, oldName, newName) : undefined;
    if (stopped === undefined) {
      return refuse(notFoundError(kind.title, oldName, reader.findNearestName(oldName, kind.nearest), kind.listTool).content[0].text);
    }
    start = { mode: 'finish', ...stopped };
  } else {
    // The entity's own name cannot clash: a new name equal to it ignoring case was refused above
    const clash = findNameClash(newName, registered);
    if (clash === newName) return refuse(`${kind.title} "${newName}" already exists.`);
    if (clash !== undefined) return refuse(caseClashError(kind.label, newName, clash));
    let own: EventSheet | Layout;
    try {
      own = category === 'eventSheets' ? await reader.readEventSheet(oldName) : await reader.readLayout(oldName);
    } catch (error) {
      const code = classifyReadError(error);
      const file = reader.getEntityRelativePath(category, oldName);
      return refuse(code === 'E_FILE_NOT_FOUND'
        ? `The file of ${kind.label} "${oldName}" (${file}) does not exist, so there is nothing to rename.`
        : `The file of ${kind.label} "${oldName}" (${file}) could not be parsed (${describeReadFailure(code)}), so it cannot be `
          + 'renamed here: its "name" must change with its file name. Rename it in the Construct 3 editor.');
    }
    const leftover = await newFileState(reader, writer, category, writer.getSubfolderForEntity(category, oldName), newName, (own as unknown as Record<string, unknown>).sid);
    if (leftover.state === 'other') return refuse(leftover.refusal);
    start = { mode: 'rename', own, ...(leftover.state === 'stopped-run' ? { leftover: leftover.read } : {}) };
  }
  const subfolder = writer.getSubfolderForEntity(category, start.mode === 'rename' ? oldName : newName);

  // Every place that names it, read before any write
  const sheets = await reader.readAllEventSheets();
  const sheetFailures = reader.getReadFailures('eventSheets');
  const skipped: UnscannedFile[] = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, sheetFailures);
  let uses: EntityNameUse[];
  if (category === 'eventSheets') {
    const layouts = await reader.readAllLayouts();
    const layoutFailures = reader.getReadFailures('layouts');
    skipped.push(...unscannedFilesOf('layouts', await reader.listLayouts(), layouts, layoutFailures));
    uses = [...findSheetIncludes(sheets, oldName), ...findLayoutBindings(layouts, oldName)];
  } else {
    uses = [...findLayoutNameUses(sheets, oldName), ...findInstanceVariableValues(await reader.readAllLayouts(), oldName)];
  }
  // Project script files: listed, never changed
  const quoted = jsQuotedNamePattern(oldName);
  const scripts = await scriptFileUses(reader, line => quoted.test(line));
  const scriptEntries = scripts.lines.map(l => ({ in: l.path, kind: 'script file', value: l.line }));
  const definite = uses.filter(u => u.definite);
  const possible = uses.filter(u => !u.definite);
  const project = reader.getProject() as unknown as Record<string, unknown>;
  const properties = isRecord(project.properties) ? project.properties : {};
  const startup = category === 'layouts'
    && [project.firstLayout, properties.firstLayout].some(v => isSameEntityName(v, oldName));
  const timelineScan = category === 'layouts'
    ? await readRegisteredTimelines(reader.getProjectDir(), project.timelines)
    : { timelines: [], unreadable: [] };
  const startingOn = timelineScan.timelines.filter(t => isSameEntityName(t.data.startOnLayout, oldName));
  const unscanned = await checkUnscannedFiles(reader, skipped, [
    { categories: category === 'eventSheets' ? ['eventSheets', 'layouts'] : ['eventSheets'], allOf: [[nameTerm(oldName)]] },
  ]);

  const oldFile = entityFileSegments(category, subfolder, oldName).join('/');
  const newFile = entityFileSegments(category, subfolder, newName).join('/');
  // The other files that name it, each once (a sheet that includes itself is written with it)
  const referencing = [...new Map(definite
    .filter(u => !(start.mode === 'rename' && u.category === category && u.file === oldName))
    .map(u => [`${u.category}/${u.file}`, u] as const)).values()];
  const references = [
    ...definite.map(useEntry),
    ...(startup ? [{ in: 'project.c3proj', kind: 'firstLayout', value: oldName }] : []),
    ...startingOn.map(t => ({ in: t.file, kind: 'startOnLayout', value: t.data.startOnLayout })),
  ];
  const possibleList = [...possible.map(useEntry), ...scriptEntries];
  const possibleReferences = possibleList.length > 0 ? { possibleReferences: possibleList } : {};
  const timelinesUnread = timelineScan.unreadable.length > 0
    ? `Timeline file(s) that could not be read or parsed may start on this layout ("startOnLayout"): ${listSome(timelineScan.unreadable)}.`
    : undefined;

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
      warnings.push(`${would} ${ofKind.length} ${USE_LABELS[useKind]} that named "${oldName}" at "${newName}": `
        + `${listSome(ofKind.map(entityNameUseLocation))}.`);
    }
  }
  if (startingOn.length > 0) {
    warnings.push(`${would} the "startOnLayout" of ${startingOn.length} timeline(s) that started on "${oldName}" at `
      + `"${newName}": ${listSome(startingOn.map(t => `"${t.name}"`))}.`);
  }
  if (startup) {
    warnings.push(`"${oldName}" is the startup layout (firstLayout); it ${args.dryRun ? 'would stay' : 'stays'} the startup layout under its new name.`);
  }
  if (possible.length > 0) {
    warnings.push(`${possible.length} other expression(s), variable value(s) or script line(s) contain the string "${oldName}", which may `
      + `name this ${kind.label} (e.g. Go to layout (by name), LayoutName = "${oldName}") or something else of that name; they ${args.dryRun ? 'would' : 'were'} NOT `
      + `${args.dryRun ? 'be ' : ''}changed: ${listSome(possible.map(entityNameUseLocation))}.`);
  }
  if (scriptEntries.length > 0) {
    warnings.push(`${scriptEntries.length} line(s) of project script files hold "${oldName}" as a string and ${args.dryRun ? 'would' : 'were'} NOT `
      + `${args.dryRun ? 'be ' : ''}changed: ${listSome(scriptEntries.map(e => e.in))}.`);
  }
  if (scripts.unreadable.length > 0) {
    warnings.push(`Script file(s) that could not be read were not searched for "${oldName}": ${listSome(scripts.unreadable)}.`);
  }
  warnings.push(...unscannedWarnings(unscanned, args.dryRun ? 'Would rename' : 'Renamed'));
  if (timelinesUnread) {
    warnings.push(`${args.dryRun ? 'Would rename' : 'Renamed'} with force=true: ${timelinesUnread} They were NOT updated.`);
  }

  const common = {
    entity: oldName,
    category: kind.category,
    references,
    ...possibleReferences,
    ...(start.mode === 'finish' ? { stoppedRun: true } : {}),
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
        ...referencing.map(u => reader.getEntityRelativePath(u.category, u.file)),
        ...(start.mode === 'rename' ? [newFile, 'project.c3proj'] : []),
        ...startingOn.map(t => t.file),
      ],
      fileToDelete: oldFile,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }
  return {
    category, oldName, newName, subfolder, start, referencing, startingOn,
    views: viewStateMoves(category, subfolder, oldName, newName),
    result: { ...common, fileDeleted: oldFile },
    warnings,
  };
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
      if (use.category === 'layouts') {
        const layout = await reader.readLayout(use.file);
        if (!ENTITY_REWRITE_POLICY['eventSheet binding'] || !isSameEntityName(layout.eventSheet, oldName)) continue;
        layout.eventSheet = newName;
        await writer.writeEntityFile('layouts', use.file, layout, writer.getSubfolderForEntity('layouts', use.file));
      } else {
        const sheet = await reader.readEventSheet(use.file);
        const changed = category === 'eventSheets'
          ? renameSheetIncludes(sheet, oldName, newName)
          : renameLayoutParameters(sheet, oldName, newName);
        if (changed === 0) continue;
        await writer.writeEntityFile('eventSheets', use.file, sheet, writer.getSubfolderForEntity('eventSheets', use.file));
      }
      filesWritten.push(reader.getEntityRelativePath(use.category, use.file));
    }
    if (start.mode === 'rename') {
      const own = start.own as unknown as Record<string, unknown>;
      own.name = newName;
      // A sheet that includes itself (not valid, but possible on disk) follows its own rename
      if (category === 'eventSheets') renameSheetIncludes(start.own as EventSheet, oldName, newName);
      // The stopped run's leftover is written over only while it is as read
      if (start.leftover) await assertUnchangedSinceRead(writer, start.leftover);
      await writer.writeEntityFile(category, newName, own, subfolder, { createOnly: start.leftover === undefined });
      filesWritten.push(entityFileSegments(category, subfolder, newName).join('/'));
      writing = reader.getProjectPath();
      // The checks made before the first write, again, on project.c3proj as the update reads it (an editor save since is merged)
      await writer.renameInProject(category, oldName, newName, { expectedFolder: subfolder ? subfolder.split('/') : [], clashesWith: [category] });
      writing = undefined;
      filesWritten.push('project.c3proj');
    }
    for (const timeline of plan.startingOn) {
      timeline.data.startOnLayout = newName;
      await replaceForRename(writer, side, timeline.read, await timelineFileText(timeline.read.path, timeline.data, reader.getProjectPath()));
      filesWritten.push(timeline.file);
    }
    // The old file last of the writes that matter: a rename that stops before this write
    // leaves the old file beside the new name, which the same call recognises
    if (start.mode === 'finish') await assertUnchangedSinceRead(writer, start.oldRead);
    backupPath = await writer.deleteEntityFile(category, oldName, subfolder);
  } catch (error) {
    throw new Error(await rollBackRename(writer, error, side, writing !== undefined ? { writing } : {}));
  }
  const view = await moveViewStateFiles(writer, reader.getProjectDir(), plan.views);
  const warnings = [...plan.warnings, ...view.warnings];
  return toolResult({
    success: true,
    action: 'renamed',
    ...plan.result,
    entity: newName,
    previousName: oldName,
    filesWritten,
    ...(view.moved.length > 0 ? { viewStateMoved: view.moved } : {}),
    ...(backupPath !== undefined ? { backupFile: backupPath } : {}),
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

/** The input schema of rename_event_sheet and rename_layout, strict. */
function renameSchema(category: Category) {
  const { tool, label } = KINDS[category];
  return z.object({
    name: z.string().max(200).describe(`Current ${label} name, as registered (letter case included)`),
    newName: z.string().max(200).describe(`New ${label} name (letters, digits, underscores and spaces, starting with a letter or underscore; must not match another ${label} name, ignoring case; a change of letter case only is refused)`),
    dryRun: z.boolean().optional().default(false).describe('Report the references the rename would update and the files it would write, and write nothing'),
    force: z.boolean().optional().default(false).describe('Rename even when files that could not be parsed possibly name it (they are NOT updated; listed in unscannedFiles and a warning)'),
  }, { errorMap: unknownKeysErrorMap(`the arguments of ${tool}`, `${tool} takes name, newName, dryRun and force.`) }).strict();
}

/** Register rename_event_sheet and rename_layout. */
export function registerEntityRenameTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);
  const handler = (category: Category) => async (args: RenameArgs) => {
    const { tool, label } = KINDS[category];
    let planned: Awaited<ReturnType<typeof planRename>>;
    try {
      planned = await planRename(reader, writer, category, args);
    } catch (error) {
      console.error(`[${tool}] failed:`, error);
      return refuse(`The rename stopped before anything was written: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}.`);
    }
    if ('content' in planned) return planned;
    try {
      return await applyRename(reader, writer, planned);
    } catch (error) {
      console.error(`[${tool}] failed:`, error);
      return toolError(`Error renaming ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ─── rename_event_sheet ───────────────────────────────

  server.registerTool(
    'rename_event_sheet',
    {
      description: 'Rename an event sheet and update what names it: include events in event sheets ("includeSheet", at any depth), '
        + 'the event sheet binding of layouts ("eventSheet"), its entry in project.c3proj (it keeps its folder and its place in the '
        + 'project bar) and its file name (the old file is kept as .bak); the editor\'s view-state file of the sheet is moved with it. '
        + 'Names are matched ignoring case, as the editor compares them. Lines of project script files that hold its name as a string are '
        + 'listed in possibleReferences, never changed. A failure midway puts back what the call wrote, except a '
        + 'file another write changed since, which is named; running the same call again finishes a rename that stopped. Event sheets '
        + 'and layouts that could not be parsed (over the read limit, not valid JSON) are not updated: one whose text names the sheet, '
        + 'or that cannot be read at all, refuses the rename without force (rename_blocked; unscannedFiles). Use dryRun first to see '
        + 'the references and files.',
      inputSchema: renameSchema('eventSheets'),
    },
    handler('eventSheets'),
  );

  // ─── rename_layout ────────────────────────────────────

  server.registerTool(
    'rename_layout',
    {
      description: 'Rename a layout and update what names it: the "layout" parameters of conditions and actions that are its name '
        + '(System Go to layout saves the bare name), the timelines that start on it ("startOnLayout"), its entry in project.c3proj '
        + '(it keeps its folder and its place in the project bar, and stays the startup layout if it is one) and its file name (the '
        + 'old file is kept as .bak); the editor\'s view-state files of the layout are moved with it. Strings, script lines and text '
        + 'variable values that are or contain its name (Go to layout (by name), LayoutName comparisons, instance variables) are '
        + 'listed in possibleReferences, never changed, and so are lines of project script files that hold its name as a string. A failure midway puts back what the call '
        + 'wrote, except a file another write changed since, which is named; running the same call again finishes a rename that '
        + 'stopped. Event sheets that could not be parsed, and timeline files that could not be read or parsed, refuse the rename '
        + 'without force when they possibly name the layout (rename_blocked; unscannedFiles). Use dryRun first.',
      inputSchema: renameSchema('layouts'),
    },
    handler('layouts'),
  );
}
