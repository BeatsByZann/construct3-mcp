/**
 * Duplicate tools: duplicate_layout, duplicate_layer, duplicate_event_sheet
 * and duplicate_object_type.
 *
 * A copy gets fresh IDs: every SID in it is new, a layout copy's instances get
 * UIDs above the project maximum, and the hierarchy links inside the copy
 * (`sceneGraphData.uid`, `parent-uid`, `children[].uid`) and the Layout View
 * entries that address an instance by SID are mapped consistently. A copy
 * never contains editor state (`*.uistate.json`, `*.instancesBar.json`) and
 * never contains other instances of global object types. A copy that cannot
 * be made faithful is refused with the reason, before anything is written.
 *
 * A new entity file is created as a file of the call (createFileForCall) and
 * registered right after its source; a failure removes the file again once
 * project.c3proj no longer registers it (rollBackStructureCall). An object
 * type's image files and tilemap brush file are created after its entity
 * file and its registration, also as files of the call, so a failure puts
 * them back last created first.
 */

import { z } from 'zod';
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import { applyJsonTextStyle, parseJsonText, resolveJsonTextStyle } from '../construct3/json-format.js';
import { forEachLayerInstance, forEachLayoutInstance, findLayerNameClash, findLayersByName, allLayers } from '../construct3/layers.js';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { containerMemberships } from '../construct3/containers.js';
import { findNameClash, nameKey } from '../construct3/names.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { classifyReadError } from '../construct3/project-reader.js';
import { describeReadFailure, unscannedFilesOf } from '../construct3/analyzers/unscanned-uses.js';
import { allTreeNames, isTree, registerAfterInTree } from '../construct3/project-tree.js';
import {
  hierarchyEscapes, planImageCopies, remapAllSids, remapImageSpriteIds, remapInstanceUids, sidRemapper, templateInstances,
} from '../construct3/entity-copies.js';
import type { EventSheet, Instance, Layout, ObjectType } from '../construct3/types.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { nothingChanged } from './event-helpers.js';
import { withProjectSync } from './project-sync.js';
import { unregisteredNameMessage } from './registered-names.js';
import {
  createFileForCall, entityFileSegments, newSideWrites, readForRename, reasonOf, type RenamedCategory, type RenameSideWrites,
} from './rename-files.js';
import { rollBackStructureCall } from './side-files.js';
import { toolError, toolResult, validateName, type MutationToolDeps } from './shared.js';

type Reader = MutationToolDeps['reader'];
type Writer = MutationToolDeps['writer'];
type Json = Record<string, unknown>;
type CopyCategory = RenamedCategory | 'timelines';

const refuse = (message: string) => toolError(nothingChanged(message));

/** Whether project.c3proj on disk registers `name` nowhere in the `category` tree (a copy's registration is not there, or was put back). */
async function copyNotRegistered(reader: Reader, category: CopyCategory, name: string): Promise<boolean> {
  const project = JSON.parse(await readFile(reader.getProjectPath(), 'utf-8')) as Record<string, unknown>;
  const tree = project[category];
  return isTree(tree) && !allTreeNames(tree, true).includes(name);
}

/**
 * Create the copy's entity file as a file of the call (createFileForCall,
 * in the project's text style), not through writeEntityFile: the writer's
 * undo of a call removes an entity file the call created whether or not
 * project.c3proj could be put back, which would leave a registered entity
 * without its file. As a file of the call it is removed by
 * rollBackStructureCall only once project.c3proj no longer registers it.
 * The data is checked as the writer checks every entity it writes (an
 * object, under the size limit, valid JSON) before the file is created.
 * The IDs in `data` came from the ID generator, which already counts them.
 * The caller has checked `writer.entityFileRefusal` (a file there, in any
 * letter case, is refused before any change); a file that appears
 * meanwhile is refused by createFileForCall and left as it is.
 */
async function createEntityCopy(
  writer: Writer, reader: Reader, side: RenameSideWrites, category: RenamedCategory,
  name: string, subfolder: string | undefined, data: unknown,
): Promise<void> {
  const json = writer.validateJsonData(data, name);
  const path = resolveProjectPath(reader.getProjectDir(), ...entityFileSegments(category, subfolder, name));
  const style = await resolveJsonTextStyle(path, reader.getProjectPath(), dirname(path));
  await createFileForCall(writer, side, path, applyJsonTextStyle(json, style));
}

/**
 * Run `write` (which creates the copy's file) and register the copy right
 * after its source in the source's folder. Returns project.c3proj's backup
 * path. It does not roll back: the tool's one `catch` does, through
 * rollBackCopy, so a failure is rolled back once.
 */
async function writeAndRegisterCopy(
  writer: Writer, category: CopyCategory, source: string, name: string, write: () => Promise<unknown>,
): Promise<string | undefined> {
  await write();
  return writer.updateProject(project => registerAfterInTree(project[category], source, name));
}

/**
 * The message of a failed duplicate call, after rolling it back: project.c3proj
 * and any entity file the call rewrote first, then the files `side` records
 * (the copy's entity file) once the copy is no longer registered, else kept
 * and named. Every duplicate tool that creates a registered file calls it
 * from its one `catch`. It never throws: a rollback that itself fails is
 * reported as writes that could not be undone, naming the files the call
 * wrote (project-relative), because the call did write before it failed.
 */
async function rollBackCopy(
  writer: Writer, reader: Reader, error: unknown, side: RenameSideWrites, category: CopyCategory, name: string,
): Promise<string> {
  try {
    return await rollBackStructureCall(writer, error, side, {
      writing: reader.getProjectPath(), projectIsBack: () => copyNotRegistered(reader, category, name),
    });
  } catch (rollbackError) {
    const relative = (file: string) => writer.projectRelative(file);
    const files = [...new Set([reader.getProjectPath(), ...side.files.map(f => f.path), ...side.unresolved.map(f => f.path)].map(relative))];
    return `${reasonOf(error, relative)}. The call's writes could not be undone (${reasonOf(rollbackError, relative)}), `
      + `so these files may be left as the call wrote them: ${files.join(', ')}. Check the project (validate_project, git diff) before you run the tool again.`;
  }
}

/** The object types among the instances that are global, and the types whose file could not be read. */
async function globalTypeScan(reader: Reader, instances: Instance[]): Promise<{ globals: string[]; unreadable: string[] }> {
  const globals = new Set<string>();
  const unreadable: string[] = [];
  for (const type of new Set(instances.map(i => i.type))) {
    try {
      const obj = await reader.readObjectType(type);
      if (obj.isGlobal === true) globals.add(type);
    } catch {
      unreadable.push(type);
    }
  }
  return { globals: [...globals], unreadable };
}

/** The warnings for a copy that places instances again: global object types, and types that could not be checked. */
function globalTypeWarnings(scan: { globals: string[]; unreadable: string[] }, persistNote: string): string[] {
  const out: string[] = [];
  if (scan.globals.length > 0) {
    out.push(`The copy places another instance of global object type(s) ${scan.globals.join(', ')}.${persistNote}`);
  }
  if (scan.unreadable.length > 0) {
    out.push(`Object type(s) ${scan.unreadable.join(', ')} could not be read, so whether the copy places another instance of a global object type was not checked.`);
  }
  return out;
}

/** What a scan for fixed UIDs found: the files that address them, and the files it could not check. */
interface UidScan {
  using: string[];
  couldNotCheck: string[];
}

/** Timeline files (any depth under timelines/) whose tracks address one of `uids`. */
async function timelinesUsingUids(reader: Reader, uids: Set<number>): Promise<UidScan> {
  const scan: UidScan = { using: [], couldNotCheck: [] };
  const uidKeys = new Set(['worldInstance', 'uid', 'ownerUid']);
  const uses = (node: unknown, depth: number): boolean => {
    if (depth > 64 || !node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(child => uses(child, depth + 1));
    for (const [key, value] of Object.entries(node as Json)) {
      if (uidKeys.has(key) && typeof value === 'number' && uids.has(value)) return true;
      if (value && typeof value === 'object' && uses(value, depth + 1)) return true;
    }
    return false;
  };
  for (const relative of await reader.listDataFiles('timelines')) {
    try {
      if (uses(parseJsonText(await reader.readDataFileText('timelines', relative)), 0)) scan.using.push(`timelines/${relative}`);
    } catch {
      scan.couldNotCheck.push(`timelines/${relative}`);
    }
  }
  scan.using.sort();
  return scan;
}

/** Event sheets with a `unique-id` parameter (pick by unique ID) holding a bare integer that names one of `uids`; sheets that could not be parsed are listed apart. */
async function sheetsPickingUids(reader: Reader, uids: Set<number>): Promise<UidScan> {
  const scan: UidScan = { using: [], couldNotCheck: [] };
  const picks = (node: unknown, depth: number): boolean => {
    if (depth > 128 || !node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(child => picks(child, depth + 1));
    const record = node as Json;
    const params = record.parameters as Json | undefined;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const value = params['unique-id'];
      if (typeof value === 'string' && /^\s*\d+\s*$/.test(value) && uids.has(Number(value))) return true;
    }
    return Object.values(record).some(child => !!child && typeof child === 'object' && picks(child, depth + 1));
  };
  const sheets = await reader.readAllEventSheets();
  for (const [name, sheet] of sheets) {
    if (picks(sheet.events, 0)) scan.using.push(name);
  }
  const registered = await reader.listEventSheets();
  scan.couldNotCheck.push(...unscannedFilesOf('eventSheets', registered, sheets, reader.getReadFailures('eventSheets')).map(f => f.file));
  return scan;
}

/**
 * The names an event sheet declares that must be unique in the project: its
 * functions, custom actions, global variables (top-level variables) and
 * groups (group titles are unique project-wide). A copy would declare each
 * twice.
 */
function projectWideNames(events: readonly unknown[]): string[] {
  const unique: string[] = [];
  const walk = (list: readonly unknown[], depth: number) => {
    if (depth > 64) return;
    for (const entry of list) {
      const event = entry as Json;
      if (event.eventType === 'function-block') unique.push(`function "${String(event.functionName)}"`);
      if (event.eventType === 'custom-ace-block') unique.push(`custom action "${String(event.aceName)}" on ${String(event.objectClass)}`);
      if (event.eventType === 'variable' && depth === 0) unique.push(`global variable "${String(event.name)}"`);
      if (event.eventType === 'group') unique.push(`group "${String(event.title)}"`);
      if (Array.isArray(event.children)) walk(event.children, depth + 1);
    }
  };
  walk(events, 0);
  return unique;
}

/** A file an object type copy creates: its project path before and after, the absolute target and the bytes read before any write. */
interface FileToCopy {
  from: string;
  to: string;
  toPath: string;
  bytes: Buffer;
}

/**
 * Read a file the copy duplicates, recorded for the writer's own checks
 * (readForRename). A file that cannot be read is a refusal naming only its
 * reason; a missing one is a refusal too unless `optional`, where its bytes
 * are null.
 */
async function readCopySource(path: string, label: string, optional: true): Promise<{ bytes: Buffer | null } | { problem: string }>;
async function readCopySource(path: string, label: string): Promise<{ bytes: Buffer } | { problem: string }>;
async function readCopySource(path: string, label: string, optional = false): Promise<{ bytes: Buffer | null } | { problem: string }> {
  try {
    const read = await readForRename(path);
    if (read.bytes === null && !optional) return { problem: `${label} could not be read (${describeReadFailure('E_FILE_NOT_FOUND')}).` };
    return { bytes: read.bytes };
  } catch (error) {
    return { problem: `${label} could not be read (${describeReadFailure(classifyReadError(error))}).` };
  }
}

/** Register the layout, layer, event sheet and object type duplicate tools. */
export function registerDuplicateTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);
  const newNameSchema = z.string().max(200).describe('Name for the copy');

  // ─── duplicate_layout ─────────────────────────────────

  server.registerTool(
    'duplicate_layout',
    {
      description: 'Duplicate a layout under a new name in the same Project Bar folder: every layer and instance is copied with fresh SIDs and new UIDs above the project maximum, '
        + 'hierarchy links are remapped, and the copy keeps the source\'s event sheet. The layout name is matched as registered. '
        + 'Refused when the layout holds template instances (a template name can exist only once). A failure puts back what the call wrote.',
      inputSchema: {
        layoutName: z.string().max(200).describe('Layout to copy (as registered)'),
        newName: newNameSchema,
      },
    },
    async (args) => {
      try {
        const layouts = await reader.listLayouts();
        const missing = unregisteredNameMessage('Layout', args.layoutName, layouts,
          () => reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        if (missing !== undefined) return refuse(missing);
        try {
          validateName(args.newName);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        const clash = findNameClash(args.newName, layouts);
        if (clash !== undefined) return refuse(`A layout named "${clash}" already exists. Layout names are compared without case because they are file names.`);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const existing = await writer.entityFileRefusal('layouts', args.newName, subfolder);
        if (existing !== undefined) return refuse(existing);

        // A fresh parse: this call's own object, changed in place below
        let copy: Layout;
        try {
          copy = await reader.readLayout(args.layoutName);
        } catch (error) {
          return refuse(`Layout "${args.layoutName}" could not be read (${describeReadFailure(classifyReadError(error))}).`);
        }
        const instances: Instance[] = [];
        forEachLayoutInstance(copy, instance => { instances.push(instance); });
        const templates = templateInstances(instances);
        if (templates.length > 0) {
          return refuse(
            `Layout "${args.layoutName}" holds ${templates.length} template instance(s) `
            + `(${templates.slice(0, 10).map(t => `uid ${t.uid} ${t.type} template "${String(t.templateName)}"`).join('; ')}). `
            + 'A template name can exist only once per object type, so the copy would not be valid. Move the templates to another layout first.',
          );
        }
        const escapes = hierarchyEscapes(instances, new Set(instances.map(i => i.uid)));
        if (escapes.length > 0) {
          return refuse(`Layout "${args.layoutName}" has hierarchy links to instances it does not contain (${escapes.slice(0, 10).join('; ')}), so the copy cannot be remapped.`);
        }

        let uidMap: Map<number, number>;
        let sids: ReturnType<typeof sidRemapper>;
        let sidCount: number;
        try {
          uidMap = await remapInstanceUids(instances, reader, idGen);
          sids = sidRemapper(reader, idGen);
          sidCount = await remapAllSids(copy, sids.fresh);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        copy.name = args.newName;

        const warnings: string[] = [];
        warnings.push(...globalTypeWarnings(await globalTypeScan(reader, instances),
          ' Global instances persist across layouts, so running both layouts creates extra instances.'));
        const sourceUids = new Set(uidMap.keys());
        const timelines = await timelinesUsingUids(reader, sourceUids);
        if (timelines.using.length > 0) {
          warnings.push(`Timeline(s) ${timelines.using.join(', ')} animate instances of "${args.layoutName}" by UID; they still address the originals and were not duplicated.`);
        }
        const uidPicks = await sheetsPickingUids(reader, sourceUids);
        if (uidPicks.using.length > 0) {
          warnings.push(`Event sheet(s) ${uidPicks.using.join(', ')} pick instances of "${args.layoutName}" by a fixed UID; those events still pick the originals, not the copies.`);
        }
        const couldNotCheck = [...timelines.couldNotCheck, ...uidPicks.couldNotCheck];
        if (couldNotCheck.length > 0) {
          warnings.push(`${couldNotCheck.join(', ')} could not be checked, so timelines or event sheets there may still address instances of "${args.layoutName}" by UID.`);
        }

        const side = newSideWrites();
        let backupPath: string | undefined;
        try {
          backupPath = await writeAndRegisterCopy(writer, 'layouts', args.layoutName, args.newName,
            () => createEntityCopy(writer, reader, side, 'layouts', args.newName, subfolder, copy));
        } catch (error) {
          return toolError(await rollBackCopy(writer, reader, error, side, 'layouts', args.newName));
        }

        const newUids = [...uidMap.values()];
        return toolResult({
          success: true,
          entity: args.newName,
          category: 'layout',
          action: 'duplicated',
          source: args.layoutName,
          folder: subfolder ?? '',
          layers: allLayers(copy.layers).length,
          instances: instances.length,
          uidRange: newUids.length > 0 ? [Math.min(...newUids), Math.max(...newUids)] : undefined,
          freshSids: sids.map.size,
          sidKeysRewritten: sidCount,
          eventSheet: copy.eventSheet,
          warnings,
          backupFile: backupPath === undefined ? undefined : writer.projectRelative(backupPath),
        });
      } catch (error) {
        console.error('[duplicate_layout] failed:', error);
        // Only the steps before the first write can throw out of the inner blocks; the copy's write and its rollback are inside them
        return refuse(`Error duplicating layout: ${reasonOf(error, path => writer.projectRelative(path))}`);
      }
    },
  );

  // ─── duplicate_layer ──────────────────────────────────

  server.registerTool(
    'duplicate_layer',
    {
      description: 'Duplicate a layer inside its layout under a new name, placed directly above the source layer. Its instances are copied with fresh SIDs and new UIDs; '
        + 'hierarchy links inside the layer are remapped. Names are matched as registered. '
        + 'Timelines and event sheets that address the original layer\'s instances by UID are not scanned: they keep addressing the originals. '
        + 'Refused for a layer with sub-layers, template instances, or hierarchy links to instances on other layers, and for a name another layer of the layout uses ignoring case.',
      inputSchema: {
        layoutName: z.string().max(200).describe('Layout that owns the layer (as registered)'),
        layerName: z.string().max(200).describe('Layer to copy (as registered)'),
        newName: newNameSchema,
      },
    },
    async (args) => {
      try {
        const layouts = await reader.listLayouts();
        const missing = unregisteredNameMessage('Layout', args.layoutName, layouts,
          () => reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        if (missing !== undefined) return refuse(missing);
        try {
          validateName(args.newName);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        // A fresh parse: this call's own object, changed in place below and written back
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch (error) {
          return refuse(`Layout "${args.layoutName}" could not be read (${describeReadFailure(classifyReadError(error))}).`);
        }
        const location = findLayersByName(layout.layers, args.layerName)[0];
        if (!location) {
          const names = allLayers(layout.layers).map(l => String(l.name));
          const notFound = unregisteredNameMessage('Layer', args.layerName, names, () => names.slice(0, 10), 'get_layout_details');
          return refuse(`In layout "${args.layoutName}": ${notFound ?? `Layer "${args.layerName}" not found.`}`);
        }
        const layerClash = findLayerNameClash(layout.layers, args.newName);
        if (layerClash) {
          return refuse(`Layout "${args.layoutName}" already has a layer named "${String(layerClash.layer.name)}". Layer names must be unique within a layout, ignoring case.`);
        }
        if (Array.isArray(location.layer.subLayers) && location.layer.subLayers.length > 0) {
          return refuse(
            `Layer "${args.layerName}" has sub-layers (${location.layer.subLayers.map(l => l.name).join(', ')}). `
            + 'Copying them would repeat their names inside the layout, which must stay unique. Duplicate a layer without sub-layers.',
          );
        }

        // The layout is written back with the copy inserted, so the copy is a separate object
        const copy = structuredClone(location.layer);
        const instances: Instance[] = [];
        forEachLayerInstance([copy], instance => { instances.push(instance); });
        const templates = templateInstances(instances);
        if (templates.length > 0) {
          return refuse(
            `Layer "${args.layerName}" holds ${templates.length} template instance(s) `
            + `(${templates.slice(0, 10).map(t => `uid ${t.uid} ${t.type} template "${String(t.templateName)}"`).join('; ')}). `
            + 'A template name can exist only once per object type.',
          );
        }
        const escapes = hierarchyEscapes(instances, new Set(instances.map(i => i.uid)));
        if (escapes.length > 0) {
          return refuse(
            `Layer "${args.layerName}" has hierarchy links to instances on other layers (${escapes.slice(0, 10).join('; ')}). `
            + 'A copy of the layer alone cannot keep those links.',
          );
        }

        let sids: ReturnType<typeof sidRemapper>;
        try {
          await remapInstanceUids(instances, reader, idGen);
          sids = sidRemapper(reader, idGen);
          await remapAllSids(copy, sids.fresh);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        copy.name = args.newName;
        location.siblings.splice(location.index + 1, 0, copy);

        // Layout View entries that address a copied instance by SID.
        let folderEntries = 0;
        const sceneRoot = layout['scene-graphs-folder-root'] as unknown;
        if (isTree(sceneRoot)) {
          const walk = (folder: typeof sceneRoot) => {
            for (let i = folder.items.length - 1; i >= 0; i--) {
              const entry = folder.items[i] as Json | undefined;
              if (!entry || typeof entry.sid !== 'number' || !sids.map.has(entry.sid)) continue;
              folder.items.splice(i + 1, 0, { ...entry, sid: sids.map.get(entry.sid) });
              folderEntries++;
            }
            for (const sub of folder.subfolders) if (isTree(sub)) walk(sub);
          };
          walk(sceneRoot);
        }

        const warnings: string[] = [];
        warnings.push(...globalTypeWarnings(await globalTypeScan(reader, instances), ''));

        let backupPath: string;
        try {
          backupPath = await writeEntityOrRollBack(writer, 'layouts', args.layoutName, layout);
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error));
        }

        return toolResult({
          success: true,
          entity: args.newName,
          category: 'layer',
          action: 'duplicated',
          layout: args.layoutName,
          source: args.layerName,
          generatedSid: copy.sid,
          instances: instances.length,
          newUids: instances.map(i => i.uid),
          sceneGraphFolderEntries: folderEntries,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: writer.projectRelative(backupPath),
        });
      } catch (error) {
        console.error('[duplicate_layer] failed:', error);
        // Only the steps before the layout write can throw out of the inner blocks; the write and its rollback are inside them
        return refuse(`Error duplicating layer: ${reasonOf(error, path => writer.projectRelative(path))}`);
      }
    },
  );

  // ─── duplicate_event_sheet ────────────────────────────

  server.registerTool(
    'duplicate_event_sheet',
    {
      description: 'Duplicate an event sheet under a new name in the same Project Bar folder, with fresh SIDs on every event, condition, action and parameter. '
        + 'The name is matched as registered. Refused when the sheet declares groups, functions, custom actions or global variables, whose names must be unique in the project. '
        + 'The copy is attached to no layout and included by no sheet. A failure puts back what the call wrote.',
      inputSchema: {
        sheetName: z.string().max(200).describe('Event sheet to copy (as registered)'),
        newName: newNameSchema,
      },
    },
    async (args) => {
      try {
        const sheets = await reader.listEventSheets();
        const missing = unregisteredNameMessage('Event sheet', args.sheetName, sheets,
          () => reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        if (missing !== undefined) return refuse(missing);
        try {
          validateName(args.newName);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        const clash = findNameClash(args.newName, sheets);
        if (clash !== undefined) return refuse(`An event sheet named "${clash}" already exists. Sheet names are compared without case because they are file names.`);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const existing = await writer.entityFileRefusal('eventSheets', args.newName, subfolder);
        if (existing !== undefined) return refuse(existing);

        // A fresh parse: this call's own object, changed in place below
        let copy: EventSheet;
        try {
          copy = await reader.readEventSheet(args.sheetName);
        } catch (error) {
          return refuse(`Cannot read event sheet "${args.sheetName}" (${describeReadFailure(classifyReadError(error))}).`);
        }
        const unique = projectWideNames(copy.events ?? []);
        if (unique.length > 0) {
          return refuse(
            `Event sheet "${args.sheetName}" declares ${unique.length} project-wide name(s): ${unique.slice(0, 10).join(', ')}`
            + `${unique.length > 10 ? ', ...' : ''}. A copy would declare them twice, which Construct rejects. `
            + 'Move those events to another sheet (move_events_between_sheets) or rename them before duplicating.',
          );
        }

        let reassigned: number;
        try {
          reassigned = await remapAllSids(copy, sidRemapper(reader, idGen).fresh);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        copy.name = args.newName;

        const side = newSideWrites();
        let backupPath: string | undefined;
        try {
          backupPath = await writeAndRegisterCopy(writer, 'eventSheets', args.sheetName, args.newName,
            () => createEntityCopy(writer, reader, side, 'eventSheets', args.newName, subfolder, copy));
        } catch (error) {
          return toolError(await rollBackCopy(writer, reader, error, side, 'eventSheets', args.newName));
        }

        return toolResult({
          success: true,
          entity: args.newName,
          category: 'eventsheet',
          action: 'duplicated',
          source: args.sheetName,
          folder: subfolder ?? '',
          generatedSid: copy.sid,
          reassignedSids: reassigned,
          warnings: ['The copy is not attached to any layout and is not included by any sheet.'],
          backupFile: backupPath === undefined ? undefined : writer.projectRelative(backupPath),
        });
      } catch (error) {
        console.error('[duplicate_event_sheet] failed:', error);
        // Only the steps before the first write can throw out of the inner blocks; the copy's write and its rollback are inside them
        return refuse(`Error duplicating event sheet: ${reasonOf(error, path => writer.projectRelative(path))}`);
      }
    },
  );

  // ─── duplicate_object_type ────────────────────────────

  server.registerTool(
    'duplicate_object_type',
    {
      description: 'Duplicate an object type under a new name in the same Project Bar folder: behaviors, instance variables, effects and animations are copied with fresh SIDs and image IDs, '
        + 'its image files are copied under the new name, and its tilemap brush file is copied. The name is matched as registered. '
        + 'No instances are placed; family and container membership is not copied. Single-global plugins (Keyboard, Mouse, ...) cannot be duplicated. '
        + 'A failure puts back what the call wrote.',
      inputSchema: {
        objectName: z.string().max(200).describe('Object type to copy (as registered)'),
        newName: newNameSchema,
      },
    },
    async (args) => {
      try {
        const objects = await reader.listObjectTypes();
        const missing = unregisteredNameMessage('Object', args.objectName, objects,
          () => reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        if (missing !== undefined) return refuse(missing);
        try {
          validateName(args.newName);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        const families = await reader.listFamilies();
        const clash = findNameClash(args.newName, [...objects, ...families]);
        if (clash !== undefined) {
          return refuse(`"${clash}" is already an object type or family name. Object types and families share one name space.`);
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const existing = await writer.entityFileRefusal('objectTypes', args.newName, subfolder);
        if (existing !== undefined) return refuse(existing);

        // A fresh parse: this call's own object, changed in place below
        let copy: ObjectType;
        try {
          copy = await reader.readObjectType(args.objectName);
        } catch (error) {
          return refuse(`Cannot read object type "${args.objectName}" (${describeReadFailure(classifyReadError(error))}).`);
        }
        if (copy['singleglobal-inst']) {
          return refuse(`"${args.objectName}" is a single-global ${copy['plugin-id']} object; a project can hold only one.`);
        }

        // Plan and read every file to copy before anything is written
        const projectDir = reader.getProjectDir();
        const images = planImageCopies(await writer.listImageFiles(), args.objectName, copy, args.newName);
        if (images.clashes.length > 0) {
          return refuse(`images/${images.clashes[0]} already exists; the copy's files would overwrite it.`);
        }
        const files: FileToCopy[] = [];
        for (const image of images.copies) {
          const read = await readCopySource(resolveProjectPath(projectDir, 'images', image.from), `images/${image.from}`);
          if ('problem' in read) return refuse(read.problem);
          files.push({ from: `images/${image.from}`, to: `images/${image.to}`, toPath: resolveProjectPath(projectDir, 'images', image.to), bytes: read.bytes });
        }
        const folderParts = subfolder ? subfolder.split('/') : [];
        const brushFrom = ['tilemapBrushes', 'objectTypes', ...folderParts, `${args.objectName}.brush.json`];
        const brushTo = ['tilemapBrushes', 'objectTypes', ...folderParts, `${args.newName}.brush.json`];
        const brush = await readCopySource(resolveProjectPath(projectDir, ...brushFrom), brushFrom.join('/'), true);
        if ('problem' in brush) return refuse(brush.problem);
        if (brush.bytes !== null) {
          const toPath = resolveProjectPath(projectDir, ...brushTo);
          if (await findFileIgnoringCase(toPath) !== undefined) {
            return refuse(`${brushTo.join('/')} already exists; the copy's files would overwrite it.`);
          }
          files.push({ from: brushFrom.join('/'), to: brushTo.join('/'), toPath, bytes: brush.bytes });
        }

        const source = args.objectName;
        const templateName = copy.editorNewInstanceTemplateName;
        let sidCount: number;
        let imageIds: number;
        try {
          sidCount = await remapAllSids(copy, sidRemapper(reader, idGen).fresh);
          imageIds = await remapImageSpriteIds(copy, () => idGen.generateImageSpriteId(reader));
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        copy.name = args.newName;

        const warnings: string[] = [];
        const memberOf: string[] = [];
        for (const [familyName, family] of await reader.readAllFamilies()) {
          if (Array.isArray(family.members) && (family.members as unknown[]).includes(source)) memberOf.push(familyName);
        }
        if (memberOf.length > 0) {
          warnings.push(`"${source}" belongs to famil${memberOf.length === 1 ? 'y' : 'ies'} ${memberOf.join(', ')}; the copy was not added. Use update_family to add it.`);
        }
        const containers = containerMemberships(reader.getProject()).get(nameKey(source)) ?? [];
        if (containers.length > 0) {
          warnings.push(`"${source}" is in ${containers.length} container(s); the copy was not added.`);
        }
        if (images.missing.length > 0) {
          warnings.push(`No image file was found in images/ for ${images.missing.slice(0, 10).join(', ')}${images.missing.length > 10 ? ', ...' : ''}; the copy has no file for those frames.`);
        }
        if (typeof templateName === 'string' && templateName !== '') {
          warnings.push(`The copy creates new instances from the template "${templateName}", which belongs to "${source}"; `
            + `no instance of "${args.newName}" is that template. Clear it with set_default_template.`);
        }

        const side = newSideWrites();
        let backupPath: string | undefined;
        try {
          backupPath = await writeAndRegisterCopy(writer, 'objectTypes', source, args.newName,
            () => createEntityCopy(writer, reader, side, 'objectTypes', args.newName, subfolder, copy));
          for (const file of files) await createFileForCall(writer, side, file.toPath, file.bytes);
        } catch (error) {
          return toolError(await rollBackCopy(writer, reader, error, side, 'objectTypes', args.newName));
        }

        return toolResult({
          success: true,
          entity: args.newName,
          category: 'objecttype',
          action: 'duplicated',
          source,
          folder: subfolder ?? '',
          generatedSid: copy.sid,
          reassignedSids: sidCount,
          newImageSpriteIds: imageIds,
          filesCopied: files.map(file => ({ from: file.from, to: file.to })),
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath === undefined ? undefined : writer.projectRelative(backupPath),
        });
      } catch (error) {
        console.error('[duplicate_object_type] failed:', error);
        // Only the steps before the first write can throw out of the inner blocks; the copy's write and its rollback are inside them
        return refuse(`Error duplicating object type: ${reasonOf(error, path => writer.projectRelative(path))}`);
      }
    },
  );
}
