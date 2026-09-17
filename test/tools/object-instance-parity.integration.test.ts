/**
 * W90 objects and instances: instance origin, blend mode, depth and Z key,
 * layer moves and Z order, single-global settings, family behaviors,
 * behavior order and single-image replacement, on a temp copy of
 * test/fixtures/rename-project.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { generatePlaceholderPng } from '../../src/construct3/png-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerAnimationTools, readPngSize } from '../../src/tools/animation-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

let tmpDir: string;
let server: MockServer;

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const readJson = async (rel: string) => JSON.parse(await readFile(join(tmpDir, rel), 'utf8'));
async function editJson(rel: string, fn: (data: any) => void) {
  const data = await readJson(rel);
  fn(data);
  await writeFile(join(tmpDir, rel), JSON.stringify(data, null, '\t'));
}
const level1 = () => readJson('layouts/Level 1.json');
const byUid = (layout: any, uid: number): any => {
  const walk = (layers: any[]): any => {
    for (const l of layers) {
      const hit = (l.instances ?? []).find((i: any) => i.uid === uid) ?? walk(l.subLayers ?? []);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(layout.layers) ?? (layout['nonworld-instances'] ?? []).find((i: any) => i.uid === uid);
};

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-w90-objects-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  await editJson('objectTypes/Keyboard.json', o => {
    o['singleglobal-inst'] = { type: 'Keyboard', properties: {}, uid: 4, sid: 660000000000099, tags: '' };
  });
  await editJson('layouts/Level 1.json', l => {
    // A second world instance on Game, and an old-format instance using zElevation.
    l.layers[0].instances.push({
      type: 'Enemy', properties: {}, uid: 5, sid: 660000000000101, tags: '', instanceVariables: {}, behaviors: {},
      world: { x: 1, y: 2, width: 3, height: 4, originX: 0.5, originY: 0.5, color: [1, 1, 1, 1], angle: 0, zElevation: 0 },
    });
  });
  await editJson('objectTypes/Actors/Player.json', o => {
    o.behaviorTypes = [
      { behaviorId: 'Platform', name: 'Platform', sid: 700000000000001 },
      { behaviorId: 'Timer', name: 'Timer', sid: 700000000000002 },
    ];
  });
  await editJson('eventSheets/Main.json', s => {
    s.events.push({
      eventType: 'block', sid: 700000000000010,
      conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform', sid: 700000000000011 }],
      actions: [],
    });
  });

  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as any);
  registerObjectTools({ server, reader, writer, idGen } as any);
  registerAnimationTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  resetProjectIndex();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('update_instance world fields (A2)', () => {
  it('writes origin, blend mode and depth, and drops blend mode for normal', async () => {
    const r = parse(await server.callTool('update_instance', { layoutName: 'Level 1', uid: 1, originX: 0, originY: 1, blendMode: 'additive', depth: 12 }));
    expect(r.success).toBe(true);
    let world = byUid(await level1(), 1).world;
    expect(world).toMatchObject({ originX: 0, originY: 1, blendMode: 'additive', depth: 12 });
    // depth sits right after z, as Construct writes it
    expect(Object.keys(world)).toEqual(['x', 'y', 'width', 'height', 'originX', 'originY', 'color', 'z', 'depth', 'angle', 'blendMode']);
    expect(r.warnings.some((w: string) => w.includes('3D Shape'))).toBe(true);

    await server.callTool('update_instance', { layoutName: 'Level 1', uid: 1, blendMode: 'normal' });
    world = byUid(await level1(), 1).world;
    expect(world).not.toHaveProperty('blendMode');
  });

  it('keeps an old-format zElevation key instead of adding z', async () => {
    await server.callTool('update_instance', { layoutName: 'Level 1', uid: 5, zElevation: 7 });
    const world = byUid(await level1(), 5).world;
    expect(world.zElevation).toBe(7);
    expect(world).not.toHaveProperty('z');
    await server.callTool('update_instance', { layoutName: 'Level 1', uid: 1, zElevation: 3 });
    expect(byUid(await level1(), 1).world).toMatchObject({ z: 3 });
    expect(byUid(await level1(), 1).world).not.toHaveProperty('zElevation');
  });

  it('ignores world fields on a non-world instance with a warning', async () => {
    const r = parse(await server.callTool('update_instance', { layoutName: 'Level 1', uid: 4, originX: 0 }));
    expect(r.warnings[0]).toContain('non-world');
    expect(byUid(await level1(), 4)).not.toHaveProperty('world');
  });
});

describe('delete_instance_from_layout on sub-layers', () => {
  it('removes an instance placed on a sub-layer', async () => {
    const r = parse(await server.callTool('delete_instance_from_layout', { layoutName: 'Level 1', uid: 3 }));
    expect(r.success).toBe(true);
    expect(byUid(await level1(), 3)).toBeUndefined();
  });
});

describe('move_instance (X12)', () => {
  const order = (layout: any, i = 0) => layout.layers[i].instances.map((x: any) => x.uid);

  it('changes Z order within a layer', async () => {
    expect(order(await level1())).toEqual([1, 2, 5]);
    let r = parse(await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, position: 'top' }));
    expect(r).toMatchObject({ success: true, fromIndex: 0, toIndex: 2 });
    expect(order(await level1())).toEqual([2, 5, 1]);
    await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, belowUid: 2 });
    expect(order(await level1())).toEqual([1, 2, 5]);
    await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, aboveUid: 2 });
    expect(order(await level1())).toEqual([2, 1, 5]);
    await server.callTool('move_instance', { layoutName: 'Level 1', uid: 5, position: 0 });
    expect(order(await level1())).toEqual([5, 2, 1]);
    r = parse(await server.callTool('move_instance', { layoutName: 'Level 1', uid: 5, position: 'bottom' }));
    expect(r.action).toBe('unchanged');
  });

  it('moves an instance to a sub-layer and back', async () => {
    await server.callTool('move_instance', { layoutName: 'Level 1', uid: 2, toLayer: 'UI', position: 'bottom' });
    let layout = await level1();
    expect(order(layout)).toEqual([1, 5]);
    expect(layout.layers[0].subLayers[0].instances.map((x: any) => x.uid)).toEqual([2, 3]);
    await server.callTool('move_instance', { layoutName: 'Level 1', uid: 2, toLayer: 'Game' });
    layout = await level1();
    expect(order(layout)).toEqual([1, 5, 2]);
  });

  it('refuses bad requests without writing', async () => {
    const before = await readFile(join(tmpDir, 'layouts/Level 1.json'), 'utf8');
    expect((await server.callTool('move_instance', { layoutName: 'Level 1', uid: 4, position: 'top' })).content[0].text).toContain('non-world');
    expect((await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, toLayer: 'Nope' })).isError).toBe(true);
    expect((await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, aboveUid: 3 })).isError).toBe(true);
    expect((await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, position: 9 })).isError).toBe(true);
    expect((await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, position: 'top', aboveUid: 2 })).isError).toBe(true);
    expect(await readFile(join(tmpDir, 'layouts/Level 1.json'), 'utf8')).toBe(before);
  });
});

describe('single-global settings (X8)', () => {
  it('merges properties and tags into singleglobal-inst', async () => {
    const r = parse(await server.callTool('update_object_properties', { name: 'Keyboard', globalInstanceProperties: { 'some-setting': 3 }, globalInstanceTags: 'input' }));
    expect(r.success).toBe(true);
    expect(r.warnings[0]).toContain('not present');
    const sgi = (await readJson('objectTypes/Keyboard.json'))['singleglobal-inst'];
    expect(sgi).toEqual({ type: 'Keyboard', properties: { 'some-setting': 3 }, uid: 4, sid: 660000000000099, tags: 'input' });
  });

  it('refuses an object that is not single-global', async () => {
    const r = await server.callTool('update_object_properties', { name: 'Enemy', globalInstanceTags: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not a single-global');
  });
});

describe('behavior removal guard', () => {
  it('refuses to remove an object behavior events use, unless forced, and cleans instance settings', async () => {
    await editJson('layouts/Level 1.json', l => {
      l.layers[0].instances[0].behaviors = { Platform: { properties: { 'max-speed': 1 } }, Timer: { properties: {} } };
      l.layers[0].subLayers[0].instances[0].behaviors = { Timer: { properties: {} } };
    });
    const blocked = parse(await server.callTool('update_object_properties', { name: 'Player', removeBehaviors: ['Platform'] }));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect((await readJson('objectTypes/Actors/Player.json')).behaviorTypes).toHaveLength(2);

    const ok = parse(await server.callTool('update_object_properties', { name: 'Player', removeBehaviors: ['Timer'] }));
    expect(ok.success).toBe(true);
    const layout = await level1();
    expect(Object.keys(byUid(layout, 1).behaviors)).toEqual(['Platform']);
    expect(byUid(layout, 3).behaviors).toEqual({}); // sub-layer instance cleaned too

    const forced = parse(await server.callTool('update_object_properties', { name: 'Player', removeBehaviors: ['Platform'], force: true }));
    expect(forced.success).toBe(true);
    expect(byUid(await level1(), 1).behaviors).toEqual({});
  });
});

describe('family behaviors (B3)', () => {
  it('adds a behavior to the family and syncs member instances on every layer', async () => {
    await editJson('layouts/Level 1.json', l => { delete l.layers[0].subLayers[0].instances[0].behaviors; });
    const r = parse(await server.callTool('update_family', { name: 'Hostiles', addBehaviors: [{ behaviorId: 'Sin', name: 'Wobble' }] }));
    expect(r.success).toBe(true);
    const family = await readJson('families/Groups/Hostiles.json');
    expect(family.behaviorTypes).toEqual([{ behaviorId: 'Sin', name: 'Wobble', sid: expect.any(Number) }]);
    expect(Object.keys(family)).toEqual(['name', 'plugin-id', 'sid', 'instanceVariables', 'behaviorTypes', 'effectTypes', 'members']);
    expect(byUid(await level1(), 3).behaviors).toEqual({});
    const project = await readJson('project.c3proj');
    expect(project.usedAddons.some((a: any) => a.type === 'behavior' && a.id === 'Sin')).toBe(true);
  });

  it('refuses a name a member already uses', async () => {
    const r = await server.callTool('update_family', { name: 'Hostiles', addBehaviors: [{ behaviorId: 'Timer', name: 'Timer' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('object type "Player"');
    expect((await readJson('families/Groups/Hostiles.json')).behaviorTypes).toEqual([]);
  });

  it('blocks removal while events use the behavior through a member, then removes with force', async () => {
    await editJson('families/Groups/Hostiles.json', f => { f.behaviorTypes = [{ behaviorId: 'Sin', name: 'Wobble', sid: 700000000000003 }]; });
    await editJson('eventSheets/Main.json', s => {
      s.events.push({
        eventType: 'block', sid: 700000000000020, conditions: [],
        actions: [{ id: 'set-enabled', objectClass: 'Enemy', behaviorType: 'Wobble', sid: 700000000000021, parameters: { state: 'enabled' } }],
      });
    });
    await editJson('layouts/Level 1.json', l => { l.layers[0].instances[1].behaviors = { Wobble: { properties: {} } }; });
    const blocked = parse(await server.callTool('update_family', { name: 'Hostiles', removeBehaviors: ['Wobble'] }));
    expect(blocked).toMatchObject({ success: false, action: 'update_blocked' });
    expect(blocked.references[0].sample[0]).toMatchObject({ objectClass: 'Enemy' });

    const forced = parse(await server.callTool('update_family', { name: 'Hostiles', removeBehaviors: ['Wobble'], force: true }));
    expect(forced.success).toBe(true);
    expect((await readJson('families/Groups/Hostiles.json')).behaviorTypes).toEqual([]);
    expect(byUid(await level1(), 2).behaviors).toEqual({});
  });

  it('strips family behavior settings from a removed member', async () => {
    await editJson('families/Groups/Hostiles.json', f => { f.behaviorTypes = [{ behaviorId: 'Sin', name: 'Wobble', sid: 700000000000003 }]; });
    await editJson('layouts/Level 1.json', l => { l.layers[0].instances[1].behaviors = { Wobble: { properties: {} } }; });
    const r = parse(await server.callTool('update_family', { name: 'Hostiles', removeMembers: ['Enemy'] }));
    expect(r.success).toBe(true);
    expect(byUid(await level1(), 2).behaviors).toEqual({});
    expect(byUid(await level1(), 5).behaviors).toEqual({});
  });
});

describe('reorder_behaviors (B4)', () => {
  it('reorders an object type and a family, and validates the list', async () => {
    const r = parse(await server.callTool('reorder_behaviors', { objectName: 'Player', order: ['Timer', 'Platform'] }));
    expect(r.success).toBe(true);
    expect((await readJson('objectTypes/Actors/Player.json')).behaviorTypes.map((b: any) => b.name)).toEqual(['Timer', 'Platform']);
    expect(parse(await server.callTool('reorder_behaviors', { objectName: 'Player', order: ['Timer', 'Platform'] })).action).toBe('unchanged');
    expect((await server.callTool('reorder_behaviors', { objectName: 'Player', order: ['Timer'] })).isError).toBe(true);
    expect((await server.callTool('reorder_behaviors', { objectName: 'Player', order: ['Timer', 'Timer'] })).isError).toBe(true);
    expect((await server.callTool('reorder_behaviors', { order: ['Timer'] })).isError).toBe(true);

    await editJson('families/Groups/Hostiles.json', f => {
      f.behaviorTypes = [{ behaviorId: 'Sin', name: 'A', sid: 1 }, { behaviorId: 'Sin', name: 'B', sid: 2 }];
    });
    await server.callTool('reorder_behaviors', { familyName: 'Hostiles', order: ['B', 'A'] });
    expect((await readJson('families/Groups/Hostiles.json')).behaviorTypes.map((b: any) => b.sid)).toEqual([2, 1]);
  });
});

describe('replace_object_image (X9)', () => {
  it('writes images/<name>.png and the PNG size to the object type', async () => {
    const png = generatePlaceholderPng(32, 16);
    expect(readPngSize(png)).toEqual({ width: 32, height: 16 });
    const r = parse(await server.callTool('replace_object_image', { objectName: 'Tiles', pngBase64: png.toString('base64') }));
    expect(r.success).toBe(true);
    expect(r.warnings[0]).toContain('tileset changed size');
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'tiles.png')), png)).toBe(0);
    const image = (await readJson('objectTypes/Tiles.json')).image;
    expect(image).toMatchObject({ width: 32, height: 16, fileType: 'image/png', imageSpriteId: 1234567 });
  });

  it('refuses Sprites, image-less objects and bad data', async () => {
    const png = generatePlaceholderPng(2, 2).toString('base64');
    expect((await server.callTool('replace_object_image', { objectName: 'Player', pngBase64: png })).content[0].text).toContain('replace_sprite_image');
    expect((await server.callTool('replace_object_image', { objectName: 'Keyboard', pngBase64: png })).isError).toBe(true);
    expect((await server.callTool('replace_object_image', { objectName: 'Tiles', pngBase64: Buffer.from('not a png at all, really').toString('base64') })).isError).toBe(true);
    expect((await readJson('objectTypes/Tiles.json')).image.width).toBe(64);
  });
});
