/**
 * Duplicate tools: duplicate_layout and duplicate_layer.
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
 * project.c3proj no longer registers it (rollBackStructureCall).
 */

import { z } from 'zod';
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import { applyJsonTextStyle, parseJsonText, resolveJsonTextStyle } from '../construct3/json-format.js';
import { forEachLayerInstance, forEachLayoutInstance, findLayerNameClash, findLayersByName, allLayers } from '../construct3/layers.js';
import { findNameClash } from '../construct3/names.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { classifyReadError } from '../construct3/project-reader.js';
import { describeReadFailure, unscannedFilesOf } from '../construct3/analyzers/unscanned-uses.js';
import { allTreeNames, isTree, registerAfterInTree } from '../construct3/project-tree.js';
import { hierarchyEscapes, remapAllSids, remapInstanceUids, sidRemapper, templateInstances } from '../construct3/entity-copies.js';
import type { Instance, Layout } from '../construct3/types.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { nothingChanged } from './event-helpers.js';
import { withProjectSync } from './project-sync.js';
import { unregisteredNameMessage } from './registered-names.js';
import {
  createFileForCall, entityFileSegments, newSideWrites, reasonOf, type RenamedCategory, type RenameSideWrites,
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
 * from its one `catch`.
 */
function rollBackCopy(
  writer: Writer, reader: Reader, error: unknown, side: RenameSideWrites, category: CopyCategory, name: string,
): Promise<string> {
  return rollBackStructureCall(writer, error, side, {
    writing: reader.getProjectPath(), projectIsBack: () => copyNotRegistered(reader, category, name),
  });
}

/** The object types among the instances that are global. */
async function globalTypeNames(reader: Reader, instances: Instance[]): Promise<string[]> {
  const out = new Set<string>();
  for (const type of new Set(instances.map(i => i.type))) {
    try {
      const obj = await reader.readObjectType(type);
      if (obj.isGlobal === true) out.add(type);
    } catch { /* an unreadable type is not reported as global */ }
  }
  return [...out];
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

/** Register the layout and layer duplicate tools. */
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
        const globals = await globalTypeNames(reader, instances);
        if (globals.length > 0) {
          warnings.push(`The copy places another instance of global object type(s) ${globals.join(', ')}. Global instances persist across layouts, so running both layouts creates extra instances.`);
        }
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
        return toolError(`Error duplicating layout: ${reasonOf(error, path => writer.projectRelative(path))}`);
      }
    },
  );

  // ─── duplicate_layer ──────────────────────────────────

  server.registerTool(
    'duplicate_layer',
    {
      description: 'Duplicate a layer inside its layout under a new name, placed directly above the source layer. Its instances are copied with fresh SIDs and new UIDs; '
        + 'hierarchy links inside the layer are remapped. Names are matched as registered. '
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
        const globals = await globalTypeNames(reader, instances);
        if (globals.length > 0) {
          warnings.push(`The copy places another instance of global object type(s) ${globals.join(', ')}.`);
        }

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
        return toolError(`Error duplicating layer: ${reasonOf(error, path => writer.projectRelative(path))}`);
      }
    },
  );
}
