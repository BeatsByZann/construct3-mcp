/**
 * Codec for a Tilemap instance's tile data.
 *
 * Construct 3 (r495.2) stores the painted tiles of a placed Tilemap in the
 * instance's `ownData.tilemapData`:
 *
 *   "tilemapData": { "width": 20, "height": 17, "max-width": 20, "max-height": 17,
 *                    "data": "37,13,5x0,39,...,2x1hv,..." }
 *
 * Sampled from the editor's own "Download a copy" output of the Crossing Frog
 * example, before and after erasing and painting known cells:
 *
 * - The string holds `width * height` cells in column-major order: all of
 *   column x = 0 from top to bottom, then column x = 1, and so on. The cell at
 *   (x, y) is entry `x * height + y`.
 * - A cell is the tileset index plus 1; `0` is an empty (erased) cell. The tile
 *   the Tilemap Bar labels 0 is written `1`.
 * - Flip flags follow the number in the fixed order `h` (horizontal),
 *   `v` (vertical), `d` (diagonal). The editor's rotations were written as
 *   90 degrees `vd`, 180 degrees `hv`, 270 degrees `hd`.
 * - `Nx<cell>` repeats a cell N times (N >= 2), flagged cells included:
 *   `5x0`, `2x25`, `2x1hv`.
 */

export interface TileCell {
  /** Tileset index as shown in the Tilemap Bar (0-based). */
  tile: number;
  flipX?: boolean;
  flipY?: boolean;
  flipDiagonal?: boolean;
}

/** A decoded cell: `null` when empty, a bare index when unflipped, otherwise a TileCell. */
export type TileValue = null | number | TileCell;

export interface TilemapDataBlock {
  width: number;
  height: number;
  'max-width'?: number;
  'max-height'?: number;
  data: string;
  [key: string]: unknown;
}

/** Upper bound on cells decoded or encoded in one call, to keep a bad string from exhausting memory. */
export const MAX_TILEMAP_CELLS = 4_000_000;

const TOKEN = /^(?:(\d+)x)?(\d+)(h?)(v?)(d?)$/;

/** Decode one cell token (without a run prefix) to a TileValue. */
function tokenToValue(value: number, h: string, v: string, d: string, token: string): TileValue {
  if (value === 0) {
    if (h || v || d) throw new Error(`Tile data token "${token}" flags an empty cell.`);
    return null;
  }
  const tile = value - 1;
  if (!h && !v && !d) return tile;
  const cell: TileCell = { tile };
  if (h) cell.flipX = true;
  if (v) cell.flipY = true;
  if (d) cell.flipDiagonal = true;
  return cell;
}

/**
 * Decode `tilemapData.data` into a flat, column-major array of
 * `width * height` cells. Throws on a malformed token or a cell count that
 * does not match the declared size.
 */
export function decodeTileData(data: string, width: number, height: number): TileValue[] {
  if (!Number.isInteger(width) || width < 0 || !Number.isInteger(height) || height < 0) {
    throw new Error(`Tile data has an invalid size ${width}x${height}.`);
  }
  const expected = width * height;
  if (expected > MAX_TILEMAP_CELLS) {
    throw new Error(`Tile data of ${width}x${height} exceeds the ${MAX_TILEMAP_CELLS}-cell limit.`);
  }
  const out: TileValue[] = [];
  if (data === '') {
    if (expected !== 0) throw new Error(`Tile data is empty but the tilemap is ${width}x${height}.`);
    return out;
  }
  for (const token of data.split(',')) {
    const m = TOKEN.exec(token);
    if (!m) throw new Error(`Tile data has a malformed token "${token}".`);
    const count = m[1] === undefined ? 1 : Number(m[1]);
    if (count < 1) throw new Error(`Tile data token "${token}" repeats a cell ${count} times.`);
    if (out.length + count > expected) {
      throw new Error(`Tile data holds more than the ${expected} cells of a ${width}x${height} tilemap.`);
    }
    const value = tokenToValue(Number(m[2]), m[3], m[4], m[5], token);
    for (let i = 0; i < count; i++) out.push(value);
  }
  if (out.length !== expected) {
    throw new Error(`Tile data holds ${out.length} cells, but a ${width}x${height} tilemap needs ${expected}.`);
  }
  return out;
}

/** Validate a caller-supplied cell. Returns an error message, or null when valid. */
export function validateTileValue(value: unknown, where: string): string | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0
      ? null
      : `${where}: a tile index must be a non-negative integer, got ${value}.`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const cell = value as Record<string, unknown>;
    if (!Number.isInteger(cell.tile) || (cell.tile as number) < 0) {
      return `${where}.tile: must be a non-negative integer, got ${JSON.stringify(cell.tile)}.`;
    }
    for (const key of Object.keys(cell)) {
      if (key === 'tile') continue;
      if (key !== 'flipX' && key !== 'flipY' && key !== 'flipDiagonal') {
        return `${where}: unknown key "${key}"; use tile, flipX, flipY and flipDiagonal.`;
      }
      if (typeof cell[key] !== 'boolean') {
        return `${where}.${key}: must be true or false, got ${JSON.stringify(cell[key])}.`;
      }
    }
    return null;
  }
  return `${where}: expected null (empty), a tile index, or { tile, flipX, flipY, flipDiagonal }, got ${JSON.stringify(value)}.`;
}

/** Normalize a valid cell: drop false flags and collapse an unflipped cell to its index. */
export function normalizeTileValue(value: TileValue): TileValue {
  if (value === null || typeof value === 'number') return value;
  if (!value.flipX && !value.flipY && !value.flipDiagonal) return value.tile;
  const cell: TileCell = { tile: value.tile };
  if (value.flipX) cell.flipX = true;
  if (value.flipY) cell.flipY = true;
  if (value.flipDiagonal) cell.flipDiagonal = true;
  return cell;
}

function valueToToken(value: TileValue): string {
  if (value === null) return '0';
  if (typeof value === 'number') return String(value + 1);
  return `${value.tile + 1}${value.flipX ? 'h' : ''}${value.flipY ? 'v' : ''}${value.flipDiagonal ? 'd' : ''}`;
}

/** Encode a flat, column-major cell array the way Construct writes it. */
export function encodeTileData(cells: readonly TileValue[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < cells.length) {
    const token = valueToToken(cells[i]);
    let run = 1;
    while (i + run < cells.length && valueToToken(cells[i + run]) === token) run++;
    parts.push(run > 1 ? `${run}x${token}` : token);
    i += run;
  }
  return parts.join(',');
}

/** Column-major flat array to rows[y][x]. */
export function cellsToRows(cells: readonly TileValue[], width: number, height: number): TileValue[][] {
  const rows: TileValue[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileValue[] = [];
    for (let x = 0; x < width; x++) row.push(cells[x * height + y]);
    rows.push(row);
  }
  return rows;
}

/** rows[y][x] to a column-major flat array. The rows must be rectangular. */
export function rowsToCells(rows: readonly (readonly TileValue[])[]): TileValue[] {
  const height = rows.length;
  const width = height > 0 ? rows[0].length : 0;
  const cells: TileValue[] = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) cells.push(rows[y][x]);
  }
  return cells;
}

/** Highest tile index a cell array uses, or -1 when every cell is empty. */
export function maxTileIndex(cells: readonly TileValue[]): number {
  let max = -1;
  for (const cell of cells) {
    const tile = cell === null ? -1 : typeof cell === 'number' ? cell : cell.tile;
    if (tile > max) max = tile;
  }
  return max;
}
