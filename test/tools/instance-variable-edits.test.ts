/**
 * update_instance_variable (#ISSUE): renaming an instance variable of an
 * object type or family moves every placed instance's value to the new
 * name, in place; a rename events use is refused without force, as removing
 * the variable is, also when only an event sheet that could not be parsed
 * possibly uses it; a case-only rename breaks no use; a type change gives
 * the values that do not fit the default and lists them; a failure rolls
 * back the object file and the layouts the call wrote. Synthetic data on a
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
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface InstanceJson { uid: number; type: string; instanceVariables: Record<string, unknown>; [key: string]: unknown }
interface LayoutFile { name: string; layers: Array<{ instances: InstanceJson[]; [key: string]: unknown }>; [key: string]: unknown }
interface VariableJson { name: string; type: string; desc?: string; [key: string]: unknown }
interface ToolData {
  isError?: boolean; text?: string; success?: boolean; action?: string; message?: string; warnings?: string[]; editorNote?: string;
  variable?: string; previousName?: string; type?: string; unscannedFiles?: unknown[]; [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const path = (...parts: string[]) => join(tmpDir, ...parts);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const valuesOf = async (uid: number, layout = 'Layout 1') =>
  (await readJson<LayoutFile>(path('layouts', `${layout}.json`))).layers[0].instances.find(i => i.uid === uid)!.instanceVariables;
const variablesOf = async (file: string) => (await readJson<{ instanceVariables: VariableJson[] }>(file)).instanceVariables;
const files = ['objectTypes/Sprite.json', 'layouts/Layout 1.json', 'layouts/Layout 2.json'];
async function contents(): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const file of files) out[file] = await readFile(path(file), 'utf8').catch(() => undefined);
  return out;
}

/** "Layout 2": one Sprite instance, UID 7, with values for hp and label. */
async function addLayout2(): Promise<void> {
  const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
  layout.name = 'Layout 2';
  layout.layers[0].instances = [{ ...layout.layers[0].instances[0], uid: 7, sid: 500000000000077, instanceVariables: { hp: 1, label: 'minion' } }];
  await writeFile(path('layouts', 'Layout 2.json'), JSON.stringify(layout, null, '\t'));
  const project = await readJson<{ layouts: { items: string[] } }>(path('project.c3proj'));
  project.layouts.items.push('Layout 2');
  await writeFile(path('project.c3proj'), JSON.stringify(project, null, '\t'));
  await reader.loadProject();
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-ivar-edits-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(path('project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerObjectTools({ server, reader, writer, idGen } as never);
  registerLayoutTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
  await call('update_object_properties', { name: 'Sprite', addVariables: [{ name: 'hp', type: 'number' }, { name: 'label', type: 'string' }] });
  await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { hp: 5, label: 'boss' } });
  // An event that compares Sprite's hp: a use of "hp"
  const sheet = await readJson<{ events: Array<{ conditions: unknown[] }> }>(path('eventSheets', 'MainSheet.json'));
  sheet.events[0].conditions.push({ id: 'compare-instance-variable', objectClass: 'Sprite', sid: 400000000000010, parameters: { 'instance-variable': 'hp', comparison: 0, value: '0' } });
  await writeFile(path('eventSheets', 'MainSheet.json'), JSON.stringify(sheet, null, '\t'));
  await reader.loadProject();
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('update_instance_variable: rename', () => {
  it('renames an object type\'s variable and moves every instance\'s value to the new name, in place', async () => {
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newName: 'title' });
    expect(data).toMatchObject({ success: true, variable: 'title', previousName: 'label', type: 'string' });
    expect((await variablesOf(path('objectTypes', 'Sprite.json'))).map(v => v.name)).toEqual(['hp', 'title']);
    const values = await valuesOf(0);
    expect(Object.keys(values)).toEqual(['hp', 'title']);
    expect(values).toEqual({ hp: 5, title: 'boss' });
  });

  it('refuses a rename events use, lists the uses, and changes nothing', async () => {
    const before = await contents();
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'hp', newName: 'health' });
    expect(data.success).toBe(false);
    expect(data.action).toBe('update_blocked');
    expect(data.message).toContain('Events use the instance variable this update renames: instance variable "hp" used 1 time(s) (1 condition) in events of "MainSheet".');
    expect(data.message).toContain('Nothing was changed. Use force=true to rename anyway');
    expect(await contents()).toEqual(before);
  });

  it('renames a used variable with force and says the uses were not changed', async () => {
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'hp', newName: 'health', force: true });
    expect(data.success).toBe(true);
    expect((data.warnings ?? []).join(' ')).toContain('Renamed although events still use it');
    expect(await valuesOf(0)).toEqual({ health: 5, label: 'boss' });
  });

  it('renames a used variable when only its letter case changes, and warns about scripts that read the old spelling', async () => {
    // A script action that reads instVars.hp: script property names are case-sensitive (see scriptReadWarnings in object-tools.ts)
    const sheet = await readJson<{ events: Array<{ actions: unknown[] }> }>(path('eventSheets', 'MainSheet.json'));
    sheet.events[0].actions.push({ type: 'script', language: 'javascript', script: ['const v = runtime.objects.Sprite.getFirstInstance().instVars.hp;'] });
    await writeFile(path('eventSheets', 'MainSheet.json'), JSON.stringify(sheet, null, '\t'));
    await reader.loadProject();
    resetProjectIndex();
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'hp', newName: 'HP' });
    expect(data.success).toBe(true);
    expect(await valuesOf(0)).toEqual({ HP: 5, label: 'boss' });
    expect((data.warnings ?? []).join(' ')).toContain('Scripts read instance variable "hp" by name (instVars.hp)');
    expect((data.warnings ?? []).join(' ')).toContain('script names are case-sensitive, so they will not find "HP"');
  });

  it('reports a call that changes nothing as unchanged and writes nothing', async () => {
    const before = await contents();
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'hp', newName: 'hp', newType: 'number' });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect(await contents()).toEqual(before);
  });

  it('refuses a name another variable of the instances has, ignoring case, and changes nothing', async () => {
    const before = await contents();
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newName: 'HP' });
    expect(data.text).toContain('"Sprite" already has an instance variable "hp" (its own or a family\'s), and events match instance variable names ignoring case. Choose another name. Nothing was changed.');
    expect(await contents()).toEqual(before);
  });

  it('refuses a rename that an event sheet the server could not parse possibly uses', async () => {
    await writeFile(path('eventSheets', 'Broken.json'), '{ "name": "Broken", "events": [ Sprite label');
    const project = await readJson<{ eventSheets: { items: string[] } }>(path('project.c3proj'));
    project.eventSheets.items.push('Broken');
    await writeFile(path('project.c3proj'), JSON.stringify(project, null, '\t'));
    await reader.loadProject();
    resetProjectIndex();
    const before = await contents();
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newName: 'title' });
    expect(data.action).toBe('update_blocked');
    expect(data.unscannedFiles).toBeDefined();
    expect(await contents()).toEqual(before);
  });

  it('renames a family variable on the instances of every member', async () => {
    await call('create_object', { name: 'Sprite2', pluginId: 'Sprite' });
    const placed = await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite2', x: 0, y: 0 });
    await call('create_family', { name: 'Enemies', pluginId: 'Sprite', members: ['Sprite', 'Sprite2'] });
    await call('update_family', { name: 'Enemies', addVariables: [{ name: 'speed', type: 'number' }] });
    await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { speed: 3 } });
    const data = await call('update_instance_variable', { familyName: 'Enemies', variableName: 'speed', newName: 'velocity' });
    expect(data.success).toBe(true);
    expect(await variablesOf(path('families', 'Enemies.json'))).toMatchObject([{ name: 'velocity' }]);
    const values = await valuesOf(0);
    expect(Object.keys(values)).toEqual(['velocity', 'hp', 'label']);
    expect(values.velocity).toBe(3);
    expect(await valuesOf(placed.generatedUid as number)).toEqual({ velocity: 0 });
  });

  it('refuses a family variable name that a member already has', async () => {
    await call('create_family', { name: 'Enemies', pluginId: 'Sprite', members: ['Sprite'] });
    await call('update_family', { name: 'Enemies', addVariables: [{ name: 'speed', type: 'number' }] });
    const data = await call('update_instance_variable', { familyName: 'Enemies', variableName: 'speed', newName: 'Hp' });
    expect(data.text).toContain('"Sprite" already has an instance variable "hp"');
  });

  it('refuses a family variable rename that events use through a member, lists the use, and writes nothing', async () => {
    await call('create_family', { name: 'Enemies', pluginId: 'Sprite', members: ['Sprite'] });
    await call('update_family', { name: 'Enemies', addVariables: [{ name: 'speed', type: 'number' }] });
    await call('update_instance', { layoutName: 'Layout 1', uid: 0, instanceVariables: { speed: 3 } });
    // A condition on Sprite, a member of the family, that compares the family's variable
    const sheet = await readJson<{ events: Array<{ conditions: unknown[] }> }>(path('eventSheets', 'MainSheet.json'));
    sheet.events[0].conditions.push({ id: 'compare-instance-variable', objectClass: 'Sprite', sid: 400000000000011, parameters: { 'instance-variable': 'speed', comparison: 0, value: '0' } });
    await writeFile(path('eventSheets', 'MainSheet.json'), JSON.stringify(sheet, null, '\t'));
    await reader.loadProject();
    resetProjectIndex();
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const file of (await readdir(tmpDir, { recursive: true })).map(String).sort()) {
        out[file] = await readFile(path(file), 'utf8').catch(() => '(directory)');
      }
      return out;
    };
    const before = await snapshot();
    const data = await call('update_instance_variable', { familyName: 'Enemies', variableName: 'speed', newName: 'velocity' });
    expect(data.success).toBe(false);
    expect(data.action).toBe('update_blocked');
    expect(data.message).toContain('Events use the instance variable this update renames:');
    expect(data.message).toContain('"speed"');
    expect(data.message).toContain('MainSheet');
    expect(data.references).toMatchObject({ eventSheets: ['MainSheet'] });
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(Object.keys(after).filter(f => f.endsWith('.bak'))).toEqual(Object.keys(before).filter(f => f.endsWith('.bak')));
  });
});

describe('update_instance_variable: type and description', () => {
  it('changes the type and gives values that do not fit the default, listing the ones it replaced', async () => {
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newType: 'number' });
    expect(data.type).toBe('number');
    expect((await variablesOf(path('objectTypes', 'Sprite.json'))).find(v => v.name === 'label')?.type).toBe('number');
    expect((await valuesOf(0)).label).toBe(0);
    expect((data.warnings ?? []).join(' ')).toContain('Replaced 1 instance variable value(s) that do not fit the new type with the default');
    expect((data.warnings ?? []).join(' ')).toContain('"Layout 1" UID 0 instance variable "label" = "boss"');
  });

  it('warns that events using a retyped variable are not checked', async () => {
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'hp', newType: 'string' });
    expect((data.warnings ?? []).join(' ')).toContain('they were written for a number value, and whether they work with a string value is not checked: review them.');
  });

  it('changes the description and writes no layout', async () => {
    const write = writer.writeEntityFile.bind(writer);
    const written: string[] = [];
    writer.writeEntityFile = async (category, ...rest) => {
      written.push(category);
      return write(category, ...rest);
    };
    await call('update_instance_variable', { objectName: 'Sprite', variableName: 'hp', description: 'Hit points' });
    expect((await variablesOf(path('objectTypes', 'Sprite.json'))).find(v => v.name === 'hp')?.desc).toBe('Hit points');
    expect(written).toEqual(['objectTypes']);
  });

  it('refuses no owner or two, an unknown variable and an owner in another letter case', async () => {
    expect((await call('update_instance_variable', { variableName: 'hp', newName: 'x' })).text).toContain('Give exactly one of objectName and familyName.');
    expect((await call('update_instance_variable', { objectName: 'Sprite', variableName: 'HP', newName: 'x' })).text)
      .toContain('"Sprite" has no instance variable "HP" (names are matched with their letter case). Its instance variables: "hp", "label".');
    expect((await call('update_instance_variable', { objectName: 'sprite', variableName: 'hp', newName: 'x' })).text)
      .toContain('names are matched with their letter case. Did you mean "Sprite"?');
  });
});

describe('update_instance_variable when a write fails', () => {
  it('rolls back the layouts written before when a later layout write fails, before the owner is written', async () => {
    await addLayout2();
    const before = await contents();
    const write = writer.writeEntityFile.bind(writer);
    let layouts = 0;
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'layouts' && ++layouts === 2) throw new Error('disk full');
      return write(category, ...rest);
    };
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newName: 'title' });
    expect(data.text).toContain('disk full. The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(await contents()).toEqual(before);
  });

  it('rolls back every layout when the owner write, which comes last, fails', async () => {
    await addLayout2();
    const before = await contents();
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'objectTypes') throw new Error('disk full');
      return write(category, ...rest);
    };
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newName: 'title' });
    expect(data.text).toContain('disk full. The call was rolled back: layouts/Layout 2.json, layouts/Layout 1.json are as before the call.');
    expect(await contents()).toEqual(before);
  });

  it('finishes a rename that a stopped call left half done when run again', async () => {
    // The layouts hold "title", the object type still "label": what a process stopped between the two leaves
    await addLayout2();
    for (const name of ['Layout 1', 'Layout 2']) {
      const layout = await readJson<LayoutFile>(path('layouts', `${name}.json`));
      for (const inst of layout.layers[0].instances) {
        inst.instanceVariables = Object.fromEntries(Object.entries(inst.instanceVariables).map(([k, v]) => [k === 'label' ? 'title' : k, v]));
      }
      await writeFile(path('layouts', `${name}.json`), JSON.stringify(layout, null, '\t'));
    }
    await reader.loadProject();
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newName: 'title' });
    expect(data.success).toBe(true);
    expect((await variablesOf(path('objectTypes', 'Sprite.json'))).map(v => v.name)).toEqual(['hp', 'title']);
    expect(await valuesOf(0)).toEqual({ hp: 5, title: 'boss' });
    expect(await valuesOf(7, 'Layout 2')).toEqual({ hp: 1, title: 'minion' });
  });

  it('leaves a layout an editor saved after its failed write as it is, names it, and puts back the rest', async () => {
    await addLayout2();
    const before = await contents();
    const saved = JSON.stringify({ ...(await readJson<LayoutFile>(path('layouts', 'Layout 2.json'))), width: 4321 }, null, '\t');
    const internals = writer as unknown as { verifyWrittenFile: (file: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (file, name, text) => {
      if (file.endsWith('Layout 2.json')) {
        await writeFile(path('layouts', 'Layout 2.json'), saved);
        throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      }
      return verify(file, name, text);
    };
    const data = await call('update_instance_variable', { objectName: 'Sprite', variableName: 'label', newName: 'title' });
    expect(data.text).toContain('left as it is: layouts/Layout 2.json (another write changed it after this call\'s write failed; '
      + 'its state from before the call is in layouts/Layout 2.json.bak)');
    expect(await readFile(path('layouts', 'Layout 2.json'), 'utf8')).toBe(saved);
    expect((await contents())['objectTypes/Sprite.json']).toBe(before['objectTypes/Sprite.json']);
    expect((await contents())['layouts/Layout 1.json']).toBe(before['layouts/Layout 1.json']);
  });
});
