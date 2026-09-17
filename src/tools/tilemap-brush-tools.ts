/**
 * Tilemap brush tools: list_tilemap_brushes, add_tilemap_brush,
 * update_tilemap_brush, delete_tilemap_brush.
 *
 * A Tilemap object type's editor brushes live outside the object file, in
 * `tilemapBrushes/objectTypes/<same subfolder as the object type>/<name>.brush.json`.
 * Confirmed in C3-ACE (Construct 3 r495): the object type `Tilemap` is
 * registered in the `objectTypes` subfolder `Overhead Game`, and its brushes
 * are at `tilemapBrushes/objectTypes/Overhead Game/Tilemap.brush.json` — the
 * brush path mirrors the object type's subfolder exactly.
 *
 * The file is a JSON array of brushes. Three types were observed, each with
 * its own `data` shape:
 *
 *   { "name": "Brush 0", "type": "auto16", "data": [[0,33,3,36], ... ] }      4 rows x 4 columns
 *   { "name": "Brush 1", "type": "auto47", "data": [[73,39,72,43,37,70,40,38], ... ] }  6 rows x 8 columns
 *   { "name": "Brush 2", "type": "patch",
 *     "data": { "width": 3, "height": 3,
 *               "data": [[4,5,6], [15,[{"index":44,"probability":1}, ...],17], [26,27,28]] } }
 *
 * A grid cell is a tile index, `null` for an empty cell (observed once, at the
 * end of an `auto47` grid), or — in a `patch` — an array of weighted
 * alternatives `{ index, probability }` that Construct picks between.
 *
 * A placed Tilemap instance's tile data is handled separately by
 * `tilemap-data-tools.ts`.
 */

import { z } from 'zod';
import { readFile, writeFile, copyFile, unlink, rename, mkdir, stat } from 'fs/promises';
import { dirname } from 'path';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { toolResult, toolError, notFoundError, validateName } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';

// ─── Brush shape ───────────────────────────────────────────

export type BrushType = 'auto16' | 'auto47' | 'patch';

/** One cell of a brush grid: a tile index, empty, or weighted alternatives. */
export type BrushCell = number | null | Array<{ index: number; probability: number }>;

export interface PatchBrushData {
  width: number;
  height: number;
  data: BrushCell[][];
}

export interface TilemapBrush {
  name: string;
  type: BrushType;
  data: BrushCell[][] | PatchBrushData;
}

/**
 * Fixed grid dimensions per auto-tiling brush type, taken from the sample:
 * `auto16` is 4 rows of 4, `auto47` is 6 rows of 8.
 */
const AUTO_BRUSH_DIMENSIONS: Record<'auto16' | 'auto47', { rows: number; columns: number }> = {
  auto16: { rows: 4, columns: 4 },
  auto47: { rows: 6, columns: 8 },
};

/** Guard against an unbounded patch payload reaching a project file. */
const MAX_PATCH_SIDE = 256;

// ─── Validation ────────────────────────────────────────────

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

// ─── File I/O ──────────────────────────────────────────────

/** Project-relative brush-file path for an object type. */
export function brushFileRelativePath(objectName: string, subfolder?: string): string {
  return `tilemapBrushes/objectTypes/${subfolder ? subfolder + '/' : ''}${objectName}.brush.json`;
}

function brushFileAbsolutePath(projectDir: string, objectName: string, subfolder?: string): string {
  const segments = subfolder
    ? ['tilemapBrushes', 'objectTypes', subfolder, `${objectName}.brush.json`]
    : ['tilemapBrushes', 'objectTypes', `${objectName}.brush.json`];
  return resolveProjectPath(projectDir, ...segments);
}

/** Read a brush file, treating a missing file as an empty brush list. */
async function readBrushFile(absolutePath: string): Promise<{ brushes: TilemapBrush[]; existed: boolean }> {
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf-8');
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      return { brushes: [], existed: false };
    }
    throw e;
  }
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Brush file is not a JSON array (found ${typeof parsed}); it may have been hand-edited.`);
  }
  return { brushes: parsed as TilemapBrush[], existed: true };
}

async function backupIfPresent(filePath: string): Promise<string> {
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

/**
 * Write the brush array with the backup + temp-file + rename pattern the rest
 * of this server uses. C3 writes brush files as compact JSON (no indentation),
 * which is preserved here.
 */
async function writeBrushFile(absolutePath: string, brushes: TilemapBrush[]): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const tmpPath = absolutePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(brushes), 'utf-8');
  try {
    await rename(tmpPath, absolutePath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(absolutePath);
      await rename(tmpPath, absolutePath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

// ─── Registration ──────────────────────────────────────────

export function registerTilemapBrushTools({ server, reader, writer }: MutationToolDeps) {
  /**
   * Resolve the object type and its brush file, rejecting a name that is not
   * an object type. A non-Tilemap plugin is a warning, not an error: the
   * plugin id of a third-party tilemap addon is not knowable here.
   */
  async function resolveTarget(objectName: string): Promise<
    | { error: ReturnType<typeof toolError> }
    | { absolutePath: string; relativePath: string; warnings: string[] }
  > {
    const objectTypes = await reader.listObjectTypes();
    if (!objectTypes.includes(objectName)) {
      return { error: notFoundError('Object', objectName, reader.findNearestName(objectName, 'objects'), 'list_objects') };
    }
    const warnings: string[] = [];
    try {
      const objectType = await reader.readObjectType(objectName);
      if (objectType['plugin-id'] !== 'Tilemap') {
        warnings.push(
          `"${objectName}" uses plugin "${objectType['plugin-id']}", not "Tilemap". Construct only reads brush files for ` +
          'tilemap object types, so this file may be ignored.'
        );
      }
    } catch (e) {
      warnings.push(`Could not read object type "${objectName}" to check its plugin: ${e instanceof Error ? e.message : String(e)}`);
    }
    const subfolder = writer.getSubfolderForEntity('objectTypes', objectName);
    return {
      absolutePath: brushFileAbsolutePath(reader.getProjectDir(), objectName, subfolder),
      relativePath: brushFileRelativePath(objectName, subfolder),
      warnings,
    };
  }

  const dataSchema = z.unknown().describe(
    'Brush grid. auto16: 4 rows of 4 tile indices; auto47: 6 rows of 8; patch: { width, height, data: rows of (index | [{ index, probability }]) }. null means an empty cell.'
  );

  // ─── list_tilemap_brushes ─────────────────────────────────

  server.tool(
    'list_tilemap_brushes',
    'List the editor brushes stored for a tilemap object type, with each brush\'s type and grid size.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
    },
    async (args) => {
      try {
        const target = await resolveTarget(args.objectName);
        if ('error' in target) return target.error;

        const { brushes, existed } = await readBrushFile(target.absolutePath);
        return toolResult({
          objectName: args.objectName,
          file: target.relativePath,
          fileExists: existed,
          brushes: brushes.map((brush, index) => ({
            index,
            name: brush.name,
            type: brush.type,
            size: describeBrushSize(brush),
          })),
          count: brushes.length,
          warnings: target.warnings.length > 0 ? target.warnings : undefined,
        });
      } catch (error) {
        console.error('[list_tilemap_brushes] failed:', error);
        return toolError(`Error listing tilemap brushes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_tilemap_brush ────────────────────────────────────

  server.tool(
    'add_tilemap_brush',
    'Add an editor brush to a tilemap object type\'s brush file, creating the file when it does not exist yet.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
      name: z.string().max(200).describe('Brush name, unique within this object type'),
      type: z.enum(['auto16', 'auto47', 'patch']).describe('Brush type'),
      data: dataSchema,
    },
    async (args) => {
      try {
        validateName(args.name);
        const problem = validateBrushData(args.type, args.data);
        if (problem) return toolError(problem);

        const target = await resolveTarget(args.objectName);
        if ('error' in target) return target.error;

        const { brushes } = await readBrushFile(target.absolutePath);
        if (brushes.some(brush => brush.name === args.name)) {
          return toolError(
            `"${args.objectName}" already has a brush named "${args.name}". Use update_tilemap_brush to change it.`
          );
        }

        const brush = { name: args.name, type: args.type, data: args.data } as TilemapBrush;
        brushes.push(brush);

        const backupPath = await backupIfPresent(target.absolutePath);
        await writeBrushFile(target.absolutePath, brushes);

        const result: WriteResult = {
          success: true,
          entity: `${args.objectName}/${args.name}`,
          category: 'tilemapbrush',
          action: 'created',
          warnings: target.warnings.length > 0 ? target.warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_tilemap_brush] failed:', error);
        return toolError(`Error adding tilemap brush: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_tilemap_brush ─────────────────────────────────

  server.tool(
    'update_tilemap_brush',
    'Rename a tilemap brush, change its type, or replace its grid data. Changing the type requires data matching the new type.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
      name: z.string().max(200).describe('Current brush name'),
      newName: z.string().max(200).optional().describe('New brush name'),
      type: z.enum(['auto16', 'auto47', 'patch']).optional().describe('New brush type — requires data'),
      data: z.unknown().optional().describe('Replacement grid, validated against the brush\'s (new) type'),
    },
    async (args) => {
      try {
        if (args.newName === undefined && args.type === undefined && args.data === undefined) {
          return toolError('No updates provided. Specify at least one of: newName, type, data.');
        }
        if (args.type !== undefined && args.data === undefined) {
          return toolError('Changing a brush\'s type requires new data: the grid size differs per type.');
        }
        if (args.newName !== undefined) validateName(args.newName);

        const target = await resolveTarget(args.objectName);
        if ('error' in target) return target.error;

        const { brushes, existed } = await readBrushFile(target.absolutePath);
        if (!existed) {
          return toolError(`"${args.objectName}" has no brush file (${target.relativePath}).`);
        }
        const index = brushes.findIndex(brush => brush.name === args.name);
        if (index === -1) {
          const names = brushes.map(brush => brush.name).join(', ');
          return toolError(`"${args.objectName}" has no brush named "${args.name}". Brushes: ${names || '(none)'}.`);
        }
        const brush = brushes[index];

        if (args.newName !== undefined && args.newName !== args.name
          && brushes.some(other => other.name === args.newName)) {
          return toolError(`"${args.objectName}" already has a brush named "${args.newName}".`);
        }

        const type = args.type ?? brush.type;
        if (args.data !== undefined) {
          const problem = validateBrushData(type, args.data);
          if (problem) return toolError(problem);
        }

        if (args.newName !== undefined) brush.name = args.newName;
        if (args.type !== undefined) brush.type = args.type;
        if (args.data !== undefined) brush.data = args.data as TilemapBrush['data'];

        const backupPath = await backupIfPresent(target.absolutePath);
        await writeBrushFile(target.absolutePath, brushes);

        const result: WriteResult = {
          success: true,
          entity: `${args.objectName}/${brush.name}`,
          category: 'tilemapbrush',
          action: 'updated',
          warnings: target.warnings.length > 0 ? target.warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_tilemap_brush] failed:', error);
        return toolError(`Error updating tilemap brush: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_tilemap_brush ─────────────────────────────────

  server.tool(
    'delete_tilemap_brush',
    'Delete a tilemap brush. The brush file is kept as an empty array when the last brush is removed, matching how Construct stores an empty brush set.',
    {
      objectName: z.string().max(200).describe('Tilemap object type name'),
      name: z.string().max(200).describe('Brush name to delete'),
    },
    async (args) => {
      try {
        const target = await resolveTarget(args.objectName);
        if ('error' in target) return target.error;

        const { brushes, existed } = await readBrushFile(target.absolutePath);
        if (!existed) {
          return toolError(`"${args.objectName}" has no brush file (${target.relativePath}).`);
        }
        const index = brushes.findIndex(brush => brush.name === args.name);
        if (index === -1) {
          const names = brushes.map(brush => brush.name).join(', ');
          return toolError(`"${args.objectName}" has no brush named "${args.name}". Brushes: ${names || '(none)'}.`);
        }
        brushes.splice(index, 1);

        const backupPath = await backupIfPresent(target.absolutePath);
        await writeBrushFile(target.absolutePath, brushes);

        const result: WriteResult = {
          success: true,
          entity: `${args.objectName}/${args.name}`,
          category: 'tilemapbrush',
          action: 'deleted',
          warnings: target.warnings.length > 0 ? target.warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_tilemap_brush] failed:', error);
        return toolError(`Error deleting tilemap brush: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

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
