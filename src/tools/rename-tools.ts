/**
 * Rename tools: rename_object_type, rename_family, rename_layout,
 * rename_event_sheet, rename_layer, rename_event_variable.
 *
 * Renaming an entity in Construct 3 is never a single-file edit: the name is
 * duplicated into every event sheet, layout, family, the `project.c3proj`
 * trees and containers, the entity's own file name, and (for object types) its
 * image and tilemap-brush file names. Each tool here collects every reference
 * through the one shared scanner in `src/construct3/references.ts`, rewrites
 * exactly what it reported, and returns the counts per reference kind.
 *
 * `dryRun: true` returns the same reference report and writes nothing.
 *
 * Write order and mid-way failure: referencing files are written first and the
 * entity itself (file plus `project.c3proj` registration) last. Every scan
 * looks for the OLD name, so a file already rewritten contributes nothing on a
 * second pass: re-running the identical call after a failure finishes the job
 * instead of compounding the damage. The reverse order would leave the old
 * name unfindable and the rename unresumable. Each result lists the files
 * written, in order; a failure reports that list so a caller can see exactly
 * how far the rename got.
 */

import { z } from 'zod';
import { readFile, writeFile, copyFile, unlink, rename as renameFile, readdir, stat } from 'fs/promises';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, EventSheet, Layout, ObjectType, Subfolder } from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import { findLayer, collectLayers } from '../construct3/layout-walk.js';
import { findEventBySid } from './event-helpers.js';
import {
  collectObjectNameRefsInSheet,
  collectInstanceTypeRefsInLayout,
  collectFamilyMemberRefs,
  collectIncludeSheetRefs,
  collectLayoutEventSheetRef,
  collectLayoutParameterRefs,
  collectLayerRefsInSheet,
  collectVariableRefsInSheet,
  collectContainerMemberRefs,
  countUnrewrittenObjectMentions,
  renameTreeItem,
  countByKind,
  groupByFile,
  isExpressionIdentifier,
  type RefSite,
} from '../construct3/references.js';

// ─── Result shape ──────────────────────────────────────────

interface RenameResult extends WriteResult {
  previousName: string;
  references: {
    total: number;
    byKind: Record<string, number>;
    byFile: Array<{ file: string; count: number; kinds: Record<string, number> }>;
  };
  filesWritten: string[];
  dryRun: boolean;
}

function buildResult(
  category: string,
  oldName: string,
  newName: string,
  sites: RefSite[],
  filesWritten: string[],
  warnings: string[],
  dryRun: boolean,
  backupFile?: string,
): RenameResult {
  return {
    success: true,
    entity: newName,
    category,
    action: dryRun ? 'dry-run' : 'renamed',
    previousName: oldName,
    references: {
      total: sites.length,
      byKind: countByKind(sites),
      byFile: groupByFile(sites),
    },
    filesWritten,
    dryRun,
    warnings: warnings.length > 0 ? warnings : undefined,
    backupFile,
  };
}

/**
 * Wrap a rename failure so the caller learns how far it got. The files listed
 * were written successfully; re-running the identical call resumes the rename.
 */
function partialFailure(tool: string, error: unknown, filesWritten: string[]) {
  const reason = error instanceof Error ? error.message : String(error);
  const written = filesWritten.length > 0
    ? ` Files already written (in order): ${filesWritten.join(', ')}.`
    : ' No files were written.';
  return toolError(
    `${tool} failed: ${reason}.${written} ` +
    'Re-running the same call resumes the rename: every scan looks for the old name, so a file already rewritten is skipped.'
  );
}

// ─── project.c3proj I/O ────────────────────────────────────
//
// Renaming a tree item in place (rather than remove + append) and renaming
// `containers[].members` have no writer method, so this module reads, edits
// and writes `project.c3proj` with the same backup + temp-file + rename
// pattern `timeline-tools.ts` uses, then asks the reader to reload.

type ProjectJson = Record<string, unknown>;

async function readProjectJson(projectPath: string): Promise<ProjectJson> {
  const content = await readFile(projectPath, 'utf-8');
  return JSON.parse(content) as ProjectJson;
}

async function backupFileIfPresent(filePath: string): Promise<string> {
  const bak = filePath + '.bak';
  try {
    await stat(filePath);
    await copyFile(filePath, bak);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return bak;
    throw e;
  }
  return bak;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(data, null, '\t'), 'utf-8');
  try {
    await renameFile(tmpPath, filePath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(filePath);
      await renameFile(tmpPath, filePath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

// ─── Shared helpers ────────────────────────────────────────

type Reader = MutationToolDeps['reader'];
type Writer = MutationToolDeps['writer'];

/** Every name registered in a project.c3proj container (root plus subfolders). */
function collectContainerNames(container: unknown): Array<{ name: string; subfolder: string }> {
  const out: Array<{ name: string; subfolder: string }> = [];
  const typed = container as { items?: unknown; subfolders?: unknown } | undefined;
  if (!typed) return out;
  if (Array.isArray(typed.items)) {
    for (const item of typed.items) {
      if (typeof item === 'string') out.push({ name: item, subfolder: '' });
    }
  }
  const walk = (subfolders: unknown, prefix: string) => {
    if (!Array.isArray(subfolders)) return;
    for (const raw of subfolders) {
      const folder = raw as Subfolder | undefined;
      if (!folder || typeof folder !== 'object') continue;
      const path = prefix ? `${prefix}/${folder.name}` : String(folder.name);
      if (Array.isArray(folder.items)) {
        for (const item of folder.items) {
          if (typeof item === 'string') out.push({ name: item, subfolder: path });
        }
      }
      walk(folder.subfolders, path);
    }
  };
  walk(typed.subfolders, '');
  return out;
}

/** Warn when the new name cannot appear as an expression identifier. */
function expressionIdentifierWarnings(oldName: string, newName: string): string[] {
  const warnings: string[] = [];
  if (!isExpressionIdentifier(oldName)) {
    warnings.push(
      `"${oldName}" contains a character Construct treats as an expression delimiter (a space, for example), ` +
      'so it cannot appear as an identifier token; expression text was not scanned for it.'
    );
  }
  if (!isExpressionIdentifier(newName)) {
    warnings.push(
      `"${newName}" contains a character Construct treats as an expression delimiter, so existing ` +
      'expressions rewritten to this name will no longer parse. Pick a name without spaces.'
    );
  }
  return warnings;
}

/** Project-relative path of an entity file in a known subfolder. */
function entityRelativePath(
  category: 'objectTypes' | 'eventSheets' | 'layouts' | 'families',
  name: string,
  subfolder?: string,
): string {
  return `${category}/${subfolder ? subfolder + '/' : ''}${name}.json`;
}

/** Write an event sheet through the writer and stale the project index. */
async function writeSheet(writer: Writer, name: string, sheet: EventSheet): Promise<string> {
  const subfolder = writer.getSubfolderForEntity('eventSheets', name);
  const backup = await writer.writeEntityFile('eventSheets', name, sheet, subfolder);
  resetProjectIndex();
  return backup;
}

/** Write a layout through the writer and stale the project index. */
async function writeLayout(writer: Writer, name: string, layout: Layout): Promise<string> {
  const subfolder = writer.getSubfolderForEntity('layouts', name);
  const backup = await writer.writeEntityFile('layouts', name, layout, subfolder);
  resetProjectIndex();
  return backup;
}

/**
 * Rewrite every event sheet that holds a reference, one file at a time.
 * The scan runs twice per sheet — once to decide whether the file needs a
 * write, once with `apply` — so a sheet with no reference is never rewritten.
 */
async function rewriteSheets(
  reader: Reader,
  writer: Writer,
  collect: (file: string, sheet: EventSheet, apply: boolean) => RefSite[],
  filesWritten: string[],
): Promise<void> {
  for (const sheetName of await reader.listEventSheets()) {
    const file = reader.getEntityRelativePath('eventSheets', sheetName);
    let sheet: EventSheet;
    try {
      sheet = await reader.readEventSheet(sheetName);
    } catch {
      continue; // unreadable sheet: reported by the scan phase, not silently rewritten
    }
    if (collect(file, sheet, false).length === 0) continue;
    collect(file, sheet, true);
    await writeSheet(writer, sheetName, sheet);
    filesWritten.push(file);
  }
}

/** Rewrite every layout that holds a reference, one file at a time. */
async function rewriteLayouts(
  reader: Reader,
  writer: Writer,
  collect: (file: string, layout: Layout, apply: boolean) => RefSite[],
  filesWritten: string[],
): Promise<void> {
  for (const layoutName of await reader.listLayouts()) {
    const file = reader.getEntityRelativePath('layouts', layoutName);
    let layout: Layout;
    try {
      layout = await reader.readLayout(layoutName);
    } catch {
      continue;
    }
    if (collect(file, layout, false).length === 0) continue;
    collect(file, layout, true);
    await writeLayout(writer, layoutName, layout);
    filesWritten.push(file);
  }
}

/** Rewrite every family file that holds a reference, one file at a time. */
async function rewriteFamilies(
  reader: Reader,
  writer: Writer,
  oldName: string,
  newName: string,
  filesWritten: string[],
): Promise<void> {
  for (const familyName of await reader.listFamilies()) {
    const file = reader.getEntityRelativePath('families', familyName);
    let family: Record<string, unknown>;
    try {
      family = await reader.readFamily(familyName);
    } catch {
      continue;
    }
    if (collectFamilyMemberRefs(file, family, oldName, newName, false).length === 0) continue;
    collectFamilyMemberRefs(file, family, oldName, newName, true);
    const subfolder = writer.getSubfolderForEntity('families', familyName);
    await writer.writeEntityFile('families', familyName, family, subfolder);
    resetProjectIndex();
    filesWritten.push(file);
  }
}

// ─── Image files ───────────────────────────────────────────

/**
 * Image files belonging to an object type.
 *
 * `getImageFileName` in `png-generator.ts` lowercases the object name, so a
 * Sprite's frames are `images/<lowercase name>-<animation>-NNN.png`
 * (`itemfood-default-000.png` in C3-ACE) and a TiledBg is
 * `images/<lowercase name>.png`. Both forms are matched; the `-` in the
 * Sprite form keeps `item` from matching `itemfood-...`.
 */
async function findImageFiles(projectDir: string, objectName: string): Promise<string[]> {
  const lower = objectName.toLowerCase();
  let entries: string[];
  try {
    entries = await readdir(resolveProjectPath(projectDir, 'images'));
  } catch {
    return [];
  }
  return entries
    .filter(entry => {
      const name = entry.toLowerCase();
      if (name.startsWith(`${lower}-`)) return true;
      const dot = name.lastIndexOf('.');
      return dot > 0 && name.slice(0, dot) === lower;
    })
    .sort();
}

function renamedImageFile(entry: string, oldName: string, newName: string): string {
  return newName.toLowerCase() + entry.slice(oldName.length);
}

// ─── Tilemap brush files ───────────────────────────────────

/**
 * Brush file for an object type.
 *
 * Confirmed in C3-ACE: the object type `Tilemap` lives in the `objectTypes`
 * subfolder `Overhead Game`, and its brushes are at
 * `tilemapBrushes/objectTypes/Overhead Game/Tilemap.brush.json` — the brush
 * path mirrors the object type's subfolder exactly.
 */
export function brushRelativePath(objectName: string, subfolder?: string): string {
  return `tilemapBrushes/objectTypes/${subfolder ? subfolder + '/' : ''}${objectName}.brush.json`;
}

export function brushAbsolutePath(projectDir: string, objectName: string, subfolder?: string): string {
  const segments = subfolder
    ? ['tilemapBrushes', 'objectTypes', subfolder, `${objectName}.brush.json`]
    : ['tilemapBrushes', 'objectTypes', `${objectName}.brush.json`];
  return resolveProjectPath(projectDir, ...segments);
}

// ─── Timelines ─────────────────────────────────────────────

function timelineAbsolutePath(projectDir: string, name: string, subfolder: string): string {
  const segments = subfolder
    ? ['timelines', subfolder, `${name}.json`]
    : ['timelines', `${name}.json`];
  return resolveProjectPath(projectDir, ...segments);
}

function timelineRelativePath(name: string, subfolder: string): string {
  return `timelines/${subfolder ? subfolder + '/' : ''}${name}.json`;
}

/**
 * Find (and optionally rewrite) `startOnLayout` in every timeline file.
 * Confirmed key in C3-ACE: `timelines/Timeline 1.json` has
 * `"startOnLayout": ""`.
 */
async function rewriteTimelineStartOnLayout(
  reader: Reader,
  oldName: string,
  newName: string,
  apply: boolean,
  filesWritten: string[],
): Promise<RefSite[]> {
  const sites: RefSite[] = [];
  const projectDir = reader.getProjectDir();
  const project = reader.getProject() as unknown as ProjectJson;
  for (const { name, subfolder } of collectContainerNames(project.timelines)) {
    const absolute = timelineAbsolutePath(projectDir, name, subfolder);
    let timeline: Record<string, unknown>;
    try {
      timeline = JSON.parse(await readFile(absolute, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (timeline.startOnLayout !== oldName) continue;
    const file = timelineRelativePath(name, subfolder);
    sites.push({ file, path: 'startOnLayout', kind: 'timelineStartOnLayout' });
    if (apply) {
      timeline.startOnLayout = newName;
      await backupFileIfPresent(absolute);
      await atomicWriteJson(absolute, timeline);
      filesWritten.push(file);
    }
  }
  return sites;
}

// ─── Registration ──────────────────────────────────────────

export function registerRenameTools({ server, reader, writer }: MutationToolDeps) {
  const dryRunSchema = z.boolean().optional().default(false)
    .describe('Report every reference that would be rewritten and write nothing');

  // ─── rename_object_type ───────────────────────────────────

  server.tool(
    'rename_object_type',
    'Rename an object type and rewrite every reference: event-sheet objectClass and expression text, layout instance types, family members, project.c3proj containers and tree, the object file, its images and its tilemap brush file.',
    {
      name: z.string().max(200).describe('Current object type name'),
      newName: z.string().max(200).describe('New object type name'),
      dryRun: dryRunSchema,
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        const { name, newName, dryRun } = args;
        if (name === newName) return toolError(`"${name}" is already the object type's name.`);
        validateName(newName);

        const objectTypes = await reader.listObjectTypes();
        if (!objectTypes.includes(name)) {
          return notFoundError('Object', name, reader.findNearestName(name, 'objects'), 'list_objects');
        }
        const families = await reader.listFamilies();
        if (objectTypes.includes(newName)) {
          return toolError(`An object type named "${newName}" already exists. Pick a different name.`);
        }
        if (families.includes(newName)) {
          return toolError(
            `A family named "${newName}" already exists. Object types and families share one name space in Construct, so the rename would be ambiguous.`
          );
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', name);
        const objectType = await reader.readObjectType(name);
        const projectDir = reader.getProjectDir();
        const warnings = expressionIdentifierWarnings(name, newName);

        // ── Scan ──
        const sites: RefSite[] = [];
        let unrewritten = 0;
        for (const sheetName of await reader.listEventSheets()) {
          const file = reader.getEntityRelativePath('eventSheets', sheetName);
          try {
            const sheet = await reader.readEventSheet(sheetName);
            sites.push(...collectObjectNameRefsInSheet(file, sheet, name, newName, false));
            unrewritten += countUnrewrittenObjectMentions(sheet, name);
          } catch (e) {
            warnings.push(`Event sheet "${sheetName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        for (const layoutName of await reader.listLayouts()) {
          const file = reader.getEntityRelativePath('layouts', layoutName);
          try {
            sites.push(...collectInstanceTypeRefsInLayout(file, await reader.readLayout(layoutName), name, newName, false));
          } catch (e) {
            warnings.push(`Layout "${layoutName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        for (const familyName of await reader.listFamilies()) {
          const file = reader.getEntityRelativePath('families', familyName);
          try {
            sites.push(...collectFamilyMemberRefs(file, await reader.readFamily(familyName), name, newName, false));
          } catch (e) {
            warnings.push(`Family "${familyName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const projectProbe = await readProjectJson(reader.getProjectPath());
        sites.push(...collectContainerMemberRefs(projectProbe, name, newName, false));
        sites.push({ file: 'project.c3proj', path: `objectTypes.items[${name}]`, kind: 'projectTree' });

        const entityFile = reader.getEntityRelativePath('objectTypes', name);
        sites.push({ file: entityFile, path: 'name', kind: 'entityName' });
        sites.push({ file: entityFile, path: '<file name>', kind: 'entityFile' });

        const images = await findImageFiles(projectDir, name);
        for (const image of images) {
          sites.push({ file: `images/${image}`, path: '<file name>', kind: 'imageFile' });
        }

        const brushRel = brushRelativePath(name, subfolder);
        const brushAbs = brushAbsolutePath(projectDir, name, subfolder);
        let hasBrush = false;
        try {
          await stat(brushAbs);
          hasBrush = true;
          sites.push({ file: brushRel, path: '<file name>', kind: 'tilemapBrushFile' });
        } catch { /* no brush file */ }

        if (unrewritten > 0) {
          warnings.push(
            `${unrewritten} mention(s) of "${name}" remain in script bodies, comments or variable initial values. ` +
            'Those are JavaScript or free text, not object references, and were not rewritten.'
          );
        }

        if (dryRun) {
          return toolResult(buildResult('objecttype', name, newName, sites, [], warnings, true));
        }

        // ── Apply: references first, the entity itself last ──
        await rewriteSheets(
          reader, writer,
          (file, sheet, apply) => collectObjectNameRefsInSheet(file, sheet, name, newName, apply),
          filesWritten,
        );
        await rewriteLayouts(
          reader, writer,
          (file, layout, apply) => collectInstanceTypeRefsInLayout(file, layout, name, newName, apply),
          filesWritten,
        );
        await rewriteFamilies(reader, writer, name, newName, filesWritten);

        // New object file first, so the c3proj rename never points at a
        // missing file.
        (objectType as ObjectType).name = newName;
        await writer.writeEntityFile('objectTypes', newName, objectType, subfolder);
        filesWritten.push(entityRelativePath('objectTypes', newName, subfolder));

        const project = await readProjectJson(reader.getProjectPath());
        collectContainerMemberRefs(project, name, newName, true);
        renameTreeItem(project.objectTypes as { items?: unknown; subfolders?: unknown }, name, newName, true);
        const backupPath = await backupFileIfPresent(reader.getProjectPath());
        await atomicWriteJson(reader.getProjectPath(), project);
        await reader.reloadProject();
        resetProjectIndex();
        filesWritten.push('project.c3proj');

        await writer.deleteEntityFile('objectTypes', name, subfolder);

        for (const image of images) {
          const target = renamedImageFile(image, name, newName);
          const from = resolveProjectPath(projectDir, 'images', image);
          const to = resolveProjectPath(projectDir, 'images', target);
          try {
            await stat(to);
            warnings.push(`Image "images/${target}" already exists; "images/${image}" was left in place.`);
            continue;
          } catch { /* target free */ }
          await renameFile(from, to);
          filesWritten.push(`images/${target}`);
        }

        if (hasBrush) {
          const target = brushAbsolutePath(projectDir, newName, subfolder);
          await renameFile(brushAbs, target);
          filesWritten.push(brushRelativePath(newName, subfolder));
        }

        return toolResult(buildResult('objecttype', name, newName, sites, filesWritten, warnings, false, backupPath));
      } catch (error) {
        console.error('[rename_object_type] failed:', error);
        return partialFailure('rename_object_type', error, filesWritten);
      }
    }
  );

  // ─── rename_family ────────────────────────────────────────

  server.tool(
    'rename_family',
    'Rename a family and rewrite every reference: event-sheet objectClass (including custom-action owners) and expression text, project.c3proj tree, and the family file. A family has no layout instances, images or tilemap brushes.',
    {
      name: z.string().max(200).describe('Current family name'),
      newName: z.string().max(200).describe('New family name'),
      dryRun: dryRunSchema,
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        const { name, newName, dryRun } = args;
        if (name === newName) return toolError(`"${name}" is already the family's name.`);
        validateName(newName);

        const families = await reader.listFamilies();
        if (!families.includes(name)) {
          return toolError(`Family "${name}" not found. Use list_families to see all available names.`);
        }
        const objectTypes = await reader.listObjectTypes();
        if (families.includes(newName)) {
          return toolError(`A family named "${newName}" already exists. Pick a different name.`);
        }
        if (objectTypes.includes(newName)) {
          return toolError(
            `An object type named "${newName}" already exists. Object types and families share one name space in Construct, so the rename would be ambiguous.`
          );
        }

        const subfolder = writer.getSubfolderForEntity('families', name);
        const family = await reader.readFamily(name);
        const warnings = expressionIdentifierWarnings(name, newName);

        const sites: RefSite[] = [];
        let unrewritten = 0;
        for (const sheetName of await reader.listEventSheets()) {
          const file = reader.getEntityRelativePath('eventSheets', sheetName);
          try {
            const sheet = await reader.readEventSheet(sheetName);
            sites.push(...collectObjectNameRefsInSheet(file, sheet, name, newName, false));
            unrewritten += countUnrewrittenObjectMentions(sheet, name);
          } catch (e) {
            warnings.push(`Event sheet "${sheetName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        sites.push({ file: 'project.c3proj', path: `families.items[${name}]`, kind: 'projectTree' });
        const entityFile = reader.getEntityRelativePath('families', name);
        sites.push({ file: entityFile, path: 'name', kind: 'entityName' });
        sites.push({ file: entityFile, path: '<file name>', kind: 'entityFile' });

        if (unrewritten > 0) {
          warnings.push(
            `${unrewritten} mention(s) of "${name}" remain in script bodies, comments or variable initial values and were not rewritten.`
          );
        }

        if (dryRun) {
          return toolResult(buildResult('family', name, newName, sites, [], warnings, true));
        }

        await rewriteSheets(
          reader, writer,
          (file, sheet, apply) => collectObjectNameRefsInSheet(file, sheet, name, newName, apply),
          filesWritten,
        );

        (family as Record<string, unknown>).name = newName;
        await writer.writeEntityFile('families', newName, family, subfolder);
        filesWritten.push(entityRelativePath('families', newName, subfolder));

        const project = await readProjectJson(reader.getProjectPath());
        renameTreeItem(project.families as { items?: unknown; subfolders?: unknown }, name, newName, true);
        const backupPath = await backupFileIfPresent(reader.getProjectPath());
        await atomicWriteJson(reader.getProjectPath(), project);
        await reader.reloadProject();
        resetProjectIndex();
        filesWritten.push('project.c3proj');

        await writer.deleteEntityFile('families', name, subfolder);

        return toolResult(buildResult('family', name, newName, sites, filesWritten, warnings, false, backupPath));
      } catch (error) {
        console.error('[rename_family] failed:', error);
        return partialFailure('rename_family', error, filesWritten);
      }
    }
  );

  // ─── rename_layout ────────────────────────────────────────

  server.tool(
    'rename_layout',
    'Rename a layout and rewrite every reference: project.c3proj firstLayout and tree, each timeline\'s startOnLayout, layout-keyed action parameters, and the layout file.',
    {
      name: z.string().max(200).describe('Current layout name'),
      newName: z.string().max(200).describe('New layout name'),
      dryRun: dryRunSchema,
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        const { name, newName, dryRun } = args;
        if (name === newName) return toolError(`"${name}" is already the layout's name.`);
        validateName(newName);

        const layouts = await reader.listLayouts();
        if (!layouts.includes(name)) {
          return notFoundError('Layout', name, reader.findNearestName(name, 'layouts'), 'list_layouts');
        }
        if (layouts.includes(newName)) {
          return toolError(`A layout named "${newName}" already exists. Pick a different name.`);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', name);
        const layout = await reader.readLayout(name);
        const warnings: string[] = [];

        const sites: RefSite[] = [];
        for (const sheetName of await reader.listEventSheets()) {
          const file = reader.getEntityRelativePath('eventSheets', sheetName);
          try {
            sites.push(...collectLayoutParameterRefs(file, await reader.readEventSheet(sheetName), name, newName, false));
          } catch (e) {
            warnings.push(`Event sheet "${sheetName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        sites.push(...await rewriteTimelineStartOnLayout(reader, name, newName, false, filesWritten));

        const projectProbe = await readProjectJson(reader.getProjectPath());
        const isFirstLayout = projectProbe.firstLayout === name;
        if (isFirstLayout) {
          sites.push({ file: 'project.c3proj', path: 'firstLayout', kind: 'firstLayout' });
        }
        sites.push({ file: 'project.c3proj', path: `layouts.items[${name}]`, kind: 'projectTree' });

        const entityFile = reader.getEntityRelativePath('layouts', name);
        sites.push({ file: entityFile, path: 'name', kind: 'entityName' });
        sites.push({ file: entityFile, path: '<file name>', kind: 'entityFile' });

        warnings.push(
          'Layout names are not scanned inside general expression text: no layout-valued parameter exists in the reference project, ' +
          'so only "layout"-keyed parameters, firstLayout, startOnLayout and the registration are rewritten.'
        );

        if (dryRun) {
          return toolResult(buildResult('layout', name, newName, sites, [], warnings, true));
        }

        await rewriteSheets(
          reader, writer,
          (file, sheet, apply) => collectLayoutParameterRefs(file, sheet, name, newName, apply),
          filesWritten,
        );
        await rewriteTimelineStartOnLayout(reader, name, newName, true, filesWritten);

        (layout as Layout).name = newName;
        await writer.writeEntityFile('layouts', newName, layout, subfolder);
        filesWritten.push(entityRelativePath('layouts', newName, subfolder));

        const project = await readProjectJson(reader.getProjectPath());
        if (project.firstLayout === name) project.firstLayout = newName;
        renameTreeItem(project.layouts as { items?: unknown; subfolders?: unknown }, name, newName, true);
        const backupPath = await backupFileIfPresent(reader.getProjectPath());
        await atomicWriteJson(reader.getProjectPath(), project);
        await reader.reloadProject();
        resetProjectIndex();
        filesWritten.push('project.c3proj');

        await writer.deleteEntityFile('layouts', name, subfolder);

        return toolResult(buildResult('layout', name, newName, sites, filesWritten, warnings, false, backupPath));
      } catch (error) {
        console.error('[rename_layout] failed:', error);
        return partialFailure('rename_layout', error, filesWritten);
      }
    }
  );

  // ─── rename_event_sheet ───────────────────────────────────

  server.tool(
    'rename_event_sheet',
    'Rename an event sheet and rewrite every reference: each layout\'s eventSheet binding, every includeSheet, the project.c3proj tree, and the sheet file.',
    {
      name: z.string().max(200).describe('Current event sheet name'),
      newName: z.string().max(200).describe('New event sheet name'),
      dryRun: dryRunSchema,
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        const { name, newName, dryRun } = args;
        if (name === newName) return toolError(`"${name}" is already the event sheet's name.`);
        validateName(newName);

        const sheets = await reader.listEventSheets();
        if (!sheets.includes(name)) {
          return notFoundError('Event sheet', name, reader.findNearestName(name, 'eventsheets'), 'list_eventsheets');
        }
        if (sheets.includes(newName)) {
          return toolError(`An event sheet named "${newName}" already exists. Pick a different name.`);
        }

        const subfolder = writer.getSubfolderForEntity('eventSheets', name);
        const sheet = await reader.readEventSheet(name);
        const warnings: string[] = [];

        const sites: RefSite[] = [];
        for (const layoutName of await reader.listLayouts()) {
          const file = reader.getEntityRelativePath('layouts', layoutName);
          try {
            sites.push(...collectLayoutEventSheetRef(file, await reader.readLayout(layoutName), name, newName, false));
          } catch (e) {
            warnings.push(`Layout "${layoutName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        for (const sheetName of sheets) {
          const file = reader.getEntityRelativePath('eventSheets', sheetName);
          try {
            sites.push(...collectIncludeSheetRefs(file, await reader.readEventSheet(sheetName), name, newName, false));
          } catch (e) {
            warnings.push(`Event sheet "${sheetName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        sites.push({ file: 'project.c3proj', path: `eventSheets.items[${name}]`, kind: 'projectTree' });
        const entityFile = reader.getEntityRelativePath('eventSheets', name);
        sites.push({ file: entityFile, path: 'name', kind: 'entityName' });
        sites.push({ file: entityFile, path: '<file name>', kind: 'entityFile' });

        if (dryRun) {
          return toolResult(buildResult('eventsheet', name, newName, sites, [], warnings, true));
        }

        await rewriteLayouts(
          reader, writer,
          (file, layout, apply) => collectLayoutEventSheetRef(file, layout, name, newName, apply),
          filesWritten,
        );
        await rewriteSheets(
          reader, writer,
          (file, s, apply) => collectIncludeSheetRefs(file, s, name, newName, apply),
          filesWritten,
        );

        (sheet as EventSheet).name = newName;
        await writer.writeEntityFile('eventSheets', newName, sheet, subfolder);
        filesWritten.push(entityRelativePath('eventSheets', newName, subfolder));

        const project = await readProjectJson(reader.getProjectPath());
        renameTreeItem(project.eventSheets as { items?: unknown; subfolders?: unknown }, name, newName, true);
        const backupPath = await backupFileIfPresent(reader.getProjectPath());
        await atomicWriteJson(reader.getProjectPath(), project);
        await reader.reloadProject();
        resetProjectIndex();
        filesWritten.push('project.c3proj');

        await writer.deleteEntityFile('eventSheets', name, subfolder);

        return toolResult(buildResult('eventsheet', name, newName, sites, filesWritten, warnings, false, backupPath));
      } catch (error) {
        console.error('[rename_event_sheet] failed:', error);
        return partialFailure('rename_event_sheet', error, filesWritten);
      }
    }
  );

  // ─── rename_layer ─────────────────────────────────────────

  server.tool(
    'rename_layer',
    'Rename a layer inside one layout and rewrite the layer-name references in event sheets: "layer"-keyed parameters and whole "<name>" string literals in expressions such as LayerScale("UI"). Skipped, with a warning, when another layout has a layer of the same name.',
    {
      layoutName: z.string().max(200).describe('Layout that owns the layer'),
      layerName: z.string().max(200).describe('Current layer name'),
      newName: z.string().max(200).describe('New layer name'),
      dryRun: dryRunSchema,
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        const { layoutName, layerName, newName, dryRun } = args;
        if (layerName === newName) return toolError(`"${layerName}" is already the layer's name.`);
        validateName(newName);

        const layouts = await reader.listLayouts();
        if (!layouts.includes(layoutName)) {
          return notFoundError('Layout', layoutName, reader.findNearestName(layoutName, 'layouts'), 'list_layouts');
        }
        const layout = await reader.readLayout(layoutName);
        const layer = findLayer(layout, layerName);
        if (!layer) {
          const names = collectLayers(layout).map(l => l.name).join(', ');
          return toolError(`Layer "${layerName}" not found in layout "${layoutName}". Layers in this layout: ${names || '(none)'}.`);
        }
        if (collectLayers(layout).some(l => l.name === newName)) {
          return toolError(`Layout "${layoutName}" already has a layer named "${newName}". Layer names must be unique within a layout.`);
        }

        const warnings: string[] = [];
        // A layer name is only unique within its layout, but an event-sheet
        // "layer" parameter is not layout-scoped: C3-ACE has eight layouts
        // carrying a layer called l_BehaviorTrees. Rewriting sheet references
        // would silently retarget the other layouts' layers, so the sheet pass
        // is skipped when the name is shared.
        const sharedWith = (await Promise.all(
          layouts
            .filter(other => other !== layoutName)
            .map(async other => {
              try {
                return collectLayers(await reader.readLayout(other)).some(l => l.name === layerName) ? other : null;
              } catch {
                return null;
              }
            }),
        )).filter((other): other is string => other !== null);

        const layoutFile = reader.getEntityRelativePath('layouts', layoutName);
        const sites: RefSite[] = [{ file: layoutFile, path: `layers[${layerName}].name`, kind: 'layerName' }];

        if (sharedWith.length > 0) {
          warnings.push(
            `Layouts ${sharedWith.join(', ')} also have a layer named "${layerName}". Event-sheet layer references are not ` +
            'layout-scoped, so rewriting them would retarget those layouts too; only this layout\'s layer was renamed. ' +
            'Update the affected event-sheet parameters yourself, or rename the other layouts\' layers first.'
          );
        } else {
          for (const sheetName of await reader.listEventSheets()) {
            const file = reader.getEntityRelativePath('eventSheets', sheetName);
            try {
              sites.push(...collectLayerRefsInSheet(file, await reader.readEventSheet(sheetName), layerName, newName, false));
            } catch (e) {
              warnings.push(`Event sheet "${sheetName}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        warnings.push(
          'A layer name stored as instance-variable data or built at runtime from an expression cannot be told apart from ' +
          'ordinary text and is not rewritten.'
        );

        if (dryRun) {
          return toolResult(buildResult('layer', layerName, newName, sites, [], warnings, true));
        }

        if (sharedWith.length === 0) {
          await rewriteSheets(
            reader, writer,
            (file, sheet, apply) => collectLayerRefsInSheet(file, sheet, layerName, newName, apply),
            filesWritten,
          );
        }

        const fresh = await reader.readLayout(layoutName);
        const freshLayer = findLayer(fresh, layerName);
        if (!freshLayer) {
          return toolError(`Layer "${layerName}" disappeared from layout "${layoutName}" while renaming.`);
        }
        freshLayer.name = newName;
        const backupPath = await writeLayout(writer, layoutName, fresh);
        filesWritten.push(layoutFile);

        return toolResult(buildResult('layer', layerName, newName, sites, filesWritten, warnings, false, backupPath));
      } catch (error) {
        console.error('[rename_layer] failed:', error);
        return partialFailure('rename_layer', error, filesWritten);
      }
    }
  );

  // ─── rename_event_variable ────────────────────────────────

  server.tool(
    'rename_event_variable',
    'Rename an event variable by its declaration SID and rewrite every reference: "variable"-keyed parameters and bare identifier tokens in expression text. A root-level (global) variable is rewritten across all sheets; a nested (local) one only within its own sheet.',
    {
      sheetName: z.string().max(200).describe('Event sheet holding the variable declaration'),
      sid: z.number().int().describe('SID of the variable event to rename'),
      newName: z.string().max(200).describe('New variable name'),
      dryRun: dryRunSchema,
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        const { sheetName, sid, newName, dryRun } = args;
        validateName(newName);

        let sheet: EventSheet;
        try {
          sheet = await reader.readEventSheet(sheetName);
        } catch {
          return notFoundError('Event sheet', sheetName, reader.findNearestName(sheetName, 'eventsheets'), 'list_eventsheets');
        }

        const found = findEventBySid(sheet.events as unknown as Record<string, unknown>[], sid);
        if (!found) {
          return toolError(`No event with SID ${sid} found in sheet "${sheetName}".`);
        }
        if (found.event.eventType !== 'variable') {
          return toolError(`Event SID ${sid} is a "${found.event.eventType}" event, not a variable event.`);
        }
        const oldName = String(found.event.name);
        if (oldName === newName) return toolError(`"${oldName}" is already the variable's name.`);

        // A declaration at the sheet root is a global event variable and is
        // visible project-wide; a nested one is local to its container.
        const isGlobal = found.parentEvent === undefined;
        const scopeSheets = isGlobal ? await reader.listEventSheets() : [sheetName];

        const warnings = expressionIdentifierWarnings(oldName, newName);
        const clash = await findVariableNameClash(reader, newName, sid, isGlobal, sheetName);
        if (clash) return toolError(clash);
        const shadowing = isGlobal ? await sheetsWithLocalDeclaration(reader, newName, sid) : [];

        const ownerFile = reader.getEntityRelativePath('eventSheets', sheetName);
        const sites: RefSite[] = [{ file: ownerFile, path: 'name', kind: 'variableDeclaration' }];
        for (const scopeSheet of scopeSheets) {
          const file = reader.getEntityRelativePath('eventSheets', scopeSheet);
          try {
            sites.push(...collectVariableRefsInSheet(file, await reader.readEventSheet(scopeSheet), oldName, newName, false));
          } catch (e) {
            warnings.push(`Event sheet "${scopeSheet}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        warnings.push(
          isGlobal
            ? 'The declaration is at the sheet root, so it is a global event variable and every sheet was rewritten.'
            : `The declaration is nested, so it is a local variable and only "${sheetName}" was rewritten.`
        );
        if (shadowing.length > 0) {
          warnings.push(
            `A local variable named "${newName}" is declared inside ${shadowing.join(', ')}. Construct resolves the ` +
            'local first inside its container, so the rewritten expressions there will read the local, not this global.'
          );
        }
        if (!isGlobal && variableNameInUse(sheet.events as unknown as Array<Record<string, unknown>>, oldName, sid)) {
          warnings.push(
            `Another declaration in "${sheetName}" is also named "${oldName}". A local variable's scope cannot be told ` +
            'apart from a sibling scope in expression text, so uses belonging to that other declaration were rewritten too.'
          );
        }

        if (dryRun) {
          return toolResult(buildResult('eventvariable', oldName, newName, sites, [], warnings, true));
        }

        // Other sheets first; the sheet holding the declaration is written
        // last so the old name stays findable if a write fails.
        for (const scopeSheet of scopeSheets) {
          if (scopeSheet === sheetName) continue;
          const file = reader.getEntityRelativePath('eventSheets', scopeSheet);
          let other: EventSheet;
          try {
            other = await reader.readEventSheet(scopeSheet);
          } catch {
            continue;
          }
          if (collectVariableRefsInSheet(file, other, oldName, newName, false).length === 0) continue;
          collectVariableRefsInSheet(file, other, oldName, newName, true);
          await writeSheet(writer, scopeSheet, other);
          filesWritten.push(file);
        }

        const owner = await reader.readEventSheet(sheetName);
        const ownerFound = findEventBySid(owner.events as unknown as Record<string, unknown>[], sid);
        if (!ownerFound) {
          return toolError(`Variable SID ${sid} disappeared from sheet "${sheetName}" while renaming.`);
        }
        collectVariableRefsInSheet(ownerFile, owner, oldName, newName, true);
        ownerFound.event.name = newName;
        const backupPath = await writeSheet(writer, sheetName, owner);
        filesWritten.push(ownerFile);

        return toolResult(buildResult('eventvariable', oldName, newName, sites, filesWritten, warnings, false, backupPath));
      } catch (error) {
        console.error('[rename_event_variable] failed:', error);
        return partialFailure('rename_event_variable', error, filesWritten);
      }
    }
  );
}

/**
 * Reject a new variable name that is already taken.
 *
 * A global (root-level) declaration is visible project-wide, so it is checked
 * against every sheet's root-level variables; a local one only against its own
 * sheet's declarations.
 */
async function findVariableNameClash(
  reader: Reader,
  newName: string,
  excludeSid: number,
  isGlobal: boolean,
  sheetName: string,
): Promise<string | null> {
  const sheets = isGlobal ? await reader.listEventSheets() : [sheetName];
  for (const name of sheets) {
    let sheet: EventSheet;
    try {
      sheet = await reader.readEventSheet(name);
    } catch {
      continue;
    }
    const events = (sheet.events ?? []) as unknown as Array<Record<string, unknown>>;
    if (isGlobal) {
      for (const event of events) {
        if (event.eventType === 'variable' && event.name === newName && event.sid !== excludeSid) {
          return `A global event variable named "${newName}" already exists in sheet "${name}".`;
        }
      }
      continue;
    }
    if (variableNameInUse(events, newName, excludeSid)) {
      return `A variable named "${newName}" already exists in sheet "${name}".`;
    }
  }
  return null;
}

/**
 * Sheets holding a nested (local) declaration of `name`. Renaming a global to
 * that name is not rejected — Construct scopes local variables to their
 * container — but the rewritten expressions inside those containers would then
 * resolve to the local, so the caller is warned.
 */
async function sheetsWithLocalDeclaration(reader: Reader, name: string, excludeSid: number): Promise<string[]> {
  const out: string[] = [];
  for (const sheetName of await reader.listEventSheets()) {
    let sheet: EventSheet;
    try {
      sheet = await reader.readEventSheet(sheetName);
    } catch {
      continue;
    }
    const events = (sheet.events ?? []) as unknown as Array<Record<string, unknown>>;
    const nested = events.some(event => Array.isArray(event.children)
      && variableNameInUse(event.children as Array<Record<string, unknown>>, name, excludeSid));
    if (nested) out.push(sheetName);
  }
  return out;
}

/** Recursive declaration search, used for the local-variable clash check. */
function variableNameInUse(events: Array<Record<string, unknown>>, name: string, excludeSid: number): boolean {
  for (const event of events) {
    if (event.eventType === 'variable' && event.name === name && event.sid !== excludeSid) return true;
    if (Array.isArray(event.children)
      && variableNameInUse(event.children as Array<Record<string, unknown>>, name, excludeSid)) {
      return true;
    }
  }
  return false;
}
