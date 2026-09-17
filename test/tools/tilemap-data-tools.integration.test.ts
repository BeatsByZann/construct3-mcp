/**
 * Real-reader/writer tests for the tilemap tile-data tools. Each test copies
 * `test/fixtures/rename-project` (Tilemap object type `Tiles`, 64x64 tileset)
 * and adds two instances to "Level 1": the r495.2 editor sample instance with
 * its tile data (UID 900, 16px tiles, so 16 tileset tiles) and a Tiles
 * instance placed without tile data (UID 901, 64x32 at 16px tiles).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTilemapDataTools } from '../../src/tools/tilemap-data-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');
const sample = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'tilemap-sample', 'ground-r495.json'), 'utf-8'));

let tmpDir: string;
let server: MockServer;

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function layoutInstance(uid: number): Promise<any> {
  const layout = JSON.parse(await readFile(join(tmpDir, 'layouts', 'Level 1.json'), 'utf-8'));
  return layout.layers[0].instances.find((i: any) => i.uid === uid);
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-tiledata-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });

  const layoutPath = join(tmpDir, 'layouts', 'Level 1.json');
  const layout = JSON.parse(await readFile(layoutPath, 'utf-8'));
  const painted = { ...structuredClone(sample.instance), type: 'Tiles', uid: 900, sid: 690000000000900 };
  const bare = {
    type: 'Tiles', uid: 901, sid: 690000000000901, tags: '',
    properties: { 'initially-visible': true, 'tile-width': 16, 'tile-height': 16 },
    instanceVariables: {}, behaviors: {}, showing: true, locked: false,
    world: { x: 0, y: 0, width: 64, height: 32, originX: 0, originY: 0, color: [1, 1, 1, 1], z: 0 },
  };
  layout.layers[0].instances.push(painted, bare);
  await writeFile(layoutPath, JSON.stringify(layout, null, '\t'));

  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerTilemapDataTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('get_tilemap_data', () => {
  it('returns rows[y][x] for the editor sample', async () => {
    const data = parseResult(await server.callTool('get_tilemap_data', { layoutName: 'Level 1', uid: 900 }));
    expect(data.width).toBe(20);
    expect(data.height).toBe(17);
    expect(data.tileWidth).toBe(16);
    expect(data.tilesetTileCount).toBe(16);
    expect(data.rows).toHaveLength(17);
    expect(data.rows[0]).toHaveLength(20);
    expect(data.rows[0][0]).toBe(36);
    expect(data.rows[2].every((cell: unknown) => cell === null)).toBe(true);
    expect(data.emptyCells).toBe(100);
  });

  it('returns only the requested region', async () => {
    const data = parseResult(await server.callTool('get_tilemap_data', {
      layoutName: 'Level 1', uid: 900, region: { x: 0, y: 0, width: 2, height: 3 },
    }));
    expect(data.rows).toEqual([[36, 36], [12, 12], [null, null]]);
  });

  it('rejects a region past the edge', async () => {
    const result = await server.callTool('get_tilemap_data', {
      layoutName: 'Level 1', uid: 900, region: { x: 19, y: 0, width: 2, height: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('extends past the 20x17 tilemap');
  });

  it('shows an empty grid sized from the instance when there is no tile data', async () => {
    const data = parseResult(await server.callTool('get_tilemap_data', { layoutName: 'Level 1', uid: 901 }));
    expect(data.width).toBe(4);
    expect(data.height).toBe(2);
    expect(data.rows).toEqual([[null, null, null, null], [null, null, null, null]]);
    expect(data.warnings.join(' ')).toContain('no tile data yet');
  });

  it('refuses an instance that is not a Tilemap', async () => {
    const result = await server.callTool('get_tilemap_data', { layoutName: 'Level 1', uid: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a Tilemap');
  });
});

describe('set_tilemap_tiles', () => {
  it('paints, flips and erases single cells and keeps the rest byte-identical', async () => {
    const result = await server.callTool('set_tilemap_tiles', {
      layoutName: 'Level 1', uid: 900,
      tiles: [
        { x: 1, y: 8, value: null },
        { x: 2, y: 8, value: null },
        { x: 3, y: 8, value: null },
        { x: 4, y: 7, value: { tile: 0, flipX: true } },
        { x: 5, y: 7, value: { tile: 0, flipY: true } },
        { x: 6, y: 7, value: { tile: 0, flipY: true, flipDiagonal: true } },
        { x: 7, y: 7, value: { tile: 0, flipX: true, flipDiagonal: true } },
      ],
    });
    expect(result.isError).not.toBe(true);
    // The same edits in the editor produced exactly this string.
    const inst = await layoutInstance(900);
    expect(inst.ownData.tilemapData.data).toBe(sample.data.edited);
    expect(inst.world.width).toBe(320);
  });

  it('fills a rectangle and warns about a tile past the tileset', async () => {
    const data = parseResult(await server.callTool('set_tilemap_tiles', {
      layoutName: 'Level 1', uid: 901, fill: { x: 1, y: 0, width: 2, height: 2, value: 20 },
    }));
    expect(data.success).toBe(true);
    expect(data.warnings.join(' ')).toContain('Tile index 20 is outside the tileset, which holds 16 tile(s)');
    expect(data.warnings.join(' ')).toContain('created');
    const inst = await layoutInstance(901);
    expect(inst.ownData.tilemapData).toEqual({ width: 4, height: 2, 'max-width': 4, 'max-height': 2, data: '2x0,4x21,2x0' });
    expect(inst.ownData['tile-width']).toBe(16);
  });

  it('rejects a cell outside the map and writes nothing', async () => {
    const before = await readFile(join(tmpDir, 'layouts', 'Level 1.json'), 'utf-8');
    const result = await server.callTool('set_tilemap_tiles', {
      layoutName: 'Level 1', uid: 900, tiles: [{ x: 0, y: 0, value: 1 }, { x: 20, y: 0, value: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tiles[1]: cell 20,0 is outside the 20x17 tilemap');
    expect(await readFile(join(tmpDir, 'layouts', 'Level 1.json'), 'utf-8')).toBe(before);
  });

  it('requires tiles or fill', async () => {
    const result = await server.callTool('set_tilemap_tiles', { layoutName: 'Level 1', uid: 900 });
    expect(result.isError).toBe(true);
  });
});

describe('set_tilemap_data', () => {
  it('replaces the grid, resizes the instance, and reads back the same rows', async () => {
    const rows = [
      [0, 1, null],
      [{ tile: 2, flipX: true, flipY: true }, null, 3],
    ];
    const result = await server.callTool('set_tilemap_data', { layoutName: 'Level 1', uid: 900, rows });
    expect(result.isError).not.toBe(true);

    const inst = await layoutInstance(900);
    expect(inst.ownData.tilemapData).toEqual({ width: 3, height: 2, 'max-width': 3, 'max-height': 2, data: '1,3hv,2,2x0,4' });
    expect(inst.world.width).toBe(48);
    expect(inst.world.height).toBe(32);

    const data = parseResult(await server.callTool('get_tilemap_data', { layoutName: 'Level 1', uid: 900 }));
    expect(data.rows).toEqual(rows);
  });

  it('keeps the instance size when asked and warns about the mismatch', async () => {
    const data = parseResult(await server.callTool('set_tilemap_data', {
      layoutName: 'Level 1', uid: 901, rows: [[1, 2]], resizeInstance: false,
    }));
    expect(data.warnings.join(' ')).toContain('covers 4x2 cells but the grid is 2x1');
    const inst = await layoutInstance(901);
    expect(inst.world.width).toBe(64);
    expect(inst.ownData.tilemapData.data).toBe('2,3');
  });

  it('rejects ragged rows and invalid cells', async () => {
    const ragged = await server.callTool('set_tilemap_data', { layoutName: 'Level 1', uid: 900, rows: [[1, 2], [3]] });
    expect(ragged.isError).toBe(true);
    expect(ragged.content[0].text).toContain('rows[1] has 1 cell(s); every row needs 2');

    const bad = await server.callTool('set_tilemap_data', { layoutName: 'Level 1', uid: 900, rows: [[1, '2h']] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('rows[0][1]');
  });
});
