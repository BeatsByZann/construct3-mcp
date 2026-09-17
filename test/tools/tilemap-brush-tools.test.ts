/**
 * Unit tests for tilemap brush grid validation.
 *
 * The grid dimensions are the guard that keeps an unusable brush out of a
 * project file, so every dimension and cell rule has its own case.
 */

import { describe, it, expect } from 'vitest';
import { validateBrushData, brushFileRelativePath } from '../../src/tools/tilemap-brush-tools.js';

const auto16 = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [8, 9, 10, 11],
  [12, 13, 14, null],
];

const auto47 = [
  [73, 39, 72, 43, 37, 70, 40, 38],
  [71, 41, 42, 5, 51, 62, 50, 61],
  [21, 48, 59, 18, 49, 60, 19, 20],
  [75, 10, 32, 15, 8, 30, 65, 54],
  [4, 7, 29, 17, 9, 31, 52, 63],
  [6, 27, 53, 26, 28, 64, 16, null],
];

describe('validateBrushData', () => {
  it('accepts the sample grids', () => {
    expect(validateBrushData('auto16', auto16)).toBeNull();
    expect(validateBrushData('auto47', auto47)).toBeNull();
    expect(validateBrushData('patch', {
      width: 3,
      height: 3,
      data: [
        [4, 5, 6],
        [15, [{ index: 44, probability: 1 }, { index: 45, probability: 1 }], 17],
        [26, 27, 28],
      ],
    })).toBeNull();
  });

  /**
   * Revert check (e): removing the dimension checks makes every case here
   * pass silently.
   */
  it('rejects the wrong number of rows or columns', () => {
    expect(validateBrushData('auto16', auto16.slice(0, 3))).toContain('exactly 4 row(s), got 3');
    expect(validateBrushData('auto16', [...auto16, [1, 2, 3, 4]])).toContain('exactly 4 row(s), got 5');
    expect(validateBrushData('auto16', [[0, 1, 2], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]]))
      .toContain('exactly 4 cell(s) per row, got 3');

    // An auto47 grid is 6 rows of 8 — an auto16 grid must not pass as one.
    expect(validateBrushData('auto47', auto16)).toContain('exactly 6 row(s), got 4');
    expect(validateBrushData('auto47', auto47.map(row => row.slice(0, 7)))).toContain('exactly 8 cell(s) per row, got 7');

    expect(validateBrushData('patch', { width: 3, height: 2, data: [[1, 2, 3]] }))
      .toContain('needs 2 row(s) in data.data, got 1');
    expect(validateBrushData('patch', { width: 3, height: 1, data: [[1, 2]] }))
      .toContain('needs 3 cell(s) per row, got 2');
  });

  it('rejects a non-grid payload', () => {
    expect(validateBrushData('auto16', 'nope')).toContain('4x4 array of rows');
    expect(validateBrushData('auto16', [0, 1, 2, 3])).toContain('expected an array of 4 cell(s)');
    expect(validateBrushData('patch', [[1]])).toContain('{ width, height, data: [[...]] }');
    expect(validateBrushData('patch', { width: 0, height: 1, data: [[]] })).toContain('integer width of at least 1');
    expect(validateBrushData('patch', { width: 1, height: 1.5, data: [[1]] })).toContain('integer height of at least 1');
    expect(validateBrushData('patch', { width: 1, height: 1 })).toContain('data.data as an array of rows');
    expect(validateBrushData('patch', { width: 1000, height: 1, data: [[1]] })).toContain('at most 256 tiles on a side');
  });

  it('rejects a bad cell', () => {
    const withCell = (cell: unknown) => validateBrushData('auto16', [
      [cell, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
    ]);
    expect(withCell(-1)).toContain('non-negative integer');
    expect(withCell(1.5)).toContain('non-negative integer');
    expect(withCell('3')).toContain('expected a tile index, null, or a list');
    expect(withCell([])).toContain('list is empty');
    expect(withCell([{ index: 1 }])).toContain('probability: must be a number greater than 0');
    expect(withCell([{ index: -2, probability: 1 }])).toContain('index: must be a non-negative integer');
    expect(withCell([{ index: 1, probability: 0 }])).toContain('greater than 0');
    expect(withCell([5])).toContain('expected { index, probability }');
    expect(withCell(null)).toBeNull();
  });
});

describe('brushFileRelativePath', () => {
  it('mirrors the object type\'s subfolder', () => {
    expect(brushFileRelativePath('Tilemap', 'Overhead Game'))
      .toBe('tilemapBrushes/objectTypes/Overhead Game/Tilemap.brush.json');
    expect(brushFileRelativePath('Tiles')).toBe('tilemapBrushes/objectTypes/Tiles.brush.json');
  });
});
