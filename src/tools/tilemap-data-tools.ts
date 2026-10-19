/**
 * Tilemap tile-data tools: get_tilemap_data, set_tilemap_tiles,
 * set_tilemap_data.
 *
 * They read and write a placed Tilemap instance's `ownData.tilemapData`; the
 * string format is documented in `../construct3/tilemap-data.ts`. Cells are
 * exchanged as rows[y][x] of `null` (empty), a tile index, or
 * `{ tile, flipX, flipY, flipDiagonal }`, with tile indices as the Tilemap Bar
 * shows them.
 *
 * Every check runs before the layout is written, and a refusal of a write
 * tool says "Nothing was changed.". The layout is written once, through
 * writeEntityOrRollBack.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Instance, Layout, WriteResult } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { forEachLayoutInstance, findInstanceByUid } from '../construct3/layers.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { refusal, stoppedBeforeWrite, unregisteredName, messageWithoutPaths, causeWithoutPaths, syncedTools } from './tilemap-support.js';
import {
  decodeTileData,
  encodeTileData,
  cellsToRows,
  rowsToCells,
  maxTileIndex,
  validateTileValue,
  normalizeTileValue,
  MAX_TILEMAP_CELLS,
  type TileValue,
  type TilemapDataBlock,
} from '../construct3/tilemap-data.js';

/** Cells returned by get_tilemap_data without a region. */
const MAX_READ_CELLS = 10_000;
/** Cells accepted by one write call. */
const MAX_WRITE_CELLS = 250_000;
/** The tile size used when an instance sets none. */
const DEFAULT_TILE_SIZE = 32;
/** Tile properties also written into `ownData` when the instance's `properties` hold them. */
const OWN_DATA_TILE_KEYS = ['tile-width', 'tile-height', 'tile-x-offset', 'tile-y-offset', 'tile-x-spacing', 'tile-y-spacing'];
/** Largest tile index stored: index + 1 is still a safe integer, so its token is digits the decoder reads back. */
const MAX_TILE_INDEX = Number.MAX_SAFE_INTEGER - 1;

const cellSchema = z.union([
  z.null(),
  z.number().int().min(0).max(MAX_TILE_INDEX),
  z.object({
    tile: z.number().int().min(0).max(MAX_TILE_INDEX),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    flipDiagonal: z.boolean().optional(),
  }).strict(),
]).describe('null for an empty cell, a tile index, or { tile, flipX, flipY, flipDiagonal }. Rotations clockwise: 90 = flipX+flipDiagonal, 180 = flipX+flipY, 270 = flipY+flipDiagonal');

interface TilemapTarget {
  layout: Layout;
  inst: Instance;
  tileWidth: number;
  tileHeight: number;
  /** Number of tiles in the tileset image, when it can be computed. */
  tileCount?: number;
  warnings: string[];
}

/** Decoded cells and the grid they fill; `hadData` is false when the grid was derived from the instance. */
interface CurrentCells {
  cells: TileValue[];
  width: number;
  height: number;
  hadData: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberProp(inst: Instance, key: string, fallback: number): number {
  const own = isPlainObject(inst.ownData) ? inst.ownData : undefined;
  const value = inst.properties?.[key] ?? own?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBlock(inst: Instance): TilemapDataBlock | undefined {
  const own = isPlainObject(inst.ownData) ? inst.ownData : undefined;
  const block = own?.tilemapData;
  return isPlainObject(block) ? block as TilemapDataBlock : undefined;
}

/**
 * Why the instance's tile containers cannot hold tile data, or undefined.
 * `ownData` and `ownData.tilemapData` must each be an object, absent or null
 * (a bare instance); an array or a scalar there would drop the data when the
 * layout is serialized.
 */
function malformedTileContainer(inst: Instance): string | undefined {
  const own = inst.ownData;
  if (own !== undefined && own !== null && !isPlainObject(own)) {
    return 'ownData is not an object, so tile data cannot be stored in it.';
  }
  const block = isPlainObject(own) ? own.tilemapData : undefined;
  if (block !== undefined && block !== null && !isPlainObject(block)) {
    return 'ownData.tilemapData is not an object, so its tile data cannot be read or replaced.';
  }
  return undefined;
}

export function registerTilemapDataTools({ server: mcpServer, reader, writer }: MutationToolDeps) {
  const { readTool, writeTool } = syncedTools(mcpServer, reader);

  /** The instance to work on, or the message that says why there is none. */
  async function resolveTilemap(layoutName: string, uid: number): Promise<{ error: string } | TilemapTarget> {
    const registered = await reader.listLayouts();
    const unknown = unregisteredName('Layout', layoutName, registered, reader.findNearestName(layoutName, 'layouts'), 'list_layouts');
    if (unknown !== undefined) return { error: unknown };
    const layout = await reader.readLayout(layoutName);
    let count = 0;
    forEachLayoutInstance(layout, i => { if (i.uid === uid) count++; });
    if (count > 1) {
      return { error: `UID ${uid} is used by ${count} instances of layout "${layoutName}" (duplicate-uid in validate_project), so which one is meant cannot be told.` };
    }
    const found = findInstanceByUid(layout, uid);
    if (!found) return { error: `Instance with UID ${uid} not found in layout "${layoutName}". Use get_layout_details to see all instance UIDs.` };
    const inst = found.instance;
    const malformed = malformedTileContainer(inst);
    if (malformed !== undefined) return { error: `Instance ${uid} of layout "${layoutName}": ${malformed}` };

    let objectType;
    try {
      objectType = await reader.readObjectType(inst.type);
    } catch (e) {
      return { error: `Cannot read object type "${inst.type}": ${causeWithoutPaths(e, reader.getProjectDir())}.` };
    }
    const pluginId = objectType['plugin-id'];
    if (pluginId !== 'Tilemap') return { error: `Instance ${uid} is a "${inst.type}" (plugin "${String(pluginId)}"), not a Tilemap.` };

    const tileWidth = numberProp(inst, 'tile-width', DEFAULT_TILE_SIZE);
    const tileHeight = numberProp(inst, 'tile-height', DEFAULT_TILE_SIZE);
    if (!(tileWidth > 0) || !(tileHeight > 0)) {
      return { error: `Instance ${uid} has an invalid tile size ${tileWidth}x${tileHeight}.` };
    }
    let tileCount: number | undefined;
    const image = objectType.image as { width?: unknown; height?: unknown } | undefined;
    if (image && typeof image.width === 'number' && typeof image.height === 'number') {
      const offX = numberProp(inst, 'tile-x-offset', 0);
      const offY = numberProp(inst, 'tile-y-offset', 0);
      const spX = numberProp(inst, 'tile-x-spacing', 0);
      const spY = numberProp(inst, 'tile-y-spacing', 0);
      const columns = Math.floor((image.width - offX + spX) / (tileWidth + spX));
      const rows = Math.floor((image.height - offY + spY) / (tileHeight + spY));
      if (columns > 0 && rows > 0) tileCount = columns * rows;
    }
    return { layout, inst, tileWidth, tileHeight, tileCount, warnings: [] };
  }

  /** Decode the instance's cells, or an empty grid sized from the instance when it has none; an error message when neither is possible. */
  function currentCells(target: TilemapTarget): { error: string } | CurrentCells {
    const block = readBlock(target.inst);
    if (block) {
      try {
        return { cells: decodeTileData(String(block.data ?? ''), block.width, block.height), width: block.width, height: block.height, hadData: true };
      } catch (e) {
        return { error: `The stored tile data cannot be read: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const width = Math.max(0, Math.ceil((target.inst.world?.width ?? 0) / target.tileWidth));
    const height = Math.max(0, Math.ceil((target.inst.world?.height ?? 0) / target.tileHeight));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > MAX_TILEMAP_CELLS) {
      return { error: `The instance covers ${width}x${height} cells, over the ${MAX_TILEMAP_CELLS}-cell limit of a tilemap, so no grid is created from it; use set_tilemap_data with a smaller grid.` };
    }
    return { cells: new Array<TileValue>(width * height).fill(null), width, height, hadData: false };
  }

  function tileRangeWarning(target: TilemapTarget, cells: readonly TileValue[]): void {
    if (target.tileCount === undefined) return;
    const max = maxTileIndex(cells);
    if (max >= target.tileCount) {
      target.warnings.push(
        `Tile index ${max} is outside the tileset, which holds ${target.tileCount} tile(s) (indices 0 to ${target.tileCount - 1}).`
      );
    }
  }

  /** Store cells on the instance and write the layout once; returns the backup path. A failed write is rolled back and throws with the shared helper's message. */
  async function store(target: TilemapTarget, layoutName: string, cells: TileValue[], width: number, height: number, resizeInstance: boolean): Promise<string> {
    const inst = target.inst;
    const own = (isPlainObject(inst.ownData) ? inst.ownData : {}) as Record<string, unknown>;
    const previous = readBlock(inst);
    own.tilemapData = {
      ...(previous ?? {}),
      width,
      height,
      'max-width': width,
      'max-height': height,
      data: encodeTileData(cells),
    };
    for (const key of OWN_DATA_TILE_KEYS) {
      const value = inst.properties?.[key];
      if (value !== undefined && own[key] === undefined) own[key] = value;
    }
    inst.ownData = own;
    if (resizeInstance && inst.world) {
      inst.world.width = width * target.tileWidth;
      inst.world.height = height * target.tileHeight;
    }
    return writeEntityOrRollBack(writer, 'layouts', layoutName, target.layout);
  }

  /** The success result of a write tool. */
  function written(args: { layoutName: string; uid: number }, backupPath: string, target: TilemapTarget) {
    const result: WriteResult = {
      success: true,
      entity: `${args.layoutName}/${args.uid}`,
      category: 'layout',
      action: 'updated',
      backupFile: backupPath,
      warnings: target.warnings.length > 0 ? target.warnings : undefined,
    };
    return toolResult(result);
  }

  // ─── get_tilemap_data ─────────────────────────────────────

  readTool(
    'get_tilemap_data',
    'Read the painted tiles of a placed Tilemap instance as rows[y][x]: null (empty), a tile index, or { tile, flipX, flipY, flipDiagonal }. Large tilemaps need a region.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the Tilemap instance'),
      region: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }).optional().describe(`Cell rectangle to return; required when the tilemap has more than ${MAX_READ_CELLS} cells`),
    },
    async (args) => {
      try {
        const target = await resolveTilemap(args.layoutName, args.uid);
        if ('error' in target) return toolError(target.error);
        const current = currentCells(target);
        if ('error' in current) return toolError(current.error);
        const { cells, width, height, hadData } = current;

        const region = args.region ?? { x: 0, y: 0, width, height };
        if (!args.region && width * height > MAX_READ_CELLS) {
          return toolError(`The tilemap is ${width}x${height} (${width * height} cells); pass a region of at most ${MAX_READ_CELLS} cells.`);
        }
        if (region.width * region.height > MAX_READ_CELLS) {
          return toolError(`The region holds ${region.width * region.height} cells; the limit is ${MAX_READ_CELLS}.`);
        }
        if (region.x + region.width > width || region.y + region.height > height) {
          return toolError(`The region ${region.x},${region.y} ${region.width}x${region.height} extends past the ${width}x${height} tilemap.`);
        }

        const all = cellsToRows(cells, width, height);
        const rows = all.slice(region.y, region.y + region.height).map(row => row.slice(region.x, region.x + region.width));
        const emptyCells = cells.filter(cell => cell === null).length;
        if (!hadData) target.warnings.push('The instance has no tile data yet; an empty grid sized from the instance is shown.');

        return toolResult({
          layoutName: args.layoutName,
          uid: args.uid,
          objectType: target.inst.type,
          width,
          height,
          tileWidth: target.tileWidth,
          tileHeight: target.tileHeight,
          tilesetTileCount: target.tileCount,
          emptyCells,
          region,
          rows,
          warnings: target.warnings.length > 0 ? target.warnings : undefined,
        });
      } catch (error) {
        console.error('[get_tilemap_data] failed:', error);
        return toolError(`Error reading tilemap data: ${messageWithoutPaths(error, reader.getProjectDir())}`);
      }
    }
  );

  // ─── set_tilemap_tiles ────────────────────────────────────

  writeTool(
    'set_tilemap_tiles',
    'Paint or erase individual cells, or fill a rectangle, on a placed Tilemap instance. Other cells are kept. Use null to erase.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the Tilemap instance'),
      tiles: z.array(z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        value: cellSchema,
      })).max(MAX_WRITE_CELLS).optional().describe('Cells to set, applied in order'),
      fill: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
        value: cellSchema,
      }).optional().describe('Rectangle to fill before `tiles` is applied'),
    },
    async (args) => {
      let target: TilemapTarget;
      let cells: TileValue[];
      let width: number;
      let height: number;
      try {
        if (!args.tiles?.length && !args.fill) {
          return refusal('No cells provided. Specify tiles, fill, or both.');
        }
        if (args.fill && args.fill.width * args.fill.height > MAX_WRITE_CELLS) {
          return refusal(`The fill covers ${args.fill.width * args.fill.height} cells; the limit is ${MAX_WRITE_CELLS}.`);
        }
        const resolved = await resolveTilemap(args.layoutName, args.uid);
        if ('error' in resolved) return refusal(resolved.error);
        target = resolved;
        const current = currentCells(target);
        if ('error' in current) return refusal(current.error);
        ({ cells, width, height } = current);
        if (width === 0 || height === 0) {
          return refusal(`Instance ${args.uid} has no cells (size ${width}x${height}); use set_tilemap_data to give it a grid.`);
        }

        const placed: TileValue[] = [];
        if (args.fill) {
          const f = args.fill;
          if (f.x + f.width > width || f.y + f.height > height) {
            return refusal(`The fill ${f.x},${f.y} ${f.width}x${f.height} extends past the ${width}x${height} tilemap.`);
          }
          const value = normalizeTileValue(f.value as TileValue);
          for (let x = f.x; x < f.x + f.width; x++) {
            for (let y = f.y; y < f.y + f.height; y++) cells[x * height + y] = value;
          }
          placed.push(value);
        }
        for (const [i, t] of (args.tiles ?? []).entries()) {
          if (t.x >= width || t.y >= height) {
            return refusal(`tiles[${i}]: cell ${t.x},${t.y} is outside the ${width}x${height} tilemap.`);
          }
          const value = normalizeTileValue(t.value as TileValue);
          cells[t.x * height + t.y] = value;
          placed.push(value);
        }
        const highest = maxTileIndex(cells);
        if (highest > MAX_TILE_INDEX) return refusal(`Tile index ${highest} is too large (at most ${MAX_TILE_INDEX}).`);
        tileRangeWarning(target, placed);
        if (!current.hadData) target.warnings.push(`The instance had no tile data; a ${width}x${height} grid sized from the instance was created.`);
      } catch (error) {
        console.error('[set_tilemap_tiles] failed before the write:', error);
        return stoppedBeforeWrite(error, reader.getProjectDir());
      }

      let backupPath: string;
      try {
        backupPath = await store(target, args.layoutName, cells, width, height, false);
      } catch (error) {
        console.error('[set_tilemap_tiles] write failed:', error);
        return toolError(`Error setting tilemap tiles: ${messageWithoutPaths(error, reader.getProjectDir())}`);
      }
      return written(args, backupPath, target);
    }
  );

  // ─── set_tilemap_data ─────────────────────────────────────

  writeTool(
    'set_tilemap_data',
    'Replace all tile data of a placed Tilemap instance with rows[y][x]. The grid size becomes the rows\' size and, by default, the instance is resized to match.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the Tilemap instance'),
      rows: z.array(z.array(z.unknown()).max(MAX_WRITE_CELLS)).min(1).max(MAX_WRITE_CELLS)
        .describe('rows[y][x] of null, a tile index, or { tile, flipX, flipY, flipDiagonal }; every row the same length'),
      resizeInstance: z.boolean().optional().describe('Set the instance size to columns x tile width and rows x tile height (default true)'),
    },
    async (args) => {
      let target: TilemapTarget;
      let cells: TileValue[];
      let width: number;
      let height: number;
      let resize: boolean;
      try {
        height = args.rows.length;
        width = args.rows[0].length;
        if (width === 0) return refusal('rows[0] is empty; a tilemap needs at least one column.');
        if (width * height > MAX_WRITE_CELLS) {
          return refusal(`The grid holds ${width * height} cells; the limit is ${MAX_WRITE_CELLS}.`);
        }
        for (let y = 0; y < height; y++) {
          if (args.rows[y].length !== width) {
            return refusal(`rows[${y}] has ${args.rows[y].length} cell(s); every row needs ${width}.`);
          }
          for (let x = 0; x < width; x++) {
            const problem = validateTileValue(args.rows[y][x], `rows[${y}][${x}]`);
            if (problem) return refusal(problem);
          }
        }
        cells = rowsToCells(args.rows as TileValue[][]).map(normalizeTileValue);
        const highest = maxTileIndex(cells);
        if (highest > MAX_TILE_INDEX) return refusal(`Tile index ${highest} is too large (at most ${MAX_TILE_INDEX}).`);

        const resolved = await resolveTilemap(args.layoutName, args.uid);
        if ('error' in resolved) return refusal(resolved.error);
        target = resolved;

        tileRangeWarning(target, cells);
        resize = args.resizeInstance ?? true;
        if (!resize && target.inst.world) {
          const w = Math.ceil(target.inst.world.width / target.tileWidth);
          const h = Math.ceil(target.inst.world.height / target.tileHeight);
          if (w !== width || h !== height) {
            target.warnings.push(`The instance covers ${w}x${h} cells but the grid is ${width}x${height}.`);
          }
        }
      } catch (error) {
        console.error('[set_tilemap_data] failed before the write:', error);
        return stoppedBeforeWrite(error, reader.getProjectDir());
      }

      let backupPath: string;
      try {
        backupPath = await store(target, args.layoutName, cells, width, height, resize);
      } catch (error) {
        console.error('[set_tilemap_data] write failed:', error);
        return toolError(`Error setting tilemap data: ${messageWithoutPaths(error, reader.getProjectDir())}`);
      }
      return written(args, backupPath, target);
    }
  );
}
