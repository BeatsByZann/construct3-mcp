/**
 * rename_object_type and rename_family: the object type's file, its "name" and
 * its project-bar entry change, and so does everything that names it (event
 * sheet objects, parameters and expressions, layout instances, families,
 * containers, its frame image files and its tilemap brush file); strings,
 * scripts, timeline tracks and flowchart nodes are only listed. A dry run
 * writes nothing; files that could not be parsed refuse without force; a
 * failure midway puts back every file; a run that stopped midway is finished
 * by the same call. Checked on a temp copy of the minimal fixture with the
 * real reader, writer and ID generator; every object type, family, sheet,
 * layout, timeline and image added here is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { gate, letOthersRun, track } from '../helpers/barrier.js';
import { Construct3ProjectReader, ProjectReadError } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectRenameTools, planObjectImageRenames } from '../../src/tools/object-rename.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Args = Record<string, unknown>;

interface Folder { name?: string; items: string[]; subfolders: Folder[] }
interface ProjectFile {
  objectTypes: Folder;
  families: Folder;
  layouts: Folder;
  eventSheets: Folder;
  timelines: Folder;
  containers?: Array<{ members: string[] }>;
  rootFileFolders: { script: { items: unknown[] } };
  [key: string]: unknown;
}
interface AceJson {
  id?: string;
  objectClass?: string;
  customActionObjectClass?: string;
  parameters?: Record<string, unknown>;
  script?: string[];
  [key: string]: unknown;
}
interface EventJson { conditions: AceJson[]; actions: AceJson[]; [key: string]: unknown }
interface SheetFile { events: EventJson[]; [key: string]: unknown }
interface InstanceJson { type: string; [key: string]: unknown }
interface LayerJson { instances: InstanceJson[]; subLayers?: LayerJson[]; [key: string]: unknown }
interface LayoutFile { layers: LayerJson[]; [key: string]: unknown }
interface ObjectFile {
  name?: string;
  sid?: number;
  animations: { items: unknown[] };
  'singleglobal-inst'?: { type: string; [key: string]: unknown };
  [key: string]: unknown;
}
interface FamilyFile { name?: string; members: string[]; [key: string]: unknown }
interface FlowFile { nodes: Array<{ c: string }>; [key: string]: unknown }

interface UseJson { in: string; kind: string; [key: string]: unknown }
interface ToolData {
  isError?: boolean;
  text?: string;
  message?: string;
  success?: boolean;
  dryRun?: boolean;
  action?: string;
  stoppedRun?: boolean;
  editorNote?: string;
  previousName?: string;
  fileDeleted?: string;
  fileToDelete?: string;
  brushFileToDelete?: string;
  brushMoved?: { from: string; to: string };
  backupFile?: string;
  filesWritten?: string[];
  filesToWrite?: string[];
  imageRenames?: Array<{ from: string; to: string }>;
  warnings?: string[];
  references?: UseJson[];
  possibleReferences?: UseJson[];
  viewStateMoved?: Array<{ from: string; to: string }>;
  unscannedFiles?: unknown[];
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const path = (...parts: string[]) => join(tmpDir, ...parts);
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const writeJson = (file: string, data: unknown) => writeFile(file, JSON.stringify(data, null, '\t'));
const call = async (tool: string, args: Args): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const warningsOf = (data: ToolData) => (data.warnings ?? []).join(' ');
const rename_ = (name: string, newName: string, extra: Args = {}) => call('rename_object_type', { name, newName, ...extra });

/** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
async function editorSave(file: string, text: string): Promise<void> {
  await writeFile(file, text);
  const { mtime } = await stat(file);
  const later = new Date(mtime.getTime() + 2000);
  await utimes(file, later, later);
}

/** Every file of the project with its bytes, .bak files left out. */
async function snapshot(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.endsWith('.bak')) files.set(relative(tmpDir, full).split('\\').join('/'), await readFile(full, 'utf8'));
    }
  };
  await walk(tmpDir);
  return files;
}

/** A call that must be refused: an error that contains `parts` and ends with "Nothing was changed." once. */
async function refusal(tool: string, args: Args, ...parts: string[]): Promise<ToolData> {
  const data = await call(tool, args);
  expect(data.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
  for (const part of parts) expect(data.text, `${tool} ${JSON.stringify(args)}`).toContain(part);
  expect(data.text, `${tool} ${JSON.stringify(args)}`).toMatch(/Nothing was changed\.$/);
  expect(data.text, `${tool} ${JSON.stringify(args)}`).not.toContain(tmpDir);
  return data;
}

const frame = () => ({ width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1 });
const animation = (name: string, sid: number, frames: number) => ({
  name, sid, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, frames: Array.from({ length: frames }, frame),
});
const spriteFile = (name: string, sid: number, animations: unknown[]) => ({
  name, 'plugin-id': 'Sprite', sid, isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [], animations: { items: animations, subfolders: [] },
});
const instance = (type: string, uid: number, sid: number) => ({
  type, uid, sid, tags: '', properties: {}, instanceVariables: {}, behaviors: {}, world: { x: 1, y: 2, width: 64, height: 64 },
});

const ALPHA_SID = 210000000000001;

/**
 * The fixture plus: object type "Alpha" (a Sprite with animation "Default" of
 * two frames, images/alpha-default-000.png and -001.png) and "Floor" (a Tiled
 * Background with images/floor.png); family "Fam" with member Alpha; a
 * container of Alpha and Sprite; Alpha instances on "Layout 1" (one on a
 * sub-layer); in "MainSheet" an event that names Alpha as a condition and
 * action object, in an expression, as an object parameter and as the object
 * of an instance variable parameter, and a string and a script line that
 * mention it; the timeline "Intro" with a track of Alpha; and an
 * objecttypes.uistate.json that lists Alpha.
 */
async function setUpProject(): Promise<void> {
  const project = await readJson<ProjectFile>(path('project.c3proj'));
  project.objectTypes.items.push('Alpha', 'Floor');
  project.families.items.push('Fam');
  project.containers = [{ members: ['Alpha', 'Sprite'] }];
  project.timelines.items.push('Intro');
  await writeJson(path('project.c3proj'), project);

  await writeJson(path('objectTypes', 'Alpha.json'), spriteFile('Alpha', ALPHA_SID, [animation('Default', 310000000000001, 2)]));
  await writeJson(path('objectTypes', 'Floor.json'), {
    name: 'Floor', 'plugin-id': 'TiledBg', sid: 210000000000002, isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
    image: { fileType: 'image/png', width: 64, height: 64 },
  });
  await mkdir(path('families'), { recursive: true });
  await writeJson(path('families', 'Fam.json'), { name: 'Fam', sid: 220000000000001, members: ['Alpha'], instanceVariables: [], behaviorTypes: [], effectTypes: [] });
  await mkdir(path('images'), { recursive: true });
  await writeFile(path('images', 'alpha-default-000.png'), 'alpha frame 0');
  await writeFile(path('images', 'alpha-default-001.png'), 'alpha frame 1');
  await writeFile(path('images', 'floor.png'), 'floor image');

  const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
  layout.layers[0].instances.push(instance('Alpha', 1, 500000000000010));
  layout.layers[0].subLayers = [{ name: 'Sub', sid: 500000000000011, instances: [instance('Alpha', 2, 500000000000012)], subLayers: [] }];
  await writeJson(path('layouts', 'Layout 1.json'), layout);

  const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
  main.events.push({
    eventType: 'block',
    conditions: [{ id: 'is-visible', objectClass: 'ALPHA', sid: 400000000000010 }],
    actions: [
      { id: 'set-x', objectClass: 'Sprite', sid: 400000000000011, parameters: { x: 'Alpha.X' } },
      { id: 'create-object', objectClass: 'System', sid: 400000000000012, parameters: { 'object-to-create': 'Alpha', layer: '"Main"', x: '0', y: '0' } },
      { id: 'set-instvar', objectClass: 'Alpha', sid: 400000000000013, parameters: { 'instance-variable': { name: 'hp', objectClass: 'Alpha' }, value: '1' } },
      { id: 'set-text', objectClass: 'Sprite', sid: 400000000000014, parameters: { text: '"Alpha"' } },
      { type: 'script', language: 'javascript', script: ['const a = runtime.objects.Alpha;'] },
    ],
    sid: 400000000000015,
  });
  await writeJson(path('eventSheets', 'MainSheet.json'), main);

  await mkdir(path('timelines'), { recursive: true });
  await writeJson(path('timelines', 'Intro.json'), {
    name: 'Intro', totalTime: 5, startOnLayout: 'Layout 1', tracks: [{ type: 'instance-track', objectType: 'Alpha', worldInstance: 1 }],
  });
  await writeFile(path('objecttypes.uistate.json'), uiState(['Alpha', 'Sprite']));
  await reader.loadProject();
}

/** The text of objecttypes.uistate.json for entries of these object types, in Construct 3's own layout. */
function uiState(names: string[]): string {
  return JSON.stringify(names.map(name => [name, {}]), null, '\t');
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-rename-object-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerObjectRenameTools({ server, reader, writer, idGen } as never);
  registerAnimationTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
  await setUpProject();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

/** The writer's read-back of `fileName` fails once with an ordinary error. */
function failReadBackOf(fileName: string, before?: () => Promise<void>): void {
  const internals = writer as unknown as { verifyWrittenFile: (file: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  vi.spyOn(internals, 'verifyWrittenFile').mockImplementation(async (file, name, text) => {
    if (file.endsWith(fileName)) {
      await before?.();
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(file, name, text);
  });
}

/** A finished rename of Alpha to Gamma put back to what a run that stopped after its project update leaves: the old file beside the new, the images under the old names. */
async function stopAfterProjectUpdate(): Promise<void> {
  await copyFile(path('objectTypes', 'Alpha.json.bak'), path('objectTypes', 'Alpha.json'));
  await rename(path('images', 'gamma-default-000.png'), path('images', 'alpha-default-000.png'));
  await rename(path('images', 'gamma-default-001.png'), path('images', 'alpha-default-001.png'));
  await writeFile(path('objecttypes.uistate.json'), uiState(['Alpha', 'Sprite']));
  await reader.loadProject();
}

describe('rename_object_type', () => {
  it('renames the object with every definite reference', async () => {
    const before = await snapshot();
    const internals = writer as unknown as { atomicWrite: (file: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    const projectWrites: string[] = [];
    vi.spyOn(internals, 'atomicWrite').mockImplementation(async (file, content) => {
      if (file.endsWith('project.c3proj')) projectWrites.push(file);
      return atomicWrite(file, content);
    });
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.action).toBe('renamed');
    expect(data.previousName).toBe('Alpha');

    const renamed = await readJson<ObjectFile>(path('objectTypes', 'Gamma.json'));
    expect(renamed.name).toBe('Gamma');
    expect(renamed.sid).toBe(ALPHA_SID);
    expect(existsSync(path('objectTypes', 'Alpha.json'))).toBe(false);
    expect(existsSync(path('objectTypes', 'Alpha.json.bak'))).toBe(true);

    const project = await readJson<ProjectFile>(path('project.c3proj'));
    expect(project.objectTypes.items).toEqual(['Sprite', 'Gamma', 'Floor']);
    expect(project.containers).toEqual([{ members: ['Gamma', 'Sprite'] }]);
    expect(projectWrites).toHaveLength(1);
    expect((await readJson<FamilyFile>(path('families', 'Fam.json'))).members).toEqual(['Gamma']);

    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    expect(layout.layers[0].instances.map((i: InstanceJson) => i.type)).toEqual(['Sprite', 'Gamma']);
    expect(layout.layers[0].subLayers?.[0].instances[0].type).toBe('Gamma');

    const event = (await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'))).events[1];
    expect(event.conditions[0].objectClass).toBe('Gamma');
    expect(event.actions[0].parameters?.x).toBe('Gamma.X');
    expect(event.actions[1].parameters?.['object-to-create']).toBe('Gamma');
    expect(event.actions[2].objectClass).toBe('Gamma');
    expect(event.actions[2].parameters?.['instance-variable']).toEqual({ name: 'hp', objectClass: 'Gamma' });
    expect(event.actions[3].parameters?.text).toBe('"Alpha"');
    expect(event.actions[4].script).toEqual(['const a = runtime.objects.Alpha;']);

    // Track shapes are listed until an editor save has shown them
    const now = await snapshot();
    expect(now.get('timelines/Intro.json')).toBe(before.get('timelines/Intro.json'));
    expect(data.possibleReferences).toContainEqual({ in: 'timelines/Intro.json', kind: 'timeline track', value: 'Alpha' });
    expect(warningsOf(data)).toContain('1 timeline(s) have a value that is "Alpha"');

    expect(now.get('images/gamma-default-000.png')).toBe('alpha frame 0');
    expect(now.get('images/gamma-default-001.png')).toBe('alpha frame 1');
    expect([...now.keys()].filter(k => k.startsWith('images/alpha-'))).toEqual([]);
    expect(now.get('images/floor.png')).toBe('floor image');
    expect(data.imageRenames).toEqual([
      { from: 'images/alpha-default-000.png', to: 'images/gamma-default-000.png' },
      { from: 'images/alpha-default-001.png', to: 'images/gamma-default-001.png' },
    ]);

    expect(data.filesWritten).toEqual([
      'eventSheets/MainSheet.json', 'layouts/Layout 1.json', 'families/Fam.json', 'objectTypes/Gamma.json', 'project.c3proj',
      'images/gamma-default-000.png', 'images/gamma-default-001.png',
    ]);
    expect(data.fileDeleted).toBe('objectTypes/Alpha.json');
    const possible = (data.possibleReferences ?? []).map(r => `${r.in}|${r.kind}`);
    expect(possible).toContain('eventSheets/MainSheet.json|script');
    expect(possible).toContain('eventSheets/MainSheet.json|string literal');
    const warnings = warningsOf(data);
    expect(warnings).toContain('Pointed 2 condition or action object(s) that named "Alpha" at "Gamma"');
    expect(warnings).toContain('Pointed 1 object parameter(s)');
    expect(warnings).toContain('Pointed 1 instance variable parameter object(s)');
    expect(warnings).toContain('Pointed 1 expression(s) that use it as an object');
    expect(warnings).toContain('Pointed 2 layout instance(s)');
    expect(warnings).toContain('Pointed 1 family member(s)');
    expect(warnings).toContain('Renamed "Alpha" in 1 container(s) of project.c3proj');
    expect(warnings).toContain('Renamed 2 image file(s) in images/');
    expect(warnings).toContain('2 other expression(s), string(s), script line(s)');
    expect(warnings).toContain('were NOT changed');
  });

  it('deletes the old file after every other write', async () => {
    const order: string[] = [];
    const renameImageFiles = writer.renameImageFiles.bind(writer);
    const deleteEntityFile = writer.deleteEntityFile.bind(writer);
    vi.spyOn(writer, 'renameImageFiles').mockImplementation(async renames => { order.push('images'); return renameImageFiles(renames); });
    vi.spyOn(writer, 'deleteEntityFile').mockImplementation(async (...args) => { order.push('delete'); return deleteEntityFile(...args); });
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    expect(order).toEqual(['images', 'delete']);
  });

  it('does not delete the old file when the image rename fails', async () => {
    const deleteEntityFile = vi.spyOn(writer, 'deleteEntityFile');
    vi.spyOn(writer, 'renameImageFiles').mockRejectedValueOnce(new Error('EACCES'));
    expect((await rename_('Alpha', 'Gamma')).isError).toBe(true);
    expect(deleteEntityFile).not.toHaveBeenCalled();
  });

  it('writes only the files that still name the object when it reads them again', async () => {
    const before = await snapshot();
    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    layout.layers[0].instances = layout.layers[0].instances.filter(i => i.type !== 'Alpha');
    layout.layers[0].subLayers = [];
    vi.spyOn(reader, 'readEventSheet').mockResolvedValueOnce({ name: 'MainSheet', events: [], sid: 1 } as never);
    vi.spyOn(reader, 'readLayout').mockResolvedValueOnce(layout as never);
    vi.spyOn(reader, 'readFamily').mockResolvedValueOnce({ name: 'Fam', members: [], sid: 2 } as never);
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.filesWritten).toEqual(['objectTypes/Gamma.json', 'project.c3proj', 'images/gamma-default-000.png', 'images/gamma-default-001.png']);
    for (const file of ['eventSheets/MainSheet.json', 'layouts/Layout 1.json', 'families/Fam.json']) {
      expect((await snapshot()).get(file), file).toBe(before.get(file));
    }
  });

  it('names a file by its path in the project when a read during the writes fails', async () => {
    const before = await snapshot();
    const file = path('layouts', 'Layout 1.json');
    const cause = Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY', path: file });
    vi.spyOn(reader, 'readLayout').mockRejectedValueOnce(new ProjectReadError('E_READ_ERROR', `Failed to read layout "Layout 1": ${cause.message}`, { cause }));
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('EBUSY on layouts/Layout 1.json');
    expect(data.text).toContain('The call was rolled back:');
    expect(data.text).not.toContain(tmpDir);
    expect(await snapshot()).toEqual(before);
  });

  it('renames a single-image object type and its image file', async () => {
    const data = await rename_('Floor', 'Ground');
    expect(data.success).toBe(true);
    expect(data.imageRenames).toEqual([{ from: 'images/floor.png', to: 'images/ground.png' }]);
    expect(await readFile(path('images', 'ground.png'), 'utf8')).toBe('floor image');
    expect(existsSync(path('images', 'floor.png'))).toBe(false);
    expect(data.filesWritten).toEqual(['objectTypes/Ground.json', 'project.c3proj', 'images/ground.png']);
    expect((await readJson<ObjectFile>(path('objectTypes', 'Ground.json'))).name).toBe('Ground');
  });

  it('points a non-world instance at the new name', async () => {
    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    layout['nonworld-instances'] = [{ type: 'Alpha', uid: 9, sid: 500000000000020, properties: {} }];
    await writeJson(path('layouts', 'Layout 1.json'), layout);
    await reader.loadProject();
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    const renamed = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    expect((renamed['nonworld-instances'] as InstanceJson[])[0].type).toBe('Gamma');
    expect(warningsOf(data)).toContain('Pointed 3 layout instance(s)');
  });

  it('refuses without force when a layout that could not be parsed names the object, and renames with force', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.layouts.items.push('Broken');
    await writeJson(path('project.c3proj'), project);
    await writeFile(path('layouts', 'Broken.json'), '{"name":"Broken","layers":[{"instances":[{"type":"Alpha"} broken');
    await reader.loadProject();
    const before = await snapshot();
    const blocked = await rename_('Alpha', 'Gamma');
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.message).toContain('layouts/Broken');
    expect(blocked.message).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
    const forced = await rename_('Alpha', 'Gamma', { force: true });
    expect(forced.success).toBe(true);
    expect(warningsOf(forced)).toContain('Renamed with force=true');
    expect(await readFile(path('layouts', 'Broken.json'), 'utf8')).toBe('{"name":"Broken","layers":[{"instances":[{"type":"Alpha"} broken');
  });

  it('refuses without force when a family that could not be parsed names the object, and renames with force', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.families.items.push('Gang');
    await writeJson(path('project.c3proj'), project);
    await writeFile(path('families', 'Gang.json'), '{"name":"Gang","members":["Alpha"] broken');
    await reader.loadProject();
    const before = await snapshot();
    const blocked = await rename_('Alpha', 'Gamma');
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.message).toContain('families/Gang');
    expect(blocked.message).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
    const forced = await rename_('Alpha', 'Gamma', { force: true });
    expect(forced.success).toBe(true);
    expect(warningsOf(forced)).toContain('Renamed with force=true');
    expect(await readFile(path('families', 'Gang.json'), 'utf8')).toBe('{"name":"Gang","members":["Alpha"] broken');
  });

  it('refuses without force when a timeline has more values than the search reads', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.timelines.items.push('Big');
    await writeJson(path('project.c3proj'), project);
    await writeJson(path('timelines', 'Big.json'), { name: 'Big', totalTime: 5, tracks: [], values: Array.from({ length: 200_001 }, () => 'x') });
    await reader.loadProject();
    const before = await snapshot();
    const blocked = await rename_('Alpha', 'Gamma');
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.message).toContain('timelines/Big.json (more than 200000 values, not searched to the end)');
    expect(await snapshot()).toEqual(before);
  });

  it('answers not found when the same rename is run again after it finished, and writes nothing', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'Object type "Alpha" not found.');
    expect(await snapshot()).toEqual(before);
  });

  it('lists a project script file that reads it, and names one it cannot read', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.rootFileFolders.script.items = [{ name: 'main.js', type: 'text/javascript', sid: 110000000000001 }, { name: 'gone.js', type: 'text/javascript', sid: 110000000000002 }];
    await writeJson(path('project.c3proj'), project);
    await mkdir(path('scripts'), { recursive: true });
    await writeFile(path('scripts', 'main.js'), 'const a = runtime.objects.Alpha;\nconst b = 1;\n');
    await reader.loadProject();
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.possibleReferences).toContainEqual({ in: 'scripts/main.js', kind: 'script', value: 'const a = runtime.objects.Alpha;' });
    expect(warningsOf(data)).toContain('scripts/gone.js');
    expect(await readFile(path('scripts', 'main.js'), 'utf8')).toBe('const a = runtime.objects.Alpha;\nconst b = 1;\n');
  });

  it('lists a flowchart node whose "c" is the name, a parameter named like the object, and a value that differs only in case', async () => {
    await mkdir(path('flowcharts'), { recursive: true });
    await writeJson(path('flowcharts', 'Flow.json'), { name: 'Flow', nodes: [{ c: 'Alpha' }, { c: 'Beta' }] });
    await writeFile(path('flowcharts', 'Broken.json'), '{ broken');
    const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
    main.events.push({
      eventType: 'block', conditions: [], sid: 400000000000030,
      actions: [{ id: 'set-text', objectClass: 'Sprite', sid: 400000000000031, parameters: { Alpha: 'keyvalue', text: '"x"' } },
        { id: 'set-animation', objectClass: 'Sprite', sid: 400000000000032, parameters: { animation: 'alpha' } }],
    });
    await writeJson(path('eventSheets', 'MainSheet.json'), main);
    await reader.loadProject();
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.possibleReferences).toContainEqual({ in: 'flowcharts/Flow.json', kind: 'flowchart node', parameter: 'nodes[0].c', value: 'Alpha' });
    expect(data.possibleReferences).toContainEqual(expect.objectContaining({ kind: 'possible expression', parameter: 'Alpha', value: 'Alpha' }));
    expect(data.possibleReferences).toContainEqual(expect.objectContaining({ kind: 'possible expression', parameter: 'animation', value: 'alpha' }));
    expect(warningsOf(data)).toContain('flowcharts/Broken.json');
    const sheet = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
    expect(sheet.events[2].actions[0].parameters).toEqual({ Alpha: 'keyvalue', text: '"x"' });
    expect(sheet.events[2].actions[1].parameters?.animation).toBe('alpha');
    expect((await readJson<FlowFile>(path('flowcharts', 'Flow.json'))).nodes[0].c).toBe('Alpha');
  });

  it('names the timelines whose tracks it searched only for the name as a value', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.timelines.items.push('Quiet');
    await writeJson(path('project.c3proj'), project);
    await writeJson(path('timelines', 'Quiet.json'), { name: 'Quiet', totalTime: 5, tracks: [] });
    await reader.loadProject();
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(warningsOf(data)).toContain('The tracks of 1 timeline(s) were searched only for a value equal to "Alpha"');
    expect(warningsOf(data)).toContain('"Quiet"');
    expect(data.possibleReferences?.map(r => r.in)).not.toContain('timelines/Quiet.json');
  });

  it('points the single-global instance of the object type at the new name', async () => {
    const file = await readJson<ObjectFile>(path('objectTypes', 'Alpha.json'));
    file['singleglobal-inst'] = { type: 'Alpha', properties: {}, tags: '' };
    await writeJson(path('objectTypes', 'Alpha.json'), file);
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect((await readJson<ObjectFile>(path('objectTypes', 'Gamma.json')))['singleglobal-inst']?.type).toBe('Gamma');
    expect(data.references).toContainEqual({ in: 'objectTypes/Gamma.json', kind: 'single-global instance type', value: 'Alpha' });
  });

  it('with dryRun lists the references and the files and writes nothing', async () => {
    const before = await snapshot();
    const data = await rename_('Alpha', 'Gamma', { dryRun: true });
    expect(data.action).toBe('would_rename');
    expect(data.dryRun).toBe(true);
    expect(data.filesToWrite).toEqual([
      'eventSheets/MainSheet.json', 'layouts/Layout 1.json', 'families/Fam.json', 'objectTypes/Gamma.json', 'project.c3proj',
      'images/gamma-default-000.png', 'images/gamma-default-001.png',
    ]);
    expect(data.fileToDelete).toBe('objectTypes/Alpha.json');
    expect(data.imageRenames).toEqual([
      { from: 'images/alpha-default-000.png', to: 'images/gamma-default-000.png' },
      { from: 'images/alpha-default-001.png', to: 'images/gamma-default-001.png' },
    ]);
    expect(data.editorNote).toBeUndefined();
    expect((data.references ?? []).filter(r => r.kind === 'container member')).toHaveLength(1);
    expect(warningsOf(data)).toContain('Would point 2 condition or action object(s)');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an argument it does not take', async () => {
    await expect(server.callTool('rename_object_type', { name: 'Alpha', newName: 'Gamma', bogus: 1 })).rejects.toThrow();
    await expect(server.callTool('rename_family', { name: 'Fam', newName: 'Clan', bogus: 1 })).rejects.toThrow();
  });

  it('every refusal ends with Nothing was changed. and leaves every file as it was', async () => {
    const before = await snapshot();
    const cases: Array<[Args, ...string[]]> = [
      [{ name: 'Nope', newName: 'Gamma' }, 'Object type "Nope" not found.'],
      [{ name: 'Alph', newName: 'Gamma' }, 'Did you mean: Alpha'],
      [{ name: 'alpha', newName: 'Gamma' }, 'named "Alpha"'],
      [{ name: 'Alpha', newName: 'Alpha' }, 'already has this name'],
      [{ name: 'Alpha', newName: 'ALPHA' }, 'only the letter case'],
      [{ name: 'Alpha', newName: 'Sprite' }, 'Sprite'],
      [{ name: 'Alpha', newName: 'sprite' }, 'Sprite'],
      [{ name: 'Alpha', newName: 'fam' }, 'Fam'],
      [{ name: 'Alpha', newName: 'System' }],
      [{ name: 'Alpha', newName: 'system' }],
      [{ name: 'Alpha', newName: 'functions' }, 'Functions'],
      [{ name: 'Alpha', newName: 'Bad/Name' }, 'letters, digits and underscores'],
      [{ name: 'Alpha', newName: 'Big Alpha' }, 'expressions cannot name', '"BigAlpha"'],
      [{ name: 'Alpha', newName: ' Gamma' }, 'starts or ends with a space', '"Gamma"'],
      [{ name: 'Alpha', newName: 'Gamma ' }, 'starts or ends with a space', '"Gamma"'],
      [{ name: 'Alpha', newName: 'Ga.mma' }, 'the punctuation is removed', '"Gamma"'],
      [{ name: 'Alpha', newName: 'Ga-mma' }, '"Gamma"'],
      [{ name: 'Alpha', newName: '' }],
      [{ name: 'Fam', newName: 'Gamma' }, 'Object type "Fam" not found.'],
    ];
    for (const [args, ...parts] of cases) {
      await refusal('rename_object_type', args, ...parts);
      expect(await snapshot(), JSON.stringify(args)).toEqual(before);
    }

    // A file at the new name that is not the stopped run's
    await writeJson(path('objectTypes', 'Gamma.json'), { name: 'Gamma', sid: 1 });
    const withOther = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'objectTypes/Gamma.json');
    expect(await snapshot()).toEqual(withOther);
    await rm(path('objectTypes', 'Gamma.json'));

    // The object's own file unparsable
    const original = await readFile(path('objectTypes', 'Alpha.json'), 'utf8');
    await writeFile(path('objectTypes', 'Alpha.json'), '{ broken');
    const broken = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'could not be parsed');
    expect(await snapshot()).toEqual(broken);
    await writeFile(path('objectTypes', 'Alpha.json'), original);

    // A scan that throws before any write
    vi.spyOn(reader, 'readAllLayouts').mockRejectedValueOnce(new Error('scan failed.'));
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'The rename stopped before anything was written: scan failed.');
    expect(await snapshot()).toEqual(before);
  });

  it('names a file by its path in the project when an fs error stops the scan', async () => {
    const before = await snapshot();
    const file = path('eventSheets', 'MainSheet.json');
    vi.spyOn(reader, 'readAllEventSheets').mockRejectedValueOnce(Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES', path: file }));
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'The rename stopped before anything was written: EACCES on eventSheets/MainSheet.json.');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a frame image shared with another object type, before anything is written', async () => {
    // Alpha has animation "b-x" and the registered object type "Alpha-b" has animation "x": both use images/alpha-b-x-000.png
    const alpha = await readJson<ObjectFile>(path('objectTypes', 'Alpha.json'));
    alpha.animations.items.push(animation('b-x', 310000000000009, 1));
    await writeJson(path('objectTypes', 'Alpha.json'), alpha);
    await writeJson(path('objectTypes', 'Alpha-b.json'), spriteFile('Alpha-b', 210000000000009, [animation('x', 310000000000010, 1)]));
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.objectTypes.items.push('Alpha-b');
    await writeJson(path('project.c3proj'), project);
    await writeFile(path('images', 'alpha-b-x-000.png'), 'shared');
    await reader.loadProject();
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'images/alpha-b-x-000.png', 'used by another object type');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a frame image named after an object type whose file cannot be parsed, before anything is written', async () => {
    await writeFile(path('objectTypes', 'Alpha-default.json'), '{ broken');
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.objectTypes.items.push('Alpha-default');
    await writeJson(path('project.c3proj'), project);
    await reader.loadProject();
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'images/alpha-default-000.png', 'could not be parsed');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a new image file name that is taken, before anything is written', async () => {
    await writeFile(path('images', 'gamma-default-001.png'), 'taken');
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'images/gamma-default-001.png', 'already exist');
    expect(await snapshot()).toEqual(before);
  });

  it('plans no image renames for an object type that has none', () => {
    expect(planObjectImageRenames('Alpha', 'Gamma', { name: 'Alpha' }, ['alpha-default-000.png'], new Map(), [])).toEqual({ renames: [] });
  });

  it('refuses without force when an event sheet that could not be parsed names the object, and renames with force', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.eventSheets.items.push('Other');
    await writeJson(path('project.c3proj'), project);
    await writeFile(path('eventSheets', 'Other.json'), '{"name":"Other","events":[{"objectClass":"Alpha"} broken');
    await reader.loadProject();
    const before = await snapshot();
    const blocked = await rename_('Alpha', 'Gamma');
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.unscannedFiles).toBeDefined();
    expect(blocked.message).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
    const forced = await rename_('Alpha', 'Gamma', { force: true });
    expect(forced.success).toBe(true);
    expect(warningsOf(forced)).toContain('Renamed with force=true');
    expect(await readFile(path('eventSheets', 'Other.json'), 'utf8')).toBe('{"name":"Other","events":[{"objectClass":"Alpha"} broken');
  });

  it('refuses without force when a timeline cannot be read, and renames with force', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.timelines.items.push('Bad');
    await writeJson(path('project.c3proj'), project);
    await writeFile(path('timelines', 'Bad.json'), '{ broken');
    await reader.loadProject();
    const before = await snapshot();
    const blocked = await rename_('Alpha', 'Gamma');
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.message).toContain('timelines/Bad.json');
    expect(blocked.message).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
    const forced = await rename_('Alpha', 'Gamma', { force: true });
    expect(forced.success).toBe(true);
    expect(warningsOf(forced)).toContain('Renamed with force=true: Timeline file(s) that could not be read');
    expect(await readFile(path('timelines', 'Bad.json'), 'utf8')).toBe('{ broken');
  });

  it('puts every file back when the project update fails, before any image is renamed', async () => {
    const before = await snapshot();
    const renameImageFiles = vi.spyOn(writer, 'renameImageFiles');
    vi.spyOn(writer, 'renameInProject').mockRejectedValueOnce(new Error('disk full'));
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(renameImageFiles).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('puts every file back when the image rename fails', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'renameImageFiles').mockRejectedValueOnce(new Error('EACCES'));
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(await snapshot()).toEqual(before);
  });

  describe.each([
    ['as an object type in another folder', (project: ProjectFile) => { project.objectTypes.subfolders.push({ name: 'Other', items: ['Gamma'], subfolders: [] }); }, 'Gamma'],
    ['as a family', (project: ProjectFile) => { project.families.items.push('Gamma'); }, 'Gamma'],
    ['with the object type moved to another folder', (project: ProjectFile) => {
      project.objectTypes.items = project.objectTypes.items.filter((i: string) => i !== 'Alpha');
      project.objectTypes.subfolders.push({ name: 'Moved', items: ['Alpha'], subfolders: [] });
    }, 'moved'],
  ])('when the editor saves project.c3proj during the call', (label, change, mention) => {
    it(`refuses and keeps the editor's save: ${label}`, async () => {
      const before = await snapshot();
      const renameInProject = writer.renameInProject.bind(writer);
      let saved = '';
      vi.spyOn(writer, 'renameInProject').mockImplementation(async (...args) => {
        const project = await readJson<ProjectFile>(path('project.c3proj'));
        change(project);
        saved = JSON.stringify(project);
        await editorSave(path('project.c3proj'), saved);
        return renameInProject(...args);
      });
      const data = await rename_('Alpha', 'Gamma');
      expect(data.isError).toBe(true);
      expect(data.text).toContain(mention);
      expect(data.text).not.toContain(tmpDir);
      expect(await readFile(path('project.c3proj'), 'utf8')).toBe(saved);
      const now = await snapshot();
      now.delete('project.c3proj');
      before.delete('project.c3proj');
      expect(now).toEqual(before);
      expect(existsSync(path('objectTypes', 'Gamma.json'))).toBe(false);
    });
  });

  it('renames the images back when the old file\'s delete fails after them', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('EBUSY'));
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('images/ (2 file(s) the call renamed, renamed back)');
    expect(await snapshot()).toEqual(before);
  });

  it('puts every file back when a layout\'s read-back fails', async () => {
    const before = await snapshot();
    failReadBackOf('Layout 1.json');
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(await snapshot()).toEqual(before);
  });

  it('leaves a layout the editor saved after the failed write, and puts the other files back', async () => {
    const before = await snapshot();
    const saved = '{"name":"Layout 1","layers":[],"sid":500000000000003,"saved":"in the editor"}';
    failReadBackOf('Layout 1.json', () => editorSave(path('layouts', 'Layout 1.json'), saved));
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('layouts/Layout 1.json.bak');
    expect(data.text).toContain('rolled back only in part');
    expect(await readFile(path('layouts', 'Layout 1.json'), 'utf8')).toBe(saved);
    const now = await snapshot();
    now.delete('layouts/Layout 1.json');
    before.delete('layouts/Layout 1.json');
    expect(now).toEqual(before);
  });

  it('keeps an event sheet the editor saved during the call', async () => {
    const before = await snapshot();
    const original = writer.writeEntityFile.bind(writer);
    const saved = '{"name":"MainSheet","events":[{"eventType":"comment","text":"saved in the editor"}],"sid":400000000000004}';
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, data, subfolder, options) => {
      if (name === 'MainSheet') await editorSave(path('eventSheets', 'MainSheet.json'), saved);
      return original(category, name, data, subfolder, options);
    });
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('was changed on disk');
    expect(await readFile(path('eventSheets', 'MainSheet.json'), 'utf8')).toBe(saved);
    const now = await snapshot();
    now.delete('eventSheets/MainSheet.json');
    before.delete('eventSheets/MainSheet.json');
    expect(now).toEqual(before);
  });

  it('finishes an object rename that stopped after the project update, renaming its images', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    await stopAfterProjectUpdate();
    const dry = await rename_('Alpha', 'Gamma', { dryRun: true });
    expect(dry.stoppedRun).toBe(true);
    expect(dry.filesToWrite).toEqual(['images/gamma-default-000.png', 'images/gamma-default-001.png']);
    expect(existsSync(path('images', 'alpha-default-000.png'))).toBe(true);

    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.stoppedRun).toBe(true);
    expect(existsSync(path('images', 'gamma-default-000.png'))).toBe(true);
    expect(existsSync(path('images', 'alpha-default-001.png'))).toBe(false);
    expect(existsSync(path('objectTypes', 'Alpha.json'))).toBe(false);
    expect(data.viewStateMoved).toEqual([{ from: 'objecttypes.uistate.json', to: 'objecttypes.uistate.json' }]);
    expect(await readFile(path('objecttypes.uistate.json'), 'utf8')).toBe(uiState(['Gamma', 'Sprite']));
  });

  it('refuses a stopped run whose old file holds another SID as not found', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    await writeJson(path('objectTypes', 'Alpha.json'), { name: 'Alpha', sid: 5 });
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'Object type "Alpha" not found.');
    expect(await snapshot()).toEqual(before);
  });

  it('runs one at a time with the animation tools', async () => {
    const reached = gate();
    const release = gate();
    const renameImageFiles = writer.renameImageFiles.bind(writer);
    let held = false;
    vi.spyOn(writer, 'renameImageFiles').mockImplementation(async renames => {
      if (!held) {
        held = true;
        reached.open();
        await release.opened;
      }
      return renameImageFiles(renames);
    });
    const arrived = gate();
    let held2 = false;
    let ranInLock = false;
    const withAnimationLock = writer.withAnimationLock.bind(writer);
    vi.spyOn(writer, 'withAnimationLock').mockImplementation(<T>(fn: () => Promise<T>) => {
      if (!held2) return withAnimationLock(fn);
      arrived.open();
      return withAnimationLock(() => {
        ranInLock = true;
        return fn();
      });
    });
    const renaming = track(server.callTool('rename_object_type', { name: 'Alpha', newName: 'Gamma' }));
    await reached.opened;
    held2 = true;
    const animating = track(server.callTool('rename_animation', { objectName: 'Gamma', animationName: 'Default', newName: 'Run' }));
    await arrived.opened;
    await letOthersRun();
    expect(ranInLock, 'the animation tool ran while the object type was being renamed').toBe(false);
    expect(animating.settled()).toBe(false);
    release.open();
    const [renamed, animated] = await Promise.all([renaming.promise, animating.promise]);
    expect(renamed.isError, renamed.content[0].text).toBeFalsy();
    expect(animated.isError, animated.content[0].text).toBeFalsy();
    expect(ranInLock).toBe(true);
    // The animation tool found the object under its new name, with its images
    expect(existsSync(path('images', 'gamma-run-000.png'))).toBe(true);
    expect(existsSync(path('images', 'gamma-default-000.png'))).toBe(false);
  });

  it('moves the entry of objecttypes.uistate.json with the object type, in the file\'s own style', async () => {
    const data = await rename_('Alpha', 'Gamma');
    expect(await readFile(path('objecttypes.uistate.json'), 'utf8')).toBe(uiState(['Gamma', 'Sprite']));
    expect(data.viewStateMoved).toEqual([{ from: 'objecttypes.uistate.json', to: 'objecttypes.uistate.json' }]);
  });

  it('leaves objecttypes.uistate.json and does not list it when it has no entry of the object type', async () => {
    await writeFile(path('objecttypes.uistate.json'), '[]');
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(await readFile(path('objecttypes.uistate.json'), 'utf8')).toBe('[]');
    expect(data.viewStateMoved).toBeUndefined();
    expect(warningsOf(data)).not.toContain('view state');
  });

  it('warns when objecttypes.uistate.json names the object type but cannot be read as entries', async () => {
    await writeFile(path('objecttypes.uistate.json'), '{"Alpha": 1, broken');
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(await readFile(path('objecttypes.uistate.json'), 'utf8')).toBe('{"Alpha": 1, broken');
    expect(warningsOf(data)).toContain('The editor\'s view state objecttypes.uistate.json still names "Alpha"');
  });
});

describe('rename_object_type and tilemap brushes', () => {
  const brushDir = ['tilemapBrushes', 'objectTypes'];
  const oldBrush = () => path(...brushDir, 'Alpha.brush.json');
  const newBrush = () => path(...brushDir, 'Gamma.brush.json');

  beforeEach(async () => {
    await mkdir(path(...brushDir), { recursive: true });
    await writeFile(oldBrush(), '{"brushes":["alpha"]}');
  });

  it('moves the brush file with the object type', async () => {
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(await readFile(newBrush(), 'utf8')).toBe('{"brushes":["alpha"]}');
    expect(existsSync(oldBrush())).toBe(false);
    expect(existsSync(`${oldBrush()}.bak`)).toBe(true);
    expect(data.filesWritten?.slice(-2)).toEqual(['images/gamma-default-001.png', 'tilemapBrushes/objectTypes/Gamma.brush.json']);
    expect(data.brushMoved).toEqual({ from: 'tilemapBrushes/objectTypes/Alpha.brush.json', to: 'tilemapBrushes/objectTypes/Gamma.brush.json' });
    expect(warningsOf(data)).toContain('Moved the tilemap brush file');
  });

  it('lists the brush file in a dry run and writes nothing', async () => {
    const before = await snapshot();
    const data = await rename_('Alpha', 'Gamma', { dryRun: true });
    expect(data.filesToWrite).toContain('tilemapBrushes/objectTypes/Gamma.brush.json');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a new brush name that holds other content', async () => {
    await writeFile(newBrush(), '{"other":true}');
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'tilemapBrushes/objectTypes/Gamma.brush.json', 'already exists with other content');
    expect(await snapshot()).toEqual(before);
  });

  it('puts every file back when the brush move fails', async () => {
    const before = await snapshot();
    const deleteFile = writer.deleteFile.bind(writer);
    vi.spyOn(writer, 'deleteFile').mockImplementation(async (file, options) => {
      if (file.endsWith('Alpha.brush.json')) throw new Error('EBUSY');
      return deleteFile(file, options);
    });
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back');
    expect(await snapshot()).toEqual(before);
  });

  it('keeps an old brush file the editor saved after it was read, and rolls back', async () => {
    const before = await snapshot();
    const replaceFile = writer.replaceFile.bind(writer);
    const saved = '{"brushes":["alpha","edited in the editor"]}';
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      if (file.endsWith('Gamma.brush.json')) await editorSave(oldBrush(), saved);
      return replaceFile(file, content, options);
    });
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('was changed on disk');
    expect(await readFile(oldBrush(), 'utf8')).toBe(saved);
    expect(existsSync(newBrush())).toBe(false);
    const now = await snapshot();
    now.delete('tilemapBrushes/objectTypes/Alpha.brush.json');
    before.delete('tilemapBrushes/objectTypes/Alpha.brush.json');
    expect(now).toEqual(before);
  });

  it('refuses a brush file under the new name that no run of this rename left, naming it', async () => {
    await rm(oldBrush());
    await writeFile(newBrush(), '{"brushes":["a removed object type\'s"]}');
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'tilemapBrushes/objectTypes/Gamma.brush.json', 'no brush file of "Alpha"');
    expect(await snapshot()).toEqual(before);
  });

  it('moves a brush file that is in another folder than the object type\'s, within that folder, and says so', async () => {
    await mkdir(path(...brushDir, 'Maps'), { recursive: true });
    await rename(oldBrush(), path(...brushDir, 'Maps', 'Alpha.brush.json'));
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(await readFile(path(...brushDir, 'Maps', 'Gamma.brush.json'), 'utf8')).toBe('{"brushes":["alpha"]}');
    expect(existsSync(path(...brushDir, 'Maps', 'Alpha.brush.json'))).toBe(false);
    expect(data.brushMoved).toEqual({ from: 'tilemapBrushes/objectTypes/Maps/Alpha.brush.json', to: 'tilemapBrushes/objectTypes/Maps/Gamma.brush.json' });
    expect(warningsOf(data)).toContain('not in the folder of the object type');
  });

  it('refuses when two folders hold a brush file of the object type', async () => {
    await mkdir(path(...brushDir, 'Maps'), { recursive: true });
    await mkdir(path(...brushDir, 'Old'), { recursive: true });
    await rename(oldBrush(), path(...brushDir, 'Maps', 'Alpha.brush.json'));
    await writeFile(path(...brushDir, 'Old', 'Alpha.brush.json'), '{}');
    const before = await snapshot();
    await refusal('rename_object_type', { name: 'Alpha', newName: 'Gamma' }, 'More than one brush file is named after "Alpha"');
    expect(await snapshot()).toEqual(before);
  });

  it('reports a Tilemap whose brush file was not found', async () => {
    await rm(oldBrush());
    const file = await readJson<ObjectFile>(path('objectTypes', 'Alpha.json'));
    file['plugin-id'] = 'Tilemap';
    await writeJson(path('objectTypes', 'Alpha.json'), file);
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.brushFileFound).toBe(false);
    expect(warningsOf(data)).toContain('is a Tilemap, and no brush file named after it was found');
  });

  it('takes the brush file of the object type\'s own folder and leaves a same-name brush file in another folder, and the files of AlphaBeta and Alpha2, as they are', async () => {
    // 'Aaa' sorts before the object's own file, so a search that took the first match would take the stale one
    await mkdir(path(...brushDir, 'Aaa'), { recursive: true });
    await writeFile(path(...brushDir, 'Aaa', 'Alpha.brush.json'), '{"stale":true}');
    await writeFile(path(...brushDir, 'AlphaBeta.brush.json'), '{"beta":true}');
    await writeFile(path(...brushDir, 'Alpha2.brush.json'), '{"two":true}');
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.brushMoved).toEqual({ from: 'tilemapBrushes/objectTypes/Alpha.brush.json', to: 'tilemapBrushes/objectTypes/Gamma.brush.json' });
    expect(await readFile(newBrush(), 'utf8')).toBe('{"brushes":["alpha"]}');
    expect(await readFile(path(...brushDir, 'Aaa', 'Alpha.brush.json'), 'utf8')).toBe('{"stale":true}');
    expect(existsSync(path(...brushDir, 'Aaa', 'Gamma.brush.json'))).toBe(false);
    expect(await readFile(path(...brushDir, 'AlphaBeta.brush.json'), 'utf8')).toBe('{"beta":true}');
    expect(await readFile(path(...brushDir, 'Alpha2.brush.json'), 'utf8')).toBe('{"two":true}');
    expect(warningsOf(data)).not.toContain('not in the folder of the object type');
  });

  it('does not take the brush file of AlphaBeta or Alpha2 for the object type\'s, even when its own is in another folder', async () => {
    await mkdir(path(...brushDir, 'Maps'), { recursive: true });
    await rename(oldBrush(), path(...brushDir, 'Maps', 'Alpha.brush.json'));
    await writeFile(path(...brushDir, 'AlphaBeta.brush.json'), '{"beta":true}');
    await writeFile(path(...brushDir, 'Alpha2.brush.json'), '{"two":true}');
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.brushMoved).toEqual({ from: 'tilemapBrushes/objectTypes/Maps/Alpha.brush.json', to: 'tilemapBrushes/objectTypes/Maps/Gamma.brush.json' });
    expect(await readFile(path(...brushDir, 'AlphaBeta.brush.json'), 'utf8')).toBe('{"beta":true}');
    expect(await readFile(path(...brushDir, 'Alpha2.brush.json'), 'utf8')).toBe('{"two":true}');
  });

  it('warns that the brush search stopped at its depth limit', async () => {
    const deep = path(...brushDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'Far.brush.json'), '{}');
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(warningsOf(data)).toContain('The search below tilemapBrushes/ stopped at its limit');
  });

  it('names the old brush file when its delete fails and the file then holds other bytes, finishing a stopped run', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    await stopAfterProjectUpdate();
    await writeFile(oldBrush(), '{"brushes":["alpha"]}');
    const saved = '{"brushes":["alpha","saved in the editor"]}';
    vi.spyOn(writer, 'deleteFile').mockImplementation(async file => {
      if (file.endsWith('Alpha.brush.json')) {
        await editorSave(oldBrush(), saved);
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return undefined;
    });
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('tilemapBrushes/objectTypes/Alpha.brush.json');
    expect(data.text).toContain('neither this call\'s nor those from before it');
    expect(data.text).not.toContain('Nothing was changed.');
    expect(data.text).not.toContain(tmpDir);
    expect(await readFile(oldBrush(), 'utf8')).toBe(saved);
  });

  it('names the old brush file when its delete fails and the file can no longer be read, finishing a stopped run', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    await stopAfterProjectUpdate();
    await writeFile(oldBrush(), '{"brushes":["alpha"]}');
    vi.spyOn(writer, 'deleteFile').mockImplementation(async file => {
      if (file.endsWith('Alpha.brush.json')) {
        // A folder where the file was: it exists, but cannot be read as a file
        await rm(oldBrush());
        await mkdir(oldBrush());
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return undefined;
    });
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('tilemapBrushes/objectTypes/Alpha.brush.json');
    expect(data.text).toContain('neither this call\'s nor those from before it');
    expect(data.text).not.toContain(tmpDir);
  });

  it('puts back the old brush file when its delete fails after it was removed, finishing a stopped run', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    await stopAfterProjectUpdate();
    await writeFile(oldBrush(), '{"brushes":["alpha"]}');
    const before = await snapshot();
    const deleteFile = writer.deleteFile.bind(writer);
    vi.spyOn(writer, 'deleteFile').mockImplementation(async (file, options) => {
      const result = await deleteFile(file, options);
      if (file.endsWith('Alpha.brush.json')) throw Object.assign(new Error('EIO after the delete'), { code: 'EIO' });
      return result;
    });
    const data = await rename_('Alpha', 'Gamma');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back');
    expect(data.text).not.toContain(tmpDir);
    expect(await readFile(oldBrush(), 'utf8')).toBe('{"brushes":["alpha"]}');
    expect(await snapshot()).toEqual(before);
  });

  it('finishes a run that stopped after the new brush file was written, deleting only the old brush file', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    await stopAfterProjectUpdate();
    await writeFile(oldBrush(), '{"brushes":["alpha"]}');
    await writeFile(path(...brushDir, 'Other.brush.json'), '{}');
    const dry = await rename_('Alpha', 'Gamma', { dryRun: true });
    expect(dry.stoppedRun).toBe(true);
    expect(dry.brushFileToDelete).toBe('tilemapBrushes/objectTypes/Alpha.brush.json');
    expect(existsSync(oldBrush())).toBe(true);
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(existsSync(oldBrush())).toBe(false);
    expect(await readFile(newBrush(), 'utf8')).toBe('{"brushes":["alpha"]}');
    expect(existsSync(path(...brushDir, 'Other.brush.json'))).toBe(true);
    expect(data.filesWritten).toContain('tilemapBrushes/objectTypes/Gamma.brush.json');
  });

  it('finishes a run that stopped after the old brush file was deleted, reporting it as moved already', async () => {
    expect((await rename_('Alpha', 'Gamma')).success).toBe(true);
    await stopAfterProjectUpdate();
    const data = await rename_('Alpha', 'Gamma');
    expect(data.success).toBe(true);
    expect(data.stoppedRun).toBe(true);
    expect(warningsOf(data)).toContain('brush file already moved by the earlier run');
    expect(existsSync(newBrush())).toBe(true);
  });
});

describe('rename_family', () => {
  beforeEach(async () => {
    const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
    main.events.push({
      eventType: 'block',
      conditions: [{ id: 'is-visible', objectClass: 'FAM', sid: 400000000000040 }],
      actions: [
        { id: 'set-x', objectClass: 'Sprite', sid: 400000000000041, parameters: { x: 'Fam.X' } },
        { callCustomAction: 'Hit', objectClass: 'Sprite', customActionObjectClass: 'Fam', sid: 400000000000042, parameters: {} },
      ],
      sid: 400000000000043,
    });
    await writeJson(path('eventSheets', 'MainSheet.json'), main);
    await reader.loadProject();
  });

  it('renames the family and what names it', async () => {
    const data = await call('rename_family', { name: 'Fam', newName: 'Clan' });
    expect(data.success).toBe(true);
    expect(data.previousName).toBe('Fam');
    expect((await readJson<FamilyFile>(path('families', 'Clan.json'))).name).toBe('Clan');
    expect(existsSync(path('families', 'Fam.json'))).toBe(false);
    expect((await readJson<ProjectFile>(path('project.c3proj'))).families.items).toEqual(['Clan']);
    const event = (await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'))).events[2];
    expect(event.conditions[0].objectClass).toBe('Clan');
    expect(event.actions[0].parameters?.x).toBe('Clan.X');
    expect(event.actions[1].customActionObjectClass).toBe('Clan');
    expect(data.filesWritten).toEqual(['eventSheets/MainSheet.json', 'families/Clan.json', 'project.c3proj']);
    expect(data.fileDeleted).toBe('families/Fam.json');
    // The object types, layouts and images are not touched
    expect((await readJson<LayoutFile>(path('layouts', 'Layout 1.json'))).layers[0].instances.map((i: InstanceJson) => i.type)).toEqual(['Sprite', 'Alpha']);
    expect(existsSync(path('images', 'alpha-default-000.png'))).toBe(true);
  });

  it('with dryRun writes nothing', async () => {
    const before = await snapshot();
    const data = await call('rename_family', { name: 'Fam', newName: 'Clan', dryRun: true });
    expect(data.action).toBe('would_rename');
    expect(data.filesToWrite).toEqual(['eventSheets/MainSheet.json', 'families/Clan.json', 'project.c3proj']);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a name an object type has, and a name that is not a family', async () => {
    const before = await snapshot();
    await refusal('rename_family', { name: 'Fam', newName: 'alpha' }, 'Alpha');
    await refusal('rename_family', { name: 'Alpha', newName: 'Clan' }, 'Family "Alpha" not found.');
    await refusal('rename_family', { name: 'Fam', newName: 'Big Clan' }, 'expressions cannot name');
    expect(await snapshot()).toEqual(before);
  });

  it('puts every file back when the project update fails', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'renameInProject').mockRejectedValueOnce(new Error('disk full'));
    const data = await call('rename_family', { name: 'Fam', newName: 'Clan' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(await snapshot()).toEqual(before);
  });
});
