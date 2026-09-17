/**
 * Tilemap tile-data tools: get_tilemap_data, set_tilemap_tiles,
 * set_tilemap_data.
 *
 * They read and write a placed Tilemap instance's `ownData.tilemapData`; the
 * string format is documented in `../construct3/tilemap-data.ts`. Cells are
 * exchanged as rows[y][x] of `null` (empty), a tile index, or
 * `{ tile, flipX, flipY, flipDiagonal }`, with tile indices as the Tilemap Bar
 * shows them.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Instance, Layout, WriteResult } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { collectInstances } from '../construct3/layout-walk.js';
import {
  decodeTileData,
  encodeTileData,
  cellsToRows,
  rowsToCells,
  maxTileIndex,
  validateTileValue,
  normalizeTileValue,
  type TileValue,
  type TilemapDataBlock,
} from '../construct3/tilemap-data.js';

/** Cells returned by get_tilemap_data without a region. */
const MAX_READ_CELLS = 10_000;
/** Cells accepted by one write call. */
const MAX_WRITE_CELLS = 250_000;
/** Construct's default tile size for a new Tilemap. */
const DEFAULT_TILE_SIZE = 32;
/** Tile properties Construct copies from `properties` into `ownData`. */
const OWN_DATA_TILE_KEYS = ['tile-width', 'tile-height', 'tile-x-offset', 'tile-y-offset', 'tile-x-spacing', 'tile-y-spacing'];

const cellSchema = z.union([
  z.null(),
  z.number().int().min(0),
  z.object({
    tile: z.number().int().min(0),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    flipDiagonal: z.boolean().optional(),
  }).strict(),
]).describe('null for an empty cell, a tile index, or { tile, flipX, flipY, flipDiagonal }. Editor rotations: 90 = flipY+flipDiagonal, 180 = flipX+flipY, 270 = flipX+flipDiagonal');

interface TilemapTarget {
  layout: Layout;
  inst: Instance;
  tileWidth: number;
  tileHeight: number;
  /** Number of tiles in the tileset image, when it can be computed. */
  tileCount?: number;
  warnings: string[];
}

function numberProp(inst: Instance, key: string, fallback: number): number {
  const own = inst.ownData as Record<string, unknown> | undefined;
  const value = inst.properties?.[key] ?? own?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBlock(inst: Instance): TilemapDataBlock | undefined {
  const own = inst.ownData as Record<string, unknown> | undefined;
  const block = own?.tilemapData as TilemapDataBlock | undefined;
  return block && typeof block === 'object' ? block : undefined;
}

export function registerTilemapDataTools({ server, reader, writer }: MutationToolDeps) {
  async function resolveTilemap(layoutName: string, uid: number): Promise<{ error: ReturnType<typeof toolError> } | TilemapTarget> {
    let layout: Layout;
    try {
      layout = await reader.readLayout(layoutName);
    } catch {
      return { error: notFoundError('Layout', layoutName, reader.findNearestName(layoutName, 'layouts'), 'list_layouts') };
    }
    const inst = collectInstances(layout).find(i => i.uid === uid);
    if (!inst) {
      return { error: toolError(`Instance with UID ${uid} not found in layout "${layoutName}". Use get_layout_details to see all instance UIDs.`) };
    }

    const warnings: string[] = [];
    let tileCount: number | undefined;
    let pluginId: unknown;
    let image: { width?: unknown; height?: unknown } | undefined;
    try {
      const objectType = await reader.readObjectType(inst.type);
      pluginId = objectType['plugin-id'];
      image = objectType.image as typeof image;
    } catch (e) {
      warnings.push(`Could not read object type "${inst.type}": ${e instanceof Error ? e.message : String(e)}`);
    }
    if (pluginId !== undefined && pluginId !== 'Tilemap') {
      return { error: toolError(`Instance ${uid} is a "${inst.type}" (plugin "${String(pluginId)}"), not a Tilemap.`) };
    }

    const tileWidth = numberProp(inst, 'tile-width', DEFAULT_TILE_SIZE);
    const tileHeight = numberProp(inst, 'tile-height', DEFAULT_TILE_SIZE);
    if (!(tileWidth > 0) || !(tileHeight > 0)) {
      return { error: toolError(`Instance ${uid} has an invalid tile size ${tileWidth}x${tileHeight}.`) };
    }
    if (image && typeof image.width === 'number' && typeof image.height === 'number') {
      const offX = numberProp(inst, 'tile-x-offset', 0);
      const offY = numberProp(inst, 'tile-y-offset', 0);
      const spX = numberProp(inst, 'tile-x-spacing', 0);
      const spY = numberProp(inst, 'tile-y-spacing', 0);
      const columns = Math.floor((image.width - offX + spX) / (tileWidth + spX));
      const rows = Math.floor((image.height - offY + spY) / (tileHeight + spY));
      if (columns > 0 && rows > 0) tileCount = columns * rows;
    }
    return { layout, inst, tileWidth, tileHeight, tileCount, warnings };
  }

  /** Decode the instance's cells, or an empty grid sized from the instance when it has none. */
  function currentCells(target: TilemapTarget): { cells: TileValue[]; width: number; height: number; hadData: boolean } {
    const block = readBlock(target.inst);
    if (block) {
      return { cells: decodeTileData(String(block.data ?? ''), block.width, block.height), width: block.width, height: block.height, hadData: true };
    }
    const width = Math.max(0, Math.ceil((target.inst.world?.width ?? 0) / target.tileWidth));
    const height = Math.max(0, Math.ceil((target.inst.world?.height ?? 0) / target.tileHeight));
    return { cells: new Array<TileValue>(width * height).fill(null), width, height, hadData: false };
  }

  function tileRangeWarning(target: TilemapTarget, cells: readonly TileValue[]): void {
    if (target.tileCount === undefined) return;
    const max = maxTileIndex(cells);
    if (max >= target.tileCount) {
      target.warnings.push(
        `Tile index ${max} is outside the tileset, which holds ${target.tileCount} tile(s) (indices 0 to ${target.tileCount - 1}); Construct draws such cells empty.`
      );
    }
  }

  /** Store cells on the instance and write the layout. */
  async function store(target: TilemapTarget, layoutName: string, cells: TileValue[], width: number, height: number, resizeInstance: boolean): Promise<string> {
    const inst = target.inst;
    const own = (inst.ownData && typeof inst.ownData === 'object' ? inst.ownData : {}) as Record<string, unknown>;
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
    const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
    return writer.writeEntityFile('layouts', layoutName, target.layout, subfolder);
  }

  // ─── get_tilemap_data ─────────────────────────────────────

  server.tool(
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
        if ('error' in target) return target.error;
        const { cells, width, height, hadData } = currentCells(target);

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
        return toolError(`Error reading tilemap data: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── set_tilemap_tiles ────────────────────────────────────

  server.tool(
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
      try {
        if (!args.tiles?.length && !args.fill) {
          return toolError('No cells provided. Specify tiles, fill, or both.');
        }
        if (args.fill && args.fill.width * args.fill.height > MAX_WRITE_CELLS) {
          return toolError(`The fill covers ${args.fill.width * args.fill.height} cells; the limit is ${MAX_WRITE_CELLS}.`);
        }
        const target = await resolveTilemap(args.layoutName, args.uid);
        if ('error' in target) return target.error;
        const { cells, width, height, hadData } = currentCells(target);
        if (width === 0 || height === 0) {
          return toolError(`Instance ${args.uid} has no cells (size ${width}x${height}); use set_tilemap_data to give it a grid.`);
        }

        const written: TileValue[] = [];
        if (args.fill) {
          const f = args.fill;
          if (f.x + f.width > width || f.y + f.height > height) {
            return toolError(`The fill ${f.x},${f.y} ${f.width}x${f.height} extends past the ${width}x${height} tilemap.`);
          }
          const value = normalizeTileValue(f.value as TileValue);
          for (let x = f.x; x < f.x + f.width; x++) {
            for (let y = f.y; y < f.y + f.height; y++) cells[x * height + y] = value;
          }
          written.push(value);
        }
        for (const [i, t] of (args.tiles ?? []).entries()) {
          if (t.x >= width || t.y >= height) {
            return toolError(`tiles[${i}]: cell ${t.x},${t.y} is outside the ${width}x${height} tilemap.`);
          }
          const value = normalizeTileValue(t.value as TileValue);
          cells[t.x * height + t.y] = value;
          written.push(value);
        }
        tileRangeWarning(target, written);
        if (!hadData) target.warnings.push(`The instance had no tile data; a ${width}x${height} grid sized from the instance was created.`);

        const backupPath = await store(target, args.layoutName, cells, width, height, false);
        const result: WriteResult = {
          success: true,
          entity: `${args.layoutName}/${args.uid}`,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: target.warnings.length > 0 ? target.warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[set_tilemap_tiles] failed:', error);
        return toolError(`Error setting tilemap tiles: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── set_tilemap_data ─────────────────────────────────────

  server.tool(
    'set_tilemap_data',
    'Replace all tile data of a placed Tilemap instance with rows[y][x]. The grid size becomes the rows\' size and, by default, the instance is resized to match.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the Tilemap instance'),
      rows: z.array(z.array(z.unknown())).min(1).describe('rows[y][x] of null, a tile index, or { tile, flipX, flipY, flipDiagonal }; every row the same length'),
      resizeInstance: z.boolean().optional().describe('Set the instance size to columns x tile width and rows x tile height (default true)'),
    },
    async (args) => {
      try {
        const height = args.rows.length;
        const width = args.rows[0].length;
        if (width === 0) return toolError('rows[0] is empty; a tilemap needs at least one column.');
        if (width * height > MAX_WRITE_CELLS) {
          return toolError(`The grid holds ${width * height} cells; the limit is ${MAX_WRITE_CELLS}.`);
        }
        for (let y = 0; y < height; y++) {
          if (args.rows[y].length !== width) {
            return toolError(`rows[${y}] has ${args.rows[y].length} cell(s); every row needs ${width}.`);
          }
          for (let x = 0; x < width; x++) {
            const problem = validateTileValue(args.rows[y][x], `rows[${y}][${x}]`);
            if (problem) return toolError(problem);
          }
        }

        const target = await resolveTilemap(args.layoutName, args.uid);
        if ('error' in target) return target.error;

        const cells = rowsToCells(args.rows as TileValue[][]).map(normalizeTileValue);
        tileRangeWarning(target, cells);
        const resize = args.resizeInstance ?? true;
        if (!resize && target.inst.world) {
          const w = Math.ceil(target.inst.world.width / target.tileWidth);
          const h = Math.ceil(target.inst.world.height / target.tileHeight);
          if (w !== width || h !== height) {
            target.warnings.push(`The instance covers ${w}x${h} cells but the grid is ${width}x${height}; Construct may resize one to the other when the layout opens.`);
          }
        }

        const backupPath = await store(target, args.layoutName, cells, width, height, resize);
        const result: WriteResult = {
          success: true,
          entity: `${args.layoutName}/${args.uid}`,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: target.warnings.length > 0 ? target.warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[set_tilemap_data] failed:', error);
        return toolError(`Error setting tilemap data: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
