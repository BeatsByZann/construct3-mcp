/**
 * Real-reader/writer tests for the tilemap brush tools against a temp copy of
 * `test/fixtures/rename-project`, which registers the Tilemap object type
 * `Tiles` at the objectTypes root with one `auto16` brush already on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTilemapBrushTools } from '../../src/tools/tilemap-brush-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

const auto16 = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [8, 9, 10, 11],
  [12, 13, 14, null],
];

let tmpDir: string;
let server: MockServer;

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function brushes(...segments: string[]): Promise<any[]> {
  const path = segments.length > 0
    ? join(tmpDir, ...segments)
    : join(tmpDir, 'tilemapBrushes', 'objectTypes', 'Tiles.brush.json');
  return JSON.parse(await readFile(path, 'utf-8'));
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-brush-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });

  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerTilemapBrushTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('list_tilemap_brushes', () => {
  it('lists the brushes on disk with their grid size', async () => {
    const result = parseResult(await server.callTool('list_tilemap_brushes', { objectName: 'Tiles' }));
    expect(result.file).toBe('tilemapBrushes/objectTypes/Tiles.brush.json');
    expect(result.fileExists).toBe(true);
    expect(result.brushes).toEqual([{ index: 0, name: 'Brush 0', type: 'auto16', size: '4x4' }]);
    expect(result.warnings).toBeUndefined();
  });

  it('reports an empty list and warns for a non-tilemap object type', async () => {
    const result = parseResult(await server.callTool('list_tilemap_brushes', { objectName: 'Player' }));
    expect(result.fileExists).toBe(false);
    expect(result.count).toBe(0);
    expect(result.warnings.join(' ')).toContain('not "Tilemap"');
  });

  it('rejects an unknown object type', async () => {
    const result = await server.callTool('list_tilemap_brushes', { objectName: 'Nope' });
    expect(result.isError).toBe(true);
  });
});

describe('add_tilemap_brush', () => {
  it('appends a brush and keeps the existing ones', async () => {
    const result = parseResult(await server.callTool('add_tilemap_brush', {
      objectName: 'Tiles',
      name: 'Patchy',
      type: 'patch',
      data: { width: 2, height: 2, data: [[1, 2], [3, [{ index: 4, probability: 0.5 }]]] },
    }));
    expect(result.success).toBe(true);
    expect(result.action).toBe('created');

    const list = await brushes();
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({
      name: 'Patchy',
      type: 'patch',
      data: { width: 2, height: 2, data: [[1, 2], [3, [{ index: 4, probability: 0.5 }]]] },
    });
    await expect(stat(join(tmpDir, 'tilemapBrushes', 'objectTypes', 'Tiles.brush.json.bak'))).resolves.toBeDefined();
  });

  it('creates the brush file when it does not exist yet, mirroring the object subfolder', async () => {
    const result = parseResult(await server.callTool('add_tilemap_brush', {
      objectName: 'Player', name: 'Odd', type: 'auto16', data: auto16,
    }));
    expect(result.success).toBe(true);
    const list = await brushes('tilemapBrushes', 'objectTypes', 'Actors', 'Player.brush.json');
    expect(list).toEqual([{ name: 'Odd', type: 'auto16', data: auto16 }]);
  });

  /**
   * Revert check (e): dropping the grid-size validation lets this through.
   */
  it('rejects a grid of the wrong size', async () => {
    const result = await server.callTool('add_tilemap_brush', {
      objectName: 'Tiles', name: 'Bad', type: 'auto16', data: auto16.slice(0, 3),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly 4 row(s), got 3');
    expect(await brushes()).toHaveLength(1);

    const wrongType = await server.callTool('add_tilemap_brush', {
      objectName: 'Tiles', name: 'Bad47', type: 'auto47', data: auto16,
    });
    expect(wrongType.isError).toBe(true);
    expect(await brushes()).toHaveLength(1);
  });

  it('refuses a duplicate brush name and an invalid name', async () => {
    const duplicate = await server.callTool('add_tilemap_brush', {
      objectName: 'Tiles', name: 'Brush 0', type: 'auto16', data: auto16,
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toContain('already has a brush named');

    const invalid = await server.callTool('add_tilemap_brush', {
      objectName: 'Tiles', name: '..', type: 'auto16', data: auto16,
    });
    expect(invalid.isError).toBe(true);
    expect(await brushes()).toHaveLength(1);
  });
});

describe('update_tilemap_brush', () => {
  it('renames a brush and replaces its data', async () => {
    const renamed = parseResult(await server.callTool('update_tilemap_brush', {
      objectName: 'Tiles', name: 'Brush 0', newName: 'Ground',
    }));
    expect(renamed.action).toBe('updated');
    expect((await brushes())[0].name).toBe('Ground');

    const replaced = auto16.map(row => row.map(cell => (cell === null ? null : 99)));
    await server.callTool('update_tilemap_brush', { objectName: 'Tiles', name: 'Ground', data: replaced });
    expect((await brushes())[0].data).toEqual(replaced);
  });

  it('changes the type only with matching data', async () => {
    const noData = await server.callTool('update_tilemap_brush', {
      objectName: 'Tiles', name: 'Brush 0', type: 'auto47',
    });
    expect(noData.isError).toBe(true);
    expect(noData.content[0].text).toContain('requires new data');

    const mismatched = await server.callTool('update_tilemap_brush', {
      objectName: 'Tiles', name: 'Brush 0', type: 'auto47', data: auto16,
    });
    expect(mismatched.isError).toBe(true);

    const ok = parseResult(await server.callTool('update_tilemap_brush', {
      objectName: 'Tiles',
      name: 'Brush 0',
      type: 'patch',
      data: { width: 1, height: 1, data: [[7]] },
    }));
    expect(ok.success).toBe(true);
    expect((await brushes())[0]).toEqual({ name: 'Brush 0', type: 'patch', data: { width: 1, height: 1, data: [[7]] } });
  });

  it('validates replacement data against the current type', async () => {
    const result = await server.callTool('update_tilemap_brush', {
      objectName: 'Tiles', name: 'Brush 0', data: [[1, 2, 3, 4]],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly 4 row(s), got 1');
  });

  it('refuses no-op calls, unknown brushes, missing files and name clashes', async () => {
    const noUpdates = await server.callTool('update_tilemap_brush', { objectName: 'Tiles', name: 'Brush 0' });
    expect(noUpdates.isError).toBe(true);
    expect(noUpdates.content[0].text).toContain('No updates provided');

    const unknown = await server.callTool('update_tilemap_brush', {
      objectName: 'Tiles', name: 'Nope', newName: 'X',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('Brushes: Brush 0');

    const noFile = await server.callTool('update_tilemap_brush', {
      objectName: 'Player', name: 'Brush 0', newName: 'X',
    });
    expect(noFile.isError).toBe(true);
    expect(noFile.content[0].text).toContain('has no brush file');

    await server.callTool('add_tilemap_brush', { objectName: 'Tiles', name: 'Second', type: 'auto16', data: auto16 });
    const clash = await server.callTool('update_tilemap_brush', {
      objectName: 'Tiles', name: 'Second', newName: 'Brush 0',
    });
    expect(clash.isError).toBe(true);
  });
});

describe('delete_tilemap_brush', () => {
  it('removes a brush and keeps the file as an empty array', async () => {
    const result = parseResult(await server.callTool('delete_tilemap_brush', {
      objectName: 'Tiles', name: 'Brush 0',
    }));
    expect(result.action).toBe('deleted');
    expect(await brushes()).toEqual([]);
  });

  it('refuses an unknown brush and a missing file', async () => {
    const unknown = await server.callTool('delete_tilemap_brush', { objectName: 'Tiles', name: 'Nope' });
    expect(unknown.isError).toBe(true);
    expect(await brushes()).toHaveLength(1);

    const noFile = await server.callTool('delete_tilemap_brush', { objectName: 'Player', name: 'Nope' });
    expect(noFile.isError).toBe(true);
    expect(noFile.content[0].text).toContain('has no brush file');
  });
});
