/**
 * Structure tools: move_project_item, duplicate_layout, duplicate_layer,
 * duplicate_event_sheet, duplicate_object_type, duplicate_timeline.
 *
 * Project Bar folders. project.c3proj stores each tree as
 * `{ items, subfolders }`, and a folder as `{ items, subfolders, name }` (key
 * order confirmed on every folder in the 22 r495 example packages, the
 * template and C3-ACE). Construct keeps the file path in step with the
 * folder: all 425 foldered object types, families, layouts, event sheets and
 * flowcharts in the samples live at `<category>/<folder path>/<name>.json`,
 * and their editor files follow them (`<name>.uistate.json` next to the
 * entity for sheets, layouts and flowcharts, and
 * `layouts/uistate/<folder path>/<name>.instancesBar.json` for layouts).
 * Scripts and imported Project Files do the same under `scripts/` and
 * `files/`. Tilemap brushes mirror the object type's folder under
 * `tilemapBrushes/objectTypes/` (C3-ACE). A move therefore relocates those
 * files and rewrites the tree. Item and folder order is the user's own (most
 * sample folders are not sorted), so a moved item is appended to the
 * destination folder and a new folder is appended after its siblings.
 *
 * Timelines are not movable here: no sample has a timeline in a named folder,
 * and the timelines tree's only observed subfolder is the unnamed one that
 * registers custom eases (files in timelines/transitions/).
 *
 * Duplicates. Every SID in a copy is fresh (instance, layer, layout, event,
 * condition, action, behavior, variable, animation and folder-entry SIDs), a
 * layout copy's instances get UIDs above the project maximum, and the
 * hierarchy links inside the copy (`sceneGraphData.uid`, `parent-uid`,
 * `children[].uid`) and the Layout View entries that address an instance by
 * SID (`instanceFolderItem.sid`, `scene-graphs-folder-root`) are remapped
 * consistently. Editor state (`*.uistate.json`, `*.instancesBar.json`) is not
 * copied. A copy that cannot be made faithful is refused with the reason.
 */

import { z } from 'zod';
import { readdir, copyFile, unlink, mkdir, stat, readFile, writeFile, rename } from 'fs/promises';
import { dirname } from 'path';
import type { MutationToolDeps } from './shared.js';
import type { Layer, Instance, ObjectType } from '../construct3/types.js';
import { validateName, validateSubfolder, validateFileName, toolResult, toolError, notFoundError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import { collectLayers, collectInstances, findLayerLocation } from '../construct3/layout-walk.js';
import { reassignSids } from './event-helpers.js';

type Reader = MutationToolDeps['reader'];
type Writer = MutationToolDeps['writer'];
type IdGen = MutationToolDeps['idGen'];
type Json = Record<string, unknown>;

// ─── Project Bar trees ─────────────────────────────────────

/** A Project Bar tree or folder. Entity trees hold names; file trees hold `{ name, ... }` items. */
export interface TreeFolder {
  items: unknown[];
  subfolders: TreeFolder[];
  name?: string;
}

export interface TreeLocation {
  folder: TreeFolder;
  index: number;
  /** Slash-separated folder path, '' for the tree root. */
  path: string;
}

function itemName(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
    return (item as { name: string }).name;
  }
  return undefined;
}

function isTree(value: unknown): value is TreeFolder {
  return !!value && typeof value === 'object'
    && Array.isArray((value as TreeFolder).items)
    && Array.isArray((value as TreeFolder).subfolders);
}

/**
 * Every place `name` is registered. Subfolders without a string name are
 * skipped: the timelines tree's unnamed custom-ease folder is the only one
 * observed, and it is not a user folder.
 */
export function locateInTree(root: TreeFolder, name: string): TreeLocation[] {
  const out: TreeLocation[] = [];
  const walk = (folder: TreeFolder, path: string, depth: number) => {
    if (depth > 64) return;
    folder.items.forEach((item, index) => {
      if (itemName(item) === name) out.push({ folder, index, path });
    });
    for (const sub of folder.subfolders) {
      if (!isTree(sub) || typeof sub.name !== 'string') continue;
      walk(sub, path ? `${path}/${sub.name}` : sub.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

/**
 * The subfolder named `part`. Folder names become directory names, and on
 * Windows two names that differ only by case are the same directory, so a
 * case-insensitive match counts; an exact match wins when both exist.
 */
function findSubfolder(folder: TreeFolder, part: string): TreeFolder | undefined {
  const named = folder.subfolders.filter(sub => isTree(sub) && typeof sub.name === 'string');
  return named.find(sub => sub.name === part)
    ?? named.find(sub => (sub.name as string).toLowerCase() === part.toLowerCase());
}

/** The folder at `path` (segments matched without case), or undefined. */
export function findTreeFolder(root: TreeFolder, path: string): TreeFolder | undefined {
  if (!path) return root;
  let current: TreeFolder = root;
  for (const part of path.split('/')) {
    const next = findSubfolder(current, part);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/** `path` spelled with the casing of the folders that already exist. */
export function canonicalFolderPath(root: TreeFolder, path: string): string {
  if (!path) return path;
  const out: string[] = [];
  let current: TreeFolder | undefined = root;
  for (const part of path.split('/')) {
    const next: TreeFolder | undefined = current ? findSubfolder(current, part) : undefined;
    out.push(next ? String(next.name) : part);
    current = next;
  }
  return out.join('/');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;

/** Reject folder segments Windows cannot store as directory names. */
export function validateFolderSegments(path: string): void {
  validateSubfolder(path);
  for (const part of path.split('/')) {
    if (part.length > 255) throw new Error(`Folder name "${part.slice(0, 20)}..." is too long (max 255 characters)`);
    if (WINDOWS_FORBIDDEN.test(part)) throw new Error(`Folder name "${part}" contains a character Windows does not allow in folder names (< > : " | ? * or a control character)`);
    if (/[ .]$/.test(part) || /^ /.test(part)) throw new Error(`Folder name "${part}" must not start with a space or end with a space or a dot`);
    if (WINDOWS_RESERVED.test(part)) throw new Error(`Folder name "${part}" is reserved on Windows`);
  }
}

/** The folder at `path`, created with Construct's `{ items, subfolders, name }` key order where missing. */
export function ensureTreeFolder(root: TreeFolder, path: string): { folder: TreeFolder; created: string[] } {
  const created: string[] = [];
  if (!path) return { folder: root, created };
  let current: TreeFolder = root;
  let walked = '';
  for (const part of path.split('/')) {
    walked = walked ? `${walked}/${part}` : part;
    let next = findSubfolder(current, part);
    if (!next) {
      next = { items: [], subfolders: [], name: part };
      current.subfolders.push(next);
      created.push(walked);
    }
    current = next;
  }
  return { folder: current, created };
}

function allTreeNames(root: TreeFolder, includeUnnamed: boolean): string[] {
  const out: string[] = [];
  const walk = (folder: TreeFolder, depth: number) => {
    if (depth > 64) return;
    for (const item of folder.items) {
      const n = itemName(item);
      if (n !== undefined) out.push(n);
    }
    for (const sub of folder.subfolders) {
      if (!isTree(sub)) continue;
      if (typeof sub.name !== 'string' && !includeUnnamed) continue;
      walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function sameNameIgnoringCase(names: string[], candidate: string): string | undefined {
  const lower = candidate.toLowerCase();
  return names.find(n => n.toLowerCase() === lower);
}

function describeFolder(path: string): string {
  return path ? `"${path}"` : 'the root';
}

// ─── File helpers ──────────────────────────────────────────

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return false;
    throw e;
  }
}

function splitPath(path: string): string[] {
  return path ? path.split('/') : [];
}

interface Relocation {
  from: string[];
  to: string[];
  required: boolean;
}

function rel(segments: string[]): string {
  return segments.join('/');
}

/**
 * Copy each existing source to its target, refusing when a target is taken.
 * Returns the relocations that had a source, in order.
 */
async function copyRelocations(projectDir: string, relocations: Relocation[]): Promise<Relocation[]> {
  const present: Relocation[] = [];
  for (const r of relocations) {
    const from = resolveProjectPath(projectDir, ...r.from);
    if (!(await pathExists(from))) {
      if (r.required) throw new Error(`${rel(r.from)} is registered but does not exist on disk`);
      continue;
    }
    if (await pathExists(resolveProjectPath(projectDir, ...r.to))) {
      throw new Error(`${rel(r.to)} already exists; move or delete it first`);
    }
    present.push(r);
  }
  const copied: string[] = [];
  try {
    for (const r of present) {
      const to = resolveProjectPath(projectDir, ...r.to);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(resolveProjectPath(projectDir, ...r.from), to);
      copied.push(to);
    }
  } catch (e) {
    for (const path of copied) {
      try { await unlink(path); } catch { /* best-effort */ }
    }
    throw e;
  }
  return present;
}

async function removeCopies(projectDir: string, relocations: Relocation[]): Promise<void> {
  for (const r of relocations) {
    try { await unlink(resolveProjectPath(projectDir, ...r.to)); } catch { /* best-effort */ }
  }
}

async function removeSources(projectDir: string, relocations: Relocation[], warnings: string[]): Promise<void> {
  for (const r of relocations) {
    try {
      await unlink(resolveProjectPath(projectDir, ...r.from));
    } catch (e) {
      warnings.push(`Could not delete the old file ${rel(r.from)} after copying it: ${e instanceof Error ? e.message : String(e)}. Delete it manually.`);
    }
  }
}

// ─── Move configuration ────────────────────────────────────

const ENTITY_MOVES = {
  objectType: { key: 'objectTypes', dir: 'objectTypes', label: 'Object type' },
  family: { key: 'families', dir: 'families', label: 'Family' },
  layout: { key: 'layouts', dir: 'layouts', label: 'Layout' },
  eventSheet: { key: 'eventSheets', dir: 'eventSheets', label: 'Event sheet' },
  flowchart: { key: 'flowcharts', dir: 'flowcharts', label: 'Flowchart' },
} as const;

/** Only the script and general file trees have foldered samples (C3-ACE, solar-system). */
const FILE_MOVES = {
  script: { folder: 'script', dir: 'scripts', label: 'Script' },
  file: { folder: 'general', dir: 'files', label: 'Project file' },
} as const;

type EntityMoveCategory = keyof typeof ENTITY_MOVES;
type FileMoveCategory = keyof typeof FILE_MOVES;

function entityRelocations(category: EntityMoveCategory, name: string, fromPath: string, toPath: string): Relocation[] {
  const { dir } = ENTITY_MOVES[category];
  const from = splitPath(fromPath);
  const to = splitPath(toPath);
  const out: Relocation[] = [
    { from: [dir, ...from, `${name}.json`], to: [dir, ...to, `${name}.json`], required: true },
  ];
  if (category === 'layout' || category === 'eventSheet' || category === 'flowchart') {
    out.push({ from: [dir, ...from, `${name}.uistate.json`], to: [dir, ...to, `${name}.uistate.json`], required: false });
  }
  if (category === 'layout') {
    out.push({
      from: ['layouts', 'uistate', ...from, `${name}.instancesBar.json`],
      to: ['layouts', 'uistate', ...to, `${name}.instancesBar.json`],
      required: false,
    });
  }
  if (category === 'objectType') {
    out.push({
      from: ['tilemapBrushes', 'objectTypes', ...from, `${name}.brush.json`],
      to: ['tilemapBrushes', 'objectTypes', ...to, `${name}.brush.json`],
      required: false,
    });
  }
  return out;
}

// ─── Duplicate helpers ─────────────────────────────────────

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A memoized SID remapper: one old SID always maps to the same fresh SID. */
function sidRemapper(reader: Reader, idGen: IdGen) {
  const map = new Map<number, number>();
  return {
    map,
    async fresh(old: number): Promise<number> {
      let next = map.get(old);
      if (next === undefined) {
        next = await idGen.generateSid(reader);
        map.set(old, next);
      }
      return next;
    },
  };
}

/** Rewrite every numeric `sid` key under `value` through `fresh`. */
async function remapAllSids(value: unknown, fresh: (old: number) => Promise<number>): Promise<number> {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (node && typeof node === 'object') {
      const record = node as Json;
      for (const [key, child] of Object.entries(record)) {
        if (key === 'sid' && typeof child === 'number') {
          record.sid = await fresh(child);
          count++;
        } else if (child && typeof child === 'object') {
          stack.push(child);
        }
      }
    }
  }
  return count;
}

interface TemplateInstance {
  uid: number;
  type: string;
  templateName: unknown;
}

/**
 * Instances that ARE a template (`template.mode: "template"`). Template names
 * are unique per object type, so a copy would declare the same template
 * twice. Replicas (`mode: "replica"`) only name their source template and
 * copy safely.
 */
function templateInstances(instances: Instance[]): TemplateInstance[] {
  const out: TemplateInstance[] = [];
  for (const instance of instances) {
    const template = (instance as unknown as Json).template as Json | undefined;
    if (template && template.mode === 'template') {
      out.push({ uid: instance.uid, type: instance.type, templateName: template.templateName });
    }
  }
  return out;
}

/** Hierarchy links from the copied instances to instances outside the copy. */
function hierarchyEscapes(instances: Instance[], uids: Set<number>): string[] {
  const out: string[] = [];
  for (const instance of instances) {
    const graph = instance.sceneGraphData as unknown as Json | undefined;
    if (!graph) continue;
    const parent = graph['parent-uid'];
    if (typeof parent === 'number' && !uids.has(parent)) {
      out.push(`uid ${instance.uid} (${instance.type}) has parent uid ${parent}`);
    }
    const children = Array.isArray(graph.children) ? graph.children as Json[] : [];
    for (const child of children) {
      if (typeof child?.uid === 'number' && !uids.has(child.uid)) {
        out.push(`uid ${instance.uid} (${instance.type}) has child uid ${child.uid}`);
      }
    }
  }
  return out;
}

/** Give every instance a fresh UID and rewrite the hierarchy links through the same map. */
async function remapInstanceUids(
  instances: Instance[],
  reader: Reader,
  idGen: IdGen,
): Promise<Map<number, number>> {
  const uidMap = new Map<number, number>();
  for (const instance of instances) {
    if (typeof instance.uid !== 'number') continue;
    uidMap.set(instance.uid, await idGen.generateUid(reader));
  }
  const map = (value: unknown) => (typeof value === 'number' && uidMap.has(value) ? uidMap.get(value)! : value);
  for (const instance of instances) {
    instance.uid = map(instance.uid) as number;
    const graph = instance.sceneGraphData as unknown as Json | undefined;
    if (graph) {
      if ('uid' in graph) graph.uid = map(graph.uid);
      if ('parent-uid' in graph) graph['parent-uid'] = map(graph['parent-uid']);
      if (Array.isArray(graph.children)) {
        for (const child of graph.children as Json[]) {
          if (child && typeof child === 'object' && 'uid' in child) child.uid = map(child.uid);
        }
      }
    }
    const template = (instance as unknown as Json).template as Json | undefined;
    if (template && Array.isArray(template.replicasUIDs)) {
      template.replicasUIDs = (template.replicasUIDs as unknown[]).map(map);
    }
  }
  return uidMap;
}

function instancesOfLayer(layer: Layer): Instance[] {
  const out: Instance[] = [];
  const walk = (l: Layer) => {
    if (Array.isArray(l.instances)) out.push(...l.instances);
    if (Array.isArray(l.subLayers)) l.subLayers.forEach(walk);
  };
  walk(layer);
  return out;
}

async function globalTypeNames(reader: Reader, instances: Instance[]): Promise<string[]> {
  const out = new Set<string>();
  for (const type of new Set(instances.map(i => i.type))) {
    try {
      const obj = await reader.readObjectType(type);
      if (obj.isGlobal === true) out.add(type);
    } catch { /* unreadable type: nothing to report */ }
  }
  return [...out];
}

/** Register `newName` right after `sourceName` in the same folder of the tree under `key`. */
async function registerAfter(writer: Writer, key: string, sourceName: string, newName: string): Promise<string> {
  const { backupPath } = await writer.mutateProjectJson(project => {
    const root = project[key];
    if (!isTree(root)) throw new Error(`project.c3proj has no "${key}" tree`);
    const found = locateInTree(root, sourceName);
    if (found.length === 0) throw new Error(`"${sourceName}" is no longer registered in project.c3proj`);
    const { folder, index } = found[0];
    folder.items.splice(index + 1, 0, newName);
  });
  return backupPath;
}

/**
 * Remove a copy written moments ago. `writer.deleteEntityFile` would first
 * back the file up, leaving a stray `<name>.json.bak` next to nothing.
 */
async function discardNewEntityFile(
  reader: Reader,
  idGen: IdGen,
  category: 'layouts' | 'eventSheets' | 'objectTypes',
  name: string,
  subfolder: string | undefined,
): Promise<void> {
  try {
    await unlink(resolveProjectPath(reader.getProjectDir(), category, ...splitPath(subfolder ?? ''), `${name}.json`));
  } catch { /* best-effort */ }
  reader.invalidateCaches();
  resetProjectIndex();
  idGen.reset();
}

/** Timeline files (any depth under timelines/) whose tracks address one of `uids`. */
async function timelinesUsingUids(projectDir: string, uids: Set<number>): Promise<string[]> {
  const out: string[] = [];
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
  const walk = async (relative: string[], depth: number): Promise<void> => {
    if (depth > 16) return;
    let entries;
    try {
      entries = await readdir(resolveProjectPath(projectDir, ...relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = [...relative, entry.name];
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
      } else if (entry.name.endsWith('.json') && !entry.name.endsWith('.uistate.json')) {
        try {
          if (uses(JSON.parse(await readFile(resolveProjectPath(projectDir, ...child), 'utf-8')), 0)) out.push(rel(child));
        } catch { /* unreadable timeline: nothing to report */ }
      }
    }
  };
  await walk(['timelines'], 0);
  return out.sort();
}

/**
 * Sheets with a `unique-id` parameter (pick by unique ID; 262 sample uses)
 * holding a bare integer that names one of `uids`.
 */
async function sheetsPickingUids(reader: Reader, uids: Set<number>): Promise<string[]> {
  const out: string[] = [];
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
  for (const name of await reader.listEventSheets()) {
    try {
      if (picks((await reader.readEventSheet(name)).events, 0)) out.push(name);
    } catch { /* unreadable sheet: nothing to report */ }
  }
  return out;
}

function projectTree(reader: Reader, key: string): TreeFolder | undefined {
  const value = (reader.getProject() as unknown as Json)[key];
  return isTree(value) ? value : undefined;
}

/** Unnamed or "transitions" root subfolders register custom eases (files in timelines/transitions/), not timelines. */
function transitionTimelineNames(root: TreeFolder): string[] {
  const out: string[] = [];
  for (const sub of root.subfolders) {
    if (!isTree(sub)) continue;
    if (typeof sub.name === 'string' && sub.name !== 'transitions') continue;
    out.push(...allTreeNames(sub, true));
  }
  return out;
}

// ─── Object type images ────────────────────────────────────

/**
 * Image files of an object type. Construct names them from the lowercased
 * object name: `<name>-<animation>-NNN.<ext>` for animation frames (1958 of
 * 2003 sample frames; the rest differ only by the extension of a GIF frame)
 * and `<name>.<ext>` for a single-image plugin (TiledBg, NinePatch, Particles,
 * Spritefont2, Tilemap: 105 of 105). Object names cannot contain `-` or `.`,
 * so the prefix cannot match another object's files.
 */
async function objectImageFiles(projectDir: string, objectName: string): Promise<string[]> {
  const lower = objectName.toLowerCase();
  let entries: string[];
  try {
    entries = await readdir(resolveProjectPath(projectDir, 'images'));
  } catch {
    return [];
  }
  return entries.filter(entry => {
    const name = entry.toLowerCase();
    return name.startsWith(`${lower}-`) || name.startsWith(`${lower}.`);
  }).sort();
}

// ─── Registration ──────────────────────────────────────────

export function registerStructureTools({ server, reader, writer, idGen }: MutationToolDeps) {
  const newNameSchema = z.string().max(200).describe('Name for the copy');

  // ─── move_project_item ────────────────────────────────────

  server.tool(
    'move_project_item',
    'Move an existing Project Bar item to another folder (or to the root): an object type, family, layout, event sheet, flowchart, script or imported project file. Construct keeps the file path in step with the folder, so the item\'s file and its editor-state files move too (and an object type\'s tilemap brush file). Missing destination folders are created. Timelines cannot be moved.',
    {
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
    async (args) => {
      try {
        const requested = args.folder;
        if (requested) validateFolderSegments(requested);
        const projectDir = reader.getProjectDir();
        const warnings: string[] = [];
        const isFile = args.category === 'script' || args.category === 'file';

        let treeKey: string;
        let rootOf: (project: Json) => TreeFolder | undefined;
        let label: string;
        if (isFile) {
          validateFileName(args.name);
          if (args.sourceFolder) validateSubfolder(args.sourceFolder);
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
        if (!root) return toolError(`project.c3proj has no ${treeKey} tree, so there is nothing to move.`);

        let found = locateInTree(root, args.name);
        if (isFile && args.sourceFolder !== undefined) {
          found = found.filter(loc => loc.path === args.sourceFolder);
        }
        if (found.length === 0) {
          return toolError(`${label} "${args.name}" was not found in the Project Bar${isFile && args.sourceFolder !== undefined ? ` folder "${args.sourceFolder}"` : ''}.`);
        }
        if (found.length > 1) {
          return toolError(
            `${label} "${args.name}" exists in more than one folder (${found.map(f => describeFolder(f.path)).join(', ')}). ` +
            'Pass sourceFolder to choose one.'
          );
        }
        const fromPath = found[0].path;
        const dest = canonicalFolderPath(root, requested);
        if (dest !== requested) {
          warnings.push(`Folder "${requested}" matches the existing folder "${dest}" apart from case; the item was moved into "${dest}".`);
        }
        if (fromPath === dest) {
          return toolError(`${label} "${args.name}" is already in ${describeFolder(dest)}.`);
        }
        const destFolder = findTreeFolder(root, dest);
        if (!destFolder && !args.createFolders) {
          return toolError(`Folder "${dest}" does not exist in the ${treeKey} tree. Pass createFolders: true to create it.`);
        }
        if (isFile && destFolder && destFolder.items.some(item => itemName(item) === args.name)) {
          return toolError(`${describeFolder(dest)} already holds a ${label.toLowerCase()} named "${args.name}".`);
        }

        let relocations: Relocation[];
        if (isFile) {
          const { dir } = FILE_MOVES[args.category as FileMoveCategory];
          relocations = [{
            from: [dir, ...splitPath(fromPath), args.name],
            to: [dir, ...splitPath(dest), args.name],
            required: true,
          }];
          if (args.category === 'script') {
            warnings.push(
              'Module imports are resolved by path: import statements in other scripts that load this file, and relative imports inside it, were not rewritten. Check them after the move.'
            );
          }
        } else {
          relocations = entityRelocations(args.category as EntityMoveCategory, args.name, fromPath, dest);
        }

        const moved = await copyRelocations(projectDir, relocations);

        let foldersCreated: string[] = [];
        let backupPath: string | undefined;
        try {
          const outcome = await writer.mutateProjectJson(project => {
            const freshRoot = rootOf(project);
            if (!freshRoot) throw new Error(`project.c3proj has no ${treeKey} tree`);
            const again = locateInTree(freshRoot, args.name).filter(loc => loc.path === fromPath);
            if (again.length !== 1) throw new Error(`"${args.name}" changed in project.c3proj during the move`);
            const [item] = again[0].folder.items.splice(again[0].index, 1);
            const ensured = ensureTreeFolder(freshRoot, dest);
            ensured.folder.items.push(item);
            return ensured.created;
          });
          foldersCreated = outcome.result;
          backupPath = outcome.backupPath;
        } catch (e) {
          if (!(e && typeof e === 'object' && (e as { projectCommitted?: unknown }).projectCommitted === true)) {
            await removeCopies(projectDir, moved);
            throw e;
          }
          // project.c3proj already points at the new location: keep the copies.
          warnings.push(`project.c3proj was updated but could not be re-read afterwards: ${e instanceof Error ? e.message : String(e)}. Check the project before further edits.`);
          try { await reader.reloadProject(); } catch { /* reported above */ }
        }
        await removeSources(projectDir, moved, warnings);
        resetProjectIndex();

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
          to: dest,
          foldersCreated,
          filesMoved: moved.map(r => ({ from: rel(r.from), to: rel(r.to) })),
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[move_project_item] failed:', error);
        return toolError(`Error moving item: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── duplicate_layout ─────────────────────────────────────

  server.tool(
    'duplicate_layout',
    'Duplicate a layout under a new name in the same Project Bar folder: every layer and instance is copied with fresh SIDs and new UIDs above the project maximum, hierarchy links are remapped, and the copy keeps the source\'s event sheet. Refused when the layout holds template instances (a template name can exist only once).',
    {
      layoutName: z.string().max(200).describe('Layout to copy'),
      newName: newNameSchema,
    },
    async (args) => {
      try {
        validateName(args.newName);
        const layouts = await reader.listLayouts();
        if (!layouts.includes(args.layoutName)) {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }
        const clash = sameNameIgnoringCase(layouts, args.newName);
        if (clash) return toolError(`A layout named "${clash}" already exists. Layout names are compared without case because they are file names.`);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const target = resolveProjectPath(reader.getProjectDir(), 'layouts', ...splitPath(subfolder ?? ''), `${args.newName}.json`);
        if (await pathExists(target)) {
          return toolError(`layouts/${subfolder ? subfolder + '/' : ''}${args.newName}.json already exists on disk but is not registered. Remove it first.`);
        }

        const copy = deepClone(await reader.readLayout(args.layoutName));
        const instances = collectInstances(copy);
        const templates = templateInstances(instances);
        if (templates.length > 0) {
          return toolError(
            `Layout "${args.layoutName}" holds ${templates.length} template instance(s) ` +
            `(${templates.slice(0, 10).map(t => `uid ${t.uid} ${t.type} template "${String(t.templateName)}"`).join('; ')}). ` +
            'A template name can exist only once per object type, so the copy would not be valid. Move the templates to another layout first.'
          );
        }
        const escapes = hierarchyEscapes(instances, new Set(instances.map(i => i.uid)));
        if (escapes.length > 0) {
          return toolError(`Layout "${args.layoutName}" has hierarchy links to instances it does not contain (${escapes.slice(0, 10).join('; ')}), so the copy cannot be remapped.`);
        }

        const uidMap = await remapInstanceUids(instances, reader, idGen);
        const sids = sidRemapper(reader, idGen);
        const sidCount = await remapAllSids(copy, sids.fresh);
        copy.name = args.newName;

        const warnings: string[] = [];
        const globals = await globalTypeNames(reader, instances);
        if (globals.length > 0) {
          warnings.push(`The copy places another instance of global object type(s) ${globals.join(', ')}. Global instances persist across layouts, so running both layouts creates extra instances.`);
        }
        const sourceUids = new Set(uidMap.keys());
        const timelines = await timelinesUsingUids(reader.getProjectDir(), sourceUids);
        if (timelines.length > 0) {
          warnings.push(`Timeline(s) ${timelines.join(', ')} animate instances of "${args.layoutName}" by UID; they still address the originals and were not duplicated.`);
        }
        const uidPicks = await sheetsPickingUids(reader, sourceUids);
        if (uidPicks.length > 0) {
          warnings.push(`Event sheet(s) ${uidPicks.join(', ')} pick instances of "${args.layoutName}" by a fixed UID; those events still pick the originals, not the copies.`);
        }

        await writer.writeEntityFile('layouts', args.newName, copy, subfolder);
        let backupPath: string;
        try {
          backupPath = await registerAfter(writer, 'layouts', args.layoutName, args.newName);
        } catch (e) {
          await discardNewEntityFile(reader, idGen, 'layouts', args.newName, subfolder);
          throw e;
        }
        resetProjectIndex();

        const newUids = [...uidMap.values()];
        return toolResult({
          success: true,
          entity: args.newName,
          category: 'layout',
          action: 'duplicated',
          source: args.layoutName,
          folder: subfolder ?? '',
          layers: collectLayers(copy).length,
          instances: instances.length,
          uidRange: newUids.length > 0 ? [Math.min(...newUids), Math.max(...newUids)] : undefined,
          freshSids: sids.map.size,
          sidKeysRewritten: sidCount,
          eventSheet: copy.eventSheet,
          warnings,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[duplicate_layout] failed:', error);
        return toolError(`Error duplicating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── duplicate_layer ──────────────────────────────────────

  server.tool(
    'duplicate_layer',
    'Duplicate a layer inside its layout under a new name, placed directly above the source layer. Its instances are copied with fresh SIDs and new UIDs; hierarchy links inside the layer are remapped. Refused for a layer with sub-layers, template instances, or hierarchy links to instances on other layers.',
    {
      layoutName: z.string().max(200).describe('Layout that owns the layer'),
      layerName: z.string().max(200).describe('Layer to copy'),
      newName: newNameSchema,
    },
    async (args) => {
      try {
        validateName(args.newName);
        const layouts = await reader.listLayouts();
        if (!layouts.includes(args.layoutName)) {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }
        const layout = await reader.readLayout(args.layoutName);
        const location = findLayerLocation(layout, args.layerName);
        if (!location) {
          const names = collectLayers(layout).map(l => l.name).join(', ');
          return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Layers in this layout: ${names || '(none)'}.`);
        }
        if (collectLayers(layout).some(l => l.name === args.newName)) {
          return toolError(`Layout "${args.layoutName}" already has a layer named "${args.newName}". Layer names must be unique within a layout.`);
        }
        if (Array.isArray(location.layer.subLayers) && location.layer.subLayers.length > 0) {
          return toolError(
            `Layer "${args.layerName}" has sub-layers (${location.layer.subLayers.map(l => l.name).join(', ')}). ` +
            'Copying them would repeat their names inside the layout, which must stay unique. Duplicate a layer without sub-layers.'
          );
        }

        const copy = deepClone(location.layer);
        const instances = instancesOfLayer(copy);
        const templates = templateInstances(instances);
        if (templates.length > 0) {
          return toolError(
            `Layer "${args.layerName}" holds ${templates.length} template instance(s) ` +
            `(${templates.slice(0, 10).map(t => `uid ${t.uid} ${t.type} template "${String(t.templateName)}"`).join('; ')}). ` +
            'A template name can exist only once per object type.'
          );
        }
        const escapes = hierarchyEscapes(instances, new Set(instances.map(i => i.uid)));
        if (escapes.length > 0) {
          return toolError(
            `Layer "${args.layerName}" has hierarchy links to instances on other layers (${escapes.slice(0, 10).join('; ')}). ` +
            'A copy of the layer alone cannot keep those links.'
          );
        }

        await remapInstanceUids(instances, reader, idGen);
        const sids = sidRemapper(reader, idGen);
        await remapAllSids(copy, sids.fresh);
        copy.name = args.newName;
        location.siblings.splice(location.index + 1, 0, copy);

        // Layout View entries that address a copied instance by SID.
        let folderEntries = 0;
        const sceneRoot = layout['scene-graphs-folder-root'] as unknown;
        if (isTree(sceneRoot)) {
          const walk = (folder: TreeFolder) => {
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

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);
        resetProjectIndex();

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
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[duplicate_layer] failed:', error);
        return toolError(`Error duplicating layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── duplicate_event_sheet ────────────────────────────────

  server.tool(
    'duplicate_event_sheet',
    'Duplicate an event sheet under a new name in the same Project Bar folder, with fresh SIDs on every event, condition, action and parameter. Refused when the sheet declares groups, functions, custom actions or global variables, whose names must be unique in the project.',
    {
      sheetName: z.string().max(200).describe('Event sheet to copy'),
      newName: newNameSchema,
    },
    async (args) => {
      try {
        validateName(args.newName);
        const sheets = await reader.listEventSheets();
        if (!sheets.includes(args.sheetName)) {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }
        const clash = sameNameIgnoringCase(sheets, args.newName);
        if (clash) return toolError(`An event sheet named "${clash}" already exists. Sheet names are compared without case because they are file names.`);

        const subfolder = writer.getSubfolderForEntity('eventSheets', args.sheetName);
        const target = resolveProjectPath(reader.getProjectDir(), 'eventSheets', ...splitPath(subfolder ?? ''), `${args.newName}.json`);
        if (await pathExists(target)) {
          return toolError(`eventSheets/${subfolder ? subfolder + '/' : ''}${args.newName}.json already exists on disk but is not registered. Remove it first.`);
        }

        const copy = deepClone(await reader.readEventSheet(args.sheetName));
        const events = (copy.events ?? []) as unknown as Json[];
        const unique: string[] = [];
        const walk = (list: Json[], depth: number) => {
          if (depth > 64) return;
          for (const event of list) {
            if (event.eventType === 'function-block') unique.push(`function "${String(event.functionName)}"`);
            if (event.eventType === 'custom-ace-block') unique.push(`custom action "${String(event.aceName)}" on ${String(event.objectClass)}`);
            if (event.eventType === 'variable' && depth === 0) unique.push(`global variable "${String(event.name)}"`);
            // Group names are unique project-wide: 508 groups in the samples,
            // no title repeated within a project.
            if (event.eventType === 'group') unique.push(`group "${String(event.title)}"`);
            if (Array.isArray(event.children)) walk(event.children as Json[], depth + 1);
          }
        };
        walk(events, 0);
        if (unique.length > 0) {
          return toolError(
            `Event sheet "${args.sheetName}" declares ${unique.length} project-wide name(s): ${unique.slice(0, 10).join(', ')}` +
            `${unique.length > 10 ? ', ...' : ''}. A copy would declare them twice, which Construct rejects. ` +
            'Move those events to another sheet (move_events_between_sheets) or rename them before duplicating.'
          );
        }

        const reassigned = await reassignSids(reader, idGen, copy);
        copy.name = args.newName;

        const warnings: string[] = [];
        warnings.push('The copy is not attached to any layout and is not included by any sheet.');

        await writer.writeEntityFile('eventSheets', args.newName, copy, subfolder);
        let backupPath: string;
        try {
          backupPath = await registerAfter(writer, 'eventSheets', args.sheetName, args.newName);
        } catch (e) {
          await discardNewEntityFile(reader, idGen, 'eventSheets', args.newName, subfolder);
          throw e;
        }
        resetProjectIndex();

        return toolResult({
          success: true,
          entity: args.newName,
          category: 'eventsheet',
          action: 'duplicated',
          source: args.sheetName,
          folder: subfolder ?? '',
          generatedSid: (copy as unknown as Json).sid,
          reassignedSids: reassigned,
          warnings,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[duplicate_event_sheet] failed:', error);
        return toolError(`Error duplicating event sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── duplicate_object_type ────────────────────────────────

  server.tool(
    'duplicate_object_type',
    'Duplicate an object type under a new name in the same Project Bar folder: behaviors, instance variables, effects and animations are copied with fresh SIDs and image IDs, its image files are copied under the new name, and its tilemap brush file is copied. No instances are placed; family and container membership is not copied. Single-global plugins (Keyboard, Mouse, ...) cannot be duplicated.',
    {
      objectName: z.string().max(200).describe('Object type to copy'),
      newName: newNameSchema,
    },
    async (args) => {
      const written: string[] = [];
      const projectDir = reader.getProjectDir();
      try {
        validateName(args.newName);
        const objects = await reader.listObjectTypes();
        if (!objects.includes(args.objectName)) {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }
        const families = await reader.listFamilies();
        const clash = sameNameIgnoringCase([...objects, ...families], args.newName);
        if (clash) {
          return toolError(`"${clash}" is already an object type or family name. Object types and families share one name space.`);
        }

        const source = await reader.readObjectType(args.objectName);
        if (source['singleglobal-inst']) {
          return toolError(`"${args.objectName}" is a single-global ${source['plugin-id']} object; a project can hold only one.`);
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const parts = splitPath(subfolder ?? '');
        if (await pathExists(resolveProjectPath(projectDir, 'objectTypes', ...parts, `${args.newName}.json`))) {
          return toolError(`objectTypes/${subfolder ? subfolder + '/' : ''}${args.newName}.json already exists on disk but is not registered. Remove it first.`);
        }

        // Plan the file copies before writing anything.
        const lowerOld = args.objectName.toLowerCase();
        const lowerNew = args.newName.toLowerCase();
        const images = await objectImageFiles(projectDir, args.objectName);
        const copies: Array<{ from: string[]; to: string[] }> = images.map(image => ({
          from: ['images', image],
          to: ['images', lowerNew + image.slice(lowerOld.length)],
        }));
        const brushFrom = ['tilemapBrushes', 'objectTypes', ...parts, `${args.objectName}.brush.json`];
        if (await pathExists(resolveProjectPath(projectDir, ...brushFrom))) {
          copies.push({ from: brushFrom, to: ['tilemapBrushes', 'objectTypes', ...parts, `${args.newName}.brush.json`] });
        }
        for (const c of copies) {
          if (await pathExists(resolveProjectPath(projectDir, ...c.to))) {
            return toolError(`${rel(c.to)} already exists; the copy's files would overwrite it.`);
          }
        }

        const copy = deepClone(source) as ObjectType;
        copy.name = args.newName;
        const reassignedSids = await reassignSids(reader, idGen, copy);
        let imageIds = 0;
        const stack: unknown[] = [copy];
        while (stack.length > 0) {
          const node = stack.pop();
          if (Array.isArray(node)) {
            node.forEach(child => stack.push(child));
          } else if (node && typeof node === 'object') {
            const record = node as Json;
            for (const [key, child] of Object.entries(record)) {
              if (key === 'imageSpriteId' && typeof child === 'number') {
                record[key] = await idGen.generateImageSpriteId(reader);
                imageIds++;
              } else if (child && typeof child === 'object') {
                stack.push(child);
              }
            }
          }
        }

        for (const c of copies) {
          const to = resolveProjectPath(projectDir, ...c.to);
          await mkdir(dirname(to), { recursive: true });
          await copyFile(resolveProjectPath(projectDir, ...c.from), to);
          written.push(to);
        }
        await writer.writeEntityFile('objectTypes', args.newName, copy, subfolder);
        written.push(resolveProjectPath(projectDir, 'objectTypes', ...parts, `${args.newName}.json`));
        const backupPath = await registerAfter(writer, 'objectTypes', args.objectName, args.newName);
        written.length = 0;
        resetProjectIndex();

        const warnings: string[] = [];
        const memberOf: string[] = [];
        for (const [familyName, family] of await reader.readAllFamilies()) {
          if (Array.isArray(family.members) && (family.members as unknown[]).includes(args.objectName)) memberOf.push(familyName);
        }
        if (memberOf.length > 0) {
          warnings.push(`"${args.objectName}" belongs to famil${memberOf.length === 1 ? 'y' : 'ies'} ${memberOf.join(', ')}; the copy was not added. Use update_family to add it.`);
        }
        const containers = (reader.getProject().containers ?? []).filter(c => Array.isArray(c.members) && c.members.includes(args.objectName));
        if (containers.length > 0) {
          warnings.push(`"${args.objectName}" is in ${containers.length} container(s); the copy was not added.`);
        }
        const hasImageData = imageIds > 0;
        if (hasImageData && images.length === 0) {
          warnings.push(`No image files named "${lowerOld}-*" or "${lowerOld}.*" were found in images/; the copy has no image files.`);
        }

        return toolResult({
          success: true,
          entity: args.newName,
          category: 'objecttype',
          action: 'duplicated',
          source: args.objectName,
          folder: subfolder ?? '',
          generatedSid: copy.sid,
          reassignedSids,
          newImageSpriteIds: imageIds,
          filesCopied: copies.map(c => ({ from: rel(c.from), to: rel(c.to) })),
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        });
      } catch (error) {
        for (const path of written) {
          try { await unlink(path); } catch { /* best-effort */ }
        }
        console.error('[duplicate_object_type] failed:', error);
        return toolError(`Error duplicating object type: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── duplicate_timeline ───────────────────────────────────

  server.tool(
    'duplicate_timeline',
    'Duplicate a timeline under a new name. The copy is registered next to the source and animates the same instances (tracks address instances by UID). Custom eases (registered in the unnamed subfolder of the timelines list) are not timelines and cannot be duplicated here.',
    {
      timelineName: z.string().max(200).describe('Timeline to copy'),
      newName: newNameSchema,
    },
    async (args) => {
      try {
        validateName(args.newName);
        const root = projectTree(reader, 'timelines');
        if (!root) return toolError('project.c3proj has no timelines tree.');
        if (transitionTimelineNames(root).includes(args.timelineName)) {
          return toolError(`"${args.timelineName}" is a custom ease, not a timeline; eases cannot be duplicated with this tool.`);
        }
        if (!root.items.includes(args.timelineName)) {
          const named = locateInTree(root, args.timelineName);
          return toolError(named.length > 0
            ? `Timeline "${args.timelineName}" is in folder "${named[0].path}"; only timelines at the root can be duplicated.`
            : `Timeline "${args.timelineName}" not found. Use list_timelines to see available timelines.`);
        }
        const clash = sameNameIgnoringCase(allTreeNames(root, true), args.newName);
        if (clash) return toolError(`A timeline named "${clash}" already exists.`);

        const projectDir = reader.getProjectDir();
        const sourcePath = resolveProjectPath(projectDir, 'timelines', `${args.timelineName}.json`);
        const targetPath = resolveProjectPath(projectDir, 'timelines', `${args.newName}.json`);
        if (await pathExists(targetPath)) {
          return toolError(`timelines/${args.newName}.json already exists on disk but is not registered. Remove it first.`);
        }
        const copy = JSON.parse(await readFile(sourcePath, 'utf-8')) as Json;
        copy.name = args.newName;
        const tmp = targetPath + '.tmp';
        try {
          await writeFile(tmp, JSON.stringify(copy, null, '\t'), 'utf-8');
          await rename(tmp, targetPath);
        } catch (e) {
          try { await unlink(tmp); } catch { /* best-effort */ }
          throw e;
        }

        let backupPath: string;
        try {
          backupPath = await registerAfter(writer, 'timelines', args.timelineName, args.newName);
        } catch (e) {
          try { await unlink(targetPath); } catch { /* best-effort */ }
          throw e;
        }
        resetProjectIndex();

        const tracks = Array.isArray(copy.tracks) ? copy.tracks as Json[] : [];
        return toolResult({
          success: true,
          entity: args.newName,
          category: 'timeline',
          action: 'duplicated',
          source: args.timelineName,
          tracks: tracks.length,
          warnings: tracks.length > 0
            ? ['The copy animates the same instances as the source; playing both at once makes them compete.']
            : undefined,
          backupFile: backupPath,
        });
      } catch (error) {
        console.error('[duplicate_timeline] failed:', error);
        return toolError(`Error duplicating timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
