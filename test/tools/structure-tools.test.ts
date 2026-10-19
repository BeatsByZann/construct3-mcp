/**
 * move_project_item: an item moves to another Project Bar folder together
 * with its files (editor-state files, a tilemap object type's brush file, a
 * script or project file), refusals leave every file as it was, and a
 * failure midway puts back what the call wrote. Checked on a temp copy of
 * the synthetic rename-project fixture with the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerStructureTools } from '../../src/tools/structure-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

type Args = Record<string, unknown>;

interface Folder { name?: string; items: unknown[]; subfolders: Folder[] }
interface ProjectFile {
  objectTypes: Folder;
  families: Folder;
  layouts: Folder;
  eventSheets: Folder;
  flowcharts?: Folder;
  rootFileFolders: { script: Folder; general: Folder };
  [key: string]: unknown;
}
interface ToolData {
  isError?: boolean;
  text?: string;
  success?: boolean;
  from?: string;
  to?: string;
  foldersCreated?: string[];
  filesMoved?: Array<{ from: string; to: string }>;
  oldFilesKeptAs?: string[];
  warnings?: string[];
  backupFile?: string;
  [key: string]: unknown;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const path = (...parts: string[]) => join(tmpDir, ...parts);
const readJson = async <T>(...parts: string[]): Promise<T> => JSON.parse(await readFile(path(...parts), 'utf-8')) as T;
const text = (...parts: string[]) => readFile(path(...parts), 'utf-8');
const project = () => readJson<ProjectFile>('project.c3proj');

const call = async (args: Args): Promise<ToolData> => {
  const result = await server.callTool('move_project_item', args);
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

/** Change project.c3proj on disk before the reader loads it again, as a test setup (not a save of the editor). */
async function editProject(change: (data: ProjectFile) => void): Promise<void> {
  const data = await project();
  change(data);
  await writeFile(path('project.c3proj'), JSON.stringify(data, null, '\t'));
  await reader.reloadProject();
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
async function refusal(args: Args, ...parts: string[]): Promise<ToolData> {
  const before = await snapshotProject();
  const data = await call(args);
  expect(data.isError, JSON.stringify(args)).toBe(true);
  for (const part of parts) expect(data.text, JSON.stringify(args)).toContain(part);
  expect(data.text, JSON.stringify(args)).toMatch(/Nothing was changed\.$/);
  expect(data.text, JSON.stringify(args)).not.toContain(tmpDir);
  expect(await snapshotProject()).toEqual(before);
  return data;
}

/** The text of an error result that names neither the temp folder nor a drive path. */
function expectNoAbsolutePath(value: string | undefined): void {
  expect(value).not.toContain(tmpDir);
  expect(value).not.toMatch(/[A-Za-z]:[\\/]/);
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-structure-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  await mkdir(path('images'), { recursive: true });
  reader = new Construct3ProjectReader(path('project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
  server = new MockServer();
  registerStructureTools({ server, reader, writer, idGen: new IdGenerator() } as unknown as Parameters<typeof registerStructureTools>[0]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('move_project_item', () => {
  it('moves a layout into a new nested folder with its editor files', async () => {
    await writeFile(path('layouts', 'Level 1.uistate.json'), '{"a":1}');
    await mkdir(path('layouts', 'uistate'), { recursive: true });
    await writeFile(path('layouts', 'uistate', 'Level 1.instancesBar.json'), '{"b":2}');
    const original = await text('layouts', 'Level 1.json');

    const data = await call({ category: 'layout', name: 'Level 1', folder: 'Maps/World' });
    expect(data.isError).not.toBe(true);
    expect(data.from).toBe('');
    expect(data.to).toBe('Maps/World');
    expect(data.foldersCreated).toEqual(['Maps', 'Maps/World']);
    expect(data.filesMoved).toEqual([
      { from: 'layouts/Level 1.json', to: 'layouts/Maps/World/Level 1.json' },
      { from: 'layouts/Level 1.uistate.json', to: 'layouts/Maps/World/Level 1.uistate.json' },
      { from: 'layouts/uistate/Level 1.instancesBar.json', to: 'layouts/uistate/Maps/World/Level 1.instancesBar.json' },
    ]);
    expect(data.oldFilesKeptAs).toEqual(['layouts/Level 1.json.bak']);
    expect(data.backupFile).toBe('project.c3proj.bak');

    expect(existsSync(path('layouts', 'Level 1.json'))).toBe(false);
    expect(existsSync(path('layouts', 'Level 1.uistate.json'))).toBe(false);
    expect(existsSync(path('layouts', 'uistate', 'Level 1.instancesBar.json'))).toBe(false);
    expect(await text('layouts', 'Maps', 'World', 'Level 1.json')).toBe(original);
    expect(await text('layouts', 'Maps', 'World', 'Level 1.uistate.json')).toBe('{"a":1}');
    expect(await text('layouts', 'uistate', 'Maps', 'World', 'Level 1.instancesBar.json')).toBe('{"b":2}');
    expect(await text('layouts', 'Level 1.json.bak')).toBe(original);

    const data2 = await project();
    expect(data2.layouts.items).toEqual([]);
    const maps = data2.layouts.subfolders[1];
    expect(Object.keys(maps)).toEqual(['items', 'subfolders', 'name']);
    expect(maps.name).toBe('Maps');
    expect(maps.subfolders[0]).toEqual({ items: ['Level 1'], subfolders: [], name: 'World' });
    expect(data2.layouts.subfolders[0].items).toEqual(['Level 2']);
    expect((await reader.readLayout('Level 1')).name).toBe('Level 1');
  });

  it('moves an object type to the root and keeps the rest of its folder in order', async () => {
    const data = await call({ category: 'objectType', name: 'PlayerShip', folder: '' });
    expect(data.isError).not.toBe(true);
    expect(existsSync(path('objectTypes', 'PlayerShip.json'))).toBe(true);
    expect(existsSync(path('objectTypes', 'Actors', 'PlayerShip.json'))).toBe(false);
    const after = await project();
    expect(after.objectTypes.items).toEqual(['Tiles', 'Keyboard', 'PlayerShip']);
    expect(after.objectTypes.subfolders[0].items).toEqual(['Player', 'Enemy']);
  });

  it('moves a tilemap object type together with its brush file', async () => {
    const brush = await text('tilemapBrushes', 'objectTypes', 'Tiles.brush.json');
    const data = await call({ category: 'objectType', name: 'Tiles', folder: 'Terrain' });
    expect(data.isError).not.toBe(true);
    expect(existsSync(path('tilemapBrushes', 'objectTypes', 'Tiles.brush.json'))).toBe(false);
    expect(await text('tilemapBrushes', 'objectTypes', 'Terrain', 'Tiles.brush.json')).toBe(brush);
    expect(existsSync(path('objectTypes', 'Terrain', 'Tiles.json'))).toBe(true);
    expect(data.filesMoved?.map(f => f.to)).toEqual(['objectTypes/Terrain/Tiles.json', 'tilemapBrushes/objectTypes/Terrain/Tiles.brush.json']);
    expect(warningsOf(data)).not.toContain('brush');
  });

  it('warns when a tilemap object type has no brush file at its folder', async () => {
    await unlink(path('tilemapBrushes', 'objectTypes', 'Tiles.brush.json'));
    const data = await call({ category: 'objectType', name: 'Tiles', folder: 'Terrain' });
    expect(data.isError).not.toBe(true);
    expect(existsSync(path('objectTypes', 'Terrain', 'Tiles.json'))).toBe(true);
    expect(warningsOf(data)).toContain('no tilemap brush file was found at tilemapBrushes/objectTypes/Tiles.brush.json');
  });

  it('does not warn about a brush for an object type that is not a tilemap', async () => {
    const data = await call({ category: 'objectType', name: 'Player', folder: '' });
    expect(data.isError).not.toBe(true);
    expect(warningsOf(data)).not.toContain('brush');
  });

  it('moves an event sheet out of a folder and keeps the emptied folder', async () => {
    const data = await call({ category: 'eventSheet', name: 'Helpers', folder: '' });
    expect(data.isError).not.toBe(true);
    expect(warningsOf(data)).toContain('"Shared" is now empty');
    const after = await project();
    expect(after.eventSheets.items).toEqual(['Main', 'Helpers']);
    expect(after.eventSheets.subfolders).toEqual([{ items: [], subfolders: [], name: 'Shared' }]);
    expect(existsSync(path('eventSheets', 'Helpers.json'))).toBe(true);
  });

  it('moves a family between folders', async () => {
    const data = await call({ category: 'family', name: 'Hostiles', folder: 'Teams' });
    expect(data.isError).not.toBe(true);
    expect(existsSync(path('families', 'Teams', 'Hostiles.json'))).toBe(true);
    expect((await project()).families.subfolders.map(f => f.name)).toEqual(['Groups', 'Teams']);
  });

  it('moves a flowchart when the project has the tree', async () => {
    await mkdir(path('flowcharts'), { recursive: true });
    await writeFile(path('flowcharts', 'Graph.json'), '{"name":"Graph"}');
    await editProject(p => {
      p.flowcharts = { items: ['Graph'], subfolders: [] };
    });
    const data = await call({ category: 'flowchart', name: 'Graph', folder: 'A' });
    expect(data.isError).not.toBe(true);
    expect(await text('flowcharts', 'A', 'Graph.json')).toBe('{"name":"Graph"}');
    expect(existsSync(path('flowcharts', 'Graph.json'))).toBe(false);
    expect((await project()).flowcharts?.subfolders[0]).toEqual({ items: ['Graph'], subfolders: [], name: 'A' });
  });

  it('moves a registered script and keeps its registration entry, warning about module imports', async () => {
    await mkdir(path('scripts'), { recursive: true });
    await writeFile(path('scripts', 'main.js'), 'export const x = 1;\n');
    const entry = { name: 'main.js', type: 'application/javascript', sid: 640000000000001, 'script-info': { purpose: 'main-script' } };
    await editProject(p => {
      p.rootFileFolders.script.items.push(entry);
    });
    const data = await call({ category: 'script', name: 'main.js', folder: 'lib' });
    expect(data.isError).not.toBe(true);
    expect(warningsOf(data)).toContain('import');
    expect(existsSync(path('scripts', 'main.js'))).toBe(false);
    expect(await text('scripts', 'lib', 'main.js')).toBe('export const x = 1;\n');
    const script = (await project()).rootFileFolders.script;
    expect(script.items).toEqual([]);
    expect(script.subfolders).toEqual([{ items: [entry], subfolders: [], name: 'lib' }]);
  });

  it('moves the project file chosen by sourceFolder when two files share a name', async () => {
    await mkdir(path('files', 'Old'), { recursive: true });
    await writeFile(path('files', 'data.json'), 'root');
    await writeFile(path('files', 'Old', 'data.json'), 'old');
    await editProject(p => {
      p.rootFileFolders.general = {
        items: [{ name: 'data.json', type: 'application/json' }],
        subfolders: [{ items: [{ name: 'data.json', type: 'application/json' }], subfolders: [], name: 'Old' }],
      };
    });
    const data = await call({ category: 'file', name: 'data.json', sourceFolder: 'Old', folder: 'New' });
    expect(data.isError).not.toBe(true);
    expect(data.from).toBe('Old');
    expect(await text('files', 'New', 'data.json')).toBe('old');
    expect(await text('files', 'data.json')).toBe('root');
    expect(existsSync(path('files', 'Old', 'data.json'))).toBe(false);
    const general = (await project()).rootFileFolders.general;
    expect(general.items).toEqual([{ name: 'data.json', type: 'application/json' }]);
    expect(general.subfolders.map(f => [f.name, f.items.length])).toEqual([['Old', 0], ['New', 1]]);
  });

  it('refuses a move that cannot be made, saying Nothing was changed. and leaving every file as it was', async () => {
    await mkdir(path('files', 'Old'), { recursive: true });
    await writeFile(path('files', 'data.json'), 'root');
    await writeFile(path('files', 'Old', 'data.json'), 'old');
    await editProject(p => {
      p.rootFileFolders.general = {
        items: [{ name: 'data.json' }],
        subfolders: [{ items: [{ name: 'data.json' }], subfolders: [], name: 'Old' }],
      };
    });
    await refusal({ category: 'objectType', name: 'Player', folder: 'Actors' }, 'is already in "Actors"');
    await refusal({ category: 'layout', name: 'Level 1', folder: 'Nowhere', createFolders: false }, 'Folder "Nowhere" does not exist in the layouts tree');
    await refusal({ category: 'file', name: 'data.json', folder: 'New' }, 'exists in more than one folder', 'Pass sourceFolder');
    await refusal({ category: 'file', name: 'data.json', sourceFolder: 'Nope', folder: 'New' }, 'was not found in the Project Bar folder "Nope"');
    await refusal({ category: 'layout', name: 'Nope', folder: 'A' }, 'Layout "Nope" not found.');
    await refusal({ category: 'layout', name: 'level 1', folder: 'A' }, 'names are matched with their letter case', 'Did you mean "Level 1"?');
    await refusal({ category: 'flowchart', name: 'Graph', folder: 'A' }, 'project.c3proj has no flowcharts tree');
    await refusal({ category: 'file', name: 'data.json', sourceFolder: 'Old', folder: '' }, 'the root already holds a project file named "data.json"');
    await refusal({ category: 'file', name: 'a/b', folder: 'New' }, 'File name must be a single path segment');
    await refusal({ category: 'file', name: 'data.json', sourceFolder: 'Old/../X', folder: 'New' }, 'Subfolder path contains invalid characters');
  });

  it('refuses a destination folder that differs from a sibling only in case, and a folder name Windows forbids', async () => {
    await refusal(
      { category: 'objectType', name: 'Tiles', folder: 'actors' },
      'Folder "actors" differs only in case from the existing Project Bar folder "Actors". '
        + 'Construct 3 treats sibling folder names that differ only in case as the same name, and on Windows and macOS '
        + 'they are the same directory. Use folder "Actors". Nothing was changed.',
    );
    await refusal({ category: 'objectType', name: 'Tiles', folder: 'Bad:name' }, 'Folder name "Bad:name" contains a character Windows does not allow');
    await refusal({ category: 'objectType', name: 'Tiles', folder: 'Trailing.' }, 'must not start with a space or end with a space or a dot');
  });

  it('refuses when a destination file exists, also one that differs only in case, and creates no copy', async () => {
    await writeFile(path('layouts', 'Extra', 'Level 1.json'), '{}');
    await refusal({ category: 'layout', name: 'Level 1', folder: 'Extra' }, 'layouts/Extra/Level 1.json already exists');
    await unlink(path('layouts', 'Extra', 'Level 1.json'));
    await writeFile(path('layouts', 'Extra', 'level 1.json'), '{}');
    await refusal({ category: 'layout', name: 'Level 1', folder: 'Extra' }, 'layouts/Extra/level 1.json already exists');
    await unlink(path('layouts', 'Extra', 'level 1.json'));
    await mkdir(path('tilemapBrushes', 'objectTypes', 'Terrain'), { recursive: true });
    await writeFile(path('tilemapBrushes', 'objectTypes', 'Terrain', 'Tiles.brush.json'), '{}');
    await refusal({ category: 'objectType', name: 'Tiles', folder: 'Terrain' }, 'tilemapBrushes/objectTypes/Terrain/Tiles.brush.json already exists');
    expect(existsSync(path('objectTypes', 'Terrain', 'Tiles.json'))).toBe(false);
  });

  it('puts the copies back when a source changed on disk after it was read', async () => {
    const original = await text('tilemapBrushes', 'objectTypes', 'Tiles.brush.json');
    const replaceFile = writer.replaceFile.bind(writer);
    let rewritten = false;
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      const result = await replaceFile(file, content, options);
      if (!rewritten) {
        rewritten = true;
        await editorSave(path('tilemapBrushes', 'objectTypes', 'Tiles.brush.json'), '{"saved":"by the editor, after the first copy"}');
      }
      return result;
    });
    const before = await snapshotProject();
    const data = await call({ category: 'objectType', name: 'Tiles', folder: 'Terrain' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('tilemapBrushes/objectTypes/Tiles.brush.json was changed on disk after this call read it. It was left as it is. '
      + 'The call was rolled back: tilemapBrushes/objectTypes/Terrain/Tiles.brush.json (removed: the call had created it), '
      + 'objectTypes/Terrain/Tiles.json (removed: the call had created it) are as before the call.');
    expect(existsSync(path('objectTypes', 'Terrain', 'Tiles.json'))).toBe(false);
    expect(existsSync(path('tilemapBrushes', 'objectTypes', 'Terrain', 'Tiles.brush.json'))).toBe(false);
    expect(await text('tilemapBrushes', 'objectTypes', 'Tiles.brush.json')).toBe('{"saved":"by the editor, after the first copy"}');
    expect(original).not.toBe('{"saved":"by the editor, after the first copy"}');
    const after = await snapshotProject();
    after.delete('tilemapBrushes/objectTypes/Tiles.brush.json');
    before.delete('tilemapBrushes/objectTypes/Tiles.brush.json');
    expect(after).toEqual(before);
  });

  it('refuses an entity whose file is missing on disk', async () => {
    await unlink(path('layouts', 'Level 1.json'));
    await refusal({ category: 'layout', name: 'Level 1', folder: 'A' }, 'layouts/Level 1.json is registered but does not exist on disk. Nothing was changed.');
  });

  it('removes the copies when the project update fails', async () => {
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotProject();
    const data = await call({ category: 'objectType', name: 'Tiles', folder: 'Terrain' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe('boom. The call was rolled back: tilemapBrushes/objectTypes/Terrain/Tiles.brush.json (removed: the call had created it), '
      + 'objectTypes/Terrain/Tiles.json (removed: the call had created it) are as before the call.');
    expect(await snapshotProject()).toEqual(before);
  });

  it('names a copy it could not remove', async () => {
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new Error('boom'));
    const restoreForCall = writer.restoreForCall.bind(writer);
    vi.spyOn(writer, 'restoreForCall').mockImplementation(async (file, content) => {
      if (file.endsWith('Tiles.brush.json')) throw new Error('locked');
      return restoreForCall(file, content);
    });
    const data = await call({ category: 'objectType', name: 'Tiles', folder: 'Terrain' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('as before the call: objectTypes/Terrain/Tiles.json (removed: the call had created it)');
    expect(data.text).toContain('left as it is: tilemapBrushes/objectTypes/Terrain/Tiles.brush.json (locked; it did not exist before the call)');
    expect(existsSync(path('objectTypes', 'Terrain', 'Tiles.json'))).toBe(false);
    expect(existsSync(path('tilemapBrushes', 'objectTypes', 'Terrain', 'Tiles.brush.json'))).toBe(true);
  });

  describe('when the project update fails after project.c3proj was written', () => {
    /** The update runs, an editor save then rewrites project.c3proj, and the update reports a failure. */
    function failAfterEditorSave(change: (data: ProjectFile) => void): void {
      const updateProject = writer.updateProject.bind(writer);
      vi.spyOn(writer, 'updateProject').mockImplementationOnce(async fn => {
        await updateProject(fn);
        const data = await project();
        change(data);
        await editorSave(path('project.c3proj'), JSON.stringify(data, null, '\t'));
        throw new Error('boom');
      });
    }

    it('keeps the copies while project.c3proj still names the new folder', async () => {
      failAfterEditorSave(() => undefined);
      const data = await call({ category: 'objectType', name: 'Tiles', folder: 'Terrain' });
      expect(data.isError).toBe(true);
      expect(existsSync(path('objectTypes', 'Terrain', 'Tiles.json'))).toBe(true);
      expect(existsSync(path('tilemapBrushes', 'objectTypes', 'Terrain', 'Tiles.brush.json'))).toBe(true);
      expect(data.text).toContain('objectTypes/Terrain/Tiles.json (kept: project.c3proj still registers what this call added');
      expect(data.text).toContain('tilemapBrushes/objectTypes/Terrain/Tiles.brush.json (kept: project.c3proj still registers what this call added');
    });

    it('keeps the copies when the rewritten project.c3proj names both the old and the new folder', async () => {
      failAfterEditorSave(data => {
        data.objectTypes.items.unshift('Tiles');
      });
      const data = await call({ category: 'objectType', name: 'Tiles', folder: 'Terrain' });
      expect(data.isError).toBe(true);
      expect(existsSync(path('objectTypes', 'Terrain', 'Tiles.json'))).toBe(true);
      expect(data.text).toContain('kept: project.c3proj still registers what this call added');
    });
  });

  it('refuses an unregistered flowchart name without naming a tool the server lacks', async () => {
    await editProject(p => {
      p.flowcharts = { items: ['Graph'], subfolders: [] };
    });
    const unknown = await refusal({ category: 'flowchart', name: 'Nope', folder: 'A' }, 'Flowchart "Nope" not found.', 'Use the Project Bar to see all available names.');
    const variant = await refusal({ category: 'flowchart', name: 'graph', folder: 'A' }, 'names are matched with their letter case', 'Did you mean "Graph"?');
    expect(unknown.text).not.toContain('list_');
    expect(variant.text).not.toContain('list_');
  });

  it('says Nothing was changed. when a step before the first write throws unexpectedly, without a path', async () => {
    const failure = Object.assign(new Error(`EACCES: permission denied, open '${path('project.c3proj')}'`), { code: 'EACCES', path: path('project.c3proj') });
    vi.spyOn(reader, 'getProjectDir').mockImplementationOnce(() => {
      throw failure;
    });
    await refusal({ category: 'layout', name: 'Level 1', folder: 'A' }, 'Error moving item: EACCES on project.c3proj. Nothing was changed.');
  });

  it('refuses a script move when the project has no script tree', async () => {
    await editProject(p => {
      delete (p.rootFileFolders as Partial<ProjectFile['rootFileFolders']>).script;
    });
    await refusal({ category: 'script', name: 'main.js', folder: 'lib' }, 'project.c3proj has no rootFileFolders.script tree');
  });

  it('moves an object type whose file is not valid JSON, without a brush warning', async () => {
    await writeFile(path('objectTypes', 'Actors', 'Enemy.json'), '{ broken');
    const data = await call({ category: 'objectType', name: 'Enemy', folder: '' });
    expect(data.isError).not.toBe(true);
    expect(await text('objectTypes', 'Enemy.json')).toBe('{ broken');
    expect(warningsOf(data)).not.toContain('brush');
  });

  describe('when project.c3proj changed during the call', () => {
    /** Just before the update takes its fresh copy of project.c3proj, an editor save changes it. */
    function editorChangesProjectBeforeUpdate(change: (data: ProjectFile) => void): void {
      const updateProject = writer.updateProject.bind(writer);
      vi.spyOn(writer, 'updateProject').mockImplementationOnce(async fn => {
        const data = await project();
        change(data);
        await editorSave(path('project.c3proj'), JSON.stringify(data, null, '\t'));
        return updateProject(fn);
      });
    }

    it('stops when the item is no longer where it was', async () => {
      editorChangesProjectBeforeUpdate(data => {
        data.layouts.items = [];
        data.layouts.subfolders[0].items.push('Level 1');
      });
      const data = await call({ category: 'layout', name: 'Level 1', folder: 'Maps' });
      expect(data.isError).toBe(true);
      expect(data.text).toContain('"Level 1" changed in project.c3proj during the move.');
      expect(data.text).toContain('layouts/Maps/Level 1.json (kept: project.c3proj still registers what this call added, so the file stays)');
      expect(existsSync(path('layouts', 'Level 1.json'))).toBe(true);
      expectNoAbsolutePath(data.text);
    });

    it('stops when the tree is gone, and keeps the copies since project.c3proj cannot be checked', async () => {
      await mkdir(path('scripts'), { recursive: true });
      await writeFile(path('scripts', 'main.js'), 'export const x = 1;\n');
      await editProject(p => {
        p.rootFileFolders.script.items.push({ name: 'main.js', type: 'application/javascript' });
      });
      editorChangesProjectBeforeUpdate(data => {
        delete (data.rootFileFolders as Partial<ProjectFile['rootFileFolders']>).script;
      });
      const data = await call({ category: 'script', name: 'main.js', folder: 'lib' });
      expect(data.isError).toBe(true);
      expect(data.text).toContain('project.c3proj has no rootFileFolders.script tree.');
      expect(data.text).toContain('scripts/lib/main.js (kept: project.c3proj still registers what this call added, so the file stays)');
      expect(existsSync(path('scripts', 'lib', 'main.js'))).toBe(true);
    });
  });

  it('warns when an old file cannot be deleted, without a path of the machine', async () => {
    const oldFile = path('layouts', 'Level 1.json');
    const deleteFile = writer.deleteFile.bind(writer);
    vi.spyOn(writer, 'deleteFile').mockImplementation(async (file, options) => {
      if (file === oldFile) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${oldFile}'`), { code: 'EBUSY', path: oldFile });
      return deleteFile(file, options);
    });
    const data = await call({ category: 'layout', name: 'Level 1', folder: 'Maps' });
    expect(data.isError).not.toBe(true);
    expect(existsSync(path('layouts', 'Maps', 'Level 1.json'))).toBe(true);
    expect((await project()).layouts.subfolders[1]).toEqual({ items: ['Level 1'], subfolders: [], name: 'Maps' });
    expect(warningsOf(data)).toContain('Could not delete the old file layouts/Level 1.json after copying it (EBUSY on layouts/Level 1.json). Delete it manually.');
    expectNoAbsolutePath(JSON.stringify(data));
  });

  it('keeps an old file that changed after the copy, and says the copy is older', async () => {
    const updateProject = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementationOnce(async fn => {
      const result = await updateProject(fn);
      await editorSave(path('layouts', 'Level 1.json'), '{"saved":"after the copy"}');
      return result;
    });
    const data = await call({ category: 'layout', name: 'Level 1', folder: 'A/B' });
    expect(data.isError).not.toBe(true);
    expect(await text('layouts', 'Level 1.json')).toBe('{"saved":"after the copy"}');
    expect(existsSync(path('layouts', 'A', 'B', 'Level 1.json'))).toBe(true);
    expect(warningsOf(data)).toContain('layouts/Level 1.json changed on disk after this call copied it, so it was not deleted; '
      + 'layouts/A/B/Level 1.json holds it as it was before that change. Compare the two and delete one.');
  });

  it('warns, and does not fail, when an editor-state file cannot be moved or its target exists', async () => {
    await writeFile(path('layouts', 'Level 1.uistate.json'), '{"a":1}');
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (file, content, options) => {
      if (file.endsWith('Level 1.uistate.json')) throw new Error('disk full');
      return replaceFile(file, content, options);
    });
    const failed = await call({ category: 'layout', name: 'Level 1', folder: 'Maps' });
    expect(failed.isError).not.toBe(true);
    expect(existsSync(path('layouts', 'Maps', 'Level 1.json'))).toBe(true);
    expect(await text('layouts', 'Level 1.uistate.json')).toBe('{"a":1}');
    expect(warningsOf(failed)).toContain("The editor's view state layouts/Level 1.uistate.json could not be moved to layouts/Maps/Level 1.uistate.json (disk full)");

    vi.restoreAllMocks();
    await mkdir(path('layouts', 'Extra'), { recursive: true });
    await writeFile(path('layouts', 'Extra', 'Level 2.uistate.json'), 'other bytes');
    await writeFile(path('layouts', 'Level 2.uistate.json'), '{"c":3}');
    await rm(path('layouts', 'Extra', 'Level 2.json'));
    await writeFile(path('layouts', 'Level 2.json'), '{"name":"Level 2"}');
    await editProject(p => {
      p.layouts.items.push('Level 2');
      p.layouts.subfolders[0].items = [];
    });
    const taken = await call({ category: 'layout', name: 'Level 2', folder: 'Extra' });
    expect(taken.isError).not.toBe(true);
    expect(warningsOf(taken)).toContain("The editor's view state layouts/Level 2.uistate.json was left as it is: layouts/Extra/Level 2.uistate.json already exists.");
    expect(await text('layouts', 'Extra', 'Level 2.uistate.json')).toBe('other bytes');
  });

  it('refuses a call when a file cannot be read, without a path', async () => {
    await unlink(path('layouts', 'Level 1.json'));
    await mkdir(path('layouts', 'Level 1.json'));
    const data = await refusal({ category: 'layout', name: 'Level 1', folder: 'A' }, 'layouts/Level 1.json could not be read (could not be read). Nothing was changed.');
    expectNoAbsolutePath(data.text);
  });

  it('leaves the project object the reader holds as it was after a refused call', async () => {
    const before = structuredClone(reader.getProject());
    await call({ category: 'objectType', name: 'Player', folder: 'Actors' });
    await call({ category: 'layout', name: 'Nope', folder: 'A' });
    await call({ category: 'objectType', name: 'Tiles', folder: 'actors' });
    expect(reader.getProject()).toEqual(before);
  });
});
