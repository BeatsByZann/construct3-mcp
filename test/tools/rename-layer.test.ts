/**
 * rename_layer (#ISSUE): renames a layer in several layouts in one call and
 * points the "layer" parameters that are exactly its quoted old name at the
 * new name when every layout with a layer of that name is renamed; dryRun
 * reports and writes nothing; a failure rolls back what the call wrote and
 * never overwrites another write. Synthetic data on a temp copy of the
 * minimal fixture ("Layout 1" with layer "Main", event sheet "MainSheet"),
 * with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerLayerRenameTools } from '../../src/tools/layer-rename.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { ConcurrentWriteError } from '../../src/construct3/project-writer.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const ALL = ['Layout 1', 'Layout 2', 'Layout 3'];

interface LayerJson { name: string; sid?: number; instances: unknown[]; subLayers?: LayerJson[]; [key: string]: unknown }
interface LayoutFile { name: string; width?: number; layers: LayerJson[]; [key: string]: unknown }
interface ActionJson { sid?: number; id?: string; objectClass?: string; parameters?: Record<string, string>; [key: string]: unknown }
interface SheetFile { events: Array<{ actions: ActionJson[]; [key: string]: unknown }>; [key: string]: unknown }
interface ProjectFile { layouts: { items: string[] }; [key: string]: unknown }
interface ToolData {
  isError?: boolean; text?: string; success?: boolean; dryRun?: boolean; action?: string; editorNote?: string;
  layouts?: string[]; filesWritten?: string[]; wouldWrite?: string[]; warnings?: string[]; [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');
const layoutPath = (name = 'Layout 1') => join(tmpDir, 'layouts', `${name}.json`);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const rename = (layoutNames: string[], newName: string, extra: Record<string, unknown> = {}) =>
  call('rename_layer', { layoutNames, layerName: 'Main', newName, ...extra });
const layerOf = async (name = 'Layout 1') => (await readJson<LayoutFile>(layoutPath(name))).layers[0].name;
const layerParams = async () => (await readJson<SheetFile>(sheetPath())).events[0].actions.slice(1).map(a => a.parameters?.layer);

/** Another layout `name`: a copy of "Layout 1" without instances, whose first layer is `layerName`, and more layers named `extra`. */
async function addLayout(name: string, layerName: string, extra: string[] = []): Promise<void> {
  const other = await readJson<LayoutFile>(layoutPath());
  other.name = name;
  other.layers[0].name = layerName;
  other.layers[0].instances = [];
  other.layers.push(...extra.map((layer, i) => ({ ...structuredClone(other.layers[0]), name: layer, sid: 530000000000000 + i })));
  await writeFile(layoutPath(name), JSON.stringify(other, null, '\t'));
  const project = await readJson<ProjectFile>(join(tmpDir, 'project.c3proj'));
  project.layouts.items.push(name);
  await writeFile(join(tmpDir, 'project.c3proj'), JSON.stringify(project, null, '\t'));
  await reader.loadProject();
}

/** Actions of the sheet's first event, after its set-position action. */
async function addActions(actions: ActionJson[]): Promise<void> {
  const sheet = await readJson<SheetFile>(sheetPath());
  sheet.events[0].actions.push(...actions.map((a, i) => ({ sid: 400000000000100 + i, ...a })));
  await writeFile(sheetPath(), JSON.stringify(sheet, null, '\t'));
  await reader.loadProject();
}

/** Content of every entity JSON file and project.c3proj (no .bak). */
async function contents(): Promise<Record<string, string>> {
  const out: Record<string, string> = { 'project.c3proj': await readFile(join(tmpDir, 'project.c3proj'), 'utf8') };
  for (const folder of ['layouts', 'eventSheets']) {
    for (const file of await readdir(join(tmpDir, folder))) {
      if (file.endsWith('.json')) out[`${folder}/${file}`] = await readFile(join(tmpDir, folder, file), 'utf8');
    }
  }
  return out;
}

/** Every file name in the project folder and its entity folders, .bak included. */
async function fileNames(): Promise<string[]> {
  const names = [...await readdir(tmpDir)];
  for (const folder of ['layouts', 'eventSheets', 'objectTypes']) names.push(...(await readdir(join(tmpDir, folder))).map(f => `${folder}/${f}`));
  return names.sort();
}

const LAYER_ACTIONS: ActionJson[] = [
  { id: 'create-object', objectClass: 'System', parameters: { 'object-to-create': 'Sprite', layer: '"Main"', x: '0', y: '0' } },
  { id: 'move-to-layer', objectClass: 'Sprite', parameters: { layer: ' "main" ' } },
  { id: 'set-layer-visible', objectClass: 'System', parameters: { layer: '"Main"', visibility: 'visible' } },
];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-rename-layer-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as never);
  registerLayerRenameTools({ server, reader, writer, idGen } as never);
  await addActions(LAYER_ACTIONS);
  await addLayout('Layout 2', 'MAIN');
  await addLayout('Layout 3', 'Main');
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('rename_layer', () => {
  it('renames the layer in every listed layout and points the layer parameters at the new name', async () => {
    const data = await rename(ALL, 'Game');
    expect(data.success).toBe(true);
    expect([await layerOf(), await layerOf('Layout 2'), await layerOf('Layout 3')]).toEqual(['Game', 'Game', 'Game']);
    expect(await layerParams()).toEqual(['"Game"', ' "Game" ', '"Game"']);
    expect(data.layouts).toEqual(ALL);
    expect(data.filesWritten).toEqual(['layouts/Layout 1.json', 'layouts/Layout 2.json', 'layouts/Layout 3.json', 'eventSheets/MainSheet.json']);
    expect((data.warnings ?? []).join(' ')).toContain('Pointed 3 "layer" parameter(s) that named "Main" at "Game"');
  });

  it('lists the layer parameters without changing them while a layout not in the list has a layer of the old name', async () => {
    const data = await rename(['Layout 1', 'Layout 3'], 'Game');
    expect(data.success).toBe(true);
    expect(await layerOf('Layout 2')).toBe('MAIN');
    expect(await layerParams()).toEqual(['"Main"', ' "main" ', '"Main"']);
    expect((data.warnings ?? []).join(' ')).toContain('3 "layer" parameter(s) name "Main" and were NOT changed: layout(s) "Layout 2" has a layer of that name too');
    expect(data.filesWritten).toEqual(['layouts/Layout 1.json', 'layouts/Layout 3.json']);
  });

  it('dryRun reports the files and the references and writes nothing', async () => {
    const before = await contents();
    const namesBefore = await fileNames();
    const data = await rename(ALL, 'Game', { dryRun: true });
    expect(data.dryRun).toBe(true);
    expect(data.action).toBe('rename_preview');
    expect(data.wouldWrite).toEqual(['layouts/Layout 1.json', 'layouts/Layout 2.json', 'layouts/Layout 3.json', 'eventSheets/MainSheet.json']);
    expect((data.warnings ?? []).join(' ')).toContain('Would point 3 "layer" parameter(s) that named "Main" at "Game"');
    expect(data.editorNote).toBeUndefined();
    expect(await contents()).toEqual(before);
    expect(await fileNames()).toEqual(namesBefore);
  });

  it('refuses before writing anything when a listed layout has no such layer', async () => {
    await addLayout('Layout 4', 'HUD');
    const before = await contents();
    const data = await rename(['Layout 1', 'Layout 4'], 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('Layer "Main" not found in layout "Layout 4"');
    expect(data.text).toContain('Nothing was changed.');
    expect(await contents()).toEqual(before);
  });

  it('refuses before writing anything when the new name is taken in one of the layouts', async () => {
    await addLayout('Layout 5', 'Main', ['Game']);
    const before = await contents();
    const data = await rename(['Layout 1', 'Layout 5'], 'game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('layout "Layout 5"');
    expect(data.text).toContain('Nothing was changed.');
    expect(await contents()).toEqual(before);
  });

  it('renames a layout listed twice once, also in another letter case', async () => {
    const data = await rename(['Layout 1', 'layout 1', 'Layout 2', 'Layout 3'], 'Game');
    expect(data.success).toBe(true);
    expect(data.layouts).toEqual(ALL);
  });

  it('changes no event sheet when the rename only changes the letter case', async () => {
    const sheetBefore = await readFile(sheetPath(), 'utf8');
    const data = await rename(ALL, 'MAIN');
    expect(data.success).toBe(true);
    expect(data.layouts).toEqual(['Layout 1', 'Layout 3']);
    expect(await readFile(sheetPath(), 'utf8')).toBe(sheetBefore);
  });

  it('names the old name of a layout it renames, not of one listed first that already has the new name', async () => {
    // Layout 2's layer is "MAIN" already; only Layout 1's "Main" changes
    const data = await rename(['Layout 2', 'Layout 1'], 'MAIN');
    expect(data.success).toBe(true);
    expect(data.entity).toBe('Main');
    expect(data.layouts).toEqual(['Layout 1']);
    expect(await layerOf()).toBe('MAIN');
  });

  it('refuses before writing anything when every listed layout has the layer under the new name already', async () => {
    const before = await contents();
    const data = await rename(['Layout 1', 'Layout 3'], 'Main');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The layer is already named "Main" in "Layout 1", "Layout 3". Nothing was changed.');
    expect(await contents()).toEqual(before);
  });

  it('refuses before writing anything when a listed layout does not exist', async () => {
    const before = await contents();
    const data = await rename(['Layout 1', 'No such layout'], 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('Layout "No such layout" not found.');
    expect(await contents()).toEqual(before);
  });

  it.each([false, true])('says nothing was changed when planning the event sheet changes fails before any write (dryRun %s)', async dryRun => {
    const before = await contents();
    const namesBefore = await fileNames();
    reader.readAllEventSheets = async () => { throw new Error('event sheets unreadable'); };
    const data = await rename(ALL, 'Game', { dryRun });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('Error renaming layer: event sheets unreadable. Nothing was changed.');
    expect(await contents()).toEqual(before);
    expect(await fileNames()).toEqual(namesBefore);
  });

  it('finds a sub-layer by its path', async () => {
    const layout = await readJson<LayoutFile>(layoutPath());
    layout.layers[0].subLayers = [{ ...structuredClone(layout.layers[0]), name: 'HUD', sid: 540000000000001, instances: [], subLayers: [] }];
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    reader.invalidateCaches();
    const data = await call('rename_layer', { layoutNames: ['Layout 1'], layerName: 'Main > HUD', newName: 'Overlay' });
    expect(data.success).toBe(true);
    expect((await readJson<LayoutFile>(layoutPath())).layers[0].subLayers?.[0].name).toBe('Overlay');
  });
});

describe('rename_layer when a write fails', () => {
  it('puts back the layouts written before when a later layout write fails', async () => {
    const before = await contents();
    const write = writer.writeEntityFile.bind(writer);
    let layouts = 0;
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'layouts' && ++layouts === 2) throw new Error('disk full');
      return write(category, ...rest);
    };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('disk full. The rename was rolled back: the layouts and the event sheets written before were restored from their backups.');
    expect(await contents()).toEqual(before);
  });

  it('says nothing was written, not that files were restored, when the first write fails', async () => {
    const before = await contents();
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    let writes = 0;
    internals.atomicWrite = async (path, content) => {
      if (writes++ === 0) throw new Error('disk full');
      return atomicWrite(path, content);
    };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toBe('Error renaming layer: disk full. Nothing was written before this failure and nothing was changed: '
      + 'the layouts and the event sheets are as they were before the call.');
    expect(data.text).not.toContain('restored');
    expect(data.text).not.toContain('rolled back');
    expect(await contents()).toEqual(before);
  });

  it('puts back every layout when the event sheet write fails', async () => {
    const before = await contents();
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'eventSheets') throw new Error('disk full');
      return write(category, ...rest);
    };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(await contents()).toEqual(before);
  });

  it('leaves a layout an editor saved after its failed write as it is, names it, and puts back the rest', async () => {
    // Layout 2's write replaces the file, then its read-back fails with an ordinary error,
    // and an editor save of Layout 2 lands before the rollback reaches it
    const layout1Before = await readFile(layoutPath(), 'utf8');
    const saved = JSON.stringify({ ...(await readJson<LayoutFile>(layoutPath('Layout 2'))), width: 4321 }, null, '\t');
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (path, name, text) => {
      if (path.endsWith('Layout 2.json')) {
        await writeFile(layoutPath('Layout 2'), saved);
        throw new Error(`Post-write verification failed for "${name}": the file could not be read back`);
      }
      return verify(path, name, text);
    };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(await readFile(layoutPath('Layout 2'), 'utf8')).toBe(saved);
    expect(data.text).toContain('layouts/Layout 2.json (another write changed it after this call\'s write failed; '
      + 'its state from before the call is in layouts/Layout 2.json.bak)');
    expect(await readFile(layoutPath(), 'utf8')).toBe(layout1Before);
    expect(await layerOf('Layout 3')).toBe('Main');
    expect((await layerParams())[0]).toBe('"Main"');
  });

  it('names the layout and its .bak when another write replaced it during its write, and puts back the rest', async () => {
    // The write of Layout 2 finds other valid JSON where it wrote (ConcurrentWriteError), a write from outside the server
    const layout1Before = await readFile(layoutPath(), 'utf8');
    const saved = JSON.stringify({ ...(await readJson<LayoutFile>(layoutPath('Layout 2'))), width: 4321 }, null, '\t');
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (path, name, text) => {
      if (path.endsWith('Layout 2.json')) {
        await writeFile(layoutPath('Layout 2'), saved);
        throw new ConcurrentWriteError(`Post-write verification failed for "${name}": the file was changed by another write during this one`);
      }
      return verify(path, name, text);
    };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('the file was changed by another write during this one');
    expect(data.text).toContain('The rename was rolled back only in part');
    expect(data.text).toContain('left as it is: layouts/Layout 2.json (another write changed it after this call\'s write failed; '
      + 'its state from before the call is in layouts/Layout 2.json.bak)');
    expect(await readFile(layoutPath('Layout 2'), 'utf8')).toBe(saved);
    expect(await readFile(layoutPath(), 'utf8')).toBe(layout1Before);
    expect(await layerOf('Layout 3')).toBe('Main');
    expect((await layerParams())[0]).toBe('"Main"');
  });

  it('names a layout it could not restore by its project-relative path', async () => {
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (path, name, text) => {
      if (path.endsWith('Layout 2.json')) throw new Error(`Post-write verification failed for "${name}": the file could not be read back`);
      return verify(path, name, text);
    };
    writer.restoreFailedWrite = async () => { throw new Error('EPERM'); };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('restoring failed for: layouts/Layout 2.json (the .bak file holds the previous JSON)');
    expect(data.text).not.toContain(tmpDir);
    expect(await layerOf()).toBe('Main');
  });

  it('rethrows a write refused as stale, which the writer has undone, without rolling back again', async () => {
    // An editor saves Layout 2 after the call read it and before the call writes it
    const layout1Before = await readFile(layoutPath(), 'utf8');
    const saved = JSON.stringify({ ...(await readJson<LayoutFile>(layoutPath('Layout 2'))), width: 4321 }, null, '\t');
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'layouts' && rest[0] === 'Layout 2') await writeFile(layoutPath('Layout 2'), saved);
      return write(category, ...rest);
    };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('layouts/Layout 2.json was changed on disk after this server read it');
    expect(data.text).toContain('were put back as they were before the call (layouts/Layout 1.json), so the call changed nothing');
    expect(data.text).not.toContain('The rename was rolled back');
    expect(await readFile(layoutPath('Layout 2'), 'utf8')).toBe(saved);
    expect(await readFile(layoutPath(), 'utf8')).toBe(layout1Before);
    expect(await layerOf('Layout 3')).toBe('Main');
  });

  it('leaves a layout the editor saved again after the call wrote it as it is, names it, and puts back the rest', async () => {
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'eventSheets') throw new Error('disk full');
      const backup = await write(category, ...rest);
      if (rest[0] === 'Layout 1') {
        const layout = await readJson<LayoutFile>(layoutPath());
        layout.width = 12345;
        await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
      }
      return backup;
    };
    const data = await rename(ALL, 'Game');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The rename was rolled back only in part');
    expect(data.text).toContain('layouts/Layout 1.json (its state from before the call is in layouts/Layout 1.json.bak)');
    expect((await readJson<LayoutFile>(layoutPath())).width).toBe(12345);
    expect(await layerOf('Layout 2')).toBe('MAIN');
    expect(await layerOf('Layout 3')).toBe('Main');
    expect((await layerParams())[0]).toBe('"Main"');
  });
});
