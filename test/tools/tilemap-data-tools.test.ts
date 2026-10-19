/**
 * Real-reader/writer tests for the tilemap tile-data tools on a temp project
 * made by test/helpers/tilemap-project.ts: Tilemap object types `Tiles` (64x64
 * tileset, 16px tiles: 16 tiles) and `Walls`, and on "Layout 1" a painted
 * Tiles instance (UID 900, 4x2 cells) and a Tiles instance without tile data
 * (UID 901, 64x32 at 16px tiles). Expected values are written out as literals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTilemapDataTools } from '../../src/tools/tilemap-data-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';
import { makeTilemapProject, PAINTED_UID, BARE_UID, SPRITE_UID, PAINTED_ROWS, PAINTED_DATA } from '../helpers/tilemap-project.js';

interface InstanceJson {
  uid: number;
  properties: Record<string, unknown>;
  ownData?: unknown;
  world: { width: number; height: number; [key: string]: unknown };
  [key: string]: unknown;
}
interface LayoutJson {
  name: string;
  layers: Array<{ instances: InstanceJson[]; [key: string]: unknown }>;
  [key: string]: unknown;
}
interface OwnDataJson {
  tilemapData: { width: number; height: number; 'max-width': number; 'max-height': number; data: string; [key: string]: unknown };
  [key: string]: unknown;
}

const ENDING = 'Nothing was changed.';
/** The text MAX_WRITE_CELLS, MAX_READ_CELLS and MAX_TILE_INDEX stand for in the module. */
const MAX_WRITE_CELLS = 250_000;
const MAX_TILE_INDEX = Number.MAX_SAFE_INTEGER - 1;

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const layoutBytes = () => readFile(layoutPath(), 'utf-8');

async function layoutJson(): Promise<LayoutJson> {
  return JSON.parse(await layoutBytes()) as LayoutJson;
}

async function layoutInstance(uid: number): Promise<InstanceJson> {
  return (await layoutJson()).layers[0].instances.find(i => i.uid === uid)!;
}

/** Change the layout file on disk, as an editor save or a hand edit would. */
async function editLayout(change: (layout: LayoutJson) => void): Promise<void> {
  const layout = await layoutJson();
  change(layout);
  await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
}

/** Change one instance of the layout file. */
async function editInstance(uid: number, change: (inst: InstanceJson) => void): Promise<void> {
  await editLayout(layout => change(layout.layers[0].instances.find(i => i.uid === uid)!));
}

const ownOf = (inst: InstanceJson) => inst.ownData as OwnDataJson;

async function call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await server.callTool(tool, args);
  return { isError: result.isError === true, text: result.content[0].text };
}

/** A call that must succeed; its parsed result. */
async function ok(tool: string, args: Record<string, unknown>) {
  const result = await call(tool, args);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as Record<string, unknown> & { rows: unknown; warnings?: string[] };
}

/** A write tool call that must be refused before anything is written: its text. */
async function expectWriteRefused(tool: string, args: Record<string, unknown>, ...parts: string[]): Promise<string> {
  const before = await layoutBytes();
  const spy = vi.spyOn(writer, 'writeEntityFile');
  const result = await call(tool, args);
  expect(result.isError).toBe(true);
  for (const part of parts) expect(result.text).toContain(part);
  expect(result.text.endsWith(ENDING)).toBe(true);
  expect(spy).not.toHaveBeenCalled();
  expect(await layoutBytes()).toBe(before);
  spy.mockRestore();
  return result.text;
}

/** A read call that must be refused: its text, which does not carry the write tools' ending. */
async function expectReadRefused(args: Record<string, unknown>, ...parts: string[]): Promise<string> {
  const result = await call('get_tilemap_data', args);
  expect(result.isError).toBe(true);
  for (const part of parts) expect(result.text).toContain(part);
  expect(result.text).not.toContain(ENDING);
  return result.text;
}

const paint = (uid: number, value: unknown = 1) => ({ layoutName: 'Layout 1', uid, tiles: [{ x: 0, y: 0, value }] });
const replace = (uid: number, rows: unknown[][], more: Record<string, unknown> = {}) => ({ layoutName: 'Layout 1', uid, rows, ...more });
const get = (uid: number, more: Record<string, unknown> = {}) => ({ layoutName: 'Layout 1', uid, ...more });

/** The writer's read-back of `fileName` fails once with an ordinary error, as call-rollback.test.ts injects it. */
function failReadBackOf(fileName: string): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  internals.verifyWrittenFile = async (path, name, text) => {
    if (!failed && path.endsWith(fileName)) {
      failed = true;
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read ${join(tmpDir, 'layouts', 'Layout 1.json')}`);
    }
    return verify(path, name, text);
  };
}

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-tiledata-'));
  await makeTilemapProject(tmpDir);
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerTilemapDataTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('get_tilemap_data', () => {
  it('returns rows[y][x] for the painted instance', async () => {
    const data = await ok('get_tilemap_data', get(PAINTED_UID));
    expect(data.width).toBe(4);
    expect(data.height).toBe(2);
    expect(data.tileWidth).toBe(16);
    expect(data.tilesetTileCount).toBe(16);
    expect(data.rows).toEqual([[0, 1, 1, 2], [null, { tile: 3, flipX: true }, 3, 3]]);
    expect(data.rows).toEqual(PAINTED_ROWS);
    expect(data.emptyCells).toBe(1);
  });

  it('returns only the requested region', async () => {
    const data = await ok('get_tilemap_data', get(PAINTED_UID, { region: { x: 1, y: 0, width: 2, height: 2 } }));
    expect(data.rows).toEqual([[1, 1], [{ tile: 3, flipX: true }, 3]]);
  });

  it('rejects a region past the edge', async () => {
    await expectReadRefused(get(PAINTED_UID, { region: { x: 3, y: 1, width: 2, height: 2 } }), 'extends past the 4x2 tilemap');
  });

  it('rejects a region past the bottom edge alone', async () => {
    await expectReadRefused(get(PAINTED_UID, { region: { x: 0, y: 1, width: 1, height: 2 } }), 'The region 0,1 1x2 extends past the 4x2 tilemap');
  });

  it('shows an empty grid sized from the instance when there is no tile data', async () => {
    const data = await ok('get_tilemap_data', get(BARE_UID));
    expect(data.width).toBe(4);
    expect(data.height).toBe(2);
    expect(data.rows).toEqual([[null, null, null, null], [null, null, null, null]]);
    expect(data.emptyCells).toBe(8);
    expect(data.warnings!.join(' ')).toContain('no tile data yet');
  });

  it('refuses an instance that is not a Tilemap', async () => {
    await expectReadRefused(get(SPRITE_UID), 'not a Tilemap');
  });

  it('refuses a map over the read limit without a region, and a region over it', async () => {
    await editInstance(PAINTED_UID, inst => {
      ownOf(inst).tilemapData = { width: 101, height: 100, 'max-width': 101, 'max-height': 100, data: '10100x0' };
    });
    await expectReadRefused(get(PAINTED_UID), 'The tilemap is 101x100 (10100 cells); pass a region of at most 10000 cells');
    await expectReadRefused(get(PAINTED_UID, { region: { x: 0, y: 0, width: 101, height: 100 } }), 'The region holds 10100 cells; the limit is 10000');
  });
});

describe('set_tilemap_tiles', () => {
  it('paints, flips and erases single cells and keeps the others', async () => {
    const data = await ok('set_tilemap_tiles', {
      layoutName: 'Layout 1', uid: PAINTED_UID,
      tiles: [{ x: 0, y: 1, value: { tile: 2, flipY: true } }, { x: 3, y: 0, value: null }],
    });
    expect(data.success).toBe(true);
    const inst = await layoutInstance(PAINTED_UID);
    expect(ownOf(inst).tilemapData.data).toBe('1,3v,2,4h,2,4,0,4');
    expect(inst.world.width).toBe(64);
  });

  it('fills a rectangle, then applies tiles on top', async () => {
    await ok('set_tilemap_tiles', { layoutName: 'Layout 1', uid: PAINTED_UID, fill: { x: 0, y: 0, width: 4, height: 2, value: 0 } });
    expect(ownOf(await layoutInstance(PAINTED_UID)).tilemapData.data).toBe('8x1');
    await ok('set_tilemap_tiles', {
      layoutName: 'Layout 1', uid: PAINTED_UID,
      fill: { x: 0, y: 0, width: 4, height: 2, value: 0 }, tiles: [{ x: 1, y: 1, value: 5 }],
    });
    expect(ownOf(await layoutInstance(PAINTED_UID)).tilemapData.data).toBe('3x1,6,4x1');
  });

  it('creates a grid for a bare instance and warns about a tile past the tileset', async () => {
    const data = await ok('set_tilemap_tiles', { layoutName: 'Layout 1', uid: BARE_UID, fill: { x: 1, y: 0, width: 2, height: 2, value: 20 } });
    expect(data.warnings!.join(' ')).toContain('Tile index 20 is outside the tileset, which holds 16 tile(s)');
    expect(data.warnings!.join(' ')).toContain('created');
    const inst = await layoutInstance(BARE_UID);
    expect(ownOf(inst).tilemapData).toEqual({ width: 4, height: 2, 'max-width': 4, 'max-height': 2, data: '2x0,4x21,2x0' });
    expect(ownOf(inst)['tile-width']).toBe(16);
  });

  it('refuses a cell outside the map', async () => {
    await expectWriteRefused('set_tilemap_tiles', { layoutName: 'Layout 1', uid: PAINTED_UID, tiles: [{ x: 4, y: 0, value: 0 }] },
      'tiles[0]: cell 4,0 is outside the 4x2 tilemap');
  });

  it('refuses a cell below the map, which would otherwise land in the next column', async () => {
    await expectWriteRefused('set_tilemap_tiles', { layoutName: 'Layout 1', uid: PAINTED_UID, tiles: [{ x: 0, y: 2, value: 0 }] },
      'tiles[0]: cell 0,2 is outside the 4x2 tilemap');
  });

  it('warns about a tile index outside the tileset', async () => {
    const data = await ok('set_tilemap_tiles', paint(PAINTED_UID, 16));
    expect(data.warnings!.join(' ')).toContain('Tile index 16 is outside the tileset, which holds 16 tile(s) (indices 0 to 15).');
  });

  it('requires tiles or fill', async () => {
    await expectWriteRefused('set_tilemap_tiles', { layoutName: 'Layout 1', uid: PAINTED_UID }, 'No cells provided');
  });

  it('refuses a fill past the edge and a fill over the write limit', async () => {
    await expectWriteRefused('set_tilemap_tiles', { layoutName: 'Layout 1', uid: PAINTED_UID, fill: { x: 3, y: 0, width: 2, height: 1, value: 1 } },
      'The fill 3,0 2x1 extends past the 4x2 tilemap');
    await expectWriteRefused('set_tilemap_tiles', { layoutName: 'Layout 1', uid: PAINTED_UID, fill: { x: 0, y: 1, width: 1, height: 2, value: 1 } },
      'The fill 0,1 1x2 extends past the 4x2 tilemap');
    await expectWriteRefused('set_tilemap_tiles', { layoutName: 'Layout 1', uid: PAINTED_UID, fill: { x: 0, y: 0, width: 501, height: 501, value: 1 } },
      'The fill covers 251001 cells; the limit is 250000');
  });

  it('refuses an instance whose tile data has no cells', async () => {
    await editInstance(PAINTED_UID, inst => {
      ownOf(inst).tilemapData = { width: 0, height: 0, 'max-width': 0, 'max-height': 0, data: '' };
    });
    await expectWriteRefused('set_tilemap_tiles', paint(PAINTED_UID), 'Instance 900 has no cells (size 0x0); use set_tilemap_data to give it a grid');
  });
});

describe('set_tilemap_data', () => {
  it('replaces the grid, resizes the instance, and reads back the same rows', async () => {
    const rows = [[0, 1, null], [{ tile: 2, flipX: true, flipY: true }, null, 3]];
    await ok('set_tilemap_data', replace(PAINTED_UID, rows));
    const inst = await layoutInstance(PAINTED_UID);
    expect(ownOf(inst).tilemapData).toEqual({ width: 3, height: 2, 'max-width': 3, 'max-height': 2, data: '1,3hv,2,2x0,4' });
    expect(inst.world.width).toBe(48);
    expect(inst.world.height).toBe(32);
    expect((await ok('get_tilemap_data', get(PAINTED_UID))).rows).toEqual(rows);
  });

  it('sizes a bare instance to the grid', async () => {
    await ok('set_tilemap_data', replace(BARE_UID, [[0, 1, 2], [3, 4, 5]]));
    const inst = await layoutInstance(BARE_UID);
    expect(ownOf(inst).tilemapData.data).toBe('1,4,2,5,3,6');
    expect(inst.world.width).toBe(48);
    expect(inst.world.height).toBe(32);
  });

  it('keeps the instance size when asked, and the size warning states the sizes only', async () => {
    const data = await ok('set_tilemap_data', replace(BARE_UID, [[1, 2, 3], [4, 5, 6]], { resizeInstance: false }));
    expect(data.warnings).toEqual(['The instance covers 4x2 cells but the grid is 3x2.']);
    const inst = await layoutInstance(BARE_UID);
    expect(inst.world.width).toBe(64);
    expect(ownOf(inst).tilemapData.data).toBe('2,5,3,6,4,7');
    for (const warning of data.warnings!) expect(warning).not.toMatch(/Construct|r\d{3}/);
  });

  it('rejects ragged rows, empty rows and invalid cells', async () => {
    await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, [[1, 2], [3]]), 'rows[1] has 1 cell(s); every row needs 2');
    await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, [[1, '2h']]), 'rows[0][1]');
    await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, [[]]), 'rows[0] is empty; a tilemap needs at least one column');
  });
});

describe('the registered tools', () => {
  it('registers the three tools through the project sync', async () => {
    for (const name of ['get_tilemap_data', 'set_tilemap_tiles', 'set_tilemap_data']) expect(server.getTool(name)).toBeDefined();
    await ok('get_tilemap_data', get(PAINTED_UID));
    // A second layout appears on disk between two calls; the project file changes length
    const layout = await layoutJson();
    const second = structuredClone(layout);
    second.name = 'Layout 2';
    second.layers[0].instances = [{ ...layout.layers[0].instances.find(i => i.uid === PAINTED_UID)!, uid: 950, sid: 690000000000950 }];
    await writeFile(join(tmpDir, 'layouts', 'Layout 2.json'), JSON.stringify(second, null, '\t'));
    const projectPath = join(tmpDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf-8')) as { layouts: { items: string[] } };
    project.layouts.items.push('Layout 2');
    await writeFile(projectPath, JSON.stringify(project, null, '\t'));
    const data = await ok('get_tilemap_data', { layoutName: 'Layout 2', uid: 950 });
    expect(data.rows).toEqual(PAINTED_ROWS);
  });

  it('writes the layout once per call and reports the update', async () => {
    const spy = vi.spyOn(writer, 'writeEntityFile');
    const tiles = await ok('set_tilemap_tiles', paint(PAINTED_UID, 2));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(tiles).toMatchObject({ success: true, action: 'updated', entity: 'Layout 1/900' });
    expect(typeof tiles.backupFile).toBe('string');
    expect(tiles.editorNote).toBeDefined();
    const data = await ok('set_tilemap_data', replace(PAINTED_UID, [[1]]));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(data).toMatchObject({ success: true, action: 'updated', entity: 'Layout 1/900' });
    expect(typeof data.backupFile).toBe('string');
    expect(data.editorNote).toBeDefined();
  });

  it('refuses a layout name in another letter case, and an unknown layout', async () => {
    for (const [tool, args] of [['set_tilemap_tiles', paint(PAINTED_UID)], ['set_tilemap_data', replace(PAINTED_UID, [[1]])]] as const) {
      await expectWriteRefused(tool, { ...args, layoutName: 'layout 1' }, 'Did you mean "Layout 1"?');
      await expectWriteRefused(tool, { ...args, layoutName: 'Nope' }, 'Layout "Nope" not found');
    }
    await expectReadRefused({ ...get(PAINTED_UID), layoutName: 'layout 1' }, 'Did you mean "Layout 1"?');
    await expectReadRefused({ ...get(PAINTED_UID), layoutName: 'Nope' }, 'Layout "Nope" not found');
  });

  it('refuses an instance that is not in the layout', async () => {
    await expectWriteRefused('set_tilemap_tiles', paint(12345), 'Instance with UID 12345 not found in layout "Layout 1"');
    await expectWriteRefused('set_tilemap_data', replace(12345, [[1]]), 'Instance with UID 12345 not found in layout "Layout 1"');
  });

  it('refuses a UID used by two instances', async () => {
    await editInstance(BARE_UID, inst => { inst.uid = PAINTED_UID; inst.tags = 'duplicate'; });
    const text = await expectWriteRefused('set_tilemap_tiles', paint(PAINTED_UID), 'UID 900 is used by 2 instances of layout "Layout 1"');
    expect(text).toContain('which one is meant cannot be told');
    await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, [[1]]), 'UID 900 is used by 2 instances');
    await expectReadRefused(get(PAINTED_UID), 'UID 900 is used by 2 instances of layout "Layout 1"');
  });

  it('refuses an instance of another plugin', async () => {
    await expectWriteRefused('set_tilemap_tiles', paint(SPRITE_UID), 'is a "Sprite" (plugin "Sprite"), not a Tilemap');
    await expectWriteRefused('set_tilemap_data', replace(SPRITE_UID, [[1]]), 'is a "Sprite" (plugin "Sprite"), not a Tilemap');
  });

  it('refuses an object type it cannot read, without the project folder', async () => {
    const forward = tmpDir.replace(/\\/g, '/');
    vi.spyOn(reader, 'readObjectType').mockRejectedValue(new Error(`EBUSY: open ${join(tmpDir, 'objectTypes', 'Tiles.json')}`));
    for (const [tool, args] of [['set_tilemap_tiles', paint(PAINTED_UID)], ['set_tilemap_data', replace(PAINTED_UID, [[1]])]] as const) {
      const text = await expectWriteRefused(tool, args, 'Cannot read object type "Tiles"');
      expect(text).not.toContain(tmpDir);
      expect(text).not.toContain(forward);
    }
    const read = await expectReadRefused(get(PAINTED_UID), 'Cannot read object type "Tiles"');
    expect(read).not.toContain(tmpDir);
  });

  it('refuses an invalid tile size', async () => {
    await editInstance(BARE_UID, inst => { inst.properties['tile-width'] = 0; });
    await expectWriteRefused('set_tilemap_tiles', paint(BARE_UID), 'has an invalid tile size 0x16');
    await expectWriteRefused('set_tilemap_data', replace(BARE_UID, [[1]]), 'has an invalid tile size 0x16');
  });

  it('refuses an invalid tile height', async () => {
    await editInstance(BARE_UID, inst => { inst.properties['tile-height'] = 0; });
    await expectWriteRefused('set_tilemap_tiles', paint(BARE_UID), 'has an invalid tile size 16x0');
    await expectWriteRefused('set_tilemap_data', replace(BARE_UID, [[1]]), 'has an invalid tile size 16x0');
  });
  it('refuses to overwrite tile data it cannot decode, except by replacing it', async () => {
    await editInstance(PAINTED_UID, inst => { ownOf(inst).tilemapData.data = '1,2,3'; });
    const text = await expectWriteRefused('set_tilemap_tiles', paint(PAINTED_UID), 'The stored tile data cannot be read: Tile data holds 3 cells');
    expect(text.startsWith('The change was stopped')).toBe(false);
    await expectReadRefused(get(PAINTED_UID), 'The stored tile data cannot be read: Tile data holds 3 cells');
    await ok('set_tilemap_data', replace(PAINTED_UID, [[1, 2]]));
    expect(ownOf(await layoutInstance(PAINTED_UID)).tilemapData.data).toBe('2,3');
  });

  it('keeps the other keys of the data block', async () => {
    await editInstance(PAINTED_UID, inst => { ownOf(inst).tilemapData.custom = 5; });
    await ok('set_tilemap_tiles', paint(PAINTED_UID, 2));
    const block = ownOf(await layoutInstance(PAINTED_UID)).tilemapData;
    expect(block.custom).toBe(5);
    expect(block['max-width']).toBe(4);
    expect(block['max-height']).toBe(2);
  });

  it('keeps the tile keys of the instance: written from properties when missing, never replaced', async () => {
    await ok('set_tilemap_data', replace(BARE_UID, [[1]]));
    const bare = ownOf(await layoutInstance(BARE_UID));
    expect(bare['tile-width']).toBe(16);
    expect(bare['tile-height']).toBe(16);
    await editInstance(PAINTED_UID, inst => { ownOf(inst)['tile-width'] = 240; });
    await ok('set_tilemap_data', replace(PAINTED_UID, [[1]]));
    expect(ownOf(await layoutInstance(PAINTED_UID))['tile-width']).toBe(240);
  });
});

describe('bounds', () => {
  it('bounds a request in the schema and the grid in the tool', async () => {
    await expect(call('set_tilemap_data', replace(PAINTED_UID, Array.from({ length: MAX_WRITE_CELLS + 1 }, () => [0])))).rejects.toThrow(/at most/);
    await expect(call('set_tilemap_data', replace(PAINTED_UID, [new Array<number>(MAX_WRITE_CELLS + 1).fill(0)]))).rejects.toThrow(/at most/);
    const grid = Array.from({ length: 501 }, () => new Array<number>(501).fill(0));
    await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, grid), 'The grid holds 251001 cells; the limit is 250000');
    const many = (n: number) => ({ layoutName: 'Layout 1', uid: PAINTED_UID, tiles: Array.from({ length: n }, () => ({ x: 0, y: 0, value: 0 })) });
    await expect(call('set_tilemap_tiles', many(MAX_WRITE_CELLS + 1))).rejects.toThrow(/at most/);
    expect((await call('set_tilemap_tiles', many(MAX_WRITE_CELLS))).isError).toBe(false);
  });

  it('refuses a tile index too large to store', async () => {
    const tooLarge = Number.MAX_SAFE_INTEGER;
    await expect(call('set_tilemap_tiles', paint(PAINTED_UID, tooLarge))).rejects.toThrow(/9007199254740990/);
    await expect(call('set_tilemap_tiles', paint(PAINTED_UID, { tile: tooLarge }))).rejects.toThrow(/9007199254740990/);
    expect((await call('set_tilemap_tiles', paint(PAINTED_UID, MAX_TILE_INDEX))).isError).toBe(false);
    expect((await call('set_tilemap_tiles', paint(PAINTED_UID, { tile: MAX_TILE_INDEX }))).isError).toBe(false);
    for (const cell of [tooLarge, { tile: tooLarge }]) {
      await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, [[cell]]), 'Tile index 9007199254740991 is too large (at most 9007199254740990).');
    }
    await ok('set_tilemap_data', replace(PAINTED_UID, [[MAX_TILE_INDEX]]));
    expect(ownOf(await layoutInstance(PAINTED_UID)).tilemapData.data).toBe('9007199254740991');
  });

  it('refuses a paint when a stored cell is already too large to store', async () => {
    await editInstance(PAINTED_UID, inst => { ownOf(inst).tilemapData.data = '0,0,0,0,0,0,0,9007199254740992'; });
    await expectWriteRefused('set_tilemap_tiles', paint(PAINTED_UID, 1), 'Tile index 9007199254740991 is too large (at most 9007199254740990).');
  });

  it('refuses a bare instance whose derived grid is over the map limit, before any write', async () => {
    await editInstance(BARE_UID, inst => { inst.world.width = 64016; inst.world.height = 16000; });
    await expectWriteRefused('set_tilemap_tiles', paint(BARE_UID), '4001x1000', 'the 4000000-cell limit');
    await expectReadRefused(get(BARE_UID), '4001x1000', 'the 4000000-cell limit');
  });

  it('does not refuse a bare instance of exactly the map limit', async () => {
    await editInstance(BARE_UID, inst => { inst.world.width = 32000; inst.world.height = 32000; });
    const data = await ok('get_tilemap_data', get(BARE_UID, { region: { x: 0, y: 0, width: 10, height: 10 } }));
    expect(data.width).toBe(2000);
    expect(data.height).toBe(2000);
  });
});

describe('malformed tile containers', () => {
  it('refuses ownData that is not an object', async () => {
    await editInstance(PAINTED_UID, inst => { inst.ownData = []; });
    await expectWriteRefused('set_tilemap_tiles', paint(PAINTED_UID), 'ownData is not an object');
    await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, [[1]]), 'ownData is not an object');
    await expectReadRefused(get(PAINTED_UID), 'ownData is not an object');
  });

  it('refuses tilemapData that is not an object', async () => {
    for (const bad of [[], 'text']) {
      await editInstance(PAINTED_UID, inst => { ownOf(inst).tilemapData = bad as never; });
      await expectWriteRefused('set_tilemap_tiles', paint(PAINTED_UID), 'ownData.tilemapData is not an object');
      await expectWriteRefused('set_tilemap_data', replace(PAINTED_UID, [[1]]), 'ownData.tilemapData is not an object');
      await expectReadRefused(get(PAINTED_UID), 'ownData.tilemapData is not an object');
    }
  });

  it('accepts null or absent ownData and persists the new block', async () => {
    await ok('set_tilemap_data', replace(BARE_UID, [[1, 2]]));
    expect(ownOf(await layoutInstance(BARE_UID)).tilemapData.data).toBe('2,3');
    await editInstance(BARE_UID, inst => { inst.ownData = null; });
    await ok('set_tilemap_data', replace(BARE_UID, [[3, 4]]));
    expect(ownOf(await layoutInstance(BARE_UID)).tilemapData.data).toBe('4,5');
  });
});

describe('failures', () => {
  it('puts the layout back when its read-back fails', async () => {
    const before = await layoutBytes();
    for (const [tool, args] of [['set_tilemap_tiles', paint(PAINTED_UID, 2)], ['set_tilemap_data', replace(PAINTED_UID, [[1]])]] as const) {
      failReadBackOf('Layout 1.json');
      const result = await call(tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
      expect(result.text).not.toContain(tmpDir);
      expect(result.text).not.toContain(tmpDir.replace(/\\/g, '/'));
      expect(await layoutBytes()).toBe(before);
      expect((await ok('get_tilemap_data', get(PAINTED_UID))).rows).toEqual(PAINTED_ROWS);
    }
  });

  it('refuses a layout the editor saved meanwhile', async () => {
    const original = reader.readObjectType.bind(reader);
    for (const [round, [tool, args]] of ([['set_tilemap_tiles', paint(PAINTED_UID, 2)], ['set_tilemap_data', replace(PAINTED_UID, [[1]])]] as const).entries()) {
      // A different length each round, so the writer tells the files apart by size
      const edited = JSON.stringify({ ...(await layoutJson()), savedInEditor: 'x'.repeat(round + 1) }, null, '\t');
      const spy = vi.spyOn(reader, 'readObjectType').mockImplementation(async name => {
        await writeFile(layoutPath(), edited);
        return original(name);
      });
      const result = await call(tool, args);
      spy.mockRestore();
      expect(result.isError).toBe(true);
      expect(result.text).toContain('layouts/Layout 1.json was changed on disk after this server read it');
      expect(result.text).toContain('Run the tool again: it reads the file as it is now.');
      expect(result.text).not.toContain(ENDING);
      expect(await layoutBytes()).toBe(edited);
    }
  });

  it('an error thrown by a check before the write is a refusal', async () => {
    const forward = tmpDir.replace(/\\/g, '/');
    vi.spyOn(reader, 'listLayouts').mockRejectedValue(new Error(`Cannot list ${tmpDir}\\layouts and ${forward}/layouts.`));
    for (const [tool, args] of [['set_tilemap_tiles', paint(PAINTED_UID)], ['set_tilemap_data', replace(PAINTED_UID, [[1]])]] as const) {
      const text = await expectWriteRefused(tool, args, 'The change was stopped before anything was written:');
      expect(text).not.toContain(tmpDir);
      expect(text).not.toContain(forward);
    }
    const read = await expectReadRefused(get(PAINTED_UID), 'Error reading tilemap data:');
    expect(read).not.toContain(tmpDir);
    expect(read).not.toContain(forward);
  });

  it('words a failing project check by the tool kind', async () => {
    const forward = tmpDir.replace(/\\/g, '/');
    vi.spyOn(reader, 'checkProjectFile').mockRejectedValue(new Error(`Cannot read ${tmpDir}\\project.c3proj and ${forward}/project.c3proj.`));
    for (const [tool, args] of [['set_tilemap_tiles', paint(PAINTED_UID)], ['set_tilemap_data', replace(PAINTED_UID, [[1]])]] as const) {
      const text = await expectWriteRefused(tool, args, 'The change was stopped before anything was written:');
      expect(text).not.toContain(tmpDir);
      expect(text).not.toContain(forward);
    }
    const read = await expectReadRefused(get(PAINTED_UID), 'Error reading the project:');
    expect(read).not.toContain(tmpDir);
    expect(read).not.toContain(forward);
  });
});

describe('the project helper constants', () => {
  it('start from the painted data', async () => {
    expect(ownOf(await layoutInstance(PAINTED_UID)).tilemapData.data).toBe(PAINTED_DATA);
  });
});
