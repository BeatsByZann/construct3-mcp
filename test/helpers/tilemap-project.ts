/**
 * A temp project for the tilemap tools: a copy of test/fixtures/minimal-project
 * (never changed itself) with the Tilemap plugin, two Tilemap object types
 * (`Tiles` at the root, `Walls` in the project-bar folder "Scenery") and, on
 * the first layout, a Tiles instance with tile data (UID 900) and one
 * without (UID 901).
 */

import { cp, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { encodeTileData, rowsToCells, type TileValue } from '../../src/construct3/tilemap-data.js';

export const PAINTED_UID = 900;
export const BARE_UID = 901;
/** The Sprite instance of minimal-project's Layout 1. */
export const SPRITE_UID = 0;
/** The painted instance's grid: 4 columns by 2 rows, rows[y][x]. */
export const PAINTED_ROWS: TileValue[][] = [[0, 1, 1, 2], [null, { tile: 3, flipX: true }, 3, 3]];
/** PAINTED_ROWS as stored, written out by hand: column-major, index + 1, 0 for empty. */
export const PAINTED_DATA = '1,0,2,4h,2,4,3,4';
export const WALLS_BRUSH_PATH = 'tilemapBrushes/objectTypes/Scenery/Walls.brush.json';
export const TILES_BRUSH_PATH = 'tilemapBrushes/objectTypes/Tiles.brush.json';

const FIXTURE = join(__dirname, '..', 'fixtures', 'minimal-project');

/** The object type file of a Tilemap object type. */
function tilemapObjectType(name: string, sid: number) {
  return {
    name, 'plugin-id': 'Tilemap', sid, isGlobal: false, editorNewInstanceIsReplica: true,
    instanceVariables: [], behaviorTypes: [], effectTypes: [],
    image: { width: 64, height: 64, originX: 0.5, originY: 0.5, originalSource: '', exportFormat: 'lossless', exportQuality: 0.8, fileType: 'image/png', imageSpriteId: sid % 100000, useCollisionPoly: true, tag: '' },
    'tile-collision-polys': {},
  };
}

/** A Tilemap instance of 4x2 cells of 16 pixels, with `data` as its tile data when given. */
function instance(uid: number, type: string, data?: string) {
  return {
    type, uid, sid: 690000000000000 + uid, tags: '', instanceVariables: {}, behaviors: {}, showing: true, locked: false,
    properties: { 'initially-visible': true, 'tile-width': 16, 'tile-height': 16 },
    ...(data === undefined ? {} : {
      ownData: { tilemapData: { width: 4, height: 2, 'max-width': 4, 'max-height': 2, data }, 'tile-width': 16, 'tile-height': 16 },
    }),
    world: { x: 0, y: 0, width: 64, height: 32, originX: 0, originY: 0, color: [1, 1, 1, 1], z: 0 },
  };
}

/** Copy minimal-project to `dir` and add the Tilemap objects and instances. */
export async function makeTilemapProject(dir: string): Promise<void> {
  await cp(FIXTURE, dir, { recursive: true });
  const projectPath = join(dir, 'project.c3proj');
  const project = JSON.parse(await readFile(projectPath, 'utf-8'));
  project.usedAddons.push({ type: 'plugin', id: 'Tilemap', name: 'Tilemap', author: 'Scirra', bundled: false });
  project.objectTypes.items.push('Tiles');
  project.objectTypes.subfolders.push({ items: ['Walls'], subfolders: [], name: 'Scenery' });
  await writeFile(projectPath, JSON.stringify(project, null, '\t'));
  await writeFile(join(dir, 'objectTypes', 'Tiles.json'), JSON.stringify(tilemapObjectType('Tiles', 479915495843001), null, '\t'));
  await mkdir(join(dir, 'objectTypes', 'Scenery'), { recursive: true });
  await writeFile(join(dir, 'objectTypes', 'Scenery', 'Walls.json'), JSON.stringify(tilemapObjectType('Walls', 479915495843002), null, '\t'));
  const layoutPath = join(dir, 'layouts', 'Layout 1.json');
  const layout = JSON.parse(await readFile(layoutPath, 'utf-8'));
  const data = encodeTileData(rowsToCells(PAINTED_ROWS));
  if (data !== PAINTED_DATA) throw new Error(`PAINTED_ROWS encodes to ${data}, not ${PAINTED_DATA}`);
  layout.layers[0].instances.push(instance(PAINTED_UID, 'Tiles', data), instance(BARE_UID, 'Tiles'));
  await writeFile(layoutPath, JSON.stringify(layout, null, '\t'));
}
