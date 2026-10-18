/**
 * reorder_behaviors (#ISSUE): the behaviors of an object type or family in
 * a new order, and on placed instances the entries of those behaviors,
 * among the places they hold (each owner's entries are saved in its
 * behaviorTypes order, instance-behaviors.ts); entries of another family
 * and for another name stay where they are. Synthetic data on a temp copy
 * of the minimal fixture, with the real reader and writer.
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
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface InstanceJson { uid: number; behaviors: Record<string, unknown>; [key: string]: unknown }
interface LayoutFile { layers: Array<{ instances: InstanceJson[] }>; [key: string]: unknown }
interface ToolData { isError?: boolean; text?: string; success?: boolean; action?: string; editorNote?: string; warnings?: string[]; [key: string]: unknown }

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
const instance0 = async () => (await readJson<LayoutFile>(path('layouts', 'Layout 1.json'))).layers[0].instances[0];
const behaviorNames = async (file: string) => (await readJson<{ behaviorTypes: Array<{ name: string }> }>(file)).behaviorTypes.map(b => b.name);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-behavior-order-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(path('project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerObjectTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
  await call('update_object_properties', {
    name: 'Sprite',
    addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }, { behaviorId: 'Fade', name: 'Fade' }, { behaviorId: 'Pin', name: 'Pin' }],
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('reorder_behaviors', () => {
  it('reorders an object type\'s behaviors and the entries of its placed instances, keeping their values', async () => {
    const entriesBefore = (await instance0()).behaviors;
    const data = await call('reorder_behaviors', { objectName: 'Sprite', order: ['Pin', 'Platform', 'Fade'] });
    expect(data.action).toBe('updated');
    expect(await behaviorNames(path('objectTypes', 'Sprite.json'))).toEqual(['Pin', 'Platform', 'Fade']);
    const entries = (await instance0()).behaviors;
    expect(Object.keys(entries)).toEqual(['Pin', 'Platform', 'Fade']);
    expect(entries).toEqual(entriesBefore);
  });

  it('leaves an instance\'s entry for another name where it is', async () => {
    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    const entries = layout.layers[0].instances[0].behaviors;
    layout.layers[0].instances[0].behaviors = { Platform: entries.Platform, Old: { properties: {} }, Fade: entries.Fade, Pin: entries.Pin };
    await writeFile(path('layouts', 'Layout 1.json'), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    await call('reorder_behaviors', { objectName: 'Sprite', order: ['Pin', 'Platform', 'Fade'] });
    expect(Object.keys((await instance0()).behaviors)).toEqual(['Pin', 'Old', 'Platform', 'Fade']);
  });

  it('reorders a family\'s entries on member instances and leaves the object\'s own and another family\'s where they are', async () => {
    // Instance entries seeded in the old order, so only orderInstanceBehaviors can make the new one (no backfill)
    await call('create_family', { name: 'Enemies', pluginId: 'Sprite', members: ['Sprite'] });
    await call('create_family', { name: 'Movers', pluginId: 'Sprite', members: ['Sprite'] });
    for (const [name, behaviors] of [
      ['Enemies', [{ behaviorId: 'Sin', name: 'Sine', sid: 610000000000001 }, { behaviorId: 'Rotate', name: 'Spin', sid: 610000000000002 }]],
      ['Movers', [{ behaviorId: 'Bullet', name: 'Shot', sid: 610000000000003 }, { behaviorId: 'Orbit', name: 'Loop', sid: 610000000000004 }]],
    ] as const) {
      const family = await readJson<Record<string, unknown>>(path('families', `${name}.json`));
      family.behaviorTypes = behaviors;
      await writeFile(path('families', `${name}.json`), JSON.stringify(family, null, '\t'));
    }
    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    const own = layout.layers[0].instances[0].behaviors;
    const entry = { properties: {} };
    layout.layers[0].instances[0].behaviors = { Loop: entry, Sine: entry, Shot: entry, Spin: entry, ...own };
    await writeFile(path('layouts', 'Layout 1.json'), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
    const data = await call('reorder_behaviors', { familyName: 'Enemies', order: ['Spin', 'Sine'] });
    expect(await behaviorNames(path('families', 'Enemies.json'))).toEqual(['Spin', 'Sine']);
    // Enemies' two slots (1 and 3) get Spin, Sine; Movers' Loop and Shot and the own entries keep their places
    expect(Object.keys((await instance0()).behaviors)).toEqual(['Loop', 'Spin', 'Shot', 'Sine', 'Platform', 'Fade', 'Pin']);
    expect((data.warnings ?? []).join(' ')).not.toContain('Also added default entries');
  });

  it('refuses an owner whose behaviors share a name, naming it', async () => {
    const file = path('objectTypes', 'Sprite.json');
    const object = await readJson<{ behaviorTypes: Array<Record<string, unknown>> }>(file);
    object.behaviorTypes.push({ ...object.behaviorTypes[1] });
    await writeFile(file, JSON.stringify(object, null, '\t'));
    await reader.loadProject();
    const data = await call('reorder_behaviors', { objectName: 'Sprite', order: ['Pin', 'Platform', 'Fade'] });
    expect(data.text).toContain('Behaviors of "Sprite" share a name ("Fade"): rename one in the Construct 3 editor first. Nothing was changed.');
  });

  it('refuses an order that leaves out, repeats or adds a behavior, and changes nothing', async () => {
    const before = await readFile(path('objectTypes', 'Sprite.json'), 'utf8');
    for (const order of [['Pin', 'Platform'], ['Pin', 'Platform', 'Fade', 'Pin'], ['Pin', 'Platform', 'Fade', 'Timer']]) {
      const data = await call('reorder_behaviors', { objectName: 'Sprite', order });
      expect(data.text).toContain('order must list every behavior of "Sprite" exactly once');
      expect(data.text).toContain('Current order: "Platform", "Fade", "Pin". Nothing was changed.');
    }
    expect(await readFile(path('objectTypes', 'Sprite.json'), 'utf8')).toBe(before);
  });

  it('reports the order it has as unchanged and writes nothing', async () => {
    const filesBefore = (await readdir(path('objectTypes'))).sort();
    const data = await call('reorder_behaviors', { objectName: 'Sprite', order: ['Platform', 'Fade', 'Pin'] });
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect((await readdir(path('objectTypes'))).sort()).toEqual(filesBefore);
  });

  it('rolls back the layout when the object type write, which comes last, fails', async () => {
    const objectBefore = await readFile(path('objectTypes', 'Sprite.json'), 'utf8');
    const layoutBefore = await readFile(path('layouts', 'Layout 1.json'), 'utf8');
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'objectTypes') throw new Error('disk full');
      return write(category, ...rest);
    };
    const data = await call('reorder_behaviors', { objectName: 'Sprite', order: ['Pin', 'Platform', 'Fade'] });
    expect(data.text).toContain('disk full. The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(await readFile(path('objectTypes', 'Sprite.json'), 'utf8')).toBe(objectBefore);
    expect(await readFile(path('layouts', 'Layout 1.json'), 'utf8')).toBe(layoutBefore);
  });
});
