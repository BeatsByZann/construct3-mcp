/**
 * rename_family: the family's file, its "name" and its project-bar entry
 * change, and so does everything in the event sheets that names it (condition
 * and action objects, the owner of a custom action and the family of a call to
 * it, object parameters, the object of an instance variable parameter and
 * "Name.member" expressions). Object types, layouts, images, timelines,
 * containers and the editor's view state are not touched. A dry run writes
 * nothing; an event sheet that could not be parsed refuses without force; a
 * failure midway puts back every file; a run that stopped midway is finished
 * by the same call; the call does not take the animation lock. Checked on a
 * temp copy of the minimal fixture with the real reader, writer and ID
 * generator; every object type, family, sheet, layout, timeline and image
 * added here is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { gate, letOthersRun, track } from '../helpers/barrier.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerObjectRenameTools } from '../../src/tools/object-rename.js';
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
  [key: string]: unknown;
}
interface AceJson {
  id?: string;
  objectClass?: string;
  customActionObjectClass?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}
interface EventJson {
  eventType: string;
  objectClass?: string;
  conditions: AceJson[];
  actions: AceJson[];
  [key: string]: unknown;
}
interface SheetFile { events: EventJson[]; [key: string]: unknown }
interface InstanceJson { type: string; [key: string]: unknown }
interface LayerJson { instances: InstanceJson[]; subLayers?: LayerJson[]; [key: string]: unknown }
interface LayoutFile { layers: LayerJson[]; [key: string]: unknown }
interface FamilyFile { name?: string; sid?: number; members: string[]; [key: string]: unknown }

interface UseJson { in: string; kind: string; [key: string]: unknown }
interface ToolData {
  isError?: boolean;
  text?: string;
  message?: string;
  success?: boolean;
  dryRun?: boolean;
  action?: string;
  stoppedRun?: boolean;
  previousName?: string;
  fileDeleted?: string;
  fileToDelete?: string;
  backupFile?: string;
  filesWritten?: string[];
  filesToWrite?: string[];
  warnings?: string[];
  references?: UseJson[];
  possibleReferences?: UseJson[];
  viewStateMoved?: unknown[];
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
const renameFamily = (name: string, newName: string, extra: Args = {}) => call('rename_family', { name, newName, ...extra });

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

const instance = (type: string, uid: number, sid: number) => ({
  type, uid, sid, tags: '', properties: {}, instanceVariables: {}, behaviors: {}, world: { x: 1, y: 2, width: 64, height: 64 },
});

const FAM_SID = 220000000000001;

/** The text of objecttypes.uistate.json for entries of these names, in Construct 3's own layout. */
function uiState(names: string[]): string {
  return JSON.stringify(names.map(name => [name, {}]), null, '\t');
}

/**
 * The fixture plus: object types "Alpha" (a Sprite with two frame images) and
 * "Floor" (a Tiled Background with an image); family "Fam" with member Alpha;
 * a container of Alpha and Sprite; Alpha instances on "Layout 1"; in
 * "MainSheet" an event that names Alpha, a custom action block owned by
 * "Fam", and an event that names Fam as a condition object, in expressions
 * (Fam(0).X, Fam.Y), as an object parameter, as the object of an instance
 * variable parameter, as the family of a call of the custom action from Alpha
 * and in a string; the timeline "Intro" with a track of Alpha; and an
 * objecttypes.uistate.json that has entries named Alpha, Fam and Sprite.
 */
async function setUpProject(): Promise<void> {
  const project = await readJson<ProjectFile>(path('project.c3proj'));
  project.objectTypes.items.push('Alpha', 'Floor');
  project.families.items.push('Fam');
  project.containers = [{ members: ['Alpha', 'Sprite'] }];
  project.timelines.items.push('Intro');
  await writeJson(path('project.c3proj'), project);

  await writeJson(path('objectTypes', 'Alpha.json'), {
    name: 'Alpha', 'plugin-id': 'Sprite', sid: 210000000000001, isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
    animations: { items: [{ name: 'Default', sid: 310000000000001, speed: 5, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, frames: [
      { width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1 }, { width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1 },
    ] }], subfolders: [] },
  });
  await writeJson(path('objectTypes', 'Floor.json'), {
    name: 'Floor', 'plugin-id': 'TiledBg', sid: 210000000000002, isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
    image: { fileType: 'image/png', width: 64, height: 64 },
  });
  await mkdir(path('families'), { recursive: true });
  await writeJson(path('families', 'Fam.json'), { name: 'Fam', sid: FAM_SID, members: ['Alpha'], instanceVariables: [], behaviorTypes: [], effectTypes: [] });
  await mkdir(path('images'), { recursive: true });
  await writeFile(path('images', 'alpha-default-000.png'), 'alpha frame 0');
  await writeFile(path('images', 'alpha-default-001.png'), 'alpha frame 1');
  await writeFile(path('images', 'floor.png'), 'floor image');

  const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
  layout.layers[0].instances.push(instance('Alpha', 1, 500000000000010));
  await writeJson(path('layouts', 'Layout 1.json'), layout);

  const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
  main.events.push({
    eventType: 'block',
    conditions: [{ id: 'is-visible', objectClass: 'ALPHA', sid: 400000000000010 }],
    actions: [{ id: 'set-x', objectClass: 'Sprite', sid: 400000000000011, parameters: { x: 'Alpha.X' } }],
    sid: 400000000000015,
  }, {
    eventType: 'custom-ace-block',
    aceType: 'action',
    aceName: 'Hit',
    objectClass: 'Fam',
    functionDescription: '',
    functionCategory: '',
    functionReturnType: 'none',
    functionCopyPicked: false,
    functionIsAsync: false,
    functionParameters: [],
    conditions: [],
    actions: [],
    sid: 400000000000050,
  }, {
    eventType: 'block',
    conditions: [{ id: 'is-visible', objectClass: 'FAM', sid: 400000000000040 }],
    actions: [
      { id: 'set-x', objectClass: 'Sprite', sid: 400000000000041, parameters: { x: 'Fam(0).X' } },
      { id: 'set-y', objectClass: 'Sprite', sid: 400000000000044, parameters: { y: 'Fam.Y + 1' } },
      { callCustomAction: 'Hit', objectClass: 'Alpha', customActionObjectClass: 'Fam', sid: 400000000000042, parameters: {} },
      { id: 'pick-by-comparison', objectClass: 'System', sid: 400000000000045, parameters: { object: 'Fam', 'instance-variable': { name: 'hp', objectClass: 'Fam' }, value: '1' } },
      { id: 'set-text', objectClass: 'Sprite', sid: 400000000000046, parameters: { text: '"Fam"' } },
    ],
    sid: 400000000000043,
  });
  await writeJson(path('eventSheets', 'MainSheet.json'), main);

  await mkdir(path('timelines'), { recursive: true });
  await writeJson(path('timelines', 'Intro.json'), {
    name: 'Intro', totalTime: 5, startOnLayout: 'Layout 1', tracks: [{ type: 'instance-track', objectType: 'Alpha', worldInstance: 1 }],
  });
  await writeFile(path('objecttypes.uistate.json'), uiState(['Alpha', 'Fam', 'Sprite']));
  await reader.loadProject();
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-rename-family-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerObjectRenameTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
  await setUpProject();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

/** The sheet's two events that name the family: the custom action block and the event that uses it. */
async function familyEvents(): Promise<{ block: EventJson; event: EventJson }> {
  const { events } = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
  return { block: events[events.length - 2], event: events[events.length - 1] };
}

/** The writer's read-back of `fileName` fails once with an ordinary error. */
function failReadBackOf(fileName: string): void {
  const internals = writer as unknown as { verifyWrittenFile: (file: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  vi.spyOn(internals, 'verifyWrittenFile').mockImplementation(async (file, name, text) => {
    if (file.endsWith(fileName)) throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    return verify(file, name, text);
  });
}

/** Write another container beside the first, listing the family: no editor writes one, so it only makes the container handling observable. */
async function addContainerWithFamily(): Promise<Array<{ members: string[] }>> {
  const project = await readJson<ProjectFile>(path('project.c3proj'));
  project.containers = [{ members: ['Alpha', 'Sprite'] }, { members: ['Fam', 'Alpha'] }];
  await writeJson(path('project.c3proj'), project);
  await reader.loadProject();
  return project.containers;
}

describe('rename_family', () => {
  it('renames the family with every definite reference and leaves every other file as it was', async () => {
    const containers = await addContainerWithFamily();
    const before = await snapshot();
    const internals = writer as unknown as { atomicWrite: (file: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    const projectWrites: unknown[] = [];
    vi.spyOn(internals, 'atomicWrite').mockImplementation(async (file, content) => {
      if (file.endsWith('project.c3proj')) projectWrites.push((JSON.parse(String(content)) as ProjectFile).containers);
      return atomicWrite(file, content);
    });

    const data = await renameFamily('Fam', 'Gang');
    expect(data.success).toBe(true);
    expect(data.action).toBe('renamed');
    expect(data.previousName).toBe('Fam');
    expect(data.filesWritten).toEqual(['eventSheets/MainSheet.json', 'families/Gang.json', 'project.c3proj']);
    expect(data.fileDeleted).toBe('families/Fam.json');

    const renamed = await readJson<FamilyFile>(path('families', 'Gang.json'));
    expect(renamed.name).toBe('Gang');
    expect(renamed.sid).toBe(FAM_SID);
    expect(renamed.members).toEqual(['Alpha']);
    expect(existsSync(path('families', 'Fam.json'))).toBe(false);
    expect(existsSync(path('families', 'Fam.json.bak'))).toBe(true);

    // The family keeps its place in the project, and no container member is renamed
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    expect(project.families.items).toEqual(['Gang']);
    expect(project.containers).toEqual(containers);
    expect(projectWrites).toEqual([containers]);

    const { block, event } = await familyEvents();
    expect(block.objectClass).toBe('Gang');
    expect(event.conditions[0].objectClass).toBe('Gang');
    expect(event.actions[0].parameters?.x).toBe('Gang(0).X');
    expect(event.actions[1].parameters?.y).toBe('Gang.Y + 1');
    expect(event.actions[2].customActionObjectClass).toBe('Gang');
    expect(event.actions[2].objectClass).toBe('Alpha');
    expect(event.actions[3].parameters).toEqual({ object: 'Gang', 'instance-variable': { name: 'hp', objectClass: 'Gang' }, value: '1' });
    // A string is listed, never changed
    expect(event.actions[4].parameters?.text).toBe('"Fam"');
    expect(data.possibleReferences).toContainEqual(expect.objectContaining({ in: 'eventSheets/MainSheet.json', kind: 'string literal', value: '"Fam"' }));
    expect(data.references?.some(r => r.kind === 'container member')).toBe(false);

    // Everything but the three files named is byte for byte as it was: the object types, layouts, images, timelines and the view state
    const after = await snapshot();
    const changed = new Set(['eventSheets/MainSheet.json', 'families/Fam.json', 'families/Gang.json', 'project.c3proj']);
    expect([...after.keys()].sort()).toEqual([...before.keys()].filter(file => file !== 'families/Fam.json').concat('families/Gang.json').sort());
    for (const [file, text] of before) if (!changed.has(file)) expect(after.get(file), file).toBe(text);
    expect(after.get('objecttypes.uistate.json')).toBe(uiState(['Alpha', 'Fam', 'Sprite']));
  });

  it('with dryRun lists the references and the files and writes nothing', async () => {
    await addContainerWithFamily();
    const before = await snapshot();
    const data = await renameFamily('Fam', 'Gang', { dryRun: true });
    expect(data.success).toBe(true);
    expect(data.action).toBe('would_rename');
    expect(data.filesToWrite).toEqual(['eventSheets/MainSheet.json', 'families/Gang.json', 'project.c3proj']);
    expect(data.fileToDelete).toBe('families/Fam.json');
    expect(data.references?.map(r => r.kind).sort()).toEqual([
      'custom action family', 'custom action owner', 'expression', 'expression', 'instance-variable object', 'object parameter', 'objectClass',
    ]);
    expect(await snapshot()).toEqual(before);
    expect(existsSync(path('families', 'Fam.json.bak'))).toBe(false);
  });

  it('refuses a name that is taken or cannot be used, and a family that is not there, and leaves every file as it was', async () => {
    const before = await snapshot();
    const cases: Array<[Args, ...string[]]> = [
      [{ name: 'Fam', newName: 'Alpha' }, 'Alpha'],
      [{ name: 'Fam', newName: 'alpha' }, 'Alpha'],
      [{ name: 'Fam', newName: 'Sprite' }, 'Sprite'],
      [{ name: 'Fam', newName: 'System' }],
      [{ name: 'Fam', newName: 'system' }],
      [{ name: 'Fam', newName: 'Functions' }, 'Functions'],
      [{ name: 'Fam', newName: 'functions' }, 'Functions'],
      [{ name: 'fam', newName: 'Gang' }, 'named "Fam"', 'Use name "Fam"'],
      [{ name: 'Fam', newName: 'Fam' }, 'already has this name'],
      [{ name: 'Fam', newName: 'FAM' }, 'only the letter case'],
      [{ name: 'Fam', newName: 'Big Fam' }, 'expressions cannot name', '"BigFam"'],
      [{ name: 'Fam', newName: ' Gang' }, 'starts or ends with a space', '"Gang"'],
      [{ name: 'Fam', newName: 'Gang ' }, 'starts or ends with a space', '"Gang"'],
      [{ name: 'Fam', newName: 'Ga.ng' }, 'the punctuation is removed', '"Gang"'],
      [{ name: 'Fam', newName: 'Bad/Name' }, 'letters, digits and underscores'],
      [{ name: 'Fam', newName: '' }],
      [{ name: 'Nope', newName: 'Gang' }, 'Family "Nope" not found.', 'list_families'],
      [{ name: 'Alpha', newName: 'Gang' }, 'Family "Alpha" not found.'],
    ];
    for (const [args, ...parts] of cases) {
      await refusal('rename_family', args, ...parts);
      expect(await snapshot(), JSON.stringify(args)).toEqual(before);
    }

    // A file at the new name that no stopped run left: another SID
    await writeJson(path('families', 'Gang.json'), { name: 'Gang', sid: 1, members: [] });
    const withOther = await snapshot();
    await refusal('rename_family', { name: 'Fam', newName: 'Gang' }, 'families/Gang.json');
    expect(await snapshot()).toEqual(withOther);
    await rm(path('families', 'Gang.json'));

    // Another family
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.families.items.push('Crew');
    await writeJson(path('project.c3proj'), project);
    await writeJson(path('families', 'Crew.json'), { name: 'Crew', sid: 220000000000002, members: [], instanceVariables: [], behaviorTypes: [], effectTypes: [] });
    await reader.loadProject();
    const withCrew = await snapshot();
    await refusal('rename_family', { name: 'Fam', newName: 'crew' }, 'Crew');
    expect(await snapshot()).toEqual(withCrew);

    // The family's own file unparsable, or missing
    const original = await readFile(path('families', 'Fam.json'), 'utf8');
    await writeFile(path('families', 'Fam.json'), '{ broken');
    const broken = await snapshot();
    await refusal('rename_family', { name: 'Fam', newName: 'Gang' }, 'could not be parsed');
    expect(await snapshot()).toEqual(broken);
    await rm(path('families', 'Fam.json'));
    const missing = await snapshot();
    await refusal('rename_family', { name: 'Fam', newName: 'Gang' }, 'does not exist');
    expect(await snapshot()).toEqual(missing);
    await writeFile(path('families', 'Fam.json'), original);

    // A scan that throws before any write
    vi.spyOn(reader, 'readAllEventSheets').mockRejectedValueOnce(new Error('scan failed.'));
    await refusal('rename_family', { name: 'Fam', newName: 'Gang' }, 'The rename stopped before anything was written: scan failed.');
  });

  it('answers not found when the same rename is run again after it finished, and writes nothing', async () => {
    expect((await renameFamily('Fam', 'Gang')).success).toBe(true);
    const before = await snapshot();
    await refusal('rename_family', { name: 'Fam', newName: 'Gang' }, 'Family "Fam" not found.');
    expect(await snapshot()).toEqual(before);
  });

  describe('with an event sheet that could not be parsed', () => {
    const brokenSheet = '{"name":"Other","events":[{"objectClass":"Fam"} broken';

    beforeEach(async () => {
      const project = await readJson<ProjectFile>(path('project.c3proj'));
      project.eventSheets.items.push('Other');
      await writeJson(path('project.c3proj'), project);
      await writeFile(path('eventSheets', 'Other.json'), brokenSheet);
      await reader.loadProject();
    });

    it('refuses without force, naming the sheet and writing nothing', async () => {
      const before = await snapshot();
      const blocked = await renameFamily('Fam', 'Gang');
      expect(blocked.action).toBe('rename_blocked');
      expect(blocked.unscannedFiles).toBeDefined();
      expect(blocked.message).toContain('eventSheets/Other');
      expect(blocked.message).toMatch(/Nothing was changed\.$/);
      expect(await snapshot()).toEqual(before);
    });

    it('renames with force and warns, leaving the sheet as it is', async () => {
      const forced = await renameFamily('Fam', 'Gang', { force: true });
      expect(forced.success).toBe(true);
      expect(warningsOf(forced)).toContain('Renamed with force=true');
      expect(await readFile(path('eventSheets', 'Other.json'), 'utf8')).toBe(brokenSheet);
      expect((await familyEvents()).block.objectClass).toBe('Gang');
      expect((await readJson<ProjectFile>(path('project.c3proj'))).families.items).toEqual(['Gang']);
    });
  });

  it('does not refuse for a layout or a family file that could not be parsed, since neither names a family', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.layouts.items.push('Broken');
    project.families.items.push('Crew');
    await writeJson(path('project.c3proj'), project);
    await writeFile(path('layouts', 'Broken.json'), '{ broken');
    await writeFile(path('families', 'Crew.json'), '{ broken');
    await reader.loadProject();
    const data = await renameFamily('Fam', 'Gang');
    expect(data.success).toBe(true);
    expect(await readFile(path('layouts', 'Broken.json'), 'utf8')).toBe('{ broken');
    expect(await readFile(path('families', 'Crew.json'), 'utf8')).toBe('{ broken');
  });

  it('puts every file back when the project update fails', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'renameInProject').mockRejectedValueOnce(new Error('disk full'));
    const data = await renameFamily('Fam', 'Gang');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(data.text).not.toContain(tmpDir);
    expect(await snapshot()).toEqual(before);
  });

  it('puts every file back when the old file cannot be deleted', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('disk full'));
    const data = await renameFamily('Fam', 'Gang');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(await snapshot()).toEqual(before);
  });

  it('puts the event sheet back and names the new family file when its read-back fails, and the same call finishes the rename', async () => {
    const before = await snapshot();
    failReadBackOf('Gang.json');
    const data = await renameFamily('Fam', 'Gang');
    expect(data.isError).toBe(true);
    expect(data.text).toContain('rolled back only in part');
    expect(data.text).toContain('left as it is: families/Gang.json');
    expect(data.text).not.toContain(tmpDir);
    const now = await snapshot();
    expect(now.delete('families/Gang.json')).toBe(true);
    expect(now).toEqual(before);
    expect((await readJson<ProjectFile>(path('project.c3proj'))).families.items).toEqual(['Fam']);

    vi.restoreAllMocks();
    const rerun = await renameFamily('Fam', 'Gang');
    expect(rerun.success).toBe(true);
    expect((await readJson<FamilyFile>(path('families', 'Gang.json'))).sid).toBe(FAM_SID);
    expect((await familyEvents()).block.objectClass).toBe('Gang');
    expect((await readJson<ProjectFile>(path('project.c3proj'))).families.items).toEqual(['Gang']);
  });

  it('keeps an event sheet the editor saved during the call and names it', async () => {
    const before = await snapshot();
    const saved = `${before.get('eventSheets/MainSheet.json')}\n`;
    const projectUpdate = writer.renameInProject.bind(writer);
    vi.spyOn(writer, 'renameInProject').mockImplementationOnce(async (...args) => {
      await editorSave(path('eventSheets', 'MainSheet.json'), saved);
      return projectUpdate(...args);
    });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('disk full'));
    const data = await renameFamily('Fam', 'Gang');
    expect(data.isError).toBe(true);
    expect(await readFile(path('eventSheets', 'MainSheet.json'), 'utf8')).toBe(saved);
    expect(data.text).toContain('eventSheets/MainSheet.json');
    expect(data.text).not.toContain(tmpDir);
    expect(existsSync(path('families', 'Gang.json'))).toBe(false);
    expect(await readFile(path('families', 'Fam.json'), 'utf8')).toBe(before.get('families/Fam.json'));
  });

  describe('a rename that stopped', () => {
    it('is finished after the project update: only the old file is deleted', async () => {
      expect((await renameFamily('Fam', 'Gang')).success).toBe(true);
      // What a run that stopped before its last write leaves: the old file beside the registered new name
      await copyFile(path('families', 'Fam.json.bak'), path('families', 'Fam.json'));
      await reader.loadProject();
      const before = await snapshot();

      const dry = await renameFamily('Fam', 'Gang', { dryRun: true });
      expect(dry.stoppedRun).toBe(true);
      expect(dry.filesToWrite).toEqual([]);
      expect(dry.fileToDelete).toBe('families/Fam.json');
      expect(await snapshot()).toEqual(before);

      const data = await renameFamily('Fam', 'Gang');
      expect(data.success).toBe(true);
      expect(data.stoppedRun).toBe(true);
      expect(data.filesWritten).toEqual([]);
      expect(data.fileDeleted).toBe('families/Fam.json');
      expect(warningsOf(data)).toContain('an earlier rename stopped after its project update');
      expect(existsSync(path('families', 'Fam.json'))).toBe(false);
      const after = await snapshot();
      before.delete('families/Fam.json');
      expect(after).toEqual(before);
      expect((await readJson<ProjectFile>(path('project.c3proj'))).families.items).toEqual(['Gang']);
    });

    it('is finished after the new file was written: the file is written over and the project updated', async () => {
      const original = await readJson<FamilyFile>(path('families', 'Fam.json'));
      await writeJson(path('families', 'Gang.json'), { ...original, name: 'Gang' });
      const data = await renameFamily('Fam', 'Gang');
      expect(data.success).toBe(true);
      expect(data.filesWritten).toEqual(['eventSheets/MainSheet.json', 'families/Gang.json', 'project.c3proj']);
      expect((await readJson<FamilyFile>(path('families', 'Gang.json'))).sid).toBe(FAM_SID);
      expect(existsSync(path('families', 'Fam.json'))).toBe(false);
      expect((await readJson<ProjectFile>(path('project.c3proj'))).families.items).toEqual(['Gang']);
    });

    it('is not taken for one when the old file holds another SID', async () => {
      expect((await renameFamily('Fam', 'Gang')).success).toBe(true);
      await writeJson(path('families', 'Fam.json'), { name: 'Fam', sid: 5, members: [] });
      const before = await snapshot();
      await refusal('rename_family', { name: 'Fam', newName: 'Gang' }, 'Family "Fam" not found.');
      expect(await snapshot()).toEqual(before);
    });
  });

  it('does not take the animation lock', async () => {
    const held = gate();
    const barrier = gate();
    const holding = writer.withAnimationLock(async () => {
      held.open();
      await barrier.opened;
    });
    await held.opened;
    try {
      const renaming = track(server.callTool('rename_family', { name: 'Fam', newName: 'Gang' }));
      // The rename does file I/O: wait in real time, up to three seconds, for it to settle
      for (let i = 0; i < 100&& !renaming.settled(); i++) {
        await letOthersRun();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(renaming.settled(), 'the rename finished while the animation lock was held').toBe(true);
      const result = await renaming.promise;
      expect(result.isError, result.content[0].text).toBeFalsy();
    } finally {
      barrier.open();
      await holding;
    }
    expect(existsSync(path('families', 'Gang.json'))).toBe(true);
  });

  it('refuses an argument it does not take', async () => {
    await expect(server.callTool('rename_family', { name: 'Fam', newName: 'Gang', bogus: 1 })).rejects.toThrow();
  });
});
