/**
 * Construct3ProjectWriter.renameInProject: an entry keeps its place in the
 * project bar, a renamed startup layout stays the startup layout,
 * alsoChange lands in the same write, and a name that is not registered
 * changes nothing. On a temp copy of the minimal fixture with the real
 * reader and writer; the folders and names are synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter, RenameConflictError } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { runInToolCall, StaleFileError, statFileState } from '../../src/construct3/disk-state.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
const projectPath = () => join(dir, 'project.c3proj');
const readProject = async (): Promise<Record<string, any>> => JSON.parse(await readFile(projectPath(), 'utf-8'));

/** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
async function editorSave(path: string, text: string): Promise<void> {
  await writeFile(path, text);
  const { mtime } = await stat(path);
  const later = new Date(mtime.getTime() + 2000);
  await utimes(path, later, later);
}

/** The project file as an editor save since the tool planned the rename leaves it. */
async function editorSaveProject(change: (project: Record<string, any>) => void): Promise<void> {
  const project = await readProject();
  change(project);
  await editorSave(projectPath(), JSON.stringify(project, null, '\t'));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-rename-in-project-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const project = await readProject();
  project.layouts.items = ['Layout 1', 'Level 2'];
  // The shape the editor saves: named subfolders, each with items and subfolders
  project.layouts.subfolders = [{ items: ['Boss', 'Secret'], subfolders: [], name: 'Levels' }];
  project.firstLayout = 'LAYOUT 1';
  project.properties = { ...(project.properties ?? {}), firstLayout: 'Layout 1' };
  await writeFile(projectPath(), JSON.stringify(project, null, '\t'));
  reader = new Construct3ProjectReader(projectPath());
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('renameInProject', () => {
  it('renames an entry in place at the root and in a folder', async () => {
    await runInToolCall(() => writer.renameInProject('layouts', 'Level 2', 'Stage'));
    await runInToolCall(() => writer.renameInProject('layouts', 'Boss', 'Final'));
    const project = await readProject();
    expect(project.layouts.items).toEqual(['Layout 1', 'Stage']);
    expect(project.layouts.subfolders).toEqual([{ items: ['Final', 'Secret'], subfolders: [], name: 'Levels' }]);
    expect(project.firstLayout).toBe('LAYOUT 1');
    expect(await reader.listLayouts()).toEqual(expect.arrayContaining(['Layout 1', 'Stage', 'Final', 'Secret']));
  });

  it('keeps a renamed startup layout the startup layout, at the top level and in properties, matched ignoring case', async () => {
    await runInToolCall(() => writer.renameInProject('layouts', 'Layout 1', 'Title'));
    const project = await readProject();
    expect(project.layouts.items).toEqual(['Title', 'Level 2']);
    expect(project.firstLayout).toBe('Title');
    expect(project.properties.firstLayout).toBe('Title');
  });

  it('leaves firstLayout alone when it renames an entry of another category', async () => {
    // An object type registered under the startup layout's name
    await editorSaveProject(project => { project.objectTypes.items = ['Layout 1']; });
    await runInToolCall(() => writer.renameInProject('objectTypes', 'Layout 1', 'Hero'));
    const project = await readProject();
    expect(project.objectTypes.items).toEqual(['Hero']);
    expect(project.firstLayout).toBe('LAYOUT 1');
    expect(project.properties.firstLayout).toBe('Layout 1');
  });

  it('applies alsoChange in the same write of project.c3proj', async () => {
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = vi.spyOn(internals, 'atomicWrite');
    await runInToolCall(() => writer.renameInProject('objectTypes', 'Sprite', 'Hero', {
      alsoChange: project => { project.containers = [{ members: ['Hero', 'Other'] }]; },
    }));
    expect(atomicWrite.mock.calls.filter(([path]) => path.endsWith('project.c3proj'))).toHaveLength(1);
    const project = await readProject();
    expect(project.objectTypes.items).toEqual(['Hero']);
    expect(project.containers).toEqual([{ members: ['Hero', 'Other'] }]);
  });

  it('throws for a name that is not registered, also one that differs only in case, and writes nothing', async () => {
    const before = await readFile(projectPath());
    await expect(runInToolCall(() => writer.renameInProject('layouts', 'Nope', 'X')))
      .rejects.toThrow('"Nope" is no longer registered in project.c3proj (layouts).');
    await expect(runInToolCall(() => writer.renameInProject('layouts', 'level 2', 'X')))
      .rejects.toThrow('"level 2" is no longer registered in project.c3proj (layouts).');
    expect(await readFile(projectPath())).toEqual(before);
    expect(existsSync(`${projectPath()}.bak`)).toBe(false);
  });

  it('returns the backup path, holding the file from before the call', async () => {
    const before = await readFile(projectPath());
    const backup = await runInToolCall(() => writer.renameInProject('layouts', 'Level 2', 'Stage'));
    expect(backup).toBe(`${projectPath()}.bak`);
    expect(await readFile(backup)).toEqual(before);
  });

  it('refuses a new name another entry got during the call, in its own category or a shared one, and writes nothing', async () => {
    await editorSaveProject(project => {
      project.objectTypes.subfolders = [{ items: ['Gamma'], subfolders: [], name: 'Things' }];
    });
    let before = await readFile(projectPath());
    const ownCategory = runInToolCall(() => writer.renameInProject('objectTypes', 'Sprite', 'Gamma', { clashesWith: ['objectTypes', 'families'] }));
    await expect(ownCategory).rejects.toThrow(RenameConflictError);
    await expect(ownCategory).rejects.toThrow('Gamma');
    expect(await readFile(projectPath())).toEqual(before);

    await editorSaveProject(project => {
      project.objectTypes.subfolders = [];
      project.families.items = ['gamma'];
    });
    before = await readFile(projectPath());
    const sharedCategory = runInToolCall(() => writer.renameInProject('objectTypes', 'Sprite', 'Gamma', { clashesWith: ['objectTypes', 'families'] }));
    await expect(sharedCategory).rejects.toThrow(RenameConflictError);
    await expect(sharedCategory).rejects.toThrow('gamma');
    expect(await readFile(projectPath())).toEqual(before);
  });

  it('does not refuse a change of letter case only because of the entry itself', async () => {
    await runInToolCall(() => writer.renameInProject('objectTypes', 'Sprite', 'SPRITE', { clashesWith: ['objectTypes', 'families'] }));
    expect((await readProject()).objectTypes.items).toEqual(['SPRITE']);
  });

  it('refuses an entry moved to another folder during the call', async () => {
    await editorSaveProject(project => {
      project.layouts.items = ['Layout 1'];
      project.layouts.subfolders = [{ items: ['Boss', 'Secret', 'Level 2'], subfolders: [], name: 'Levels' }];
    });
    const before = await readFile(projectPath());
    const rename = runInToolCall(() => writer.renameInProject('layouts', 'Level 2', 'Stage', { expectedFolder: [] }));
    await expect(rename).rejects.toThrow(RenameConflictError);
    await expect(rename).rejects.toThrow('was moved');
    expect(await readFile(projectPath())).toEqual(before);
  });

  it('deleteFile refuses a file changed since the expected state, under its lock', async () => {
    const extra = join(dir, 'extra.txt');
    await writeFile(extra, 'as read');
    const stateBefore = await statFileState(extra);
    await editorSave(extra, 'saved by the editor in between');
    await expect(runInToolCall(() => writer.deleteFile(extra, { expected: stateBefore }))).rejects.toThrow(StaleFileError);
    expect(await readFile(extra, 'utf-8')).toBe('saved by the editor in between');
  });
});
