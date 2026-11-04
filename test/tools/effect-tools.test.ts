/**
 * list_effects, add_effect, update_effect, remove_effect and reorder_effects
 * (#ISSUE): the effects of an object type, a family, a layout and a layer.
 * An object type's or family's effect is an entry of its effectTypes plus an
 * entry on every placed instance of the object type or of its members; a
 * layer's or layout's effect carries its own state. The layouts are written
 * first and the holder's file last, and a failed write is rolled back.
 * remove_effect refuses while events name the effect. Synthetic data on a
 * temp copy of the minimal fixture, with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import { registerEffectTools } from '../../src/tools/effect-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface InstanceEffect { isEnabled: boolean; parameters: Record<string, unknown> }
interface EffectEntry { effectId: string; name: string; instance?: InstanceEffect }
interface InstanceJson { uid: number; type: string; effects?: Record<string, InstanceEffect>; [key: string]: unknown }
interface LayerJson { name: string; sid: number; instances: InstanceJson[]; subLayers?: LayerJson[]; effectTypes?: EffectEntry[]; [key: string]: unknown }
interface LayoutFile { name: string; layers: LayerJson[]; effectTypes?: EffectEntry[]; [key: string]: unknown }
interface HolderFile { effectTypes?: EffectEntry[]; members?: string[]; [key: string]: unknown }
interface ToolData {
  isError?: boolean; text?: string; success?: boolean; action?: string; message?: string; warnings?: string[]; editorNote?: string;
  category?: string; entity?: string; effect?: string; effects?: unknown; target?: unknown; registeredEffectAddons?: Array<{ id: string }>;
  references?: { effectUses?: unknown[] }; unscannedFiles?: Array<{ file: string }>; backupFile?: string; generatedUid?: number;
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const path = (...parts: string[]) => join(tmpDir, ...parts);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const writeJson = (file: string, data: unknown) => writeFile(file, JSON.stringify(data, null, '\t'));
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const reload = async () => {
  await reader.loadProject();
  resetProjectIndex();
};
const glow = (name = 'Glow', effectId = 'glowhorizontal'): EffectEntry => ({ effectId, name });
const layerEntry = (name: string, parameters: Record<string, unknown> = {}, isEnabled = true): EffectEntry =>
  ({ effectId: 'glowhorizontal', name, instance: { isEnabled, parameters } });
const state = (parameters: Record<string, unknown> = {}, isEnabled = true): InstanceEffect => ({ isEnabled, parameters });

/** Change a holder file (object type or family) on disk and reload. */
async function editHolder(file: string, change: (holder: HolderFile) => void): Promise<void> {
  const holder = await readJson<HolderFile>(path(file));
  change(holder);
  await writeJson(path(file), holder);
  await reload();
}
const editLayout = async (change: (layout: LayoutFile) => void, name = 'Layout 1'): Promise<void> => {
  const layout = await readJson<LayoutFile>(path('layouts', `${name}.json`));
  change(layout);
  await writeJson(path('layouts', `${name}.json`), layout);
  await reload();
};
const layoutOf = (name = 'Layout 1') => readJson<LayoutFile>(path('layouts', `${name}.json`));
const instanceOf = async (uid: number, layout = 'Layout 1'): Promise<InstanceJson> =>
  (await layoutOf(layout)).layers[0].instances.find(i => i.uid === uid)!;
const effectsOf = async (file: string) => (await readJson<HolderFile>(path(file))).effectTypes;
const overlayOf = async () => (await layoutOf()).layers[1].subLayers![0];

/** The effects of a placed instance: Sprite UID 0 of Layout 1 holds `effects`. */
const giveInstance = (uid: number, effects: Record<string, InstanceEffect>, layout = 'Layout 1') =>
  editLayout(l => { l.layers[0].instances.find(i => i.uid === uid)!.effects = effects; }, layout);

/** "Layout 2": a copy of Layout 1 with one Sprite instance, UID 7, on its layer "Main". */
async function addLayout2(): Promise<void> {
  const layout = await layoutOf();
  layout.name = 'Layout 2';
  layout.layers = [{ ...layout.layers[0], instances: [{ ...layout.layers[0].instances[0], uid: 7, sid: 500000000000077 }] }];
  await writeJson(path('layouts', 'Layout 2.json'), layout);
  const project = await readJson<{ layouts: { items: string[] } }>(path('project.c3proj'));
  project.layouts.items.push('Layout 2');
  await writeJson(path('project.c3proj'), project);
  await reload();
}

/** Family "Enemies" with the given members and effects. */
async function addFamily(name: string, members: string[], effects: EffectEntry[]): Promise<void> {
  expect((await call('create_family', { name, pluginId: 'Sprite', members })).success).toBe(true);
  await editHolder(`families/${name}.json`, f => { f.effectTypes = effects; });
}

/** A set-effect-enabled action on `objectClass` whose effect parameter is `effect` (System: the layer and layout effects). */
async function setActions(...actions: Array<{ objectClass: string; effect: string }>): Promise<void> {
  const sheet = await readJson<{ events: Array<{ actions: unknown[] }> }>(path('eventSheets', 'MainSheet.json'));
  sheet.events[0].actions = actions.map((a, i) => ({
    id: a.objectClass === 'System' ? 'set-layer-effect-enabled' : 'set-effect-enabled', objectClass: a.objectClass, sid: 400000000000100 + i,
    parameters: { effect: a.effect, enable: 'true' },
  }));
  await writeJson(path('eventSheets', 'MainSheet.json'), sheet);
  await reload();
}

/** An event sheet the reader cannot parse, registered in the project. */
async function addBrokenSheet(text: string): Promise<void> {
  await writeFile(path('eventSheets', 'Broken.json'), text);
  const project = await readJson<{ eventSheets: { items: string[] } }>(path('project.c3proj'));
  if (!project.eventSheets.items.includes('Broken')) project.eventSheets.items.push('Broken');
  await writeJson(path('project.c3proj'), project);
  await reload();
}

async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of (await readdir(tmpDir, { recursive: true })).map(String).sort()) {
    out[file.replaceAll('\\', '/')] = await readFile(path(file), 'utf8').catch(() => '(directory)');
  }
  return out;
}

/** The files of the project as they are, without the .bak copies the writer leaves. */
async function contents(): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await snapshot()).filter(([file]) => !file.endsWith('.bak')));
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-effect-tools-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(path('project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  const deps = { server, reader, writer, idGen } as never;
  registerObjectTools(deps);
  registerLayoutTools(deps);
  registerProjectTools(deps);
  registerEffectTools(deps);
  for (const [id, name] of [['glowhorizontal', 'Glow horizontal'], ['fogexponential', 'Fog exponential']]) {
    expect((await call('register_addon', { type: 'effect', id, name })).success).toBe(true);
  }
  // Layout 1 gets a layer "HUD" with a sub-layer "Overlay"
  await editLayout(l => {
    l.layers.push({ name: 'HUD', sid: 500000000000010, instances: [], subLayers: [{ name: 'Overlay', sid: 500000000000011, instances: [] }] });
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('list_effects', () => {
  it('lists the effects of an object type, a family, a layout and a layer by its path, and the registered effect addons', async () => {
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow')]; });
    await addFamily('Enemies', ['Sprite'], [glow('Fog', 'fogexponential')]);
    await editLayout(l => {
      l.effectTypes = [layerEntry('Dim')];
      l.layers[1].subLayers![0].effectTypes = [layerEntry('Shade', { a: 1 })];
    });
    const before = await snapshot();

    const object = await call('list_effects', { objectName: 'Sprite' });
    expect(object.target).toEqual({ kind: 'object', name: 'Sprite' });
    expect(object.effects).toEqual([glow('Glow')]);
    expect(object.registeredEffectAddons!.map(a => a.id).sort()).toEqual(['fogexponential', 'glowhorizontal']);
    expect((await call('list_effects', { familyName: 'Enemies' })).effects).toEqual([glow('Fog', 'fogexponential')]);
    const layout = await call('list_effects', { layoutName: 'Layout 1' });
    expect(layout.target).toEqual({ kind: 'layout', name: 'Layout 1' });
    expect(layout.effects).toEqual([layerEntry('Dim')]);
    const layer = await call('list_effects', { layoutName: 'Layout 1', layerName: 'HUD > Overlay' });
    expect(layer.target).toEqual({ kind: 'layer', layout: 'Layout 1', layer: 'HUD > Overlay' });
    expect(layer.effects).toEqual([layerEntry('Shade', { a: 1 })]);
    expect(layer.editorNote).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });
});

describe('add_effect', () => {
  it('adds an object type\'s effect with an entry on every placed instance', async () => {
    await addLayout2();
    const data = await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'Glow', parameters: { strength: 2 } });
    expect(data).toMatchObject({ success: true, entity: 'Sprite', category: 'object', action: 'updated', effect: 'Glow', effects: ['Glow'] });
    expect(data.backupFile).toBeDefined();
    expect(data.editorNote).toBeDefined();
    expect(await effectsOf('objectTypes/Sprite.json')).toEqual([glow('Glow')]);
    expect((await instanceOf(0)).effects).toEqual({ Glow: state({ strength: 2 }) });
    expect((await instanceOf(7, 'Layout 2')).effects).toEqual({ Glow: state({ strength: 2 }) });
  });

  it('adds a family effect to the instances of every member, family entries first', async () => {
    expect((await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' })).success).toBe(true);
    const placed = await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 0, y: 0 });
    await addFamily('Enemies', ['Sprite', 'Sprite2'], []);
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Own')]; });
    await giveInstance(0, { Own: state({ k: 1 }) });
    const data = await call('add_effect', { familyName: 'Enemies', effectId: 'fogexponential', name: 'Fog', parameters: { density: 1 } });
    expect(data).toMatchObject({ success: true, entity: 'Enemies', category: 'family', effects: ['Fog'] });
    expect(await effectsOf('families/Enemies.json')).toEqual([glow('Fog', 'fogexponential')]);
    const sprite = (await instanceOf(0)).effects!;
    expect(Object.keys(sprite)).toEqual(['Fog', 'Own']);
    expect(sprite.Own).toEqual(state({ k: 1 }));
    expect((await instanceOf(placed.generatedUid!)).effects).toEqual({ Fog: state({ density: 1 }) });
  });

  it('adds a layer effect (by its path) and a layout effect with their instance state', async () => {
    const layer = await call('add_effect', {
      layoutName: 'Layout 1', layerName: 'HUD > Overlay', effectId: 'fogexponential', name: 'Mist', parameters: { density: 3 }, isEnabled: false,
    });
    expect(layer).toMatchObject({ success: true, entity: 'Layout 1', category: 'layer', effects: ['Mist'] });
    expect((await overlayOf()).effectTypes).toEqual([{ effectId: 'fogexponential', name: 'Mist', instance: { isEnabled: false, parameters: { density: 3 } } }]);
    const layout = await call('add_effect', { layoutName: 'Layout 1', effectId: 'glowhorizontal', name: 'Dim', parameters: { a: 1 } });
    expect(layout).toMatchObject({ success: true, entity: 'Layout 1', category: 'layout', effects: ['Dim'] });
    expect((await layoutOf()).effectTypes).toEqual([layerEntry('Dim', { a: 1 })]);
    // A layout's effect writes no entries on the instances
    expect((await instanceOf(0)).effects).toBeUndefined();
  });

  it('refuses an addon not in usedAddons, a name in use ignoring case (also a family\'s), and an index past the end, changing nothing', async () => {
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow'), glow('Own')]; });
    await addFamily('Enemies', ['Sprite'], [glow('Fog', 'fogexponential')]);
    await giveInstance(0, { Fog: state(), Glow: state(), Own: state() });
    const before = await snapshot();

    const unknown = await call('add_effect', { objectName: 'Sprite', effectId: 'blur', name: 'Blur' });
    expect(unknown.text).toContain('is not a usedAddons entry of type effect');
    expect(unknown.text).toContain('register_addon');
    // Registered, but as a plugin
    expect((await call('add_effect', { objectName: 'Sprite', effectId: 'Sprite', name: 'Blur' })).text).toContain('register_addon');
    expect((await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'glow' })).text)
      .toContain('"Sprite" already has an effect "Glow"');
    const familys = await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'FOG' });
    expect(familys.text).toContain('"Sprite" already has an effect "Fog" (its own or a family\'s)');
    expect((await call('add_effect', { familyName: 'Enemies', effectId: 'glowhorizontal', name: 'own' })).text)
      .toContain('"Sprite" already has an effect "Own"');
    expect((await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'Late', index: 3 })).text)
      .toContain('index 3 is past the end');
    expect((await call('add_effect', { layoutName: 'Layout 1', effectId: 'glowhorizontal', name: 'Late', index: 1 })).text)
      .toContain('index 1 is past the end');
    for (const refused of [unknown, familys]) expect(refused.text).toContain('Nothing was changed.');
    expect(await snapshot()).toEqual(before);
  });

  it('accepts add_effect without parameters, writing {}', async () => {
    const layer = await call('add_effect', { layoutName: 'Layout 1', layerName: 'HUD', effectId: 'glowhorizontal', name: 'Aura' });
    expect(layer.success).toBe(true);
    expect((await layoutOf()).layers[1].effectTypes).toEqual([layerEntry('Aura', {})]);
    const object = await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'Glow' });
    expect(object.success).toBe(true);
    expect((await instanceOf(0)).effects).toEqual({ Glow: state({}) });
  });

  it('defaults the name to the effect id with its first letter in upper case', async () => {
    const data = await call('add_effect', { objectName: 'Sprite', effectId: 'fogexponential' });
    expect(data).toMatchObject({ success: true, effect: 'Fogexponential', effects: ['Fogexponential'] });
    expect(await effectsOf('objectTypes/Sprite.json')).toEqual([glow('Fogexponential', 'fogexponential')]);
  });

  it('refuses no target, two targets, and layerName without layoutName', async () => {
    const before = await snapshot();
    const base = { effectId: 'glowhorizontal', name: 'Glow' };
    expect((await call('add_effect', base)).text).toContain('Give exactly one of objectName, familyName and layoutName.');
    expect((await call('add_effect', { ...base, objectName: 'Sprite', layoutName: 'Layout 1' })).text)
      .toContain('Give exactly one of objectName, familyName and layoutName.');
    expect((await call('add_effect', { ...base, objectName: 'Sprite', layerName: 'Main' })).text).toContain('layerName needs layoutName');
    expect((await call('list_effects', { objectName: 'Sprite', familyName: 'Enemies' })).text).toContain('Give exactly one of');
    expect((await call('add_effect', { ...base, objectName: 'sprite' })).text).toContain('names are matched with their letter case. Did you mean "Sprite"?');
    expect(await snapshot()).toEqual(before);
  });

  it('finishes an add_effect that a stopped call left half done when run again', async () => {
    // The first instance holds the entry (with its own state), the object type does not: what a process stopped between the two leaves
    await addLayout2();
    await giveInstance(0, { Glow: state({ k: 1 }, false) });
    const data = await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'Glow', parameters: { k: 2 } });
    expect(data.success).toBe(true);
    expect(await effectsOf('objectTypes/Sprite.json')).toEqual([glow('Glow')]);
    expect((await instanceOf(0)).effects).toEqual({ Glow: state({ k: 1 }, false) });
    expect((await instanceOf(7, 'Layout 2')).effects).toEqual({ Glow: state({ k: 2 }) });
  });
});

describe('update_effect', () => {
  it('merges a layer effect\'s parameters and sets isEnabled', async () => {
    await editLayout(l => {
      l.effectTypes = [layerEntry('Dim', { a: 1 })];
      l.layers[1].subLayers![0].effectTypes = [layerEntry('Shade', { a: 1, b: 2 })];
    });
    const data = await call('update_effect', {
      layoutName: 'Layout 1', layerName: 'HUD > Overlay', name: 'Shade', isEnabled: false, parameters: { b: 3, c: 4 },
    });
    expect(data).toMatchObject({ success: true, category: 'layer', action: 'updated', effect: 'Shade', effects: ['Shade'] });
    expect((await overlayOf()).effectTypes).toEqual([layerEntry('Shade', { a: 1, b: 3, c: 4 }, false)]);
    const layout = await call('update_effect', { layoutName: 'Layout 1', name: 'Dim', isEnabled: false });
    expect(layout).toMatchObject({ success: true, category: 'layout', action: 'updated' });
    expect((await layoutOf()).effectTypes).toEqual([layerEntry('Dim', { a: 1 }, false)]);
  });

  it('changes one placed instance\'s entry of an object type\'s effect, and refuses without instanceUid', async () => {
    await addLayout2();
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow')]; });
    await giveInstance(0, { Glow: state({ a: 1, b: 1 }) });
    await giveInstance(7, { Glow: state({ a: 1 }) }, 'Layout 2');
    const before = await snapshot();
    expect((await call('update_effect', { objectName: 'Sprite', name: 'Glow', parameters: { a: 9 } })).text)
      .toContain('instanceLayoutName and instanceUid');
    expect((await call('update_effect', { objectName: 'Sprite', name: 'Glow', instanceLayoutName: 'Layout 1', parameters: { a: 9 } })).text)
      .toContain('instanceLayoutName and instanceUid');
    expect((await call('update_effect', { objectName: 'Sprite', name: 'Glow', instanceLayoutName: 'Layout 1', instanceUid: 0 })).text)
      .toContain('Nothing to update');
    expect(await snapshot()).toEqual(before);

    const data = await call('update_effect', {
      objectName: 'Sprite', name: 'Glow', instanceLayoutName: 'Layout 1', instanceUid: 0, isEnabled: false, parameters: { a: 9 },
    });
    expect(data).toMatchObject({ success: true, category: 'object', action: 'updated', effect: 'Glow' });
    expect((await instanceOf(0)).effects).toEqual({ Glow: state({ a: 9, b: 1 }, false) });
    expect((await instanceOf(7, 'Layout 2')).effects).toEqual({ Glow: state({ a: 1 }) });
    expect(await effectsOf('objectTypes/Sprite.json')).toEqual([glow('Glow')]);
  });

  it('on an instance placed after add_effect refuses, says add_instance_to_layout wrote no entry for it, and changes nothing', async () => {
    expect((await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'Glow' })).success).toBe(true);
    const placed = await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 5, y: 5 });
    expect((await instanceOf(placed.generatedUid!)).effects).toBeUndefined();
    const before = await snapshot();
    const data = await call('update_effect', {
      objectName: 'Sprite', name: 'Glow', instanceLayoutName: 'Layout 1', instanceUid: placed.generatedUid, isEnabled: false,
    });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('has no entry for the effect "Glow"');
    expect(data.text).toContain('add_instance_to_layout does not write effect entries');
    expect(data.text).toContain('Nothing was changed.');
    expect(await snapshot()).toEqual(before);
  });
});

describe('remove_effect', () => {
  it('refuses while an action on the object names the effect, changing nothing; with force it removes and warns', async () => {
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow')]; });
    await giveInstance(0, { Glow: state({ a: 1 }) });
    await setActions({ objectClass: 'Sprite', effect: '"glow"' });
    const before = await snapshot();
    const refused = await call('remove_effect', { objectName: 'Sprite', name: 'Glow' });
    expect(refused).toMatchObject({ success: false, action: 'remove_blocked' });
    expect(refused.message).toContain('Nothing was changed.');
    expect(refused.message).toContain('force=true');
    expect(refused.references!.effectUses).toHaveLength(1);
    expect(refused.editorNote).toBeUndefined();
    expect(await snapshot()).toEqual(before);

    const forced = await call('remove_effect', { objectName: 'Sprite', name: 'Glow', force: true });
    expect(forced).toMatchObject({ success: true, action: 'updated', effects: [] });
    expect((forced.warnings ?? []).join(' ')).toContain('although events still use');
    expect(await effectsOf('objectTypes/Sprite.json')).toEqual([]);
    expect((await instanceOf(0)).effects).toEqual({});
  });

  it('of a family effect refuses while an action on a member names it; a member with its own effect of that name keeps its entries', async () => {
    expect((await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' })).success).toBe(true);
    const placed = await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 0, y: 0 });
    await addFamily('Enemies', ['Sprite', 'Sprite2'], [glow('Glow')]);
    // Sprite2 has an effect of that name of its own (a hand edit: add_effect would refuse the name)
    await editHolder('objectTypes/Sprite2.json', o => { o.effectTypes = [glow('Glow')]; });
    await giveInstance(0, { Glow: state({ s: 1 }) });
    await editLayout(l => { l.layers[0].instances.find(i => i.uid === placed.generatedUid)!.effects = { Glow: state({ s: 2 }) }; });

    await setActions({ objectClass: 'Sprite', effect: '"Glow"' });
    const before = await snapshot();
    const refused = await call('remove_effect', { familyName: 'Enemies', name: 'Glow' });
    expect(refused).toMatchObject({ success: false, action: 'remove_blocked' });
    expect(refused.message).toContain('"Sprite"');
    expect(await snapshot()).toEqual(before);

    // An action on Sprite2 is no use of the family's effect: Sprite2 keeps its own
    await setActions({ objectClass: 'Sprite2', effect: '"Glow"' });
    const data = await call('remove_effect', { familyName: 'Enemies', name: 'Glow' });
    expect(data).toMatchObject({ success: true, category: 'family', action: 'updated', effects: [] });
    expect(await effectsOf('families/Enemies.json')).toEqual([]);
    expect((await instanceOf(0)).effects).toEqual({});
    expect((await instanceOf(placed.generatedUid!)).effects).toEqual({ Glow: state({ s: 2 }) });
  });

  it('of a layer effect refuses while a System action names an effect of that name', async () => {
    await editLayout(l => {
      l.effectTypes = [layerEntry('Dim')];
      l.layers[1].effectTypes = [layerEntry('Blur')];
    });
    await setActions({ objectClass: 'System', effect: '"Blur"' });
    const before = await snapshot();
    const refused = await call('remove_effect', { layoutName: 'Layout 1', layerName: 'HUD', name: 'Blur' });
    expect(refused).toMatchObject({ success: false, action: 'remove_blocked' });
    expect(refused.message).toContain('System');
    expect(refused.message).toContain('possible uses');
    expect(await snapshot()).toEqual(before);
    // The same for a layout effect, and no use of another name
    await setActions({ objectClass: 'System', effect: '"Dim"' });
    expect((await call('remove_effect', { layoutName: 'Layout 1', name: 'Dim' })).action).toBe('remove_blocked');
    const free = await call('remove_effect', { layoutName: 'Layout 1', layerName: 'HUD', name: 'Blur' });
    expect(free).toMatchObject({ success: true, category: 'layer', effects: [] });
    expect((await layoutOf()).layers[1].effectTypes).toEqual([]);
    const forced = await call('remove_effect', { layoutName: 'Layout 1', name: 'Dim', force: true });
    expect(forced.success).toBe(true);
    expect((forced.warnings ?? []).join(' ')).toContain('although events still use');
  });

  it('refuses while an event sheet that could not be parsed names the effect', async () => {
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow')]; });
    await addBrokenSheet('{ "name": "Broken", "events": [ Sprite Glow');
    const before = await snapshot();
    const refused = await call('remove_effect', { objectName: 'Sprite', name: 'Glow' });
    expect(refused).toMatchObject({ success: false, action: 'remove_blocked' });
    expect(refused.unscannedFiles!.map(f => f.file)).toEqual(['eventSheets/Broken']);
    expect(await snapshot()).toEqual(before);
    // Text that names the effect but not the object (or the reverse) is no possible use
    await addBrokenSheet('{ "name": "Broken", "events": [ Glow');
    const data = await call('remove_effect', { objectName: 'Sprite', name: 'Glow' });
    expect(data.success).toBe(true);
    expect((data.warnings ?? []).join(' ')).toContain('only searched as text');
  });

  it('of a family effect refuses while an event sheet that could not be parsed names a member and the effect, but not the family', async () => {
    await addFamily('Glowers', ['Sprite'], [glow('Glow')]);
    await addBrokenSheet('{ "name": "Broken", "events": [ Sprite Glow');
    const before = await snapshot();
    const refused = await call('remove_effect', { familyName: 'Glowers', name: 'Glow' });
    expect(refused).toMatchObject({ success: false, action: 'remove_blocked' });
    expect(refused.unscannedFiles!.map(f => f.file)).toEqual(['eventSheets/Broken']);
    expect(await snapshot()).toEqual(before);
  });

  it('removes the instance entries and lists them', async () => {
    await addLayout2();
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow'), glow('Keep')]; });
    await giveInstance(0, { Glow: state({ a: 1 }), Keep: state() });
    await giveInstance(7, { Glow: state(), Keep: state() }, 'Layout 2');
    const data = await call('remove_effect', { objectName: 'Sprite', name: 'Glow' });
    expect(data).toMatchObject({ success: true, effects: ['Keep'] });
    const warnings = (data.warnings ?? []).join(' ');
    expect(warnings).toContain('Removed 2 effect entries from instances');
    expect(warnings).toContain('"Layout 1" UID 0 effect "Glow" {"isEnabled":true,"parameters":{"a":1}}');
    expect(warnings).toContain(".bak files hold them");
    expect((await instanceOf(0)).effects).toEqual({ Keep: state() });
    expect((await instanceOf(7, 'Layout 2')).effects).toEqual({ Keep: state() });
    expect((await call('remove_effect', { objectName: 'Sprite', name: 'Gone' })).text).toContain('has no effect "Gone"');
  });
});

describe('reorder_effects', () => {
  it('reorders the stack and the owner\'s instance entries, entries of another family and for another name staying where they are', async () => {
    await addFamily('Enemies', ['Sprite'], [glow('F1'), glow('F2')]);
    await addFamily('Others', ['Sprite'], [glow('X')]);
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('O1'), glow('O2')]; });
    // Seeded in the old order, with another family's entry between the two
    await giveInstance(0, { F1: state({ n: 1 }), X: state({ n: 2 }), F2: state({ n: 3 }), O1: state({ n: 4 }), O2: state({ n: 5 }) });

    const family = await call('reorder_effects', { familyName: 'Enemies', names: ['F2', 'F1'] });
    expect(family).toMatchObject({ success: true, category: 'family', action: 'updated', effects: ['F2', 'F1'] });
    expect((await effectsOf('families/Enemies.json'))!.map(e => e.name)).toEqual(['F2', 'F1']);
    const afterFamily = (await instanceOf(0)).effects!;
    expect(Object.keys(afterFamily)).toEqual(['F2', 'X', 'F1', 'O1', 'O2']);
    expect(afterFamily.F2).toEqual(state({ n: 3 }));

    const object = await call('reorder_effects', { objectName: 'Sprite', names: ['O2', 'O1'] });
    expect(object.success).toBe(true);
    expect(Object.keys((await instanceOf(0)).effects!)).toEqual(['F2', 'X', 'F1', 'O2', 'O1']);

    const layout = await call('add_effect', { layoutName: 'Layout 1', effectId: 'glowhorizontal', name: 'Dim' });
    expect(layout.success).toBe(true);
    await call('add_effect', { layoutName: 'Layout 1', effectId: 'glowhorizontal', name: 'Blur' });
    expect((await call('reorder_effects', { layoutName: 'Layout 1', names: ['Blur', 'Dim'] })).effects).toEqual(['Blur', 'Dim']);
    expect((await layoutOf()).effectTypes!.map(e => e.name)).toEqual(['Blur', 'Dim']);
  });

  it('refuses names that are not a permutation of the holder\'s effects, naming the current order', async () => {
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('A'), glow('B')]; });
    const before = await snapshot();
    for (const names of [['A'], ['A', 'A'], ['A', 'b'], ['A', 'B', 'C']]) {
      const data = await call('reorder_effects', { objectName: 'Sprite', names });
      expect(data.text).toContain('Current order: "A", "B".');
      expect(data.text).toContain('Nothing was changed.');
    }
    expect(await snapshot()).toEqual(before);
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('A'), glow('A')]; });
    const duplicated = await snapshot();
    expect((await call('reorder_effects', { objectName: 'Sprite', names: ['A', 'A'] })).text).toContain('share a name ("A")');
    expect(await snapshot()).toEqual(duplicated);
  });
});

describe('a holder whose effectTypes holds an entry that is no record with a name', () => {
  // Hand-edited files: add_effect, remove_effect and reorder_effects would drop an entry or write the wrong ones
  const malformed: Array<[string, unknown[]]> = [
    ['an entry without a name', [{ effectId: 'glowhorizontal' }, glow('A'), glow('B')]],
    ['an entry that is not a record', [glow('A'), 'stray', glow('B')]],
  ];
  for (const [title, stack] of malformed) {
    it(`refuses add_effect, remove_effect and reorder_effects for ${title}, changing nothing`, async () => {
      await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = stack as unknown as EffectEntry[]; });
      await giveInstance(0, { A: state({ n: 1 }), B: state({ n: 2 }) });
      const before = await snapshot();
      const calls: Array<[string, Record<string, unknown>]> = [
        ['add_effect', { objectName: 'Sprite', effectId: 'fogexponential', name: 'Fog' }],
        ['remove_effect', { objectName: 'Sprite', name: 'A' }],
        ['reorder_effects', { objectName: 'Sprite', names: ['B', 'A'] }],
      ];
      for (const [tool, args] of calls) {
        const data = await call(tool, args);
        expect(data.isError, tool).toBe(true);
        expect(data.text, tool).toContain('is not a record with a name');
        expect(data.text, tool).toContain('rename or remove it in the Construct 3 editor first. Nothing was changed.');
      }
      expect(await snapshot()).toEqual(before);
    });
  }

  it('refuses the same for a layer, and for an effectTypes that is not a list', async () => {
    await editLayout(l => { l.layers[1].effectTypes = ['stray', layerEntry('Blur')] as unknown as EffectEntry[]; });
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = 'oops' as unknown as EffectEntry[]; });
    const before = await snapshot();
    const layer = await call('reorder_effects', { layoutName: 'Layout 1', layerName: 'HUD', names: ['Blur'] });
    expect(layer.text).toContain('is not a record with a name');
    expect(layer.text).toContain('Nothing was changed.');
    const object = await call('add_effect', { objectName: 'Sprite', effectId: 'fogexponential', name: 'Fog' });
    expect(object.text).toContain('is not a list');
    expect(object.text).toContain('Nothing was changed.');
    expect(await snapshot()).toEqual(before);
  });
});

describe('update_effect guards', () => {
  it('refuses an instance of another object type, even one that holds an entry of that name, and changes nothing', async () => {
    expect((await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' })).success).toBe(true);
    const placed = await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 0, y: 0 });
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow')]; });
    await editLayout(l => { l.layers[0].instances.find(i => i.uid === placed.generatedUid)!.effects = { Glow: state({ a: 1 }) }; });
    const before = await snapshot();
    const data = await call('update_effect', {
      objectName: 'Sprite', name: 'Glow', instanceLayoutName: 'Layout 1', instanceUid: placed.generatedUid, parameters: { a: 9 },
    });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('is a "Sprite2", not an instance of "Sprite"');
    expect(data.text).toContain('Nothing was changed.');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a layout that is listed but cannot be read, saying nothing was changed', async () => {
    await addLayout2();
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow')]; });
    await writeFile(path('layouts', 'Layout 2.json'), '{ "name": "Layout 2", "layers": [ <<<<');
    const before = await snapshot();
    const data = await call('update_effect', {
      objectName: 'Sprite', name: 'Glow', instanceLayoutName: 'Layout 2', instanceUid: 7, parameters: { a: 9 },
    });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('Layout "Layout 2" could not be read');
    expect(data.text).toContain('Nothing was changed.');
    expect(await snapshot()).toEqual(before);
  });

  it('describes its single-file write, not the layouts-then-holder order of the other tools', () => {
    const description = server.getTool('update_effect')!.description;
    expect(description).toContain('written to one layout file');
    expect(description).not.toContain('holder\'s file last');
  });
});

describe('remove_effect of an object type whose family keeps an effect of that name', () => {
  it('goes through without a use check or an unparsed-sheet search, and keeps the instance entry', async () => {
    await addFamily('Glowers', ['Sprite'], [glow('Glow')]);
    // A hand edit: add_effect would refuse the same name on the object type
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('Glow')]; });
    await giveInstance(0, { Glow: state({ a: 1 }) });
    await setActions({ objectClass: 'Sprite', effect: '"Glow"' });
    await addBrokenSheet('{ "name": "Broken", "events": [ Sprite Glow');
    const data = await call('remove_effect', { objectName: 'Sprite', name: 'Glow' });
    expect(data).toMatchObject({ success: true, action: 'updated', category: 'object', effects: [] });
    expect(data.unscannedFiles).toBeUndefined();
    expect(await effectsOf('objectTypes/Sprite.json')).toEqual([]);
    expect(await effectsOf('families/Glowers.json')).toEqual([glow('Glow')]);
    expect((await instanceOf(0)).effects).toEqual({ Glow: state({ a: 1 }) });
  });

  it('says so in its description', () => {
    expect(server.getTool('remove_effect')!.description)
      .toContain('object type\'s effect that one of its families also has is not checked');
  });
});

describe('unchanged results', () => {
  it('every unchanged result writes nothing and has no editorNote', async () => {
    await editHolder('objectTypes/Sprite.json', o => { o.effectTypes = [glow('A'), glow('B')]; });
    await editLayout(l => { l.layers[1].effectTypes = [layerEntry('Shade', { a: 1 })]; });
    await giveInstance(0, { A: state({ a: 1 }), B: state() });
    const before = await snapshot();
    const results = [
      await call('reorder_effects', { objectName: 'Sprite', names: ['A', 'B'] }),
      await call('update_effect', { layoutName: 'Layout 1', layerName: 'HUD', name: 'Shade', isEnabled: true, parameters: { a: 1 } }),
      await call('update_effect', { objectName: 'Sprite', name: 'A', instanceLayoutName: 'Layout 1', instanceUid: 0, parameters: { a: 1 } }),
    ];
    for (const data of results) {
      expect(data).toMatchObject({ success: true, action: 'unchanged' });
      expect(data.editorNote).toBeUndefined();
      expect(data.backupFile).toBeUndefined();
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('when a write fails', () => {
  it('rolls back the layouts written before when a later layout write fails, before the holder is written', async () => {
    await addLayout2();
    const before = await contents();
    const write = writer.writeEntityFile.bind(writer);
    let layouts = 0;
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'layouts' && ++layouts === 2) throw new Error('disk full');
      return write(category, ...rest);
    };
    const data = await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'Glow' });
    expect(data.text).toContain('disk full. The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(await contents()).toEqual(before);
  });

  it('leaves a layout an editor saved after its failed write as it is, names it, and puts back the rest', async () => {
    await addLayout2();
    const before = await contents();
    const saved = JSON.stringify({ ...(await layoutOf('Layout 2')), width: 4321 }, null, '\t');
    const internals = writer as unknown as { verifyWrittenFile: (file: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (file, name, text) => {
      if (file.endsWith('Layout 2.json')) {
        await writeFile(path('layouts', 'Layout 2.json'), saved);
        throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      }
      return verify(file, name, text);
    };
    const data = await call('add_effect', { objectName: 'Sprite', effectId: 'glowhorizontal', name: 'Glow' });
    expect(data.text).toContain('left as it is: layouts/Layout 2.json (another write changed it after this call\'s write failed; '
      + 'its state from before the call is in layouts/Layout 2.json.bak)');
    expect(await readFile(path('layouts', 'Layout 2.json'), 'utf8')).toBe(saved);
    const after = await contents();
    expect(after['objectTypes/Sprite.json']).toBeDefined();
    expect(after['objectTypes/Sprite.json']).toBe(before['objectTypes/Sprite.json']);
    expect(after['layouts/Layout 1.json']).toBe(before['layouts/Layout 1.json']);
  });
});
