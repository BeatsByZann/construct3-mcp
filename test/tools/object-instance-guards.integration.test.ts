/**
 * W90 review follow-ups for the objects and instances tier: behavior-name
 * collisions through family membership, behavior use inside expressions,
 * validate-before-write, partial-write reporting, image rollback, hierarchy
 * cleanup on delete, and cross-layer relative moves. Temp copies of
 * test/fixtures/rename-project.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
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
import { registerAnimationTools } from '../../src/tools/animation-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let idGen: IdGenerator;
let server: MockServer;

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const readJson = async (rel: string) => JSON.parse(await readFile(join(tmpDir, rel), 'utf8'));
async function editJson(rel: string, fn: (data: any) => void) {
  const data = await readJson(rel);
  fn(data);
  await writeFile(join(tmpDir, rel), JSON.stringify(data, null, '\t'));
}
const addons = async () => (await readJson('project.c3proj')).usedAddons.map((a: any) => a.id);

/** A server whose writer throws when `failWhen` matches a writeEntityFile call. */
function serverWithFailingWriter(failWhen: (folder: string, name: string) => boolean) {
  const failing = new Proxy(writer, {
    get(target, prop, receiver) {
      if (prop === 'writeEntityFile') {
        return async (folder: string, name: string, ...rest: unknown[]) => {
          if (failWhen(folder, name)) throw new Error(`disk full writing ${folder}/${name}`);
          return (target.writeEntityFile as any).call(target, folder, name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const s = new MockServer();
  registerObjectTools({ server: s, reader, writer: failing, idGen } as any);
  registerAnimationTools({ server: s, reader, writer: failing, idGen } as any);
  return s;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-w90-guards-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  await editJson('objectTypes/Actors/Player.json', o => {
    o.behaviorTypes = [{ behaviorId: 'Platform', name: 'Platform', sid: 700000000000001 }];
  });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as any);
  registerObjectTools({ server, reader, writer, idGen } as any);
  registerAnimationTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  resetProjectIndex();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('behavior name collisions through families', () => {
  it('refuses to add a member whose own behavior matches a family behavior', async () => {
    await editJson('families/Groups/Hostiles.json', f => {
      f.members = ['Enemy'];
      f.behaviorTypes = [{ behaviorId: 'Platform', name: 'Platform', sid: 700000000000005 }];
    });
    const r = await server.callTool('update_family', { name: 'Hostiles', addMembers: ['Player'] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('"Platform" would appear twice on "Player"');
    expect((await readJson('families/Groups/Hostiles.json')).members).toEqual(['Enemy']);
  });

  it('refuses an object behavior whose name a family already gives the object', async () => {
    await editJson('families/Groups/Hostiles.json', f => {
      f.behaviorTypes = [{ behaviorId: 'Sin', name: 'Wobble', sid: 700000000000005 }];
    });
    const r = await server.callTool('update_object_properties', { name: 'Enemy', addBehaviors: [{ behaviorId: 'Sin', name: 'Wobble' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('family "Hostiles"');
    expect((await readJson('objectTypes/Actors/Enemy.json')).behaviorTypes).toEqual([]);
  });

  it('accepts a name starting with a digit and registers nothing when a later entry fails', async () => {
    const before = await addons();
    const bad = await server.callTool('update_family', {
      name: 'Hostiles',
      addBehaviors: [{ behaviorId: '8Direction', name: '8Direction' }, { behaviorId: 'Platform', name: 'Platform' }],
    });
    expect(bad.isError).toBe(true);
    expect(await addons()).toEqual(before);

    const ok = parse(await server.callTool('update_family', { name: 'Hostiles', addBehaviors: [{ behaviorId: '8Direction', name: '8Direction' }] }));
    expect(ok.success).toBe(true);
    expect((await readJson('families/Groups/Hostiles.json')).behaviorTypes.map((b: any) => b.name)).toEqual(['8Direction']);
    expect((await server.callTool('update_family', { name: 'Hostiles', addBehaviors: [{ behaviorId: 'Sin', name: 'bad-name' }] })).isError).toBe(true);
  });
});

describe('behavior use inside expressions', () => {
  beforeEach(async () => {
    await editJson('eventSheets/Main.json', s => {
      s.events.push({
        eventType: 'block', sid: 700000000000030, conditions: [],
        actions: [{ id: 'set-x', objectClass: 'Enemy', sid: 700000000000031, parameters: { x: 'Player.Platform.VectorX + 1' } }],
      });
    });
  });

  it('blocks removing an object behavior used only in an expression', async () => {
    const r = parse(await server.callTool('update_object_properties', { name: 'Player', removeBehaviors: ['Platform'] }));
    expect(r).toMatchObject({ success: false, action: 'update_blocked' });
    expect(r.references[0].expressions[0]).toMatchObject({ eventSheet: 'Main', eventSid: 700000000000030 });
    expect((await readJson('objectTypes/Actors/Player.json')).behaviorTypes).toHaveLength(1);
  });

  it('blocks removing a family behavior used in an expression through a member', async () => {
    await editJson('families/Groups/Hostiles.json', f => {
      f.behaviorTypes = [{ behaviorId: 'Sin', name: 'Wobble', sid: 700000000000005 }];
    });
    await editJson('eventSheets/Main.json', s => {
      s.events.at(-1).actions[0].parameters.x = 'Enemy . Wobble.Value';
    });
    const r = parse(await server.callTool('update_family', { name: 'Hostiles', removeBehaviors: ['Wobble'] }));
    expect(r).toMatchObject({ success: false, action: 'update_blocked' });
    // A plain name that only starts the same way is not a reference.
    await editJson('eventSheets/Main.json', s => {
      s.events.at(-1).actions[0].parameters.x = 'Enemy.WobbleX.Value';
    });
    reader.invalidateCaches();
    resetProjectIndex();
    const after = parse(await server.callTool('update_family', { name: 'Hostiles', removeBehaviors: ['Wobble'] }));
    expect(after, JSON.stringify(after)).toMatchObject({ success: true });
  });
});

describe('partial writes', () => {
  beforeEach(async () => {
    // An instance without dicts makes the sync write a layout.
    await editJson('layouts/Level 1.json', l => { delete l.layers[0].instances[1].behaviors; });
  });

  it('reports the written family file when the layout sync fails', async () => {
    const failing = serverWithFailingWriter(folder => folder === 'layouts');
    const r = parse(await failing.callTool('update_family', { name: 'Hostiles', addBehaviors: [{ behaviorId: 'Sin', name: 'Wobble' }] }));
    expect(r).toMatchObject({ success: false, action: 'partially_updated', writtenLayouts: [] });
    expect(r.message).toContain('disk full writing layouts/');
    expect((await readJson('families/Groups/Hostiles.json')).behaviorTypes).toHaveLength(1);
  });

  it('reports the written object file when the layout sync fails', async () => {
    const failing = serverWithFailingWriter(folder => folder === 'layouts');
    const r = parse(await failing.callTool('update_object_properties', { name: 'Enemy', addVariables: [{ name: 'hp', type: 'number' }] }));
    expect(r).toMatchObject({ success: false, action: 'partially_updated' });
  });

  it('restores the previous image when the object type write fails', async () => {
    await mkdir(join(tmpDir, 'images'), { recursive: true });
    const old = generatePlaceholderPng(64, 64);
    await writeFile(join(tmpDir, 'images', 'tiles.png'), old);
    const failing = serverWithFailingWriter(folder => folder === 'objectTypes');
    const r = await failing.callTool('replace_object_image', { objectName: 'Tiles', pngBase64: generatePlaceholderPng(8, 8).toString('base64') });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('disk full writing objectTypes/Tiles');
    expect(r.content[0].text).toContain('previous image was restored');
    expect(Buffer.compare(await readFile(join(tmpDir, 'images', 'tiles.png')), old)).toBe(0);
  });
});

describe('instance hierarchy and cross-layer moves', () => {
  beforeEach(async () => {
    await editJson('layouts/Level 1.json', l => {
      const flags = { x: true, y: true, z: true, w: true, h: true, d: true, a: true, o: false, v: false, sm: 'normal' };
      const preview = { previewSceneGraph: false };
      const [player, enemy] = l.layers[0].instances;
      player.sceneGraphData = { 'parent-uid': null, uid: 1, flags, preview, children: [{ uid: 2, flags }] };
      enemy.sceneGraphData = { 'parent-uid': 1, uid: 2, flags, preview };
      enemy.world = { ...enemy.world, originX: 0.5, originY: 0.5, color: [1, 1, 1, 1] };
    });
  });

  it('detaches children and parent links when an instance is deleted', async () => {
    let r = parse(await server.callTool('delete_instance_from_layout', { layoutName: 'Level 1', uid: 1 }));
    expect(r.warnings).toContain('Detached its hierarchy children: 2.');
    let layout = await readJson('layouts/Level 1.json');
    expect(layout.layers[0].instances[0].sceneGraphData['parent-uid']).toBeNull();

    await editJson('layouts/Level 1.json', l => {
      l.layers[0].instances.push({ ...l.layers[0].instances[0], uid: 9, sid: 1, sceneGraphData: { 'parent-uid': null, uid: 9, children: [{ uid: 2 }] } });
      l.layers[0].instances[0].sceneGraphData['parent-uid'] = 9;
    });
    r = parse(await server.callTool('delete_instance_from_layout', { layoutName: 'Level 1', uid: 2 }));
    layout = await readJson('layouts/Level 1.json');
    expect(layout.layers[0].instances.find((i: any) => i.uid === 9).sceneGraphData).not.toHaveProperty('children');
  });

  it('places an instance relative to another on a different layer', async () => {
    await server.callTool('move_instance', { layoutName: 'Level 1', uid: 2, toLayer: 'UI', belowUid: 3 });
    let ui = (await readJson('layouts/Level 1.json')).layers[0].subLayers[0].instances.map((i: any) => i.uid);
    expect(ui).toEqual([2, 3]);
    await server.callTool('move_instance', { layoutName: 'Level 1', uid: 1, toLayer: 'UI', aboveUid: 2 });
    ui = (await readJson('layouts/Level 1.json')).layers[0].subLayers[0].instances.map((i: any) => i.uid);
    expect(ui).toEqual([2, 1, 3]);
  });

  it('places a new instance on a sub-layer', async () => {
    const r = parse(await server.callTool('add_instance_to_layout', { layoutName: 'Level 1', layerName: 'UI', objectType: 'Enemy', x: 5, y: 6 }));
    expect(r.success).toBe(true);
    const ui = (await readJson('layouts/Level 1.json')).layers[0].subLayers[0].instances;
    expect(ui.at(-1)).toMatchObject({ type: 'Enemy', uid: r.generatedUid });
  });

  it('appends depth when the instance has no Z key', async () => {
    await server.callTool('update_instance', { layoutName: 'Level 1', uid: 2, depth: 4 });
    const world = (await readJson('layouts/Level 1.json')).layers[0].instances[1].world;
    expect(Object.keys(world).at(-1)).toBe('depth');
  });
});
