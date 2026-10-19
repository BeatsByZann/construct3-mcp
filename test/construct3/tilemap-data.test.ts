/**
 * Codec tests against tile data from Construct 3 r506-2
 * (test/fixtures/tilemap-sample/tiles-r506.json): one string the codec wrote,
 * one the editor wrote after painting known cells. They pin the column-major
 * order, the +1 offset, the flag letters and the editor's rotation flags.
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
  type TileValue,
} from '../../src/construct3/tilemap-data.js';

interface Sample {
  strings: Record<string, string>;
  sizes: Record<string, [number, number]>;
  cells: Record<string, TileValue[][]>;
  bytesMatch: Record<string, boolean>;
}

const sample: Sample = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tilemap-sample', 'tiles-r506.json'), 'utf-8'),
);

describe('decodeTileData on editor samples', () => {
  for (const [entry, data] of Object.entries(sample.strings)) {
    const [width, height] = sample.sizes[entry];

    it(`decodes the ${entry} string to the cells the editor showed`, () => {
      expect(cellsToRows(decodeTileData(data, width, height), width, height)).toEqual(sample.cells[entry]);
    });

    if (sample.bytesMatch[entry]) {
      it(`re-encodes the ${entry} string byte for byte`, () => {
        expect(encodeTileData(decodeTileData(data, width, height))).toBe(data);
      });
    } else {
      it(`re-encodes the editor's ${entry} string to the same cells`, () => {
        const cells = decodeTileData(data, width, height);
        expect(decodeTileData(encodeTileData(cells), width, height)).toEqual(cells);
      });
    }
  }

  it('reads the editor\'s rotations as flipX+flipDiagonal (90), flipX+flipY (180) and flipY+flipDiagonal (270)', () => {
    const [width, height] = sample.sizes.editor;
    const rows = cellsToRows(decodeTileData(sample.strings.editor, width, height), width, height);
    expect(rows[0][1]).toEqual({ tile: 0, flipX: true });
    expect(rows[0][2]).toEqual({ tile: 0, flipX: true, flipDiagonal: true });
    expect(rows[0][3]).toEqual({ tile: 0, flipX: true, flipY: true });
    expect(rows[1][0]).toEqual({ tile: 0, flipY: true, flipDiagonal: true });
  });

  it('reads the largest tile index of the tool string', () => {
    const [width, height] = sample.sizes.tool;
    expect(maxTileIndex(decodeTileData(sample.strings.tool, width, height))).toBe(3);
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

  it('refuses a size that is negative or not a whole number', () => {
    expect(() => decodeTileData('', -1, 2)).toThrow(/invalid size -1x2/);
    expect(() => decodeTileData('1', 1, 1.5)).toThrow(/invalid size 1x1.5/);
  });

  it('refuses a map over the cell limit', () => {
    expect(() => decodeTileData('', 2001, 2001)).toThrow(/exceeds the 4000000-cell limit/);
  });

  it('a run that would pass the declared size is refused before it is expanded', () => {
    expect(() => decodeTileData('999999x1', 2, 2)).toThrow(/more than the 4 cells/);
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
