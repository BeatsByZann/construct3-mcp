/**
 * Real-reader/writer tests for the tilemap brush tools on a temp project made
 * by test/helpers/tilemap-project.ts: Tilemap object types `Tiles` (project
 * root) and `Walls` (project-bar folder "Scenery"), and the Sprite object
 * type of minimal-project. `Tiles` has a compact one-brush file on disk;
 * `Walls` has none.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import type { Dirent } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTilemapBrushTools, brushFilesElsewhere, brushFileRelativePath } from '../../src/tools/tilemap-brush-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';
import { makeTilemapProject, TILES_BRUSH_PATH, WALLS_BRUSH_PATH } from '../helpers/tilemap-project.js';

const ENDING = 'Nothing was changed.';
const AUTO16 = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, null]];
const BRUSH_0 = { name: 'Brush 0', type: 'auto16', data: AUTO16 };
/** The setup's brush file text: compact, one brush. */
const BRUSH_0_TEXT = '[{"name":"Brush 0","type":"auto16","data":[[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,null]]}]';

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

/** Absolute path of a project-relative path. */
const at = (relative: string) => join(tmpDir, ...relative.split('/'));
const brushBytes = (relative: string) => readFile(at(relative), 'utf-8');

async function call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await server.callTool(tool, args);
  return { isError: result.isError === true, text: result.content[0].text };
}

/** A call that must succeed; its parsed result. */
async function ok(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> & { warnings?: string[] }> {
  const result = await call(tool, args);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as Record<string, unknown> & { warnings?: string[] };
}

/** The project folder in both slash forms must not appear in a text. */
function expectNoFolder(text: string): void {
  expect(text).not.toContain(tmpDir);
  expect(text).not.toContain(tmpDir.replace(/\\/g, '/'));
}

const addArgs = (objectName: string, name = 'New') => ({ objectName, name, type: 'auto16', data: AUTO16 });
const updateArgs = (objectName: string) => ({ objectName, name: 'Brush 0', newName: 'Renamed' });
const deleteArgs = (objectName: string) => ({ objectName, name: 'Brush 0' });
const WRITE_TOOLS: Array<[string, (objectName: string) => Record<string, unknown>]> = [
  ['add_tilemap_brush', addArgs],
  ['update_tilemap_brush', updateArgs],
  ['delete_tilemap_brush', deleteArgs],
];

/** Write a file, making its folder. */
async function put(relative: string, text: string): Promise<void> {
  await mkdir(join(at(relative), '..'), { recursive: true });
  await writeFile(at(relative), text);
}

/** Every write tool refuses, before any write, with `parts` in its text and the ending last. */
async function expectWriteRefusals(objectName: string, watched: string, parts: string[]): Promise<void> {
  const before = await brushBytes(watched);
  const spy = vi.spyOn(writer, 'replaceFile');
  for (const [tool, args] of WRITE_TOOLS) {
    const result = await call(tool, args(objectName));
    expect(result.isError, `${tool}: ${result.text}`).toBe(true);
    for (const part of parts) expect(result.text, tool).toContain(part);
    expect(result.text.endsWith(ENDING), tool).toBe(true);
    expectNoFolder(result.text);
  }
  expect(spy).not.toHaveBeenCalled();
  expect(await brushBytes(watched)).toBe(before);
  spy.mockRestore();
}

/** Make `rejection` the outcome of the next replaceFile calls, after `before` and optionally the real write. */
function wrapReplaceFile(step: (path: string, original: () => Promise<string | undefined>) => Promise<string | undefined>) {
  const original = writer.replaceFile.bind(writer);
  return vi.spyOn(writer, 'replaceFile').mockImplementation((path, content, options) => step(path, () => original(path, content, options)));
}

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-brush-'));
  await makeTilemapProject(tmpDir);
  await put(TILES_BRUSH_PATH, BRUSH_0_TEXT);
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerTilemapBrushTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('list_tilemap_brushes', () => {
  it('lists the brushes with their grid size, and the file path project-relative', async () => {
    const result = await ok('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(result.file).toBe('tilemapBrushes/objectTypes/Tiles.brush.json');
    expect(result.fileExists).toBe(true);
    expect(result.brushes).toEqual([{ index: 0, name: 'Brush 0', type: 'auto16', size: '4x4' }]);
    expect(result.count).toBe(1);
    expect(result.warnings).toBeUndefined();
  });

  it('gives a patch brush its own size, and a brush without readable data an unknown one', async () => {
    const patch = { width: 3, height: 2, data: [[1, 2, 3], [4, 5, 6]] };
    await writeFile(at(TILES_BRUSH_PATH), JSON.stringify([
      { name: 'P', type: 'patch', data: patch },
      { name: 'Broken', type: 'patch', data: 5 },
      { name: 'Odd', type: 'other', data: [] },
    ]));
    const result = await ok('list_tilemap_brushes', { objectName: 'Tiles' });
    expect((result.brushes as Array<{ size: string }>).map(b => b.size)).toEqual(['3x2', 'unknown', 'unknown']);
  });

  it('gives an auto47 brush its size as columns x rows', async () => {
    const grid = Array.from({ length: 6 }, (_, r) => Array.from({ length: 8 }, (_, c) => r * 8 + c));
    await ok('add_tilemap_brush', { objectName: 'Tiles', name: 'Auto 47', type: 'auto47', data: grid });
    const result = await ok('list_tilemap_brushes', { objectName: 'Tiles' });
    expect((result.brushes as Array<{ name: string; size: string }>).find(b => b.name === 'Auto 47')?.size).toBe('8x6');
  });

  it('reports an object type without a brush file as an empty list', async () => {
    const result = await ok('list_tilemap_brushes', { objectName: 'Walls' });
    expect(result.fileExists).toBe(false);
    expect(result.count).toBe(0);
  });
});

describe('add_tilemap_brush', () => {
  it('appends a brush and keeps the existing ones', async () => {
    const patch = { width: 2, height: 2, data: [[1, 2], [3, [{ index: 4, probability: 0.5 }]]] };
    const result = await ok('add_tilemap_brush', { objectName: 'Tiles', name: 'Patchy', type: 'patch', data: patch });
    expect(result.action).toBe('created');
    expect(result.entity).toBe('Tiles/Patchy');
    expect(JSON.parse(await brushBytes(TILES_BRUSH_PATH))).toEqual([BRUSH_0, { name: 'Patchy', type: 'patch', data: patch }]);
    expect(typeof result.backupFile).toBe('string');
  });

  it('rejects a grid of the wrong size', async () => {
    const wrongSize = await call('add_tilemap_brush', { ...addArgs('Tiles', 'Bad'), data: AUTO16.slice(0, 3) });
    expect(wrongSize.isError).toBe(true);
    expect(wrongSize.text).toContain('exactly 4 row(s), got 3');
    expect(wrongSize.text.endsWith(ENDING)).toBe(true);
    const wrongType = await call('add_tilemap_brush', { objectName: 'Tiles', name: 'Bad47', type: 'auto47', data: AUTO16 });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.text.endsWith(ENDING)).toBe(true);
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
  });

  it('refuses a duplicate brush name and an invalid name', async () => {
    const duplicate = await call('add_tilemap_brush', addArgs('Tiles', 'Brush 0'));
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toContain('already has a brush named "Brush 0". Use update_tilemap_brush to change it.');
    const invalid = await call('add_tilemap_brush', addArgs('Tiles', '..'));
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain('Name must start with a letter');
    expect(invalid.text.endsWith(ENDING)).toBe(true);
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
  });
});

describe('update_tilemap_brush', () => {
  it('renames a brush and replaces its data', async () => {
    const renamed = await ok('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', newName: 'Ground' });
    expect(renamed.action).toBe('updated');
    expect(JSON.parse(await brushBytes(TILES_BRUSH_PATH))[0].name).toBe('Ground');
    const replaced = AUTO16.map(row => row.map(cell => (cell === null ? null : 99)));
    await ok('update_tilemap_brush', { objectName: 'Tiles', name: 'Ground', data: replaced });
    expect(JSON.parse(await brushBytes(TILES_BRUSH_PATH))[0].data).toEqual(replaced);
  });

  it('changes the type only with matching data', async () => {
    const noData = await call('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', type: 'auto47' });
    expect(noData.isError).toBe(true);
    expect(noData.text).toContain('requires new data');
    expect(noData.text.endsWith(ENDING)).toBe(true);
    const mismatched = await call('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', type: 'auto47', data: AUTO16 });
    expect(mismatched.isError).toBe(true);
    await ok('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', type: 'patch', data: { width: 1, height: 1, data: [[7]] } });
    expect(JSON.parse(await brushBytes(TILES_BRUSH_PATH))[0]).toEqual({ name: 'Brush 0', type: 'patch', data: { width: 1, height: 1, data: [[7]] } });
  });

  it('validates replacement data against the current type', async () => {
    const result = await call('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', data: [[1, 2, 3, 4]] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('exactly 4 row(s), got 1');
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
  });

  it('refuses a new name that is not a valid name', async () => {
    const replace = vi.spyOn(writer, 'replaceFile');
    const result = await call('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', newName: '..' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Name must start with a letter');
    expect(result.text.endsWith(ENDING)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
  });

  it('refuses an unknown brush and an object type without a brush file', async () => {
    const unknown = await call('update_tilemap_brush', { objectName: 'Tiles', name: 'Nope', newName: 'X' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('has no brush named "Nope". Brushes: Brush 0.');
    const noFile = await call('update_tilemap_brush', { objectName: 'Walls', name: 'Brush 0', newName: 'X' });
    expect(noFile.isError).toBe(true);
    expect(noFile.text).toContain(`has no brush file (${WALLS_BRUSH_PATH})`);
    expect(noFile.text.endsWith(ENDING)).toBe(true);
  });
});

describe('delete_tilemap_brush', () => {
  it('removes a brush and keeps the file as an empty array', async () => {
    const result = await ok('delete_tilemap_brush', deleteArgs('Tiles'));
    expect(result.action).toBe('deleted');
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe('[]');
  });

  it('refuses an unknown brush and an object type without a brush file', async () => {
    const unknown = await call('delete_tilemap_brush', { objectName: 'Tiles', name: 'Nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('has no brush named "Nope"');
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
    const noFile = await call('delete_tilemap_brush', { objectName: 'Walls', name: 'Nope' });
    expect(noFile.isError).toBe(true);
    expect(noFile.text).toContain('has no brush file');
  });
});

describe('the object type', () => {
  it('refuses an object type name in another letter case, and an unknown one', async () => {
    const replace = vi.spyOn(writer, 'replaceFile');
    for (const [tool, args] of WRITE_TOOLS) {
      const result = await call(tool, args('tiles'));
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain('Did you mean "Tiles"?');
      expect(result.text, tool).toContain('letter case');
      expect(result.text.endsWith(ENDING), tool).toBe(true);
    }
    const unknown = await call('add_tilemap_brush', addArgs('Nope'));
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Object "Nope" not found');
    expect(unknown.text.endsWith(ENDING)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);

    const list = await call('list_tilemap_brushes', { objectName: 'tiles' });
    expect(list.isError).toBe(true);
    expect(list.text).toContain('Did you mean "Tiles"?');
    expect(list.text).not.toContain(ENDING);
  });

  it('refuses an object type it cannot read', async () => {
    vi.spyOn(reader, 'readObjectType').mockRejectedValue(new Error(`EIO: i/o error, read ${join(tmpDir, 'objectTypes', 'Tiles.json')} and ${tmpDir.replace(/\\/g, '/')}/objectTypes/Tiles.json`));
    const replace = vi.spyOn(writer, 'replaceFile');
    for (const [tool, args] of WRITE_TOOLS) {
      const result = await call(tool, args('Tiles'));
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain('Cannot read object type "Tiles"');
      expect(result.text.endsWith(ENDING), tool).toBe(true);
      expectNoFolder(result.text);
    }
    expect(replace).not.toHaveBeenCalled();
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
    const list = await call('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(list.isError).toBe(true);
    expect(list.text).toContain('Cannot read object type "Tiles"');
    expect(list.text).not.toContain(ENDING);
    expectNoFolder(list.text);
  });

  it('gives a non-Tilemap object type a warning, and still writes the brush', async () => {
    const list = await ok('list_tilemap_brushes', { objectName: 'Sprite' });
    expect(list.warnings).toEqual(['"Sprite" uses plugin "Sprite", not "Tilemap"; its brush file is listed anyway.']);
    const added = await ok('add_tilemap_brush', addArgs('Sprite'));
    expect(added.warnings).toEqual(['"Sprite" uses plugin "Sprite", not "Tilemap"; the brush file is written anyway.']);
    const path = brushFileRelativePath('Sprite', writer.getSubfolderForEntity('objectTypes', 'Sprite'));
    expect(JSON.parse(await brushBytes(path))).toEqual([{ name: 'New', type: 'auto16', data: AUTO16 }]);
  });
});

describe('where the brush file is', () => {
  it('puts the brush file of an object in a project-bar folder in that folder', async () => {
    const added = await ok('add_tilemap_brush', addArgs('Walls', 'Rim'));
    expect(added.entity).toBe('Walls/Rim');
    expect(brushFileRelativePath('Walls', 'Scenery')).toBe(WALLS_BRUSH_PATH);
    expect(JSON.parse(await brushBytes(WALLS_BRUSH_PATH))).toEqual([{ name: 'Rim', type: 'auto16', data: AUTO16 }]);

    // A folder path of two segments is two folders (the one-segment file is gone, so no second file is implied)
    await rm(at('tilemapBrushes/objectTypes/Scenery'), { recursive: true });
    vi.spyOn(writer, 'getSubfolderForEntity').mockReturnValue('A/B');
    await ok('add_tilemap_brush', addArgs('Walls', 'Deep'));
    expect(JSON.parse(await brushBytes('tilemapBrushes/objectTypes/A/B/Walls.brush.json'))).toEqual([{ name: 'Deep', type: 'auto16', data: AUTO16 }]);
  });

  it('uses the brush file the editor spelled in another letter case, never a second one', async () => {
    const dir = at('tilemapBrushes/objectTypes');
    await unlink(at(TILES_BRUSH_PATH));
    await writeFile(join(dir, 'tiles.brush.json'), BRUSH_0_TEXT);
    const list = await ok('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(list.file).toBe('tilemapBrushes/objectTypes/tiles.brush.json');
    expect(list.fileExists).toBe(true);
    await ok('add_tilemap_brush', addArgs('Tiles'));
    const names = (await readdir(dir)).filter(n => n.toLowerCase() === 'tiles.brush.json');
    expect(names).toEqual(['tiles.brush.json']);
    expect(JSON.parse(await readFile(join(dir, 'tiles.brush.json'), 'utf-8'))).toHaveLength(2);
  });

  it('creates the file and its folder when none exists', async () => {
    await expect(stat(at('tilemapBrushes/objectTypes/Scenery'))).rejects.toThrow();
    const listed = await ok('list_tilemap_brushes', { objectName: 'Walls' });
    expect(listed.fileExists).toBe(false);
    const added = await ok('add_tilemap_brush', addArgs('Walls'));
    expect(added.backupFile).toBeUndefined();
    expect((await stat(at('tilemapBrushes/objectTypes/Scenery'))).isDirectory()).toBe(true);
    expect(await brushBytes(WALLS_BRUSH_PATH)).toBe(JSON.stringify([{ name: 'New', type: 'auto16', data: AUTO16 }]));
  });

  it('reports a brush file named after the object in another folder, never doubled', async () => {
    const other = 'tilemapBrushes/objectTypes/Old/Walls.brush.json';
    await put(other, '[{"name":"Old","type":"auto16","data":' + JSON.stringify(AUTO16) + '}]');
    const list = await ok('list_tilemap_brushes', { objectName: 'Walls' });
    expect(list.fileExists).toBe(false);
    expect(list.brushes).toEqual([]);
    expect(list.warnings?.join(' ')).toContain(other);
    await expectWriteRefusals('Walls', other, [other]);
    await expect(stat(at('tilemapBrushes/objectTypes/Scenery'))).rejects.toThrow();

    // With a file of its own, that one is used and the other is a warning
    await put(WALLS_BRUSH_PATH, BRUSH_0_TEXT);
    const both = await ok('list_tilemap_brushes', { objectName: 'Walls' });
    expect(both.fileExists).toBe(true);
    expect(both.brushes).toEqual([{ index: 0, name: 'Brush 0', type: 'auto16', size: '4x4' }]);
    expect(both.warnings).toEqual([`Another brush file is named after "Walls": ${other}; it is not used.`]);
    const added = await ok('add_tilemap_brush', addArgs('Walls'));
    expect(added.warnings).toEqual([`Another brush file is named after "Walls": ${other}; it is not used.`]);
    expect(JSON.parse(await brushBytes(WALLS_BRUSH_PATH))).toHaveLength(2);
    expect(JSON.parse(await brushBytes(other))).toHaveLength(1);
  });

  it('does not take an incomplete search for a brush file elsewhere as proof that none exists', async () => {
    const deep = 'tilemapBrushes/a/b/c/d/e/f/g/h/i/';
    // (a) a file past the depth limit, none in the own folder
    await put(`${deep}Walls.brush.json`, '[]');
    const list = await ok('list_tilemap_brushes', { objectName: 'Walls' });
    expect(list.fileExists).toBe(false);
    expect(list.warnings?.join(' ')).toContain('was not complete');
    const replace = vi.spyOn(writer, 'replaceFile');
    for (const [tool, args] of WRITE_TOOLS) {
      const result = await call(tool, args('Walls'));
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain('cannot be ruled out');
      expect(result.text.endsWith(ENDING), tool).toBe(true);
    }
    expect(replace).not.toHaveBeenCalled();
    await expect(stat(at('tilemapBrushes/objectTypes/Scenery'))).rejects.toThrow();
    replace.mockRestore();

    // (b) the same project without the deep file: the search is complete and the file is created
    await rm(at('tilemapBrushes/a'), { recursive: true });
    await ok('add_tilemap_brush', addArgs('Walls'));
    expect(JSON.parse(await brushBytes(WALLS_BRUSH_PATH))).toHaveLength(1);

    // (c) an own file present and an unrelated file past the depth limit
    await put(`${deep}x.brush.json`, '[]');
    const own = await ok('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(own.warnings).toEqual(['The search below tilemapBrushes/ for other brush files named after "Tiles" was not complete.']);
    await ok('add_tilemap_brush', addArgs('Tiles'));
    expect(JSON.parse(await brushBytes(TILES_BRUSH_PATH))).toHaveLength(2);
  });

  it('reports a search that stopped at its entry limit or could not read a folder as incomplete', async () => {
    await rm(at('tilemapBrushes'), { recursive: true });
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'Walls.brush.json']) await put(`tilemapBrushes/${name}`, '[]');
    const own = { path: at(WALLS_BRUSH_PATH), label: WALLS_BRUSH_PATH };
    const sorted = async (dir: string): Promise<Dirent[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.sort((x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : 1));
    };
    // (d) the entry limit: the matching file is the sixth entry
    expect(await brushFilesElsewhere(tmpDir, 'Walls', own, { maxEntries: 3, maxDepth: 8, readDir: sorted }))
      .toEqual({ found: [], complete: false });
    expect(await brushFilesElsewhere(tmpDir, 'Walls', own, { maxEntries: 100, maxDepth: 8, readDir: sorted }))
      .toEqual({ found: ['tilemapBrushes/Walls.brush.json'], complete: true });

    // (e) a folder that cannot be read
    await put('tilemapBrushes/sub/q.txt', 'q');
    const refuse = async (dir: string): Promise<Dirent[]> => {
      if (dir.endsWith('sub')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return readdir(dir, { withFileTypes: true });
    };
    const unreadable = await brushFilesElsewhere(tmpDir, 'Walls', own, { maxEntries: 100, maxDepth: 8, readDir: refuse });
    expect(unreadable.complete).toBe(false);
    await rm(at('tilemapBrushes'), { recursive: true });
    expect(await brushFilesElsewhere(tmpDir, 'Walls', own)).toEqual({ found: [], complete: true });
  });
});

describe('the brush file text and what is read', () => {
  it('keeps the text style and BOM of an existing file, and writes a new one compact', async () => {
    const styled = (brushes: unknown[]) => '\uFEFF' + JSON.stringify(brushes, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
    await writeFile(at(TILES_BRUSH_PATH), styled([BRUSH_0]));
    await ok('add_tilemap_brush', addArgs('Tiles'));
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(styled([BRUSH_0, { name: 'New', type: 'auto16', data: AUTO16 }]));
    await ok('add_tilemap_brush', addArgs('Walls'));
    expect(await brushBytes(WALLS_BRUSH_PATH)).toBe(JSON.stringify([{ name: 'New', type: 'auto16', data: AUTO16 }]));
  });

  it('refuses a brush file that is not an array, holds an entry that is not a brush, is not JSON, or cannot be read', async () => {
    const cases: Array<[string, string]> = [
      ['{"a":1}', 'is not a JSON array'],
      ['[null]', 'entry 0 is not a brush with a string name'],
      ['[{"type":"auto16"}]', 'entry 0 is not a brush with a string name'],
      ['{ broken', 'is not valid JSON'],
    ];
    for (const [text, part] of cases) {
      await writeFile(at(TILES_BRUSH_PATH), text);
      await expectWriteRefusals('Tiles', TILES_BRUSH_PATH, [part, TILES_BRUSH_PATH]);
      const list = await call('list_tilemap_brushes', { objectName: 'Tiles' });
      expect(list.isError).toBe(true);
      expect(list.text).toContain(part);
      expect(list.text).toContain(TILES_BRUSH_PATH);
      expect(list.text).not.toContain(ENDING);
      expectNoFolder(list.text);
    }

    // A directory where the file should be
    await unlink(at(TILES_BRUSH_PATH));
    await mkdir(at(TILES_BRUSH_PATH));
    const replace = vi.spyOn(writer, 'replaceFile');
    for (const [tool, args] of WRITE_TOOLS) {
      const result = await call(tool, args('Tiles'));
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain('EISDIR');
      expect(result.text, tool).toContain(TILES_BRUSH_PATH);
      expect(result.text.endsWith(ENDING), tool).toBe(true);
      expectNoFolder(result.text);
    }
    expect(replace).not.toHaveBeenCalled();
    expect((await stat(at(TILES_BRUSH_PATH))).isDirectory()).toBe(true);
    const list = await call('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(list.isError).toBe(true);
    expect(list.text).toContain('EISDIR');
    expect(list.text).not.toContain(ENDING);
  });

  it('refuses a brush file over the size limit', async () => {
    const size = 10 * 1024 * 1024 + 1;
    await writeFile(at(TILES_BRUSH_PATH), '[]' + ' '.repeat(size - 2));
    const replace = vi.spyOn(writer, 'replaceFile');
    for (const [tool, args] of WRITE_TOOLS) {
      const result = await call(tool, args('Tiles'));
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain('too large');
      expect(result.text.endsWith(ENDING), tool).toBe(true);
      expectNoFolder(result.text);
    }
    expect(replace).not.toHaveBeenCalled();
    expect((await stat(at(TILES_BRUSH_PATH))).size).toBe(size);
    const list = await call('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(list.text).toContain('too large');
    expect(list.text).not.toContain(ENDING);
  });
});

describe('what a call changes', () => {
  it('writes nothing for a call that changes nothing', async () => {
    const replace = vi.spyOn(writer, 'replaceFile');
    const same = await ok('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', newName: 'Brush 0' });
    expect(same.action).toBe('unchanged');
    expect(same.editorNote).toBeUndefined();
    const sameData = await ok('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', data: AUTO16 });
    expect(sameData.action).toBe('unchanged');
    expect(replace).not.toHaveBeenCalled();
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
    const none = await call('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('No updates provided');
    expect(none.text.endsWith(ENDING)).toBe(true);
  });

  it('refuses a brush name that differs only in case from an existing one, and names the registered spelling', async () => {
    const add = await call('add_tilemap_brush', addArgs('Tiles', 'brush 0'));
    expect(add.isError).toBe(true);
    expect(add.text).toContain('"Brush 0"');
    expect(add.text.endsWith(ENDING)).toBe(true);
    for (const [tool, args] of [
      ['update_tilemap_brush', { objectName: 'Tiles', name: 'brush 0', newName: 'X' }],
      ['delete_tilemap_brush', { objectName: 'Tiles', name: 'brush 0' }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain('Did you mean "Brush 0"?');
      expect(result.text.endsWith(ENDING), tool).toBe(true);
    }
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);

    await ok('add_tilemap_brush', addArgs('Tiles', 'Brush 1'));
    const rename1 = await call('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 1', newName: 'brush 0' });
    expect(rename1.isError).toBe(true);
    expect(rename1.text).toContain('"Brush 0"');
    expect(rename1.text.endsWith(ENDING)).toBe(true);

    // A brush may change the letter case of its own name
    const own = await ok('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0', newName: 'brush 0' });
    expect(own.action).toBe('updated');
    expect(JSON.parse(await brushBytes(TILES_BRUSH_PATH)).map((b: { name: string }) => b.name)).toEqual(['brush 0', 'Brush 1']);
  });

  it('writes once per call, backing the file up once', async () => {
    const replace = vi.spyOn(writer, 'replaceFile');
    await ok('add_tilemap_brush', addArgs('Tiles', 'One'));
    expect(replace).toHaveBeenCalledTimes(1);
    const afterFirst = await brushBytes(TILES_BRUSH_PATH);
    expect(await brushBytes(`${TILES_BRUSH_PATH}.bak`)).toBe(BRUSH_0_TEXT);
    await ok('add_tilemap_brush', addArgs('Tiles', 'Two'));
    expect(replace).toHaveBeenCalledTimes(2);
    expect(await brushBytes(`${TILES_BRUSH_PATH}.bak`)).toBe(afterFirst);
  });
});

describe('a write that goes wrong', () => {
  it('leaves the editor\'s file when it was saved after the read', async () => {
    const editorText = JSON.stringify([BRUSH_0, { name: 'Editor brush', type: 'auto16', data: AUTO16 }]);
    wrapReplaceFile(async (path, original) => {
      await writeFile(path, editorText);
      return original();
    });
    const result = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${TILES_BRUSH_PATH} was changed on disk after this server read it`);
    expect(result.text).toContain('It was not written, so that change is kept.');
    // The writer's wording stands alone: no second account of the file's state is added to it
    expect(result.text).not.toContain('before the call');
    expect(result.text.endsWith('Run the tool again: it reads the file as it is now.')).toBe(true);
    expectNoFolder(result.text);
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(editorText);
    await expect(stat(at(`${TILES_BRUSH_PATH}.bak`))).rejects.toThrow();
  });

  it('names the state of the file after a failed write', async () => {
    const bak = `${TILES_BRUSH_PATH}.bak`;
    const failWith = (message: string, after?: (path: string) => Promise<void>) => wrapReplaceFile(async (path, original) => {
      await original();
      if (after) await after(path);
      throw new Error(message);
    });

    // (a) the writer fails before it writes: the file is as it was read
    const folderForms = `${join(tmpDir, 'x')} ${tmpDir.replace(/\\/g, '/')}/x`;
    const before = wrapReplaceFile(async () => { throw new Error(`EBUSY ${folderForms}`); });
    const a = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(a.isError).toBe(true);
    expect(a.text).toContain('EBUSY');
    expect(a.text.endsWith(ENDING)).toBe(true);
    expectNoFolder(a.text);
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
    before.mockRestore();

    // A cause that ends in full stops does not double them before the ending
    const dots = wrapReplaceFile(async () => { throw new Error('EBUSY...'); });
    const dotted = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(dotted.text).toBe(`EBUSY. ${ENDING}`);
    dots.mockRestore();

    // (b) the write happened, then the call failed: the file holds the new list
    let spy = failWith('read-back failed');
    const b = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(b.isError).toBe(true);
    expect(b.text).toContain('read-back failed');
    expect(b.text).toContain(`${TILES_BRUSH_PATH} holds the new brush list`);
    expect(b.text).toContain(bak);
    expectNoFolder(b.text);
    spy.mockRestore();
    const walls = failWith('read-back failed');
    const bWalls = await call('add_tilemap_brush', addArgs('Walls'));
    expect(bWalls.text).toContain('it did not exist before the call');
    expect(bWalls.text).not.toContain('.bak');
    walls.mockRestore();
    await rm(at(WALLS_BRUSH_PATH), { force: true });
    await put(TILES_BRUSH_PATH, BRUSH_0_TEXT);
    await rm(at(bak), { force: true });

    // (c) another content was written after the call's own
    spy = failWith('late write', path => writeFile(path, 'other text'));
    const c = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(c.text).toContain(`${TILES_BRUSH_PATH} is not as it was before the call`);
    expect(c.text).toContain(bak);
    spy.mockRestore();
    await put(TILES_BRUSH_PATH, BRUSH_0_TEXT);
    await rm(at(bak), { force: true });

    // (d) the backup was replaced by another call's
    spy = failWith('read-back failed', path => writeFile(`${path}.bak`, 'another call\'s backup'));
    const d = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(d.text).toContain('the state from before the call is not known');
    expect(d.text).not.toContain('.bak');
    spy.mockRestore();
    await put(TILES_BRUSH_PATH, BRUSH_0_TEXT);
    await rm(at(bak), { force: true });

    // (e) the file is gone
    spy = failWith('removed', path => unlink(path));
    const e = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(e.text).toContain(`${TILES_BRUSH_PATH} is missing`);
    expect(e.text).toContain(bak);
    spy.mockRestore();
    await put(TILES_BRUSH_PATH, BRUSH_0_TEXT);
    await rm(at(bak), { force: true });

    // (f) a directory took its place
    spy = failWith('replaced', async path => { await unlink(path); await mkdir(path); });
    const f = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(f.text).toContain(`${TILES_BRUSH_PATH} cannot be read now (EISDIR)`);
    spy.mockRestore();
  });

  it('names what a failed write left beside a file that is as before', async () => {
    const bak = `${TILES_BRUSH_PATH}.bak`;

    // The file holds its old text again, but this call's backup is on disk
    let spy = wrapReplaceFile(async (path, original) => {
      await original();
      await writeFile(path, BRUSH_0_TEXT);
      throw new Error('put back');
    });
    const kept = await call('add_tilemap_brush', addArgs('Tiles'));
    expect(kept.isError).toBe(true);
    expect(kept.text).toContain(`${TILES_BRUSH_PATH} is as it was before the call; ${bak} was made by this call.`);
    expect(kept.text).not.toContain(ENDING);
    expectNoFolder(kept.text);
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
    spy.mockRestore();

    // A new file is gone again, but the folder made for it is not
    const folder = WALLS_BRUSH_PATH.slice(0, WALLS_BRUSH_PATH.lastIndexOf('/'));
    await expect(stat(at(folder))).rejects.toThrow();
    spy = wrapReplaceFile(async (path, original) => {
      await original();
      await unlink(path);
      throw new Error('removed again');
    });
    const created = await call('add_tilemap_brush', addArgs('Walls'));
    expect(created.isError).toBe(true);
    expect(created.text).toContain(`${WALLS_BRUSH_PATH} is as it was before the call; the folder ${folder} was created by this call.`);
    expect(created.text).not.toContain(ENDING);
    expectNoFolder(created.text);
    spy.mockRestore();
  });
});

describe('the project file', () => {
  it('reads project.c3proj fresh each call', async () => {
    await ok('list_tilemap_brushes', { objectName: 'Tiles' });
    const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')) as { objectTypes: { items: string[] } };
    project.objectTypes.items.push('Rocks');
    await writeFile(join(tmpDir, 'project.c3proj'), JSON.stringify(project, null, '\t') + '\n');
    const tiles = JSON.parse(await readFile(join(tmpDir, 'objectTypes', 'Tiles.json'), 'utf-8')) as { name: string; sid: number };
    await writeFile(join(tmpDir, 'objectTypes', 'Rocks.json'), JSON.stringify({ ...tiles, name: 'Rocks', sid: 479915495843003 }, null, '\t'));
    await ok('add_tilemap_brush', addArgs('Rocks'));
    expect(JSON.parse(await brushBytes('tilemapBrushes/objectTypes/Rocks.brush.json'))).toHaveLength(1);
  });

  it('words a failing project check by the module\'s policy', async () => {
    vi.spyOn(reader, 'checkProjectFile').mockRejectedValue(new Error(`bad ${join(tmpDir, 'project.c3proj')} and ${tmpDir.replace(/\\/g, '/')}/project.c3proj`));
    const replace = vi.spyOn(writer, 'replaceFile');
    for (const [tool, args] of WRITE_TOOLS) {
      const result = await call(tool, args('Tiles'));
      expect(result.isError, tool).toBe(true);
      expect(result.text.startsWith('The change was stopped before anything was written:'), tool).toBe(true);
      expect(result.text.endsWith(ENDING), tool).toBe(true);
      expectNoFolder(result.text);
    }
    expect(replace).not.toHaveBeenCalled();
    expect(await brushBytes(TILES_BRUSH_PATH)).toBe(BRUSH_0_TEXT);
    const list = await call('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(list.isError).toBe(true);
    expectNoFolder(list.text);
    expect(list.text).not.toContain(ENDING);
  });
});

describe('absolute paths', () => {
  it('never appear in a refusal', async () => {
    const withFolder = new Error(`EIO ${join(tmpDir, 'objectTypes')} ${tmpDir.replace(/\\/g, '/')}/objectTypes`);
    vi.spyOn(reader, 'listObjectTypes').mockRejectedValue(withFolder);
    for (const [tool, args] of WRITE_TOOLS) {
      const result = await call(tool, args('Tiles'));
      expect(result.isError, tool).toBe(true);
      expect(result.text.startsWith('The change was stopped before anything was written:'), tool).toBe(true);
      expect(result.text.endsWith(ENDING), tool).toBe(true);
      expectNoFolder(result.text);
    }
    const list = await call('list_tilemap_brushes', { objectName: 'Tiles' });
    expect(list.isError).toBe(true);
    expect(list.text).toContain('Error listing tilemap brushes');
    expectNoFolder(list.text);
  });
});

