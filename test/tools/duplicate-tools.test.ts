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
const MB = 1024 * 1024;

type Args = Record<string, unknown>;
type Obj = Record<string, unknown>;

interface Folder { name?: string; items: unknown[]; subfolders: Folder[] }
interface ProjectFile { layouts: Folder; eventSheets: Folder; objectTypes: Folder; timelines: Folder; [key: string]: unknown }
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
let idGen: IdGenerator;
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

/** The entity file of every name registered in a Project Bar tree, folders included, as a project path. */
function treeFiles(folder: Folder, prefix: string): string[] {
  return [
    ...folder.items.map(name => `${prefix}/${String(name)}.json`),
    ...folder.subfolders.flatMap(sub => treeFiles(sub, `${prefix}/${sub.name}`)),
  ];
}

/** Every numeric imageSpriteId in a JSON value. */
function imageSpriteIdsOf(value: unknown): number[] {
  const out: number[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'imageSpriteId' && typeof child === 'number') out.push(child);
        else walk(child);
      }
    }
  };
  walk(value);
  return out;
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
  idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerDuplicateTools({ server, reader, writer, idGen } as unknown as Parameters<typeof registerDuplicateTools>[0]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it('does not copy the editor view-state files of the source', async () => {
    await writeFile(path('layouts', 'Level 1.uistate.json'), '{"a":1}');
    await mkdir(path('layouts', 'uistate'), { recursive: true });
    await writeFile(path('layouts', 'uistate', 'Level 1.instancesBar.json'), '{"b":2}');
    const data = await call('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(data.isError).not.toBe(true);
    expect(existsSync(path('layouts', 'Level 1 Copy.json'))).toBe(true);
    expect(existsSync(path('layouts', 'Level 1 Copy.uistate.json'))).toBe(false);
    expect(existsSync(path('layouts', 'uistate', 'Level 1 Copy.instancesBar.json'))).toBe(false);
    expect(await text('layouts', 'Level 1.uistate.json')).toBe('{"a":1}');
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

  it('refuses a copy over the size limit when its source file is under it, before anything is written', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    const source = await readJson<LayoutJson>('layouts', 'Level 1.json');
    const [, enemy] = source.layers[0].instances;
    source.layers[0].instances = Array.from({ length: 4500 }, (_, i) => ({ ...structuredClone(enemy), uid: 1000 + i, sid: 631000000000000 + i }));
    // Saved compact: under the limit on disk, over it once the writer tab-indents it
    await writeFile(path('layouts', 'Level 1.json'), JSON.stringify(source));
    expect((await stat(path('layouts', 'Level 1.json'))).size).toBeLessThan(MB);
    expect(JSON.stringify(source, null, '\t').length).toBeGreaterThan(MB);

    const validateJsonData = vi.spyOn(writer, 'validateJsonData');
    await refusal('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' },
      'Generated JSON for "Level 1 Copy" is too large (at least', 'over the 1MB limit');
    expect(validateJsonData.mock.calls.map(([, name]) => name)).toEqual(['Level 1 Copy']);
    expect(existsSync(path('layouts', 'Level 1 Copy.json'))).toBe(false);
    expect(treeFiles((await project()).layouts, 'layouts').some(file => file.endsWith('/Level 1 Copy.json'))).toBe(false);
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

  it('says Nothing was changed. when the write fails before it changes the file', async () => {
    vi.spyOn(writer, 'writeEntityFile').mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotProject();
    const data = await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('boom. Nothing was changed.');
    expect(await snapshotProject()).toEqual(before);
  });

  it('puts back the layout when the read-back of its write fails', async () => {
    const before = await snapshotProject();
    const internals = writer as unknown as { verifyWrittenFile: (file: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    internals.verifyWrittenFile = async (file, name, written) => {
      if (file.endsWith('Level 1.json')) {
        throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      }
      return verify(file, name, written);
    };
    const data = await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('Post-write verification failed for "Level 1": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read. '
      + 'The call was rolled back: layouts/Level 1.json is as before the call.');
    expect(existsSync(path('layouts', 'Level 1.json.bak'))).toBe(true);
    expect(await snapshotProject()).toEqual(before);
  });
});

describe('duplicate_event_sheet', () => {
  /** Helpers without its global variable, so it can be copied. */
  async function allowCopy(): Promise<void> {
    const helpers = await readJson<{ events: Array<{ eventType: string }> }>('eventSheets', 'Shared', 'Helpers.json');
    helpers.events = helpers.events.filter(event => event.eventType !== 'variable');
    await writeJson(['eventSheets', 'Shared', 'Helpers.json'], helpers);
  }

  it('copies a sheet with fresh SIDs into the source folder, registered after the source', async () => {
    await allowCopy();
    const sourceBytes = await text('eventSheets', 'Shared', 'Helpers.json');
    const source = JSON.parse(sourceBytes) as Obj;
    const data = await call('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Helpers Copy' });
    expect(data.isError).not.toBe(true);

    const copy = await readJson<Obj>('eventSheets', 'Shared', 'Helpers Copy.json');
    expect(copy.name).toBe('Helpers Copy');
    expect(Object.keys(copy)).toEqual(Object.keys(source));
    expect(sidsOf(copy)).toHaveLength(sidsOf(source).length);
    const used = new Set(sidsOf(source));
    for (const name of ['Main', 'Shared/Helpers']) sidsOf(await readJson<Obj>('eventSheets', ...`${name}.json`.split('/'))).forEach(sid => used.add(sid));
    // Every registered sheet but the copy is covered
    expect(treeFiles((await project()).eventSheets, 'eventSheets').filter(file => !file.endsWith('Helpers Copy.json'))).toEqual(['eventSheets/Main.json', 'eventSheets/Shared/Helpers.json']);
    expect(sidsOf(copy).some(sid => used.has(sid))).toBe(false);
    expect(new Set(sidsOf(copy)).size).toBe(sidsOf(copy).length);
    expect(data.reassignedSids).toBe(sidsOf(source).length);
    expect(data.generatedSid).toBe(copy.sid);
    expect(data.folder).toBe('Shared');
    expect(warningsOf(data)).toBe('The copy is not attached to any layout and is not included by any sheet.');
    expect(await text('eventSheets', 'Shared', 'Helpers.json')).toBe(sourceBytes);
    expect((await project()).eventSheets.subfolders[0].items).toEqual(['Helpers', 'Helpers Copy']);
    expect(data.backupFile).toBe('project.c3proj.bak');
  });

  it('refuses a sheet that declares project-wide names, naming each, and leaves every file as it was', async () => {
    await refusal('duplicate_event_sheet', { sheetName: 'Main', newName: 'Main Copy' },
      'declares 3 project-wide name(s): global variable "score", group "Hostile handling", custom action "Alert" on Hostiles');
    await writeJson(['eventSheets', 'Decl.json'], {
      name: 'Decl',
      events: [
        { eventType: 'function-block', functionName: 'Spawn', sid: 1 },
        { eventType: 'custom-ace-block', aceName: 'Hit', objectClass: 'Player', sid: 2 },
        { eventType: 'group', title: 'Setup', children: [{ eventType: 'variable', name: 'local', sid: 3 }], sid: 4 },
      ],
      sid: 5,
    });
    const registered = await project();
    registered.eventSheets.items.push('Decl');
    await writeJson(['project.c3proj'], registered);
    await reader.reloadProject();
    await refusal('duplicate_event_sheet', { sheetName: 'Decl', newName: 'Decl Copy' },
      'declares 3 project-wide name(s): function "Spawn", custom action "Hit" on Player, group "Setup"');
  });

  it('refuses a name that cannot be used, an unknown sheet and a case-variant source, saying Nothing was changed.', async () => {
    await allowCopy();
    await refusal('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'main' }, 'An event sheet named "Main" already exists');
    await refusal('duplicate_event_sheet', { sheetName: 'helpers', newName: 'Copy' }, 'names are matched with their letter case', 'Did you mean "Helpers"?');
    await refusal('duplicate_event_sheet', { sheetName: 'Nope', newName: 'Copy' }, 'Event sheet "Nope" not found.');
    await refusal('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'bad/name' }, 'Name must start with a letter or underscore');
    await writeFile(path('eventSheets', 'Shared', 'helpers copy.json'), '{}');
    await refusal('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Helpers Copy' }, 'the file eventSheets/Shared/helpers copy.json already exists');
  });

  it('refuses a sheet whose events are nested deeper than the declared-name scan follows', async () => {
    let event: Obj = { eventType: 'group', title: 'Deep', sid: 1 };
    for (let i = 0; i < 70; i++) event = { eventType: 'block', children: [event], sid: i + 2 };
    await writeJson(['eventSheets', 'Nested.json'], { name: 'Nested', events: [event], sid: 99 });
    const registered = await project();
    registered.eventSheets.items.push('Nested');
    await writeJson(['project.c3proj'], registered);
    await reader.reloadProject();
    await refusal('duplicate_event_sheet', { sheetName: 'Nested', newName: 'Nested Copy' }, 'events nested deeper than 64 levels, which were not checked');
  });

  it('refuses a sheet file it cannot parse, without a path', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Helpers.json'), '{ broken');
    await refusal('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Copy' }, 'Cannot read event sheet "Helpers" (not valid JSON).');
  });

  it('refuses when a fresh SID cannot be generated', async () => {
    await allowCopy();
    vi.spyOn(idGen, 'generateSid').mockRejectedValueOnce(new Error('no free SID'));
    await refusal('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Copy' }, 'no free SID');
  });

  it('says Nothing was changed. when a step before the write throws unexpectedly, without a path', async () => {
    const failure = Object.assign(new Error(`EACCES: permission denied, scandir '${path('eventSheets')}'`), { code: 'EACCES', path: path('eventSheets') });
    vi.spyOn(reader, 'listEventSheets').mockRejectedValueOnce(failure);
    await refusal('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Copy' }, 'Error duplicating event sheet: EACCES on eventSheets. Nothing was changed.');
  });

  it('removes the copy when the registration fails, rolling back once', async () => {
    await allowCopy();
    const undoToolCall = vi.spyOn(writer, 'undoToolCall');
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotProject();
    const data = await call('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Helpers Copy' });
    expect(data.text).toBe('boom. The call was rolled back: eventSheets/Shared/Helpers Copy.json (removed: the call had created it) is as before the call.');
    expect(await snapshotProject()).toEqual(before);
    expect(undoToolCall).toHaveBeenCalledTimes(1);
  });
});

describe('duplicate_object_type', () => {
  /** Player with two frames that have image files, an instance variable, a behavior and an effect. */
  async function prepareSprite(): Promise<void> {
    const player = await readJson<Obj>('objectTypes', 'Actors', 'Player.json');
    const animation = (player.animations as { items: Array<{ frames: Obj[] }> }).items[0];
    const [frame] = animation.frames;
    animation.frames = [{ ...frame, imageSpriteId: 1111111 }, { ...frame, imageSpriteId: 2222222 }];
    player.instanceVariables = [{ name: 'hp', type: 'number', desc: '', show: true, sid: 660000000000021 }];
    player.behaviorTypes = [{ behaviorId: 'Platform', name: 'Platform', sid: 660000000000022 }];
    player.effectTypes = [{ name: 'Blur', sid: 660000000000023 }];
    await writeJson(['objectTypes', 'Actors', 'Player.json'], player);
    await mkdir(path('images'), { recursive: true });
    await writeFile(path('images', 'player-default-000.png'), 'png0');
    await writeFile(path('images', 'player-default-001.png'), 'png1');
  }

  /** The create of a file whose path ends with `suffix` fails with `message`; every other write runs as it is. */
  function failCreateOf(suffix: string, message: string): void {
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      if (file.replace(/\\/g, '/').endsWith(suffix)) throw new Error(message);
      return replaceFile(file, content, options);
    });
  }

  it('copies a sprite with fresh SIDs and image IDs and its image files under the new name', async () => {
    await prepareSprite();
    const sourceBytes = await text('objectTypes', 'Actors', 'Player.json');
    const source = JSON.parse(sourceBytes) as Obj;
    const levelBytes = await text('layouts', 'Level 1.json');

    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.isError).not.toBe(true);
    const copy = await readJson<Obj>('objectTypes', 'Actors', 'Hero.json');
    expect(copy.name).toBe('Hero');
    expect(Object.keys(copy)).toEqual(Object.keys(source));
    expect(sidsOf(copy)).toHaveLength(sidsOf(source).length);
    expect(data.reassignedSids).toBe(sidsOf(source).length);
    const sourceSids = new Set(sidsOf(source));
    expect(sidsOf(copy).some(sid => sourceSids.has(sid))).toBe(false);
    expect(data.generatedSid).toBe(copy.sid);
    const ids = imageSpriteIdsOf(copy);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.some(id => id === 1111111 || id === 2222222)).toBe(false);
    expect(data.newImageSpriteIds).toBe(2);
    for (const key of ['instanceVariables', 'behaviorTypes', 'effectTypes']) {
      expect((copy[key] as Array<{ name: string }>).map(entry => entry.name)).toEqual((source[key] as Array<{ name: string }>).map(entry => entry.name));
    }

    expect(await text('images', 'hero-default-000.png')).toBe('png0');
    expect(await text('images', 'hero-default-001.png')).toBe('png1');
    expect(await text('images', 'player-default-000.png')).toBe('png0');
    expect(data.filesCopied).toEqual([
      { from: 'images/player-default-000.png', to: 'images/hero-default-000.png' },
      { from: 'images/player-default-001.png', to: 'images/hero-default-001.png' },
    ]);
    expect(data.folder).toBe('Actors');
    expect(await text('objectTypes', 'Actors', 'Player.json')).toBe(sourceBytes);
    expect(await text('layouts', 'Level 1.json')).toBe(levelBytes);
    expect((await project()).objectTypes.subfolders[0].items).toEqual(['Player', 'Hero', 'PlayerShip', 'Enemy']);
    expect(data.backupFile).toBe('project.c3proj.bak');
  });

  it('copies a tilemap with a new image ID, its image file and its brush file', async () => {
    await mkdir(path('images'), { recursive: true });
    await writeFile(path('images', 'tiles.png'), 'tile image');
    const data = await call('duplicate_object_type', { objectName: 'Tiles', newName: 'Floor' });
    expect(data.isError).not.toBe(true);
    const copy = await readJson<{ image: { imageSpriteId: number } }>('objectTypes', 'Floor.json');
    expect(copy.image.imageSpriteId).not.toBe(1234567);
    expect(data.newImageSpriteIds).toBe(1);
    expect(await text('images', 'floor.png')).toBe('tile image');
    expect(await text('tilemapBrushes', 'objectTypes', 'Floor.brush.json')).toBe(await text('tilemapBrushes', 'objectTypes', 'Tiles.brush.json'));
    expect(data.filesCopied).toEqual([
      { from: 'images/tiles.png', to: 'images/floor.png' },
      { from: 'tilemapBrushes/objectTypes/Tiles.brush.json', to: 'tilemapBrushes/objectTypes/Floor.brush.json' },
    ]);
    expect((await project()).objectTypes.items).toEqual(['Tiles', 'Floor', 'Keyboard']);
  });

  it('puts the brush file of an object type in a folder under the same folders', async () => {
    await mkdir(path('tilemapBrushes', 'objectTypes', 'Actors'), { recursive: true });
    await writeFile(path('tilemapBrushes', 'objectTypes', 'Actors', 'Player.brush.json'), '[]');
    await writeFile(path('tilemapBrushes', 'objectTypes', 'Hero.brush.json'), '[ "elsewhere" ]');
    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.isError).not.toBe(true);
    expect(data.filesCopied).toEqual([
      { from: 'tilemapBrushes/objectTypes/Actors/Player.brush.json', to: 'tilemapBrushes/objectTypes/Actors/Hero.brush.json' },
    ]);
    expect(await text('tilemapBrushes', 'objectTypes', 'Actors', 'Hero.brush.json')).toBe('[]');
  });

  it('refuses a copy that cannot be made, saying Nothing was changed. and leaving every file as it was', async () => {
    await prepareSprite();
    const keyboard = await readJson<Obj>('objectTypes', 'Keyboard.json');
    keyboard['singleglobal-inst'] = { type: 'Keyboard', properties: [], tags: '', instanceFolderItem: { sid: 1, expanded: true } };
    await writeJson(['objectTypes', 'Keyboard.json'], keyboard);
    await refusal('duplicate_object_type', { objectName: 'Keyboard', newName: 'Keys' }, '"Keyboard" is a single-global Keyboard object; a project can hold only one.');
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'enemy' }, '"Enemy" is already an object type or family name');
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'hostiles' }, '"Hostiles" is already an object type or family name');
    await refusal('duplicate_object_type', { objectName: 'player', newName: 'Hero' }, 'names are matched with their letter case', 'Did you mean "Player"?');
    await refusal('duplicate_object_type', { objectName: 'Nope', newName: 'Hero' }, 'Object "Nope" not found.');
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'bad/name' }, 'Name must start with a letter or underscore');
    await writeFile(path('objectTypes', 'Actors', 'hero.json'), '{}');
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'the file objectTypes/Actors/hero.json already exists');
    await rm(path('objectTypes', 'Actors', 'hero.json'));
    await writeFile(path('images', 'Hero-Default-001.PNG'), 'taken');
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'images/hero-default-001.png: already in images/, or the target of more than one file; the copy\'s files would overwrite them.');
    await writeFile(path('images', 'Hero-Default-000.PNG'), 'taken');
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'images/hero-default-000.png, images/hero-default-001.png: already in images/');
    await rm(path('images', 'Hero-Default-000.PNG'));
    await mkdir(path('tilemapBrushes', 'objectTypes'), { recursive: true });
    await writeFile(path('tilemapBrushes', 'objectTypes', 'FLOOR.brush.json'), '[]');
    await refusal('duplicate_object_type', { objectName: 'Tiles', newName: 'Floor' }, 'tilemapBrushes/objectTypes/Floor.brush.json already exists; the copy\'s files would overwrite it.');
  });

  it('refuses an image or a brush file it cannot read, without a path', async () => {
    await prepareSprite();
    await rm(path('images', 'player-default-001.png'));
    await mkdir(path('images', 'player-default-001.png'));
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'images/player-default-001.png could not be read (could not be read).');
    await rm(path('images', 'player-default-001.png'), { recursive: true });
    await writeFile(path('images', 'player-default-001.png'), 'png1');

    vi.spyOn(writer, 'listImageFiles').mockResolvedValueOnce(['player-default-000.png', 'player-default-001.png', 'ghost.png']);
    await rm(path('images', 'player-default-000.png'));
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'images/player-default-000.png could not be read (not found).');
    await writeFile(path('images', 'player-default-000.png'), 'png0');

    await rm(path('tilemapBrushes', 'objectTypes', 'Tiles.brush.json'));
    await mkdir(path('tilemapBrushes', 'objectTypes', 'Tiles.brush.json'));
    await refusal('duplicate_object_type', { objectName: 'Tiles', newName: 'Floor' }, 'tilemapBrushes/objectTypes/Tiles.brush.json could not be read (could not be read).');
  });

  it('refuses an object file it cannot parse, without a path', async () => {
    await writeFile(path('objectTypes', 'Actors', 'Player.json'), '{ broken');
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'Cannot read object type "Player" (not valid JSON).');
  });

  it('refuses when a fresh ID cannot be generated', async () => {
    await prepareSprite();
    vi.spyOn(idGen, 'generateSid').mockRejectedValueOnce(new Error('no free SID'));
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'no free SID');
    vi.spyOn(idGen, 'generateImageSpriteId').mockRejectedValueOnce(new Error('no free image ID'));
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'no free image ID');
  });

  it('says Nothing was changed. when a step before the write throws unexpectedly, without a path', async () => {
    const failure = Object.assign(new Error(`EACCES: permission denied, scandir '${path('images')}'`), { code: 'EACCES', path: path('images') });
    vi.spyOn(writer, 'listImageFiles').mockRejectedValueOnce(failure);
    await refusal('duplicate_object_type', { objectName: 'Player', newName: 'Hero' }, 'Error duplicating object type: EACCES on images. Nothing was changed.');
  });

  it('warns about family and container membership that is not copied, and about frames without image files', async () => {
    await prepareSprite();
    await rm(path('images', 'player-default-001.png'));
    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.isError).not.toBe(true);
    expect(data.warnings).toEqual([
      '"Player" belongs to family Hostiles; the copy was not added. Use update_family to add it.',
      '"Player" is in 1 container(s); the copy was not added.',
      'No image file was found in images/ for player-default-001.png; the copy has no file for those frames.',
    ]);
    expect(existsSync(path('images', 'hero-default-001.png'))).toBe(false);
  });

  it('warns when the copy names a default template, and keeps both editor fields', async () => {
    const player = await readJson<Obj>('objectTypes', 'Actors', 'Player.json');
    player.editorNewInstanceIsReplica = true;
    player.editorNewInstanceTemplateName = 'PlayerT';
    await writeJson(['objectTypes', 'Actors', 'Player.json'], player);
    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.isError).not.toBe(true);
    const copy = await readJson<Obj>('objectTypes', 'Actors', 'Hero.json');
    expect(copy.editorNewInstanceIsReplica).toBe(true);
    expect(copy.editorNewInstanceTemplateName).toBe('PlayerT');
    expect(warningsOf(data)).toContain('The copy creates new instances from the template "PlayerT", which belongs to "Player"; no instance of "Hero" is that template. Change or clear the default template of "Hero" so that it does not name a template of another object type.');
    expect(warningsOf(data)).not.toContain('set_default_template');
  });

  it('removes the copy when the registration fails, rolling back once and creating no image first', async () => {
    await prepareSprite();
    const undoToolCall = vi.spyOn(writer, 'undoToolCall');
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotProject();
    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('boom. The call was rolled back: objectTypes/Actors/Hero.json (removed: the call had created it) is as before the call.');
    expect(await snapshotProject()).toEqual(before);
    expect(existsSync(path('images', 'hero-default-000.png'))).toBe(false);
    expect(undoToolCall).toHaveBeenCalledTimes(1);
  });

  it('names every file it wrote when the rollback itself fails', async () => {
    await prepareSprite();
    failCreateOf('images/hero-default-001.png', 'x');
    const failure = Object.assign(new Error(`EACCES: permission denied, open '${path('project.c3proj')}'`), { code: 'EACCES', path: path('project.c3proj') });
    vi.spyOn(writer, 'undoToolCall').mockRejectedValueOnce(failure);
    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.text).toBe("x. The call's writes could not be undone (EACCES on project.c3proj), so these files may be left as the call wrote them: "
      + 'project.c3proj, objectTypes/Actors/Hero.json, images/hero-default-000.png. Check the project (validate_project, git diff) before you run the tool again.');
  });

  it('names a copied file it could not remove', async () => {
    await mkdir(path('images'), { recursive: true });
    await writeFile(path('images', 'tiles.png'), 'tile image');
    failCreateOf('Floor.brush.json', 'brush failed');
    const restoreForCall = writer.restoreForCall.bind(writer);
    vi.spyOn(writer, 'restoreForCall').mockImplementation(async (file, content) => {
      if (file.replace(/\\/g, '/').endsWith('images/floor.png')) throw new Error('cannot remove it');
      return restoreForCall(file, content);
    });
    const data = await call('duplicate_object_type', { objectName: 'Tiles', newName: 'Floor' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('brush failed. The call was rolled back: project.c3proj is as before the call. '
      + 'Of the other files the call changed: as before the call: objectTypes/Floor.json (removed: the call had created it); '
      + 'left as it is: images/floor.png (cannot remove it; it did not exist before the call). '
      + 'Check the project (validate_project, git diff) before you run the tool again.');
    expect(existsSync(path('images', 'floor.png'))).toBe(true);
    expect(existsSync(path('objectTypes', 'Floor.json'))).toBe(false);
  });

  it('creates the files after the entity: a failing image copy rolls the entity and the registration back', async () => {
    await prepareSprite();
    failCreateOf('images/hero-default-001.png', 'x');
    const before = await snapshotProject();
    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('x. The call was rolled back: project.c3proj is as before the call. Also as before the call: '
      + 'images/hero-default-000.png (removed: the call had created it), objectTypes/Actors/Hero.json (removed: the call had created it).');
    expect(await snapshotProject()).toEqual(before);
    expect(existsSync(path('project.c3proj.bak'))).toBe(true);
  });

  it('keeps the entity file and the images while project.c3proj still registers the copy', async () => {
    await prepareSprite();
    const updateProject = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementationOnce(async change => {
      const backup = await updateProject(change);
      const registered = await project();
      await editorSave(path('project.c3proj'), JSON.stringify(registered, null, '\t') + '\n');
      return backup;
    });
    failCreateOf('images/hero-default-001.png', 'x');
    const data = await call('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('objectTypes/Actors/Hero.json (kept: project.c3proj still registers what this call added');
    expect(data.text).toContain('images/hero-default-000.png (kept: project.c3proj still registers what this call added');
    expect(existsSync(path('objectTypes', 'Actors', 'Hero.json'))).toBe(true);
    expect(existsSync(path('images', 'hero-default-000.png'))).toBe(true);
    const registered = treeFiles((await project()).objectTypes, 'objectTypes');
    expect(registered).toContain('objectTypes/Actors/Hero.json');
    for (const file of registered) expect(existsSync(path(...file.split('/'))), file).toBe(true);
  });
});

describe('duplicate_timeline', () => {
  /** Change the timelines tree of project.c3proj and reload it. */
  async function editTimelines(change: (tree: Folder) => void): Promise<void> {
    const registered = await project();
    change(registered.timelines);
    await writeJson(['project.c3proj'], registered);
    await reader.reloadProject();
  }

  /** A nameless first-level folder holding the custom ease Ease1, as the editor writes it. */
  const addEase = () => editTimelines(tree => { tree.subfolders.unshift({ items: ['Ease1'], subfolders: [] }); });

  it('copies a timeline under a new name next to the source, in the style of the project', async () => {
    const source = await readJson<Obj>('timelines', 'Intro.json');
    const data = await call('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' });
    expect(data.isError).not.toBe(true);
    expect(data).toMatchObject({ success: true, entity: 'Copy', category: 'timeline', action: 'duplicated', source: 'Intro' });
    expect(data.tracks).toBe((source.tracks as unknown[]).length);
    expect(warningsOf(data)).toContain('animates the same instances');
    expect(data.backupFile).toContain('project.c3proj');
    const copy = await readJson<Obj>('timelines', 'Copy.json');
    expect(copy.name).toBe('Copy');
    expect(copy.tracks).toEqual(source.tracks);
    expect({ ...copy, name: 'Intro' }).toEqual(source);
    expect(Object.keys(copy)).toEqual(Object.keys(source));
    expect((await project()).timelines.items).toEqual(['Intro', 'Copy']);
  });

  it('writes the copy in the style of the project, whatever the BOM and line endings of the source', async () => {
    const projectText = await text('project.c3proj');
    expect(projectText).toContain('\r\n');
    const sourceText = await text('timelines', 'Intro.json');
    const source = JSON.parse(sourceText) as Obj;

    await writeFile(path('timelines', 'Intro.json'), '\uFEFF' + sourceText.replace(/\r\n/g, '\n'));
    expect((await readFile(path('timelines', 'Intro.json')))[0]).toBe(0xef);
    expect((await call('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' })).isError).not.toBe(true);
    const crlfCopy = await text('timelines', 'Copy.json');
    expect(crlfCopy.charCodeAt(0)).not.toBe(0xfeff);
    expect(crlfCopy.replace(/\r\n/g, '')).not.toContain('\n');
    expect(crlfCopy).toContain('\r\n');
    expect(JSON.parse(crlfCopy)).toEqual({ ...source, name: 'Copy' });

    await writeFile(path('project.c3proj'), projectText.replace(/\r\n/g, '\n'));
    await writeFile(path('timelines', 'Intro.json'), '\uFEFF' + sourceText.replace(/\r?\n/g, '\r\n'));
    expect((await readFile(path('timelines', 'Intro.json')))[0]).toBe(0xef);
    await reader.reloadProject();
    expect((await call('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy 2' })).isError).not.toBe(true);
    const lfCopy = await text('timelines', 'Copy 2.json');
    expect(lfCopy.charCodeAt(0)).not.toBe(0xfeff);
    expect(lfCopy).not.toContain('\r');
    expect(JSON.parse(lfCopy)).toEqual({ ...source, name: 'Copy 2' });
  });

  it('gives no warning for a timeline without tracks', async () => {
    const source = await readJson<Obj>('timelines', 'Intro.json');
    await writeJson(['timelines', 'Intro.json'], { ...source, tracks: [] });
    const data = await call('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' });
    expect(data.isError).not.toBe(true);
    expect(data.tracks).toBe(0);
    expect(data.warnings).toBeUndefined();
  });

  it('refuses a custom ease', async () => {
    await addEase();
    await refusal('duplicate_timeline', { timelineName: 'Ease1', newName: 'Copy' }, '"Ease1" is a custom ease, not a timeline');
  });

  it('refuses a timeline that is not at the root of the timelines tree, naming the folder', async () => {
    await editTimelines(tree => {
      tree.subfolders.push({ name: 'Cutscenes', items: ['Cut 1'], subfolders: [] });
    });
    await refusal('duplicate_timeline', { timelineName: 'Cut 1', newName: 'Copy' },
      'Timeline "Cut 1" is in folder "Cutscenes"; only timelines at the root can be duplicated.');
    await refusal('duplicate_timeline', { timelineName: 'Swipe', newName: 'Copy' }, 'is in folder "transitions"');
    await addEase();
    await editTimelines(tree => { tree.subfolders.push({ items: ['Odd'], subfolders: [] }); });
    await refusal('duplicate_timeline', { timelineName: 'Odd', newName: 'Copy' },
      'Timeline "Odd" is in an unnamed folder; only timelines at the root can be duplicated.');
  });

  it('refuses a project without a timelines tree', async () => {
    const registered = await project();
    Reflect.deleteProperty(registered, 'timelines');
    await writeJson(['project.c3proj'], registered);
    await reader.reloadProject();
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' }, 'project.c3proj has no timelines tree.');
  });

  it('refuses a name a timeline or transition uses, an unknown timeline, a case-variant source and a name that cannot be used', async () => {
    await addEase();
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'intro' }, '"Intro" is already a timeline or transition name');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'swipe' }, '"Swipe" is already a timeline or transition name');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'ease1' }, '"Ease1" is already a timeline or transition name');
    await refusal('duplicate_timeline', { timelineName: 'intro', newName: 'Copy' }, 'names are matched with their letter case', 'Did you mean "Intro"?');
    await refusal('duplicate_timeline', { timelineName: 'Nope', newName: 'Copy' }, 'Timeline "Nope" not found.');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'bad/name' }, 'Name must start with a letter or underscore');
  });

  it('refuses a timeline file that cannot be read or parsed, without a path', async () => {
    await writeFile(path('timelines', 'Intro.json'), '{ broken');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' }, 'Timeline "Intro" could not be read (not valid JSON).');
    await rm(path('timelines', 'Intro.json'));
    await mkdir(path('timelines', 'Intro.json'));
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' }, 'Timeline "Intro" could not be read (could not be read).');
    await rm(path('timelines', 'Intro.json'), { recursive: true });
    await writeFile(path('timelines', 'Intro.json'), '[]');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' }, 'Timeline "Intro" could not be read (not a JSON object).');
  });

  it('refuses a copy over the size limit when its source file is under it, before anything is written', async () => {
    vi.stubEnv('C3MCP_MAX_FILE_MB', '1');
    const source = await readJson<Obj & { tracks: unknown[] }>('timelines', 'Intro.json');
    const [track] = source.tracks;
    source.tracks = Array.from({ length: 1100 }, () => structuredClone(track));
    // Saved compact: under the limit on disk, over it once the writer tab-indents it
    await writeFile(path('timelines', 'Intro.json'), JSON.stringify(source));
    expect((await stat(path('timelines', 'Intro.json'))).size).toBeLessThan(MB);
    expect(JSON.stringify(source, null, '\t').length).toBeGreaterThan(MB);

    const validateJsonData = vi.spyOn(writer, 'validateJsonData');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' },
      'Generated JSON for "Copy" is too large (at least', 'over the 1MB limit');
    expect(validateJsonData.mock.calls.map(([, name]) => name)).toEqual(['Copy']);
    expect(existsSync(path('timelines', 'Copy.json'))).toBe(false);
    expect(treeFiles((await project()).timelines, 'timelines').some(file => file.endsWith('/Copy.json'))).toBe(false);
  });

  it('says Nothing was changed. when a step before the write throws unexpectedly, without a path', async () => {
    const failure = Object.assign(new Error(`EACCES: permission denied, scandir '${path('timelines')}'`), { code: 'EACCES', path: path('timelines') });
    // The first getProjectDir call after the source file was read throws, however many calls the reader made while reading it
    const readSource = reader.readDataFileText.bind(reader);
    const projectDir = reader.getProjectDir.bind(reader);
    let sourceRead = false;
    let thrown = false;
    vi.spyOn(reader, 'readDataFileText').mockImplementation(async (...args) => {
      const content = await readSource(...args);
      sourceRead = true;
      return content;
    });
    vi.spyOn(reader, 'getProjectDir').mockImplementation(() => {
      if (sourceRead && !thrown) {
        thrown = true;
        throw failure;
      }
      return projectDir();
    });
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' }, 'Error duplicating timeline: EACCES on timelines. Nothing was changed.');
  });

  it('removes the new file when the registration fails, rolling back once', async () => {
    const undoToolCall = vi.spyOn(writer, 'undoToolCall');
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotProject();
    const data = await call('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('boom. The call was rolled back: timelines/Copy.json (removed: the call had created it) is as before the call.');
    expect(await snapshotProject()).toEqual(before);
    expect(undoToolCall).toHaveBeenCalledTimes(1);
  });

  it('says the writes could not be undone, naming the files, when the rollback itself fails', async () => {
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const failure = Object.assign(new Error(`EACCES: permission denied, open '${path('project.c3proj')}'`), { code: 'EACCES', path: path('project.c3proj') });
    vi.spyOn(writer, 'undoToolCall').mockRejectedValueOnce(failure);
    const data = await call('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain("boom. The call's writes could not be undone (EACCES on project.c3proj)");
    expect(data.text).toContain('timelines/Copy.json');
    expect(data.text).not.toContain('Nothing was changed');
    expect(data.text).not.toContain(tmpDir);
  });

  it('refuses a timeline file that exists unregistered under the new name, in any letter case, before any write', async () => {
    await writeFile(path('timelines', 'Copy.json'), '{"keep":1}');
    const writes = vi.spyOn(writer, 'replaceFile');
    const updates = vi.spyOn(writer, 'updateProject');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' },
      'timelines/Copy.json already exists and is not registered; move or delete it first. Nothing was changed.');
    expect(await text('timelines', 'Copy.json')).toBe('{"keep":1}');
    await rm(path('timelines', 'Copy.json'));
    await writeFile(path('timelines', 'copy.json'), '{"keep":2}');
    await refusal('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' },
      'timelines/copy.json already exists and is not registered; move or delete it first. Nothing was changed.');
    expect(await text('timelines', 'copy.json')).toBe('{"keep":2}');
    expect(writes).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });

  it('leaves a file that appears at the target after that check as it is, and registers nothing', async () => {
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementationOnce(async (file, content, options) => {
      await writeFile(file, '{"planted":true}');
      return replaceFile(file, content, options);
    });
    const updates = vi.spyOn(writer, 'updateProject');
    const before = await snapshotProject();
    const data = await call('duplicate_timeline', { timelineName: 'Intro', newName: 'Copy' });
    expect(data.isError).toBe(true);
    expect(data.text).toMatch(/Nothing was changed\.$/);
    expect(data.text).not.toMatch(/already exists and is not registered; move or delete/);
    expect(data.text).not.toContain(tmpDir);
    expect(await text('timelines', 'Copy.json')).toBe('{"planted":true}');
    expect(updates).not.toHaveBeenCalled();
    expect((await project()).timelines.items).toEqual(['Intro']);
    const after = await snapshotProject();
    after.delete('timelines/Copy.json');
    before.delete('timelines/Copy.json');
    expect(after).toEqual(before);
  });
});

describe('a refused call', () => {
  it('leaves the event sheets and object types the reader holds as they were', async () => {
    const sheets = structuredClone([...(await reader.readAllEventSheets()).entries()]);
    const objects = structuredClone([...(await reader.readAllObjectTypes()).entries()]);
    await call('duplicate_event_sheet', { sheetName: 'Main', newName: 'Main Copy' });
    await call('duplicate_object_type', { objectName: 'Player', newName: 'enemy' });
    expect([...(await reader.readAllEventSheets()).entries()]).toEqual(sheets);
    expect([...(await reader.readAllObjectTypes()).entries()]).toEqual(objects);
  });

  it('leaves the layouts the reader holds as they were', async () => {
    const before = structuredClone([...(await reader.readAllLayouts()).entries()]);
    await call('duplicate_layout', { layoutName: 'Level 1', newName: 'level 2' });
    await call('duplicate_layer', { layoutName: 'Level 1', layerName: 'Game', newName: 'Game2' });
    expect([...(await reader.readAllLayouts()).entries()]).toEqual(before);
  });
});
