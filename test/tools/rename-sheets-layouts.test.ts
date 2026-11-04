/**
 * rename_event_sheet and rename_layout: the entity's file, its "name" and its
 * project-bar entry change, and so does every reference to it (include
 * events and layout bindings for an event sheet; "layout" parameters,
 * firstLayout and the timelines that start on it for a layout). Strings that
 * may name a layout are only listed. A dry run writes nothing; files that
 * could not be parsed refuse without force; a failure midway puts back every
 * file; a run that stopped midway is finished by the same call. Checked on a
 * temp copy of the minimal fixture with the real reader and writer; the
 * sheets, layouts and timelines added are synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader, ProjectReadError } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerEntityRenameTools, viewStateWithName } from '../../src/tools/entity-rename.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Json = Record<string, unknown>;

interface ActionJson { parameters?: Record<string, string>; script?: string[]; [key: string]: unknown }
interface EventJson {
  includeSheet?: string;
  initialValue?: string;
  children?: EventJson[];
  actions?: ActionJson[];
  conditions?: ActionJson[];
  functionParameters?: Array<{ initialValue?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
interface SheetFile { name?: string; sid?: number; events: EventJson[]; [key: string]: unknown }
interface LayoutFile {
  name?: string;
  sid?: number;
  eventSheet?: string;
  layers: Array<{ sid?: number; instances: Array<{ instanceVariables?: Json }> }>;
  [key: string]: unknown;
}
interface FolderJson { items: string[]; subfolders: Array<{ items: string[]; subfolders: unknown[]; name?: string }> }
interface ProjectFile {
  eventSheets: FolderJson;
  layouts: FolderJson;
  timelines: FolderJson;
  firstLayout?: string;
  properties?: Json;
  rootFileFolders?: Json;
  [key: string]: unknown;
}
interface TimelineFile { startOnLayout?: string; [key: string]: unknown }
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
  filesWritten?: string[];
  filesToWrite?: string[];
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
const readJson = async <T = Json>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const writeJson = (file: string, data: unknown) => writeFile(file, JSON.stringify(data, null, '\t'));
const call = async (tool: string, args: Json): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const warningsOf = (data: ToolData) => (data.warnings ?? []).join(' ');

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
async function refusal(tool: string, args: Json, ...parts: string[]): Promise<ToolData> {
  const data = await call(tool, args);
  expect(data.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
  for (const part of parts) expect(data.text, `${tool} ${JSON.stringify(args)}`).toContain(part);
  expect(data.text, `${tool} ${JSON.stringify(args)}`).toMatch(/Nothing was changed\.$/);
  return data;
}

const goToLayout = (sid: number, layout: string) => ({ id: 'go-to-layout', objectClass: 'System', sid, parameters: { layout } });

/**
 * The fixture plus: event sheet "Common" in project-bar folder "Shared"
 * (eventSheets/Shared/Common.json), included by "MainSheet" and, spelled in
 * lower case, by "Other"; layout "Level 2" bound to "Common"; and in
 * "MainSheet" actions that go to "Layout 1" (one in a sub-event, one spelled
 * in lower case) and strings and a script that mention it.
 */
async function setUpProject(): Promise<void> {
  const project = await readJson<ProjectFile>(path('project.c3proj'));
  project.eventSheets.items.push('Other');
  project.eventSheets.subfolders.push({ items: ['Common'], subfolders: [], name: 'Shared' });
  project.layouts.items.push('Level 2');
  await writeJson(path('project.c3proj'), project);

  await mkdir(path('eventSheets', 'Shared'), { recursive: true });
  await writeJson(path('eventSheets', 'Shared', 'Common.json'), { name: 'Common', events: [], sid: 410000000000001 });
  await writeJson(path('eventSheets', 'Other.json'), {
    name: 'Other',
    events: [{ eventType: 'include', includeSheet: 'common' }],
    sid: 410000000000002,
  });

  const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
  main.events.unshift({ eventType: 'include', includeSheet: 'Common' });
  const block = main.events[1];
  (block.actions as ActionJson[]).push(
    goToLayout(410000000000010, 'Layout 1'),
    { id: 'go-to-layout-by-name', objectClass: 'System', sid: 410000000000011, parameters: { layout: '"Layout 1"' } },
    { id: 'set-x', objectClass: 'Sprite', sid: 410000000000012, parameters: { x: 'LayoutName = "Layout 1" ? 1 : 0' } },
    { type: 'script', language: 'javascript', script: ['runtime.goToLayout("Layout 1");'] },
  );
  block.children = [{
    eventType: 'block',
    conditions: [],
    actions: [goToLayout(410000000000013, 'layout 1')],
    sid: 410000000000014,
  }];
  await writeJson(path('eventSheets', 'MainSheet.json'), main);

  const level2 = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
  level2.name = 'Level 2';
  level2.sid = 510000000000001;
  level2.layers[0].sid = 510000000000002;
  level2.layers[0].instances = [];
  level2.eventSheet = 'Common';
  await writeJson(path('layouts', 'Level 2.json'), level2);
  await reader.loadProject();
}

/**
 * Timelines "Intro" (starts on "Layout 1"), "Outro" in folder "Cutscenes"
 * (starts on "layout 1", in lower case) and "Other" (starts on "Level 2").
 */
async function addTimelines(): Promise<void> {
  const project = await readJson<ProjectFile>(path('project.c3proj'));
  project.timelines.items.push('Intro', 'Other');
  project.timelines.subfolders.push({ items: ['Outro'], subfolders: [], name: 'Cutscenes' });
  await writeJson(path('project.c3proj'), project);
  await mkdir(path('timelines', 'Cutscenes'), { recursive: true });
  const timeline = (name: string, startOnLayout: string) => ({ name, totalTime: 5, startOnLayout, tracks: [] });
  await writeJson(path('timelines', 'Intro.json'), timeline('Intro', 'Layout 1'));
  await writeJson(path('timelines', 'Cutscenes', 'Outro.json'), timeline('Outro', 'layout 1'));
  await writeJson(path('timelines', 'Other.json'), timeline('Other', 'Level 2'));
  await reader.loadProject();
}

/** The project as a rename that stopped after its project update leaves it: "Common" registered as "Shared Logic", both files on disk. */
async function stopAfterProjectUpdate(): Promise<void> {
  const project = await readJson<ProjectFile>(path('project.c3proj'));
  project.eventSheets.subfolders[0].items = ['Shared Logic'];
  await writeJson(path('project.c3proj'), project);
  await writeJson(path('eventSheets', 'Shared', 'Shared Logic.json'), { name: 'Shared Logic', events: [], sid: 410000000000001 });
  await reader.loadProject();
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-rename-entity-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerEntityRenameTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
  await setUpProject();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

/** The writer's read-back of `fileName` fails once with an ordinary error. */
function failReadBackOf(fileName: string): void {
  const internals = writer as unknown as { verifyWrittenFile: (file: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  vi.spyOn(internals, 'verifyWrittenFile').mockImplementation(async (file, name, text) => {
    if (file.endsWith(fileName)) {
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(file, name, text);
  });
}

describe('rename_event_sheet', () => {
  it('renames the file, its name and its project-bar entry in place, and points includes and bindings at the new name', async () => {
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(data.action).toBe('renamed');
    expect(data.previousName).toBe('Common');

    expect(existsSync(path('eventSheets', 'Shared', 'Common.json'))).toBe(false);
    expect(existsSync(path('eventSheets', 'Shared', 'Common.json.bak'))).toBe(true);
    const renamed = await readJson<SheetFile>(path('eventSheets', 'Shared', 'Shared Logic.json'));
    expect(renamed.name).toBe('Shared Logic');
    expect(renamed.sid).toBe(410000000000001);

    const project = await readJson<ProjectFile>(path('project.c3proj'));
    expect(project.eventSheets.items).toEqual(['MainSheet', 'Other']);
    expect(project.eventSheets.subfolders).toEqual([{ items: ['Shared Logic'], subfolders: [], name: 'Shared' }]);

    expect((await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'))).events[0].includeSheet).toBe('Shared Logic');
    expect((await readJson<SheetFile>(path('eventSheets', 'Other.json'))).events[0].includeSheet).toBe('Shared Logic');
    expect((await readJson<LayoutFile>(path('layouts', 'Level 2.json'))).eventSheet).toBe('Shared Logic');
    expect((await readJson<LayoutFile>(path('layouts', 'Layout 1.json'))).eventSheet).toBe('MainSheet');

    expect(data.references).toHaveLength(3);
    expect(data.filesWritten).toEqual([
      'eventSheets/MainSheet.json', 'eventSheets/Other.json', 'layouts/Level 2.json',
      'eventSheets/Shared/Shared Logic.json', 'project.c3proj',
    ]);
    expect(data.fileDeleted).toBe('eventSheets/Shared/Common.json');
    const warnings = warningsOf(data);
    expect(warnings).toContain('Pointed 2 include(s) that named "Common" at "Shared Logic"');
    expect(warnings).toContain('Pointed 1 layout event sheet binding(s) that named "Common" at "Shared Logic": layout "Level 2"');

    // The reader sees the project as renamed
    expect(await reader.listEventSheets()).toContain('Shared Logic');
    expect(await reader.listEventSheets()).not.toContain('Common');
  });

  it('with dryRun reports the references and files and writes nothing', async () => {
    const before = await snapshot();
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic', dryRun: true });
    expect(data.success).toBe(true);
    expect(data.dryRun).toBe(true);
    expect(data.action).toBe('would_rename');
    expect((data.references ?? []).map(r => r.in)).toEqual(['eventSheets/MainSheet.json', 'eventSheets/Other.json', 'layouts/Level 2.json']);
    expect(data.filesToWrite).toContain('eventSheets/Shared/Shared Logic.json');
    expect(data.fileToDelete).toBe('eventSheets/Shared/Common.json');
    expect(warningsOf(data)).toContain('Would point 2 include(s)');
    expect(await snapshot()).toEqual(before);
    expect(existsSync(path('eventSheets', 'Shared', 'Common.json.bak'))).toBe(false);
  });

  it('refuses a name that is taken, also ignoring case, and a change of letter case only', async () => {
    const before = await snapshot();
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Other' }, 'Event sheet "Other" already exists');
    await refusal('rename_event_sheet', { name: 'Common', newName: 'mainsheet' }, 'differs only in case from the existing event sheet "MainSheet"');
    await refusal('rename_event_sheet', { name: 'Common', newName: 'COMMON' }, 'changes only the letter case');
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Common' }, 'already has this name');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an unknown name, a name spelled in another case and an invalid new name', async () => {
    await refusal('rename_event_sheet', { name: 'Nope', newName: 'X' }, 'not found');
    await refusal('rename_event_sheet', { name: 'common', newName: 'X' }, 'is named "Common" in the project');
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Bad/Name' }, 'Name must start with a letter or underscore');
  });

  it('refuses when a file for the new name is already on disk, and leaves it as it is', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Leftover.json'), '{"name":"Leftover"}');
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Leftover' }, 'already exists');
    expect(await readFile(path('eventSheets', 'Shared', 'Leftover.json'), 'utf8')).toBe('{"name":"Leftover"}');
    expect(existsSync(path('eventSheets', 'Shared', 'Common.json'))).toBe(true);
  });

  it('refuses without force when a layout that could not be parsed names the sheet; with force it renames and warns', async () => {
    await writeFile(path('layouts', 'Level 2.json'), '{"name":"Level 2","eventSheet":"Common", broken');
    await reader.loadProject();
    const blocked = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(blocked.success).toBe(false);
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.unscannedFiles).toEqual([expect.objectContaining({ file: 'layouts/Level 2', textSearch: 'possible-use' })]);
    expect(existsSync(path('eventSheets', 'Shared', 'Common.json'))).toBe(true);

    const forced = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic', force: true });
    expect(forced.success).toBe(true);
    expect(warningsOf(forced)).toContain('Renamed with force=true');
    expect(await readFile(path('layouts', 'Level 2.json'), 'utf8')).toContain('"eventSheet":"Common"');
  });

  it('goes ahead with a warning when a file that could not be parsed does not name the sheet', async () => {
    await writeFile(path('layouts', 'Level 2.json'), '{"name":"Level 2", broken');
    await reader.loadProject();
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(warningsOf(data)).toContain('layouts/Level 2 (not valid JSON) could not be parsed and was only searched as text');
  });

  it('refuses to rename a sheet whose own file could not be parsed', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Common.json'), '{ broken');
    await reader.loadProject();
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' }, 'could not be parsed (not valid JSON)');
  });

  it('puts every file back when a write fails midway', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('disk full'));
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('disk full');
    expect(data.text).toContain('The call was rolled back:');
    // The new file is removed again; the project file and the referencing files hold what they held
    expect(await snapshot()).toEqual(before);
  });

  it('puts the referencing files back when the project update fails', async () => {
    const before = await snapshot();
    vi.spyOn(writer, 'renameInProject').mockRejectedValueOnce(new Error('cannot write project.c3proj'));
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(await snapshot()).toEqual(before);
  });
});

describe('rename_event_sheet: what else it finds and how it fails', () => {
  it('finds an include inside a group and a binding spelled in another case', async () => {
    const other = await readJson<SheetFile>(path('eventSheets', 'Other.json'));
    other.events.push({ eventType: 'group', title: 'G', disabled: false, children: [{ eventType: 'include', includeSheet: 'COMMON' }], sid: 410000000000020 });
    await writeJson(path('eventSheets', 'Other.json'), other);
    const level2 = await readJson<LayoutFile>(path('layouts', 'Level 2.json'));
    level2.eventSheet = 'common';
    await writeJson(path('layouts', 'Level 2.json'), level2);
    await reader.loadProject();

    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    const after = await readJson<SheetFile>(path('eventSheets', 'Other.json'));
    expect(after.events[0].includeSheet).toBe('Shared Logic');
    expect((after.events[1].children as EventJson[])[0].includeSheet).toBe('Shared Logic');
    expect((await readJson<LayoutFile>(path('layouts', 'Level 2.json'))).eventSheet).toBe('Shared Logic');
  });

  it('moves the editor view state file of the sheet with it, writing the new name into it', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Common.uistate.json'), '{\n\t"name": "Common",\n\t"scroll": 3\n}');
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.viewStateMoved).toEqual([{ from: 'eventSheets/Shared/Common.uistate.json', to: 'eventSheets/Shared/Shared Logic.uistate.json' }]);
    expect(await readFile(path('eventSheets', 'Shared', 'Shared Logic.uistate.json'), 'utf8')).toBe('{\n\t"name": "Shared Logic",\n\t"scroll": 3\n}');
    expect(existsSync(path('eventSheets', 'Shared', 'Common.uistate.json'))).toBe(false);
  });

  it('moves a view state file that holds no name as it is', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Common.uistate.json'), '{"scroll":3}');
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.viewStateMoved).toEqual([{ from: 'eventSheets/Shared/Common.uistate.json', to: 'eventSheets/Shared/Shared Logic.uistate.json' }]);
    expect(await readFile(path('eventSheets', 'Shared', 'Shared Logic.uistate.json'), 'utf8')).toBe('{"scroll":3}');
  });

  it('puts back what the call wrote when the new file\'s read-back fails, and the same call then renames', async () => {
    // A backup left by an earlier rename or delete of a sheet with the new name
    await writeFile(path('eventSheets', 'Shared', 'Shared Logic.json.bak'), '{"name":"Shared Logic","events":[],"sid":1}');
    const before = await snapshot();
    failReadBackOf('Shared Logic.json');
    const failed = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('The call was rolled back only in part: put back as they were before the call: layouts/Level 2.json, eventSheets/Other.json, eventSheets/MainSheet.json; '
      + 'left as it is: eventSheets/Shared/Shared Logic.json (it did not exist before the call; it now holds what this call\'s failed write left there). '
      + 'Check the project (validate_project, git diff) before you run the tool again.');
    // Every file but the new one holds its bytes from before the call
    const now = await snapshot();
    const leftover = now.get('eventSheets/Shared/Shared Logic.json');
    expect(leftover).toBeDefined();
    expect(JSON.parse(leftover as string)).toMatchObject({ name: 'Shared Logic', sid: 410000000000001 });
    now.delete('eventSheets/Shared/Shared Logic.json');
    expect(now).toEqual(before);
    expect(await readFile(path('eventSheets', 'Shared', 'Shared Logic.json.bak'), 'utf8')).toBe('{"name":"Shared Logic","events":[],"sid":1}');

    // The leftover is the stopped run's own: the same call writes over it and finishes
    vi.restoreAllMocks();
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(existsSync(path('eventSheets', 'Shared', 'Common.json'))).toBe(false);
    expect((await readJson<SheetFile>(path('eventSheets', 'Shared', 'Shared Logic.json'))).name).toBe('Shared Logic');
    expect((await readJson<ProjectFile>(path('project.c3proj'))).eventSheets.subfolders[0].items).toEqual(['Shared Logic']);
    expect((await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'))).events[0].includeSheet).toBe('Shared Logic');
  });

  it('names project.c3proj when its replacement fails after its backup, before the writer recorded it', async () => {
    const before = await snapshot();
    const internals = writer as unknown as { atomicWrite: (file: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    // The replacement lands, then reports an I/O error: the file holds the update and the writer recorded nothing
    vi.spyOn(internals, 'atomicWrite').mockImplementation(async (file, content) => {
      await atomicWrite(file, content);
      if (file.endsWith('project.c3proj')) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    });
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('left as it is: project.c3proj (its update failed before the server recorded it, so whether it holds this call\'s change is not known; its state from before the call is in project.c3proj.bak)');
    expect(data.text).not.toContain('Nothing was changed.');
    expect(data.text).not.toContain(tmpDir);
    // The project file holds the update; every other file is as before the call
    expect((await readJson<ProjectFile>(path('project.c3proj'))).eventSheets.subfolders[0].items).toEqual(['Shared Logic']);
    const now = await snapshot();
    now.delete('project.c3proj');
    before.delete('project.c3proj');
    expect(now).toEqual(before);
  });

  it('names a file by its path in the project when an fs error stops the rename', async () => {
    const before = await snapshot();
    const file = path('eventSheets', 'Shared', 'Common.json');
    const fsError = Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC', path: file });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(fsError);
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('ENOSPC on eventSheets/Shared/Common.json');
    expect(data.text).toContain('The call was rolled back:');
    expect(data.text).not.toContain(tmpDir);
    expect(await snapshot()).toEqual(before);
  });

  it('names a file by its path in the project when an fs error stops the search before any write', async () => {
    const before = await snapshot();
    const file = path('eventSheets', 'Other.json');
    const fsError = Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES', path: file });
    vi.spyOn(reader, 'readAllEventSheets').mockRejectedValueOnce(fsError);
    const data = await refusal('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' }, 'The rename stopped before anything was written: EACCES on eventSheets/Other.json.');
    expect(data.text).not.toContain(tmpDir);
    expect(await snapshot()).toEqual(before);
  });

  it('names a file by its path in the project when a read during the writes fails', async () => {
    const before = await snapshot();
    const file = path('eventSheets', 'Other.json');
    const cause = Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY', path: file });
    const readSheet = reader.readEventSheet.bind(reader);
    vi.spyOn(reader, 'readEventSheet').mockImplementation(async name => {
      if (name === 'Other') throw new ProjectReadError('E_READ_ERROR', `Failed to read event sheet "Other": ${cause.message}`, { cause });
      return readSheet(name);
    });
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('EBUSY on eventSheets/Other.json');
    expect(data.text).toContain('The call was rolled back:');
    expect(data.text).not.toContain(tmpDir);
    expect(await snapshot()).toEqual(before);
  });

  it('warns when the sheet\'s view state holds a name the rename could not change', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Common.uistate.json'), '{"name":"common","scroll":3}');
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(warningsOf(data)).toContain('The editor\'s view state eventSheets/Shared/Shared Logic.uistate.json was moved with the "name" it holds unchanged');
    expect(await readFile(path('eventSheets', 'Shared', 'Shared Logic.uistate.json'), 'utf8')).toBe('{"name":"common","scroll":3}');
  });

  it('does not warn about a view state whose name was changed', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Common.uistate.json'), '{"name":"Common","scroll":3}');
    expect(warningsOf(await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' }))).not.toContain('view state');
  });

  it('does not warn about a view state that holds no name', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Common.uistate.json'), '{"scroll":3}');
    expect(warningsOf(await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' }))).not.toContain('view state');
  });

  it('restores a referencing file from its backup when its own write fails after replacing it', async () => {
    const before = await snapshot();
    failReadBackOf('Other.json');
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(await snapshot()).toEqual(before);
  });

  it('keeps an event sheet the editor saved during the call and puts back what the call wrote before', async () => {
    const before = await snapshot();
    const original = writer.writeEntityFile.bind(writer);
    const saved = '{"name":"Other","events":[{"eventType":"include","includeSheet":"Common"},{"eventType":"comment","text":"saved in the editor"}],"sid":410000000000002}';
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, data, subfolder, options) => {
      // The editor saves "Other" while the rename is under way
      if (name === 'Other') await editorSave(path('eventSheets', 'Other.json'), saved);
      return original(category, name, data, subfolder, options);
    });
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('was changed on disk');
    expect(await readFile(path('eventSheets', 'Other.json'), 'utf8')).toBe(saved);
    const now = await snapshot();
    now.delete('eventSheets/Other.json');
    before.delete('eventSheets/Other.json');
    expect(now).toEqual(before);
  });
});

describe('rename_layout', () => {
  it('renames the layout, keeps it the startup layout and points the "layout" parameters at the new name', async () => {
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect(existsSync(path('layouts', 'Layout 1.json'))).toBe(false);
    const renamed = await readJson<LayoutFile>(path('layouts', 'Title Screen.json'));
    expect(renamed.name).toBe('Title Screen');
    expect(renamed.eventSheet).toBe('MainSheet');

    const project = await readJson<ProjectFile>(path('project.c3proj'));
    expect(project.layouts.items).toEqual(['Title Screen', 'Level 2']);
    expect(project.firstLayout).toBe('Title Screen');

    const block = (await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'))).events[1];
    const actions = block.actions as ActionJson[];
    expect(actions[1].parameters?.layout).toBe('Title Screen');
    expect(((block.children as EventJson[])[0].actions as ActionJson[])[0].parameters?.layout).toBe('Title Screen');
    // Strings and scripts are only listed
    expect(actions[2].parameters?.layout).toBe('"Layout 1"');
    expect(actions[3].parameters?.x).toBe('LayoutName = "Layout 1" ? 1 : 0');
    expect(actions[4].script).toEqual(['runtime.goToLayout("Layout 1");']);

    const warnings = warningsOf(data);
    expect(warnings).toContain('Pointed 2 "layout" parameter(s) that named "Layout 1" at "Title Screen"');
    expect(warnings).toContain('"Layout 1" is the startup layout (firstLayout); it stays the startup layout');
    expect(warnings).toContain('3 other expression(s), variable value(s) or script line(s) contain the string "Layout 1"');
    expect(data.references).toContainEqual({ in: 'project.c3proj', kind: 'firstLayout', value: 'Layout 1' });
  });

  it('renames a layout that is not the startup layout and leaves firstLayout as it is', async () => {
    const data = await call('rename_layout', { name: 'Level 2', newName: 'Boss' });
    expect(data.success).toBe(true);
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    expect(project.layouts.items).toEqual(['Layout 1', 'Boss']);
    expect(project.firstLayout).toBe('Layout 1');
    expect((await readJson<LayoutFile>(path('layouts', 'Boss.json'))).eventSheet).toBe('Common');
    expect(data.warnings).toBeUndefined();
  });

  it('with dryRun writes nothing', async () => {
    const before = await snapshot();
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen', dryRun: true });
    expect(data.action).toBe('would_rename');
    expect((data.references ?? []).filter(r => r.kind === 'layout parameter')).toHaveLength(2);
    expect(data.filesToWrite).toEqual(['eventSheets/MainSheet.json', 'layouts/Title Screen.json', 'project.c3proj']);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses without force when an event sheet that could not be parsed names the layout', async () => {
    await writeFile(path('eventSheets', 'Other.json'), '{"name":"Other","events":[{"layout":"Level 2"} broken');
    await reader.loadProject();
    const before = await snapshot();
    const blocked = await call('rename_layout', { name: 'Level 2', newName: 'Boss' });
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.message).toMatch(/Nothing was changed\.$/);
    expect(await snapshot()).toEqual(before);
    const forced = await call('rename_layout', { name: 'Level 2', newName: 'Boss', force: true });
    expect(forced.success).toBe(true);
  });

  it('points the timelines that start on the layout at the new name, in any timelines folder', async () => {
    await addTimelines();
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect((await readJson<TimelineFile>(path('timelines', 'Intro.json'))).startOnLayout).toBe('Title Screen');
    expect((await readJson<TimelineFile>(path('timelines', 'Cutscenes', 'Outro.json'))).startOnLayout).toBe('Title Screen');
    expect((await readJson<TimelineFile>(path('timelines', 'Other.json'))).startOnLayout).toBe('Level 2');
    expect(existsSync(path('timelines', 'Intro.json.bak'))).toBe(true);
    expect((data.references ?? []).filter(r => r.kind === 'startOnLayout').map(r => r.in))
      .toEqual(['timelines/Intro.json', 'timelines/Cutscenes/Outro.json']);
    expect(warningsOf(data)).toContain('Pointed the "startOnLayout" of 2 timeline(s) that started on "Layout 1" at "Title Screen"');
  });

  it('refuses without force when a timeline file cannot be parsed', async () => {
    await addTimelines();
    await writeFile(path('timelines', 'Other.json'), '{ broken');
    const before = await snapshot();
    const blocked = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.message).toContain('timelines/Other.json');
    expect(await snapshot()).toEqual(before);
    const forced = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen', force: true });
    expect(forced.success).toBe(true);
    expect(warningsOf(forced)).toContain('Renamed with force=true: Timeline file(s) that could not be read or parsed');
    expect(await readFile(path('timelines', 'Other.json'), 'utf8')).toBe('{ broken');
  });

  it('finds a "layout" parameter on a condition and a firstLayout spelled in another case', async () => {
    const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
    (main.events[1].conditions as ActionJson[]).push({ id: 'compare-two-values', objectClass: 'System', sid: 410000000000030, parameters: { layout: 'Layout 1' } });
    await writeJson(path('eventSheets', 'MainSheet.json'), main);
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.firstLayout = 'LAYOUT 1';
    await writeJson(path('project.c3proj'), project);
    await reader.loadProject();

    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect(((await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'))).events[1].conditions as ActionJson[])[1].parameters?.layout).toBe('Title Screen');
    expect((await readJson<ProjectFile>(path('project.c3proj'))).firstLayout).toBe('Title Screen');
  });

  it('renames a layout in a project-bar folder in place, with its Instances Bar state', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.layouts.items = ['Layout 1'];
    project.layouts.subfolders = [{ items: ['Level 2'], subfolders: [], name: 'Levels' }];
    await writeJson(path('project.c3proj'), project);
    await mkdir(path('layouts', 'Levels'), { recursive: true });
    await writeFile(path('layouts', 'Levels', 'Level 2.json'), await readFile(path('layouts', 'Level 2.json')));
    await rm(path('layouts', 'Level 2.json'));
    await mkdir(path('layouts', 'uistate', 'Levels'), { recursive: true });
    await writeFile(path('layouts', 'uistate', 'Levels', 'Level 2.instancesBar.json'), '{"instanceFolderJson":{}}');
    await reader.loadProject();

    const data = await call('rename_layout', { name: 'Level 2', newName: 'Boss' });
    expect(data.success).toBe(true);
    expect(data.fileDeleted).toBe('layouts/Levels/Level 2.json');
    expect((await readJson<LayoutFile>(path('layouts', 'Levels', 'Boss.json'))).name).toBe('Boss');
    expect((await readJson<ProjectFile>(path('project.c3proj'))).layouts.subfolders).toEqual([{ items: ['Boss'], subfolders: [], name: 'Levels' }]);
    expect(await readFile(path('layouts', 'uistate', 'Levels', 'Boss.instancesBar.json'), 'utf8')).toBe('{"instanceFolderJson":{}}');
    expect(existsSync(path('layouts', 'uistate', 'Levels', 'Level 2.instancesBar.json'))).toBe(false);
    expect(data.viewStateMoved).toEqual([{ from: 'layouts/uistate/Levels/Level 2.instancesBar.json', to: 'layouts/uistate/Levels/Boss.instancesBar.json' }]);
  });

  it('lists text variable values that are its name without changing them, and never rewrites a by-name expression', async () => {
    const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
    main.events.push(
      { eventType: 'variable', name: 'NextLevel', type: 'string', initialValue: 'Layout 1', comment: '', isStatic: false, isConstant: false, sid: 410000000000040 },
      { eventType: 'function-block', functionName: 'Go', functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
        functionParameters: [{ name: 'where', type: 'string', initialValue: 'layout 1', comment: '', sid: 410000000000041 }], conditions: [], actions: [], sid: 410000000000042 },
    );
    // A by-name action whose expression is a variable spelled like the layout
    (main.events[1].actions as ActionJson[]).push({ id: 'go-to-layout-by-name', objectClass: 'System', sid: 410000000000043, parameters: { layout: 'Layout 1' } });
    await writeJson(path('eventSheets', 'MainSheet.json'), main);
    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    layout.layers[0].instances[0].instanceVariables = { target: 'Layout 1', count: 3 };
    await writeJson(path('layouts', 'Layout 1.json'), layout);
    await reader.loadProject();

    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    const after = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
    expect(after.events.at(-2)?.initialValue).toBe('Layout 1');
    expect(after.events.at(-1)?.functionParameters?.[0].initialValue).toBe('layout 1');
    expect((after.events[1].actions as ActionJson[]).at(-1)?.parameters?.layout).toBe('Layout 1');
    expect((await readJson<LayoutFile>(path('layouts', 'Title Screen.json'))).layers[0].instances[0].instanceVariables?.target).toBe('Layout 1');
    const warning = warningsOf(data);
    expect(warning).toContain('6 other expression(s), variable value(s) or script line(s) contain the string "Layout 1"');
    expect(warning).toContain('"MainSheet" events[2] "NextLevel"');
    expect(data.possibleReferences).toContainEqual({ in: 'layouts/Title Screen.json', kind: 'instance variable', uid: 0, parameter: 'target', value: 'Layout 1' });
    expect(data.possibleReferences).toContainEqual({ in: 'eventSheets/MainSheet.json', kind: 'variable value', path: 'events[3]', parameter: 'where', value: 'layout 1' });
    expect((data.possibleReferences ?? []).map(r => r.kind)).not.toContain('layout parameter');
  });

  it('writes only the files that still name the sheet when it reads them again for the write', async () => {
    // Between the scan and the write, the sheets that included it no longer do, and the layout is bound to another sheet
    const readSheet = reader.readEventSheet.bind(reader);
    const readLayout = reader.readLayout.bind(reader);
    vi.spyOn(reader, 'readEventSheet').mockImplementation(async name => {
      const sheet = await readSheet(name);
      return name === 'Other' ? { ...sheet, events: [] } : sheet;
    });
    vi.spyOn(reader, 'readLayout').mockImplementation(async name => {
      const layout = await readLayout(name);
      return name === 'Level 2' ? { ...layout, eventSheet: 'MainSheet' } : layout;
    });
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(data.filesWritten).toEqual(['eventSheets/MainSheet.json', 'eventSheets/Shared/Shared Logic.json', 'project.c3proj']);
  });

  it('refuses a layout name that is taken, also ignoring case, a change of letter case only and a name spelled in another case', async () => {
    const before = await snapshot();
    await refusal('rename_layout', { name: 'Layout 1', newName: 'Level 2' }, 'Layout "Level 2" already exists');
    await refusal('rename_layout', { name: 'Layout 1', newName: 'level 2' }, 'differs only in case from the existing layout "Level 2"');
    await refusal('rename_layout', { name: 'Layout 1', newName: 'LAYOUT 1' }, 'changes only the letter case');
    await refusal('rename_layout', { name: 'layout 1', newName: 'X' }, 'is named "Layout 1" in the project');
    expect(await snapshot()).toEqual(before);
  });

  it('lists the timelines in a dry run', async () => {
    await addTimelines();
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen', dryRun: true });
    expect(data.filesToWrite).toEqual([
      'eventSheets/MainSheet.json', 'layouts/Title Screen.json', 'project.c3proj', 'timelines/Intro.json', 'timelines/Cutscenes/Outro.json',
    ]);
    expect(warningsOf(data)).toContain('Would point the "startOnLayout" of 2 timeline(s)');
  });

  it('puts every file back when a write fails midway', async () => {
    await addTimelines();
    const before = await snapshot();
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('disk full'));
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('The call was rolled back:');
    expect(await snapshot()).toEqual(before);
  });

  it('names a timeline file by its path in the project when an fs error stops its write', async () => {
    await addTimelines();
    const before = await snapshot();
    const file = path('timelines', 'Intro.json');
    const fsError = Object.assign(new Error(`ENOSPC: no space left on device, open '${file}.tmp'`), { code: 'ENOSPC', path: `${file}.tmp` });
    vi.spyOn(writer, 'replaceFile').mockRejectedValueOnce(fsError);
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('ENOSPC on timelines/Intro.json.tmp');
    expect(data.text).not.toContain(tmpDir);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a new name that starts or ends with a space, before any change', async () => {
    const before = await snapshot();
    await refusal('rename_layout', { name: 'Layout 1', newName: 'Title ' }, 'ends with a space');
    await refusal('rename_layout', { name: 'Layout 1', newName: ' Title' }, 'Name must start with a letter or underscore');
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Shared ' }, 'ends with a space');
    await refusal('rename_event_sheet', { name: 'Common', newName: ' Shared' }, 'Name must start with a letter or underscore');
    expect(await snapshot()).toEqual(before);
  });

  it('names the file that holds a possible reference as it is in a dry run and under its new name after the rename', async () => {
    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    layout.layers[0].instances[0].instanceVariables = { target: 'Layout 1' };
    await writeJson(path('layouts', 'Layout 1.json'), layout);
    await reader.loadProject();
    const inFile = (data: ToolData) => (data.possibleReferences ?? []).filter(r => r.kind === 'instance variable').map(r => r.in);
    expect(inFile(await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen', dryRun: true }))).toEqual(['layouts/Layout 1.json']);
    expect(inFile(await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' }))).toEqual(['layouts/Title Screen.json']);
  });
});

describe('rename_event_sheet and rename_layout: arguments and refusals', () => {
  it('refuses an argument it does not take', async () => {
    await expect(server.callTool('rename_event_sheet', { name: 'Common', newName: 'X', bogus: 1 })).rejects.toThrow();
    await expect(server.callTool('rename_layout', { name: 'Level 2', newName: 'X', bogus: 1 })).rejects.toThrow();
  });

  it('every refusal ends with Nothing was changed. and leaves every file as it was', async () => {
    await addTimelines();
    const cases: Array<[string, Json]> = [
      ['rename_event_sheet', { name: 'Nope', newName: 'X' }],
      ['rename_event_sheet', { name: 'common', newName: 'X' }],
      ['rename_event_sheet', { name: 'Common', newName: 'Common' }],
      ['rename_event_sheet', { name: 'Common', newName: 'COMMON' }],
      ['rename_event_sheet', { name: 'Common', newName: 'Other' }],
      ['rename_event_sheet', { name: 'Common', newName: 'mainsheet' }],
      ['rename_event_sheet', { name: 'Common', newName: 'Bad/Name' }],
      ['rename_layout', { name: 'Layout 1', newName: 'Level 2' }],
      ['rename_layout', { name: 'layout 1', newName: 'X' }],
      ['rename_layout', { name: 'Layout 1', newName: 'LAYOUT 1' }],
      ['rename_layout', { name: 'Layout 1', newName: 'Layout 1' }],
      ['rename_layout', { name: 'Layout 1', newName: 'Bad/Name' }],
      ['rename_layout', { name: 'Layout 1', newName: 'Title ' }],
      ['rename_layout', { name: 'Nope', newName: 'X' }],
    ];
    const before = await snapshot();
    for (const [tool, args] of cases) {
      const data = await call(tool, args);
      expect(data.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(data.text, `${tool} ${JSON.stringify(args)}`).toMatch(/Nothing was changed\.$/);
      expect((data.text ?? '').match(/Nothing was changed\./g), `${tool} ${JSON.stringify(args)}`).toHaveLength(1);
      // The name check's own message, not the message of a failed scan
      if (args.newName === 'Bad/Name') {
        expect(data.text).toMatch(/^Name must start with a letter or underscore and contain only alphanumeric characters, underscores, and spaces\./);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('starts a refusal for an invalid new name with the message of the name check, not with the message of a failed scan', async () => {
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Bad/Name' });
    expect(data.text).toMatch(/^Name must start with a letter or underscore/);
    expect(data.text).not.toContain('The rename stopped before anything was written');
  });

  it('refuses a sheet whose own file is missing, and a scan that fails before any write, saying nothing was changed', async () => {
    await rm(path('eventSheets', 'Other.json'));
    await reader.loadProject();
    const missing = await call('rename_event_sheet', { name: 'Other', newName: 'X' });
    expect(missing.text).toContain('does not exist, so there is nothing to rename. Nothing was changed.');
    const before = await snapshot();
    vi.spyOn(reader, 'readAllLayouts').mockRejectedValueOnce(new Error('disk gone'));
    const failed = await call('rename_event_sheet', { name: 'Common', newName: 'X' });
    expect(failed.text).toBe('The rename stopped before anything was written: disk gone. Nothing was changed.');
    expect(await snapshot()).toEqual(before);
  });

  it('returns rename_blocked with a message that ends with Nothing was changed.', async () => {
    await writeFile(path('layouts', 'Level 2.json'), '{"name":"Level 2","eventSheet":"Common", broken');
    await reader.loadProject();
    const blocked = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.message).toMatch(/Nothing was changed\.$/);
    expect(blocked.editorNote).toBeUndefined();
  });
});

describe('a run that stopped midway is finished by the same call', () => {
  it('finishes a rename that stopped after the referencing files were written', async () => {
    const main = await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'));
    main.events[0].includeSheet = 'Shared Logic';
    await writeJson(path('eventSheets', 'MainSheet.json'), main);
    await reader.loadProject();
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(data.filesWritten).not.toContain('eventSheets/MainSheet.json');
    expect((await readJson<SheetFile>(path('eventSheets', 'Other.json'))).events[0].includeSheet).toBe('Shared Logic');
  });

  it('finishes a rename that stopped after it wrote the new file, writing over its own leftover', async () => {
    await writeJson(path('eventSheets', 'Shared', 'Shared Logic.json'), { name: 'Shared Logic', events: [], sid: 410000000000001 });
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(existsSync(path('eventSheets', 'Shared', 'Common.json'))).toBe(false);
    expect((await readJson<ProjectFile>(path('project.c3proj'))).eventSheets.subfolders[0].items).toEqual(['Shared Logic']);
  });

  it('refuses a file for the new name with another SID, or spelled in another case, as a file that is not its own', async () => {
    await writeJson(path('eventSheets', 'Shared', 'Shared Logic.json'), { name: 'Shared Logic', events: [], sid: 999 });
    const before = await snapshot();
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' }, 'already exists');
    await rm(path('eventSheets', 'Shared', 'Shared Logic.json'));
    await writeJson(path('eventSheets', 'Shared', 'shared logic.json'), { name: 'Shared Logic', events: [], sid: 410000000000001 });
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' }, 'already exists');
    before.delete('eventSheets/Shared/Shared Logic.json');
    const now = await snapshot();
    now.delete('eventSheets/Shared/shared logic.json');
    expect(now).toEqual(before);
  });

  it('finishes a rename that stopped after the project update: deletes the old file and points the references left', async () => {
    await stopAfterProjectUpdate();
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(data.stoppedRun).toBe(true);
    expect(existsSync(path('eventSheets', 'Shared', 'Common.json'))).toBe(false);
    expect((await readJson<SheetFile>(path('eventSheets', 'MainSheet.json'))).events[0].includeSheet).toBe('Shared Logic');
    expect((await readJson<LayoutFile>(path('layouts', 'Level 2.json'))).eventSheet).toBe('Shared Logic');
    expect(data.filesWritten).not.toContain('project.c3proj');
  });

  it('finishes a layout rename that stopped after one of its timelines was written, pointing the other at it', async () => {
    await addTimelines();
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.layouts.items = ['Title Screen', 'Level 2'];
    project.firstLayout = 'Title Screen';
    await writeJson(path('project.c3proj'), project);
    const layout = await readJson<LayoutFile>(path('layouts', 'Layout 1.json'));
    layout.name = 'Title Screen';
    await writeJson(path('layouts', 'Title Screen.json'), layout);
    const intro = await readJson<TimelineFile>(path('timelines', 'Intro.json'));
    intro.startOnLayout = 'Title Screen';
    await writeJson(path('timelines', 'Intro.json'), intro);
    await reader.loadProject();
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect(data.stoppedRun).toBe(true);
    expect(data.fileDeleted).toBe('layouts/Layout 1.json');
    expect(existsSync(path('layouts', 'Layout 1.json'))).toBe(false);
    expect((await readJson<TimelineFile>(path('timelines', 'Cutscenes', 'Outro.json'))).startOnLayout).toBe('Title Screen');
    expect(data.filesWritten).not.toContain('timelines/Intro.json');
  });

  it('answers not found when the same rename is run again after it finished, and writes nothing', async () => {
    await addTimelines();
    const first = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(first.success).toBe(true);
    expect(existsSync(path('layouts', 'Layout 1.json.bak'))).toBe(true);
    const before = await snapshot();
    const again = await refusal('rename_layout', { name: 'Layout 1', newName: 'Title Screen' }, 'Layout "Layout 1" not found.');
    expect(again.isError).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to delete an old file the editor saves after the last check, before the delete takes its lock, in a finished run', async () => {
    await stopAfterProjectUpdate();
    const saved = '{"name":"Common","events":[{"eventType":"comment","text":"saved late"}],"sid":410000000000001}';
    const original = writer.deleteEntityFile.bind(writer);
    // The save lands after the tool's own check and before the writer's lock: only the writer's check can see it
    vi.spyOn(writer, 'deleteEntityFile').mockImplementation(async (category, name, subfolder) => {
      if (name === 'Common') await editorSave(path('eventSheets', 'Shared', 'Common.json'), saved);
      return original(category, name, subfolder);
    });
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('eventSheets/Shared/Common.json');
    expect(await readFile(path('eventSheets', 'Shared', 'Common.json'), 'utf8')).toBe(saved);
  });

  it('refuses a new name the editor registered during the call, and a sheet the editor moved, and puts back what the call wrote', async () => {
    const original = writer.renameInProject.bind(writer);
    for (const edit of [
      // Another sheet named like the new one, in another folder
      (p: ProjectFile) => { p.eventSheets.items.push('shared logic'); },
      // The renamed sheet moved to the root
      (p: ProjectFile) => {
        p.eventSheets.subfolders[0].items = p.eventSheets.subfolders[0].items.filter(n => n !== 'Common');
        p.eventSheets.items.push('Common');
      },
    ]) {
      const before = await snapshot();
      const projectBefore = await readFile(path('project.c3proj'));
      vi.spyOn(writer, 'renameInProject').mockImplementationOnce(async (...args) => {
        const project = await readJson<ProjectFile>(path('project.c3proj'));
        edit(project);
        await editorSave(path('project.c3proj'), JSON.stringify(project, null, '\t'));
        return original(...args);
      });
      const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
      expect(data.isError).toBe(true);
      expect(data.text).toMatch(/now registers "shared logic"|was moved in project\.c3proj/);
      // The editor's project.c3proj is kept; every other file is as before the call
      const after = await snapshot();
      after.delete('project.c3proj');
      before.delete('project.c3proj');
      expect(after).toEqual(before);
      // Back to the project as it was, for the next case
      await editorSave(path('project.c3proj'), projectBefore.toString('utf8'));
      await reader.loadProject();
      vi.restoreAllMocks();
    }
  });

  it('refuses to delete an old file the editor saved after the call read it, in a finished run', async () => {
    await stopAfterProjectUpdate();
    const original = writer.writeEntityFile.bind(writer);
    const saved = '{"name":"Common","events":[{"eventType":"comment","text":"saved"}],"sid":410000000000001}';
    // The save lands while the call writes the references, after it read the old file
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, data, subfolder, options) => {
      if (name === 'MainSheet') await editorSave(path('eventSheets', 'Shared', 'Common.json'), saved);
      return original(category, name, data, subfolder, options);
    });
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('eventSheets/Shared/Common.json was changed on disk after this call read it');
    expect(await readFile(path('eventSheets', 'Shared', 'Common.json'), 'utf8')).toBe(saved);
  });

  it('refuses a name that is not registered when nothing shows a stopped rename of it', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.eventSheets.subfolders[0].items = ['Shared Logic'];
    await writeJson(path('project.c3proj'), project);
    await writeJson(path('eventSheets', 'Shared', 'Shared Logic.json'), { name: 'Shared Logic', events: [], sid: 777 });
    await reader.loadProject();
    const before = await snapshot();
    await refusal('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' }, 'Event sheet "Common" not found.');
    expect(await snapshot()).toEqual(before);
  });

  it('reports a stopped run in a dry run and writes nothing', async () => {
    await stopAfterProjectUpdate();
    const before = await snapshot();
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic', dryRun: true });
    expect(data.stoppedRun).toBe(true);
    expect(data.filesToWrite).not.toContain('project.c3proj');
    expect(data.editorNote).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });
});

describe('rename_layout: timelines and editor saves', () => {
  it('puts every file back when a timeline write fails after the entity files were written', async () => {
    await addTimelines();
    const before = await snapshot();
    const original = writer.replaceFile.bind(writer);
    let calls = 0;
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      if (file.endsWith('Outro.json') && ++calls === 1) throw new Error('disk full');
      return original(file, content, options);
    });
    const deleteEntityFile = vi.spyOn(writer, 'deleteEntityFile');
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('disk full');
    expect(data.text).toContain('The call was rolled back:');
    expect(data.text).toContain('timelines/Intro.json');
    expect(deleteEntityFile).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('deletes the old file after every other write', async () => {
    await addTimelines();
    const order: string[] = [];
    const replace = writer.replaceFile.bind(writer);
    const remove = writer.deleteEntityFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      order.push(`replace ${relative(tmpDir, file).split('\\').join('/')}`);
      return replace(file, content, options);
    });
    vi.spyOn(writer, 'deleteEntityFile').mockImplementation(async (category, name, subfolder) => {
      order.push(`delete ${category}/${name}`);
      return remove(category, name, subfolder);
    });
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect(order).toEqual(['replace timelines/Intro.json', 'replace timelines/Cutscenes/Outro.json', 'delete layouts/Layout 1']);
  });

  it('leaves a timeline the editor saved during the call as it is, and puts the other files back', async () => {
    await addTimelines();
    const before = await snapshot();
    const saved = '{"name":"Outro","totalTime":9,"startOnLayout":"layout 1","tracks":[],"note":"saved"}';
    const original = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      if (file.endsWith('Outro.json')) await editorSave(path('timelines', 'Cutscenes', 'Outro.json'), saved);
      return original(file, content, options);
    });
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('timelines/Cutscenes/Outro.json was changed on disk');
    expect(await readFile(path('timelines', 'Cutscenes', 'Outro.json'), 'utf8')).toBe(saved);
    const now = await snapshot();
    now.delete('timelines/Cutscenes/Outro.json');
    before.delete('timelines/Cutscenes/Outro.json');
    expect(now).toEqual(before);
  });

  it('leaves a timeline the editor saved after the call wrote it, names it with its .bak, and puts the rest back', async () => {
    await addTimelines();
    const saved = '{"name":"Intro","note":"saved after the rename wrote it"}';
    const replace = writer.replaceFile.bind(writer);
    // Intro is written first, then saved in the editor; the write of Outro, after it, fails
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      if (file.endsWith('Outro.json')) throw new Error('disk full');
      const backup = await replace(file, content, options);
      if (file.endsWith('Intro.json')) await editorSave(file, saved);
      return backup;
    });
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('left as it is: timelines/Intro.json (');
    expect(data.text).toContain('its state from before the call is in timelines/Intro.json.bak');
    expect(data.text).not.toContain('Nothing was changed.');
    expect(data.text).toContain('Check the project (validate_project, git diff) before you run the tool again.');
    expect(await readFile(path('timelines', 'Intro.json'), 'utf8')).toBe(saved);
    expect(existsSync(path('layouts', 'Layout 1.json'))).toBe(true);
    expect(existsSync(path('layouts', 'Title Screen.json'))).toBe(false);
  });

  it('moves the view state last; a taken name is left with a warning, an identical copy only loses the old name', async () => {
    await writeFile(path('layouts', 'Layout 1.uistate.json'), '{"tab":1}');
    await writeFile(path('layouts', 'Title Screen.uistate.json'), '{"tab":1}');
    await mkdir(path('layouts', 'uistate'), { recursive: true });
    await writeFile(path('layouts', 'uistate', 'Layout 1.instancesBar.json'), '{"a":1}');
    await writeFile(path('layouts', 'uistate', 'Title Screen.instancesBar.json'), '{"b":2}');
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect(data.viewStateMoved).toEqual([{ from: 'layouts/Layout 1.uistate.json', to: 'layouts/Title Screen.uistate.json' }]);
    expect(existsSync(path('layouts', 'Layout 1.uistate.json'))).toBe(false);
    expect(await readFile(path('layouts', 'uistate', 'Layout 1.instancesBar.json'), 'utf8')).toBe('{"a":1}');
    expect(warningsOf(data)).toContain('layouts/uistate/Title Screen.instancesBar.json already exists');
  });

  it('lists the files it writes in a dry run, and carries no editorNote', async () => {
    await addTimelines();
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen', dryRun: true });
    expect(data.editorNote).toBeUndefined();
    expect(data.fileToDelete).toBe('layouts/Layout 1.json');
    expect(data.stoppedRun).toBeUndefined();
  });

  it('renames firstLayout in properties too', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.properties = { ...(project.properties ?? {}), firstLayout: 'Layout 1' };
    await writeJson(path('project.c3proj'), project);
    await reader.loadProject();
    await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    const after = await readJson<ProjectFile>(path('project.c3proj'));
    expect(after.firstLayout).toBe('Title Screen');
    expect((after.properties as Json).firstLayout).toBe('Title Screen');
  });

  it('lists a project script file that names it, and names one it cannot read, without refusing', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.rootFileFolders = { ...(project.rootFileFolders ?? {}), script: { items: [{ name: 'main.js' }, { name: 'gone.js' }], subfolders: [] } };
    await writeJson(path('project.c3proj'), project);
    await mkdir(path('scripts'), { recursive: true });
    await writeFile(path('scripts', 'main.js'), 'runtime.goToLayout("Layout 1");\nconst other = "Layout 10";\n');
    await reader.loadProject();
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect(data.possibleReferences).toEqual(expect.arrayContaining([{ in: 'scripts/main.js', kind: 'script file', value: 'runtime.goToLayout("Layout 1");' }]));
    expect(warningsOf(data)).toContain('Script file(s) that could not be read were not searched for "Layout 1": scripts/gone.js.');
    expect(await readFile(path('scripts', 'main.js'), 'utf8')).toContain('"Layout 1"');
  });

  it('counts a timeline in a folder the tools cannot resolve as one it cannot read: refused without force', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.timelines = { items: [], subfolders: [{ items: [], subfolders: [] }, { items: ['Lost'], subfolders: [] }] };
    await writeJson(path('project.c3proj'), project);
    await reader.loadProject();
    const before = await snapshot();
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.action).toBe('rename_blocked');
    expect(data.message).toContain('timelines/Lost (in a folder the timeline tools cannot resolve)');
    expect(await snapshot()).toEqual(before);
  });
});

describe('rename_layout: its own file and a file for the new name', () => {
  it('refuses a layout whose own file is missing, saying nothing was changed', async () => {
    await rm(path('layouts', 'Level 2.json'));
    await reader.loadProject();
    const before = await snapshot();
    await refusal('rename_layout', { name: 'Level 2', newName: 'Boss' }, 'does not exist, so there is nothing to rename');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a layout whose own file could not be parsed', async () => {
    await writeFile(path('layouts', 'Level 2.json'), '{ broken');
    await reader.loadProject();
    const before = await snapshot();
    await refusal('rename_layout', { name: 'Level 2', newName: 'Boss' }, 'could not be parsed (not valid JSON)');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses when a file for the new name is already on disk, and leaves it as it is', async () => {
    await writeFile(path('layouts', 'Leftover.json'), '{"name":"Leftover"}');
    const before = await snapshot();
    await refusal('rename_layout', { name: 'Layout 1', newName: 'Leftover' }, 'already exists');
    expect(await readFile(path('layouts', 'Leftover.json'), 'utf8')).toBe('{"name":"Leftover"}');
    expect(await snapshot()).toEqual(before);
  });

  it('writes over a file for the new name that holds its SID and the new name, and refuses one with another SID', async () => {
    await writeJson(path('layouts', 'Title Screen.json'), { name: 'Title Screen', layers: [], sid: 999 });
    await refusal('rename_layout', { name: 'Layout 1', newName: 'Title Screen' }, 'already exists');
    await writeJson(path('layouts', 'Title Screen.json'), { name: 'Title Screen', layers: [], sid: 500000000000003 });
    const data = await call('rename_layout', { name: 'Layout 1', newName: 'Title Screen' });
    expect(data.success).toBe(true);
    expect(existsSync(path('layouts', 'Layout 1.json'))).toBe(false);
    const renamed = await readJson<LayoutFile>(path('layouts', 'Title Screen.json'));
    expect(renamed.name).toBe('Title Screen');
    expect(renamed.layers.length).toBeGreaterThan(0);
    expect((await readJson<ProjectFile>(path('project.c3proj'))).layouts.items).toEqual(['Title Screen', 'Level 2']);
  });
});

describe('rename_event_sheet: project script files', () => {
  it('lists a project script file that names the sheet and names one it cannot read, without changing them or refusing', async () => {
    const project = await readJson<ProjectFile>(path('project.c3proj'));
    project.rootFileFolders = { ...(project.rootFileFolders ?? {}), script: { items: [{ name: 'main.js' }, { name: 'gone.js' }], subfolders: [] } };
    await writeJson(path('project.c3proj'), project);
    await mkdir(path('scripts'), { recursive: true });
    await writeFile(path('scripts', 'main.js'), 'const sheet = "Common";\nconst other = "Common2";\n');
    await reader.loadProject();
    const data = await call('rename_event_sheet', { name: 'Common', newName: 'Shared Logic' });
    expect(data.success).toBe(true);
    expect(data.possibleReferences).toEqual([{ in: 'scripts/main.js', kind: 'script file', value: 'const sheet = "Common";' }]);
    expect(warningsOf(data)).toContain('Script file(s) that could not be read were not searched for "Common": scripts/gone.js.');
    expect(await readFile(path('scripts', 'main.js'), 'utf8')).toContain('"Common"');
  });
});

describe('viewStateWithName', () => {
  it('sets the name in place and keeps the rest of the text', () => {
    expect(viewStateWithName('{\n\t"name": "Common",\n\t"scroll": [1, 2]\n}\n', 'Common', 'Shared Logic'))
      .toBe('{\n\t"name": "Shared Logic",\n\t"scroll": [1, 2]\n}\n');
    expect(viewStateWithName('{"name":"Common","other":{"name":"Common"}}', 'Common', 'X')).toBe('{"name":"X","other":{"name":"Common"}}');
  });

  it('returns a text unchanged that is not JSON, holds another name, or holds no name', () => {
    expect(viewStateWithName('{ broken', 'Common', 'X')).toBe('{ broken');
    expect(viewStateWithName('{"name":"Other"}', 'Common', 'X')).toBe('{"name":"Other"}');
    expect(viewStateWithName('{"scroll":3}', 'Common', 'X')).toBe('{"scroll":3}');
    expect(viewStateWithName('["Common"]', 'Common', 'X')).toBe('["Common"]');
  });

  it('returns a text unchanged when the name is not the first "name" in it', () => {
    const text = '{"layers":[{"name":"Common"}],"name":"Common"}';
    expect(viewStateWithName(text, 'Common', 'X')).toBe(text);
  });
});
