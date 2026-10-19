/**
 * duplicate_layout and duplicate_layer: a copy has fresh IDs and consistent
 * links, a refused call leaves every file as it was, and a failure midway
 * puts back what the call wrote. Checked on a temp copy of the synthetic
 * rename-project fixture with the real reader, writer and ID generator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerDuplicateTools } from '../../src/tools/duplicate-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

type Args = Record<string, unknown>;
type Obj = Record<string, unknown>;

interface Folder { name?: string; items: unknown[]; subfolders: Folder[] }
interface ProjectFile { layouts: Folder; eventSheets: Folder; [key: string]: unknown }
interface InstanceJson {
  type: string;
  uid: number;
  sid: number;
  instanceFolderItem?: { sid: number; expanded: boolean };
  sceneGraphData?: { uid: number; 'parent-uid': number | null; children?: Array<{ uid: number; flags?: Obj }>; flags?: Obj };
  template?: Obj;
  [key: string]: unknown;
}
interface LayerJson { name: string; sid: number; instances: InstanceJson[]; subLayers?: LayerJson[]; [key: string]: unknown }
interface LayoutJson {
  name: string;
  sid: number;
  eventSheet?: string;
  layers: LayerJson[];
  'nonworld-instances'?: InstanceJson[];
  'scene-graphs-folder-root'?: { items: Array<{ sid: number; expanded: boolean }>; subfolders: Array<{ items: Array<{ sid: number; expanded: boolean }>; subfolders: unknown[]; name: string }> };
  [key: string]: unknown;
}
interface ToolData {
  isError?: boolean;
  text?: string;
  success?: boolean;
  instances?: number;
  warnings?: string[];
  generatedSid?: number;
  newUids?: number[];
  sceneGraphFolderEntries?: number;
  eventSheet?: string;
  backupFile?: string;
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const path = (...parts: string[]) => join(tmpDir, ...parts);
const text = (...parts: string[]) => readFile(path(...parts), 'utf-8');
const readJson = async <T>(...parts: string[]): Promise<T> => JSON.parse(await text(...parts)) as T;
const writeJson = (parts: string[], data: unknown) => writeFile(path(...parts), JSON.stringify(data, null, '\t'));
const project = () => readJson<ProjectFile>('project.c3proj');

const call = async (tool: string, args: Args): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const warningsOf = (data: ToolData) => (data.warnings ?? []).join(' ');

/** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
async function editorSave(file: string, content: string): Promise<void> {
  await writeFile(file, content);
  const { mtime } = await stat(file);
  const later = new Date(mtime.getTime() + 2000);
  await utimes(file, later, later);
}

/** Every file of the project with its bytes, .bak files left out. */
async function snapshotProject(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.endsWith('.bak')) files.set(relative(tmpDir, full).split('\\').join('/'), (await readFile(full)).toString('base64'));
    }
  };
  await walk(tmpDir);
  return files;
}

/** A call that must be refused: an error that contains `parts`, ends with "Nothing was changed." and leaves every file as it was. */
async function refusal(tool: string, args: Args, ...parts: string[]): Promise<ToolData> {
  const before = await snapshotProject();
  const data = await call(tool, args);
  expect(data.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
  for (const part of parts) expect(data.text, `${tool} ${JSON.stringify(args)}`).toContain(part);
  expect(data.text, `${tool} ${JSON.stringify(args)}`).toMatch(/Nothing was changed\.$/);
  expect(data.text, `${tool} ${JSON.stringify(args)}`).not.toContain(tmpDir);
  expect(await snapshotProject()).toEqual(before);
  return data;
}

/** Every numeric sid in a JSON value. */
function sidsOf(value: unknown): number[] {
  const out: number[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'sid' && typeof child === 'number') out.push(child);
        else walk(child);
      }
    }
  };
  walk(value);
  return out;
}

function allInstances(layout: LayoutJson): InstanceJson[] {
  const out: InstanceJson[] = [];
  const walk = (layers: LayerJson[] | undefined) => {
    for (const layer of layers ?? []) {
      out.push(...layer.instances);
      walk(layer.subLayers);
    }
  };
  walk(layout.layers);
  out.push(...(layout['nonworld-instances'] ?? []));
  return out;
}

/** Give the Player and the Enemy of Level 1 a parent link and Layout View entries. */
async function addHierarchy(): Promise<void> {
  const layout = await readJson<LayoutJson>('layouts', 'Level 1.json');
  const [player, enemy] = layout.layers[0].instances;
  const flags = { x: true, y: true };
  player.instanceFolderItem = { sid: player.sid, expanded: true };
  enemy.instanceFolderItem = { sid: enemy.sid, expanded: true };
  player.sceneGraphData = { uid: 1, 'parent-uid': null, children: [{ uid: 2, flags }], flags };
  enemy.sceneGraphData = { uid: 2, 'parent-uid': 1, flags };
  layout['scene-graphs-folder-root'] = { items: [{ sid: player.sid, expanded: true }], subfolders: [] };
  await writeJson(['layouts', 'Level 1.json'], layout);
}

async function editLayout(parts: string[], change: (layout: LayoutJson) => void): Promise<void> {
  const layout = await readJson<LayoutJson>(...parts);
  change(layout);
  await writeJson(parts, layout);
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-duplicate-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(path('project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerDuplicateTools({ server, reader, writer, idGen } as unknown as Parameters<typeof registerDuplicateTools>[0]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('duplicate_layout', () => {
  it('copies every layer and instance with fresh SIDs, new UIDs and remapped hierarchy links', async () => {
    await addHierarchy();
    const sourceBytes = await text('layouts', 'Level 1.json');
    const source = JSON.parse(sourceBytes) as LayoutJson;
    const sourceSids = new Set(sidsOf(source));

    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(data.isError).not.toBe(true);
    expect(data.instances).toBe(4);
    expect(warningsOf(data)).toContain('Keyboard');

    const copy = await readJson<LayoutJson>('layouts', 'Level 1 Copy.json');
    expect(copy.name).toBe('Level 1 Copy');
    expect(copy.eventSheet).toBe('Main');
    expect(Object.keys(copy)).toEqual(Object.keys(source));
    expect(sidsOf(copy).some(sid => sourceSids.has(sid))).toBe(false);

    const instances = allInstances(copy);
    const uids = instances.map(i => i.uid);
    expect(Math.min(...uids)).toBeGreaterThan(4);
    expect(new Set(uids).size).toBe(4);
    expect(new Set(instances.map(i => i.sid)).size).toBe(4);

    const [player, enemy] = copy.layers[0].instances;
    expect(player.sceneGraphData?.uid).toBe(player.uid);
    expect(player.sceneGraphData?.children?.[0].uid).toBe(enemy.uid);
    expect(enemy.sceneGraphData?.['parent-uid']).toBe(player.uid);
    expect(player.sceneGraphData?.['parent-uid']).toBeNull();
    expect(player.instanceFolderItem?.sid).toBe(player.sid);
    expect(enemy.instanceFolderItem?.sid).toBe(enemy.sid);
    expect(copy['scene-graphs-folder-root']?.items).toEqual([{ sid: player.sid, expanded: true }]);

    expect(await text('layouts', 'Level 1.json')).toBe(sourceBytes);
    expect((await project()).layouts.items).toEqual(['Level 1', 'Level 1 Copy']);
    expect(data.backupFile).toBe('project.c3proj.bak');
  });

  it('allocates UIDs above sub-layer instances when duplicating twice', async () => {
    await editLayout(['layouts', 'Extra', 'Level 2.json'], layout => {
      const base = layout.layers[0];
      layout.layers = [{
        ...base, name: 'Top', sid: 631000000000001, instances: [],
        subLayers: [{ ...base, instances: base.instances.map((instance, n) => ({ ...instance, uid: 900 + n })) }],
      }];
    });
    const first = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy A' });
    const second = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy B' });
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const uids = [
      ...allInstances(await readJson<LayoutJson>('layouts', 'Level 1.json')),
      ...allInstances(await readJson<LayoutJson>('layouts', 'Extra', 'Level 2.json')),
      ...allInstances(await readJson<LayoutJson>('layouts', 'Copy A.json')),
      ...allInstances(await readJson<LayoutJson>('layouts', 'Copy B.json')),
    ].map(i => i.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(Math.min(...allInstances(await readJson<LayoutJson>('layouts', 'Copy A.json')).map(i => i.uid))).toBeGreaterThan(900);
  });

  it('keeps the copy in the source folder', async () => {
    const data = await call('duplicate_layout', { layoutName: 'Level 2', newName: 'Level 3' });
    expect(data.isError).not.toBe(true);
    expect(existsSync(path('layouts', 'Extra', 'Level 3.json'))).toBe(true);
    expect((await project()).layouts.subfolders[0].items).toEqual(['Level 2', 'Level 3']);
  });

  it('refuses a layout that cannot be copied, saying Nothing was changed. and leaving every file as it was', async () => {
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'level 2' }, 'A layout named "Level 2" already exists');
    await refusal('duplicate_layout', { layoutName: 'level 1', newName: 'Copy' }, 'names are matched with their letter case', 'Did you mean "Level 1"?');
    await refusal('duplicate_layout', { layoutName: 'Nope', newName: 'Copy' }, 'Layout "Nope" not found.');
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'bad/name' }, 'Name must start with a letter or underscore');

    await writeFile(path('layouts', 'Level 1 Copy.json'), '{}');
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' },
      'Refusing to create "Level 1 Copy": the file layouts/Level 1 Copy.json already exists (not registered in project.c3proj under this name');
    await rm(path('layouts', 'Level 1 Copy.json'));
    await writeFile(path('layouts', 'level 1 copy.json'), '{}');
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' },
      'the file layouts/level 1 copy.json already exists');
    await rm(path('layouts', 'level 1 copy.json'));

    await editLayout(['layouts', 'Level 1.json'], layout => {
      layout.layers[0].instances[0].template = { mode: 'template', templateName: 'Hero', sourceTemplateName: '', replicasUIDs: null };
    });
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' }, 'holds 1 template instance(s)', 'uid 1 Player template "Hero"');
    await editLayout(['layouts', 'Level 1.json'], layout => {
      delete layout.layers[0].instances[0].template;
      const flags = { x: true };
      layout.layers[0].instances[0].sceneGraphData = { uid: 1, 'parent-uid': 77, flags };
    });
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' }, 'hierarchy links to instances it does not contain', 'has parent uid 77');
  });

  it('refuses a layout the UID scan could not read, with the generator\'s reason', async () => {
    await rm(path('layouts', 'Extra', 'Level 2.json'));
    await mkdir(path('layouts', 'Extra', 'Level 2.json'));
    const fresh = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, fresh);
    server = new MockServer();
    registerDuplicateTools({ server, reader, writer, idGen: fresh } as unknown as Parameters<typeof registerDuplicateTools>[0]);
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' }, 'Cannot generate a safe UID', 'layouts/Level 2');
  });

  it('refuses a layout that cannot be read, without a path', async () => {
    await rm(path('layouts', 'Level 1.json'));
    await mkdir(path('layouts', 'Level 1.json'));
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' }, 'Layout "Level 1" could not be read (could not be read).');
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' }, 'Layout "Level 1" could not be read (could not be read).');
  });

  it('refuses a layer copy when the UID scan could not read a layout', async () => {
    await rm(path('layouts', 'Extra', 'Level 2.json'));
    await mkdir(path('layouts', 'Extra', 'Level 2.json'));
    const fresh = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, fresh);
    server = new MockServer();
    registerDuplicateTools({ server, reader, writer, idGen: fresh } as unknown as Parameters<typeof registerDuplicateTools>[0]);
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' }, 'Cannot generate a safe UID', 'layouts/Level 2');
  });

  it('says Nothing was changed. when a step before the write throws unexpectedly, without a path', async () => {
    const failure = Object.assign(new Error(`EACCES: permission denied, scandir '${path('timelines')}'`), { code: 'EACCES', path: path('timelines') });
    vi.spyOn(reader, 'listDataFiles').mockRejectedValueOnce(failure);
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' }, 'Error duplicating layout: EACCES on timelines. Nothing was changed.');
    vi.spyOn(reader, 'listLayouts').mockRejectedValueOnce(failure);
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' }, 'Error duplicating layer: EACCES on timelines. Nothing was changed.');
  });

  it('copies replica instances', async () => {
    await editLayout(['layouts', 'Level 1.json'], layout => {
      layout.layers[0].instances[0].template = { mode: 'replica', templateName: '', sourceTemplateName: 'Hero', replicasUIDs: null };
    });
    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
    expect(data.isError).not.toBe(true);
    const copy = await readJson<LayoutJson>('layouts', 'Copy.json');
    expect(copy.layers[0].instances[0].template?.mode).toBe('replica');
  });

  describe('warnings', () => {
    /** No timeline addresses an instance of Level 1: every instance reference in the two timelines names an instance that does not exist. */
    async function detachTimeline(): Promise<void> {
      const rewrite = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(rewrite);
        else if (node && typeof node === 'object') {
          const record = node as Obj;
          for (const [key, value] of Object.entries(record)) {
            if ((key === 'worldInstance' || key === 'uid') && typeof value === 'number') record[key] = 999;
            else rewrite(value);
          }
        }
      };
      for (const file of [['timelines', 'Intro.json'], ['timelines', 'transitions', 'Swipe.json']]) {
        const timeline = await readJson<unknown>(...file);
        rewrite(timeline);
        await writeJson(file, timeline);
      }
    }

    it('says nothing about timelines and sheets when none addresses the source\'s UIDs', async () => {
      await detachTimeline();
      const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
      expect(data.isError).not.toBe(true);
      expect(data.warnings).toHaveLength(1);
      expect(warningsOf(data)).toContain('global object type(s) Keyboard');
      expect(warningsOf(data)).not.toContain('Timeline(s)');
      expect(warningsOf(data)).not.toContain('Event sheet(s)');
    });

    it('warns about a global object type, a timeline addressing the source\'s UIDs and a sheet picking one by UID', async () => {
      const player = await readJson<Obj>('objectTypes', 'Actors', 'Player.json');
      player.isGlobal = true;
      await writeJson(['objectTypes', 'Actors', 'Player.json'], player);
      const sheet = JSON.parse(await text('eventSheets', 'Main.json')) as { events: Array<{ conditions?: Array<{ parameters?: Obj }> }> };
      sheet.events[2].conditions?.push({ parameters: { 'unique-id': '3' } } as never);
      await writeJson(['eventSheets', 'Main.json'], sheet);
      const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
      expect(data.isError).not.toBe(true);
      expect(warningsOf(data)).toContain('global object type(s) Player');
      expect(warningsOf(data)).toContain('Timeline(s) timelines/Intro.json, timelines/transitions/Swipe.json animate instances of "Level 1" by UID');
      expect(warningsOf(data)).toContain('Event sheet(s) Main pick instances of "Level 1" by a fixed UID');
    });

    it('does not follow a timeline or a sheet nested deeper than its limit', async () => {
      await detachTimeline();
      let timelineNode: Obj = { worldInstance: 1 };
      for (let i = 0; i < 70; i++) timelineNode = { inner: timelineNode };
      await writeJson(['timelines', 'Deep.json'], timelineNode);
      let sheetNode: Obj = { parameters: { 'unique-id': '1' } };
      for (let i = 0; i < 130; i++) sheetNode = { inner: sheetNode };
      await writeJson(['eventSheets', 'Deep.json'], { name: 'Deep', events: [sheetNode] });
      const registered = await project();
      registered.eventSheets.items.push('Deep');
      await writeJson(['project.c3proj'], registered);
      await reader.reloadProject();
      const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
      expect(data.isError).not.toBe(true);
      expect(warningsOf(data)).not.toContain('Deep');
    });

    it('names an object type that could not be read instead of leaving it out', async () => {
      await detachTimeline();
      await writeFile(path('objectTypes', 'Actors', 'Enemy.json'), '{ broken');
      const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
      expect(data.isError).not.toBe(true);
      expect(warningsOf(data)).toContain('Object type(s) Enemy could not be read, so whether the copy places another instance of a global object type was not checked.');
      expect(warningsOf(data)).not.toContain(tmpDir);
    });

    it('names a timeline file and an event sheet that could not be checked, without a path', async () => {
      await detachTimeline();
      await writeFile(path('timelines', 'Broken.json'), '{ broken');
      await writeFile(path('eventSheets', 'Broken.json'), '{ broken');
      const registered = await project();
      registered.eventSheets.items.push('Broken');
      await writeJson(['project.c3proj'], registered);
      await reader.reloadProject();
      const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
      expect(data.isError).not.toBe(true);
      expect(warningsOf(data)).toContain('timelines/Broken.json, eventSheets/Broken');
      expect(warningsOf(data)).toContain('could not be checked');
      expect(warningsOf(data)).not.toContain(tmpDir);
    });
  });

  it('removes the new file when the registration fails', async () => {
    const undoToolCall = vi.spyOn(writer, 'undoToolCall');
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotProject();
    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('boom. The call was rolled back: layouts/Level 1 Copy.json (removed: the call had created it) is as before the call.');
    expect(await snapshotProject()).toEqual(before);
    expect(undoToolCall).toHaveBeenCalledTimes(1);
  });

  it('says the writes could not be undone, naming the files, when the rollback itself fails', async () => {
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const failure = Object.assign(new Error(`EACCES: permission denied, open '${path('project.c3proj')}'`), { code: 'EACCES', path: path('project.c3proj') });
    vi.spyOn(writer, 'undoToolCall').mockRejectedValueOnce(failure);
    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe("boom. The call's writes could not be undone (EACCES on project.c3proj), "
      + 'so these files may be left as the call wrote them: project.c3proj, layouts/Level 1 Copy.json. '
      + 'Check the project (validate_project, git diff) before you run the tool again.');
    expect(data.text).not.toContain('Nothing was changed');
    expect(data.text).not.toContain(tmpDir);
  });

  it('names the new file when its own create fails after it wrote the file', async () => {
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      const result = await replaceFile(file, content, options);
      throw new Error(`A check after the write failed (${result === undefined ? 'new file' : 'backup'}).`);
    });
    const before = await snapshotProject();
    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('A check after the write failed (new file). The call was rolled back: layouts/Level 1 Copy.json (removed: the call had created it) is as before the call.');
    expect(await snapshotProject()).toEqual(before);
  });

  it('keeps the new entity file while project.c3proj still registers it', async () => {
    const undoToolCall = vi.spyOn(writer, 'undoToolCall');
    const updateProject = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementationOnce(async change => {
      await updateProject(change);
      const registered = await project();
      await editorSave(path('project.c3proj'), JSON.stringify(registered, null, '\t') + '\n');
      throw new Error('boom');
    });
    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('layouts/Level 1 Copy.json (kept: project.c3proj still registers what this call added');
    expect(existsSync(path('layouts', 'Level 1 Copy.json'))).toBe(true);
    for (const name of (await project()).layouts.items) expect(existsSync(path('layouts', `${String(name)}.json`))).toBe(true);
    expect(undoToolCall).toHaveBeenCalledTimes(1);
    expect(data.text?.match(/boom/g)).toHaveLength(1);
    expect(data.text?.match(/rolled back/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('refuses a copy larger than the writer allows before anything is written', async () => {
    await editLayout(['layouts', 'Level 1.json'], layout => {
      layout.padding = 'x'.repeat(5.5 * 1024 * 1024);
    });
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' }, 'Generated JSON for "Level 1 Copy" is too large');
  });

  it('writes the copy with the line endings of the project', async () => {
    const crlf = (await text('project.c3proj')).replace(/\r?\n/g, '\r\n');
    await writeFile(path('project.c3proj'), crlf);
    await reader.reloadProject();
    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(data.isError).not.toBe(true);
    const copy = await text('layouts', 'Level 1 Copy.json');
    expect(copy).toContain('\r\n');
    expect(copy.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('duplicate_layer', () => {
  it('inserts a copy above the source layer with fresh IDs and copies of the Layout View entries', async () => {
    await editLayout(['layouts', 'Level 1.json'], layout => {
      const ui = layout.layers[0].subLayers![0];
      ui.instances[0].instanceFolderItem = { sid: ui.instances[0].sid, expanded: false };
      layout['scene-graphs-folder-root'] = {
        items: [{ sid: 12345, expanded: true }],
        subfolders: [{ items: [{ sid: ui.instances[0].sid, expanded: false }], subfolders: [], name: 'F' }],
      };
    });
    const before = await readJson<LayoutJson>('layouts', 'Level 1.json');
    const originalBefore = structuredClone(before.layers[0].subLayers![0]);

    const data = await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' });
    expect(data.isError).not.toBe(true);
    const layout = await readJson<LayoutJson>('layouts', 'Level 1.json');
    const [ui, ui2] = layout.layers[0].subLayers!;
    expect(ui.name).toBe('UI');
    expect(ui2.name).toBe('UI2');
    expect(ui2.sid).not.toBe(ui.sid);
    expect(data.generatedSid).toBe(ui2.sid);
    const copy = ui2.instances[0];
    expect(copy.uid).toBeGreaterThan(4);
    expect(copy.sid).not.toBe(ui.instances[0].sid);
    expect(copy.instanceFolderItem?.sid).toBe(copy.sid);
    expect(layout['scene-graphs-folder-root']?.subfolders[0].items).toEqual([
      { sid: ui.instances[0].sid, expanded: false },
      { sid: copy.sid, expanded: false },
    ]);
    expect(data.sceneGraphFolderEntries).toBe(1);
    expect(layout['scene-graphs-folder-root']?.items).toEqual([{ sid: 12345, expanded: true }]);
    // The original layer is as it was: its name, SID, instances (UIDs, SIDs) and links
    expect(ui).toEqual(originalBefore);
    expect(data.backupFile).toBe('layouts/Level 1.json.bak');
  });

  it('warns about a global object type on the copied layer, and about a type that could not be read', async () => {
    const player = await readJson<Obj>('objectTypes', 'Actors', 'Player.json');
    player.isGlobal = true;
    await writeJson(['objectTypes', 'Actors', 'Player.json'], player);
    const data = await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' });
    expect(data.isError).not.toBe(true);
    expect(data.warnings).toEqual(['The copy places another instance of global object type(s) Player.']);

    await writeFile(path('objectTypes', 'Actors', 'Player.json'), '{ broken');
    const unreadable = await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI3' });
    expect(unreadable.isError).not.toBe(true);
    expect(unreadable.warnings).toEqual(['Object type(s) Player could not be read, so whether the copy places another instance of a global object type was not checked.']);
    expect(unreadable.warnings?.join(' ')).not.toContain(tmpDir);
  });

  it('refuses a layer that cannot be copied, saying Nothing was changed. and leaving every file as it was', async () => {
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'Game', newName: 'Game2' }, 'has sub-layers (UI)');
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'Game' }, 'already has a layer named "Game"');
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'game' }, 'already has a layer named "Game"');
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'ui', newName: 'UI2' }, 'names are matched with their letter case', 'Did you mean "UI"?');
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'Nope', newName: 'UI2' }, 'In layout "Level 1": Layer "Nope" not found.');
    await refusal('duplicate_layer', { layoutName: 'Nope', layerName: 'UI', newName: 'UI2' }, 'Layout "Nope" not found.');
    await refusal('duplicate_layer', { layoutName: 'level 1', layerName: 'UI', newName: 'UI2' }, 'Did you mean "Level 1"?');
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'bad/name' }, 'Name must start with a letter or underscore');

    await editLayout(['layouts', 'Level 1.json'], layout => {
      layout.layers[0].subLayers![0].instances[0].template = { mode: 'template', templateName: 'Hero', sourceTemplateName: '', replicasUIDs: null };
    });
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' }, 'holds 1 template instance(s)');
    await editLayout(['layouts', 'Level 1.json'], layout => {
      const flags = { x: true };
      delete layout.layers[0].subLayers![0].instances[0].template;
      layout.layers[0].instances[0].sceneGraphData = { uid: 1, 'parent-uid': null, children: [{ uid: 3, flags }], flags };
      layout.layers[0].subLayers![0].instances[0].sceneGraphData = { uid: 3, 'parent-uid': 1, flags };
    });
    await refusal('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' }, 'parent uid 1');
  });

  it('puts back the layout when its write fails', async () => {
    vi.spyOn(writer, 'writeEntityFile').mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotProject();
    const data = await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('boom. Nothing was changed.');
    expect(await snapshotProject()).toEqual(before);
  });
});

describe('a refused call', () => {
  it('leaves the layouts the reader holds as they were', async () => {
    const before = structuredClone([...(await reader.readAllLayouts()).entries()]);
    await call('duplicate_layout', { layoutName: 'Level 1', newName: 'level 2' });
    await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'Game', newName: 'Game2' });
    expect([...(await reader.readAllLayouts()).entries()]).toEqual(before);
  });
});
