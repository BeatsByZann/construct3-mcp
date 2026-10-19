/**
 * Tilemap brush tools: list_tilemap_brushes, add_tilemap_brush,
 * update_tilemap_brush, delete_tilemap_brush.
 *
 * A Tilemap object type's editor brushes live outside the object file, in
 * `tilemapBrushes/objectTypes/<its project-bar folders>/<name>.brush.json`,
 * one folder per path segment. These tools use the file of that name (ignoring
 * letter case) in the object type's own folder, never write outside it, and
 * refuse to write when a brush file named after the object type exists
 * elsewhere below `tilemapBrushes/` while its own folder has none (or the
 * search for one was incomplete), so one object type never gets two brush
 * files.
 *
 * The file is a JSON array of brushes. The tools accept three types, each
 * with its own `data` shape:
 *
 *   { "name": "Brush 0", "type": "auto16", "data": [[0,33,3,36], ... ] }      4 rows x 4 columns
 *   { "name": "Brush 1", "type": "auto47", "data": [[73,39,72,43,37,70,40,38], ... ] }  6 rows x 8 columns
 *   { "name": "Brush 2", "type": "patch",
 *     "data": { "width": 3, "height": 3,
 *               "data": [[4,5,6], [15,[{"index":44,"probability":1}, ...],17], [26,27,28]] } }
 *
 * A grid cell is a tile index, `null` for an empty cell, or (in a `patch`) an
 * array of weighted alternatives `{ index, probability }`. Construct 3 r506-2
 * (Free edition) listed `auto16`, `auto47` and `patch` brushes from files at
 * these paths (the grid of an `auto47` brush was not opened in the brush
 * editor), read tile indices written as bare integers, and wrote cells back
 * as weighted alternatives when it saved after brush editing.
 *
 * A placed Tilemap instance's tile data is handled separately by
 * `tilemap-data-tools.ts`.
 */

import { z } from 'zod';
import type { Dirent } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { dirname, relative, sep } from 'path';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { currentToolCall, fileKey, sameFileState, statFileState, StaleFileError, type FileState } from '../construct3/disk-state.js';
import { applyJsonTextStyle, jsonTextStyleOf, parseJsonText, stripBom } from '../construct3/json-format.js';
import { findNameClash, nameKey } from '../construct3/names.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { toolResult, toolError, validateName } from './shared.js';
import { refusal, stoppedBeforeWrite, unregisteredName, messageWithoutPaths, causeWithoutPaths, syncedTools } from './tilemap-support.js';

/** Largest brush file read, in bytes: the limit the project reader applies to its files. */
const MAX_BRUSH_FILE_BYTES = 10 * 1024 * 1024;
/** Limits of the search below tilemapBrushes/ for a brush file in another folder (those of the rename tools' search). */
const BRUSH_SEARCH_MAX_ENTRIES = 20_000;
const BRUSH_SEARCH_MAX_DEPTH = 8;

/** The brush types a brush file holds. */
export type BrushType = 'auto16' | 'auto47' | 'patch';

/** One cell of a brush grid: a tile index, empty, or weighted alternatives. */
export type BrushCell = number | null | Array<{ index: number; probability: number }>;

/** The data of a patch brush: its size and its rows of cells. */
export interface PatchBrushData {
  width: number;
  height: number;
  data: BrushCell[][];
}

/** One brush of a brush file. */
export interface TilemapBrush {
  name: string;
  type: BrushType;
  data: BrushCell[][] | PatchBrushData;
}

/**
 * Fixed grid dimensions per auto-tiling brush type, the sizes the tools
 * accept: `auto16` is 4 rows of 4, `auto47` is 6 rows of 8.
 */
const AUTO_BRUSH_DIMENSIONS: Record<'auto16' | 'auto47', { rows: number; columns: number }> = {
  auto16: { rows: 4, columns: 4 },
  auto47: { rows: 6, columns: 8 },
};

/** Guard against an unbounded patch payload reaching a project file. */
const MAX_PATCH_SIDE = 256;


/** A cell or value as it is written in a message. */
function describeCell(cell: unknown): string {
  if (cell === null) return 'null';
  if (typeof cell === 'number') return String(cell);
  return JSON.stringify(cell);
}

/** Validate one grid cell. Returns an error message, or null when valid. */
function validateCell(cell: unknown, where: string): string | null {
  if (cell === null) return null;
  if (typeof cell === 'number') {
    return Number.isInteger(cell) && cell >= 0
      ? null
      : `${where}: tile index must be a non-negative integer, got ${describeCell(cell)}.`;
  }
  if (Array.isArray(cell)) {
    if (cell.length === 0) return `${where}: weighted-alternatives list is empty; use a tile index or null instead.`;
    for (let i = 0; i < cell.length; i++) {
      const alt = cell[i] as { index?: unknown; probability?: unknown } | null;
      if (!alt || typeof alt !== 'object' || Array.isArray(alt)) {
        return `${where}[${i}]: expected { index, probability }, got ${describeCell(alt)}.`;
      }
      if (!Number.isInteger(alt.index) || (alt.index as number) < 0) {
        return `${where}[${i}].index: must be a non-negative integer, got ${describeCell(alt.index)}.`;
      }
      if (typeof alt.probability !== 'number' || !(alt.probability > 0)) {
        return `${where}[${i}].probability: must be a number greater than 0, got ${describeCell(alt.probability)}.`;
      }
    }
    return null;
  }
  return `${where}: expected a tile index, null, or a list of { index, probability }, got ${describeCell(cell)}.`;
}

/**
 * Validate a brush's `data` against its `type`, including the grid
 * dimensions. Returns an error message, or null when valid.
 */
export function validateBrushData(type: BrushType, data: unknown): string | null {
  if (type === 'patch') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return 'A "patch" brush needs data of the form { width, height, data: [[...]] }.';
    }
    const patch = data as { width?: unknown; height?: unknown; data?: unknown };
    if (!Number.isInteger(patch.width) || (patch.width as number) < 1) {
      return `A "patch" brush needs an integer width of at least 1, got ${describeCell(patch.width)}.`;
    }
    if (!Number.isInteger(patch.height) || (patch.height as number) < 1) {
      return `A "patch" brush needs an integer height of at least 1, got ${describeCell(patch.height)}.`;
    }
    const width = patch.width as number;
    const height = patch.height as number;
    if (width > MAX_PATCH_SIDE || height > MAX_PATCH_SIDE) {
      return `A "patch" brush may be at most ${MAX_PATCH_SIDE} tiles on a side, got ${width}x${height}.`;
    }
    if (!Array.isArray(patch.data)) {
      return 'A "patch" brush needs data.data as an array of rows.';
    }
    if (patch.data.length !== height) {
      return `A "patch" brush of height ${height} needs ${height} row(s) in data.data, got ${patch.data.length}.`;
    }
    for (let r = 0; r < patch.data.length; r++) {
      const row = patch.data[r];
      if (!Array.isArray(row)) {
        return `data.data[${r}]: expected an array of ${width} cell(s), got ${describeCell(row)}.`;
      }
      if (row.length !== width) {
        return `data.data[${r}]: a "patch" brush of width ${width} needs ${width} cell(s) per row, got ${row.length}.`;
      }
      for (let c = 0; c < row.length; c++) {
        const problem = validateCell(row[c], `data.data[${r}][${c}]`);
        if (problem) return problem;
      }
    }
    return null;
  }

  const { rows, columns } = AUTO_BRUSH_DIMENSIONS[type];
  if (!Array.isArray(data)) {
    return `An "${type}" brush needs data as a ${rows}x${columns} array of rows, got ${describeCell(data)}.`;
  }
  if (data.length !== rows) {
    return `An "${type}" brush needs exactly ${rows} row(s), got ${data.length}.`;
  }
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    if (!Array.isArray(row)) {
      return `data[${r}]: expected an array of ${columns} cell(s), got ${describeCell(row)}.`;
    }
    if (row.length !== columns) {
      return `data[${r}]: an "${type}" brush needs exactly ${columns} cell(s) per row, got ${row.length}.`;
    }
    for (let c = 0; c < row.length; c++) {
      const problem = validateCell(row[c], `data[${r}][${c}]`);
      if (problem) return problem;
    }
  }
  return null;
}

/** Project-relative brush-file path for an object type: one folder per segment of its project-bar folder path. */
export function brushFileRelativePath(objectName: string, subfolder?: string): string {
  return `tilemapBrushes/objectTypes/${subfolder ? subfolder + '/' : ''}${objectName}.brush.json`;
}

/**
 * Text of a brush file holding `brushes`. A new file is written compact (one
 * line, no indentation, no trailing newline, no BOM). An existing file keeps
 * its own layout: compact stays compact, an indented file keeps its indent
 * string and line endings, and the trailing whitespace and BOM are kept
 * exactly.
 */
export function brushFileText(brushes: TilemapBrush[], existingText?: string): string {
  if (existingText === undefined) return JSON.stringify(brushes);
  const body = stripBom(existingText).replace(/[ \t\r\n]+$/, '');
  const indent = /\n([ \t]+)\S/.exec(body)?.[1];
  return applyJsonTextStyle(JSON.stringify(brushes, null, indent), jsonTextStyleOf(existingText));
}

/** Where an object type's brush file is, and its label in messages. */
interface BrushLocation { path: string; label: string }

/** A brush file as read: its brushes, its text, and its state on disk before the read (null: no file). */
interface BrushRead { brushes: TilemapBrush[]; text: string | undefined; state: FileState }

/** The brush file of an object type: the file of that name ignoring case in the object type's own folder, else the path a new file takes. */
async function locateBrushFile(projectDir: string, objectName: string, subfolder: string | undefined): Promise<BrushLocation> {
  const wanted = resolveProjectPath(projectDir, ...brushFileRelativePath(objectName, subfolder).split('/'));
  const path = (await findFileIgnoringCase(wanted)) ?? wanted;
  return { path, label: relative(projectDir, path).split(sep).join('/') };
}

/** Labels of the other brush files found, and whether the search saw everything below tilemapBrushes/. */
export interface ElsewhereSearch { found: string[]; complete: boolean }

/**
 * Labels of files named `<objectName>.brush.json` (ignoring case) below
 * tilemapBrushes/ other than `own`, within the search limits. `complete` is
 * false when the search stopped at the depth or entry limit or could not
 * read a folder: files beyond that point were not looked at, so an empty
 * `found` then proves nothing. A missing tilemapBrushes/ folder is complete
 * (there is nothing to find). `limits` is for tests.
 */
export async function brushFilesElsewhere(
  projectDir: string, objectName: string, own: BrushLocation,
  limits: { maxEntries: number; maxDepth: number; readDir?: (dir: string) => Promise<Dirent[]> } = { maxEntries: BRUSH_SEARCH_MAX_ENTRIES, maxDepth: BRUSH_SEARCH_MAX_DEPTH },
): Promise<ElsewhereSearch> {
  const readDir = limits.readDir ?? ((dir: string) => readdir(dir, { withFileTypes: true }));
  const key = nameKey(`${objectName}.brush.json`);
  const found: string[] = [];
  let entries = 0;
  let complete = true;
  async function walk(dir: string, depth: number, root: boolean): Promise<void> {
    let names: Dirent[];
    try {
      names = await readDir(dir);
    } catch (error) {
      const missing = error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
      if (!(root && missing)) complete = false;
      return;
    }
    for (const entry of names) {
      if (++entries > limits.maxEntries) { complete = false; return; }
      const path = resolveProjectPath(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 > limits.maxDepth) { complete = false; continue; }
        await walk(path, depth + 1, false);
      } else if (nameKey(entry.name) === key && fileKey(path) !== fileKey(own.path)) found.push(relative(projectDir, path).split(sep).join('/'));
    }
  }
  await walk(resolveProjectPath(projectDir, 'tilemapBrushes'), 0, true);
  return { found: found.sort(), complete };
}

/** Why a file could not be read, without its path. */
function readFailure(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
  if (code !== undefined) return `it could not be read (${code})`;
  return error instanceof SyntaxError ? 'it is not valid JSON' : 'it could not be read';
}

/** Read a brush file, taking its state before the read; a missing file is an empty list. Throws an Error whose message names the file by its label. */
async function readBrushFile(location: BrushLocation): Promise<BrushRead> {
  const state = await statFileState(location.path);
  if (state === null) return { brushes: [], text: undefined, state };
  try {
    if ((await stat(location.path)).size > MAX_BRUSH_FILE_BYTES) {
      throw new Error(`the file is too large (over ${MAX_BRUSH_FILE_BYTES / 1024 / 1024}MB)`);
    }
    const text = await readFile(location.path, 'utf-8');
    const parsed = parseJsonText(text);
    if (!Array.isArray(parsed)) throw new Error(`the file is not a JSON array (found ${parsed === null ? 'null' : typeof parsed})`);
    const bad = parsed.findIndex(b => b === null || typeof b !== 'object' || typeof (b as { name?: unknown }).name !== 'string');
    if (bad !== -1) throw new Error(`entry ${bad} is not a brush with a string name`);
    return { brushes: parsed as TilemapBrush[], text, state };
  } catch (error) {
    const reason = error instanceof Error && !(error instanceof SyntaxError) && !('code' in error) ? error.message : readFailure(error);
    throw new Error(`Cannot read the brush file ${location.label}: ${reason}.`);
  }
}

/** Where the file's state from before the call is: its own .bak (checked), "did not exist", or "not known". */
async function beforeCallClause(location: BrushLocation, read: BrushRead): Promise<string> {
  if (read.state === null) return 'it did not exist before the call';
  const record = currentToolCall()?.backups.get(fileKey(location.path));
  if (record !== undefined && record.existed && sameFileState(await statFileState(record.path), record.state)) {
    return `its state from before the call is in ${location.label}.bak`;
  }
  return 'the state from before the call is not known (no backup of this call holds it)';
}

/** What a failed write left besides the file: this call's own backup, and a folder it created. Empty when nothing is left. */
async function leftBehind(location: BrushLocation, folderExisted: boolean): Promise<string[]> {
  const left: string[] = [];
  const record = currentToolCall()?.backups.get(fileKey(location.path));
  if (record !== undefined && record.existed && (await statFileState(record.path)) !== null) left.push(`${location.label}.bak was made by this call`);
  if (!folderExisted) {
    try {
      if ((await statFileState(dirname(location.path))) !== null) left.push(`the folder ${dirname(location.label).split(sep).join('/')} was created by this call`);
    } catch {
      // A folder that cannot be inspected is not reported
    }
  }
  return left;
}

/** The message for a brush file write that failed, saying what the file holds now and what the call left beside it. */
async function failedWriteMessage(location: BrushLocation, read: BrushRead, written: string, cause: string, folderExisted: boolean): Promise<string> {
  let now: string | null;
  try {
    now = await readFile(location.path, 'utf-8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    if (code === 'ENOENT') now = null;
    else return `${cause}. ${location.label} cannot be read now (${code ?? 'unknown error'}); ${await beforeCallClause(location, read)}.`;
  }
  if (now === (read.text ?? null)) {
    const left = await leftBehind(location, folderExisted);
    return left.length === 0
      ? `${cause}. Nothing was changed.`
      : `${cause}. ${location.label} is as it was before the call; ${left.join(' and ')}.`;
  }
  if (now === written) return `${cause}. ${location.label} holds the new brush list although the write was not confirmed; ${await beforeCallClause(location, read)}.`;
  if (now === null) return `${cause}. ${location.label} is missing; ${await beforeCallClause(location, read)}.`;
  return `${cause}. ${location.label} is not as it was before the call (it holds other content than before and than this call wrote); ${await beforeCallClause(location, read)}.`;
}

/**
 * Write the brush list through the writer, in the file's own text style,
 * refused when the file is not as it was read. Returns the backup path
 * (undefined for a new file) or the tool result for a failure.
 */
async function writeBrushFile(
  writer: MutationToolDeps['writer'], projectDir: string, location: BrushLocation, read: BrushRead, brushes: TilemapBrush[],
): Promise<{ backupPath: string | undefined } | { failure: ReturnType<typeof toolError> }> {
  const text = brushFileText(brushes, read.text);
  let folderExisted = true;
  if (read.state === null) {
    try {
      folderExisted = (await statFileState(dirname(location.path))) !== null;
    } catch {
      // A folder that cannot be inspected counts as existing, so none is reported as created
    }
  }
  try {
    return { backupPath: await writer.replaceFile(location.path, text, { expected: read.state }) };
  } catch (error) {
    // A file another program saved after it was read is refused by the writer and untouched
    if (error instanceof StaleFileError) return { failure: toolError(error.message) };
    return { failure: toolError(await failedWriteMessage(location, read, text, causeWithoutPaths(error, projectDir).replace(/[.\s]+$/, ''), folderExisted)) };
  }
}

/** The brush named `name` exactly, or the message for a missing one (naming a case variant's registered spelling). */
function findBrush(brushes: TilemapBrush[], objectName: string, name: string): { index: number } | { error: string } {
  const index = brushes.findIndex(b => b.name === name);
  if (index !== -1) return { index };
  const clash = findNameClash(name, brushes.map(b => b.name));
  if (clash !== undefined) return { error: `"${objectName}" has no brush named "${name}": brush names are matched with their letter case. Did you mean "${clash}"?` };
  return { error: `"${objectName}" has no brush named "${name}". Brushes: ${brushes.map(b => b.name).join(', ') || '(none)'}.` };
}

/** An object type's brush file as one call found it: where it is, what it holds, and the warnings of the call. */
interface OpenedBrushFile { location: BrushLocation; read: BrushRead; warnings: string[] }

/** Human-readable grid size for a brush, for listings. */
function describeBrushSize(brush: TilemapBrush): string {
  if (brush.type === 'patch') {
    const patch = brush.data as PatchBrushData | undefined;
    return patch && typeof patch === 'object' && !Array.isArray(patch)
      ? `${patch.width}x${patch.height}`
      : 'unknown';
  }
  const dimensions = AUTO_BRUSH_DIMENSIONS[brush.type];
  return dimensions ? `${dimensions.columns}x${dimensions.rows}` : 'unknown';
}

/** Register list_tilemap_brushes, add_tilemap_brush, update_tilemap_brush and delete_tilemap_brush. */
export function registerTilemapBrushTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const { readTool, writeTool } = syncedTools(mcpServer, reader);

  /**
   * Find the object type's brush file for one call, or the message that says
   * why the call cannot go on. A name that is not registered, an object type
   * that cannot be read, and (for a write tool, `listing` false) a brush file
   * named after the object type elsewhere or a search that could not rule one
   * out are messages; a file that cannot be read throws.
   */
  async function openBrushFile(objectName: string, listing: boolean): Promise<{ error: string } | OpenedBrushFile> {
    const projectDir = reader.getProjectDir();
    const unknown = unregisteredName('Object', objectName, await reader.listObjectTypes(), reader.findNearestName(objectName, 'objects'), 'list_objects');
    if (unknown !== undefined) return { error: unknown };
    const warnings: string[] = [];
    try {
      const pluginId = (await reader.readObjectType(objectName))['plugin-id'];
      if (pluginId !== 'Tilemap') {
        warnings.push(`"${objectName}" uses plugin "${String(pluginId)}", not "Tilemap"; ${listing ? 'its brush file is listed' : 'the brush file is written'} anyway.`);
      }
    } catch (error) {
      return { error: `Cannot read object type "${objectName}": ${causeWithoutPaths(error, projectDir)}.` };
    }
    const location = await locateBrushFile(projectDir, objectName, writer.getSubfolderForEntity('objectTypes', objectName));
    const elsewhere = await brushFilesElsewhere(projectDir, objectName, location);
    const read = await readBrushFile(location);
    const ownExists = read.state !== null;
    const noOwnFile = `No brush file is in "${objectName}"'s own folder (${location.label})`;
    const limits = `it stops at ${BRUSH_SEARCH_MAX_ENTRIES} entries and ${BRUSH_SEARCH_MAX_DEPTH} folder levels, or a folder could not be read`;
    if (elsewhere.found.length > 0) {
      const others = elsewhere.found.join(', ');
      if (ownExists) warnings.push(`Another brush file is named after "${objectName}": ${others}; it is not used.`);
      else if (listing) warnings.push(`${noOwnFile}; a brush file named after it is at ${others} and is not used.`);
      else return { error: `${noOwnFile}, but ${others} is named after it; move it there or delete it first, so that one object type does not get two brush files.` };
    } else if (!elsewhere.complete && !ownExists) {
      if (listing) warnings.push(`${noOwnFile}, and the search below tilemapBrushes/ for one named after it was not complete (${limits}), so another one may exist.`);
      else return { error: `${noOwnFile}, and the search below tilemapBrushes/ for one named after it was not complete (${limits}), so a second brush file for this object type cannot be ruled out. Move the project's brush files closer to tilemapBrushes/objectTypes/ or create the file in the editor first.` };
    }
    if (!elsewhere.complete && ownExists && listing) {
      warnings.push(`The search below tilemapBrushes/ for other brush files named after "${objectName}" was not complete.`);
    }
    return { location, read, warnings };
  }

  const dataSchema = z.unknown().describe(
    'Brush grid. auto16: 4 rows of 4 tile indices; auto47: 6 rows of 8; patch: { width, height, data: rows of (index | [{ index, probability }]) }. null means an empty cell.'
  );

  readTool(
    'list_tilemap_brushes',
    'List the editor brushes stored for a tilemap object type, with each brush\'s type and grid size. A brush file named after the object type in another folder is reported as a warning.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
    },
    async (args) => {
      try {
        const opened = await openBrushFile(args.objectName, true);
        if ('error' in opened) return toolError(opened.error);
        const { location, read, warnings } = opened;
        return toolResult({
          objectName: args.objectName,
          file: location.label,
          fileExists: read.state !== null,
          brushes: read.brushes.map((brush, index) => ({
            index,
            name: brush.name,
            type: brush.type,
            size: describeBrushSize(brush),
          })),
          count: read.brushes.length,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[list_tilemap_brushes] failed:', error);
        return toolError(`Error listing tilemap brushes: ${messageWithoutPaths(error, reader.getProjectDir())}`);
      }
    }
  );

  writeTool(
    'add_tilemap_brush',
    'Add an editor brush to a tilemap object type\'s brush file, creating the file when it does not exist yet. The brush file is the one in the object type\'s own folder. A brush name that differs from an existing one only in letter case is refused.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
      name: z.string().max(200).describe('Brush name, unique within this object type'),
      type: z.enum(['auto16', 'auto47', 'patch']).describe('Brush type'),
      data: dataSchema,
    },
    async (args) => {
      let opened: OpenedBrushFile;
      let brushes: TilemapBrush[];
      try {
        try { validateName(args.name); } catch (e) { return refusal(e instanceof Error ? e.message : String(e)); }
        const problem = validateBrushData(args.type, args.data);
        if (problem) return refusal(problem);
        const found = await openBrushFile(args.objectName, false);
        if ('error' in found) return refusal(found.error);
        opened = found;
        const clash = findNameClash(args.name, opened.read.brushes.map(b => b.name));
        if (clash !== undefined) {
          return refusal(`"${args.objectName}" already has a brush named "${clash}"${clash === args.name ? '. Use update_tilemap_brush to change it' : ' (brush names that differ only in letter case count as the same here)'}.`);
        }
        brushes = [...opened.read.brushes, { name: args.name, type: args.type, data: args.data } as TilemapBrush];
      } catch (error) {
        console.error('[add_tilemap_brush] failed before the write:', error);
        return stoppedBeforeWrite(error, reader.getProjectDir());
      }

      const written = await writeBrushFile(writer, reader.getProjectDir(), opened.location, opened.read, brushes);
      if ('failure' in written) return written.failure;
      const result: WriteResult = {
        success: true,
        entity: `${args.objectName}/${args.name}`,
        category: 'tilemapbrush',
        action: 'created',
        warnings: opened.warnings.length > 0 ? opened.warnings : undefined,
        backupFile: written.backupPath,
      };
      return toolResult(result);
    }
  );

  writeTool(
    'update_tilemap_brush',
    'Rename a tilemap brush, change its type, or replace its grid data. Changing the type requires data matching the new type.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
      name: z.string().max(200).describe('Current brush name'),
      newName: z.string().max(200).optional().describe('New brush name'),
      type: z.enum(['auto16', 'auto47', 'patch']).optional().describe('New brush type, requires data'),
      data: z.unknown().optional().describe('Replacement grid, validated against the brush\'s (new) type'),
    },
    async (args) => {
      let opened: OpenedBrushFile;
      let brushes: TilemapBrush[];
      let brush: TilemapBrush;
      let unchanged: boolean;
      try {
        if (args.newName === undefined && args.type === undefined && args.data === undefined) {
          return refusal('No updates provided. Specify at least one of: newName, type, data.');
        }
        if (args.type !== undefined && args.data === undefined) {
          return refusal('Changing a brush\'s type requires new data: the grid size differs per type.');
        }
        if (args.newName !== undefined) {
          try { validateName(args.newName); } catch (e) { return refusal(e instanceof Error ? e.message : String(e)); }
        }
        const found = await openBrushFile(args.objectName, false);
        if ('error' in found) return refusal(found.error);
        opened = found;
        if (opened.read.state === null) return refusal(`"${args.objectName}" has no brush file (${opened.location.label}).`);
        brushes = opened.read.brushes;
        const target = findBrush(brushes, args.objectName, args.name);
        if ('error' in target) return refusal(target.error);
        brush = brushes[target.index];
        if (args.newName !== undefined) {
          const clash = findNameClash(args.newName, brushes.filter((_, i) => i !== target.index).map(b => b.name));
          if (clash !== undefined) return refusal(`"${args.objectName}" already has a brush named "${clash}".`);
        }
        const type = args.type ?? brush.type;
        if (args.data !== undefined) {
          const problem = validateBrushData(type, args.data);
          if (problem) return refusal(problem);
        }
        const original = structuredClone(brushes);
        if (args.newName !== undefined) brush.name = args.newName;
        if (args.type !== undefined) brush.type = args.type;
        if (args.data !== undefined) brush.data = args.data as TilemapBrush['data'];
        unchanged = JSON.stringify(brushes) === JSON.stringify(original);
      } catch (error) {
        console.error('[update_tilemap_brush] failed before the write:', error);
        return stoppedBeforeWrite(error, reader.getProjectDir());
      }

      const entity = `${args.objectName}/${brush.name}`;
      if (unchanged) {
        return toolResult({
          success: true,
          entity,
          category: 'tilemapbrush',
          action: 'unchanged',
          message: 'The brush list is as it was; nothing was written.',
          warnings: opened.warnings.length > 0 ? opened.warnings : undefined,
        }, { projectWritten: false });
      }
      const written = await writeBrushFile(writer, reader.getProjectDir(), opened.location, opened.read, brushes);
      if ('failure' in written) return written.failure;
      const result: WriteResult = {
        success: true,
        entity,
        category: 'tilemapbrush',
        action: 'updated',
        warnings: opened.warnings.length > 0 ? opened.warnings : undefined,
        backupFile: written.backupPath,
      };
      return toolResult(result);
    }
  );

  writeTool(
    'delete_tilemap_brush',
    'Delete a tilemap brush. The brush file is kept as an empty array when the last brush is removed.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
      name: z.string().max(200).describe('Brush name to delete'),
    },
    async (args) => {
      let opened: OpenedBrushFile;
      let brushes: TilemapBrush[];
      try {
        const found = await openBrushFile(args.objectName, false);
        if ('error' in found) return refusal(found.error);
        opened = found;
        if (opened.read.state === null) return refusal(`"${args.objectName}" has no brush file (${opened.location.label}).`);
        const target = findBrush(opened.read.brushes, args.objectName, args.name);
        if ('error' in target) return refusal(target.error);
        brushes = opened.read.brushes.filter((_, i) => i !== target.index);
      } catch (error) {
        console.error('[delete_tilemap_brush] failed before the write:', error);
        return stoppedBeforeWrite(error, reader.getProjectDir());
      }

      const written = await writeBrushFile(writer, reader.getProjectDir(), opened.location, opened.read, brushes);
      if ('failure' in written) return written.failure;
      const result: WriteResult = {
        success: true,
        entity: `${args.objectName}/${args.name}`,
        category: 'tilemapbrush',
        action: 'deleted',
        warnings: opened.warnings.length > 0 ? opened.warnings : undefined,
        backupFile: written.backupPath,
      };
      return toolResult(result);
    }
  );
}
