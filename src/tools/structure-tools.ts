/**
 * Structure tools: move_project_item.
 *
 * Project Bar folders. project.c3proj stores each tree as
 * `{ items, subfolders }`, and a folder as `{ items, subfolders, name }`. A
 * move registers the item in the destination folder and moves its files to
 * the matching path under that folder: the entity file, its editor-state
 * files, an object type's tilemap brush file, and a script or imported
 * project file. Item and folder order is the user's own, so a moved item is
 * appended to the destination folder and a new folder is appended after its
 * siblings.
 *
 * Construct 3 r506-2 (Free edition, guest) opened a project laid out this way
 * after moves of a layout, an object type and an event sheet, and saved its
 * own files at the same paths. Not checked: the editor moving an item
 * itself, and flowcharts, families, scripts, imported files and brush files.
 * A view-state file is moved as bytes, unread; r506-2 refused to open a
 * project whose layout `.uistate.json` had no `grid` object.
 *
 * Timelines are not movable here: the timelines tree's only observed
 * subfolder is the unnamed one that registers custom eases.
 *
 * A move copies each file to its new path first, then updates project.c3proj,
 * then deletes the old files (each keeps a .bak). A failure before the
 * project update puts everything back; a failure of the project update puts
 * project.c3proj back and removes the copies only once it no longer registers
 * the new place.
 */

import { z } from 'zod';
import { readFile } from 'fs/promises';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { StaleFileError } from '../construct3/disk-state.js';
import { findFolderPathClash } from '../construct3/names.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { classifyReadError } from '../construct3/project-reader.js';
import { describeReadFailure } from '../construct3/analyzers/unscanned-uses.js';
import { resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  allTreeNames, describeFolder, ensureTreeFolder, fileNameProblem, findTreeFolder, folderSegmentsProblem,
  isTree, itemName, locateInTree, type TreeFolder,
} from '../construct3/project-tree.js';
import { nothingChanged } from './event-helpers.js';
import { withProjectSync } from './project-sync.js';
import {
  assertUnchangedSinceRead, createFileForCall, moveViewStateFiles, newSideWrites, reasonOf, readForRename,
  type ReadForRename, type ViewStateMove,
} from './rename-files.js';
import { unregisteredNameMessage } from './registered-names.js';
import { rollBackStructureCall } from './side-files.js';
import { toolError, toolResult, type MutationToolDeps } from './shared.js';

type Reader = MutationToolDeps['reader'];
type Json = Record<string, unknown>;

const ENTITY_MOVES = {
  objectType: { key: 'objectTypes', dir: 'objectTypes', label: 'Object type' },
  family: { key: 'families', dir: 'families', label: 'Family' },
  layout: { key: 'layouts', dir: 'layouts', label: 'Layout' },
  eventSheet: { key: 'eventSheets', dir: 'eventSheets', label: 'Event sheet' },
  flowchart: { key: 'flowcharts', dir: 'flowcharts', label: 'Flowchart' },
} as const;

/** Only the script and general file trees have foldered items. */
const FILE_MOVES = {
  script: { folder: 'script', dir: 'scripts', label: 'Script' },
  file: { folder: 'general', dir: 'files', label: 'Project file' },
} as const;

type EntityMoveCategory = keyof typeof ENTITY_MOVES;
type FileMoveCategory = keyof typeof FILE_MOVES;

/** One file of a move: its project segments before and after, whether the item cannot be moved without it, and whether it is an editor-state file. */
interface Relocation {
  from: string[];
  to: string[];
  required: boolean;
  viewState: boolean;
}

/** A file of a move as the call read it: its project segments (Relocation), its read (state, then bytes) and the target's absolute path. */
interface SourceFile extends Relocation {
  read: ReadForRename;
  toPath: string;
}

/** A project path as the messages spell it. */
function rel(segments: readonly string[]): string {
  return segments.join('/');
}

/** The segments of a slash-separated folder path ('' is the root). */
function splitPath(path: string): string[] {
  return path ? path.split('/') : [];
}

/** The files of an entity move: the entity file, its editor-state files and an object type's brush file. */
function entityRelocations(category: EntityMoveCategory, name: string, fromPath: string, toPath: string): Relocation[] {
  const { dir } = ENTITY_MOVES[category];
  const from = splitPath(fromPath);
  const to = splitPath(toPath);
  const out: Relocation[] = [
    { from: [dir, ...from, `${name}.json`], to: [dir, ...to, `${name}.json`], required: true, viewState: false },
  ];
  if (category === 'layout' || category === 'eventSheet' || category === 'flowchart') {
    out.push({ from: [dir, ...from, `${name}.uistate.json`], to: [dir, ...to, `${name}.uistate.json`], required: false, viewState: true });
  }
  if (category === 'layout') {
    out.push({
      from: ['layouts', 'uistate', ...from, `${name}.instancesBar.json`],
      to: ['layouts', 'uistate', ...to, `${name}.instancesBar.json`],
      required: false,
      viewState: true,
    });
  }
  if (category === 'objectType') {
    out.push({
      from: ['tilemapBrushes', 'objectTypes', ...from, `${name}.brush.json`],
      to: ['tilemapBrushes', 'objectTypes', ...to, `${name}.brush.json`],
      required: false,
      viewState: false,
    });
  }
  return out;
}

/** The one file of a script or imported project file move. */
function fileRelocation(category: FileMoveCategory, name: string, fromPath: string, toPath: string): Relocation[] {
  const { dir } = FILE_MOVES[category];
  return [{ from: [dir, ...splitPath(fromPath), name], to: [dir, ...splitPath(toPath), name], required: true, viewState: false }];
}

/** The file as readForRename reads it (recorded for the writer's own checks), or a refusal that names only its reason. */
async function readSource(path: string, label: string): Promise<ReadForRename | { problem: string }> {
  try {
    return await readForRename(path);
  } catch (error) {
    return { problem: `${label} could not be read (${describeReadFailure(classifyReadError(error))}).` };
  }
}

/** The refusal of a destination folder spelled in another case than an existing one, naming this tool's argument. */
function folderCaseClash(requested: string, existing: string): string {
  return `Folder "${requested}" differs only in case from the existing Project Bar folder "${existing}". `
    + 'This tool compares sibling folder names without regard to letter case, and on Windows and macOS '
    + `they would be the same directory. Use folder "${existing}".`;
}

/** Near names for a name that is not registered; only objects, sheets and layouts have a name index. */
function suggestionsFor(reader: Reader, category: string, name: string): string[] {
  if (category === 'objectType') return reader.findNearestName(name, 'objects');
  if (category === 'eventSheet') return reader.findNearestName(name, 'eventsheets');
  if (category === 'layout') return reader.findNearestName(name, 'layouts');
  return [];
}

/** Where to see the names of a category: a tool that lists them, or for flowcharts (no listing tool) the Project Bar. */
function listToolFor(category: string): string {
  switch (category) {
    case 'objectType': return 'list_objects';
    case 'family': return 'list_families';
    case 'layout': return 'list_layouts';
    case 'eventSheet': return 'list_eventsheets';
    default: return 'the Project Bar';
  }
}

/** Whether the object type file's bytes say it is a Tilemap. */
function isTilemapFile(bytes: Buffer): boolean {
  try {
    return (JSON.parse(bytes.toString('utf-8')) as Json)['plugin-id'] === 'Tilemap';
  } catch {
    return false;
  }
}

const refuse = (message: string) => toolError(nothingChanged(message));

/** Register move_project_item. */
export function registerStructureTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  server.registerTool(
    'move_project_item',
    {
      description: 'Move an existing Project Bar item to another folder (or to the root): an object type, family, layout, event sheet, flowchart, script or imported project file. '
        + 'The item\'s file and its editor-state files move too (and an object type\'s tilemap brush file). Missing destination folders are created. '
        + 'The destination folder must be spelled as an existing folder\'s case. Timelines cannot be moved. '
        + 'A failure puts back what the call wrote; the old files are kept as .bak.',
      inputSchema: {
        category: z.enum(['objectType', 'family', 'layout', 'eventSheet', 'flowchart', 'script', 'file'])
          .describe('Kind of item to move. "file" is an imported project file (files/ folder).'),
        name: z.string().min(1).max(255).describe('Item name (for scripts and files, the file name such as "main.js")'),
        folder: z.string().max(500).optional().default('')
          .describe('Destination folder path, slash-separated (e.g. "Enemies/Bosses"); empty string moves the item to the root'),
        sourceFolder: z.string().max(500).optional()
          .describe('Scripts and files only: the folder currently holding the file, when the same file name exists in more than one folder'),
        createFolders: z.boolean().optional().default(true)
          .describe('Create the destination folder path when it does not exist (default true)'),
      },
    },
    async (args) => {
      try {
        const requested = args.folder;
        const folderProblem = requested ? folderSegmentsProblem(requested) : undefined;
        if (folderProblem !== undefined) return refuse(folderProblem);
        const projectDir = reader.getProjectDir();
        const warnings: string[] = [];
        const isFile = args.category === 'script' || args.category === 'file';

        let treeKey: string;
        let rootOf: (project: Json) => TreeFolder | undefined;
        let label: string;
        if (isFile) {
          const nameProblem = fileNameProblem(args.name);
          if (nameProblem !== undefined) return refuse(nameProblem);
          const sourceProblem = args.sourceFolder ? folderSegmentsProblem(args.sourceFolder) : undefined;
          if (sourceProblem !== undefined) return refuse(sourceProblem);
          const spec = FILE_MOVES[args.category as FileMoveCategory];
          treeKey = `rootFileFolders.${spec.folder}`;
          label = spec.label;
          rootOf = project => {
            const folders = project.rootFileFolders as Json | undefined;
            const value = folders?.[spec.folder];
            return isTree(value) ? value : undefined;
          };
        } else {
          const spec = ENTITY_MOVES[args.category as EntityMoveCategory];
          treeKey = spec.key;
          label = spec.label;
          rootOf = project => {
            const value = project[spec.key];
            return isTree(value) ? value : undefined;
          };
        }

        const root = rootOf(reader.getProject() as unknown as Json);
        if (!root) return refuse(`project.c3proj has no ${treeKey} tree, so there is nothing to move.`);

        let found = locateInTree(root, args.name);
        // Every folder the name is registered in before the call: the state the rollback must find again
        const placesBefore = found.map(loc => loc.path).sort();
        if (isFile && args.sourceFolder !== undefined) found = found.filter(loc => loc.path === args.sourceFolder);
        if (found.length === 0) {
          if (!isFile) {
            const missing = unregisteredNameMessage(label, args.name, allTreeNames(root, false),
              () => suggestionsFor(reader, args.category, args.name), listToolFor(args.category));
            if (missing !== undefined) return refuse(missing);
          }
          return refuse(`${label} "${args.name}" was not found in the Project Bar${isFile && args.sourceFolder !== undefined ? ` folder "${args.sourceFolder}"` : ''}.`);
        }
        if (found.length > 1) {
          return refuse(`${label} "${args.name}" exists in more than one folder (${found.map(f => describeFolder(f.path)).join(', ')}). Pass sourceFolder to choose one.`);
        }
        const fromPath = found[0].path;
        const clash = requested ? findFolderPathClash(root, requested) : undefined;
        if (clash !== undefined) return refuse(folderCaseClash(requested, clash));
        if (fromPath === requested) return refuse(`${label} "${args.name}" is already in ${describeFolder(requested)}.`);
        if (!findTreeFolder(root, requested) && !args.createFolders) {
          return refuse(`Folder "${requested}" does not exist in the ${treeKey} tree. Pass createFolders: true to create it.`);
        }
        const destFolder = findTreeFolder(root, requested);
        if (isFile && destFolder && destFolder.items.some(item => itemName(item) === args.name)) {
          return refuse(`${describeFolder(requested)} already holds a ${label.toLowerCase()} named "${args.name}".`);
        }

        // Plan every file before anything is written; the view-state files are moved after the project update
        const relocations = isFile
          ? fileRelocation(args.category as FileMoveCategory, args.name, fromPath, requested)
          : entityRelocations(args.category as EntityMoveCategory, args.name, fromPath, requested);
        const sources: SourceFile[] = [];
        let missingBrush = false;
        let tilemap = false;
        for (const r of relocations.filter(r => !r.viewState)) {
          const read = await readSource(resolveProjectPath(projectDir, ...r.from), rel(r.from));
          if ('problem' in read) return refuse(read.problem);
          if (read.bytes === null) {
            if (r.required) return refuse(`${rel(r.from)} is registered but does not exist on disk.`);
            missingBrush = true;
            continue;
          }
          if (args.category === 'objectType' && r.required) tilemap = isTilemapFile(read.bytes);
          const to = resolveProjectPath(projectDir, ...r.to);
          const taken = await findFileIgnoringCase(to);
          if (taken !== undefined) return refuse(`${writer.projectRelative(taken)} already exists; move or delete it first.`);
          sources.push({ ...r, read, toPath: to });
        }
        if (tilemap && missingBrush) {
          warnings.push(`"${args.name}" is a Tilemap object type, but no tilemap brush file was found at `
            + `${rel(['tilemapBrushes', 'objectTypes', ...splitPath(fromPath), `${args.name}.brush.json`])}, so none was moved.`);
        }
        if (args.category === 'script') {
          warnings.push('Module imports are resolved by path: import statements in other scripts that load this file, and relative imports inside it, were not rewritten. Check them after the move.');
        }
        const viewStateMoves: ViewStateMove[] = relocations.filter(r => r.viewState).map(r => ({ from: r.from, to: r.to }));

        const side = newSideWrites();
        let foldersCreated: string[] = [];
        let backupPath: string | undefined;
        try {
          for (const s of sources) await createFileForCall(writer, side, s.toPath, s.read.bytes!);
          // A source saved meanwhile would be moved in its old state: checked once every copy is made
          for (const s of sources) await assertUnchangedSinceRead(writer, s.read);
          backupPath = await writer.updateProject(project => {
            const freshRoot = rootOf(project as Json);
            if (!freshRoot) throw new Error(`project.c3proj has no ${treeKey} tree`);
            const again = locateInTree(freshRoot, args.name).filter(loc => loc.path === fromPath);
            if (again.length !== 1) throw new Error(`"${args.name}" changed in project.c3proj during the move`);
            const [item] = again[0].folder.items.splice(again[0].index, 1);
            const ensured = ensureTreeFolder(freshRoot, requested);
            ensured.folder.items.push(item);
            foldersCreated = ensured.created;
          });
        } catch (error) {
          return toolError(await rollBackStructureCall(writer, error, side, {
            writing: reader.getProjectPath(),
            // Back only when project.c3proj on disk registers the name in exactly the folders it did before the call:
            // the old folder still holds it, and no registration names the destination (or any other new place)
            projectIsBack: async () => {
              const tree = rootOf(JSON.parse(await readFile(reader.getProjectPath(), 'utf-8')) as Json);
              if (tree === undefined) return false;
              const placesNow = locateInTree(tree, args.name).map(loc => loc.path).sort();
              return placesNow.length === placesBefore.length && placesNow.every((path, i) => path === placesBefore[i]);
            },
          }));
        }

        // The move stands from here: an old file that cannot be deleted is a warning
        const kept: string[] = [];
        for (const s of sources) {
          try {
            const bak = await writer.deleteFile(s.read.path, { expected: s.read.state });
            if (bak !== undefined) kept.push(writer.projectRelative(bak));
          } catch (error) {
            warnings.push(error instanceof StaleFileError
              ? `${rel(s.from)} changed on disk after this call copied it, so it was not deleted; ${rel(s.to)} holds it as it was before that change. Compare the two and delete one.`
              : `Could not delete the old file ${rel(s.from)} after copying it (${reasonOf(error, path => writer.projectRelative(path))}). Delete it manually.`);
          }
        }
        const views = await moveViewStateFiles(writer, projectDir, viewStateMoves);
        warnings.push(...views.warnings);
        resetProjectIndex(reader);

        if (fromPath) {
          const fresh = rootOf(reader.getProject() as unknown as Json);
          const oldFolder = fresh ? findTreeFolder(fresh, fromPath) : undefined;
          if (oldFolder && oldFolder.items.length === 0 && oldFolder.subfolders.length === 0) {
            warnings.push(`Folder "${fromPath}" is now empty; it was kept in the Project Bar.`);
          }
        }

        return toolResult({
          success: true,
          entity: args.name,
          category: args.category,
          action: 'moved',
          from: fromPath,
          to: requested,
          foldersCreated,
          filesMoved: [
            ...sources.map(s => ({ from: rel(s.from), to: rel(s.to) })),
            ...views.moved,
          ],
          oldFilesKeptAs: kept,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath === undefined ? undefined : writer.projectRelative(backupPath),
        });
      } catch (error) {
        console.error('[move_project_item] failed:', error);
        // Reached only before the first write: the copies and the project update are inside the inner try, whose catch rolls back and never throws; the steps after the update are guarded or cannot throw
        return refuse(`Error moving item: ${reasonOf(error, path => writer.projectRelative(path))}`);
      }
    },
  );
}
