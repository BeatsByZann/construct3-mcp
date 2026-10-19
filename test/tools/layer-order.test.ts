/**
 * reorder_layers, move_layer and move_instance (#ISSUE): the order of a
 * layout's layers and of a layer's sub-layers, a layer moved to another
 * level of the layer tree, and an instance moved to another layer or place
 * in its layer's instances. Every refusal changes nothing, an unchanged
 * result writes nothing, and a failed write is rolled back. Synthetic data
 * on a temp copy of the minimal fixture, with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayerOrderTools } from '../../src/tools/layer-order.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface InstanceJson { type: string; uid: number; sid: number; world?: Record<string, number>; [key: string]: unknown }
interface LayerJson { name: string; sid: number; instances: InstanceJson[]; subLayers: LayerJson[]; [key: string]: unknown }
interface LayoutFile { name: string; layers: LayerJson[]; 'nonworld-instances'?: InstanceJson[]; [key: string]: unknown }
interface ToolData {
  isError?: boolean; text?: string; success?: boolean; action?: string; editorNote?: string; warnings?: string[];
  order?: string[]; from?: unknown; to?: unknown; fromLayer?: string; fromIndex?: number; toLayer?: string; toIndex?: number;
  layerInstanceCount?: number; [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const readLayout = async (): Promise<LayoutFile> => JSON.parse(await readFile(layoutPath(), 'utf8')) as LayoutFile;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, { layoutName: 'Layout 1', ...args });
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};

function layer(name: string, sid: number, instances: InstanceJson[] = [], subLayers: LayerJson[] = []): LayerJson {
  return { name, sid, instances, subLayers, isInitiallyVisible: true };
}
function sprite(uid: number): InstanceJson {
  return { type: 'Sprite', uid, sid: 560000000000000 + uid, properties: {}, instanceVariables: {}, behaviors: {}, world: { x: uid, y: 0, width: 8, height: 8 } };
}
const names = (layers: LayerJson[] | undefined) => (layers ?? []).map(l => l.name);
/** The layer at this path of names, from the layout's own layers down. */
function at(layers: LayerJson[], path: string[]): LayerJson {
  const [first, ...rest] = path;
  const found = layers.find(l => l.name === first);
  if (!found) throw new Error(`no layer ${first}`);
  return rest.length === 0 ? found : at(found.subLayers, rest);
}
const uidsOn = async (...path: string[]) => at((await readLayout()).layers, path).instances.map(i => i.uid);
const layoutFiles = async () => (await readdir(join(tmpDir, 'layouts'))).sort();

/**
 * Layout 1: Back; Main (UIDs 0, 1, 2) with sub-layers HUD (UID 3) and
 * Overlay (sub-layers Top and Under); Front; a non-world instance UID 9.
 */
async function setupLayers(): Promise<void> {
  const layout = await readLayout();
  layout.layers = [
    layer('Back', 550000000000001),
    layer('Main', 500000000000001, [sprite(0), sprite(1), sprite(2)], [
      layer('HUD', 550000000000002, [sprite(3)]),
      layer('Overlay', 550000000000003, [], [layer('Top', 550000000000004), layer('Under', 550000000000006)]),
    ]),
    layer('Front', 550000000000005),
  ];
  layout['nonworld-instances'] = [{ type: 'Sprite', uid: 9, sid: 560000000000009, properties: {} }];
  await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
  await reader.loadProject();
}

/** The writer's read-back of the layout fails once; `before` runs first (an editor save, say). */
function failLayoutReadBack(before: () => Promise<void> = async () => {}): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  internals.verifyWrittenFile = async (path, name, text) => {
    if (!failed && path.endsWith('Layout 1.json')) {
      failed = true;
      await before();
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(path, name, text);
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-layer-order-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayerOrderTools({ server, reader, writer, idGen } as never);
  await setupLayers();
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('reorder_layers', () => {
  it('puts the layout\'s own layers in the new order, each with its sub-layers', async () => {
    const data = await call('reorder_layers', { layerNames: ['Front', 'Back', 'Main'] });
    expect(data.action).toBe('updated');
    expect(data.order).toEqual(['Front', 'Back', 'Main']);
    expect(data.editorNote).toBeDefined();
    const layout = await readLayout();
    expect(names(layout.layers)).toEqual(['Front', 'Back', 'Main']);
    expect(names(at(layout.layers, ['Main']).subLayers)).toEqual(['HUD', 'Overlay']);
  });

  it('reorders the sub-layers of a layer given by its path', async () => {
    const data = await call('reorder_layers', { parentLayer: 'Main > Overlay', layerNames: ['Under', 'Top'] });
    expect(data.parentLayer).toBe('Main > Overlay');
    expect(names(at((await readLayout()).layers, ['Main', 'Overlay']).subLayers)).toEqual(['Under', 'Top']);
  });

  it('refuses a list that leaves out, repeats or adds a layer, and changes nothing', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    const missing = await call('reorder_layers', { layerNames: ['Front', 'Back'] });
    expect(missing.text).toContain('layerNames must list every layer of layout "Layout 1" exactly once (missing: "Main")');
    const twice = await call('reorder_layers', { layerNames: ['Front', 'Back', 'Main', 'Back'] });
    expect(twice.text).toContain('listed more than once: "Back"');
    const other = await call('reorder_layers', { layerNames: ['Front', 'Back', 'Main', 'HUD'] });
    expect(other.text).toContain('not at this level: "HUD"');
    for (const data of [missing, twice, other]) {
      expect(data.isError).toBe(true);
      expect(data.text).toContain('Current order, first to last: "Back", "Main", "Front". Nothing was changed.');
    }
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('reports the order it already has as unchanged and writes nothing', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    const filesBefore = await layoutFiles();
    const data = await call('reorder_layers', { layerNames: ['Back', 'Main', 'Front'] });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
    expect(await layoutFiles()).toEqual(filesBefore);
  });

  it('refuses a level whose layers share a name instead of merging them, and changes nothing', async () => {
    // Top, Under, Top: listing Under and Top passes the permutation check and, without the refusal, would drop one Top and its instances
    const layout = await readLayout();
    at(layout.layers, ['Main', 'Overlay']).subLayers.push(layer('Top', 550000000000008, [sprite(5)]));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const before = await readFile(layoutPath(), 'utf8');
    const filesBefore = await layoutFiles();
    const data = await call('reorder_layers', { parentLayer: 'Overlay', layerNames: ['Under', 'Top'] });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('cannot be told apart by name (repeated: "Top"); rename them first with update_layer. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
    expect(await layoutFiles()).toEqual(filesBefore);
  });

  it('prints (none) as the current order of a level with no layers', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('reorder_layers', { parentLayer: 'HUD', layerNames: ['Top'] });
    expect(data.text).toContain('Current order, first to last: (none). Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });
});

describe('move_layer', () => {
  it('moves a layer into another layer\'s sub-layers at an index', async () => {
    const data = await call('move_layer', { layerName: 'Front', parentLayer: 'Main', index: 0 });
    expect(data.from).toEqual({ parentLayer: null, index: 2 });
    expect(data.to).toEqual({ parentLayer: 'Main', index: 0 });
    const layout = await readLayout();
    expect(names(layout.layers)).toEqual(['Back', 'Main']);
    expect(names(at(layout.layers, ['Main']).subLayers)).toEqual(['Front', 'HUD', 'Overlay']);
  });

  it('moves a sub-layer given by its path to the layout\'s own layers, last by default, with its instances', async () => {
    const data = await call('move_layer', { layerName: 'Main > HUD', parentLayer: null });
    expect(data.from).toEqual({ parentLayer: 'Main', index: 0 });
    expect(data.to).toEqual({ parentLayer: null, index: 3 });
    expect(names((await readLayout()).layers)).toEqual(['Back', 'Main', 'Front', 'HUD']);
    expect(await uidsOn('HUD')).toEqual([3]);
  });

  it('moves a sub-layer within its parent when parentLayer is omitted', async () => {
    const data = await call('move_layer', { layerName: 'Main > Overlay', index: 0 });
    expect(data.from).toEqual({ parentLayer: 'Main', index: 1 });
    expect(data.to).toEqual({ parentLayer: 'Main', index: 0 });
    const layout = await readLayout();
    expect(names(layout.layers)).toEqual(['Back', 'Main', 'Front']);
    expect(names(at(layout.layers, ['Main']).subLayers)).toEqual(['Overlay', 'HUD']);
  });

  it('lists "layer" parameters given as a number and leaves them as they are', async () => {
    const sheetFile = join(tmpDir, 'eventSheets', 'MainSheet.json');
    const sheet = JSON.parse(await readFile(sheetFile, 'utf8')) as { events: Array<{ actions: unknown[] }> };
    sheet.events[0].actions.push({ id: 'set-layer-visible', objectClass: 'System', sid: 400000000000020, parameters: { layer: '1', visibility: 'visible' } });
    await writeFile(sheetFile, JSON.stringify(sheet, null, '\t'));
    await reader.loadProject();
    const sheetBefore = await readFile(sheetFile, 'utf8');
    const data = await call('move_layer', { layerName: 'Front', parentLayer: null, index: 0 });
    expect((data.warnings ?? []).join(' ')).toContain('1 "layer" parameter(s) are a number or an expression that may give one, which may count layers by their position, '
      + 'and this call changed the positions; they were NOT changed: "MainSheet" events[0] action 1 (1).');
    expect(await readFile(sheetFile, 'utf8')).toBe(sheetBefore);
    const reordered = await call('reorder_layers', { layerNames: ['Back', 'Main', 'Front'] });
    expect((reordered.warnings ?? []).join(' ')).toContain('"MainSheet" events[0] action 1 (1)');
  });

  it('lists number literals in every form and other expressions, never a quoted name, and changes none', async () => {
    const sheetFile = join(tmpDir, 'eventSheets', 'MainSheet.json');
    const sheet = JSON.parse(await readFile(sheetFile, 'utf8')) as { events: Array<{ actions: unknown[] }> };
    ['1.0', '+1', '1e0', 'LayerVar', '"Main"', '"Say ""hi"""'].forEach((layer, i) => sheet.events[0].actions.push(
      { id: 'set-layer-visible', objectClass: 'System', sid: 400000000000030 + i, parameters: { layer, visibility: 'visible' } }));
    await writeFile(sheetFile, JSON.stringify(sheet, null, '\t'));
    await reader.loadProject();
    const sheetBefore = await readFile(sheetFile, 'utf8');
    const warning = ((await call('reorder_layers', { layerNames: ['Front', 'Back', 'Main'] })).warnings ?? []).join(' ');
    expect(warning).toContain('4 "layer" parameter(s)');
    for (const [j, shown] of [[1, '1.0'], [2, '+1'], [3, '1e0'], [4, 'LayerVar']] as const) expect(warning).toContain(`action ${j} (${shown})`);
    expect(warning).not.toContain('"Main")');
    expect(await readFile(sheetFile, 'utf8')).toBe(sheetBefore);
  });

  it('keeps the sub-layers of a moved layer', async () => {
    await call('move_layer', { layerName: 'Overlay', parentLayer: null, index: 0 });
    const layout = await readLayout();
    expect(names(layout.layers)).toEqual(['Overlay', 'Back', 'Main', 'Front']);
    expect(names(at(layout.layers, ['Overlay']).subLayers)).toEqual(['Top', 'Under']);
    expect(names(at(layout.layers, ['Main']).subLayers)).toEqual(['HUD']);
  });

  it('refuses a move into the layer itself or one of its sub-layers, and changes nothing', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    const inside = await call('move_layer', { layerName: 'Main', parentLayer: 'Top' });
    expect(inside.text).toContain('Cannot move layer "Main" into "Main > Overlay > Top", one of its own sub-layers. Nothing was changed.');
    const itself = await call('move_layer', { layerName: 'Main', parentLayer: 'Main' });
    expect(itself.text).toContain('Cannot move layer "Main" into itself. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('refuses a name two layers share with a hint to the path, not to update_layer', async () => {
    const layout = await readLayout();
    at(layout.layers, ['Main', 'Overlay']).subLayers.push(layer('HUD', 550000000000007));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const data = await call('move_layer', { layerName: 'HUD', parentLayer: null });
    expect(data.text).toContain('Layer name "HUD" is used by 2 layers in layout "Layout 1" (Main > HUD; Main > Overlay > HUD). Give a sub-layer by its path');
    expect(data.text).not.toContain('update_layer');
    expect(data.text).toContain('Nothing was changed.');
  });

  it('refuses an index past the last place, and changes nothing', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('move_layer', { layerName: 'Back', parentLayer: null, index: 3 });
    expect(data.text).toContain('index 3 is out of range: the layers of layout "Layout 1" would hold 3 layer(s) with it, '
      + 'so the highest index is 2. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('reports a layer already in that place as unchanged and writes nothing', async () => {
    const filesBefore = await layoutFiles();
    const data = await call('move_layer', { layerName: 'Front' });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect(await layoutFiles()).toEqual(filesBefore);
  });
});

describe('move_instance', () => {
  it('moves an instance to another layer, last there by default', async () => {
    const data = await call('move_instance', { uid: 1, toLayer: 'Front' });
    expect(data).toMatchObject({ action: 'updated', fromLayer: 'Main', fromIndex: 1, toLayer: 'Front', toIndex: 0, layerInstanceCount: 1 });
    expect(await uidsOn('Main')).toEqual([0, 2]);
    expect(await uidsOn('Front')).toEqual([1]);
  });

  it('moves an instance to a sub-layer given by its path, first there', async () => {
    const data = await call('move_instance', { uid: 0, toLayer: 'Main > HUD', position: 'first' });
    expect(data.toLayer).toBe('Main > HUD');
    expect(await uidsOn('Main', 'HUD')).toEqual([0, 3]);
  });

  it('moves an instance within its layer: last, to an index, after and before another', async () => {
    await call('move_instance', { uid: 0, position: 'last' });
    expect(await uidsOn('Main')).toEqual([1, 2, 0]);
    await call('move_instance', { uid: 0, position: 0 });
    expect(await uidsOn('Main')).toEqual([0, 1, 2]);
    await call('move_instance', { uid: 2, afterUid: 0 });
    expect(await uidsOn('Main')).toEqual([0, 2, 1]);
    await call('move_instance', { uid: 0, beforeUid: 1 });
    expect(await uidsOn('Main')).toEqual([2, 0, 1]);
  });

  it('refuses an index past the last place, and changes nothing', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('move_instance', { uid: 0, position: 3 });
    expect(data.text).toContain('position 3 is out of range: layer "Main" would hold 3 instance(s), so the highest index is 2. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('refuses a non-world instance, an unknown UID and an anchor on another layer, and changes nothing', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    expect((await call('move_instance', { uid: 9, toLayer: 'Front' })).text)
      .toContain('Instance 9 is a non-world instance of layout "Layout 1": it is on no layer. Nothing was changed.');
    expect((await call('move_instance', { uid: 42, toLayer: 'Front' })).text)
      .toContain('Instance with UID 42 not found in layout "Layout 1"');
    expect((await call('move_instance', { uid: 0, toLayer: 'Front', afterUid: 3 })).text)
      .toContain('Instance 3 is not on the destination layer "Front": afterUid and beforeUid name an instance of the destination layer. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('refuses a UID that several instances have, and changes nothing', async () => {
    const layout = await readLayout();
    at(layout.layers, ['Front']).instances.push(sprite(1));
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const before = await readFile(layoutPath(), 'utf8');
    const data = await call('move_instance', { uid: 1, position: 'last' });
    expect(data.text).toContain('UID 1 is used by 2 instances of layout "Layout 1" (duplicate-uid in validate_project), '
      + 'so which one is meant cannot be told. Nothing was changed.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('refuses two placements, a place next to itself and a call with nothing to do', async () => {
    expect((await call('move_instance', { uid: 0, position: 'last', afterUid: 1 })).text)
      .toContain('Give at most one of position, afterUid and beforeUid. Nothing was changed.');
    expect((await call('move_instance', { uid: 0, afterUid: 0 })).text)
      .toContain('An instance cannot be placed next to itself. Nothing was changed.');
    expect((await call('move_instance', { uid: 0 })).text)
      .toContain('Nothing to do: give toLayer, position, afterUid or beforeUid. Nothing was changed.');
  });

  it('reports an instance already in that place as unchanged and writes nothing', async () => {
    const filesBefore = await layoutFiles();
    const data = await call('move_instance', { uid: 2, position: 'last' });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect(await layoutFiles()).toEqual(filesBefore);
  });
});

describe('a failed layout write', () => {
  it('puts the layout back when its write fails its read-back', async () => {
    const before = await readFile(layoutPath(), 'utf8');
    failLayoutReadBack();
    const data = await call('reorder_layers', { layerNames: ['Front', 'Back', 'Main'] });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(before);
  });

  it('leaves a layout an editor saved after the failed write as it is, and names it with its .bak', async () => {
    const saved = JSON.stringify({ ...(await readLayout()), width: 4321 }, null, '\t');
    failLayoutReadBack(() => writeFile(layoutPath(), saved));
    const data = await call('move_instance', { uid: 1, toLayer: 'Front' });
    expect(data.text).toContain('left as it is: layouts/Layout 1.json (another write changed it after this call\'s write failed; '
      + 'its state from before the call is in layouts/Layout 1.json.bak)');
    expect(await readFile(layoutPath(), 'utf8')).toBe(saved);
  });
});

describe('move_instance keeps its arguments', () => {
  // An array of [key, description] pairs: the snapshot formatter sorts an object's keys, not an array's entries
  it('takes the same arguments, described the same', () => {
    const shape = Object.entries(server.getTool('move_instance')!.schema).map(([key, value]) => [key, value.description]);
    expect(shape).toMatchInlineSnapshot(`
      [
        [
          "layoutName",
          "Layout name",
        ],
        [
          "uid",
          "UID of the instance to move (an instance on a layer or sub-layer)",
        ],
        [
          "toLayer",
          "Destination layer (a sub-layer can be given by its path, e.g. "Main > HUD"); default: its own layer",
        ],
        [
          "position",
          ""first", "last" or an index in the destination layer's instances once moved; default "last" when it changes layer",
        ],
        [
          "afterUid",
          "Place it right after this instance of the destination layer",
        ],
        [
          "beforeUid",
          "Place it right before this instance of the destination layer",
        ],
      ]
    `);
  });
});
