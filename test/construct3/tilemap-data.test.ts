/**
 * Codec tests against tile data saved by the Construct 3 r495.2 editor
 * (test/fixtures/tilemap-sample/ground-r495.json). The edits recorded in that
 * fixture pin the column-major order, the +1 offset, the flag letters and the
 * run syntax.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  decodeTileData,
  encodeTileData,
  cellsToRows,
  rowsToCells,
  maxTileIndex,
  validateTileValue,
  normalizeTileValue,
} from '../../src/construct3/tilemap-data.js';

const sample = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'tilemap-sample', 'ground-r495.json'), 'utf-8'));
const { width, height } = sample.instance.ownData.tilemapData;
const at = (cells: unknown[], x: number, y: number) => cells[x * height + y];

describe('decodeTileData on editor samples', () => {
  it('decodes the shipped 20x17 map, whose road band is five empty rows in every column', () => {
    const cells = decodeTileData(sample.data.base, width, height);
    expect(cells).toHaveLength(340);
    const rows = cellsToRows(cells, width, height);
    for (let x = 0; x < width; x++) {
      for (let y = 2; y <= 6; y++) expect(rows[y][x]).toBeNull();
    }
    // First token "37" is column 0, row 0: tile index 36.
    expect(rows[0][0]).toBe(36);
    expect(maxTileIndex(cells)).toBe(40);
  });

  it('places the erased and painted cells at the (x, y) the editor reported', () => {
    const base = decodeTileData(sample.data.base, width, height);
    const edited = decodeTileData(sample.data.edited, width, height);
    for (const { x, y } of sample.edits.erased) {
      expect(at(base, x, y)).not.toBeNull();
      expect(at(edited, x, y)).toBeNull();
    }
    expect(at(edited, 4, 7)).toEqual({ tile: 0, flipX: true });
    expect(at(edited, 5, 7)).toEqual({ tile: 0, flipY: true });
    expect(at(edited, 6, 7)).toEqual({ tile: 0, flipY: true, flipDiagonal: true });
    expect(at(edited, 7, 7)).toEqual({ tile: 0, flipX: true, flipDiagonal: true });

    const changed = base.map((c, i) => JSON.stringify(c) !== JSON.stringify(edited[i]) ? i : -1).filter(i => i >= 0);
    expect(changed).toHaveLength(7);
  });

  it('reads a run of flagged cells (2x1hv) down one column', () => {
    const cells = decodeTileData(sample.data.rotated180, width, height);
    expect(sample.data.rotated180).toContain('2x1hv');
    for (const { x, y } of sample.edits.rotated180) {
      expect(at(cells, x, y)).toEqual({ tile: 0, flipX: true, flipY: true });
    }
  });

  it('re-encodes all three samples byte for byte', () => {
    for (const data of Object.values(sample.data) as string[]) {
      expect(encodeTileData(decodeTileData(data, width, height))).toBe(data);
    }
  });
});

describe('decodeTileData errors', () => {
  it('rejects a cell count that does not match the size', () => {
    expect(() => decodeTileData('1,2,3', 2, 2)).toThrow(/3 cells/);
    expect(() => decodeTileData('5x1', 2, 2)).toThrow(/more than the 4 cells/);
  });

  it('rejects malformed tokens, flags out of order, and a flagged empty cell', () => {
    expect(() => decodeTileData('1,x,1,1', 2, 2)).toThrow(/malformed token "x"/);
    expect(() => decodeTileData('1vh,1,1,1', 2, 2)).toThrow(/malformed token "1vh"/);
    expect(() => decodeTileData('-1,1,1,1', 2, 2)).toThrow(/malformed/);
    expect(() => decodeTileData('0h,1,1,1', 2, 2)).toThrow(/flags an empty cell/);
    expect(() => decodeTileData('0x1,1,1,1', 2, 2)).toThrow(/repeats a cell 0 times/);
  });

  it('accepts an empty string only for a zero-size map', () => {
    expect(decodeTileData('', 0, 0)).toEqual([]);
    expect(() => decodeTileData('', 1, 1)).toThrow(/empty/);
  });
});

describe('encodeTileData', () => {
  it('writes index + 1, 0 for empty, flags in h-v-d order, and runs of two or more', () => {
    expect(encodeTileData([null, null, 0, { tile: 4, flipDiagonal: true, flipX: true }, 7, 7, 7])).toBe('2x0,1,5hd,3x8');
  });
});

describe('row helpers and validation', () => {
  it('converts rows[y][x] to column-major and back', () => {
    const rows = [[0, 1, 2], [3, null, 5]];
    const cells = rowsToCells(rows);
    expect(cells).toEqual([0, 3, 1, null, 2, 5]);
    expect(cellsToRows(cells, 3, 2)).toEqual(rows);
  });

  it('validates and normalizes cells', () => {
    expect(validateTileValue(null, 'c')).toBeNull();
    expect(validateTileValue(3, 'c')).toBeNull();
    expect(validateTileValue({ tile: 3, flipX: true }, 'c')).toBeNull();
    expect(validateTileValue(-1, 'c')).toMatch(/non-negative/);
    expect(validateTileValue(1.5, 'c')).toMatch(/non-negative/);
    expect(validateTileValue({ tile: 3, rotate: 90 }, 'c')).toMatch(/unknown key "rotate"/);
    expect(validateTileValue({ tile: 3, flipX: 1 }, 'c')).toMatch(/true or false/);
    expect(validateTileValue('3h', 'c')).toMatch(/expected null/);
    expect(normalizeTileValue({ tile: 2, flipX: false })).toBe(2);
    expect(normalizeTileValue({ tile: 2, flipX: false, flipY: true })).toEqual({ tile: 2, flipY: true });
  });
});
